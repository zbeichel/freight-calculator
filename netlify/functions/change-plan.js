// netlify/functions/change-plan.js
// Switches an existing Stripe subscription between the paid plans (each
// variable holds a Stripe price ID, price_…, not a product ID, prod_…):
//   'pro'  → STRIPE_PRICE_ID_PRO  ($9.99/mo, automatic miles on 100 quotes/day)
//   'plus' → STRIPE_PRICE_ID_PLUS ($19.99/mo, 250 quotes/day)
//   'max'  → STRIPE_PRICE_ID_MAX  ($49.99/mo, 1,000 quotes/day)
//   'api'  → STRIPE_PRICE_ID_API  ($199.99/mo, Pro Max + API access)
//
// POST { userId, accessToken, plan: 'pro' | 'plus' | 'max' | 'api' }
//  - Subscribers still on the original Pro plan choosing Pro, Pro Plus or Pro
//    Max: the choice is recorded (pro_users.next_plan) and nothing is charged.
//    They move to it at their first bill on or after January 1, 2027 — the
//    Stripe price is switched (no proration) here if their next bill is
//    already on or after that day, otherwise by apply-plan-changes.
//    Response has atRenewal: true and startsAt.
//  - The API plan is available now: from the original plan it's an upgrade
//    like any other.
//  - Upgrade: Stripe charges the prorated difference right away, and the
//    change only takes effect once that payment succeeds
//    (payment_behavior=pending_if_incomplete). If the card needs attention we
//    return the invoice link so the customer can finish paying there.
//  - Downgrade: takes effect now; the unused part of the higher plan is
//    credited on the next invoice.
// The Stripe webhook (customer.subscription.updated) records the plan from the
// subscription's price as well; writing it here makes the change show up at once.
//
// Responses (HTTP 200): { status: 'ok', plan, atRenewal?, renewsAt? } or
//                       { status: 'needs_payment', url }
// Errors: { error: '<code>', message: '<user-safe text>' } with a 4xx/5xx status.

const https = require('https');
const { PLANS, PLAN_NAME, PLAN_RANK, priceIdFor, newPriceIdFor, planForPriceIds, isOriginalPlanPrice,
  dueForNewPlan, subscriptionPeriod, NEW_PLANS_START } = require('../lib/plans.js');

const SUPABASE_URL = 'https://xgrmbhmgcsbnazupfybd.supabase.co';
const CONTACT = 'email info@quickfreightcalc.com and we\'ll switch it for you';

function request(hostname, path, method, headers, body){
  return new Promise((resolve, reject) => {
    const req = https.request({ hostname, path, method, headers }, res => {
      let d = '';
      res.on('data', chunk => d += chunk);
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: d ? JSON.parse(d) : {} }); }
        catch(e){ resolve({ status: res.statusCode, body: d }); }
      });
    });
    req.on('error', reject);
    if(body) req.write(body);
    req.end();
  });
}

function stripe(path, method, params){
  const body = params ? new URLSearchParams(params).toString() : null;
  const headers = { 'Authorization': `Bearer ${process.env.STRIPE_SECRET_KEY}` };
  if(body){
    headers['Content-Type'] = 'application/x-www-form-urlencoded';
    headers['Content-Length'] = Buffer.byteLength(body);
  }
  return request('api.stripe.com', path, method, headers, body);
}

function supabase(path, method, data, serviceKey){
  const body = data ? JSON.stringify(data) : null;
  const headers = {
    'apikey': serviceKey,
    'Authorization': `Bearer ${serviceKey}`,
    'Content-Type': 'application/json',
    'Prefer': 'return=minimal',
  };
  if(body) headers['Content-Length'] = Buffer.byteLength(body);
  return request(new URL(SUPABASE_URL).hostname, path, method, headers, body);
}

