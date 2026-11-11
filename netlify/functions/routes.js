// netlify/functions/routes.js
//
// Server-side proxy for the Google Routes API (Compute Routes).
// - The API key never leaves the server.
// - Routes are not cached: Google's Routes API terms only allow temporary
//   caching of lat/lng, not distances or durations, so every lookup goes to
//   Google. The daily lane limits below (free 5, Pro 100, Pro Plus 250,
//   Pro Max / API 1,000) cap how many lanes each caller can look up.
// - Each end is routed on the verified coordinates the page sends
//   (originLatLng / destinationLatLng) when it has them, else on the text.
// - Google's raw error bodies are NEVER forwarded to the client. Failures come
//   back as a short, user-safe message; the real reason is logged server-side.

const crypto = require('crypto');

const ALLOWED_ORIGINS = [
  'https://quickfreightcalc.com',
  'https://www.quickfreightcalc.com',
];

const SUPABASE_URL = 'https://xgrmbhmgcsbnazupfybd.supabase.co';
const BASE_FIELDS = 'routes.distanceMeters,routes.duration';
const LEG_FIELDS = 'routes.legs.startLocation,routes.legs.endLocation';
const MAX_ADDR_LEN = 120;

// User-safe messages — never expose Google's quota text, project number, etc.
const MSG_BUSY = 'Distance lookup is busy right now — please enter the miles manually.';
const MSG_UNAVAILABLE = 'Distance lookup is temporarily unavailable — please enter the miles manually.';

// Daily limits on automatic miles ("quotes per day" on the site), counted in
// distinct lanes (origin→destination pairs) per UTC day: each new pair priced
// is one quote. Re-pricing a lane you already ran today is free, and miles can
// always be entered by hand.
//   - Free (not signed in, or signed in without Pro): FREE_DAILY_LIMIT
//   - Paid plans: PLAN_DAILY_LIMIT in netlify/lib/plans.js (Pro 100, Pro Plus
//     250, Pro Max and API 1,000). Subscribers on the original Pro plan keep
//     unlimited quotes until their first bill on or after January 1, 2027
//     (legacyUnlimited).
const { PLAN_DAILY_LIMIT, normalizePlan, legacyUnlimited } = require('../lib/plans.js');

const FREE_DAILY_LIMIT = 5;
const MSG_LIMIT =
  "You've used today's 5 free quotes with automatic miles. Upgrade to Pro for 100 a day — or enter the miles manually.";
const MSG_TOP_LIMIT =
  "You've used today's 1,000 quotes with automatic miles — enter the miles manually for the rest of today.";
const MSG_PLAN_LIMIT = {
  pro: "You've used today's 100 quotes with automatic miles. Pro Plus ($19.99/mo) gives you 250 a day and Pro Max ($49.99/mo) 1,000 — or enter the miles manually.",
  plus: "You've used today's 250 quotes with automatic miles. Pro Max ($49.99/mo) gives you 1,000 a day — or enter the miles manually.",
  max: MSG_TOP_LIMIT,
  api: MSG_TOP_LIMIT,
};

function isAllowedOrigin(origin) {
  if (!origin) return true; // non-browser callers send no Origin header
  if (ALLOWED_ORIGINS.includes(origin)) return true;
  try {
    const { hostname } = new URL(origin);
    if (hostname === 'localhost' || hostname === '127.0.0.1') return true;
    if (hostname.endsWith('.netlify.app')) return true; // previews + branch deploys
    return false;
  } catch {
    return false;
  }
}

function norm(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/,?\s*(usa|united states)\s*$/i, '') // drop trailing country
    .replace(/\s+\d{5}(-\d{4})?\b/, '')           // drop ZIP (5 or ZIP+4)
    .replace(/[.,]/g, ' ')                          // commas/periods → space
    .replace(/\s+/g, ' ')                           // collapse whitespace
    .trim();
}

