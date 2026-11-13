// tests/news_test.js — the Market News page (market-news.html): the weekly update in full,
// past weeks, links and text from the weekly task handled safely, the owner's drafts with
// Publish and Unpublish, the empty and error states, and the teaser on the Market Rates page.
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

function serve() {
  const server = http.createServer((req, res) => {
    const p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
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
const DRAFT = { id: 'w-1116', week_of: '2026-11-16', status: 'draft', published_at: null, title: 'Draft: rates firm before Thanksgiving', summary: 'Not public yet.', glance: [], items: [{ headline: 'Rates: Firming', bullets: ['a'], takeaway: 'b' }], headlines: [], sources: [] };

async function setup(browser, base, { who = null, rows = [WEEK, OLDER, DRAFT], fail = false, width = 1280, phone = false } = {}) {
  const context = await browser.newContext(phone || width < 500
    ? { viewport: { width, height: 844 }, isMobile: true, hasTouch: true }
    : { viewport: { width, height: 900 } });
  const db = { rows: rows.map((r) => ({ ...r })), patches: [], dialogs: [] };
  await context.addInitScript((u) => {
    if (localStorage.getItem('__seeded')) return;
    localStorage.setItem('__seeded', '1');
    if (u) localStorage.setItem('sb-xgrmbhmgcsbnazupfybd-auth-token', JSON.stringify({ access_token: u.token, refresh_token: 'r',
      expires_at: Math.floor(Date.now() / 1000) + 3600, user: { id: u.id, email: u.email } }));
  }, who);
  await context.route('**/*', async (route) => {
    const req = route.request(), url = req.url();
    const json = (b, s) => route.fulfill({ status: s || 200, contentType: 'application/json', body: JSON.stringify(b) });
    if (url.startsWith(base) && !url.includes('/.netlify/')) return route.continue();
    const auth = req.headers()['authorization'] || '';
    const isOwner = auth === 'Bearer ' + OWNER.token;
    if (url.includes('/rest/v1/rpc/is_site_admin')) return json(isOwner);
    if (url.includes('/rest/v1/market_updates')) {
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

(async () => {
  const server = await serve();
  const base = `http://127.0.0.1:${server.address().port}`;
  const browser = await chromium.launch();
  let t;

  console.log('\n=== A visitor ===');
  t = await setup(browser, base);
  await t.page.goto(base + '/market-news.html');
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
  check('past weeks listed, newest first; no drafts', JSON.stringify(arch) === JSON.stringify([['?week=2026-11-09', true, false], ['?week=2026-11-02', false, false]]), JSON.stringify(arch));
  check('no owner controls', !(await t.page.$('[data-act]')) && !(await t.page.$('.news-draft')));
  check('the tab title is the week\'s title', (await t.page.title()) === WEEK.title + ' | QuickFreightCalc');
  check('the navigation marks Market News', (await text(t.page, '#qf-nav .qf-links a.active')) === 'Market News');
  await t.page.screenshot({ path: path.join(SHOTS, 'news.png'), fullPage: true });
  await t.page.goto(base + '/market-news.html?week=2026-11-02');
  await ready(t);
  check('a past week by its link', (await text(t.page, '.news-title')) === OLDER.title);
  await t.page.goto(base + '/market-news.html?week=2026-11-16');
  await ready(t);
  check('a draft\'s link shows a visitor nothing of it, and points to the published weeks', !(await t.page.isVisible('#news-post')) && (await text(t.page, '#news-empty h3')) === 'That week’s update isn’t here'
    && await t.page.isVisible('#news-archive') && (await t.page.$$('#news-arch a')).length === 2 && (await t.page.getAttribute('#news-empty a', 'href')) === '/market-news.html');
  check('no page errors', t.errors.length === 0, t.errors.join(' | '));
  await t.context.close();

  console.log('\n=== Signed in, not the owner ===');
  t = await setup(browser, base, { who: USER });
  await t.page.goto(base + '/market-news.html');
  await ready(t);
  check('the same published weeks, no drafts, no controls', (await text(t.page, '.news-title')) === WEEK.title && (await t.page.$$('#news-arch a')).length === 2 && !(await t.page.$('[data-act]')));
  await t.context.close();

  console.log('\n=== The site owner ===');
  t = await setup(browser, base, { who: OWNER });
  await t.page.goto(base + '/market-news.html');
  await ready(t);
  check('the newest week first, even as a draft, marked as one with Publish', (await text(t.page, '.news-title')) === DRAFT.title
    && (await text(t.page, '.news-draft')).startsWith('Draft. Only you can see this until you publish it.') && await t.page.isVisible('button[data-act="publish"]'));
  check('drafts show in the list, tagged', (await t.page.$$eval('#news-arch a', (as) => as.map((a) => !!a.querySelector('.tag')))).join() === 'true,false,false');
  await t.page.click('button[data-act="publish"]');
  await t.page.waitForSelector('.news-draft.live');
  check('Publish: saved with the owner\'s sign-in, then shown as published', t.db.patches.length === 1 && t.db.patches[0].id === DRAFT.id
    && t.db.patches[0].body.status === 'published' && t.db.patches[0].auth === 'Bearer ' + OWNER.token
    && (await text(t.page, '.news-draft')).startsWith('Published Nov 17. Everyone can see this.') && await t.page.isVisible('button[data-act="unpublish"]'), JSON.stringify(t.db.patches));
  check('…and no longer tagged as a draft in the list', !(await t.page.$('#news-arch a .tag')));
  await t.page.click('button[data-act="unpublish"]');
  await t.page.waitForSelector('.news-draft:not(.live)');
  check('Unpublish asks first, then puts it back to a draft', /Take this update off the site\?/.test(t.db.dialogs.join('|')) && t.db.patches[1].body.status === 'draft');
  await t.page.screenshot({ path: path.join(SHOTS, 'news_owner.png'), fullPage: true });
  check('no page errors', t.errors.length === 0, t.errors.join(' | '));
  await t.context.close();

  console.log('\n=== Nothing yet, and errors ===');
  t = await setup(browser, base, { rows: [] });
  await t.page.goto(base + '/market-news.html');
  await ready(t);
  check('no updates yet: says so and points to the market rates', await t.page.isVisible('#news-empty') && (await text(t.page, '#news-empty h3')) === 'The first weekly update is on its way'
    && (await t.page.getAttribute('#news-empty a', 'href')) === '/rates.html' && await t.page.isHidden('#news-archive'));
  await t.context.close();
  t = await setup(browser, base, { fail: true });
  await t.page.goto(base + '/market-news.html');
  await t.page.waitForFunction(() => /couldn’t load/.test(document.getElementById('news-status').textContent));
  check('the database down: a message, not a blank page', await t.page.isVisible('#news-status') && t.errors.length === 0);
  await t.context.close();

  console.log('\n=== The teaser on Market Rates ===');
  t = await setup(browser, base);
  await t.page.goto(base + '/rates.html');
  await t.page.waitForSelector('#mr-news:not([hidden])');
  check('this week\'s update, linked to its week', (await text(t.page, '#mr-news-title')) === WEEK.title && (await text(t.page, '#mr-news-week')).toLowerCase() === 'market news · week of nov 9'
    && (await t.page.getAttribute('#mr-news', 'href')) === '/market-news.html?week=2026-11-09');
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
    await t.page.goto(base + '/market-news.html');
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
