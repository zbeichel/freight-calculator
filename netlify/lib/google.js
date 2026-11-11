// netlify/lib/google.js
// Google Geocoding and Routes calls shared by geocode.js (the site's location
// check) and api-quote.js (the API), so both resolve places the same way.
//
// Google's terms: results are not stored or shared between callers, and only
// the coordinates may be kept temporarily, so every lookup goes to Google.
// Never return Google's raw error text to a caller; log it instead.

const GEOCODE_URL = 'https://maps.googleapis.com/maps/api/geocode/json';
const ROUTES_URL = 'https://routes.googleapis.com/directions/v2:computeRoutes';
const TIMEOUT_MS = 8000; // give up before Netlify's 10-second function limit

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

// One US place for the typed text (city and state, ZIP or street address).
// Returns one of:
//   { status: 'ok', place: { name, city, state, zip, county, lat, lon, types, partialMatch, formatted } }
//   { status: 'not_found' }
//   { status: 'error', quota, unreachable }   (Google unreachable, denied or over quota)
// The ZIP is included only when Google returns one for the place itself.
async function geocodePlace(address, apiKey, label = 'geocode') {
  const params = new URLSearchParams({
    address: String(address || '').trim(),
    key: apiKey,
    components: 'country:US',
  });
  let data;
  try {
    const resp = await fetch(`${GEOCODE_URL}?${params}`, { signal: AbortSignal.timeout(TIMEOUT_MS) });
    data = await resp.json();
  } catch (e) {
    console.error(`[${label}] geocode unreachable:`, e && e.message);
    return { status: 'error', quota: false, unreachable: true };
  }
  if (data.status === 'ZERO_RESULTS') return { status: 'not_found' };
  if (data.status !== 'OK' || !data.results?.length) {
    console.error(`[${label}] google status:`, data.status, data.error_message || '');
    return { status: 'error', quota: data.status === 'OVER_QUERY_LIMIT' || data.status === 'OVER_DAILY_LIMIT' };
  }

  const result = data.results[0];
  const components = result.address_components || [];
  const city = extractCity(components);
  const state = findComponent(components, 'administrative_area_level_1', true);
  const zip = findComponent(components, 'postal_code');
  const county = findComponent(components, 'administrative_area_level_2');
  return {
    status: 'ok',
    place: {
      name: buildDisplayName(city, state, zip),
      city,
      state,
      zip,
      county,
      lat: result.geometry?.location?.lat,
      lon: result.geometry?.location?.lng,
      types: result.types || [],
      partialMatch: result.partial_match === true,
      formatted: result.formatted_address || '',
    },
  };
}

// Driving distance and time between two points ({ lat, lng }), on the
// Essentials tier (no live traffic), like the site's routes function.
// Returns { status: 'ok', distanceMeters, durationSeconds } | { status: 'not_found' }
//       | { status: 'error', quota }
async function computeRoute(from, to, apiKey, label = 'routes') {
  const point = (p) => ({ location: { latLng: { latitude: p.lat, longitude: p.lng } } });
  let resp;
  let data;
  try {
    resp = await fetch(ROUTES_URL, {
      method: 'POST',
      signal: AbortSignal.timeout(TIMEOUT_MS),
      headers: {
        'Content-Type': 'application/json',
        'X-Goog-Api-Key': apiKey,
        'X-Goog-FieldMask': 'routes.distanceMeters,routes.duration',
      },
      body: JSON.stringify({
        origin: point(from),
        destination: point(to),
        travelMode: 'DRIVE',
        routingPreference: 'TRAFFIC_UNAWARE',
        units: 'IMPERIAL',
      }),
    });
    data = await resp.json();
  } catch (e) {
    console.error(`[${label}] routes unreachable:`, e && e.message);
    return { status: 'error', quota: false };
  }
  const route = data && data.routes && data.routes[0];
  if (resp.ok && route && route.distanceMeters != null) {
    const seconds = parseInt(String(route.duration || '0').replace(/s$/, ''), 10);
    return { status: 'ok', distanceMeters: route.distanceMeters, durationSeconds: Number.isFinite(seconds) ? seconds : null };
  }
  if (resp.ok && !route) return { status: 'not_found' };
  const reason = (data && data.error && (data.error.message || data.error.status)) || `HTTP ${resp.status}`;
  console.error(`[${label}] google failure:`, resp.status, reason);
  return { status: 'error', quota: resp.status === 429 || /quota|RESOURCE_EXHAUSTED/i.test(reason) };
}

module.exports = { geocodePlace, computeRoute };
