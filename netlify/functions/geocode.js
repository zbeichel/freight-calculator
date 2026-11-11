// netlify/functions/geocode.js
//
// Proxies Google Geocoding so the API key stays on the server. Google's raw
// error text is never returned to the client.
//
// Results are not cached in Supabase or at the edge: Google's Geocoding terms
// only allow temporary caching of lat/lng and forbid sharing cached address
// results across users, so every lookup goes to Google.
//
// One Google call per lookup. The ZIP is included only when Google returns one
// for the place itself (a typed ZIP or a street address). Bare city entries come
// back as "City, ST" — we no longer make a second reverse-geocode call just to
// decorate them with the ZIP at the city centre. The pages route on the lat/lon
// returned here, so the ZIP isn't needed to pin the place for the Routes API, and
// `county` lets the page show which same-named place was matched.
//
// Response shape (success):
//   { name, city, state, zip, county, lat, lon, types, partialMatch, formatted }
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
  const zip = findComponent(components, 'postal_code');
  const county = findComponent(components, 'administrative_area_level_2');

  const payload = {
    name: buildDisplayName(city, state, zip),
    city,
    state,
    zip,
    county,
    lat,
    lon,
    types: result.types || [],
    partialMatch: result.partial_match === true,
    formatted: result.formatted_address || '',
  };

  return respond(200, payload);
};
