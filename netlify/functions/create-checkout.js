// netlify/functions/create-checkout.js
// Creates a Stripe checkout session for a new subscription. Each variable
// holds a Stripe price ID (price_…), not a product ID (prod_…):
//   plan 'pro'  → STRIPE_PRICE_ID_PRO  ($9.99/mo, automatic miles on 100 quotes/day;
//                 falls back to STRIPE_PRICE_ID, the original $4.99 price, until set)
//   plan 'plus' → STRIPE_PRICE_ID_PLUS ($19.99/mo, 250 quotes/day)
//   plan 'max'  → STRIPE_PRICE_ID_MAX  ($49.99/mo, 1,000 quotes/day)
//   plan 'api'  → STRIPE_PRICE_ID_API  ($199.99/mo, Pro Max + API access)
// interval 'year' bills Pro, Pro Plus or Pro Max yearly (STRIPE_PRICE_ID_*_YEARLY,
// $99 / $199 / $499); the API plan is monthly only.
// First-time subscribers get a free trial of Pro Plus or Pro Max (TRIAL_DAYS in
// netlify/lib/plans.js): Stripe collects the card now and charges when the trial
// ends unless they cancel.
// Someone who already has an active subscription is sent to change-plan
// instead, so nobody ends up paying for two subscriptions.

const https = require('https');
const { PLANS, PLAN_NAME, normalizePlan, normalizeInterval, priceIdFor, TRIAL_DAYS, TRIAL_PLANS,
  trialEligible } = require('../lib/plans.js');

const SUPABASE_URL = 'https://xgrmbhmgcsbnazupfybd.supabase.co';

// The caller's pro_users row (service key — bypasses RLS), or null.
function getProRow(userId){
  return new Promise((resolve) => {
    const serviceKey = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;
    if(!serviceKey){ resolve(null); return; }
    const url = new URL(`${SUPABASE_URL}/rest/v1/pro_users?id=eq.${encodeURIComponent(userId)}&select=is_active,plan,stripe_customer_id,stripe_subscription_id`);
    https.get({
      hostname: url.hostname,
      path: url.pathname + url.search,
      headers: { 'apikey': serviceKey, 'Authorization': `Bearer ${serviceKey}` }
    }, res => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => {
        try { const rows = JSON.parse(d); resolve(Array.isArray(rows) ? rows[0] || null : null); }
        catch(e){ resolve(null); }
      });
    }).on('error', () => resolve(null));
  });
}

// Verify the Supabase access token and return the authenticated user id, or null.
function verifyUser(accessToken){
  return new Promise((resolve) => {
    if(!accessToken){ resolve(null); return; }
    const serviceKey = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;
    const url = new URL(`${SUPABASE_URL}/auth/v1/user`);
    https.get({
      hostname: url.hostname,
      path: url.pathname,
      headers: { 'apikey': serviceKey, 'Authorization': `Bearer ${accessToken}` }
    }, res => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => {
        try { const b = JSON.parse(d); resolve(res.statusCode === 200 && b && b.id ? b.id : null); }
        catch(e){ resolve(null); }
      });
    }).on('error', () => resolve(null));
  });
}

function stripeRequest(path, method, data){
  const secretKey = process.env.STRIPE_SECRET_KEY;
  const body = new URLSearchParams(data).toString();
  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: 'api.stripe.com',
      path,
      method,
      headers: {
        'Authorization': `Bearer ${secretKey}`,
        'Content-Type': 'application/x-www-form-urlencoded',
        'Content-Length': Buffer.byteLength(body),
      }
    }, res => {
      let d = '';
      res.on('data', chunk => d += chunk);
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(d) }); }
        catch(e){ resolve({ status: res.statusCode, body: d }); }
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

exports.handler = async function(event){
  if(event.httpMethod !== 'POST'){
    return { statusCode: 405, body: 'Method not allowed' };
  }

  const { userId, email, accessToken, plan: requestedPlan, interval: requestedInterval } = JSON.parse(event.body || '{}');
  if(!userId || !email || !accessToken){
    return { statusCode: 400, body: JSON.stringify({ error: 'Missing credentials' }) };
  }
  const plan = PLANS.includes(requestedPlan) ? requestedPlan : 'pro';
  const interval = plan === 'api' ? 'month' : normalizeInterval(requestedInterval);

  // A user may only start checkout for their own account.
  const verifiedId = await verifyUser(accessToken);
  if(!verifiedId || verifiedId !== userId){
    return { statusCode: 401, body: JSON.stringify({ error: 'Unauthorized' }) };
  }

  // Already subscribed: switching plans goes through change-plan, never a
  // second subscription.
  const proRow = await getProRow(userId);
  if(proRow && proRow.is_active === true){
    return {
      statusCode: 409,
      body: JSON.stringify({
        error: 'already_subscribed',
        plan: normalizePlan(proRow.plan),
        message: 'You already have Pro — switch plans from your Profile page.'
      })
    };
  }

  const priceId = priceIdFor(plan, interval);
  if(!priceId){
    console.error(`create-checkout: no Stripe price configured for plan "${plan}" (${interval})`);
    return {
      statusCode: 503,
      body: JSON.stringify({ error: interval === 'year'
        ? `Yearly billing for ${PLAN_NAME[plan]} isn't available yet. Choose monthly billing, or email info@quickfreightcalc.com.`
        : plan === 'pro'
          ? 'Checkout is unavailable right now. Please try again later.'
          : `${PLAN_NAME[plan]} isn't available yet — email info@quickfreightcalc.com and we'll set you up.` })
    };
  }
  // A free trial of Pro Plus or Pro Max, once per account.
  const trial = TRIAL_PLANS.includes(plan) && trialEligible(proRow);
  const siteUrl = process.env.DEPLOY_URL && process.env.DEPLOY_URL.includes('dev--')
    ? process.env.DEPLOY_URL
    : 'https://quickfreightcalc.com';

  try {
    const params = {
      'mode': 'subscription',
      'allow_promotion_codes': 'true',
      'line_items[0][price]': priceId,
      'line_items[0][quantity]': '1',
      'customer_email': email,
      'client_reference_id': userId,
      'success_url': `${siteUrl}/?checkout=success`,
      'cancel_url': `${siteUrl}/signup.html?checkout=cancelled`,
      'subscription_data[metadata][userId]': userId,
      'subscription_data[metadata][plan]': plan,
      'subscription_data[metadata][interval]': interval,
      'metadata[userId]': userId,
      'metadata[plan]': plan,
      'metadata[interval]': interval,
    };
    if(trial){
      // The card is collected now and charged when the trial ends; without one
      // the subscription simply ends with the trial.
      params['subscription_data[trial_period_days]'] = String(TRIAL_DAYS);
      params['subscription_data[trial_settings][end_behavior][missing_payment_method]'] = 'cancel';
      params['payment_method_collection'] = 'always';
      params['subscription_data[metadata][trial]'] = 'true';
    }
    const resp = await stripeRequest('/v1/checkout/sessions', 'POST', params);

    if(resp.body.error){
      return { statusCode: 400, body: JSON.stringify({ error: resp.body.error.message }) };
    }

    return {
      statusCode: 200,
      body: JSON.stringify({ url: resp.body.url, interval, trialDays: trial ? TRIAL_DAYS : 0 })
    };
  } catch(err){
    console.error('create-checkout error:', err);
    return { statusCode: 500, body: JSON.stringify({ error: err.message }) };
  }
};