// Optional verified coordinates for an end of the lane: { lat, lng }. The pages
// send these once the geocode function has confirmed a place, and we route to
// exactly that point. Routing on the text alone lets Google re-read the name and
// it can land on a different same-named place than the one the page showed
// (e.g. "Franklin, WI" → the city near Milwaukee instead of the Vernon County
// town the page matched), so text is only the fallback for unverified values.
function toLatLng(value) {
  if (!value || typeof value !== 'object') return null;
  const lat = Number(value.lat);
  const lng = Number(value.lng);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  if (lat < -90 || lat > 90 || lng < -180 || lng > 180) return null;
  return { latitude: lat, longitude: lng };
}

function waypoint(address, latLng) {
  return latLng ? { location: { latLng } } : { address };
}

// One end of the lane for the free-tier counter: the rounded coordinates when we
// have them (so the same place always counts as the same lane, and coordinates
// can't be varied under a fixed label), otherwise the normalized text.
function laneEnd(address, latLng) {
  if (latLng) return `@${latLng.latitude.toFixed(2)},${latLng.longitude.toFixed(2)}`;
  return norm(address);
}

function supaHeaders(serviceKey) {
  return {
    apikey: serviceKey,
    Authorization: `Bearer ${serviceKey}`,
    'Content-Type': 'application/json',
  };
}

// The caller's IP, used to meter anonymous (not-signed-in) visitors.
function clientIp(event) {
  const h = event.headers || {};
  return (
    h['x-nf-client-connection-ip'] ||
    (h['x-forwarded-for'] || '').split(',')[0] ||
    ''
  ).trim();
}

// Works out who is calling, whether they're Pro and on which plan. Signed-in
// users are verified against Supabase Auth + pro_users so a client can't just
// claim to be Pro. Anonymous callers are identified by IP.
// Returns { pro, plan, createdAt, identity } where identity is 'user:<uuid>'
// or 'ip:<addr>'.
async function resolveIdentity(event, serviceKey) {
  const authHeader = event.headers.authorization || event.headers.Authorization || '';
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : '';

  if (token && serviceKey) {
    try {
      const uResp = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
        headers: { apikey: serviceKey, Authorization: `Bearer ${token}` },
      });
      if (uResp.ok) {
        const user = await uResp.json();
        const uid = user && user.id;
        if (uid) {
          const pResp = await fetch(
            `${SUPABASE_URL}/rest/v1/pro_users?id=eq.${uid}&select=is_active,plan,grandfathered,billing_period_start`,
            { headers: supaHeaders(serviceKey) }
          );
          if (pResp.ok) {
            const rows = await pResp.json();
            const row = Array.isArray(rows) && rows[0];
            const isPro = !!row && row.is_active === true;
            return {
              pro: isPro,
              plan: normalizePlan(isPro ? row.plan : 'pro'),
              grandfathered: row ? row.grandfathered === true : false,
              billingPeriodStart: row ? row.billing_period_start : null,
              identity: `user:${uid}`,
            };
          }
          return { pro: false, identity: `user:${uid}` };
        }
      }
    } catch {
      /* fall through to IP-based identity */
    }
  }
  return { pro: false, identity: `ip:${clientIp(event) || 'unknown'}` };
}

// Today's lane limit for this caller, or null for no limit.
function dailyLaneLimit({ pro, plan, grandfathered, billingPeriodStart }) {
  if (!pro) return FREE_DAILY_LIMIT;
  if (legacyUnlimited({ grandfathered, billing_period_start: billingPeriodStart })) return null;
  return PLAN_DAILY_LIMIT[normalizePlan(plan)];
}

