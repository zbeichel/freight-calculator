// tests/winloss_test.js — win/loss tracking in the quote log (Pro Plus and
// up, and comp accounts), saved-quote limits by plan, and saving a quote with
// a customer, in a real browser (needs Playwright with Chromium). Supabase is
// replaced by a small in-memory quote_log that follows the database's rules
// (quote_log_enforce_plan). Run from the repository root:
//   node tests/winloss_test.js [folder for screenshots]
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { chromium } = require('playwright');
const ROOT = path.resolve(__dirname, '..');
const SHOTS = process.argv[2] || fs.mkdtempSync(path.join(os.tmpdir(), 'qfc-winloss-'));
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.json': 'application/json', '.css': 'text/css' };
const DAY = 86400000;
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

// A saved quote as Supabase returns it.
function row(id, daysAgo, o = {}) {
  return Object.assign({
    id, user_id: 'user-1', date: 'Nov 1, 26', origin: 'Lancaster, PA', destination: 'New York, NY',
    miles: 166, trailer: 'van', weight: '40000', pickup_date: null, delivery_date: null,
    commodity: 'Standard', commodity_key: 'standard', margin: '15%', base_rpm: '2.40', quote: 1850, rpm: '11.14',
    notes: '', created_at: new Date(Date.now() - daysAgo * DAY).toISOString(), tracked: true,
    customer: null, outcome: 'open', outcome_at: null, final_rate: null, lost_reason: null,
  }, o);
}

// The database's rules (quote_log_enforce_plan).
const TIER_CAP = { pro: 100, plus: 1000, max: 5000, api: 5000, comp: 5000, none: 0 };
function tierOf(acct) {
  if (!acct || acct.is_active !== true) return 'none';
  if (!acct.stripe_subscription_id) return 'comp';
  return acct.plan || 'pro';
}

async function setup(browser, base, { account, quotes = [], capOverride = null, theme = null, phone = false }) {
  const context = await browser.newContext(phone
    ? { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true }
    : { viewport: { width: 1280, height: 900 }, deviceScaleFactor: 2 });
  const db = { account, quotes: quotes.map((q) => ({ ...q })), nextId: 5000, posts: [], patches: [], deletes: [], profilePatches: [], gets: [] };
  await context.addInitScript(([themeName]) => {
    if (localStorage.getItem('__seeded')) return;
    localStorage.setItem('__seeded', '1');
    localStorage.setItem('sb-xgrmbhmgcsbnazupfybd-auth-token', JSON.stringify({ access_token: 'tok', refresh_token: 'r',
      expires_at: Math.floor(Date.now() / 1000) + 3600, user: { id: 'user-1', email: 'sam@example.com' } }));
    localStorage.setItem('qfc_pro_profile', JSON.stringify({ companyName: 'Keystone Produce Logistics' }));
    if (themeName) localStorage.setItem('qfc_theme', themeName);
  }, [theme]);
  await context.route('**/*', async (route) => {
    const req = route.request();
    const url = req.url();
    const method = req.method();
    const json = (b, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(b) });
    if (url.startsWith(base) && !url.includes('/.netlify/functions/')) return route.continue();
    if (url.includes('/rest/v1/quote_log')) {
      const u = new URL(url);
      const tier = tierOf(db.account);
      if (method === 'GET') {
        db.gets.push(u.search);
        const limit = Number(u.searchParams.get('limit') || 1000), offset = Number(u.searchParams.get('offset') || 0);
        const sorted = db.quotes.slice().sort((a, b) => b.created_at.localeCompare(a.created_at) || b.id - a.id);
        return json(sorted.slice(offset, offset + Math.min(limit, 1000)));
      }
      if (method === 'POST') {
        const body = JSON.parse(req.postData());
        db.posts.push({ body, prefer: req.headers()['prefer'] });
        const cap = capOverride !== null ? capOverride : TIER_CAP[tier];
        if (db.quotes.length >= cap) return json({ code: '54000', message: `Saved quote limit reached (${cap})` }, 400);
        const r = row(db.nextId++, 0, { ...body, outcome: 'open', final_rate: null, lost_reason: null });
        db.quotes.push(r);
        return json([r], 201);
      }
      if (method === 'PATCH') {
        const id = Number(u.searchParams.get('id').replace('eq.', ''));
        const body = JSON.parse(req.postData());
        db.patches.push({ id, body });
        const r = db.quotes.find((q) => q.id === id);
        if (!r) return json([]);
        const resultChange = ['outcome', 'final_rate', 'lost_reason'].some((k) => k in body && body[k] !== r[k]);
        if (resultChange && !['plus', 'max', 'api', 'comp'].includes(tier)) {
          return json({ code: '42501', message: 'Win/loss tracking comes with Pro Plus and up' }, 403);
        }
        if ('outcome' in body && body.outcome !== r.outcome) r.outcome_at = body.outcome === 'open' ? null : new Date().toISOString();
        Object.assign(r, body);
        return json([r]);
      }
      if (method === 'DELETE') {
        const id = Number((u.searchParams.get('id') || '').replace('eq.', ''));
        db.deletes.push(id);
        db.quotes = db.quotes.filter((q) => q.id !== id);
        return route.fulfill({ status: 204, body: '' });
      }
    }
    if (url.includes('/rest/v1/pro_users')) {
      if (method === 'PATCH') { db.profilePatches.push(JSON.parse(req.postData())); return route.fulfill({ status: 204, body: '' }); }
      return json(db.account ? [db.account] : []);
    }
    if (url.includes('/.netlify/functions/verify-pro')) return json({ active: true, plan: (db.account && db.account.plan) || 'pro', paid: true, unlimitedUntilRenewal: false });
    if (url.includes('/.netlify/functions/')) return json({});
    if (url.includes('supabase.co')) return json([]);
    if (url.includes('fonts.googleapis.com') || url.includes('fonts.gstatic.com')) return route.continue();
    return route.abort();
  });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  return { context, page, errors, db };
}

