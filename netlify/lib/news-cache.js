// news-cache.js — Netlify's CDN keeps the Market News pages (news-page.js) and sitemap.xml
// (sitemap.js) for a few minutes. Every one of those responses carries this cache tag, so
// news-purge.js can clear them all at once when the site owner publishes or takes back a week.
const CACHE_TAG = 'market-news';

module.exports = { CACHE_TAG };
