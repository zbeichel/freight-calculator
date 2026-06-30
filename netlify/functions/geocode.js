// netlify/functions/geocode.js
//
// Proxies Google Geocoding so the API key stays on the server, and caches every
// successful lookup in Supabase (geo_cache) so the same pickup/delivery location
// never re-hits Google. Google's raw error text is never returned to the client.
//
// Response shape (success):
//   { name, city, state, zip, lat, lon, types, partialMatch, formatted }
// Failure: { error: "<safe message>" }  (HTTP 200 — client branches on .error)

const crypto = require('crypto');

const GOOGLE_ENDPOINT = 'https://maps.googleapis.com/maps/api/geocode/json';
const SUPABASE_URL = 'https://xgrmbhmgcsbnazupfybd.supabase.co';

const JSON_HEADERS = {
  'Content-Type': 'application/json',
  'Cache-Control': 'public, max-age=86400', // geocodes are stable; cache 24h at the edge
};

function respond(statusCode, body) {
  return { statusCode, headers: JSON_HEADERS, body: JSON.stringify(body) };
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

async function readCache(key, serviceKey) {
  if (!serviceKey) return null;
  try {
    const url = `${SUPABASE_URL}/rest/v1/geo_cache?cache_key=eq.${key}&select=payload`;
    const resp = await fetch(url, { headers: supaHeaders(serviceKey) });
    if (!resp.ok) return null;
    const rows = await resp.json();
    if (!Array.isArray(rows) || rows.length === 0) return null;
    return rows[0].payload || null;
  } catch {
    return null;
  }
}

async function writeCache(key, query, payload, serviceKey) {
  if (!serviceKey) return;
  try {
    await fetch(`${SUPABASE_URL}/rest/v1/geo_cache`, {
      method: 'POST',
      headers: { ...supaHeaders(serviceKey), Prefer: 'resolution=merge-duplicates' },
      body: JSON.stringify({ cache_key: key, query: query.slice(0, 160), payload }),
    });
  } catch {
    /* caching is best-effort */
  }
}

function findComponent(components, type, short = false) {
  const match = components.find((c) => c.types.includes(type));
  if (!match) return '';
  return short ? match.short_name : match.long_name;
}

function buildDisplayName(city, state, zip) {
  const cityState = [city, state].filter(Boolean).join(', ');
  return zip ? `${cityState} ${zip}` : cityState;
}

function extractCity(components) {
  const preferred = [
    'locality',
    'sublocality',
    'postal_town',
    'administrative_area_level_3',
    'neighborhood',
  ];
  for (const type of preferred) {
    const name = findComponent(components, type);
    if (name) return name;
  }
  return '';
}

async function lookupZipByCoords(lat, lon, apiKey) {
  const params = new URLSearchParams({
    latlng: `${lat},${lon}`,
    key: apiKey,
    result_type: 'postal_code',
  });
  let data;
  try {
    const resp = await fetch(`${GOOGLE_ENDPOINT}?${params}`);
    data = await resp.json();
  } catch {
    return '';
  }
  if (data.status !== 'OK' || !data.results?.length) return '';
  const zipResult =
    data.results.find((r) => r.types?.includes('postal_code')) || data.results[0];
  return findComponent(zipResult.address_components || [], 'postal_code');
}

exports.handler = async (event) => {
  const address =
    (event.queryStringParameters && event.queryStringParameters.address) || '';
  if (!address.trim()) {
    return respond(400, { error: 'Missing address parameter' });
  }

  const apiKey = process.env.GMAPS_API_KEY;
  if (!apiKey) {
    console.error('[geocode] GMAPS_API_KEY not configured');
    return respond(200, { error: 'Location lookup is unavailable' });
  }
  const serviceKey =
    process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;

  const ck = crypto.createHash('sha256').update(norm(address)).digest('hex');

  // 1) Cache hit → no Google call.
  const cachedPayload = await readCache(ck, serviceKey);
  if (cachedPayload) return respond(200, cachedPayload);

  // 2) Cache miss → call Google.
  const params = new URLSearchParams({
    address: address.trim(),
    key: apiKey,
    components: 'country:US',
  });

  let data;
  try {
    const resp = await fetch(`${GOOGLE_ENDPOINT}?${params}`);
    data = await resp.json();
  } catch {
    return respond(200, { error: 'Location lookup is unavailable' });
  }

  if (data.status === 'ZERO_RESULTS') {
    return respond(200, { error: 'No results' });
  }
  if (data.status !== 'OK' || !data.results?.length) {
    // Log the real Google status/message; return only a safe generic to the client.
    console.error('[geocode] google status:', data.status, data.error_message || '');
    return respond(200, { error: 'Could not verify location' });
  }

  const result = data.results[0];
  const components = result.address_components || [];
  const lat = result.geometry?.location?.lat;
  const lon = result.geometry?.location?.lng;

  const city = extractCity(components);
  const state = findComponent(components, 'administrative_area_level_1', true);
  let zip = findComponent(components, 'postal_code');

  if (!zip && typeof lat === 'number' && typeof lon === 'number') {
    zip = await lookupZipByCoords(lat, lon, apiKey);
  }

  const payload = {
    name: buildDisplayName(city, state, zip),
    city,
    state,
    zip,
    lat,
    lon,
    types: result.types || [],
    partialMatch: result.partial_match === true,
    formatted: result.formatted_address || '',
  };

  // 3) Cache the successful resolution (best-effort) and return it.
  await writeCache(ck, address.trim(), payload, serviceKey);
  return respond(200, payload);
};
