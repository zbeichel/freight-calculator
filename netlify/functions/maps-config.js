// netlify/functions/maps-config.js
//
// Hands the calculator's lane view the browser key for Google's Maps Embed API,
// which draws a lane's route on Google's own map (free, unlimited use).
//
// This is NOT the server key (GMAPS_API_KEY) that the routes and geocode
// functions use: that one must never reach a browser. GMAPS_EMBED_KEY is a
// separate key that is public by design: in Google Cloud it should allow only
// the "Maps Embed API" and only these websites (HTTP referrers):
//   https://quickfreightcalc.com/*
//   https://www.quickfreightcalc.com/*
//   https://*.netlify.app/*        (deploy previews and branch deploys)
// Without it the lane view links to the route on Google Maps instead.
//
// Why not draw the route on the site's own US map? Google's terms don't allow
// Google routes, miles or places to be shown on or near a non-Google map.

exports.handler = async () => {
  const key = String(process.env.GMAPS_EMBED_KEY || '').trim();
  return {
    statusCode: 200,
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 'public, max-age=300',
    },
    body: JSON.stringify({ embedKey: /^[A-Za-z0-9_-]{20,80}$/.test(key) ? key : null }),
  };
};
