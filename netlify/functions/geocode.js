// netlify/functions/geocode.js
// Proxies Google Geocoding API server-side so the key is never exposed
// and referrer restrictions don't block the request.
// Env var required: GMAPS_API_KEY

exports.handler = async (event) => {
  const address = event.queryStringParameters?.address;
  if (!address) {
    return { statusCode: 400, body: JSON.stringify({ error: 'address param required' }) };
  }

  const key = process.env.GMAPS_API_KEY;
  if (!key) {
    return { statusCode: 500, body: JSON.stringify({ error: 'GMAPS_API_KEY not configured' }) };
  }

  try {
    const url = `https://maps.googleapis.com/maps/api/geocode/json?address=${encodeURIComponent(address)}&key=${key}`;
    const resp = await fetch(url);
    const data = await resp.json();

    if (data.status === 'REQUEST_DENIED') {
      return { statusCode: 403, body: JSON.stringify({ error: 'REQUEST_DENIED: ' + (data.error_message || '') }) };
    }

    if (!data.results?.[0]) {
      return { statusCode: 404, body: JSON.stringify({ error: 'Location not found', status: data.status }) };
    }

    const result = data.results[0];
    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        lat: result.geometry.location.lat,
        lon: result.geometry.location.lng,
        name: result.formatted_address
      })
    };
  } catch (e) {
    return { statusCode: 500, body: JSON.stringify({ error: e.message }) };
  }
};
