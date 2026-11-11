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
  fetchRespond = (url) => {
    if (url.endsWith('/auth/v1/user')) return { body: { id: 'user-1' } };
    if (url.includes('/rest/v1/pro_users')) return { body: proRow ? [proRow] : [] };
    if (url.includes('/rest/v1/rpc/record_free_lane')) return { body: laneAllowed };
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
  const rpc = () => fcalls.filter((c) => c.url.includes('record_free_lane')).map((c) => JSON.parse(c.opts.body));
  const google = () => fcalls.filter((c) => c.url.startsWith('https://routes.googleapis.com/')).length;
  const active = (extra) => ({ is_active: true, plan: 'pro', grandfathered: false, billing_period_start: '2026-11-20T10:00:00Z', ...extra });

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
  newSubPrice = 'price_original';
  await send(checkoutEvent());
  ok(patches.at(-1).grandfathered === true, 'webhook: checkout at the original price (new Pro price not set) → original plan');
  const updated = (price, extra = {}) => ({ type: 'customer.subscription.updated', data: { object: { id: 'sub_1', status: 'active',
    metadata: { userId: 'user-1' }, current_period_start: secs('2026-12-15T10:00:00Z'), current_period_end: secs('2027-01-15T10:00:00Z'),
    items: { data: [{ price: { id: price } }] }, ...extra } } });
  await send(updated('price_original'));
  p = patches.at(-1);
  ok(p.plan === 'pro' && p.grandfathered === true && p.billing_period_start === '2026-12-15T10:00:00.000Z',
     'webhook: renewal on the original price → stays marked, period recorded');
  await send(updated('price_max'));
  p = patches.at(-1);
  ok(p.plan === 'max' && !('grandfathered' in p), 'webhook: new price → plan from the price, marker untouched');
  await send({ type: 'customer.subscription.deleted', data: { object: { id: 'sub_1', metadata: { userId: 'user-1' } } } });
  p = patches.at(-1);
  ok(p.is_active === false && p.plan === 'pro' && p.grandfathered === false && p.next_plan === null,
     'webhook: cancelled → inactive; a later subscription starts on the new plans');

  // ═══ verify-pro.js ════════════════════════════════════════════════════════
  const verify = require(fn('verify-pro.js'));
  let vrow = null;
  respond = (c) => {
    if (c.path === '/auth/v1/user') return { status: 200, body: { id: 'user-1' } };
    if (c.path.startsWith('/rest/v1/pro_users')) return { status: 200, body: [vrow] };
    return { status: 404, body: {} };
  };
  const vp = async () => JSON.parse((await verify.handler({ httpMethod: 'POST', body: JSON.stringify({ userId: 'user-1', accessToken: 'tok' }) })).body);
  at('2026-11-20T15:00:00Z');
  vrow = { is_active: true, plan: 'pro', next_plan: 'plus', grandfathered: true, billing_period_start: null, stripe_subscription_id: 'sub_1' };
  let v = await vp();
  ok(v.active && v.paid && v.unlimitedUntilRenewal === true && v.nextPlan === 'plus' && v.newPlansStart === JAN1,
     'verify-pro: original plan → unlimited until January, with the chosen plan');
  vrow.next_plan = null;
  ok((await vp()).nextPlan === 'pro', 'verify-pro: no choice yet → moves to Pro');
  vrow = { is_active: true, plan: 'api', next_plan: 'api', grandfathered: true, billing_period_start: '2026-11-10T00:00:00Z', stripe_subscription_id: 'sub_1' };
  ok((await vp()).unlimitedUntilRenewal === false, 'verify-pro: moved to the API plan → nothing left to choose');
  vrow = { is_active: true, plan: 'plus', grandfathered: false, stripe_subscription_id: 'sub_2' };
  v = await vp();
  ok(v.active && v.plan === 'plus' && v.unlimitedUntilRenewal === false && v.nextPlan === null, 'verify-pro: new subscriber → their plan, no notice');
  at('2027-01-11T15:00:00Z');
  vrow = { is_active: true, plan: 'plus', grandfathered: true, billing_period_start: '2027-01-10T12:00:00Z', stripe_subscription_id: 'sub_1' };
  ok((await vp()).unlimitedUntilRenewal === false, 'verify-pro: after the first January bill → on the new plan');
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

  console.log(`\nALL ${passed} PLAN TESTS PASSED`);
})().catch((e) => { console.error('TEST FAILED:', e.message); process.exit(1); });
