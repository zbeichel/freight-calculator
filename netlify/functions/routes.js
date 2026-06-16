// netlify/functions/routes.js
//
// Server-side proxy for the Google Routes API (Compute Routes).
// The browser POSTs { origin, destination, includeLegs } and gets Google's
// response back verbatim. The API key never leaves the server, so it can't be
// scraped from the page or a network tab — which is the protection an HTTP
// referrer restriction was trying (and failing) to provide.

// Production domains that are always allowed. Netlify preview/branch deploys
// (*.netlify.app) and localhost are also allowed below so testing works.
const ALLOWED_ORIGINS = [
  'https://quickfreightcalc.com',
  'https://www.quickfreightcalc.com',
];

const BASE_FIELDS = 'routes.distanceMeters,routes.duration';
const LEG_FIELDS = 'routes.legs.startLocation,routes.legs.endLocation';
const MAX_ADDR_LEN = 120;

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

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return json(405, { error: 'Method not allowed' });
  }

  // Soft origin allowlist — blocks casual abuse of this endpoint from elsewhere.
  // Not a hard security boundary (Origin can be forged), but the real lock is
  // that the key is server-only and API-restricted in Cloud Console.
  const origin = event.headers.origin || event.headers.Origin || '';
  if (!isAllowedOrigin(origin)) {
    return json(403, { error: 'Forbidden' });
  }

  const key = process.env.GMAPS_API_KEY;
  if (!key) return json(500, { error: 'Maps key not configured' });

  let body;
  try {
    body = JSON.parse(event.body || '{}');
  } catch {
    return json(400, { error: 'Invalid JSON' });
  }

  const originAddr = String(body.origin || '').trim().slice(0, MAX_ADDR_LEN);
  const destAddr = String(body.destination || '').trim().slice(0, MAX_ADDR_LEN);
  if (!originAddr || !destAddr) {
    return json(400, { error: 'origin and destination are required' });
  }

  const fieldMask = body.includeLegs
    ? `${BASE_FIELDS},${LEG_FIELDS}`
    : BASE_FIELDS;

  try {
    const resp = await fetch(
      'https://routes.googleapis.com/directions/v2:computeRoutes',
      {
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
      }
    );

    // Forward Google's status and body straight through — never the key, and
    // never a synthesized success. The client already reads data.routes[0].
    const data = await resp.json();
    return json(resp.status, data);
  } catch {
    return json(502, { error: 'Routes lookup failed' });
  }
};

function json(statusCode, obj) {
  return {
    statusCode,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(obj),
  };
}
