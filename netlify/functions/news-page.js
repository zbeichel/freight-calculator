// netlify/functions/news-page.js
//
// Market News pages with the week's update already in them, so search engines read every
// week (netlify.toml routes these here):
//   /market-news              the latest published week (the main page)
//   /market-news/2026-11-09   that week's own page; 404 if it isn't published
//   /market-news/archive      every published week, by month (the others list the newest 8)
//   /market-news?week=…       an old link: 301 to the week's own page
// The page is market-news.html (bundled with this function: included_files in netlify.toml),
// filled in by news-render.js, the same code the page runs in the browser; the browser script
// then only loads drafts for the site owner. Only published updates are read here (with the
// site's public key, the database's rules hide drafts). Netlify's CDN keeps a page 10 minutes,
// tagged CACHE_TAG: publishing or taking back a week clears them all at once (news-purge.js).

const fs = require('fs');
const path = require('path');
const N = require('../../news-render.js');
const { CACHE_TAG } = require('../lib/news-cache.js');

const SUPABASE_URL = 'https://xgrmbhmgcsbnazupfybd.supabase.co';
const SUPABASE_KEY = 'sb_publishable_zSa4XpzakcntdkZfTzUPlg_FigYcISZ';   // the site's public key
const SITE = 'https://quickfreightcalc.com';
const IMAGE = SITE + '/icon-512.png';
const COLS = 'id,week_of,title,summary,glance,items,headlines,sources,status,published_at,updated_at';
const LIST_COLS = 'id,week_of,title,summary,status,published_at,updated_at';

// The page, read once. Where an included file lands in the function's bundle isn't documented,
// so look in each place it can be.
let shellHTML = null;
function shell() {
  if (shellHTML) return shellHTML;
  const places = [
    path.join(__dirname, 'market-news.html'),
    path.join(__dirname, '..', '..', 'market-news.html'),
    path.join(process.cwd(), 'market-news.html'),
    path.join(process.env.LAMBDA_TASK_ROOT || '/var/task', 'market-news.html'),
  ];
  for (const f of places) {
    try { shellHTML = fs.readFileSync(f, 'utf8'); return shellHTML; } catch (e) { /* next place */ }
  }
  throw new Error('market-news.html isn’t bundled with the function (netlify.toml included_files)');
}

