// netlify/functions/change-plan.js
// Switches an existing Stripe subscription between the paid plans:
//   'pro'       → STRIPE_PRICE_ID           ($9.99/mo, automatic miles on 100 quotes/day)
//   'plus'      → STRIPE_PRICE_ID_PLUS      ($19.99/mo, 250 quotes/day)
//   'unlimited' → STRIPE_PRICE_ID_UNLIMITED ($49.99/mo, no daily limit)
//
// POST { userId, accessToken, plan: 'pro' | 'plus' | 'unlimited' }
//  - Subscribers from before the plan changes (still on unlimited until they
//    renew): the new price starts at their next renewal, nothing is charged
//    now (proration_behavior=none). Response has atRenewal: true.
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
const { PLANS, PLAN_RANK, priceIdFor, planForPriceIds, legacyUnlimited, subscriptionPeriod } = require('../lib/plans.js');

const PLAN_NAME = { pro: 'Pro', plus: 'Pro Plus', unlimited: 'Pro Unlimited' };

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
      `/rest/v1/pro_users?id=eq.${encodeURIComponent(userId)}&select=is_active,plan,stripe_subscription_id,created_at,billing_period_start`,
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

    // Already on that price (Stripe is the source of truth, not our copy of the plan).
    const currentPrice = item.price && item.price.id;
    const period = subscriptionPeriod(sub);
    if(currentPrice === priceId){
      return reply(200, { status: 'ok', plan, unchanged: true, renewsAt: period.end });
    }

    // Subscribers from before the plan changes keep unlimited quotes until they
    // renew, so their choice takes effect at renewal with nothing charged now.
    const atRenewal = legacyUnlimited(row.created_at, row.billing_period_start);
    const upgrade = !atRenewal && PLAN_RANK[plan] > PLAN_RANK[planForPriceIds([currentPrice])];
    const params = {
      'items[0][id]': item.id,
      'items[0][price]': priceId,
      'proration_behavior': atRenewal ? 'none' : (upgrade ? 'always_invoice' : 'create_prorations'),
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

    const record = { plan, updated_at: new Date().toISOString() };
    if(period.start) record.billing_period_start = period.start;
    if(period.end) record.renews_at = period.end;
    const patch = await supabase(`/rest/v1/pro_users?id=eq.${encodeURIComponent(userId)}`, 'PATCH',
      record, serviceKey);
    if(patch.status >= 300){
      // Stripe has switched; the webhook will record the plan shortly.
      console.error('[change-plan] pro_users update failed:', patch.status, JSON.stringify(patch.body));
    }
    return reply(200, { status: 'ok', plan, atRenewal, renewsAt: period.end });
  } catch(err){
    console.error('[change-plan] error:', err);
    return reply(500, { error: 'server_error', message: 'Something went wrong. Please try again.' });
  }
};
