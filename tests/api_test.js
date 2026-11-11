// tests/api_test.js — the API (netlify/functions/api-quote.js) and the
// Profile page's key management (netlify/functions/api-keys.js), run against
// an in-memory stand-in for Supabase and Google. Run: node tests/api_test.js
const crypto = require('crypto');
const assert = require('assert');

process.env.SUPABASE_SERVICE_KEY = 'service';
process.env.GMAPS_API_KEY = 'maps';
const api = require('../netlify/functions/api-quote.js');
const keys = require('../netlify/functions/api-keys.js');
const engine = require('../netlify/lib/quote-engine.js');
const { API_MONTHLY_QUOTES, API_PER_MINUTE } = require('../netlify/lib/plans.js');

// ── In-memory Supabase + Google ─────────────────────────────────────────────
const now = Date.now();
const DAY = 86400000;
let db, google;
function reset() {
  db = {
    users: {
      'u-api':    { is_active: true,  plan: 'api', created_at: '2026-12-01T00:00:00Z', billing_period_start: new Date(now - 3 * DAY).toISOString(), renews_at: new Date(now + 27 * DAY).toISOString() },
      'u-max':    { is_active: true,  plan: 'max', created_at: '2026-12-01T00:00:00Z', billing_period_start: null, renews_at: null },
      'u-gone':   { is_active: false, plan: 'api', created_at: '2026-12-01T00:00:00Z', billing_period_start: null, renews_at: null },
      'u-legacy': { is_active: true,  plan: 'api', created_at: '2026-06-01T00:00:00Z', billing_period_start: null, renews_at: '2026-11-30T00:00:00Z' },
    },
    tokens: { 'tok-api': 'u-api', 'tok-max': 'u-max', 'tok-legacy': 'u-legacy' },
    keys: [],
    usage: [],
    nextUsage: 1,
  };
  google = { geocode: 0, routes: 0, geocodeError: false, routesError: false };
}
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');
function addKey(userId, key, revoked = false) {
  const row = { id: crypto.randomUUID(), user_id: userId, name: 'k', prefix: key.slice(0, 13), key_hash: sha(key),
    created_at: new Date().toISOString(), last_used_at: null, revoked_at: revoked ? new Date().toISOString() : null };
  db.keys.push(row);
  return row;
}
const PLACES = {
  'lancaster, pa': { city: 'Lancaster', state: 'PA', county: 'Lancaster County', lat: 40.04, lng: -76.31 },
  'new york, ny': { city: 'New York', state: 'NY', county: 'New York County', lat: 40.71, lng: -74.01 },
  'chicago, il': { city: 'Chicago', state: 'IL', county: 'Cook County', lat: 41.88, lng: -87.63 },
  'honolulu, hi': { city: 'Honolulu', state: 'HI', county: 'Honolulu County', lat: 21.31, lng: -157.86 },
};
const json = (status, body) => ({ ok: status < 300, status, json: async () => body, text: async () => JSON.stringify(body) });
const q = (url, k) => new URL(url).searchParams.get(k);
const eq = (v) => (v || '').replace(/^eq\./, '');

