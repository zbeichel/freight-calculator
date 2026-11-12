// netlify/functions/api-quote.js
//
// The QuickFreightCalc API: POST https://quickfreightcalc.com/api/v1/quote
// (netlify.toml routes /api/v1/quote here). Customer docs: /api.html.
//
// - Authenticated with an API key (Authorization: Bearer qfc_live_…) created
//   on the Profile page. Only the key's SHA-256 hash is stored (api-keys.js).
// - Needs an active API plan (netlify/lib/plans.js). change-plan only records
//   the API plan once Stripe has been paid for it.
// - Metered by the api_record_request database function: API_PER_MINUTE
//   requests a minute per account, and API_MONTHLY_QUOTES quotes with
//   automatic miles per billing month. A request that looks up miles counts
//   even when a place or route isn't found (Google charges for the lookup);
//   it's handed back if Google itself fails. Requests that send their own
//   miles don't use the monthly allowance.
// - Quotes come from netlify/lib/quote-engine.js, the calculator's own math.
// - Server-to-server only: no CORS headers, so a browser page on another site
//   can't call it (and so can't leak a customer's key).

const crypto = require('crypto');
const { API_MONTHLY_QUOTES, API_PER_MINUTE, normalizePlan } = require('../lib/plans.js');
const engine = require('../lib/quote-engine.js');
const { geocodePlace, computeRoute } = require('../lib/google.js');

const SUPABASE_URL = 'https://xgrmbhmgcsbnazupfybd.supabase.co';
const DOCS = 'https://quickfreightcalc.com/api.html';
const KEY_FORMAT = /^qfc_live_[A-Za-z0-9_-]{20,80}$/;
const MAX_BODY = 4096;
const MAX_TEXT = 120;
const DAY_MS = 24 * 60 * 60 * 1000;

const FIELDS = ['origin', 'destination', 'miles', 'trailer', 'weight', 'commodity', 'pickupDate',
  'deliveryDate', 'margin', 'rates', 'baseRatePerMile', 'dieselPrice', 'capacity', 'season',
  'holidays', 'market', 'extraDayRate'];

function reply(statusCode, payload, extraHeaders) {
  return {
    statusCode,
    headers: Object.assign({ 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }, extraHeaders || {}),
    body: JSON.stringify(payload),
  };
}
function fail(statusCode, code, message, extra, headers) {
  return reply(statusCode, { error: Object.assign({ code, message }, extra || {}) }, headers);
}

function supaHeaders(serviceKey) {
  return { apikey: serviceKey, Authorization: `Bearer ${serviceKey}`, 'Content-Type': 'application/json' };
}

function apiKeyFrom(event) {
  const h = event.headers || {};
  const auth = h.authorization || h.Authorization || '';
  if (/^Bearer\s+/i.test(auth)) return auth.replace(/^Bearer\s+/i, '').trim();
  return String(h['x-api-key'] || h['X-Api-Key'] || '').trim();
}

// The key's row and its account's subscription, or null.
async function lookupKey(apiKey, serviceKey) {
  const hash = crypto.createHash('sha256').update(apiKey).digest('hex');
  const resp = await fetch(
    `${SUPABASE_URL}/rest/v1/api_keys?key_hash=eq.${hash}&revoked_at=is.null` +
      '&select=id,user_id,pro_users(is_active,plan,billing_period_start,renews_at)',
    { headers: supaHeaders(serviceKey), signal: AbortSignal.timeout(5000) }
  );
  if (!resp.ok) throw new Error(`api_keys lookup HTTP ${resp.status}`);
  const rows = await resp.json();
  return Array.isArray(rows) && rows[0] ? rows[0] : null;
}

// The billing month the allowance counts in. Falls back to the last 31 days
// if the webhook hasn't recorded the current period.
function usageWindow(sub, now = Date.now()) {
  const start = Date.parse((sub && sub.billing_period_start) || '');
  const end = Date.parse((sub && sub.renews_at) || '');
  if (Number.isFinite(start) && start <= now && now - start < 32 * DAY_MS) {
    return { since: new Date(start).toISOString(), resetsAt: Number.isFinite(end) && end > now ? new Date(end).toISOString() : null };
  }
  return { since: new Date(now - 31 * DAY_MS).toISOString(), resetsAt: null };
}

