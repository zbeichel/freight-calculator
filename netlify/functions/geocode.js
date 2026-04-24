// netlify/functions/geocode.js
//
// Proxies Google Geocoding API requests so the API key stays on the server.
// Returns a structured payload the client can use to validate that a typed
// origin/destination resolves to a real place (not a random partial match).
//
// Response shape:
//   success: {
//     name:         "Atlanta, GA 30303"   // canonical display string
//     city:         "Atlanta"
//     state:        "GA"                  // 2-letter postal abbreviation
//     zip:          "30303"               // may be ""
//     lat:          33.7489924
//     lon:          -84.3902644
//     types:        ["locality", "political"]
//     partialMatch: false
//     formatted:    "Atlanta, GA, USA"    // Google's formatted_address
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

exports.handler = async (event) => {
  const address = (event.queryStringParameters && event.queryStringParameters.address) || '';
  if (!address.trim()) {
    return respond(400, { error: 'Missing address parameter' });
  }

  const apiKey = process.env.GOOGLE_MAPS_KEY;
  if (!apiKey) {
    return respond(500, { error: 'Geocoding not configured' });
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
  } catch (err) {
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

  const city  = extractCity(components);
  const state = findComponent(components, 'administrative_area_level_1', true);
  const zip   = findComponent(components, 'postal_code');
  const name  = buildDisplayName(city, state, zip);

  return respond(200, {
    name,
    city,
    state,
    zip,
    lat:          result.geometry?.location?.lat,
    lon:          result.geometry?.location?.lng,
    types:        result.types || [],
    partialMatch: result.partial_match === true,
    formatted:    result.formatted_address || '',
  });
};
