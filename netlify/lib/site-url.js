// site-url.js — the site address to put in emails: the live site, or the Netlify deploy
// the request came from (so a test email from a deploy preview links to that preview).
// Only the site's own hosts count; anything else gets SITE_URL.
function siteBase(event) {
  const h = (event && event.headers) || {};
  const host = String(h['x-forwarded-host'] || h.host || h.Host || '').toLowerCase().split(':')[0].trim();
  if (/^(www\.)?quickfreightcalc\.com$/.test(host)) return 'https://quickfreightcalc.com';
  if (/^([a-z0-9-]+--)?quickfreightcalculator\.netlify\.app$/.test(host)) return `https://${host}`;
  return process.env.SITE_URL || 'https://quickfreightcalc.com';
}

module.exports = { siteBase };
