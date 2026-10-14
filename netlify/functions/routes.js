// netlify/functions/routes.js
//
// Server-side proxy for the Google Routes API (Compute Routes).
// - The API key never leaves the server.
// - Routes are not cached: Google's Routes API terms only allow temporary
//   caching of lat/lng, not distances or durations, so every lookup goes to
//   Google. The free-tier daily limit below still caps anonymous usage.
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

// Free tier: this many distinct lanes (origin→destination pairs) per day.
// Pro users are exempt. Re-pricing a lane you already ran today is free.
const FREE_DAILY_LIMIT = 5;
const MSG_LIMIT =
  "You've hit today's free limit of 5 auto-distance lookups. Upgrade to Pro for unlimited — or enter the miles manually.";

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

// Works out who is calling and whether they're Pro (Pro = exempt from limits).
// Signed-in users are verified against Supabase Auth + pro_users so a client
// can't just claim to be Pro. Anonymous callers are identified by IP.
// Returns { pro, identity } where identity is 'user:<uuid>' or 'ip:<addr>'.
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
            `${SUPABASE_URL}/rest/v1/pro_users?id=eq.${uid}&select=is_active`,
            { headers: supaHeaders(serviceKey) }
          );
          if (pResp.ok) {
            const rows = await pResp.json();
            const isPro = Array.isArray(rows) && rows[0] && rows[0].is_active === true;
            return { pro: isPro, identity: `user:${uid}` };
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

// Records a lane against today's usage and returns whether it's allowed.
// Re-pricing a lane already used today is always allowed (no new slot spent).
// FAILS OPEN: if the counter is unreachable we allow the request, so an infra
// hiccup never blocks a customer — the Google daily quota is the hard ceiling.
async function withinFreeLimit(identity, laneKey, serviceKey) {
  if (!serviceKey) return true;
  try {
    const resp = await fetch(`${SUPABASE_URL}/rest/v1/rpc/record_free_lane`, {
      method: 'POST',
      headers: supaHeaders(serviceKey),
      body: JSON.stringify({
        p_identity: identity,
        p_lane: laneKey,
        p_limit: FREE_DAILY_LIMIT,
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

  // Free-tier limit. Pro users are exempt; everyone else gets FREE_DAILY_LIMIT
  // distinct lanes/day. The lane key is legs-agnostic so the same lane counts
  // once no matter which page (calculator, profitability, etc.) requested it.
  const { pro, identity } = await resolveIdentity(event, serviceKey);
  if (!pro) {
    const laneKey = crypto
      .createHash('sha256')
      .update(`${norm(originAddr)}|${norm(destAddr)}`)
      .digest('hex');
    const allowed = await withinFreeLimit(identity, laneKey, serviceKey);
    if (!allowed) {
      return json(200, { error: MSG_LIMIT, limit: true });
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
        origin: { address: originAddr },
        destination: { address: destAddr },
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
