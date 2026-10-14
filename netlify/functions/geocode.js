// netlify/functions/geocode.js
//
// Proxies Google Geocoding so the API key stays on the server. Google's raw
// error text is never returned to the client.
//
// Results are not cached in Supabase or at the edge: Google's Geocoding terms
// only allow temporary caching of lat/lng and forbid sharing cached address
// results across users, so every lookup goes to Google.
//
// Response shape (success):
//   { name, city, state, zip, lat, lon, types, partialMatch, formatted }
// Failure: { error: "<safe message>" }  (HTTP 200 — client branches on .error)

const GOOGLE_ENDPOINT = 'https://maps.googleapis.com/maps/api/geocode/json';

const JSON_HEADERS = {
  'Content-Type': 'application/json',
  'Cache-Control': 'no-store', // Google terms: no shared caching of geocode results
};

function respond(statusCode, body) {
  return { statusCode, headers: JSON_HEADERS, body: JSON.stringify(body) };
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

  return respond(200, payload);
};