global.fetch = async (url, opts = {}) => {
  const method = opts.method || 'GET';
  const body = opts.body ? JSON.parse(opts.body) : null;
  const u = new URL(url);
  if (u.hostname === 'maps.googleapis.com') {
    google.geocode++;
    if (google.geocodeError) return json(200, { status: 'OVER_QUERY_LIMIT', error_message: 'quota' });
    const p = PLACES[q(url, 'address').toLowerCase()];
    if (!p) return json(200, { status: 'ZERO_RESULTS', results: [] });
    return json(200, { status: 'OK', results: [{ address_components: [
      { long_name: p.city, short_name: p.city, types: ['locality'] },
      { long_name: p.county, short_name: p.county, types: ['administrative_area_level_2'] },
      { long_name: p.state, short_name: p.state, types: ['administrative_area_level_1'] }],
      geometry: { location: { lat: p.lat, lng: p.lng } }, types: ['locality'], formatted_address: `${p.city}, ${p.state}, USA` }] });
  }
  if (u.hostname === 'routes.googleapis.com') {
    google.routes++;
    if (google.routesError) return json(429, { error: { status: 'RESOURCE_EXHAUSTED', message: 'quota' } });
    const a = body.origin.location.latLng, b = body.destination.location.latLng;
    if (a.latitude < 25 || b.latitude < 25) return json(200, {});
    const meters = Math.round(Math.hypot(a.latitude - b.latitude, a.longitude - b.longitude) * 111000 * 1.2);
    return json(200, { routes: [{ distanceMeters: meters, duration: `${Math.round(meters / 25)}s` }] });
  }
  assert.strictEqual(opts.headers.apikey, 'service');
  if (u.pathname === '/auth/v1/user') {
    const id = db.tokens[(opts.headers.Authorization || '').replace('Bearer ', '')];
    return id ? json(200, { id }) : json(401, { msg: 'bad token' });
  }
  if (u.pathname === '/rest/v1/pro_users') {
    const id = eq(q(url, 'id'));
    return json(200, db.users[id] ? [db.users[id]] : []);
  }
  if (u.pathname === '/rest/v1/api_keys') {
    const live = (k) => (q(url, 'revoked_at') === 'is.null' ? !k.revoked_at : true);
    if (method === 'GET' && q(url, 'key_hash')) {
      const k = db.keys.find((k) => k.key_hash === eq(q(url, 'key_hash')) && live(k));
      return json(200, k ? [{ id: k.id, user_id: k.user_id, pro_users: db.users[k.user_id] || null }] : []);
    }
    if (method === 'GET') return json(200, db.keys.filter((k) => k.user_id === eq(q(url, 'user_id')) && live(k)));
    if (method === 'POST') {
      const row = Object.assign({ id: crypto.randomUUID(), created_at: new Date().toISOString(), last_used_at: null, revoked_at: null }, body);
      db.keys.push(row);
      return json(201, [row]);
    }
    if (method === 'PATCH') {
      db.keys.filter((k) => k.id === eq(q(url, 'id')) && k.user_id === eq(q(url, 'user_id')) && live(k))
        .forEach((k) => Object.assign(k, body));
      return json(204, null);
    }
  }
  if (u.pathname === '/rest/v1/rpc/api_record_request') {
    const mine = db.usage.filter((r) => r.user === body.p_user);
    if (mine.filter((r) => r.at > Date.now() - 60000).length >= body.p_per_minute) return json(200, { ok: false, reason: 'rate_limited' });
    const used = mine.filter((r) => r.auto && r.at >= Date.parse(body.p_since)).length;
    if (body.p_auto && used >= body.p_monthly_limit) return json(200, { ok: false, reason: 'monthly_limit', used });
    const id = db.nextUsage++;
    db.usage.push({ id, user: body.p_user, key: body.p_key, auto: body.p_auto, at: Date.now() });
    const k = db.keys.find((k) => k.id === body.p_key); if (k) k.last_used_at = new Date().toISOString();
    return json(200, { ok: true, id, used: used + (body.p_auto ? 1 : 0) });
  }
  if (u.pathname === '/rest/v1/rpc/api_quota_status') {
    const used = db.usage.filter((r) => r.user === body.p_user && r.auto && r.at >= Date.parse(body.p_since)).length;
    return json(200, { last_minute: 0, auto_miles_used: used });
  }
  if (u.pathname === '/rest/v1/api_usage' && method === 'DELETE') {
    db.usage = db.usage.filter((r) => String(r.id) !== eq(q(url, 'id')));
    return json(204, null);
  }
  throw new Error(`unexpected ${method} ${url}`);
};