// Records a lane against today's usage and returns whether it's allowed.
// Re-pricing a lane already used today is always allowed (no new slot spent).
// FAILS OPEN: if the counter is unreachable we allow the request, so an infra
// hiccup never blocks a customer — the Google daily quota is the hard ceiling.
async function withinDailyLimit(identity, laneKey, limit, serviceKey) {
  if (!serviceKey) return true;
  try {
    const resp = await fetch(`${SUPABASE_URL}/rest/v1/rpc/record_free_lane`, {
      method: 'POST',
      headers: supaHeaders(serviceKey),
      body: JSON.stringify({
        p_identity: identity,
        p_lane: laneKey,
        p_limit: limit,
      }),
    });
    if (!resp.ok) return true;
    return (await resp.json()) === true;
  } catch {
    return true;
  }
}

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return json(405, { error: MSG_UNAVAILABLE });
  }

  const origin = event.headers.origin || event.headers.Origin || '';
  if (!isAllowedOrigin(origin)) {
    return json(403, { error: 'Forbidden' });
  }

  const key = process.env.GMAPS_API_KEY;
  if (!key) {
    console.error('[routes] GMAPS_API_KEY not configured');
    return json(200, { error: MSG_UNAVAILABLE });
  }
  const serviceKey =
    process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;

  let body;
  try {
    body = JSON.parse(event.body || '{}');
  } catch {
    return json(400, { error: 'Invalid request' });
  }

  const originAddr = String(body.origin || '').trim().slice(0, MAX_ADDR_LEN);
  const destAddr = String(body.destination || '').trim().slice(0, MAX_ADDR_LEN);
  if (!originAddr || !destAddr) {
    return json(400, { error: 'origin and destination are required' });
  }
  const includeLegs = body.includeLegs === true;
  const originLatLng = toLatLng(body.originLatLng);
  const destLatLng = toLatLng(body.destinationLatLng);

  // Daily lane limit: FREE_DAILY_LIMIT without Pro, PLAN_DAILY_LIMIT by plan (100, 250,
  // 1,000 on Pro Max / API). The lane key is legs-agnostic so the same lane counts
  // once no matter which page (calculator, profitability, etc.) requested it.
  // `plan` in the limit response tells the page which upgrade to offer.
  const caller = await resolveIdentity(event, serviceKey);
  const limit = dailyLaneLimit(caller);
  if (limit) {
    const laneKey = crypto
      .createHash('sha256')
      .update(`${laneEnd(originAddr, originLatLng)}|${laneEnd(destAddr, destLatLng)}`)
      .digest('hex');
    const allowed = await withinDailyLimit(caller.identity, laneKey, limit, serviceKey);
    if (!allowed) {
      return caller.pro
        ? json(200, { error: MSG_PLAN_LIMIT[caller.plan] || MSG_PLAN_LIMIT.pro, limit: true, plan: caller.plan })
        : json(200, { error: MSG_LIMIT, limit: true, plan: 'free' });
    }
  }

  // 1) Call Google.
  const fieldMask = includeLegs ? `${BASE_FIELDS},${LEG_FIELDS}` : BASE_FIELDS;
  let resp, data;
  try {
    resp = await fetch('https://routes.googleapis.com/directions/v2:computeRoutes', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Goog-Api-Key': key,
        'X-Goog-FieldMask': fieldMask,
      },
      body: JSON.stringify({
        origin: waypoint(originAddr, originLatLng),
        destination: waypoint(destAddr, destLatLng),
        travelMode: 'DRIVE',
        routingPreference: 'TRAFFIC_UNAWARE', // Essentials tier — stays in free cap
        units: 'IMPERIAL',
      }),
    });
    data = await resp.json();
  } catch (e) {
    console.error('[routes] upstream unreachable:', e && e.message);
    return json(200, { error: MSG_UNAVAILABLE });
  }

  const route = data && data.routes && data.routes[0];

  // 2) Success → return it.
  if (resp.ok && route && route.distanceMeters != null) {
    return json(200, { routes: [route] });
  }

  // 3) Valid request but no route between the points → let the client say so.
  if (resp.ok && !route) {
    return json(200, { notFound: true });
  }

  // 4) Real error (quota, denied, etc.) → log the truth, return a safe message.
  const reason = (data && data.error && (data.error.message || data.error.status)) || `HTTP ${resp.status}`;
  console.error('[routes] google failure:', resp.status, reason);
  const quota = resp.status === 429 || /quota|RESOURCE_EXHAUSTED/i.test(reason);
  return json(200, { error: quota ? MSG_BUSY : MSG_UNAVAILABLE });
};

function json(statusCode, obj) {
  return {
    statusCode,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(obj),
  };
}