async function recordRequest(serviceKey, userId, keyId, since, auto) {
  const resp = await fetch(`${SUPABASE_URL}/rest/v1/rpc/api_record_request`, {
    method: 'POST',
    headers: supaHeaders(serviceKey),
    signal: AbortSignal.timeout(5000),
    body: JSON.stringify({
      p_user: userId, p_key: keyId, p_since: since, p_auto: auto,
      p_monthly_limit: API_MONTHLY_QUOTES, p_per_minute: API_PER_MINUTE,
    }),
  });
  if (!resp.ok) throw new Error(`api_record_request HTTP ${resp.status}`);
  return resp.json();
}

// Hand a lookup back when Google itself failed, so it doesn't use the allowance.
async function refund(serviceKey, usageId) {
  try {
    await fetch(`${SUPABASE_URL}/rest/v1/api_usage?id=eq.${encodeURIComponent(usageId)}`, {
      method: 'DELETE', headers: supaHeaders(serviceKey), signal: AbortSignal.timeout(5000),
    });
  } catch (e) {
    console.error('[api-quote] refund failed:', e && e.message);
  }
}

// ── Request checks ───────────────────────────────────────────────────────────
function badField(field, message) {
  return { error: { code: 'invalid_request', field, message } };
}
function asNumber(v) {
  if (typeof v === 'number') return Number.isFinite(v) ? v : NaN;
  if (typeof v === 'string' && v.trim() !== '') return Number(v);
  return NaN;
}
function isDate(v) {
  if (typeof v !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(v)) return false;
  const d = new Date(v + 'T00:00:00Z');
  return !isNaN(d) && d.toISOString().slice(0, 10) === v;
}

// Returns { input } ready for the engine, or { error }.
function validate(body) {
  for (const k of Object.keys(body)) {
    if (!FIELDS.includes(k)) return badField(k, `Unknown field "${k}". See ${DOCS} for the fields you can send.`);
  }
  const input = {};
  for (const k of ['origin', 'destination']) {
    const v = body[k];
    const label = k === 'origin' ? 'origin (pickup)' : 'destination (delivery)';
    if (typeof v !== 'string' || !v.trim()) {
      return badField(k, `${label} is required: a city and state ("Lancaster, PA"), a ZIP code or a street address.`);
    }
    if (v.trim().length > MAX_TEXT) return badField(k, `${label} is too long (${MAX_TEXT} characters at most).`);
    input[k] = v.trim();
  }
  const num = (k, min, max, what) => {
    if (body[k] == null) return undefined;
    const n = asNumber(body[k]);
    if (!Number.isFinite(n) || n < min || n > max) return badField(k, `${k} must be ${what}.`);
    input[k] = n;
    return undefined;
  };
  const choice = (k, options, fallback) => {
    if (body[k] == null) { input[k] = fallback; return undefined; }
    const v = String(body[k]).trim().toLowerCase();
    if (!options.includes(v)) return badField(k, `${k} must be one of: ${options.join(', ')}.`);
    input[k] = v;
    return undefined;
  };
  const checks = [
    () => num('miles', 1, 10000, 'a number of miles from 1 to 10,000'),
    () => choice('trailer', engine.TRAILERS, 'van'),
    () => num('weight', 1, 999999, 'the weight in pounds, from 1 to 999,999'),
    () => choice('commodity', engine.COMMODITIES, 'standard'),
    () => num('margin', 0, 100, 'a percentage from 0 to 100'),
    () => choice('rates', ['regional', 'national'], 'regional'),
    () => num('baseRatePerMile', 0.01, 50, 'a rate in dollars per mile, from 0.01 to 50'),
    () => num('dieselPrice', 0.01, 20, 'a diesel price in dollars per gallon, from 0.01 to 20'),
    () => num('market', engine.MP_MIN, engine.MP_MAX, `a percentage from ${engine.MP_MIN} to ${engine.MP_MAX}`),
    () => num('extraDayRate', 0, 10000, 'a dollar amount per extra day, from 0 to 10,000'),
    () => (body.season == null ? undefined : choice('season', engine.SEASON_REGIONS)),
  ];
  for (const check of checks) {
    const err = check();
    if (err) return err;
  }
  for (const k of ['pickupDate', 'deliveryDate']) {
    if (body[k] == null) continue;
    if (!isDate(body[k])) return badField(k, `${k} must be a date written YYYY-MM-DD.`);
    input[k] = body[k];
  }
  if (body.capacity != null) {
    if (typeof body.capacity !== 'boolean') return badField('capacity', 'capacity must be true or false.');
    input.capacity = body.capacity;
  }
  if (body.holidays != null) {
    if (!Array.isArray(body.holidays) || body.holidays.some((h) => !engine.HOLIDAY_IDS.includes(String(h).trim().toLowerCase()))) {
      return badField('holidays', `holidays must be a list of: ${engine.HOLIDAY_IDS.join(', ')}.`);
    }
    input.holidays = [...new Set(body.holidays.map((h) => String(h).trim().toLowerCase()))];
  }
  return { input };
}

