// tests/plans_test.js — the paid plans and the January 1, 2027 changeover:
// daily limits (routes.js), checkout, plan switches (change-plan.js), the
// Stripe webhook, verify-pro and the scheduled apply-plan-changes job.
// Stripe, Supabase and Google are stubbed: nothing leaves this machine.
// Run from the repository root: node tests/plans_test.js
const assert = require('assert');
const path = require('path');
const crypto = require('crypto');
const https = require('https');
const { EventEmitter } = require('events');
const fn = (name) => path.join(__dirname, '..', 'netlify/functions', name);

let passed = 0;
function ok(cond, label, detail) {
  assert.ok(cond, label + (detail ? ' — ' + detail : ''));
  passed++;
  console.log('PASS  ' + label);
}

// ── https stub (create-checkout, change-plan, stripe-webhook, verify-pro) ──
let calls = [];
let respond = () => ({ status: 500, body: {} });
function fakeRequest(opts, cb) {
  const req = new EventEmitter();
  let body = '';
  req.write = (chunk) => { body += chunk; };
  req.end = () => setImmediate(() => {
    const call = { method: opts.method || 'GET', host: opts.hostname, path: opts.path, body };
    calls.push(call);
    const r = respond(call);
    const res = new EventEmitter();
    res.statusCode = r.status;
    cb(res);
    res.emit('data', typeof r.body === 'string' ? r.body : JSON.stringify(r.body));
    res.emit('end');
  });
  return req;
}
https.request = fakeRequest;
https.get = (opts, cb) => { const r = fakeRequest({ ...opts, method: 'GET' }, cb); r.end(); return r; };

// ── fetch stub (routes.js, the webhook's subscription read, apply-plan-changes) ──
let fcalls = [];
let fetchRespond = () => { throw new Error('unexpected fetch'); };
global.fetch = async (url, opts = {}) => {
  url = String(url);
  fcalls.push({ url, opts });
  const r = fetchRespond(url, opts);
  const status = r.status || 200;
  return { ok: status < 400, status, json: async () => r.body, text: async () => JSON.stringify(r.body) };
};

process.env.GMAPS_API_KEY = 'k';
process.env.SUPABASE_SERVICE_KEY = 'svc';
process.env.STRIPE_SECRET_KEY = 'sk_test_x';
process.env.STRIPE_PRICE_ID = 'price_original';   // the original $4.99 Pro price
process.env.STRIPE_PRICE_ID_PRO = 'price_pro';     // new $9.99 Pro
process.env.STRIPE_PRICE_ID_PLUS = 'price_plus';
process.env.STRIPE_PRICE_ID_MAX = 'price_max';
process.env.STRIPE_PRICE_ID_API = 'price_api';
process.env.STRIPE_PRICE_ID_PRO_YEARLY = 'price_pro_year';     // $99/year
process.env.STRIPE_PRICE_ID_PLUS_YEARLY = 'price_plus_year';   // $199/year
process.env.STRIPE_PRICE_ID_MAX_YEARLY = 'price_max_year';     // $499/year
process.env.STRIPE_WEBHOOK_SECRET = 'whsec_test';

const realNow = Date.now;
const at = (iso) => { Date.now = () => Date.parse(iso); };
const secs = (iso) => Date.parse(iso) / 1000;
const JAN1 = '2027-01-01T05:00:00.000Z';