const ACCT = (o) => Object.assign({ id: 'user-1', email: 'sam@example.com', company_name: 'Keystone Produce Logistics',
  is_active: true, plan: 'pro', stripe_customer_id: 'cus_1', stripe_subscription_id: 'sub_1' }, o);

async function open(t, base, count) {
  await t.page.goto(base + '/index.html');
  await t.page.waitForFunction((n) => typeof quoteLog !== 'undefined' && quoteLog.length === n
    && typeof regionalRates !== 'undefined' && regionalRates !== null, count);
  await t.page.waitForTimeout(300);
}
const flat = async (pg, sel) => (await pg.textContent(sel)).replace(/\s+/g, ' ').trim();
const rowById = (pg, id) => pg.locator(`#log-body tr:has(button[onclick="openNotesModal(${id})"])`);
const chips = (pg, sel) => pg.$$eval(sel + ' .wl-chip', (els) => els.map((e) => e.textContent.trim()).join(' · '));

// Ten quotes in the last 90 days and one from 120 days ago.
const SEED = [
  row(101, 1, { customer: 'Keystone Produce', outcome: 'won', final_rate: 1800 }),
  row(102, 2, { origin: 'Lancaster, PA 17601', destination: 'New York, NY 10001', customer: 'keystone produce', outcome: 'won' }),
  row(103, 3, { customer: 'Keystone Produce', outcome: 'lost', lost_reason: 'price', final_rate: 1700 }),
  row(104, 4, { customer: 'Keystone Produce', notes: 'open-keystone' }),
  row(105, 5, { origin: 'Hastings, FL 32145', destination: 'Lancaster, PA', customer: 'Sunrise Farms', outcome: 'won', quote: 3400, margin: '12%', trailer: 'reefer' }),
  row(106, 6, { origin: 'Hastings, FL', destination: 'Lancaster, PA', customer: 'Sunrise Farms', outcome: 'lost', lost_reason: 'capacity', quote: 3500, margin: '18%', trailer: 'reefer' }),
  row(107, 7, { origin: 'Hastings, FL', destination: 'Lancaster, PA', customer: 'Sunrise Farms', outcome: 'lost', quote: 3600, margin: '20%', trailer: 'reefer' }),
  row(108, 8, { origin: 'Chicago, IL', destination: 'Dallas, TX', quote: 2600, notes: 'open-chicago' }),
  row(109, 9, { origin: 'Chicago, IL', destination: 'Dallas, TX', outcome: 'won', quote: 2500, margin: '10%' }),
  row(110, 120, { origin: 'Chicago, IL', destination: 'Dallas, TX', customer: 'Lone Star Grocers', outcome: 'won', quote: 2400, margin: '10%' }),
];

