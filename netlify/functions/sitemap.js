// netlify/functions/sitemap.js — /sitemap.xml (netlify.toml), which robots.txt points search
// engines to: the site's public pages and every published Market News week, each at the
// address its page names as canonical. Account pages (Profile, Customers) and the 404 page
// aren't listed. Netlify's CDN keeps it an hour.

const N = require('../../news-render.js');

const SUPABASE_URL = 'https://xgrmbhmgcsbnazupfybd.supabase.co';
const SUPABASE_KEY = 'sb_publishable_zSa4XpzakcntdkZfTzUPlg_FigYcISZ';   // the site's public key
const SITE = 'https://quickfreightcalc.com';

// Public pages, by the address they're canonical at (tests/news_test.js checks each file exists
// and names that address)
const PAGES = [
  { path: '/', file: 'index.html' },
  { path: '/rates', file: 'rates.html' },
  { path: '/market-news', file: 'market-news.html' },
  { path: '/signup', file: 'signup.html' },
  { path: '/multistop', file: 'multistop.html' },
  { path: '/bulk', file: 'bulk.html' },
  { path: '/lanes', file: 'lanes.html' },
  { path: '/carriers', file: 'carriers.html' },
  { path: '/api', file: 'api.html' },
  { path: '/terms', file: 'terms.html' },
  { path: '/privacy', file: 'privacy.html' },
];

const xml = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const date = (t) => (t ? new Date(t).toISOString().slice(0, 10) : null);

async function weeks() {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/market_updates?select=week_of,published_at,updated_at&status=eq.published&order=week_of.desc&limit=5000`, {
    headers: { apikey: SUPABASE_KEY, Accept: 'application/json' },
    signal: AbortSignal.timeout(8000),
  });
  if (!r.ok) throw new Error(`market_updates answered ${r.status}`);
  const rows = await r.json();
  return Array.isArray(rows) ? rows.filter((x) => N.isWeek(String(x.week_of).slice(0, 10))) : [];
}

function sitemap(list) {
  const latest = list[0] ? date(list[0].updated_at || list[0].published_at) : null;
  const urls = PAGES.map((p) => ({ loc: SITE + p.path, lastmod: p.path === '/market-news' ? latest : null }))
    .concat(list.map((w) => ({ loc: SITE + N.weekUrl(w.week_of), lastmod: date(w.updated_at || w.published_at) })));
  return '<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n'
    + urls.map((u) => `  <url><loc>${xml(u.loc)}</loc>${u.lastmod ? `<lastmod>${u.lastmod}</lastmod>` : ''}</url>`).join('\n')
    + '\n</urlset>\n';
}

exports.handler = async () => {
  let list = [], cacheFor = 3600;
  try { list = await weeks(); } catch (e) {
    // The pages still go out; the weeks come back on the next fetch
    console.error('[sitemap]', e.message);
    cacheFor = 60;
  }
  return {
    statusCode: 200,
    headers: {
      'Content-Type': 'application/xml; charset=utf-8',
      'Cache-Control': 'public, max-age=0, must-revalidate',
      'Netlify-CDN-Cache-Control': `public, durable, s-maxage=${cacheFor}, stale-while-revalidate=86400`,
    },
    body: sitemap(list),
  };
};

exports._internal = { PAGES, sitemap };
