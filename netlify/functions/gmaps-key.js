// Netlify serverless function — serves Google Maps API key safely
// Add GMAPS_API_KEY as a Netlify environment variable:
//   Site configuration → Environment variables → Add variable
//   Key: GMAPS_API_KEY   Value: your Google Maps API key

exports.handler = async () => {
  const key = process.env.GMAPS_API_KEY;
  if (!key) {
    return {
      statusCode: 500,
      body: JSON.stringify({ error: 'GMAPS_API_KEY not configured' }),
    };
  }
  return {
    statusCode: 200,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ key }),
  };
};