(async () => {
  const server = await serve();
  const base = `http://127.0.0.1:${server.address().port}`;
  const browser = await chromium.launch();

  // ── Pro Plus ──────────────────────────────────────────────────────────────
  console.log('\n=== Pro Plus: results, numbers by lane and customer ===');
  let t = await setup(browser, base, { account: ACCT({ plan: 'plus' }), quotes: SEED });
  await open(t, base, 10);
  const pills = await t.page.$$eval('#log-body .wl-pill', (els) => els.map((e) => e.textContent.trim()));
  check('Result column: 5 won, 3 lost, 2 open', pills.filter((p) => p === '✓ Won').length === 5
    && pills.filter((p) => p === '✕ Lost').length === 3 && pills.filter((p) => p === 'Open').length === 2, pills.join(','));
  check('filters show the counts', (await chips(t.page, '#log-filters')) === 'All 10 · Open 2 · Won 5 · Lost 3', await chips(t.page, '#log-filters'));
  check('count note uses the Pro Plus limit', (await flat(t.page, '#profile-count-note')) === '10 / 1,000 quotes saved');
  check('customer shown under the route', (await rowById(t.page, 104).locator('.wl-cust').textContent()) === 'Keystone Produce');
  check('hover text says how it was won or lost', (await rowById(t.page, 105).locator('.wl-pill').getAttribute('title')) === 'Booked at your quote'
    && (await rowById(t.page, 103).locator('.wl-pill').getAttribute('title')) === 'Price too high · went for $1,700');

  let panel = await flat(t.page, '#wl-panel');
  check('90 days: win rate 57% (4 won, 3 lost)', panel.includes('57% win rate') && panel.includes('4 won · 3 lost'), panel.slice(0, 200));
  const tiles = await t.page.$$eval('#wl-panel .wl-tile', (els) => els.map((e) => [...e.children].map((c) => c.textContent.trim()).join('|')));
  check('open quotes and booked revenue', tiles[1] === 'Open|2|quotes waiting on an answer' && tiles[2] === 'Booked|$9,550|on 4 won loads', JSON.stringify(tiles));
  check('margin on won loads at the booked rate, and on lost quotes', tiles[3] === 'Avg margin|12%|on won loads · 18% on lost quotes', tiles[3]);
  const laneRows = await t.page.$$eval('#wl-panel .wl-table-wrap:nth-child(1) tbody tr', (trs) => trs.map((tr) => [...tr.cells].map((c) => c.textContent.trim()).join('|')));
  check('by lane: ZIP variants are one lane, most results first', JSON.stringify(laneRows) === JSON.stringify([
    'Lancaster, PA → New York, NY|4|2|1|67%|13%',
    'Hastings, FL → Lancaster, PA|3|1|2|33%|12%',
    'Chicago, IL → Dallas, TX|2|1|0|100%|10%',
  ]), JSON.stringify(laneRows));
  const custRows = await t.page.$$eval('#wl-panel .wl-table-wrap:nth-child(2) tbody tr', (trs) => trs.map((tr) => [...tr.cells].map((c) => c.textContent.trim()).join('|')));
  check('by customer: names match regardless of case', JSON.stringify(custRows) === JSON.stringify([
    'Keystone Produce|4|2|1|67%|13%',
    'Sunrise Farms|3|1|2|33%|12%',
  ]), JSON.stringify(custRows));
  check('why quotes were lost', panel.includes('Why quotes were lost: Price too high 1 · No truck available 1 · No reason given 1.'));
  check('how far above the winning rate', panel.includes('your quote was 9% above it on average (1 quote)'));
  check('quotes without a customer are pointed out', panel.includes('2 quotes in this period have no customer'));
  await t.page.locator('#wl-panel').screenshot({ path: path.join(SHOTS, 'winloss_panel.png') });

  await t.page.click('#wl-panel .wl-chip:has-text("All time")');
  panel = await flat(t.page, '#wl-panel');
  check('all time includes the older quote (5 won, 3 lost → 63%)', panel.includes('63% win rate') && panel.includes('5 won · 3 lost')
    && panel.includes('Lone Star Grocers'));
  await t.page.click('#wl-panel .wl-chip:has-text("90 days")');

  await t.page.click('#log-filters .wl-chip:has-text("Lost")');
  check('Lost filter shows only lost quotes', (await t.page.$$('#log-body tr')).length === 3
    && (await t.page.$$eval('#log-body .wl-pill', (els) => els.every((e) => e.textContent.trim() === '✕ Lost'))));
  await t.page.click('#log-filters .wl-chip:has-text("All")');

  console.log('\n=== Marking results ===');
  await rowById(t.page, 104).locator('.wl-pill').click();
  check('Result window opens on the quote, set to Open', await t.page.isVisible('#wl-modal-overlay')
    && (await t.page.textContent('#wl-modal-lane')).includes('quoted $1,850')
    && (await t.page.getAttribute('#wl-modal-overlay .wl-seg [data-outcome="open"]', 'aria-checked')) === 'true'
    && !(await t.page.isVisible('#wl-won-fields')) && !(await t.page.isVisible('#wl-lost-fields')));
  await t.page.click('#wl-modal-overlay .wl-seg [data-outcome="lost"]');
  await t.page.selectOption('#wl-reason', 'timing');
  await t.page.fill('#wl-went-for', '1790');
  await t.page.locator('.wl-modal').screenshot({ path: path.join(SHOTS, 'winloss_modal_lost.png') });
  await t.page.click('#wl-modal-save');
  await t.page.waitForFunction(() => document.getElementById('wl-modal-overlay').style.display === 'none');
  let patch = t.db.patches.at(-1);
  check('Lost: saves the reason, the rate it went for, and keeps the customer', patch.id === 104
    && JSON.stringify(patch.body) === JSON.stringify({ outcome: 'lost', final_rate: 1790, lost_reason: 'timing', customer: 'Keystone Produce', customer_id: null }), JSON.stringify(patch));
  check('row and numbers update (4 won, 4 lost → 50%)', (await rowById(t.page, 104).locator('.wl-pill').textContent()).trim() === '✕ Lost'
    && (await flat(t.page, '#wl-panel')).includes('50% win rate'));

  await rowById(t.page, 108).locator('.wl-pill').click();
  await t.page.click('#wl-modal-overlay .wl-seg [data-outcome="won"]');
  check('Won: "Booked at" starts at the quoted rate', (await t.page.inputValue('#wl-booked')) === '2600');
  await t.page.fill('#wl-booked', '2550');
  await t.page.fill('#wl-customer', '  Lone   Star Grocers ');
  await t.page.click('#wl-modal-save');
  await t.page.waitForFunction(() => document.getElementById('wl-modal-overlay').style.display === 'none');
  patch = t.db.patches.at(-1);
  check('Won at a different rate, with a customer added', patch.id === 108
    && JSON.stringify(patch.body) === JSON.stringify({ outcome: 'won', final_rate: 2550, lost_reason: null, customer: 'Lone Star Grocers', customer_id: null }), JSON.stringify(patch));

  await rowById(t.page, 102).locator('.wl-pill').click();   // won at the quote
  check('a won quote reopens on Won with its rate', (await t.page.getAttribute('#wl-modal-overlay .wl-seg [data-outcome="won"]', 'aria-checked')) === 'true'
    && (await t.page.inputValue('#wl-booked')) === '1850');
  await t.page.click('#wl-modal-overlay .wl-seg [data-outcome="open"]');
  await t.page.click('#wl-modal-save');
  await t.page.waitForFunction(() => document.getElementById('wl-modal-overlay').style.display === 'none');
  patch = t.db.patches.at(-1);
  check('back to Open clears the rate and reason', patch.id === 102 && patch.body.outcome === 'open' && patch.body.final_rate === null && patch.body.lost_reason === null);

  await t.page.locator('#log-body tr').first().locator('.wl-pill').click();
  await t.page.keyboard.press('Escape');
  check('Escape closes the Result window', !(await t.page.isVisible('#wl-modal-overlay')));

  console.log('\n=== Saving a quote with a customer ===');
  check('customer field on the calculator', await t.page.isVisible('#quote-customer'));
  await t.page.evaluate(() => {
    const set = (id, v) => { document.getElementById(id).value = v; };
    set('origin', 'Harrisburg, PA'); set('dest', 'Boston, MA'); set('miles', 384); set('weight', 38000);
    set('trailer', 'van'); set('commodity', 'standard'); set('margin', 15); set('quote-customer', 'Acme Foods');
    applyRegionalRates(); calc();
  });
  await t.page.evaluate(() => saveQuote());
  await t.page.waitForFunction(() => quoteLog[0] && !quoteLog[0].pending);
  const post = t.db.posts.at(-1);
  check('saved with the customer, asking for the new row back', post.body.customer === 'Acme Foods' && post.prefer === 'return=representation');
  check("the new entry carries the database's id", (await t.page.evaluate(() => quoteLog[0].id)) === 5000);
  await rowById(t.page, 5000).locator('.wl-pill').click();
  await t.page.click('#wl-modal-overlay .wl-seg [data-outcome="won"]');
  await t.page.click('#wl-modal-save');
  await t.page.waitForFunction(() => document.getElementById('wl-modal-overlay').style.display === 'none');
  check('a just-saved quote can be marked right away (reaches its row)', t.db.patches.at(-1).id === 5000
    && t.db.quotes.find((q) => q.id === 5000).outcome === 'won');
  await t.page.evaluate(() => openNotesModal(5000));
  await t.page.fill('#notes-modal-input', 'Dock 4');
  await t.page.evaluate(() => saveNotesModal());
  await t.page.waitForTimeout(200);
  check('and its notes reach the database too', t.db.quotes.find((q) => q.id === 5000).notes === 'Dock 4');
  await t.page.evaluate(() => { document.getElementById('quote-customer').value = ''; loadQuoteIntoCalc(5000); });
  check('loading it back fills the customer', (await t.page.inputValue('#quote-customer')) === 'Acme Foods');

  const csv = await t.page.evaluate(() => {
    let href = '';
    const click = HTMLAnchorElement.prototype.click;
    HTMLAnchorElement.prototype.click = function () { href = this.href; };
    exportCSV();
    HTMLAnchorElement.prototype.click = click;
    return decodeURIComponent(href.slice(href.indexOf(',') + 1));
  });
  const csvLines = csv.split('\n');
  check('CSV has customer and result columns', csvLines[0] === 'Date,Customer,Origin,Destination,Miles,Trailer,Commodity,Margin,Base RPM,Quote,RPM,Result,Booked / Went For,Lost Reason,Notes', csvLines[0]);
  check('CSV keeps "City, ST" in one column', csvLines.some((l) => l.includes(',Keystone Produce,"Lancaster, PA","New York, NY",') && l.includes(',Lost,1790,Timing / schedule,')), csvLines.slice(1, 4).join(' / '));

  await t.page.click('.wl-toggle');
  check('panel folds away', !(await t.page.isVisible('.wl-tiles')));
  await t.page.reload();
  await t.page.waitForFunction(() => typeof quoteLog !== 'undefined' && quoteLog.length === 11);
  check('and stays folded after a reload', !(await t.page.isVisible('.wl-tiles')) && (await flat(t.page, '#wl-panel')).includes('win rate'));
  check('no page errors', t.errors.length === 0, t.errors.join(' | '));
  await t.context.close();

  console.log('\n=== On a phone ===');
  t = await setup(browser, base, { account: ACCT({ plan: 'plus' }), quotes: SEED, phone: true });
  await open(t, base, 10);
  const sideways = await t.page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  check('the page does not scroll sideways', sideways <= 1, `${sideways}px`);
  const tileCols = await t.page.$$eval('#wl-panel .wl-tile', (els) => new Set(els.map((e) => Math.round(e.getBoundingClientRect().left))).size);
  const tableOverflow = await t.page.$$eval('#wl-panel .wl-table-wrap', (els) => els.map((e) => e.scrollWidth - e.clientWidth));
  check('lane and customer tables fit without scrolling', tableOverflow.every((x) => x <= 1), JSON.stringify(tableOverflow));
  check('tiles in two columns, tables stacked', tileCols === 2
    && (await t.page.$$eval('#wl-panel .wl-table-wrap', (els) => els[1].getBoundingClientRect().top > els[0].getBoundingClientRect().bottom - 1)));
  await t.page.addStyleTag({ content: 'header{display:none!important}' });
  await t.page.locator('#wl-panel').screenshot({ path: path.join(SHOTS, 'winloss_phone_panel.png') });
  await rowById(t.page, 104).locator('.wl-pill').click();
  await t.page.click('#wl-modal-overlay .wl-seg [data-outcome="won"]');
  const box = await t.page.locator('.wl-modal').boundingBox();
  check('Result window fits the screen', box.x >= 0 && box.x + box.width <= 390 && box.y >= 0 && box.y + box.height <= 844, JSON.stringify(box));
  await t.page.screenshot({ path: path.join(SHOTS, 'winloss_phone_modal.png') });
  check('no page errors', t.errors.length === 0, t.errors.join(' | '));
  await t.context.close();

  // ── Pro ───────────────────────────────────────────────────────────────────
  console.log('\n=== Pro: locked, with the way to get it ===');
  t = await setup(browser, base, { account: ACCT({ plan: 'pro' }), quotes: SEED.slice(0, 3) });
  await open(t, base, 3);
  check('results show locked', (await t.page.$$eval('#log-body .wl-pill', (els) => els.every((e) => e.classList.contains('locked') && e.textContent.includes('Result')))));
  check('no filters; count note uses the Pro limit', (await chips(t.page, '#log-filters')) === '' && (await flat(t.page, '#profile-count-note')) === '3 / 100 quotes saved');
  check('teaser instead of the numbers', (await flat(t.page, '#wl-panel')).includes('Comes with Pro Plus') && !(await t.page.$('.wl-tiles')));
  await t.page.locator('#wl-panel').screenshot({ path: path.join(SHOTS, 'winloss_teaser.png') });
  await t.page.locator('#log-body .wl-pill').first().click();
  check('a locked result opens the upgrade window on Pro Plus', await t.page.isVisible('#upg-modal-overlay')
    && (await t.page.isChecked('#upg-option-plus input')) && (await t.page.textContent('#upg-modal-desc')).includes('Win/loss tracking comes with Pro Plus'));
  await t.page.evaluate(() => closeUpgradeModal());
  check('the customer field is there for Pro too', await t.page.isVisible('#quote-customer'));
  await t.page.click('.wl-teaser-close');
  await t.page.reload();
  await t.page.waitForFunction(() => typeof quoteLog !== 'undefined' && quoteLog.length === 3);
  check('teaser can be hidden for good', (await flat(t.page, '#wl-panel').catch(() => '')) === '');
  check('no page errors', t.errors.length === 0, t.errors.join(' | '));
  await t.context.close();

  console.log('\n=== Pro: full quote log ===');
  const hundred = Array.from({ length: 100 }, (_, i) => row(1000 + i, i / 10));
  t = await setup(browser, base, { account: ACCT({ plan: 'pro' }), quotes: hundred });
  await open(t, base, 100);
  await t.page.evaluate(() => {
    document.getElementById('miles').value = 300; applyRegionalRates(); calc(); saveQuote();
  });
  await t.page.waitForTimeout(200);
  check('at 100 quotes, saving offers Pro Plus (1,000 quotes) and nothing is sent', await t.page.isVisible('#upg-modal-overlay')
    && (await t.page.textContent('#upg-modal-desc')).includes('Your quote log is full (100 quotes)') && t.db.posts.length === 0);
  check('100 quotes load, 50 rows drawn, the rest one click away', (await t.page.$$('#log-body tr')).length === 50
    && (await flat(t.page, '#log-more')) === 'Show 50 more · 50 not shown');
  await t.context.close();

  console.log("\n=== The database's limit wins ===");
  t = await setup(browser, base, { account: ACCT({ plan: 'pro' }), quotes: SEED.slice(0, 3), capOverride: 3 });
  await open(t, base, 3);
  await t.page.evaluate(() => { document.getElementById('miles').value = 300; applyRegionalRates(); calc(); saveQuote(); });
  await t.page.waitForFunction(() => document.getElementById('upg-modal-overlay').style.display === 'flex');
  check('a save the database refuses is taken back out of the log', (await t.page.evaluate(() => quoteLog.length)) === 3 && t.db.posts.length === 1);
  await t.context.close();

  console.log("\n=== A result the database refuses ===");
  t = await setup(browser, base, { account: ACCT({ plan: 'plus' }), quotes: SEED.slice(3, 4) });
  await open(t, base, 1);
  t.db.account.plan = 'pro';   // plan changed elsewhere; this page still thinks Pro Plus
  await t.page.locator('#log-body .wl-pill').click();
  await t.page.click('#wl-modal-overlay .wl-seg [data-outcome="won"]');
  await t.page.click('#wl-modal-save');
  await t.page.waitForFunction(() => document.getElementById('wl-modal-status').textContent !== '');
  check('the window says why and the quote stays open', (await t.page.textContent('#wl-modal-status')).includes('comes with Pro Plus')
    && (await t.page.evaluate(() => quoteLog[0].outcome)) === 'open');
  await t.context.close();

  // ── Comp (coworkers) ─────────────────────────────────────────────────────
  console.log('\n=== Comp account ===');
  t = await setup(browser, base, { account: ACCT({ plan: 'pro', stripe_subscription_id: null, stripe_customer_id: null }), quotes: SEED.slice(0, 4) });
  await open(t, base, 4);
  check('comp accounts get win/loss and the 5,000 limit', !(await t.page.$('#log-body .wl-pill.locked')) && !!(await t.page.$('.wl-tiles'))
    && (await flat(t.page, '#profile-count-note')) === '4 / 5,000 quotes saved');
  await t.context.close();

  // ── Pro Max with more than 1,000 saved quotes ────────────────────────────
  console.log('\n=== Pro Max: 1,234 saved quotes ===');
  const many = Array.from({ length: 1234 }, (_, i) => row(20000 + i, i / 20, {
    origin: `Town ${i % 40}, PA`, destination: 'Newark, NJ', customer: `Customer ${i % 12}`,
    outcome: i % 3 === 0 ? 'won' : i % 3 === 1 ? 'lost' : 'open', lost_reason: i % 3 === 1 ? 'price' : null,
  }));
  t = await setup(browser, base, { account: ACCT({ plan: 'max' }), quotes: many, theme: 'dark' });
  await open(t, base, 1234);
  check('loads in pages of 1,000 (2 requests)', t.db.gets.length === 2 && t.db.gets[1].includes('offset=1000'), t.db.gets.join(' '));
  check('count note uses the Pro Max limit', (await flat(t.page, '#profile-count-note')) === '1,234 / 5,000 quotes saved');
  check('50 rows drawn, "Show more" for the rest', (await t.page.$$('#log-body tr')).length === 50 && (await flat(t.page, '#log-more')) === 'Show 50 more · 1,184 not shown');
  await t.page.click('#log-more button');
  check('Show more adds 50', (await t.page.$$('#log-body tr')).length === 100);
  check('tables show the top 8 with a way to see all', (await t.page.$$('#wl-panel .wl-table-wrap:nth-child(1) tbody tr')).length === 8
    && (await t.page.textContent('#wl-panel .wl-table-wrap:nth-child(1) .wl-more')).includes('Show all'));
  await t.page.click('#wl-panel .wl-table-wrap:nth-child(1) .wl-more');
  check('Show all lists every lane', (await t.page.$$('#wl-panel .wl-table-wrap:nth-child(1) tbody tr')).length === 40);
  const profiles = t.db.profilePatches.at(-1);
  check('Lane Tracker still gets the 100 most recent tracked quotes', profiles && profiles.rate_profiles.length === 100);
  await t.page.evaluate(() => { logShown = 6; wlShowAll.lane = false; renderLog(); });
  await t.page.addStyleTag({ content: 'header{display:none!important}' });
  await t.page.locator('#quote-log-card').screenshot({ path: path.join(SHOTS, 'winloss_dark.png') });
  check('no page errors', t.errors.length === 0, t.errors.join(' | '));
  await t.context.close();

  await browser.close();
  server.close();
  console.log(failures ? `\n${failures} WIN/LOSS CHECK(S) FAILED` : `\nALL WIN/LOSS CHECKS PASSED (screenshots in ${SHOTS})`);
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
