// netlify/functions/news-purge.js
//
// After the site owner publishes or takes back a Market News week (the buttons on
// market-news.html), clears Netlify's cached copies of the Market News pages and sitemap.xml,
// so visitors see the change right away instead of within 10 minutes. Those responses all
// carry one cache tag (netlify/lib/news-cache.js), and this asks Netlify to drop that tag.
//
// POST with the owner's sign-in (Authorization: Bearer <access token>); only the site owner
// (is_site_admin) may ask. Netlify hands this function its own purge token on each call
// (context.clientContext.custom.purge_api_token), so there's no key to set up.
//   200 { purged: true }   401 not signed in   403 not the owner   502/503 couldn't clear it

const { CACHE_TAG } = require('../lib/news-cache.js');

const SUPABASE_URL = 'https://xgrmbhmgcsbnazupfybd.supabase.co';
const SUPABASE_KEY = 'sb_publishable_zSa4XpzakcntdkZfTzUPlg_FigYcISZ';   // the site's public key
const PURGE_API = 'https://api.netlify.com/api/v1/purge';

const reply = (statusCode, body) => ({
  statusCode,
  headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  body: JSON.stringify(body),
});
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

// The same check the Market News page uses to show the owner's buttons
async function isOwner(token) {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/rpc/is_site_admin`, {
    method: 'POST',
    headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: '{}',
    signal: AbortSignal.timeout(8000),
  });
  if (!r.ok) return false;
  return (await r.json()) === true;
}

// Which site to clear: the one this function runs for
function site() {
  if (process.env.SITE_ID) return { site_id: process.env.SITE_ID };
  if (process.env.SITE_NAME) return { site_slug: process.env.SITE_NAME };
  return null;
}

async function purge(token, target) {
  const call = () => fetch(PURGE_API, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json; charset=utf8', Authorization: `Bearer ${token}` },
    body: JSON.stringify(Object.assign({}, target, { cache_tags: [CACHE_TAG] })),
    signal: AbortSignal.timeout(10000),
  });
  let r = await call();
  // Netlify allows two purges of a tag every 5 seconds (Publish, then Unpublish right away)
  if (r.status === 429) { await wait(3000); r = await call(); }
  return r;
}

exports.handler = async (event, context) => {
  if (event.httpMethod !== 'POST') return reply(405, { error: 'Use POST.' });
  const h = event.headers || {};
  const auth = String(h.authorization || h.Authorization || '');
  const token = (auth.match(/^Bearer\s+(\S+)$/i) || [])[1];
  if (!token) return reply(401, { error: 'Sign in as the site owner.' });
  try {
    if (!(await isOwner(token))) return reply(403, { error: 'Only the site owner can do this.' });
  } catch (e) {
    console.error('[news-purge] owner check:', e.message);
    return reply(502, { error: 'Couldn’t check your sign-in.' });
  }

  const purgeToken = context && context.clientContext && context.clientContext.custom && context.clientContext.custom.purge_api_token;
  const target = site();
  if (!purgeToken || !target) {
    console.error(`[news-purge] can't clear the cache here: ${purgeToken ? '' : 'no purge token from Netlify '}${target ? '' : 'no SITE_ID or SITE_NAME'}`.trim());
    return reply(503, { error: 'Clearing the cache isn’t available here.' });
  }
  try {
    const r = await purge(purgeToken, target);
    if (!r.ok) {
      console.error('[news-purge] Netlify answered', r.status);
      return reply(502, { error: 'Netlify didn’t clear the cache.', status: r.status });
    }
  } catch (e) {
    console.error('[news-purge] purge call:', e.message);
    return reply(502, { error: 'Netlify didn’t answer.' });
  }
  console.log(`[news-purge] cleared "${CACHE_TAG}"`);
  return reply(200, { purged: true });
};
