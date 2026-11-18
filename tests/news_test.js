// tests/news_test.js — the Market News page (market-news.html): the weekly update in full,
// past weeks, links and text from the weekly task handled safely, the owner's drafts with
// Publish and Unpublish, the empty and error states, and the teaser on the Market Rates page.
// Each week's own page (/market-news/2026-11-09) comes from netlify/functions/news-page.js with
// the update already in it (what search engines read), and /sitemap.xml lists every week; the
// server here routes those addresses to the functions the way netlify.toml does.
// In a real browser (needs Playwright with Chromium); the database is a stub that answers the
// way its access rules do (published updates for everyone, drafts only for the site owner).
// Run from the repository root:
//   node tests/news_test.js [folder for screenshots]
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { chromium } = require('playwright');
const ROOT = path.resolve(__dirname, '..');
const SHOTS = process.argv[2] || fs.mkdtempSync(path.join(os.tmpdir(), 'qfc-news-'));
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.json': 'application/json', '.css': 'text/css', '.svg': 'image/svg+xml' };
let failures = 0;
const check = (label, cond, detail) => { console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}${detail && !cond ? '  — ' + detail : ''}`); if (!cond) failures++; };

// The functions' side of the database: what the public key may read (published updates only)
// and who the site owner is; and Netlify's cache purge API (news-purge.js), which records each
// call and answers PURGE.status (a number, or a list used up one call at a time)
const SERVER = { rows: [], fail: false, reads: 0, adminDown: false };
const PURGE = { calls: [], status: 200 };
process.env.SITE_ID = 'site-123';
const realFetch = global.fetch;
global.fetch = async (url, opts = {}) => {
  const u = new URL(String(url));
  if (u.hostname === 'api.netlify.com' && u.pathname === '/api/v1/purge') {
    PURGE.calls.push({ method: opts.method, auth: (opts.headers || {}).Authorization, body: JSON.parse(opts.body || '{}') });
    const status = Array.isArray(PURGE.status) ? (PURGE.status.length ? PURGE.status.shift() : 200) : PURGE.status;
    return new Response(status < 300 ? '' : JSON.stringify({ message: 'no' }), { status });
  }
  if (u.hostname === 'xgrmbhmgcsbnazupfybd.supabase.co' && u.pathname === '/rest/v1/rpc/is_site_admin') {
    if (SERVER.adminDown) throw new TypeError('fetch failed');
    const auth = (opts.headers || {}).Authorization;
    return new Response(JSON.stringify(auth === 'Bearer owner-token'), { status: 200, headers: { 'Content-Type': 'application/json' } });
  }
  if (u.hostname !== 'xgrmbhmgcsbnazupfybd.supabase.co' || !u.pathname.endsWith('/market_updates')) return realFetch(url, opts);
  SERVER.reads++;
  if (SERVER.fail) return new Response(JSON.stringify({ message: 'boom' }), { status: 500 });
  const q = u.searchParams;
  let list = SERVER.rows.filter((r) => r.status === 'published');
  if (q.get('week_of')) list = list.filter((r) => 'eq.' + r.week_of === q.get('week_of'));
  list = list.slice().sort((a, b) => b.week_of.localeCompare(a.week_of));
  if (q.get('limit')) list = list.slice(0, Number(q.get('limit')));
  return new Response(JSON.stringify(list), { status: 200, headers: { 'Content-Type': 'application/json' } });
};
const newsPage = require(path.join(ROOT, 'netlify/functions/news-page.js'));
const sitemapFn = require(path.join(ROOT, 'netlify/functions/sitemap.js'));
const newsPurge = require(path.join(ROOT, 'netlify/functions/news-purge.js'));
// Netlify hands its functions a purge token with each call
const NETLIFY_CONTEXT = { clientContext: { custom: { purge_api_token: 'netlify-purge-token' } } };

function serve() {
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://x');
    const p = decodeURIComponent(url.pathname);
    // As netlify.toml routes them
    const fn = p === '/sitemap.xml' ? sitemapFn : /^\/market-news(\/|$)/.test(p) ? newsPage : p === '/.netlify/functions/news-purge' ? newsPurge : null;
    if (fn) {
      const r = await fn.handler({ path: p, httpMethod: req.method, headers: req.headers, rawUrl: 'https://quickfreightcalc.com' + req.url,
        queryStringParameters: Object.fromEntries(url.searchParams) }, NETLIFY_CONTEXT);
      res.writeHead(r.statusCode, r.headers);
      res.end(r.body);
      return;
    }
    const file = path.join(ROOT, p === '/' ? 'index.html' : p);
    if (!file.startsWith(ROOT) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404); res.end(); return; }
    res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream' });
    fs.createReadStream(file).pipe(res);
  });
  return new Promise((r) => server.listen(0, '127.0.0.1', () => r(server)));
}

const OWNER = { id: 'owner-1', email: 'owner@example.com', token: 'owner-token' };
const USER = { id: 'user-2', email: 'sam@example.com', token: 'user-token' };
const WEEK = {
  id: 'w-1109', week_of: '2026-11-09', status: 'published', published_at: '2026-11-10T13:00:00Z',
  title: 'Spot rates hold, diesel slips, and an ELD crackdown',
  summary: 'Van and reefer spot rates held steady, diesel fell for a second week, and FMCSA pulled 133 logging devices.',
  glance: [
    { measure: 'Van spot ($/mi)', now: '$2.12', week: '+0.5%', year: '+14%' },
    { measure: 'Reefer spot ($/mi)', now: '$2.48', week: '-0.4%', year: '+11%' },
    { measure: 'Diesel, U.S. average', now: '$3.85', week: '-$0.10', year: '' },
  ],
  items: [
    { topic: 'Rates', headline: 'Rates: Spot holds steady ahead of the holidays', bullets: ['Van spot linehaul at **$2.12/mi**, up 0.5% on the week', 'Reefer at **$2.48/mi** <script>window.__x=1</script>'],
      takeaway: 'Expect tighter reefer capacity the week of Thanksgiving.' },
    { topic: 'Diesel', headline: 'Diesel: Down a dime', bullets: ['U.S. average **$3.85**'], takeaway: 'Fuel surcharges drift lower.' },
    { topic: 'News', headline: 'Capacity: FMCSA pulls 133 ELDs', bullets: ['The largest revocation yet'], takeaway: 'Some cheap capacity leaves the market.' },
  ],
  headlines: [
    { title: 'Port of Los Angeles tops a million units again', summary: 'Imports up **25%** on the year.', url: 'https://portoflosangeles.org/news', source: 'Port of Los Angeles', date: '2026-11-12' },
    { title: 'A link that is not a web page', url: 'javascript:alert(1)', source: 'Nowhere', date: '2026-11-12' },
  ],
  sources: [
    { item: 'Rates', publisher: 'DAT', title: 'Weekly trendlines', url: 'https://www.dat.com/trendlines', date: '2026-11-10' },
    { item: 'Rates', publisher: 'FreightWaves', title: 'SONAR update', url: 'https://www.freightwaves.com/x', date: '2026-11-11' },
    { item: 'Diesel', publisher: 'EIA', title: 'Gasoline and Diesel Fuel Update', url: 'https://www.eia.gov/petroleum/gasdiesel/', date: '2026-11-10' },
  ],
};
const OLDER = { id: 'w-1102', week_of: '2026-11-02', status: 'published', published_at: '2026-11-03T13:00:00Z', title: 'Reefer tightens in the Midwest', summary: 'Older week.', glance: [], items: [{ headline: 'Rates: Older', bullets: ['x'], takeaway: 'y' }], headlines: [], sources: [] };
// Eight more published weeks, back to Sep 7: ten in all, more than the eight listed beside an update
const MORE = ['2026-10-26', '2026-10-19', '2026-10-12', '2026-10-05', '2026-09-28', '2026-09-21', '2026-09-14', '2026-09-07'].map((w, i) => ({
  id: 'w-' + w, week_of: w, status: 'published', published_at: w + 'T13:00:00Z', title: 'Week of ' + w + ': rates and diesel', summary: 'Summary ' + (i + 1) + '.',
  glance: [], items: [{ headline: 'Rates: ' + w, bullets: ['b'], takeaway: 't' }], headlines: [], sources: [] }));
const DRAFT = { id: 'w-1116', week_of: '2026-11-16', status: 'draft', published_at: null, title: 'Draft: rates firm before Thanksgiving', summary: 'Not public yet.', glance: [], items: [{ headline: 'Rates: Firming', bullets: ['a'], takeaway: 'b' }], headlines: [], sources: [] };

async function setup(browser, base, { who = null, rows = [WEEK, OLDER, DRAFT], fail = false, width = 1280, phone = false } = {}) {
  const context = await browser.newContext(phone || width < 500
    ? { viewport: { width, height: 844 }, isMobile: true, hasTouch: true }
    : { viewport: { width, height: 900 } });
  const db = { rows: rows.map((r) => ({ ...r })), patches: [], dialogs: [], reads: 0 };
  SERVER.rows = db.rows;
  SERVER.fail = fail;
  await context.addInitScript((u) => {
    if (localStorage.getItem('__seeded')) return;
    localStorage.setItem('__seeded', '1');
    if (u) localStorage.setItem('sb-xgrmbhmgcsbnazupfybd-auth-token', JSON.stringify({ access_token: u.token, refresh_token: 'r',
      expires_at: Math.floor(Date.now() / 1000) + 3600, user: { id: u.id, email: u.email } }));
  }, who);
  await context.route('**/*', async (route) => {
    const req = route.request(), url = req.url();
    const json = (b, s) => route.fulfill({ status: s || 200, contentType: 'application/json', body: JSON.stringify(b) });
    // The site's own files and pages, and news-purge (the real function, on the test server)
    if (url.startsWith(base) && (!url.includes('/.netlify/') || url.includes('/.netlify/functions/news-purge'))) return route.continue();
    const auth = req.headers()['authorization'] || '';
    const isOwner = auth === 'Bearer ' + OWNER.token;
    if (url.includes('/rest/v1/rpc/is_site_admin')) return json(isOwner);
    if (url.includes('/rest/v1/market_updates')) {
      if (req.method() === 'GET') db.reads++;
      if (fail) return json({ message: 'boom' }, 500);
      if (req.method() === 'PATCH') {
        const id = decodeURIComponent(url.match(/id=eq\.([^&]+)/)[1]);
        const body = JSON.parse(req.postData() || '{}');
        db.patches.push({ id, body, auth });
        if (!isOwner) return json([]);
        const row = db.rows.find((r) => r.id === id);
        if (!row) return json([]);
        Object.assign(row, body, { published_at: body.status === 'published' ? '2026-11-17T12:00:00Z' : null });
        return json([row]);
      }
      let list = db.rows.filter((r) => isOwner || r.status === 'published');
      if (url.includes('status=eq.published')) list = list.filter((r) => r.status === 'published');
      list = list.slice().sort((a, b) => b.week_of.localeCompare(a.week_of));
      if (/limit=1(&|$)/.test(url)) list = list.slice(0, 1);
      return json(list);
    }
    if (url.includes('/.netlify/functions/diesel-price')) return json({ price: 3.851, previous: 3.951, period: '2026-11-09' });
    if (url.includes('/.netlify/functions/')) return json({});
    if (url.includes('supabase.co')) return json([]);
    if (url.includes('fonts.googleapis.com') || url.includes('fonts.gstatic.com')) return route.continue();
    return route.abort();
  });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('dialog', async (d) => { db.dialogs.push(d.message()); await d.accept(); });
  return { context, page, errors, db };
}
const text = (pg, sel) => pg.$eval(sel, (e) => e.innerText.replace(/\s+/g, ' ').trim()).catch(() => '');
const ready = (t) => t.page.waitForFunction(() => document.getElementById('news-status').hidden);
// The owner's view comes from the page's script (drafts load after the server's copy is shown)
const ownerView = (t) => t.page.waitForSelector('.news-draft', { timeout: 60000 });
// What a search engine gets: the page as sent, without running its script
const get = (url) => new Promise((resolve, reject) => http.get(url, (r) => { let b = ''; r.on('data', (c) => { b += c; }); r.on('end', () => resolve({ status: r.statusCode, headers: r.headers, body: b })); }).on('error', reject));
const between = (html, re) => ((html.match(re) || [])[1] || '');

(async () => {
  const server = await serve();
  const base = `http://127.0.0.1:${server.address().port}`;
  const browser = await chromium.launch();
  let t;

  console.log('\n=== A visitor ===');
  t = await setup(browser, base);
  await t.page.goto(base + '/market-news');
  await ready(t);
  check('the latest published week, in full', (await text(t.page, '.news-week')) === 'WEEK OF NOVEMBER 9, 2026'
    && (await text(t.page, '.news-title')) === WEEK.title && (await text(t.page, '.news-summary')).startsWith('Van and reefer spot rates held'), await text(t.page, '.news-week'));
  const glance = await t.page.$$eval('.news-glance tbody tr', (trs) => trs.map((tr) => tr.innerText.replace(/\s+/g, ' ').trim()));
  check('this week at a glance: measure, now, vs last week, vs last year (n/a when missing)', glance.length === 3
    && glance[0] === 'Van spot ($/mi) $2.12 +0.5% +14%' && glance[2] === 'Diesel, U.S. average $3.85 -$0.10 n/a', JSON.stringify(glance));
  const items = await t.page.$$eval('.news-item', (els) => els.map((e) => ({ h: e.querySelector('h3').innerText, n: e.querySelectorAll('li').length,
    means: (e.querySelector('.news-means') || {}).innerText || '' })));
  check('three items titled by their headlines (no numbers), each with its bullets and "What it means for your rates"', items.length === 3 && items[0].h === 'Rates: Spot holds steady ahead of the holidays'
    && items[2].h === 'Capacity: FMCSA pulls 133 ELDs' && items[0].n === 2 && items.every((i) => i.means.startsWith('What it means for your rates:')), JSON.stringify(items));
  const bold = await t.page.$eval('.news-item', (e) => [...e.querySelectorAll('li strong')].map((x) => x.textContent));
  check('**bold** in the task\'s text shows as bold', JSON.stringify(bold) === JSON.stringify(['$2.12/mi', '$2.48/mi']), JSON.stringify(bold));
  check('…and anything else that looks like HTML stays text', (await t.page.$eval('.news-item', (e) => e.querySelectorAll('li')[1].textContent)).includes('<script>window.__x=1</script>')
    && await t.page.evaluate(() => window.__x === undefined && !document.querySelector('.news-post script')));
  const heads = await t.page.$$eval('.news-heads li', (lis) => lis.map((li) => { const a = li.querySelector('a'); return { a: a ? [a.getAttribute('href'), a.target, a.rel] : null, t: li.innerText.replace(/\s+/g, ' ').trim() }; }));
  check('more freight news: the headline links to its story, with the source and date', heads.length === 2 && heads[0].a[0] === 'https://portoflosangeles.org/news'
    && heads[0].a[1] === '_blank' && heads[0].a[2] === 'noopener noreferrer nofollow' && heads[0].t.includes('Port of Los Angeles · Nov 12'), JSON.stringify(heads));
  check('…a link that isn\'t a web address is left as plain text', heads[1].a === null && heads[1].t.startsWith('A link that is not a web page'), JSON.stringify(heads[1]));
  check('sources, grouped by item', (await text(t.page, '.news-sources')).includes('Rates: DAT, Weekly trendlines (Nov 10, 2026); FreightWaves, SONAR update (Nov 11, 2026)')
    && (await text(t.page, '.news-sources')).includes('Diesel: EIA'), await text(t.page, '.news-sources'));
  const arch = await t.page.$$eval('#news-arch a', (as) => as.map((a) => [a.getAttribute('href'), a.classList.contains('on'), a.innerText.includes('Draft')]));
  check('past weeks listed, newest first, each linking to its own page; no drafts', JSON.stringify(arch) === JSON.stringify([['/market-news/2026-11-09', true, false], ['/market-news/2026-11-02', false, false]]), JSON.stringify(arch));
  check('no owner controls', !(await t.page.$('[data-act]')) && !(await t.page.$('.news-draft')));
  check('the main page keeps its own title (each week has its own page)', (await t.page.title()) === 'Freight Market News — Weekly Rates, Diesel & Trucking Updates | QuickFreightCalc', await t.page.title());
  check('…“Week of November 9, 2026” links to that week’s page, and “Previous week” to the one before', (await t.page.getAttribute('.news-week a', 'href')) === '/market-news/2026-11-09'
    && (await t.page.getAttribute('#news-pager .news-older', 'href')) === '/market-news/2026-11-02' && !(await t.page.$('#news-pager .news-newer')));
  check('the navigation marks Market News', (await text(t.page, '#qf-nav .qf-links a.active')) === 'Market News');
  check('the update came with the page: the browser didn’t load it again', t.db.reads === 0, `${t.db.reads} reads`);
  await t.page.screenshot({ path: path.join(SHOTS, 'news.png'), fullPage: true });
  await t.page.goto(base + '/market-news/2026-11-02');
  await ready(t);
  check('a past week on its own page: that week, its date as the heading, its title on the tab', (await text(t.page, '.news-title')) === OLDER.title
    && (await text(t.page, '#news-h1')) === 'Freight news, week of Nov 2, 2026' && (await t.page.title()) === OLDER.title + ' | QuickFreightCalc', await text(t.page, '#news-h1'));
  check('…“Next week” leads to the newer week; the list marks this one', (await t.page.getAttribute('#news-pager .news-newer', 'href')) === '/market-news/2026-11-09'
    && !(await t.page.$('#news-pager .news-older')) && (await t.page.getAttribute('#news-arch a.on', 'href')) === '/market-news/2026-11-02');
  check('…and the navigation still marks Market News', (await text(t.page, '#qf-nav .qf-links a.active')) === 'Market News');
  await t.page.screenshot({ path: path.join(SHOTS, 'news_week.png'), fullPage: true });
  const draftPage = await t.page.goto(base + '/market-news/2026-11-16');
  await ready(t);
  check('a draft’s page shows a visitor nothing of it (404), and points to the published weeks', draftPage.status() === 404 && !(await t.page.isVisible('#news-post')) && (await text(t.page, '#news-empty h3')) === 'That week’s update isn’t here'
    && await t.page.isVisible('#news-archive') && (await t.page.$$('#news-arch a')).length === 2 && (await t.page.getAttribute('#news-empty a', 'href')) === '/market-news', String(draftPage.status()));
  check('no page errors', t.errors.length === 0, t.errors.join(' | '));
  await t.context.close();

  console.log('\n=== What search engines get (the page as sent, no script run) ===');
  t = await setup(browser, base);   // the database as above
  let r = await get(base + '/market-news');
  check('the main page: 200, with this week’s update in it (not “Loading…”)', r.status === 200 && r.body.includes(WEEK.title) && r.body.includes('Expect tighter reefer capacity the week of Thanksgiving.')
    && /<p class="news-status" id="news-status" hidden>/.test(r.body) && /<article class="card news-post" id="news-post">/.test(r.body), String(r.status));
  check('…links to every published week’s page, and not to the draft', r.body.includes('href="/market-news/2026-11-09"') && r.body.includes('href="/market-news/2026-11-02"')
    && !r.body.includes(DRAFT.title) && !r.body.includes('2026-11-16'));
  check('…its address as canonical; Netlify’s CDN keeps it a while', between(r.body, /<link rel="canonical" href="([^"]+)"/) === 'https://quickfreightcalc.com/market-news'
    && /s-maxage=600/.test(r.headers['netlify-cdn-cache-control'] || ''), r.headers['netlify-cdn-cache-control']);
  r = await get(base + '/market-news/2026-11-02');
  const ld = JSON.parse(between(r.body, /<script type="application\/ld\+json">([\s\S]*?)<\/script>/) || '{}');
  check('a week’s own page: 200, its own title, description, canonical address and heading', r.status === 200 && between(r.body, /<title>([^<]*)<\/title>/) === OLDER.title + ' | QuickFreightCalc'
    && between(r.body, /<meta name="description" content="([^"]*)">/) === 'Older week.' && between(r.body, /<link rel="canonical" href="([^"]+)"/) === 'https://quickfreightcalc.com/market-news/2026-11-02'
    && /<h1 id="news-h1">Freight news, <em>week of Nov 2, 2026<\/em><\/h1>/.test(r.body), between(r.body, /<title>([^<]*)<\/title>/));
  check('…marked up as a news article (headline, date, publisher) for search results', ld['@type'] === 'NewsArticle' && ld.headline === OLDER.title && ld.datePublished === '2026-11-03T13:00:00.000Z'
    && ld.url === 'https://quickfreightcalc.com/market-news/2026-11-02' && ld.publisher && ld.publisher.name === 'QuickFreightCalc', JSON.stringify(ld));
  check('…and for link previews (title, description, address)', between(r.body, /<meta property="og:title" content="([^"]*)">/) === OLDER.title && between(r.body, /<meta property="og:url" content="([^"]*)">/) === 'https://quickfreightcalc.com/market-news/2026-11-02');
  r = await get(base + '/market-news/2026-11-09');
  const sent = JSON.parse(between(r.body, /<script type="application\/json" id="news-data">([\s\S]*?)<\/script>/) || 'null');
  check('text from the weekly task can’t become markup on the server either (escaped in the page and in its data)', r.body.includes('&lt;script&gt;window.__x=1&lt;/script&gt;')
    && !r.body.includes('<script>window.__x') && sent && sent.current && sent.current.items[0].bullets[1].includes('<script>window.__x=1</script>'), r.body.match(/window\.__x[^<]{0,40}/));
  check('…a headline link that isn’t a web address stays text (no link to it anywhere)', !/href="javascript:/i.test(r.body) && r.body.includes('<li>A link that is not a web page<span class="src">'));
  r = await get(base + '/market-news/2026-11-16');
  check('a draft’s or missing week’s page: 404, kept out of search results, no draft content', r.status === 404 && r.body.includes('<meta name="robots" content="noindex">') && !r.body.includes(DRAFT.title) && !r.body.includes('Not public yet'));
  r = await get(base + '/market-news/not-a-week');
  check('…the same for an address that isn’t a week', r.status === 404 && r.body.includes('noindex'));
  r = await get(base + '/market-news?week=2026-11-02');
  check('an old link (?week=) moves permanently to the week’s own page', r.status === 301 && r.headers.location === '/market-news/2026-11-02', `${r.status} ${r.headers.location}`);
  await t.context.close();

  console.log('\n=== Signed in, not the owner ===');
  t = await setup(browser, base, { who: USER });
  await t.page.goto(base + '/market-news');
  await ready(t);
  check('the same published weeks, no drafts, no controls', (await text(t.page, '.news-title')) === WEEK.title && (await t.page.$$('#news-arch a')).length === 2 && !(await t.page.$('[data-act]')));
  await t.context.close();

  console.log('\n=== The site owner ===');
  t = await setup(browser, base, { who: OWNER });
  await t.page.goto(base + '/market-news');
  await ownerView(t);
  check('the newest week first, even as a draft, marked as one with Publish', (await text(t.page, '.news-title')) === DRAFT.title
    && (await text(t.page, '.news-draft')).startsWith('Draft. Only you can see this until you publish it.') && await t.page.isVisible('button[data-act="publish"]'));
  check('drafts show in the list, tagged', (await t.page.$$eval('#news-arch a', (as) => as.map((a) => !!a.querySelector('.tag')))).join() === 'true,false,false');
  PURGE.calls = [];
  PURGE.status = 200;
  const cacheNote = (re) => t.page.waitForFunction((src) => new RegExp(src).test((document.querySelector('#news-post .news-cache') || {}).textContent || ''), re.source, { timeout: 15000 });
  await t.page.click('button[data-act="publish"]');
  await t.page.waitForSelector('.news-draft.live');
  check('Publish: saved with the owner\'s sign-in, then shown as published', t.db.patches.length === 1 && t.db.patches[0].id === DRAFT.id
    && t.db.patches[0].body.status === 'published' && t.db.patches[0].auth === 'Bearer ' + OWNER.token
    && (await text(t.page, '.news-draft')).startsWith('Published Nov 17. Everyone can see this.') && await t.page.isVisible('button[data-act="unpublish"]'), JSON.stringify(t.db.patches));
  await cacheNote(/^Visitors see it now\.$/);
  check('…then the site’s cached pages are cleared (news-purge, with the owner’s sign-in): the "market-news" tag for this site, with Netlify’s token',
    PURGE.calls.length === 1 && PURGE.calls[0].method === 'POST' && PURGE.calls[0].auth === 'Bearer netlify-purge-token'
    && JSON.stringify(PURGE.calls[0].body) === JSON.stringify({ site_id: 'site-123', cache_tags: ['market-news'] }), JSON.stringify(PURGE.calls));
  check('…and the owner is told visitors see it now', (await text(t.page, '#news-post .news-cache')) === 'Visitors see it now.');
  check('…and no longer tagged as a draft in the list', !(await t.page.$('#news-arch a .tag')));
  await t.page.screenshot({ path: path.join(SHOTS, 'news_owner_published.png') });
  await t.page.click('button[data-act="unpublish"]');
  await t.page.waitForSelector('.news-draft:not(.live)');
  check('Unpublish asks first, then puts it back to a draft', /Take this update off the site\?/.test(t.db.dialogs.join('|')) && t.db.patches[1].body.status === 'draft');
  await cacheNote(/^It’s off the site for visitors now\.$/);
  check('…clears the cached pages again, and says it’s off the site now', PURGE.calls.length === 2 && (await text(t.page, '#news-post .news-cache')) === 'It’s off the site for visitors now.');
  PURGE.status = 500;
  await t.page.click('button[data-act="publish"]');
  await cacheNote(/within 10 minutes/);
  check('when Netlify doesn’t clear them: still published, and the owner is told visitors see it within 10 minutes',
    t.db.patches[2].body.status === 'published' && await t.page.isVisible('.news-draft.live') && (await text(t.page, '#news-post .news-cache')) === 'Visitors see it within 10 minutes.');
  PURGE.status = 200;
  await t.page.click('button[data-act="unpublish"]');
  await t.page.waitForSelector('.news-draft:not(.live)');
  await cacheNote(/^It’s off the site for visitors now\.$/);
  await t.page.screenshot({ path: path.join(SHOTS, 'news_owner.png'), fullPage: true });
  await t.page.goto(base + '/market-news/2026-11-16');
  await ownerView(t);
  check('the draft’s own page: the owner sees the draft there, with Publish (visitors get “isn’t here”)', (await text(t.page, '.news-title')) === DRAFT.title
    && await t.page.isVisible('button[data-act="publish"]') && await t.page.isHidden('#news-empty'));
  check('no page errors', t.errors.length === 0, t.errors.join(' | '));
  await t.context.close();

  console.log('\n=== Nothing yet, and errors ===');
  t = await setup(browser, base, { rows: [] });
  await t.page.goto(base + '/market-news');
  await ready(t);
  check('no updates yet: says so and points to the market rates', await t.page.isVisible('#news-empty') && (await text(t.page, '#news-empty h3')) === 'The first weekly update is on its way'
    && (await t.page.getAttribute('#news-empty a', 'href')) === '/rates.html' && await t.page.isHidden('#news-archive'));
  await t.context.close();
  t = await setup(browser, base, { fail: true });
  const down = await t.page.goto(base + '/market-news');
  await t.page.waitForFunction(() => /couldn’t load/.test(document.getElementById('news-status').textContent));
  check('the database down: 503 (search engines come back later), and a message, not a blank page', down.status() === 503 && await t.page.isVisible('#news-status') && t.errors.length === 0, String(down.status()));
  await t.context.close();

  console.log('\n=== Without the server (the page on its own, as a fallback) ===');
  t = await setup(browser, base);
  await t.page.goto(base + '/market-news.html');
  await ready(t);
  check('the page loads the latest week itself, linking weeks to their own pages', (await text(t.page, '.news-title')) === WEEK.title && t.db.reads >= 1
    && (await t.page.$$eval('#news-arch a', (as) => as.map((a) => a.getAttribute('href')))).join() === '/market-news/2026-11-09,/market-news/2026-11-02');
  await t.page.goto(base + '/market-news.html?week=2026-11-02');
  await ready(t);
  check('…and an old ?week= link still shows that week', (await text(t.page, '.news-title')) === OLDER.title);
  await t.context.close();

  console.log('\n=== Sitemap and robots.txt ===');
  t = await setup(browser, base);
  r = await get(base + '/sitemap.xml');
  const locs = [...r.body.matchAll(/<loc>([^<]+)<\/loc>(?:<lastmod>([^<]+)<\/lastmod>)?/g)].map((m) => [m[1], m[2] || '']);
  check('sitemap.xml: the public pages, the archive, then every published week with its date (not the draft)', r.status === 200 && /application\/xml/.test(r.headers['content-type'])
    && locs.some(([l]) => l === 'https://quickfreightcalc.com/') && locs.some(([l]) => l === 'https://quickfreightcalc.com/rates')
    && locs.some(([l, d]) => l === 'https://quickfreightcalc.com/market-news/archive' && d === '2026-11-10')
    && JSON.stringify(locs.filter(([l]) => /market-news\/\d/.test(l))) === JSON.stringify([['https://quickfreightcalc.com/market-news/2026-11-09', '2026-11-10'], ['https://quickfreightcalc.com/market-news/2026-11-02', '2026-11-03']])
    && !r.body.includes('2026-11-16') && !/profile|customers|404/.test(r.body), JSON.stringify(locs));
  const pageIssues = sitemapFn._internal.PAGES.filter((pg) => {
    const html = fs.readFileSync(path.join(ROOT, pg.file), 'utf8');
    const canon = between(html, /<link rel="canonical" href="([^"]+)"/).replace(/\/$/, '');
    return canon !== ('https://quickfreightcalc.com' + pg.path).replace(/\/$/, '');
  }).map((pg) => pg.file);
  check('…each page it lists names that same address as its canonical one', pageIssues.length === 0, pageIssues.join(', '));
  const robots = fs.readFileSync(path.join(ROOT, 'robots.txt'), 'utf8');
  check('robots.txt lets search engines in and points them to the sitemap', /User-agent: \*\nAllow: \//.test(robots) && /Sitemap: https:\/\/quickfreightcalc\.com\/sitemap\.xml/.test(robots) && !/Disallow: \S/.test(robots));
  const toml = fs.readFileSync(path.join(ROOT, 'netlify.toml'), 'utf8');
  const rule = (from) => { const m = toml.match(new RegExp('from = "' + from.replace(/[.*/]/g, '\\$&') + '"\\n\\s*to = "([^"]+)"\\n\\s*status = (\\d+)\\n\\s*force = true')); return m ? m[1] + ' ' + m[2] : ''; };
  check('netlify.toml: /market-news and each week go to news-page.js, the old .html address moves, /sitemap.xml goes to sitemap.js',
    rule('/market-news') === '/.netlify/functions/news-page 200' && rule('/market-news/*') === '/.netlify/functions/news-page/:splat 200'
    && rule('/market-news.html') === '/market-news 301' && rule('/sitemap.xml') === '/.netlify/functions/sitemap 200'
    && /\[functions\."news-page"\]\n\s*included_files = \["market-news\.html"/.test(toml), [rule('/market-news'), rule('/market-news/*'), rule('/market-news.html'), rule('/sitemap.xml')].join(' | '));
  await t.context.close();

  console.log('\n=== Many weeks: the newest eight beside an update, every week on the archive page ===');
  t = await setup(browser, base, { rows: [WEEK, OLDER].concat(MORE, [DRAFT]) });
  await t.page.goto(base + '/market-news');
  await ready(t);
  let listed = await t.page.$$eval('#news-arch a', (as) => as.map((a) => a.getAttribute('href')));
  check('the main page lists the newest 8 weeks (not all 10), then “All weekly updates”', listed.length === 8 && listed[0] === '/market-news/2026-11-09' && listed[7] === '/market-news/2026-09-21'
    && await t.page.isVisible('#news-all') && (await t.page.getAttribute('#news-all', 'href')) === '/market-news/archive' && (await text(t.page, '#news-count')) === '10 updates', listed.join(', '));
  check('…the latest week has no “from an earlier week” note', !(await t.page.$('.news-old')));
  r = await get(base + '/market-news/archive');
  const months = [...r.body.matchAll(/<h3 class="news-arch-h">([^<]+)<\/h3>/g)].map((m) => m[1]);
  const weeks = [...r.body.matchAll(/<a href="(\/market-news\/\d{4}-\d{2}-\d{2})"/g)].map((m) => m[1]);
  check('the archive page, as sent: 200, its own title and canonical address, every published week by month', r.status === 200
    && between(r.body, /<title>([^<]*)<\/title>/) === 'Freight Market News Archive: Every Weekly Update | QuickFreightCalc'
    && between(r.body, /<link rel="canonical" href="([^"]+)"/) === 'https://quickfreightcalc.com/market-news/archive' && !r.body.includes('noindex')
    && JSON.stringify(months) === JSON.stringify(['November 2026', 'October 2026', 'September 2026']) && weeks.length === 10 && weeks[0] === '/market-news/2026-11-09' && weeks[9] === '/market-news/2026-09-07'
    && !r.body.includes(DRAFT.title), JSON.stringify({ months, n: weeks.length }));
  await t.page.goto(base + '/market-news/archive');
  await ready(t);
  check('…in the browser: “Market news archive”, every week under its month, no update above it, no “All weekly updates” link',
    (await text(t.page, '#news-h1')) === 'Market news archive' && (await t.page.$$('#news-arch a')).length === 10 && (await t.page.$$('#news-arch .news-arch-h')).length === 3
    && await t.page.isHidden('#news-post') && await t.page.isHidden('#news-all') && (await t.page.$eval('#news-arch-title', (e) => e.textContent)) === 'Every weekly update', await text(t.page, '#news-h1'));
  check('…the navigation marks Market News, nothing loaded again, no page errors', (await text(t.page, '#qf-nav .qf-links a.active')) === 'Market News' && t.db.reads === 0 && t.errors.length === 0, t.errors.join(' | '));
  await t.page.screenshot({ path: path.join(SHOTS, 'news_archive.png'), fullPage: true });
  await t.page.goto(base + '/market-news/2026-09-07');
  await ready(t);
  check('a week from a month or more before the latest says so, and points to the latest', (await text(t.page, '.news-old')) === 'This update is from September 7, 2026. Rates and diesel have moved since. See the latest update →'
    && (await t.page.getAttribute('.news-old a', 'href')) === '/market-news', await text(t.page, '.news-old'));
  check('…and its page still lists the newest 8, with the way to every week', (await t.page.$$('#news-arch a')).length === 8 && await t.page.isVisible('#news-all'));
  await t.page.screenshot({ path: path.join(SHOTS, 'news_old_week.png'), fullPage: true });
  await t.page.goto(base + '/market-news/2026-11-02');
  await ready(t);
  check('a week just before the latest has no such note', !(await t.page.$('.news-old')));
  await t.context.close();
  t = await setup(browser, base, { who: OWNER, rows: [WEEK, OLDER].concat(MORE, [DRAFT]) });
  await t.page.goto(base + '/market-news/archive');
  await t.page.waitForSelector('#news-arch .tag', { timeout: 60000 });
  check('the owner’s archive page also shows the draft, tagged, under its month', (await t.page.$$('#news-arch a')).length === 11
    && (await t.page.$eval('#news-arch a', (a) => a.getAttribute('href') + ' ' + !!a.querySelector('.tag'))) === '/market-news/2026-11-16 true');
  check('no page errors', t.errors.length === 0, t.errors.join(' | '));
  await t.context.close();

  console.log('\n=== Clearing the cached pages when the owner publishes (news-purge) ===');
  t = await setup(browser, base);
  const tagged = [];
  for (const u of ['/market-news', '/market-news/2026-11-09', '/market-news/archive', '/market-news/2030-01-07', '/sitemap.xml']) {
    const g = await get(base + u);
    tagged.push(`${u} ${g.status} ${g.headers['netlify-cache-tag']}`);
  }
  check('the Market News pages (a week that isn’t here too) and sitemap.xml carry the cache tag Publish clears',
    tagged.every((x) => / market-news$/.test(x)) && tagged.some((x) => / 404 /.test(x)), tagged.join(' | '));
  await t.context.close();
  const purgeCall = (method, auth, ctx = NETLIFY_CONTEXT) => newsPurge.handler({ httpMethod: method, headers: auth ? { authorization: auth } : {} }, ctx);
  PURGE.calls = [];
  PURGE.status = 200;
  let pr = await purgeCall('GET', 'Bearer owner-token');
  check('news-purge: POST only', pr.statusCode === 405 && PURGE.calls.length === 0);
  pr = await purgeCall('POST', null);
  check('…not signed in: 401, nothing cleared', pr.statusCode === 401 && PURGE.calls.length === 0);
  pr = await purgeCall('POST', 'Bearer ' + USER.token);
  check('…signed in, but not the site owner: 403, nothing cleared', pr.statusCode === 403 && PURGE.calls.length === 0);
  pr = await purgeCall('POST', 'Bearer owner-token', {});
  check('…no purge token from Netlify (not running on Netlify): 503, nothing cleared', pr.statusCode === 503 && PURGE.calls.length === 0);
  pr = await purgeCall('POST', 'Bearer owner-token');
  check('…the site owner: the "market-news" tag cleared for this site with Netlify’s token, 200, never cached',
    pr.statusCode === 200 && JSON.parse(pr.body).purged === true && PURGE.calls.length === 1 && PURGE.calls[0].auth === 'Bearer netlify-purge-token'
    && PURGE.calls[0].body.site_id === 'site-123' && PURGE.calls[0].body.cache_tags.join() === 'market-news' && pr.headers['Cache-Control'] === 'no-store', JSON.stringify(PURGE.calls));
  PURGE.calls = [];
  PURGE.status = [429, 200];
  pr = await purgeCall('POST', 'Bearer owner-token');
  check('…cleared twice within seconds (Netlify allows two every 5 seconds): waits, then tries once more', pr.statusCode === 200 && PURGE.calls.length === 2);
  PURGE.calls = [];
  PURGE.status = 500;
  pr = await purgeCall('POST', 'Bearer owner-token');
  check('…Netlify fails: 502', pr.statusCode === 502 && PURGE.calls.length === 1);
  PURGE.calls = [];
  PURGE.status = 200;
  SERVER.adminDown = true;
  pr = await purgeCall('POST', 'Bearer owner-token');
  SERVER.adminDown = false;
  check('…the sign-in can’t be checked: 502, nothing cleared', pr.statusCode === 502 && PURGE.calls.length === 0);
  delete process.env.SITE_ID;
  process.env.SITE_NAME = 'quickfreightcalculator';
  pr = await purgeCall('POST', 'Bearer owner-token');
  check('…without a site ID, by the site’s name', pr.statusCode === 200 && !!PURGE.calls[0] && PURGE.calls[0].body.site_slug === 'quickfreightcalculator' && !('site_id' in PURGE.calls[0].body));
  delete process.env.SITE_NAME;
  PURGE.calls = [];
  pr = await purgeCall('POST', 'Bearer owner-token');
  check('…with neither: 503, nothing cleared', pr.statusCode === 503 && PURGE.calls.length === 0);
  process.env.SITE_ID = 'site-123';

  console.log('\n=== The teaser on Market Rates ===');
  t = await setup(browser, base);
  await t.page.goto(base + '/rates.html');
  await t.page.waitForSelector('#mr-news:not([hidden])');
  check('this week\'s update, linked to its week', (await text(t.page, '#mr-news-title')) === WEEK.title && (await text(t.page, '#mr-news-week')).toLowerCase() === 'market news · week of nov 9'
    && (await t.page.getAttribute('#mr-news', 'href')) === '/market-news/2026-11-09');
  await t.context.close();
  t = await setup(browser, base, { rows: [DRAFT] });
  await t.page.goto(base + '/rates.html');
  await t.page.waitForFunction(() => document.querySelectorAll('#mr-svg path[data-state]').length > 0);
  await t.page.waitForTimeout(500);
  check('no published update: no teaser (a draft never shows)', await t.page.isHidden('#mr-news'));
  await t.context.close();

  console.log('\n=== Phones ===');
  for (const width of [390, 320]) {
    t = await setup(browser, base, { width });
    await t.page.goto(base + '/market-news/2026-11-02');
    await ready(t);
    const sw = await t.page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    check(`${width}px: no sideways scrolling`, sw <= 1, `${sw}px`);
    if (width === 390) await t.page.screenshot({ path: path.join(SHOTS, 'news_phone.png'), fullPage: true });
    await t.context.close();
  }

  await browser.close();
  server.close();
  console.log(failures ? `\n${failures} NEWS CHECK(S) FAILED` : `\nALL NEWS CHECKS PASSED (screenshots in ${SHOTS})`);
  process.exit(failures ? 1 : 0);
})();
