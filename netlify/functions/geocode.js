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

const { geocodePlace } = require('../lib/google.js');

const JSON_HEADERS = {
  'Content-Type': 'application/json',
  'Cache-Control': 'no-store', // Google terms: no shared caching of geocode results
};

function respond(statusCode, body) {
  return { statusCode, headers: JSON_HEADERS, body: JSON.stringify(body) };
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

  // The lookup and the parsing live in netlify/lib/google.js, shared with the API.
  const result = await geocodePlace(address, apiKey, 'geocode');
  if (result.status === 'not_found') return respond(200, { error: 'No results' });
  if (result.status !== 'ok') {
    return respond(200, { error: result.unreachable ? 'Location lookup is unavailable' : 'Could not verify location' });
  }
  return respond(200, result.place);
};