// The id of the user this Supabase access token belongs to, or null.
async function verifyUser(accessToken, serviceKey){
  if(!accessToken) return null;
  try {
    const resp = await request(new URL(SUPABASE_URL).hostname, '/auth/v1/user', 'GET',
      { 'apikey': serviceKey, 'Authorization': `Bearer ${accessToken}` });
    return resp.status === 200 && resp.body && resp.body.id ? resp.body.id : null;
  } catch(e){
    return null;
  }
}

function reply(statusCode, payload){
  return { statusCode, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) };
}

exports.handler = async function(event){
  if(event.httpMethod !== 'POST'){
    return reply(405, { error: 'method_not_allowed', message: 'Method not allowed' });
  }

  let userId, accessToken, plan;
  try {
    ({ userId, accessToken, plan } = JSON.parse(event.body || '{}'));
  } catch(e){
    return reply(400, { error: 'bad_request', message: 'Invalid request' });
  }
  if(!userId || !accessToken || !PLANS.includes(plan)){
    return reply(400, { error: 'bad_request', message: 'Invalid request' });
  }

  const serviceKey = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;
  if(!serviceKey || !process.env.STRIPE_SECRET_KEY){
    console.error('[change-plan] missing SUPABASE_SERVICE_KEY or STRIPE_SECRET_KEY');
    return reply(500, { error: 'server_config', message: 'Plan changes are unavailable right now.' });
  }

  // Only the signed-in owner of this account may change its plan.
  const verifiedId = await verifyUser(accessToken, serviceKey);
  if(!verifiedId || verifiedId !== userId){
    return reply(401, { error: 'unauthorized', message: 'Please sign in again.' });
  }

  try {
    const rowResp = await supabase(
      `/rest/v1/pro_users?id=eq.${encodeURIComponent(userId)}&select=is_active,plan,stripe_subscription_id`,
      'GET', null, serviceKey
    );
    const row = Array.isArray(rowResp.body) ? rowResp.body[0] : null;
    if(!row || row.is_active !== true){
      return reply(400, { error: 'not_subscribed', message: 'Start a Pro subscription first.' });
    }
    if(!row.stripe_subscription_id){
      // Comp / partner accounts aren't billed through Stripe.
      return reply(400, { error: 'not_billed_by_stripe',
        message: `Your Pro access isn't billed through Stripe — ${CONTACT}.` });
    }

    const priceId = priceIdFor(plan);
    if(!priceId){
      console.error(`[change-plan] no Stripe price configured for plan "${plan}"`);
      return reply(503, { error: 'not_available',
        message: `${PLAN_NAME[plan]} isn't available to buy online yet — ${CONTACT}.` });
    }

    const subId = encodeURIComponent(row.stripe_subscription_id);
    const subResp = await stripe(`/v1/subscriptions/${subId}`, 'GET');
    const sub = subResp.body;
    if(subResp.status !== 200 || !sub || sub.error){
      console.error('[change-plan] could not load subscription:', subResp.status, sub && sub.error && sub.error.message);
      return reply(502, { error: 'stripe_error', message: 'Could not load your subscription. Please try again.' });
    }
    if(sub.status !== 'active' && sub.status !== 'trialing'){
      return reply(400, { error: 'subscription_inactive',
        message: 'Your subscription isn\'t active — update your payment details from your Profile first.' });
    }
    const item = sub.items && sub.items.data && sub.items.data[0];
    if(!item){
      console.error('[change-plan] subscription has no items:', row.stripe_subscription_id);
      return reply(502, { error: 'stripe_error', message: 'Could not load your subscription. Please try again.' });
    }

    const currentPrice = item.price && item.price.id;
    const period = subscriptionPeriod(sub);
    const userPath = `/rest/v1/pro_users?id=eq.${encodeURIComponent(userId)}`;

    // Still on the original Pro plan (Stripe's price is the source of truth,
    // not our copy). Pro, Pro Plus and Pro Max start with the January 1, 2027
    // changeover: record the choice, charge nothing now.
    if (isOriginalPlanPrice(currentPrice) && plan !== 'api') {
      const record = { next_plan: plan, grandfathered: true, updated_at: new Date().toISOString() };
      const newPrice = newPriceIdFor(plan);
      if (dueForNewPlan(period.end) && !sub.cancel_at_period_end && newPrice) {
        // Their next bill is already on or after January 1: switch the price
        // now, without proration, so that bill is at the new price.
        const sw = await stripe(`/v1/subscriptions/${subId}`, 'POST', {
          'items[0][id]': item.id,
          'items[0][price]': newPrice,
          'proration_behavior': 'none',
        });
        if (sw.status !== 200 || !sw.body || sw.body.error) {
          const msg = sw.body && sw.body.error && sw.body.error.message;
          console.error('[change-plan] January switch failed:', sw.status, msg);
          return reply(400, { error: 'stripe_error', message: msg || 'Stripe could not change your plan.' });
        }
        record.plan = plan;
      }
      const saved = await supabase(userPath, 'PATCH', record, serviceKey);
      if (saved.status >= 300) {
        console.error('[change-plan] could not save the January plan:', saved.status, JSON.stringify(saved.body));
        return reply(500, { error: 'server_error', message: 'Could not save your choice. Please try again.' });
      }
      return reply(200, { status: 'ok', plan, atRenewal: true,
        startsAt: new Date(NEW_PLANS_START).toISOString(), renewsAt: period.end });
    }

    if (currentPrice === priceId) {
      return reply(200, { status: 'ok', plan, unchanged: true, renewsAt: period.end });
    }

    // From the original plan (to the API plan) or up a tier: an upgrade.
    const upgrade = isOriginalPlanPrice(currentPrice) || PLAN_RANK[plan] > PLAN_RANK[planForPriceIds([currentPrice])];
    const params = {
      'items[0][id]': item.id,
      'items[0][price]': priceId,
      'proration_behavior': upgrade ? 'always_invoice' : 'create_prorations',
      'expand[0]': 'latest_invoice',
    };
    if(upgrade) params['payment_behavior'] = 'pending_if_incomplete';

    const updResp = await stripe(`/v1/subscriptions/${subId}`, 'POST', params);
    const updated = updResp.body;
    if(updResp.status !== 200 || !updated || updated.error){
      const msg = updated && updated.error && updated.error.message;
      console.error('[change-plan] update failed:', updResp.status, msg);
      return reply(400, { error: 'stripe_error', message: msg || 'Stripe could not change your plan.' });
    }

    // Upgrade waiting on payment (card declined or needs authentication): the
    // plan hasn't changed yet. Send the customer to the invoice to finish it.
    if(updated.pending_update){
      const url = updated.latest_invoice && updated.latest_invoice.hosted_invoice_url;
      return reply(200, { status: 'needs_payment', url: url || null,
        message: 'Your card needs attention before the upgrade can go through.' });
    }

    const newPrice = updated.items && updated.items.data && updated.items.data[0]
      && updated.items.data[0].price && updated.items.data[0].price.id;
    if(newPrice !== priceId){
      console.error('[change-plan] price not applied, now:', newPrice);
      return reply(502, { error: 'stripe_error', message: 'Stripe did not apply the change. Please try again.' });
    }

    const record = { plan, next_plan: plan, updated_at: new Date().toISOString() };
    if(period.start) record.billing_period_start = period.start;
    if(period.end) record.renews_at = period.end;
    const patch = await supabase(userPath, 'PATCH', record, serviceKey);
    if(patch.status >= 300){
      // Stripe has switched; the webhook will record the plan shortly.
      console.error('[change-plan] pro_users update failed:', patch.status, JSON.stringify(patch.body));
    }
    return reply(200, { status: 'ok', plan, atRenewal: false, renewsAt: period.end });
  } catch(err){
    console.error('[change-plan] error:', err);
    return reply(500, { error: 'server_error', message: 'Something went wrong. Please try again.' });
  }
};