(async () => {
  // ═══ routes.js — daily quotes per plan ═════════════════════════════════════
  const routes = require(fn('routes.js'));
  let proRow = null;
  let laneAllowed = true;
  let seatOn = null;   // a team owner whose plan user-1 has a seat on (effective_account)
  fetchRespond = (url) => {
    if (url.endsWith('/auth/v1/user')) return { body: { id: 'user-1' } };
    if (url.includes('/rest/v1/rpc/effective_account')) {
      return { body: { account_id: seatOn || 'user-1', role: seatOn ? 'member' : null, seated: !!seatOn, owner_id: seatOn, team_size: seatOn ? 3 : 1, row: proRow } };
    }
    if (url.includes('/rest/v1/rpc/record_lane_usage')) return { body: { allowed: laneAllowed, used: laneAllowed ? 7 : 100 } };
    if (url.includes('/rest/v1/rpc/lanes_used_today')) return { body: 42 };
    if (url.startsWith('https://routes.googleapis.com/')) return { body: { routes: [{ distanceMeters: 1609, duration: '60s' }] } };
    throw new Error('unexpected fetch ' + url);
  };
  async function run(row, nowIso, allowed = true) {
    proRow = row; laneAllowed = allowed; fcalls = []; at(nowIso);
    const res = await routes.handler({
      httpMethod: 'POST',
      headers: { 'x-nf-client-connection-ip': '198.51.100.7', ...(row ? { authorization: 'Bearer tok' } : {}) },
      body: JSON.stringify({ origin: 'Lancaster, PA', destination: 'New York, NY' }),
    });
    Date.now = realNow;
    return JSON.parse(res.body);
  }
  const rpc = () => fcalls.filter((c) => c.url.includes('record_lane_usage')).map((c) => JSON.parse(c.opts.body));
  const google = () => fcalls.filter((c) => c.url.startsWith('https://routes.googleapis.com/')).length;
  const active = (extra) => ({ is_active: true, plan: 'pro', grandfathered: false, billing_period_start: '2026-11-20T10:00:00Z', stripe_subscription_id: 'sub_1', ...extra });

  await run(null, '2026-11-21T15:00:00Z');
  ok(rpc()[0].p_limit === 5 && rpc()[0].p_identity === 'ip:198.51.100.7', 'free: 5 quotes a day, counted by IP');
  let r = await run(null, '2026-11-21T15:00:00Z', false);
  ok(r.limit && r.plan === 'free' && google() === 0, 'free over the limit: Pro offered, no Google call');
  await run(active(), '2026-11-21T15:00:00Z');
  ok(rpc()[0].p_limit === 100 && rpc()[0].p_identity === 'user:user-1', 'new Pro subscriber: 100 a day from the start');
  r = await run(active(), '2026-11-21T15:00:00Z', false);
  ok(r.plan === 'pro' && /Pro Plus/.test(r.error) && /Pro Max/.test(r.error) && google() === 0, 'Pro over the limit: offers Pro Plus and Pro Max');
  for (const [plan, limit] of [['plus', 250], ['max', 1000], ['api', 1000], ['unlimited', 100]]) {
    await run(active({ plan }), '2026-11-21T15:00:00Z');
    ok(rpc()[0].p_limit === limit, `${plan}: ${limit} a day`);
  }
  r = await run(active({ plan: 'max' }), '2026-11-21T15:00:00Z', false);
  ok(r.plan === 'max' && /1,000 quotes/.test(r.error) && /manually/.test(r.error), 'Pro Max over the limit: miles by hand, no upsell');

  const original = (extra) => active({ grandfathered: true, billing_period_start: null, ...extra });
  await run(original(), '2026-11-20T15:00:00Z');
  ok(rpc().length === 0 && google() === 1, 'original plan in November: unlimited');
  await run(original({ billing_period_start: '2026-12-15T10:00:00Z' }), '2026-12-20T15:00:00Z');
  ok(rpc().length === 0, 'original plan, renewed Dec 15: still unlimited');
  await run(original({ billing_period_start: '2027-01-01T00:30:00Z' }), '2027-01-02T15:00:00Z');
  ok(rpc().length === 0, 'renewed Dec 31 at 7:30 pm Eastern: unlimited until the next bill');
  await run(original({ plan: 'plus', billing_period_start: '2027-01-15T10:00:00Z' }), '2027-01-16T15:00:00Z');
  ok(rpc()[0].p_limit === 250, 'first bill on or after Jan 1 (on Pro Plus): 250 a day');
  await run(original({ billing_period_start: '2026-12-15T10:00:00Z' }), '2027-02-04T15:00:00Z');
  ok(rpc()[0].p_limit === 100, 'renewal never recorded: limited after the Feb 3 backstop');
  await run(original({ is_active: false }), '2026-11-20T15:00:00Z');
  ok(rpc()[0].p_limit === 5 && rpc()[0].p_identity === 'user:user-1', 'cancelled account: free limit');
  const comp = { is_active: true, plan: 'pro', grandfathered: true, billing_period_start: null, stripe_subscription_id: null };
  await run(comp, '2026-11-20T15:00:00Z');
  ok(rpc().length === 0 && google() === 1, 'comp account (coworker): unlimited now');
  await run(comp, '2027-03-01T15:00:00Z');
  ok(rpc().length === 0 && google() === 1, 'comp account: still unlimited after January (no backstop)');
  await run({ ...comp, is_active: false }, '2027-03-01T15:00:00Z');
  ok(rpc()[0].p_limit === 5, 'comp access turned off: free limit');

  // The usage meter: every answer says how many of today's quotes are used
  r = await run(active({ plan: 'plus' }), '2026-11-21T15:00:00Z');
  ok(r.routes && r.usage && r.usage.used === 7 && r.usage.limit === 250 && r.usage.plan === 'plus' && r.usage.trial === false,
     'usage meter: the answer says 7 of 250 used today', JSON.stringify(r.usage));
  r = await run(null, '2026-11-21T15:00:00Z', false);
  ok(r.usage && r.usage.used === 100 && r.usage.limit === 5 && r.usage.plan === 'free', 'usage meter: over the limit, still told how many');
  r = await run(comp, '2026-11-21T15:00:00Z');
  ok(r.usage && r.usage.limit === null && r.usage.used === null, 'usage meter: comp account has no limit (nothing to show)');
  async function usageOnly(row) {
    proRow = row; fcalls = []; at('2026-11-21T15:00:00Z');
    const res = await routes.handler({ httpMethod: 'POST', headers: { 'x-nf-client-connection-ip': '198.51.100.7', ...(row ? { authorization: 'Bearer tok' } : {}) },
      body: JSON.stringify({ usage: true }) });
    Date.now = realNow;
    return JSON.parse(res.body);
  }
  r = await usageOnly(active());
  ok(r.usage && r.usage.used === 42 && r.usage.limit === 100 && google() === 0 && rpc().length === 0,
     'usage meter on page load: today\'s count read, nothing counted, no Google call');
  r = await usageOnly(null);
  ok(r.usage && r.usage.limit === 5 && r.usage.plan === 'free' && fcalls.some((c) => c.url.includes('lanes_used_today') && JSON.parse(c.opts.body).p_identity === 'ip:198.51.100.7'),
     'usage meter, not signed in: the 5 free quotes, counted by IP');

  // A free trial: 100 a day whatever the plan, back to the plan's own limit after it
  await run(active({ plan: 'max', trial_ends_at: '2026-11-30T10:00:00Z' }), '2026-11-21T15:00:00Z');
  ok(rpc()[0].p_limit === 100, 'free trial of Pro Max: 100 a day during the trial');
  r = await run(active({ plan: 'max', trial_ends_at: '2026-11-30T10:00:00Z' }), '2026-11-21T15:00:00Z', false);
  ok(r.trial === true && /free trial/.test(r.error) && !/Pro Max \(/.test(r.error) && r.usage.trial === true && google() === 0,
     'free trial over 100: told it\'s the trial\'s limit, no upsell');
  await run(active({ plan: 'max', trial_ends_at: '2026-11-20T10:00:00Z' }), '2026-11-21T15:00:00Z');
  ok(rpc()[0].p_limit === 1000, 'trial over (paid now): the plan\'s 1,000 a day');

  // A team member quotes on the owner's plan and shares the owner's daily limit
  seatOn = 'owner-1';
  await run(active({ plan: 'max' }), '2026-11-21T15:00:00Z');
  ok(rpc()[0].p_limit === 1000 && rpc()[0].p_identity === 'user:owner-1', 'team member: the owner\'s Pro Max limit, counted for the whole team');
  r = await run(active({ plan: 'max' }), '2026-11-21T15:00:00Z', false);
  ok(r.plan === 'max' && /^Your team has used today's 1,000 quotes/.test(r.error) && google() === 0, 'team over the limit: worded for the team, no upsell');
  seatOn = null;

  // ═══ create-checkout.js ═══════════════════════════════════════════════════
  const checkout = require(fn('create-checkout.js'));
  let checkoutRow = null;
  respond = (c) => {
    if (c.path === '/auth/v1/user') return { status: 200, body: { id: 'user-1' } };
    if (c.path.startsWith('/rest/v1/pro_users')) return { status: 200, body: checkoutRow ? [checkoutRow] : [] };
    if (c.path === '/v1/checkout/sessions') return { status: 200, body: { url: 'https://checkout.stripe.com/c/pay/cs_test' } };
    return { status: 404, body: {} };
  };
  const startCheckout = (plan) => checkout.handler({ httpMethod: 'POST',
    body: JSON.stringify({ userId: 'user-1', email: 'a@b.co', accessToken: 'tok', ...(plan ? { plan } : {}) }) });
  const sessionParams = () => new URLSearchParams(calls.find((c) => c.path === '/v1/checkout/sessions').body);
  for (const [plan, price] of [[undefined, 'price_pro'], ['plus', 'price_plus'], ['max', 'price_max'], ['api', 'price_api']]) {
    calls = []; checkoutRow = { is_active: false };
    const res = await startCheckout(plan);
    ok(res.statusCode === 200 && sessionParams().get('line_items[0][price]') === price
       && sessionParams().get('metadata[plan]') === (plan || 'pro'), `new signup, ${plan || 'Pro'}: sold at ${price}`);
  }
  delete process.env.STRIPE_PRICE_ID_PRO;
  calls = []; checkoutRow = null;
  await startCheckout();
  ok(sessionParams().get('line_items[0][price]') === 'price_original', 'new Pro price not set yet: Pro still sold at the original price');
  process.env.STRIPE_PRICE_ID_PRO = 'price_pro';
  calls = []; checkoutRow = { is_active: true, plan: 'pro', stripe_subscription_id: 'sub_1' };
  let res = await startCheckout('plus');
  ok(res.statusCode === 409 && !calls.some((c) => c.path === '/v1/checkout/sessions'), 'already subscribed: 409, no second subscription');
  calls = []; checkoutRow = null; delete process.env.STRIPE_PRICE_ID_PLUS;
  res = await startCheckout('plus');
  ok(res.statusCode === 503 && /Pro Plus isn't available yet/.test(JSON.parse(res.body).error), 'Pro Plus price not set up: friendly 503');
  process.env.STRIPE_PRICE_ID_PLUS = 'price_plus';

  // Yearly billing
  const startYearly = (plan, interval) => checkout.handler({ httpMethod: 'POST',
    body: JSON.stringify({ userId: 'user-1', email: 'a@b.co', accessToken: 'tok', plan, interval }) });
  for (const [plan, price] of [['pro', 'price_pro_year'], ['plus', 'price_plus_year'], ['max', 'price_max_year']]) {
    calls = []; checkoutRow = { is_active: false, stripe_customer_id: 'cus_old' };
    res = await startYearly(plan, 'year');
    ok(res.statusCode === 200 && sessionParams().get('line_items[0][price]') === price && sessionParams().get('metadata[interval]') === 'year'
       && JSON.parse(res.body).interval === 'year', `yearly ${plan}: sold at ${price}`);
  }
  calls = []; checkoutRow = null;
  res = await startYearly('api', 'year');
  ok(sessionParams().get('line_items[0][price]') === 'price_api' && sessionParams().get('metadata[interval]') === 'month', 'API asked for yearly: monthly (the API plan is monthly only)');
  calls = []; checkoutRow = null; delete process.env.STRIPE_PRICE_ID_MAX_YEARLY;
  res = await startYearly('max', 'year');
  ok(res.statusCode === 503 && /Yearly billing for Pro Max isn't available yet/.test(JSON.parse(res.body).error) && !calls.some((c) => c.path === '/v1/checkout/sessions'),
     'yearly price not set: friendly 503, no checkout');
  ok(JSON.stringify(require('../netlify/lib/plans.js').yearlyPlans()) === '["pro","plus"]', 'yearlyPlans: only the plans whose yearly price is set');
  process.env.STRIPE_PRICE_ID_MAX_YEARLY = 'price_max_year';

  // The free trial: Pro Plus and Pro Max, first subscription only
  const trialDays = () => sessionParams().get('subscription_data[trial_period_days]');
  for (const [plan, interval, rowNow, days, label] of [
    ['plus', 'month', null, '7', 'first subscription, Pro Plus: 7-day free trial'],
    ['max', 'year', { is_active: false }, '7', 'first subscription, Pro Max yearly: 7-day free trial'],
    ['pro', 'month', null, null, 'Pro: no trial'],
    ['api', 'month', null, null, 'API: no trial'],
    ['plus', 'month', { is_active: false, stripe_customer_id: 'cus_old' }, null, 'had a subscription before: no second trial'],
    ['max', 'month', { is_active: false, stripe_subscription_id: 'sub_old' }, null, 'an old subscription on file: no trial'],
  ]) {
    calls = []; checkoutRow = rowNow;
    res = await startYearly(plan, interval);
    ok(res.statusCode === 200 && trialDays() === days && JSON.parse(res.body).trialDays === (days ? 7 : 0)
       && (days ? sessionParams().get('payment_method_collection') === 'always'
            && sessionParams().get('subscription_data[trial_settings][end_behavior][missing_payment_method]') === 'cancel' : true),
       label);
  }

  // Yearly prices are new-plan prices, never the original plan
  const P = require('../netlify/lib/plans.js');
  ok(!P.isOriginalPlanPrice('price_plus_year') && !P.isOriginalPlanPrice('price_pro_year') && P.isOriginalPlanPrice('price_original'),
     'a yearly price is a new plan, not the original $4.99 plan');
  ok(P.planForPriceIds(['price_max_year']) === 'max' && P.planForPriceIds(['price_plus_year']) === 'plus' && P.planForPriceIds(['price_pro_year']) === 'pro',
     'yearly prices map to their plans');
  ok(P.intervalForPriceIds(['price_plus_year']) === 'year' && P.intervalForPriceIds(['price_plus']) === 'month' && P.intervalForPriceIds(['price_original']) === 'month',
     'billing interval from the price');

  // ═══ change-plan.js ═══════════════════════════════════════════════════════
  const changePlan = require(fn('change-plan.js'));
  let row = null; let sub = null; let updateReply = null;
  respond = (c) => {
    if (c.path === '/auth/v1/user') return { status: 200, body: { id: 'user-1' } };
    if (c.path.startsWith('/rest/v1/pro_users') && c.method === 'GET') return { status: 200, body: row ? [row] : [] };
    if (c.path.startsWith('/rest/v1/pro_users') && c.method === 'PATCH') return { status: 204, body: '' };
    if (c.path === '/v1/subscriptions/sub_1' && c.method === 'GET') return { status: 200, body: sub };
    if (c.path === '/v1/subscriptions/sub_1' && c.method === 'POST') return updateReply(new URLSearchParams(c.body));
    return { status: 404, body: {} };
  };
  const subWith = (price, end = '2026-12-10T12:00:00Z', extra = {}) => ({ id: 'sub_1', status: 'active',
    current_period_start: secs('2026-11-10T12:00:00Z'), current_period_end: secs(end),
    items: { data: [{ id: 'si_1', price: { id: price } }] }, ...extra });
  const applied = (p) => ({ status: 200, body: { ...subWith(p.get('items[0][price]')), pending_update: null } });
  const change = async (plan) => {
    const x = await changePlan.handler({ httpMethod: 'POST', body: JSON.stringify({ userId: 'user-1', accessToken: 'tok', plan }) });
    return { code: x.statusCode, ...JSON.parse(x.body) };
  };
  const posts = () => calls.filter((c) => c.method === 'POST' && c.path === '/v1/subscriptions/sub_1');
  const update = () => new URLSearchParams(posts()[0].body);
  const patched = () => JSON.parse(calls.find((c) => c.method === 'PATCH').body);
  const paidRow = () => ({ is_active: true, plan: 'pro', stripe_subscription_id: 'sub_1' });
  at('2026-11-20T15:00:00Z');

  calls = []; row = paidRow(); sub = subWith('price_original'); updateReply = applied;
  let o = await change('plus');
  ok(o.status === 'ok' && o.atRenewal === true && o.startsAt === JAN1 && posts().length === 0
     && patched().next_plan === 'plus' && patched().grandfathered === true && !('plan' in patched()),
     'original plan picks Pro Plus in November: choice saved, nothing sent to Stripe or charged');
  calls = []; sub = subWith('price_original', '2027-01-10T12:00:00Z');
  o = await change('max');
  ok(o.atRenewal === true && update().get('items[0][price]') === 'price_max' && update().get('proration_behavior') === 'none'
     && !update().get('payment_behavior') && patched().plan === 'max' && patched().next_plan === 'max',
     'next bill already after Jan 1: switched to Pro Max now, no proration, nothing charged');
  calls = []; sub = subWith('price_original', '2027-01-10T12:00:00Z', { cancel_at_period_end: true });
  o = await change('plus');
  ok(o.status === 'ok' && posts().length === 0 && patched().next_plan === 'plus', 'cancelling at period end: choice saved, Stripe left alone');
  calls = []; sub = subWith('price_original');
  o = await change('api');
  ok(o.status === 'ok' && o.atRenewal === false && update().get('items[0][price]') === 'price_api'
     && update().get('proration_behavior') === 'always_invoice' && update().get('payment_behavior') === 'pending_if_incomplete'
     && patched().plan === 'api' && patched().next_plan === 'api',
     'original plan → API: charged now (available now), applied once paid');
  calls = []; sub = subWith('price_pro');
  o = await change('plus');
  ok(update().get('proration_behavior') === 'always_invoice' && update().get('payment_behavior') === 'pending_if_incomplete',
     'Pro → Pro Plus: prorated now, applied once paid');
  calls = []; row.plan = 'max'; sub = subWith('price_max');
  o = await change('plus');
  ok(update().get('proration_behavior') === 'create_prorations' && !update().get('payment_behavior'), 'Pro Max → Pro Plus: credit on next invoice');
  calls = []; row.plan = 'pro'; sub = subWith('price_pro');
  updateReply = () => ({ status: 200, body: { ...subWith('price_pro'), pending_update: { expires_at: 1 }, latest_invoice: { hosted_invoice_url: 'https://invoice.stripe.com/i/acct/inv_1' } } });
  o = await change('max');
  ok(o.status === 'needs_payment' && o.url.startsWith('https://invoice.stripe.com/') && !calls.some((c) => c.method === 'PATCH'), 'card needs attention: invoice link, plan unchanged');
  updateReply = applied;
  calls = []; sub = subWith('price_plus'); row.plan = 'plus';
  o = await change('plus');
  ok(o.status === 'ok' && o.unchanged && posts().length === 0, 'already on that price: nothing sent to Stripe');
  calls = []; row = { is_active: true, plan: 'pro', stripe_subscription_id: null };
  o = await change('max');
  ok(o.code === 400 && o.error === 'not_billed_by_stripe' && !calls.some((c) => c.host === 'api.stripe.com'), 'comp account: told to contact you');
  calls = []; row = { is_active: false, stripe_subscription_id: 'sub_1' };
  o = await change('plus');
  ok(o.code === 400 && o.error === 'not_subscribed', 'inactive account: must subscribe first');
  const bad = await changePlan.handler({ httpMethod: 'POST', body: JSON.stringify({ userId: 'someone-else', accessToken: 'tok', plan: 'plus' }) });
  ok(bad.statusCode === 401, 'token for a different user: 401');

  // Monthly ↔ yearly
  const changeTo = async (plan, interval) => {
    const x = await changePlan.handler({ httpMethod: 'POST', body: JSON.stringify({ userId: 'user-1', accessToken: 'tok', plan, interval }) });
    return { code: x.statusCode, ...JSON.parse(x.body) };
  };
  calls = []; row = paidRow(); row.plan = 'plus'; sub = subWith('price_plus');
  o = await changeTo('plus', 'year');
  ok(o.status === 'ok' && o.interval === 'year' && update().get('items[0][price]') === 'price_plus_year'
     && update().get('proration_behavior') === 'always_invoice' && update().get('payment_behavior') === 'pending_if_incomplete'
     && patched().billing_interval === 'year' && patched().plan === 'plus',
     'Pro Plus monthly → yearly: the year charged now (less the unused month), applied once paid');
  calls = []; sub = subWith('price_plus_year');
  o = await changeTo('max');
  ok(update().get('items[0][price]') === 'price_max_year' && o.interval === 'year', 'yearly Pro Plus → Pro Max: stays yearly');
  calls = []; row.plan = 'max'; sub = subWith('price_max_year');
  o = await changeTo('max', 'month');
  ok(update().get('items[0][price]') === 'price_max' && update().get('proration_behavior') === 'always_invoice'
     && !update().get('payment_behavior') && patched().billing_interval === 'month',
     'yearly → monthly: new monthly period now, the unused year credited');
  calls = []; sub = subWith('price_max_year');
  o = await changeTo('api', 'year');
  ok(update().get('items[0][price]') === 'price_api' && o.interval === 'month', 'yearly → API: monthly (the API plan is monthly only)');
  calls = []; row = { ...paidRow(), grandfathered: true, billing_period_start: null }; sub = subWith('price_original');
  o = await changeTo('plus', 'year');
  ok(o.code === 400 && o.error === 'yearly_after_january' && posts().length === 0 && !calls.some((c) => c.method === 'PATCH'),
     'original plan asks for yearly: after the January move, nothing changed');
  calls = []; row = { ...paidRow(), grandfathered: true, billing_period_start: '2027-01-12T10:00:00Z' }; sub = subWith('price_pro', '2027-02-12T10:00:00Z');
  o = await changeTo('pro', 'year');
  ok(o.status === 'ok' && update().get('items[0][price]') === 'price_pro_year', 'after the January move: yearly is available');
  calls = []; row = paidRow(); sub = subWith('price_pro'); delete process.env.STRIPE_PRICE_ID_PRO_YEARLY;
  o = await changeTo('pro', 'year');
  ok(o.code === 503 && o.error === 'not_available' && posts().length === 0, 'yearly price not set: 503, nothing changed');
  process.env.STRIPE_PRICE_ID_PRO_YEARLY = 'price_pro_year';
  const badInterval = await changePlan.handler({ httpMethod: 'POST', body: JSON.stringify({ userId: 'user-1', accessToken: 'tok', plan: 'plus', interval: 'week' }) });
  ok(badInterval.statusCode === 400, 'unknown billing interval: 400');

  // On a free trial: change plans freely, nothing charged, the trial's end date kept
  calls = []; row = paidRow(); row.plan = 'max'; sub = subWith('price_max', '2026-12-01T12:00:00Z', { status: 'trialing', trial_end: secs('2026-12-01T12:00:00Z') });
  o = await changeTo('plus');
  ok(o.status === 'ok' && update().get('items[0][price]') === 'price_plus' && update().get('proration_behavior') === 'none'
     && update().get('trial_end') === String(secs('2026-12-01T12:00:00Z')) && !update().get('payment_behavior'),
     'trial of Pro Max → Pro Plus: nothing charged, trial still ends Dec 1');
  calls = []; sub = subWith('price_plus', '2026-12-01T12:00:00Z', { status: 'trialing', trial_end: secs('2026-12-01T12:00:00Z') });
  o = await changeTo('plus', 'year');
  ok(update().get('items[0][price]') === 'price_plus_year' && update().get('proration_behavior') === 'none' && update().get('trial_end'),
     'trial, monthly → yearly: nothing charged now, the year billed when the trial ends');
  Date.now = realNow;

  // ═══ stripe-webhook.js ════════════════════════════════════════════════════
  const webhook = require(fn('stripe-webhook.js'));
  const patches = [];
  respond = (c) => {
    if (c.method === 'GET' && c.path.startsWith('/rest/v1/pro_users')) return { status: 200, body: [{ id: 'user-1', is_active: true }] };
    if (c.method === 'PATCH') { patches.push(JSON.parse(c.body)); return { status: 200, body: '' }; }
    return { status: 200, body: {} };
  };
  let newSubPrice = 'price_plus';
  fetchRespond = (url) => {
    if (url.startsWith('https://api.stripe.com/v1/subscriptions/')) {
      return { body: { id: 'sub_1', current_period_start: secs('2026-11-20T10:00:00Z'), current_period_end: secs('2026-12-20T10:00:00Z'),
        items: { data: [{ price: { id: newSubPrice } }] } } };
    }
    throw new Error('unexpected fetch ' + url);
  };
  const send = (evt) => {
    const payload = JSON.stringify(evt);
    const t = Math.floor(Date.now() / 1000);
    const sig = crypto.createHmac('sha256', 'whsec_test').update(`${t}.${payload}`).digest('hex');
    return webhook.handler({ httpMethod: 'POST', headers: { 'stripe-signature': `t=${t},v1=${sig}` }, body: payload });
  };
  const checkoutEvent = (plan) => ({ type: 'checkout.session.completed', data: { object: { client_reference_id: 'user-1',
    customer: 'cus_1', subscription: 'sub_1', metadata: plan ? { plan } : {} } } });
  await send(checkoutEvent('plus'));
  let p = patches.at(-1);
  ok(p.plan === 'plus' && p.is_active === true && p.grandfathered === false && p.next_plan === 'plus'
     && p.billing_period_start === '2026-11-20T10:00:00.000Z' && p.renews_at === '2026-12-20T10:00:00.000Z',
     'webhook: new Pro Plus checkout → new plan from day one, billing period recorded');
  ok(p.cancel_at === null, 'webhook: new checkout → not set to end');
  ok(p.billing_interval === 'month' && p.trial_ends_at === null && p.trial_reminder_sent_at === null, 'webhook: checkout records monthly billing, no trial');
  newSubPrice = 'price_original';
  await send(checkoutEvent());
  ok(patches.at(-1).grandfathered === true, 'webhook: checkout at the original price (new Pro price not set) → original plan');
  ok(patches.at(-1).next_plan === null, 'webhook: …with the January plan still to choose');
  const updated = (price, extra = {}) => ({ type: 'customer.subscription.updated', data: { object: { id: 'sub_1', status: 'active',
    metadata: { userId: 'user-1' }, current_period_start: secs('2026-12-15T10:00:00Z'), current_period_end: secs('2027-01-15T10:00:00Z'),
    items: { data: [{ price: { id: price } }] }, ...extra } } });
  await send(updated('price_original'));
  p = patches.at(-1);
  ok(p.plan === 'pro' && p.grandfathered === true && p.billing_period_start === '2026-12-15T10:00:00.000Z',
     'webhook: renewal on the original price → stays marked, period recorded');
  ok(p.cancel_at === null, 'webhook: renewal → not set to end');
  await send(updated('price_original', { cancel_at_period_end: true, cancel_at: secs('2027-01-15T10:00:00Z') }));
  ok(patches.at(-1).cancel_at === '2027-01-15T10:00:00.000Z' && patches.at(-1).is_active === true,
     'webhook: set to cancel at the end of the period → cancel_at recorded, still active');
  await send(updated('price_original', { cancel_at_period_end: true }));
  ok(patches.at(-1).cancel_at === '2027-01-15T10:00:00.000Z', 'webhook: …from the period end when Stripe leaves cancel_at out');
  await send(updated('price_original', { cancel_at_period_end: false, cancel_at: null }));
  ok(patches.at(-1).cancel_at === null, 'webhook: renewed again → cancel_at cleared');
  await send(updated('price_max'));
  p = patches.at(-1);
  ok(p.plan === 'max' && !('grandfathered' in p), 'webhook: new price → plan from the price, marker untouched');
  ok(p.billing_interval === 'month' && p.trial_ends_at === null, 'webhook: monthly, not on a trial');
  await send(updated('price_max_year'));
  ok(patches.at(-1).plan === 'max' && patches.at(-1).billing_interval === 'year' && !('grandfathered' in patches.at(-1)),
     'webhook: yearly Pro Max → Pro Max, billed yearly (not the original plan)');
  await send(updated('price_plus', { status: 'trialing', trial_end: secs('2026-12-03T10:00:00Z') }));
  ok(patches.at(-1).is_active === true && patches.at(-1).trial_ends_at === '2026-12-03T10:00:00.000Z',
     'webhook: on a free trial → active, with the trial\'s end');
  await send({ type: 'customer.subscription.deleted', data: { object: { id: 'sub_1', metadata: { userId: 'user-1' } } } });
  p = patches.at(-1);
  ok(p.is_active === false && p.plan === 'pro' && p.grandfathered === false && p.next_plan === null && p.cancel_at === null,
     'webhook: cancelled → inactive; a later subscription starts on the new plans');

  // ═══ verify-pro.js ════════════════════════════════════════════════════════
  const verify = require(fn('verify-pro.js'));
  let vrow = null;
  let vseat = null;   // { owner } while user-1 has a seat on someone's team
  respond = (c) => {
    if (c.path === '/auth/v1/user') return { status: 200, body: { id: 'user-1' } };
    return { status: 404, body: {} };
  };
  fetchRespond = (url) => {
    if (url.includes('/rest/v1/rpc/effective_account')) {
      return { body: { account_id: vseat ? vseat.owner : 'user-1', role: vseat ? 'member' : null, seated: !!vseat, owner_id: vseat && vseat.owner, team_size: vseat ? 3 : 1, row: vrow } };
    }
    throw new Error('unexpected fetch ' + url);
  };
  const vp = async () => JSON.parse((await verify.handler({ httpMethod: 'POST', body: JSON.stringify({ userId: 'user-1', accessToken: 'tok' }) })).body);
  at('2026-11-20T15:00:00Z');
  vrow = { is_active: true, plan: 'pro', next_plan: 'plus', grandfathered: true, billing_period_start: null, stripe_subscription_id: 'sub_1' };
  let v = await vp();
  ok(v.active && v.paid && v.unlimitedUntilRenewal === true && v.nextPlan === 'plus' && v.newPlansStart === JAN1,
     'verify-pro: original plan → unlimited until January, with the chosen plan');
  ok(v.planChosen === true && v.cancelAt === null, 'verify-pro: …marked as chosen, not set to end');
  ok(v.interval === 'month' && v.trialEndsAt === null && v.trialEligible === false, 'verify-pro: monthly, no trial, can\'t start one (subscribed)');
  vrow.next_plan = null;
  v = await vp();
  ok(v.nextPlan === 'pro' && v.planChosen === false, 'verify-pro: no choice yet → moves to Pro, not chosen');
  vrow.cancel_at = '2026-12-14T10:00:00Z';
  ok((await vp()).cancelAt === '2026-12-14T10:00:00Z', 'verify-pro: set to end → cancelAt');
  delete vrow.cancel_at;
  vrow = { is_active: true, plan: 'api', next_plan: 'api', grandfathered: true, billing_period_start: '2026-11-10T00:00:00Z', stripe_subscription_id: 'sub_1' };
  ok((await vp()).unlimitedUntilRenewal === false, 'verify-pro: moved to the API plan → nothing left to choose');
  vrow = { is_active: true, plan: 'plus', grandfathered: false, stripe_subscription_id: 'sub_2', billing_interval: 'year', trial_ends_at: '2026-11-29T10:00:00Z' };
  v = await vp();
  ok(v.interval === 'year' && v.trialEndsAt === '2026-11-29T10:00:00Z', 'verify-pro: billed yearly, on a trial until Nov 29');
  vrow = { is_active: false, plan: 'pro' };
  ok((await vp()).trialEligible === true, 'verify-pro: never subscribed → can start a free trial');
  vrow = { is_active: false, plan: 'pro', had_subscription: true };
  ok((await vp()).trialEligible === false, 'verify-pro: subscribed before → no second trial');
  vrow = { is_active: true, plan: 'plus', grandfathered: false, stripe_subscription_id: 'sub_2' };
  v = await vp();
  ok(v.active && v.plan === 'plus' && v.unlimitedUntilRenewal === false && v.nextPlan === null && v.planChosen === false,
     'verify-pro: new subscriber → their plan, no notice');
  at('2027-01-11T15:00:00Z');
  vrow = { is_active: true, plan: 'plus', grandfathered: true, billing_period_start: '2027-01-10T12:00:00Z', stripe_subscription_id: 'sub_1' };
  ok((await vp()).unlimitedUntilRenewal === false, 'verify-pro: after the first January bill → on the new plan');
  at('2026-11-20T15:00:00Z');
  vseat = { owner: 'owner-1' };
  vrow = { is_active: true, plan: 'max', grandfathered: true, billing_period_start: null, renews_at: '2026-12-01T00:00:00Z', stripe_subscription_id: 'sub_9',
    cancel_at: '2026-12-01T00:00:00Z' };
  v = await vp();
  ok(v.active && v.plan === 'max' && v.team && v.team.role === 'member' && v.team.seated === true && v.team.size === 3,
     'verify-pro: a team member is active on the owner\'s plan');
  ok(v.paid === false && v.renewsAt === null && v.unlimitedUntilRenewal === false && v.nextPlan === null
     && v.cancelAt === null && v.planChosen === false,
     'verify-pro: …with none of the owner\'s billing (no renewal date or plan-change notice)');
  vseat = null;
  vrow = { is_active: true, plan: 'max', grandfathered: false, stripe_subscription_id: 'sub_3' };
  ok((await vp()).team === null, 'verify-pro: no team → team is null');
  Date.now = realNow;

  // ═══ apply-plan-changes.js (scheduled) ════════════════════════════════════
  const job = require(fn('apply-plan-changes.js'));
  let subs = {};
  const jobRows = [];
  const stripePosts = [];
  const userPatches = [];
  fetchRespond = (url, opts) => {
    const method = opts.method || 'GET';
    if (url.includes('/rest/v1/pro_users?is_active=eq.true')) return { body: jobRows };
    if (url.includes('/rest/v1/pro_users?id=eq.') && method === 'PATCH') {
      userPatches.push({ id: decodeURIComponent(url.split('id=eq.')[1]), ...JSON.parse(opts.body) });
      return { status: 204, body: null };
    }
    const m = url.match(/^https:\/\/api\.stripe\.com\/v1\/subscriptions\/([^?]+)/);
    if (m && method === 'GET') return subs[m[1]] ? { body: subs[m[1]] } : { status: 404, body: { error: { message: 'No such subscription' } } };
    if (m && method === 'POST') {
      const params = new URLSearchParams(opts.body);
      stripePosts.push({ id: m[1], params });
      subs[m[1]].items.data[0].price.id = params.get('items[0][price]');
      return { body: subs[m[1]] };
    }
    throw new Error('unexpected fetch ' + method + ' ' + url);
  };
  const jobSub = (price, end, extra = {}) => ({ id: 'x', status: 'active', current_period_start: secs('2026-12-01T00:00:00Z'),
    current_period_end: secs(end), items: { data: [{ id: 'si', price: { id: price } }] }, ...extra });
  const addRow = (id, next, grandfathered, s) => {
    jobRows.push({ id, plan: 'pro', next_plan: next, grandfathered, stripe_subscription_id: 'sub_' + id });
    if (s) subs['sub_' + id] = s;
  };
  addRow('u1-aaaaaaaa', 'plus', true, jobSub('price_original', '2027-01-15T10:00:00Z'));
  addRow('u2-aaaaaaaa', null, false, jobSub('price_original', '2026-12-28T10:00:00Z'));
  addRow('u3-aaaaaaaa', null, true, jobSub('price_original', '2027-01-05T10:00:00Z'));
  addRow('u4-aaaaaaaa', 'max', false, jobSub('price_max', '2027-01-20T10:00:00Z'));
  addRow('u5-aaaaaaaa', 'plus', true, jobSub('price_original', '2027-01-07T10:00:00Z', { cancel_at_period_end: true }));
  addRow('u6-aaaaaaaa', null, true, jobSub('price_original', '2027-01-07T10:00:00Z', { status: 'canceled' }));
  addRow('u7-aaaaaaaa', null, true, null);
  at('2026-12-20T12:00:00Z');
  let out = JSON.parse((await job.handler()).body);
  const switched = (id) => stripePosts.find((x) => x.id === 'sub_' + id);
  ok(switched('u1-aaaaaaaa') && switched('u1-aaaaaaaa').params.get('items[0][price]') === 'price_plus'
     && switched('u1-aaaaaaaa').params.get('proration_behavior') === 'none'
     && userPatches.some((x) => x.id === 'u1-aaaaaaaa' && x.plan === 'plus'),
     'job: next bill Jan 15 → switched to the chosen Pro Plus price now, no proration');
  ok(switched('u3-aaaaaaaa') && switched('u3-aaaaaaaa').params.get('items[0][price]') === 'price_pro', 'job: no choice → Pro at $9.99');
  ok(!switched('u2-aaaaaaaa') && userPatches.some((x) => x.id === 'u2-aaaaaaaa' && x.grandfathered === true),
     'job: next bill Dec 28 → not yet (December is still at the old price); marked as original plan');
  ok(!switched('u4-aaaaaaaa') && !userPatches.some((x) => x.id === 'u4-aaaaaaaa'), 'job: already on a new plan → left alone');
  ok(!switched('u5-aaaaaaaa'), 'job: cancelling at period end → left alone');
  ok(!switched('u6-aaaaaaaa') && !switched('u7-aaaaaaaa'), 'job: cancelled or unreadable subscriptions → left alone');
  ok(out.switched === 2 && out.waiting === 1 && out.on_new_plan === 1 && out.cancelling === 1 && out.not_live === 1 && out.stripe_error === 1,
     'job: run summary', JSON.stringify(out));
  stripePosts.length = 0;
  out = JSON.parse((await job.handler()).body);
  ok(stripePosts.length === 0 && out.on_new_plan === 3, 'job: second run changes nothing');
  subs['sub_u2-aaaaaaaa'].current_period_end = secs('2027-01-28T10:00:00Z'); // renewed Dec 28
  delete process.env.STRIPE_PRICE_ID_PRO;
  out = JSON.parse((await job.handler()).body);
  // (With the new Pro price unset, nothing can move to Pro; both Pro-bound subscriptions wait.)
  ok(stripePosts.length === 0 && out.price_missing === 2, 'job: new Pro price not set → waits instead of guessing', JSON.stringify(out));
  process.env.STRIPE_PRICE_ID_PRO = 'price_pro';
  out = JSON.parse((await job.handler()).body);
  ok(stripePosts.length === 1 && stripePosts[0].params.get('items[0][price]') === 'price_pro', 'job: after the Dec 28 renewal → switched for the Jan 28 bill');
  delete process.env.STRIPE_SECRET_KEY;
  ok((await job.handler()).statusCode === 500, 'job: not configured → does nothing');
  process.env.STRIPE_SECRET_KEY = 'sk_test_x';
  Date.now = realNow;

  // ═══ trial-reminders.js ═══════════════════════════════════════════════════
  const reminders = require(fn('trial-reminders.js'));
  const mail = reminders._internal.buildReminder({ plan: 'plus', billing_interval: 'month', trial_ends_at: '2026-11-27T15:00:00Z' }, 'https://quickfreightcalc.com');
  ok(mail.subject === 'Your QuickFreightCalc Pro Plus free trial ends on November 27'
     && /ends on Friday, November 27, 2026/.test(mail.text) && /charged \$19\.99\/month for Pro Plus that day/.test(mail.text)
     && /profile\.html#subscription-paid/.test(mail.text) && /\$19\.99\/month/.test(mail.html),
     'trial reminder: the end date and the price, in plain words', mail.text);
  const yearlyMail = reminders._internal.buildReminder({ plan: 'max', billing_interval: 'year', trial_ends_at: '2026-11-27T15:00:00Z' }, 'https://quickfreightcalc.com');
  ok(/charged \$499\/year for Pro Max/.test(yearlyMail.text) && /every year after/.test(yearlyMail.text), 'trial reminder, yearly: $499/year');
  process.env.RESEND_API_KEY = 're_test';
  const trialRows = [
    { id: 't1-aaaaaaaa', email: 'one@example.com', plan: 'plus', billing_interval: 'month', trial_ends_at: '2026-11-27T15:00:00Z', cancel_at: null },
    { id: 't2-aaaaaaaa', email: 'two@example.com', plan: 'max', billing_interval: 'month', trial_ends_at: '2026-11-27T16:00:00Z', cancel_at: '2026-11-27T16:00:00Z' },
    { id: 't3-aaaaaaaa', email: 'three@example.com', plan: 'max', billing_interval: 'year', trial_ends_at: '2026-11-27T17:00:00Z', cancel_at: null },
  ];
  const claimedBy = new Set(['t1-aaaaaaaa', 't2-aaaaaaaa']);   // t3 was claimed by another run
  const sentTo = []; const releases = []; let listQuery = '';
  fetchRespond = (url, opts) => {
    if (url.includes('/rest/v1/pro_users?is_active=eq.true')) { listQuery = url; return { body: trialRows }; }
    if (url.includes('/rest/v1/pro_users?id=eq.') && opts.method === 'PATCH') {
      const id = decodeURIComponent(url.split('id=eq.')[1].split('&')[0]);
      const body = JSON.parse(opts.body);
      if (body.trial_reminder_sent_at === null) { releases.push(id); return { body: [{ id }] }; }
      return { body: claimedBy.has(id) ? [{ id }] : [] };
    }
    if (url === 'https://api.resend.com/emails') { sentTo.push(JSON.parse(opts.body).to[0]); return { body: { id: 'em_1' } }; }
    throw new Error('unexpected fetch ' + url);
  };
  at('2026-11-24T16:00:00Z');
  let tr = JSON.parse((await reminders.handler()).body);
  ok(/trial_reminder_sent_at=is\.null/.test(listQuery) && /trial_ends_at=gt\.2026-11-24T16/.test(listQuery) && /trial_ends_at=lte\.2026-11-27T16/.test(listQuery),
     'trial reminders: trials ending in the next 3 days, not yet reminded', listQuery);
  ok(sentTo.join() === 'one@example.com' && tr.sent === 1 && tr.skipped === 1 && releases.length === 0,
     'trial reminders: emailed once; set to cancel → skipped; claimed elsewhere → left alone', JSON.stringify(tr));
  claimedBy.add('t3-aaaaaaaa');
  fetchRespond = ((prev) => (url, opts) => (url === 'https://api.resend.com/emails' ? { status: 500, body: {} } : prev(url, opts)))(fetchRespond);
  sentTo.length = 0;
  tr = JSON.parse((await reminders.handler()).body);
  ok(tr.failed === 3 - tr.skipped && releases.includes('t1-aaaaaaaa') && releases.includes('t3-aaaaaaaa'), 'trial reminders: email failed → released to try again next run', JSON.stringify(tr));
  Date.now = realNow;

  // ═══ plan-options.js ══════════════════════════════════════════════════════
  const options = require(fn('plan-options.js'));
  let po = JSON.parse((await options.handler({ httpMethod: 'GET' })).body);
  ok(JSON.stringify(po.yearly) === '["pro","plus","max"]' && po.trial.days === 7 && JSON.stringify(po.trial.plans) === '["plus","max"]'
     && po.prices.plus.year === '$199' && po.prices.api.year === undefined, 'plan options: yearly Pro, Pro Plus, Pro Max; 7-day trial of Pro Plus and Pro Max');
  delete process.env.STRIPE_PRICE_ID_PRO_YEARLY; delete process.env.STRIPE_PRICE_ID_PLUS_YEARLY; delete process.env.STRIPE_PRICE_ID_MAX_YEARLY;
  po = JSON.parse((await options.handler({ httpMethod: 'GET' })).body);
  ok(po.yearly.length === 0, 'plan options: no yearly prices set → no yearly billing offered');

  console.log(`\nALL ${passed} PLAN TESTS PASSED`);
})().catch((e) => { console.error('TEST FAILED:', e.message); process.exit(1); });
