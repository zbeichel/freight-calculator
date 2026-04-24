// netlify/functions/geocode.js
//
// Proxies Google Geocoding API requests so the API key stays on the server.
// Returns a structured payload the client can use to validate that a typed
// origin/destination resolves to a real place (not a random partial match).
//
// For bare city inputs like "Charlotte, NC", Google's forward geocoder returns
// the city centroid without a postal_code. To keep the "City, ST ZIP" display
// consistent across all inputs, we fall back to a reverse geocode on those
// coordinates, which returns the ZIP polygon covering the centroid.
//
// Response shape:
//   success: {
//     name:         "Charlotte, NC 28202"   // canonical display string
//     city:         "Charlotte"
//     state:        "NC"                    // 2-letter postal abbreviation
//     zip:          "28202"                 // may be "" if even reverse-geocode failed
//     lat:          35.2270869
//     lon:          -80.8431267
//     types:        ["locality", "political"]
//     partialMatch: false
//     formatted:    "Charlotte, NC, USA"    // Google's formatted_address
//   }
//   failure: { error: "message" }   (HTTP 200 — client branches on .error)

const GOOGLE_ENDPOINT = 'https://maps.googleapis.com/maps/api/geocode/json';

const JSON_HEADERS = {
  'Content-Type': 'application/json',
  'Cache-Control': 'public, max-age=86400', // geocodes are stable; cache 24h at the edge
};

function respond(statusCode, body) {
  return { statusCode, headers: JSON_HEADERS, body: JSON.stringify(body) };
}

// Pulls a component by type from Google's address_components array.
// `short` returns the short_name (e.g. "GA"), otherwise long_name ("Georgia").
function findComponent(components, type, short = false) {
  const match = components.find(c => c.types.includes(type));
  if (!match) return '';
  return short ? match.short_name : match.long_name;
}

// Builds a clean "City, ST ZIP" display string from the components we care about.
function buildDisplayName(city, state, zip) {
  const cityState = [city, state].filter(Boolean).join(', ');
  return zip ? `${cityState} ${zip}` : cityState;
}

// Picks the best "city-like" component from a result. Google puts the city
// in different fields depending on the place type — locality for incorporated
// cities, sublocality for NYC boroughs, admin_area_level_3 for townships,
// neighborhood for small unincorporated places (e.g. Bird in Hand, PA).
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

// Reverse-geocodes lat/lon to find the ZIP polygon containing that point.
// Used as a fallback when a forward geocode of a bare city returns no ZIP.
// Returns "" on any failure — the caller treats this as "no ZIP available".
async function lookupZipByCoords(lat, lon, apiKey) {
  const params = new URLSearchParams({
    latlng:      `${lat},${lon}`,
    key:         apiKey,
    result_type: 'postal_code', // narrow the response; Google returns only postal_code results
  });

  let data;
  try {
    const resp = await fetch(`${GOOGLE_ENDPOINT}?${params}`);
    data = await resp.json();
  } catch {
    return '';
  }

  if (data.status !== 'OK' || !data.results?.length) return '';

  // Prefer a result whose top-level type is postal_code. Fall back to the first
  // result's address_components if Google doesn't tag it that way.
  const zipResult =
    data.results.find(r => r.types?.includes('postal_code')) || data.results[0];
  return findComponent(zipResult.address_components || [], 'postal_code');
}

exports.handler = async (event) => {
  const address = (event.queryStringParameters && event.queryStringParameters.address) || '';
  if (!address.trim()) {
    return respond(400, { error: 'Missing address parameter' });
  }

  const apiKey = process.env.GMAPS_API_KEY;
  if (!apiKey) {
    return respond(500, { error: 'Geocoding not configured' });
  }

  const params = new URLSearchParams({
    address:    address.trim(),
    key:        apiKey,
    components: 'country:US',
  });

  let data;
  try {
    const resp = await fetch(`${GOOGLE_ENDPOINT}?${params}`);
    data = await resp.json();
  } catch {
    return respond(502, { error: 'Upstream geocoder unreachable' });
  }

  if (data.status === 'ZERO_RESULTS') {
    return respond(200, { error: 'No results' });
  }
  if (data.status !== 'OK' || !data.results?.length) {
    return respond(200, { error: data.error_message || data.status || 'Geocode failed' });
  }

  const result     = data.results[0];
  const components = result.address_components || [];
  const lat        = result.geometry?.location?.lat;
  const lon        = result.geometry?.location?.lng;

  const city  = extractCity(components);
  const state = findComponent(components, 'administrative_area_level_1', true);
  let   zip   = findComponent(components, 'postal_code');

  // Bare-city queries (e.g. "Charlotte, NC") don't return a postal_code at the
  // city level. Reverse-geocode the centroid to get a representative ZIP so the
  // display stays consistent across all inputs.
  if (!zip && typeof lat === 'number' && typeof lon === 'number') {
    zip = await lookupZipByCoords(lat, lon, apiKey);
  }

  return respond(200, {
    name:         buildDisplayName(city, state, zip),
    city,
    state,
    zip,
    lat,
    lon,
    types:        result.types || [],
    partialMatch: result.partial_match === true,
    formatted:    result.formatted_address || '',
  });
};