// ── Helpers ─────────────────────────────────────────────────────────────────
const KEY = 'qfc_live_' + 'A'.repeat(32);
async function call(body, opts = {}) {
  const headers = {};
  if (opts.key !== null) headers.authorization = `Bearer ${opts.key || KEY}`;
  if (opts.xApiKey) headers['x-api-key'] = opts.xApiKey;
  const res = await api.handler({ httpMethod: opts.method || 'POST', headers, body: typeof body === 'string' ? body : JSON.stringify(body) });
  return { status: res.statusCode, headers: res.headers, body: JSON.parse(res.body) };
}
async function keysCall(body) {
  const res = await keys.handler({ httpMethod: 'POST', headers: {}, body: JSON.stringify(body) });
  return { status: res.statusCode, body: JSON.parse(res.body) };
}
const LANE = { origin: 'Lancaster, PA', destination: 'New York, NY' };
let passed = 0;
async function test(name, fn) {
  reset();
  addKey('u-api', KEY);
  try { await fn(); passed++; console.log('PASS ', name); }
  catch (e) { console.log('FAIL ', name, '\n   ', e.message); process.exitCode = 1; }
}

(async () => {
  // ── Keys and plans ──
  await test('no key → 401 missing_key', async () => {
    const r = await call(LANE, { key: null });
    assert.strictEqual(r.status, 401); assert.strictEqual(r.body.error.code, 'missing_key');
  });
  await test('malformed key → 401 without a database call', async () => {
    const r = await call(LANE, { key: 'sk_test_123' });
    assert.strictEqual(r.status, 401); assert.strictEqual(r.body.error.code, 'invalid_key');
  });
  await test('unknown key → 401', async () => {
    const r = await call(LANE, { key: 'qfc_live_' + 'B'.repeat(32) });
    assert.strictEqual(r.status, 401); assert.strictEqual(r.body.error.code, 'invalid_key');
  });
  await test('revoked key → 401', async () => {
    const k = 'qfc_live_' + 'R'.repeat(32); addKey('u-api', k, true);
    const r = await call(LANE, { key: k });
    assert.strictEqual(r.status, 401);
  });
  await test('X-API-Key header works too', async () => {
    const r = await call(LANE, { key: null, xApiKey: KEY });
    assert.strictEqual(r.status, 200, JSON.stringify(r.body));
  });
  await test('cancelled subscription → 403', async () => {
    const k = 'qfc_live_' + 'G'.repeat(32); addKey('u-gone', k);
    const r = await call(LANE, { key: k });
    assert.strictEqual(r.status, 403); assert.strictEqual(r.body.error.code, 'subscription_inactive');
  });
  await test('Pro Max (not API plan) → 403 plan_required', async () => {
    const k = 'qfc_live_' + 'M'.repeat(32); addKey('u-max', k);
    const r = await call(LANE, { key: k });
    assert.strictEqual(r.status, 403); assert.strictEqual(r.body.error.code, 'plan_required');
  });
  await test('subscriber from before the changes → API starts at renewal', async () => {
    const k = 'qfc_live_' + 'L'.repeat(32); addKey('u-legacy', k);
    const r = await call(LANE, { key: k });
    assert.strictEqual(r.status, 403); assert.strictEqual(r.body.error.code, 'starts_at_renewal');
    assert.match(r.body.error.message, /2026-11-30/);
  });

  // ── Requests ──
  await test('GET → 405', async () => {
    const r = await call(LANE, { method: 'GET' });
    assert.strictEqual(r.status, 405);
  });
  await test('bad JSON and non-object bodies → 400', async () => {
    assert.strictEqual((await call('{oops')).body.error.code, 'invalid_json');
    assert.strictEqual((await call('[1,2]')).body.error.code, 'invalid_json');
  });
  for (const [label, body, field] of [
    ['unknown field', { ...LANE, dieselprice: 4 }, 'dieselprice'],
    ['missing origin', { destination: 'New York, NY' }, 'origin'],
    ['bad trailer', { ...LANE, trailer: 'tanker' }, 'trailer'],
    ['bad date', { ...LANE, pickupDate: '11/20/2026' }, 'pickupDate'],
    ['impossible date', { ...LANE, pickupDate: '2026-02-30' }, 'pickupDate'],
    ['market out of range', { ...LANE, market: 45 }, 'market'],
    ['capacity not boolean', { ...LANE, capacity: 'yes' }, 'capacity'],
    ['unknown holiday', { ...LANE, holidays: ['easter'] }, 'holidays'],
    ['zero miles', { ...LANE, miles: 0 }, 'miles'],
    ['margin over 100', { ...LANE, margin: 150 }, 'margin'],
  ]) {
    await test(`invalid: ${label} → 400 on "${field}"`, async () => {
      const r = await call(body);
      assert.strictEqual(r.status, 400); assert.strictEqual(r.body.error.field, field);
      assert.strictEqual(db.usage.length, 0, 'invalid requests are not metered');
    });
  }

  await test('automatic miles: quote matches the engine, 3 Google calls, counted once', async () => {
    const r = await call({ ...LANE, trailer: 'reefer', weight: '42000', commodity: 'food', pickupDate: '2026-12-01', margin: 12 });
    assert.strictEqual(r.status, 200, JSON.stringify(r.body));
    assert.strictEqual(google.geocode, 2); assert.strictEqual(google.routes, 1);
    assert.strictEqual(r.body.lane.milesSource, 'google');
    assert.strictEqual(r.body.lane.origin.state, 'PA'); assert.strictEqual(r.body.lane.destination.city, 'New York');
    const expect = engine.presentQuote(engine.computeQuote({ miles: r.body.lane.miles, trailer: 'reefer', weight: 42000,
      commodity: 'food', pickupDate: '2026-12-01', marginPercent: 12, rateRegion: 'northeast' }));
    assert.deepStrictEqual(r.body.quote, { total: expect.total, ratePerMile: expect.ratePerMile, currency: 'USD' });
    assert.deepStrictEqual(r.body.breakdown, expect.breakdown);
    assert.strictEqual(r.body.usage.used, 1); assert.strictEqual(r.body.usage.limit, API_MONTHLY_QUOTES);
    assert.ok(r.body.attribution && /Google/.test(r.body.attribution));
    assert.ok(!Object.keys(r.headers).some((h) => /access-control/i.test(h)), 'no CORS headers');
  });
  await test('own miles: no Google calls, not counted toward the month, region from the text', async () => {
    const r = await call({ origin: 'Dallas, TX', destination: 'Anywhere', miles: 620, trailer: 'flatbed' });
    assert.strictEqual(r.status, 200, JSON.stringify(r.body));
    assert.strictEqual(google.geocode + google.routes, 0);
    assert.strictEqual(r.body.lane.milesSource, 'provided'); assert.strictEqual(r.body.lane.origin.state, 'TX');
    assert.strictEqual(r.body.breakdown.rateRegion, 'southwest');
    assert.strictEqual(r.body.usage.used, 0); assert.ok(!r.body.attribution);
    const expect = engine.presentQuote(engine.computeQuote({ miles: 620, trailer: 'flatbed', rateRegion: 'southwest', marginPercent: 15 }));
    assert.strictEqual(r.body.quote.total, expect.total);
  });
  await test('own miles without a state → national rates', async () => {
    const r = await call({ origin: '17601', destination: '10001', miles: 166 });
    assert.strictEqual(r.body.breakdown.rateRegion, 'national');
  });
  await test('rates: national, and your own base rate', async () => {
    assert.strictEqual((await call({ ...LANE, miles: 166, rates: 'national' })).body.breakdown.rateRegion, 'national');
    const own = await call({ ...LANE, miles: 166, baseRatePerMile: 2.5 });
    assert.strictEqual(own.body.breakdown.rateRegion, null); assert.strictEqual(own.body.breakdown.baseRatePerMile, 2.5);
  });
  await test('every Advanced setting reaches the engine', async () => {
    const body = { ...LANE, miles: 900, trailer: 'reefer', weight: 44001, commodity: 'hazmat', pickupDate: '2026-11-20',
      deliveryDate: '2026-11-26', margin: 18, dieselPrice: 3.85, capacity: true, season: 'ne_produce',
      holidays: ['thanksgiving', 'THANKSGIVING'], market: 7, extraDayRate: 250 };
    const r = await call(body);
    const expect = engine.presentQuote(engine.computeQuote({ miles: 900, trailer: 'reefer', weight: 44001, commodity: 'hazmat',
      pickupDate: '2026-11-20', deliveryDate: '2026-11-26', marginPercent: 18, rateRegion: 'northeast', dieselPrice: 3.85,
      capacity: true, seasonRegion: 'ne_produce', holidays: ['thanksgiving'], marketPercent: 7, extraDayRate: 250 }));
    assert.deepStrictEqual(r.body.breakdown, expect.breakdown); assert.strictEqual(r.body.quote.total, expect.total);
    assert.strictEqual(r.body.breakdown.extraDays, 4); // 6 days for 900 mi (2 standard)
  });
  await test('place not found → 422, still counted (Google charged for it)', async () => {
    const r = await call({ origin: 'Nowhereville, ZZ', destination: 'New York, NY' });
    assert.strictEqual(r.status, 422); assert.strictEqual(r.body.error.code, 'location_not_found'); assert.strictEqual(r.body.error.field, 'origin');
    assert.strictEqual(db.usage.filter((u) => u.auto).length, 1);
  });
  await test('no driving route → 422, counted', async () => {
    const r = await call({ origin: 'Honolulu, HI', destination: 'New York, NY' });
    assert.strictEqual(r.status, 422); assert.strictEqual(r.body.error.code, 'no_route');
    assert.strictEqual(db.usage.length, 1);
  });
  await test('Google over quota on lookup → 503 and the quote is handed back', async () => {
    google.geocodeError = true;
    const r = await call(LANE);
    assert.strictEqual(r.status, 503); assert.strictEqual(r.body.error.code, 'miles_unavailable');
    assert.strictEqual(db.usage.length, 0);
  });
  await test('Google over quota on route → 503 and handed back', async () => {
    google.routesError = true;
    const r = await call(LANE);
    assert.strictEqual(r.status, 503); assert.strictEqual(db.usage.length, 0);
  });
  await test(`monthly allowance: quote ${API_MONTHLY_QUOTES + 1} with automatic miles → 429; own miles still work`, async () => {
    const old = Date.now() - 2 * 60000;
    for (let i = 0; i < API_MONTHLY_QUOTES; i++) db.usage.push({ id: db.nextUsage++, user: 'u-api', auto: true, at: old });
    const r = await call(LANE);
    assert.strictEqual(r.status, 429); assert.strictEqual(r.body.error.code, 'monthly_limit');
    assert.strictEqual(r.body.error.usage.used, API_MONTHLY_QUOTES); assert.ok(r.body.error.usage.resetsAt);
    assert.strictEqual(google.geocode, 0, 'no Google call once the allowance is used');
    assert.strictEqual((await call({ ...LANE, miles: 166 })).status, 200);
  });
  await test('last month\'s quotes don\'t count', async () => {
    for (let i = 0; i < API_MONTHLY_QUOTES; i++) db.usage.push({ id: db.nextUsage++, user: 'u-api', auto: true, at: Date.now() - 5 * DAY });
    const r = await call(LANE);
    assert.strictEqual(r.status, 200); assert.strictEqual(r.body.usage.used, 1);
  });
  await test(`rate limit: request ${API_PER_MINUTE + 1} in a minute → 429 with Retry-After`, async () => {
    for (let i = 0; i < API_PER_MINUTE; i++) db.usage.push({ id: db.nextUsage++, user: 'u-api', auto: false, at: Date.now() - 1000 });
    const r = await call({ ...LANE, miles: 100 });
    assert.strictEqual(r.status, 429); assert.strictEqual(r.body.error.code, 'rate_limited'); assert.strictEqual(r.headers['Retry-After'], '60');
  });

  // ── Profile: keys ──
  await test('keys: sign-in required', async () => {
    assert.strictEqual((await keysCall({ action: 'list', accessToken: 'nope' })).status, 401);
  });
  await test('keys: create → shown once, stored hashed, works with the API; revoke stops it', async () => {
    db.keys = [];
    const c = await keysCall({ action: 'create', accessToken: 'tok-api', name: 'Website <b>form</b>' });
    assert.strictEqual(c.status, 200, JSON.stringify(c.body));
    assert.match(c.body.key, /^qfc_live_[A-Za-z0-9_-]{32}$/);
    assert.strictEqual(c.body.item.prefix, c.body.key.slice(0, 13)); assert.strictEqual(c.body.item.name, 'Website bform/b');
    assert.strictEqual(db.keys[0].key_hash, sha(c.body.key)); assert.ok(!JSON.stringify(db.keys).includes(c.body.key));
    assert.strictEqual(c.body.access, 'active'); assert.strictEqual(c.body.keys.length, 1);
    const ok = await call({ ...LANE, miles: 166 }, { key: c.body.key });
    assert.strictEqual(ok.status, 200);
    const list = await keysCall({ action: 'list', accessToken: 'tok-api' });
    assert.ok(list.body.keys[0].lastUsedAt, 'last used is shown');
    const rv = await keysCall({ action: 'revoke', accessToken: 'tok-api', keyId: c.body.item.id });
    assert.strictEqual(rv.status, 200); assert.strictEqual(rv.body.keys.length, 0);
    assert.strictEqual((await call({ ...LANE, miles: 166 }, { key: c.body.key })).status, 401);
  });
  await test('keys: usage shows this billing month', async () => {
    await call(LANE); await call(LANE); await call({ ...LANE, miles: 50 });
    const l = await keysCall({ action: 'list', accessToken: 'tok-api' });
    assert.strictEqual(l.body.usage.used, 2); assert.strictEqual(l.body.usage.limit, API_MONTHLY_QUOTES); assert.ok(l.body.usage.resetsAt);
  });
  await test('keys: at most 5', async () => {
    db.keys = [];
    for (let i = 0; i < 5; i++) assert.strictEqual((await keysCall({ action: 'create', accessToken: 'tok-api' })).status, 200);
    const sixth = await keysCall({ action: 'create', accessToken: 'tok-api' });
    assert.strictEqual(sixth.status, 400); assert.match(sixth.body.error, /up to 5/);
  });
  await test('keys: other plans can\'t create; before-renewal subscribers are told when', async () => {
    const m = await keysCall({ action: 'create', accessToken: 'tok-max' });
    assert.strictEqual(m.status, 403);
    assert.strictEqual((await keysCall({ action: 'list', accessToken: 'tok-max' })).body.access, 'plan_required');
    assert.strictEqual((await keysCall({ action: 'list', accessToken: 'tok-legacy' })).body.access, 'starts_at_renewal');
  });
  await test('keys: can\'t revoke someone else\'s key; bad ids rejected', async () => {
    const other = addKey('u-max', 'qfc_live_' + 'O'.repeat(32));
    await keysCall({ action: 'revoke', accessToken: 'tok-api', keyId: other.id });
    assert.strictEqual(other.revoked_at, null);
    assert.strictEqual((await keysCall({ action: 'revoke', accessToken: 'tok-api', keyId: '1 or 1=1' })).status, 400);
  });

  console.log(`\n${passed} passed${process.exitCode ? ', some FAILED' : ''}`);
})();