// The pickup state from text like "Lancaster, PA" or "Hastings, FL 32145" —
// the same pattern the calculator uses before a place is checked.
function stateFromText(text) {
  const m = String(text || '').match(/[\s,]+([A-Za-z]{2})\b(?:\s+\d{5}(?:-\d{4})?)?(?:\s*,\s*USA?)?\s*$/i);
  return m ? m[1].toUpperCase() : null;
}

function formatDrive(seconds) {
  if (!Number.isFinite(seconds)) return null;
  const h = Math.floor(seconds / 3600);
  const m = Math.round((seconds % 3600) / 60);
  return h ? `${h}h ${m}m` : `${m}m`;
}

function placeOut(input, p) {
  return { input, name: p.name, city: p.city, state: p.state, zip: p.zip, county: p.county,
    lat: p.lat, lng: p.lon, partialMatch: p.partialMatch };
}

exports.handler = async function (event) {
  if (event.httpMethod !== 'POST') {
    return fail(405, 'method_not_allowed', `Send a POST request with a JSON body. See ${DOCS}.`, null, { Allow: 'POST' });
  }

  // ── Who is calling ──
  const apiKey = apiKeyFrom(event);
  if (!apiKey) {
    return fail(401, 'missing_key', 'Send your API key in the Authorization header: "Authorization: Bearer qfc_live_…".');
  }
  if (!KEY_FORMAT.test(apiKey)) return fail(401, 'invalid_key', 'That API key isn\'t valid. Check it on your Profile page.');

  const serviceKey = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;
  const mapsKey = process.env.GMAPS_API_KEY;
  if (!serviceKey) {
    console.error('[api-quote] SUPABASE_SERVICE_KEY not configured');
    return fail(503, 'unavailable', 'The API is temporarily unavailable. Please try again shortly.');
  }

  let keyRow;
  try {
    keyRow = await lookupKey(apiKey, serviceKey);
  } catch (e) {
    console.error('[api-quote] key lookup failed:', e && e.message);
    return fail(503, 'unavailable', 'The API is temporarily unavailable. Please try again shortly.');
  }
  if (!keyRow) {
    return fail(401, 'invalid_key', 'That API key isn\'t valid or has been revoked. Check it on your Profile page.');
  }
  const sub = keyRow.pro_users || {};
  if (sub.is_active !== true) {
    return fail(403, 'subscription_inactive', 'Your QuickFreightCalc subscription isn\'t active. Restart the API plan from your Profile page.');
  }
  if (normalizePlan(sub.plan) !== 'api') {
    return fail(403, 'plan_required', 'API access is part of the API plan ($199.99/month). Switch plans from your Profile page.');
  }

  // ── What they asked for ──
  let raw = event.body || '';
  if (event.isBase64Encoded) raw = Buffer.from(raw, 'base64').toString('utf8');
  if (raw.length > MAX_BODY) return fail(413, 'too_large', 'The request body is too large.');
  let body;
  try {
    body = JSON.parse(raw || '{}');
  } catch {
    return fail(400, 'invalid_json', 'The request body isn\'t valid JSON.');
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return fail(400, 'invalid_json', 'The request body must be a JSON object.');
  }
  const checked = validate(body);
  if (checked.error) return reply(400, checked);
  const input = checked.input;

  const auto = input.miles == null;
  if (auto && !mapsKey) {
    console.error('[api-quote] GMAPS_API_KEY not configured');
    return fail(503, 'miles_unavailable', 'Automatic miles are unavailable right now. Send "miles" with the request, or try again shortly.');
  }

  // ── Meter it ──
  const period = usageWindow(sub);
  let meter;
  try {
    meter = await recordRequest(serviceKey, keyRow.user_id, keyRow.id, period.since, auto);
  } catch (e) {
    console.error('[api-quote] metering failed:', e && e.message);
    meter = null;
  }
  if (!meter || typeof meter !== 'object') {
    return fail(503, 'unavailable', 'The API is temporarily unavailable. Please try again shortly.');
  }
  const usage = { used: meter.used, limit: API_MONTHLY_QUOTES, resetsAt: period.resetsAt };
  if (!meter.ok && meter.reason === 'rate_limited') {
    return fail(429, 'rate_limited', `Too many requests: up to ${API_PER_MINUTE} a minute. Please wait a moment and try again.`,
      null, { 'Retry-After': '60' });
  }
  if (!meter.ok) {
    return fail(429, 'monthly_limit',
      `You've used this billing month's ${API_MONTHLY_QUOTES.toLocaleString('en-US')} quotes with automatic miles. ` +
      'Send "miles" with the request to keep quoting, or wait for your next billing month.',
      { usage });
  }

  // ── Miles ──
  const lane = { origin: { input: input.origin }, destination: { input: input.destination } };
  let pickupState = stateFromText(input.origin);
  if (auto) {
    const [from, to] = await Promise.all([
      geocodePlace(input.origin, mapsKey, 'api-quote'),
      geocodePlace(input.destination, mapsKey, 'api-quote'),
    ]);
    if (from.status === 'error' || to.status === 'error') {
      await refund(serviceKey, meter.id);
      return fail(503, 'miles_unavailable', 'Automatic miles are unavailable right now. Send "miles" with the request, or try again shortly.');
    }
    for (const [k, r] of [['origin', from], ['destination', to]]) {
      if (r.status !== 'ok' || !Number.isFinite(r.place.lat) || !Number.isFinite(r.place.lon)) {
        return fail(422, 'location_not_found', `Couldn't find the ${k === 'origin' ? 'pickup' : 'delivery'} location "${input[k]}". ` +
          'Try a city and state ("Lancaster, PA"), a ZIP code or a street address.', { field: k, usage });
      }
    }
    const route = await computeRoute({ lat: from.place.lat, lng: from.place.lon }, { lat: to.place.lat, lng: to.place.lon }, mapsKey, 'api-quote');
    if (route.status === 'error') {
      await refund(serviceKey, meter.id);
      return fail(503, 'miles_unavailable', 'Automatic miles are unavailable right now. Send "miles" with the request, or try again shortly.');
    }
    if (route.status !== 'ok') {
      return fail(422, 'no_route', 'There\'s no driving route between those locations.', { usage });
    }
    input.miles = Math.round(route.distanceMeters / 1609.34); // same rounding as the calculator
    if (input.miles < 1) {
      return fail(422, 'same_location', 'The pickup and delivery are the same place.', { usage });
    }
    lane.origin = placeOut(input.origin, from.place);
    lane.destination = placeOut(input.destination, to.place);
    lane.driveSeconds = route.durationSeconds;
    lane.driveTime = formatDrive(route.durationSeconds);
    pickupState = from.place.state || null;
  } else {
    lane.origin.state = pickupState;
  }
  lane.miles = input.miles;
  lane.milesSource = auto ? 'google' : 'provided';

  // ── The quote ──
  const rateRegion = input.rates === 'national' ? 'national' : engine.regionForState(pickupState);
  const q = engine.computeQuote({
    miles: input.miles,
    trailer: input.trailer,
    weight: input.weight,
    commodity: input.commodity,
    pickupDate: input.pickupDate,
    deliveryDate: input.deliveryDate,
    marginPercent: input.margin == null ? 15 : input.margin,
    rateRegion,
    baseRatePerMile: input.baseRatePerMile,
    dieselPrice: input.dieselPrice,
    capacity: input.capacity === true,
    seasonRegion: input.season,
    holidays: input.holidays || [],
    marketPercent: input.market || 0,
    extraDayRate: input.extraDayRate,
  });
  const shown = engine.presentQuote(q);

  console.log(`[api-quote] user=${String(keyRow.user_id).slice(0, 8)} auto=${auto} miles=${input.miles} used=${usage.used}`);
  const out = {
    quote: { total: shown.total, ratePerMile: shown.ratePerMile, currency: 'USD' },
    lane,
    shipment: {
      trailer: input.trailer,
      weight: input.weight == null ? null : input.weight,
      commodity: input.commodity,
      pickupDate: input.pickupDate || null,
      deliveryDate: input.deliveryDate || null,
    },
    breakdown: shown.breakdown,
    ratesUpdated: (engine.RATES && engine.RATES.updated) || null,
    usage,
  };
  if (auto) out.attribution = 'Miles and drive time: Google Maps';
  return reply(200, out);
};

// For tests.
exports._internal = { validate, usageWindow, stateFromText };