async function rows(query) {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/market_updates?${query}`, {
    headers: { apikey: SUPABASE_KEY, Accept: 'application/json' },
    signal: AbortSignal.timeout(8000),
  });
  if (!r.ok) throw new Error(`market_updates answered ${r.status}`);
  const data = await r.json();
  return Array.isArray(data) ? data : [];
}

// What's after /market-news: '' (the main page), a week, or anything else (not a page)
function wantedPath(event) {
  const paths = [event.path];
  try { if (event.rawUrl) paths.push(new URL(event.rawUrl).pathname); } catch (e) { /* no rawUrl */ }
  for (const p of paths) {
    const m = String(p || '').match(/^\/(?:market-news|\.netlify\/functions\/news-page)(?:\/(.*?))?\/?$/);
    if (m) return decodeURIComponent(m[1] || '');
  }
  return '';
}

// Safe inside <script>: nothing that could close the tag or start markup
const scriptJSON = (x) => JSON.stringify(x).replace(/</g, '\\u003c').replace(/>/g, '\\u003e').replace(/&/g, '\\u0026')
  .replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');

function swap(html, from, to) {
  if (!html.includes(from)) throw new Error(`market-news.html changed: no ${from.slice(0, 60)}`);
  return html.replace(from, () => to);
}
function swapRe(html, re, to) {
  if (!re.test(html)) throw new Error(`market-news.html changed: no ${re}`);
  return html.replace(re, () => to);
}

const iso = (t) => (t ? new Date(t).toISOString() : undefined);

// The page for `u` (null: no update to show) among the published weeks
function page({ u, own, list }) {
  const url = own ? SITE + N.weekUrl(own) : SITE + '/market-news';
  const found = !!u;
  let html = shell();
  const head = [];
  if (own && found) {
    const title = `${u.title} | QuickFreightCalc`;
    const description = N.clip(u.summary || u.title, 158);
    html = swapRe(html, /<title>[^<]*<\/title>/, `<title>${N.esc(title)}</title>`);
    html = swapRe(html, /<meta name="description" content="[^"]*">/, `<meta name="description" content="${N.esc(description)}">`);
    head.push(
      `<meta property="og:type" content="article">`,
      `<meta property="og:title" content="${N.esc(u.title)}">`,
      `<meta property="og:description" content="${N.esc(description)}">`,
      u.published_at ? `<meta property="article:published_time" content="${N.esc(iso(u.published_at))}">` : '',
      `<script type="application/ld+json">${scriptJSON({
        '@context': 'https://schema.org',
        '@type': 'NewsArticle',
        headline: N.plain(u.title).slice(0, 110),
        description,
        url,
        mainEntityOfPage: url,
        datePublished: iso(u.published_at || u.week_of),
        dateModified: iso(u.updated_at || u.published_at || u.week_of),
        image: [IMAGE],
        author: { '@type': 'Organization', name: 'QuickFreightCalc', url: SITE },
        publisher: { '@type': 'Organization', name: 'QuickFreightCalc', url: SITE, logo: { '@type': 'ImageObject', url: IMAGE } },
      })}</script>`);
  } else if (own) {
    html = swapRe(html, /<title>[^<]*<\/title>/, '<title>That week’s update isn’t here | QuickFreightCalc</title>');
    head.push('<meta name="robots" content="noindex">');
  } else {
    head.push(`<meta property="og:type" content="website">`,
      `<script type="application/ld+json">${scriptJSON({
        '@context': 'https://schema.org',
        '@type': 'CollectionPage',
        name: 'Freight Market News',
        url,
        hasPart: list.slice(0, 20).map((x) => ({ '@type': 'NewsArticle', headline: N.plain(x.title).slice(0, 110), url: SITE + N.weekUrl(x.week_of), datePublished: iso(x.published_at || x.week_of) })),
      })}</script>`);
  }
  if (!own || found) {
    head.push(`<meta property="og:site_name" content="QuickFreightCalc">`, `<meta property="og:url" content="${N.esc(url)}">`, `<meta property="og:image" content="${IMAGE}">`);
    if (!own) head.push(`<meta property="og:title" content="Freight Market News | QuickFreightCalc">`);
  }
  html = swap(html, '<link rel="canonical" href="https://quickfreightcalc.com/market-news">', `<link rel="canonical" href="${N.esc(url)}">`);
  html = swap(html, '<!--news:head-->', head.filter(Boolean).join('\n'));
  html = swap(html, '<h1 id="news-h1">This week in <em>freight</em></h1>', `<h1 id="news-h1">${N.heading(u, !!own)}</h1>`);
  html = swap(html, '<main class="news" id="news-main">', '<main class="news" id="news-main" data-ssr="1">');
  html = swap(html, '<p class="news-status" id="news-status">', '<p class="news-status" id="news-status" hidden>');
  if (found) {
    html = swap(html, '<article class="card news-post" id="news-post" hidden></article>',
      `<article class="card news-post" id="news-post">${N.postHTML(u, { permalink: !own, notice: N.oldNotice(u, list[0]) })}</article>`);
    const pager = N.pagerHTML(N.neighbors(list, u));
    if (pager) html = swap(html, '<nav class="news-pager" id="news-pager" aria-label="Other weeks" hidden></nav>', `<nav class="news-pager" id="news-pager" aria-label="Other weeks">${pager}</nav>`);
  } else {
    html = swap(html, '<div class="card" id="news-empty" hidden>', '<div class="card" id="news-empty">');
    if (own && list.length) {
      html = swapRe(html, /<h3 id="news-empty-title">[^<]*<\/h3>/, '<h3 id="news-empty-title">That week’s update isn’t here</h3>');
      html = swapRe(html, /<p id="news-empty-text">[^<]*<\/p>/, '<p id="news-empty-text">It may not be out yet. Every published week is listed below.</p>');
      html = swapRe(html, /<a class="qf-btn qf-btn-primary" href="\/rates\.html"[^>]*>See market rates<\/a>/, '<a class="qf-btn qf-btn-primary" href="/market-news" style="margin-top:16px">See the latest update</a>');
    }
  }
  if (list.length >= (found ? 2 : 1)) {
    html = swap(html, '<section class="card" id="news-archive" hidden>', '<section class="card" id="news-archive">');
  }
  html = swap(html, '<span class="card-meta" id="news-count"></span>', `<span class="card-meta" id="news-count">${list.length === 1 ? '1 update' : list.length + ' updates'}</span>`);
  html = swap(html, '<div class="news-arch" id="news-arch"></div>', `<div class="news-arch" id="news-arch">${N.archiveHTML(N.recent(list), u)}</div>`);
  if (list.length > N.RECENT) html = swap(html, '<a class="news-all" id="news-all" href="/market-news/archive" hidden>', '<a class="news-all" id="news-all" href="/market-news/archive">');
  // What the page shows, for its script (so it doesn't load it again)
  html = swap(html, '<!--news:data-->', `<script type="application/json" id="news-data">${scriptJSON({ list, current: u })}</script>`);
  return html;
}

// The archive page: every published week, newest first, under a heading for each month
function archivePage(list) {
  const url = SITE + N.ARCHIVE_URL;
  const title = 'Freight Market News Archive: Every Weekly Update | QuickFreightCalc';
  const description = 'Every weekly freight market update, newest first: spot rates per mile for van, reefer and flatbed, diesel prices, and the trucking news that moved capacity.';
  let html = shell();
  html = swapRe(html, /<title>[^<]*<\/title>/, `<title>${N.esc(title)}</title>`);
  html = swapRe(html, /<meta name="description" content="[^"]*">/, `<meta name="description" content="${N.esc(description)}">`);
  html = swap(html, '<link rel="canonical" href="https://quickfreightcalc.com/market-news">', `<link rel="canonical" href="${url}">`);
  html = swap(html, '<!--news:head-->', [
    '<meta property="og:type" content="website">',
    '<meta property="og:site_name" content="QuickFreightCalc">',
    '<meta property="og:title" content="Freight Market News Archive | QuickFreightCalc">',
    `<meta property="og:description" content="${N.esc(description)}">`,
    `<meta property="og:url" content="${url}">`,
    `<meta property="og:image" content="${IMAGE}">`,
    `<script type="application/ld+json">${scriptJSON({
      '@context': 'https://schema.org',
      '@type': 'CollectionPage',
      name: 'Freight Market News Archive',
      url,
      hasPart: list.slice(0, 100).map((x) => ({ '@type': 'NewsArticle', headline: N.plain(x.title).slice(0, 110), url: SITE + N.weekUrl(x.week_of), datePublished: iso(x.published_at || x.week_of) })),
    })}</script>`,
  ].join('\n'));
  html = swap(html, '<h1 id="news-h1">This week in <em>freight</em></h1>', '<h1 id="news-h1">Market news <em>archive</em></h1>');
  html = swap(html, '<main class="news" id="news-main">', '<main class="news" id="news-main" data-ssr="1">');
  html = swap(html, '<p class="news-status" id="news-status">', '<p class="news-status" id="news-status" hidden>');
  if (list.length) {
    html = swap(html, '<section class="card" id="news-archive" hidden>', '<section class="card" id="news-archive">');
    html = swap(html, '<span class="card-title" id="news-arch-title">Weekly updates</span>', '<span class="card-title" id="news-arch-title">Every weekly update</span>');
  } else {
    html = swap(html, '<div class="card" id="news-empty" hidden>', '<div class="card" id="news-empty">');
  }
  html = swap(html, '<span class="card-meta" id="news-count"></span>', `<span class="card-meta" id="news-count">${list.length === 1 ? '1 update' : list.length + ' updates'}</span>`);
  html = swap(html, '<div class="news-arch" id="news-arch"></div>', `<div class="news-arch" id="news-arch">${N.archiveByMonth(list, null)}</div>`);
  html = swap(html, '<!--news:data-->', `<script type="application/json" id="news-data">${scriptJSON({ list, current: null })}</script>`);
  return html;
}

const HTML = { 'Content-Type': 'text/html; charset=utf-8' };
// Browsers check back each time; Netlify's CDN keeps the page (shorter for "not here"),
// until the owner publishes or takes back a week (news-purge.js clears the tag)
const cached = (seconds) => Object.assign({}, HTML, {
  'Cache-Control': 'public, max-age=0, must-revalidate',
  'Netlify-CDN-Cache-Control': `public, durable, s-maxage=${seconds}, stale-while-revalidate=86400`,
  'Netlify-Cache-Tag': CACHE_TAG,
});

exports.handler = async (event) => {
  const rest = wantedPath(event);
  const q = event.queryStringParameters || {};
  // An old link (market-news.html?week=…): the week's own page
  if (!rest && N.isWeek(q.week)) {
    return { statusCode: 301, headers: { Location: N.weekUrl(q.week), 'Cache-Control': 'public, max-age=3600' }, body: '' };
  }
  const archive = rest === 'archive';
  const own = rest && !archive ? (N.isWeek(rest) ? rest : 'missing') : null;
  let list, u;
  try {
    const [all, one] = await Promise.all([
      rows(`select=${LIST_COLS}&status=eq.published&order=week_of.desc&limit=1000`),
      own === 'missing' || archive ? Promise.resolve([])
        : rows(`select=${COLS}&status=eq.published&${own ? `week_of=eq.${own}` : 'order=week_of.desc'}&limit=1`),
    ]);
    list = all;
    u = one[0] || null;
  } catch (e) {
    // The database didn't answer: the plain page, whose script tries again in the browser
    console.error('[news-page]', e.message);
    let body;
    try { body = shell(); } catch (e2) { body = '<!DOCTYPE html><title>Market News</title><p>The market update couldn’t load right now. Refresh the page to try again.</p>'; }
    return { statusCode: 503, headers: Object.assign({}, HTML, { 'Cache-Control': 'no-store', 'Retry-After': '300' }), body };
  }
  try {
    if (archive) return { statusCode: 200, headers: cached(600), body: archivePage(list) };
    const body = page({ u, own: own === 'missing' ? rest : own, list });
    return { statusCode: own && !u ? 404 : 200, headers: cached(own && !u ? 60 : 600), body };
  } catch (e) {
    console.error('[news-page]', e.message);
    return { statusCode: 500, headers: Object.assign({}, HTML, { 'Cache-Control': 'no-store' }), body: '<!DOCTYPE html><title>Market News</title><p>Something went wrong showing this page. Try again in a minute.</p>' };
  }
};

exports._internal = { wantedPath, page, archivePage, scriptJSON, shell };
