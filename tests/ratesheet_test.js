// tests/ratesheet_test.js — your own rate sheet (Pro Plus and up): rate-sheet.js itself, the
// Profile page's editor, "My rates" on the calculator and the multi-stop builder, in a real
// browser (needs Playwright with Chromium). Supabase and the Netlify functions are fakes.
// Run from the repository root:
//   node tests/ratesheet_test.js [folder for screenshots]
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { chromium } = require('playwright');
const ROOT = path.resolve(__dirname, '..');
const SHOTS = process.argv[2] || fs.mkdtempSync(path.join(os.tmpdir(), 'qfc-ratesheet-'));
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.json': 'application/json', '.css': 'text/css' };
const RATES = JSON.parse(fs.readFileSync(path.join(ROOT, 'rates.json'), 'utf8'));
const RS = require(path.join(ROOT, 'rate-sheet.js'));
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

const SHEET = { all: { van: 3.1 }, northeast: { reefer: 3.9 } };
const ROW = (o) => Object.assign({ id: 'user-1', email: 'sam@example.com', company_name: 'Keystone Produce Logistics', contact_name: 'Sam Rivera',
  is_active: true, plan: 'plus', stripe_customer_id: 'cus_1', stripe_subscription_id: 'sub_1', rate_sheet: null }, o);

async function setup(browser, base, { row = ROW(), team = null, verifyPlan = null } = {}) {
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, deviceScaleFactor: 2 });
  const db = { row, patches: [], dialogs: [] };
  await context.addInitScript(() => {
    if (localStorage.getItem('__seeded')) return;
    localStorage.setItem('__seeded', '1');
    localStorage.setItem('sb-xgrmbhmgcsbnazupfybd-auth-token', JSON.stringify({ access_token: 'tok', refresh_token: 'r',
      expires_at: Math.floor(Date.now() / 1000) + 3600, user: { id: 'user-1', email: 'sam@example.com' } }));
  });
  await context.route('**/*', async (route) => {
    const req = route.request();
    const url = req.url();
    const json = (b, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(b) });
    if (url.startsWith(base) && !url.includes('/.netlify/functions/')) return route.continue();
    if (url.includes('/rest/v1/rpc/my_account')) return json({ row: db.row, team });
    if (url.includes('/rest/v1/pro_users')) {
      if (req.method() === 'PATCH') { db.patches.push(JSON.parse(req.postData())); return route.fulfill({ status: 204, body: '' }); }
      return json(db.row ? [db.row] : []);
    }
    if (url.includes('/.netlify/functions/verify-pro')) return json({ active: true, plan: verifyPlan || db.row.plan, paid: true, unlimitedUntilRenewal: false });
    if (url.includes('/.netlify/functions/team')) return json({ role: null, size: 1, used: 1, members: [] });
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
const rates = (pg) => pg.evaluate(() => ['van', 'reefer', 'flatbed'].map((t) => document.getElementById('rate-' + t).value).join(' '));
const text = (pg, sel) => pg.$eval(sel, (e) => e.innerText.replace(/\s+/g, ' ').trim()).catch(() => '');

(async () => {
  // ── rate-sheet.js ─────────────────────────────────────────────────────────
  console.log('\n=== rate-sheet.js ===');
  check('rates: $ signs, commas and /mi are fine; out of range or text is not a rate; blank is blank',
    RS.parseRate('$3.10') === 3.1 && RS.parseRate(' 2.845 ') === 2.85 && RS.parseRate('3.5/mi') === 3.5 && RS.parseRate('') === null
    && RS.parseRate(null) === null && Number.isNaN(RS.parseRate('abc')) && Number.isNaN(RS.parseRate('0.2')) && Number.isNaN(RS.parseRate('25')));
  check('clean keeps only known rows and trailers with rates; an empty sheet is null',
    JSON.stringify(RS.clean({ all: { van: '3.10', foo: 2 }, northeast: { reefer: 3.9, flatbed: '' }, mars: { van: 3 }, west: { van: 'x' } }))
      === JSON.stringify({ all: { van: 3.1 }, northeast: { reefer: 3.9 } })
    && RS.clean({}) === null && RS.clean(null) === null && RS.clean({ all: { van: '' } }) === null);
  check('a region’s own rate wins, then all regions, then nothing (market)',
    RS.sheetRate(SHEET, 'northeast', 'reefer') === 3.9 && RS.sheetRate(SHEET, 'northeast', 'van') === 3.1
    && RS.sheetRate(SHEET, 'west', 'van') === 3.1 && RS.sheetRate(SHEET, 'national', 'van') === 3.1 && RS.sheetRate(SHEET, 'west', 'flatbed') === null);
  const m = Object.fromEntries(Object.entries(RATES.regions).map(([k, v]) => [k, { van: v.van, reefer: v.reefer, flatbed: v.flatbed }]));
  const ne = RS.ratesFor(SHEET, m, 'northeast');
  check('ratesFor: the sheet where set, the region’s market rate otherwise',
    ne.rates.van === 3.1 && ne.rates.reefer === 3.9 && ne.rates.flatbed === RATES.regions.northeast.flatbed
    && ne.from.van === 'sheet' && ne.from.flatbed === 'market', JSON.stringify(ne));
  check('who gets it: Pro Plus, Pro Max, API and comp — not Pro', RS.allowed('plus') && RS.allowed('max') && RS.allowed('api')
    && RS.allowed('pro', true) && !RS.allowed('pro') && !RS.allowed(undefined));

  const server = await serve();
  const base = `http://127.0.0.1:${server.address().port}`;
  const browser = await chromium.launch();

  // ── Profile: the editor ───────────────────────────────────────────────────
  console.log('\n=== Profile: Pro Plus ===');
  let t = await setup(browser, base, { row: ROW({ rate_sheet: SHEET }) });
  await t.page.goto(base + '/profile.html');
  await t.page.waitForFunction(() => document.getElementById('rs-northeast-reefer') && document.getElementById('rs-northeast-reefer').value === '3.90');
  await t.page.waitForFunction(() => document.getElementById('rs-states-northeast').textContent.length > 0);
  const grid = await t.page.evaluate(() => ({
    inputs: document.querySelectorAll('#rs-grid input').length,
    allVan: document.getElementById('rs-all-van').value,
    neVanHint: document.getElementById('rs-northeast-van').placeholder,
    neFlatHint: document.getElementById('rs-northeast-flatbed').placeholder,
    allFlatHint: document.getElementById('rs-all-flatbed').placeholder,
    states: document.getElementById('rs-states-northeast').textContent,
    locked: getComputedStyle(document.getElementById('rs-locked')).display,
    disabled: document.getElementById('rs-all-van').disabled,
  }));
  check('six rows (all regions + five regions) by three trailers, filled from the account', grid.inputs === 18 && grid.allVan === '3.10', JSON.stringify(grid));
  check('blank boxes hint what applies: the all-regions rate, else this month’s market rate', grid.neVanHint === '3.10'
    && grid.neFlatHint === RATES.regions.northeast.flatbed.toFixed(2) && grid.allFlatHint === RATES.regions.national.flatbed.toFixed(2), JSON.stringify(grid));
  check('each region lists its states; open on Pro Plus', /PA/.test(grid.states) && grid.locked === 'none' && !grid.disabled);
  await t.page.fill('#rs-west-flatbed', 'abc');
  await t.page.click('.save-btn');
  await t.page.waitForTimeout(300);
  check('a box that isn’t a rate blocks the save and is marked', t.db.patches.length === 0
    && await t.page.$eval('#rs-west-flatbed', (e) => e.classList.contains('bad')) && /rates are \$0\.50 to \$20\.00 a mile/.test(await text(t.page, '#toast')));
  await t.page.fill('#rs-west-flatbed', '$4.25');
  await t.page.fill('#rs-all-van', '');
  check('clearing the all-regions box puts the market hint back', (await t.page.$eval('#rs-northeast-van', (e) => e.placeholder)) === RATES.regions.northeast.van.toFixed(2));
  await t.page.click('.save-btn');
  await t.page.waitForTimeout(500);
  const patch = t.db.patches[t.db.patches.length - 1] || {};
  check('Save sends the cleaned sheet with the profile', JSON.stringify(patch.rate_sheet) === JSON.stringify({ northeast: { reefer: 3.9 }, west: { flatbed: 4.25 } }), JSON.stringify(patch.rate_sheet));
  check('…and keeps it for the calculator', await t.page.evaluate(() => JSON.stringify(JSON.parse(localStorage.getItem('qfc_pro_profile')).rateSheet)) === JSON.stringify({ northeast: { reefer: 3.9 }, west: { flatbed: 4.25 } }));
  await t.page.click('#rs-fill-btn');
  const filled = await t.page.evaluate(() => [...document.querySelectorAll('#rs-grid input')].filter((e) => !e.id.startsWith('rs-all') && e.value).length);
  check('“Fill blanks” fills every region box with the market rate, keeping what you typed', filled === 15
    && (await t.page.inputValue('#rs-west-flatbed')) === '4.25' && (await t.page.inputValue('#rs-midwest-van')) === RATES.regions.midwest.van.toFixed(2),
    JSON.stringify({ filled, west: await t.page.inputValue('#rs-west-flatbed'), mwVan: await t.page.inputValue('#rs-midwest-van'), status: await text(t.page, '#rs-status') }));
  await t.page.click('#rs-clear-btn');
  check('Clear asks, then empties the sheet', /Clear your whole rate sheet\?/.test(t.db.dialogs.join('|'))
    && (await t.page.evaluate(() => [...document.querySelectorAll('#rs-grid input')].every((e) => !e.value))));
  await t.page.click('.save-btn');
  await t.page.waitForTimeout(400);
  check('saving an empty sheet saves null (market rates)', t.db.patches[t.db.patches.length - 1].rate_sheet === null);
  check('no page errors', t.errors.length === 0, t.errors.join(' | '));
  await t.page.setViewportSize({ width: 390, height: 844 });
  await t.page.evaluate(() => document.getElementById('rate-sheet-card').scrollIntoView());
  const overflow = await t.page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  check('the editor fits a phone screen', overflow <= 0, String(overflow));
  await t.page.$eval('#rate-sheet-card', (e) => e.scrollIntoView()).catch(() => {});
  const card = await t.page.$('#rate-sheet-card');
  if (card) await card.screenshot({ path: path.join(SHOTS, 'ratesheet-phone.png') }).catch(() => {});
  await t.context.close();

  console.log('\n=== Profile: Pro ===');
  t = await setup(browser, base, { row: ROW({ plan: 'pro', rate_sheet: SHEET }) });
  await t.page.goto(base + '/profile.html');
  await t.page.waitForFunction(() => getComputedStyle(document.getElementById('rs-locked')).display !== 'none' && document.getElementById('rs-all-van').value === '3.10');
  check('Pro: the editor is locked with what Pro Plus adds', await t.page.$eval('#rs-all-van', (e) => e.disabled)
    && /comes with Pro Plus/.test(await text(t.page, '#rs-locked')) && await t.page.$eval('#rs-fill-btn', (e) => e.disabled));
  await t.context.close();

  console.log('\n=== Profile: a team member ===');
  t = await setup(browser, base, { row: ROW({ id: 'user-2', email: 'jo@example.com', plan: 'max', stripe_customer_id: undefined, stripe_subscription_id: 'team', rate_sheet: SHEET }),
    team: { role: 'member', seated: true, company: 'Keystone Produce Logistics', owner_name: 'Sam Rivera', plan: 'max', size: 3, tag: 'JL' } });
  await t.page.goto(base + '/profile.html');
  await t.page.waitForFunction(() => document.body.classList.contains('pf-member'));
  await t.page.waitForTimeout(300);
  check('a team member sees the owner’s sheet, read-only', (await t.page.inputValue('#rs-all-van')) === '3.10'
    && await t.page.$eval('#rs-all-van', (e) => e.disabled) && await t.page.$eval('#rate-sheet-card', (e) => e.classList.contains('pf-locked')));
  await t.context.close();

  // ── Calculator: My rates ──────────────────────────────────────────────────
  console.log('\n=== Calculator: Pro Plus with a rate sheet ===');
  t = await setup(browser, base, { row: ROW({ rate_sheet: SHEET }) });
  await t.page.goto(base + '/index.html');
  await t.page.waitForFunction(() => typeof regionalRates !== 'undefined' && regionalRates && rateMode === 'sheet');
  check('My rates shows and is on', await t.page.isVisible('#btn-rate-sheet')
    && (await t.page.$eval('#btn-rate-sheet', (e) => e.style.color)) === 'var(--accent)');
  await t.page.fill('#origin', 'Scranton, PA');
  await t.page.dispatchEvent('#origin', 'input');
  await t.page.waitForTimeout(150);
  const ne3 = await rates(t.page);
  check('a Northeast pickup: all-regions van, the Northeast reefer, the market flatbed', ne3 === `3.10 3.90 ${RATES.regions.northeast.flatbed.toFixed(2)}`, ne3);
  check('the label and disclaimer say it’s your rate sheet', /Your rate sheet · Northeast \(PA\) · market rate where your sheet is blank/.test(await text(t.page, '#rate-region-label'))
    && /your rate sheet/.test(await text(t.page, '#rate-disclaimer')), await text(t.page, '#rate-region-label'));
  await t.page.fill('#origin', 'Fresno, CA');
  await t.page.dispatchEvent('#origin', 'input');
  await t.page.waitForTimeout(150);
  const west = await rates(t.page);
  check('a West pickup: all-regions van, market reefer and flatbed', west === `3.10 ${RATES.regions.west.reefer.toFixed(2)} ${RATES.regions.west.flatbed.toFixed(2)}`, west);
  await t.page.click('#btn-rate-regional');
  const market = await rates(t.page);
  check('Regional switches the quote to market rates', market === [RATES.regions.west.van, RATES.regions.west.reefer, RATES.regions.west.flatbed].map((x) => x.toFixed(2)).join(' ')
    && /Auto-applied/.test(await text(t.page, '#rate-region-label')), market);
  await t.page.click('#btn-rate-sheet');
  check('My rates switches back', (await rates(t.page)).startsWith('3.10 '));
  await t.page.click('#btn-rate-regional');
  await t.page.evaluate(() => clearShipmentForm());
  await t.page.waitForTimeout(150);
  check('clearing the form starts from your sheet again', (await t.page.evaluate(() => rateMode)) === 'sheet' && (await rates(t.page)).startsWith('3.10 '));
  check('no page errors', t.errors.length === 0, t.errors.join(' | '));
  await t.context.close();

  console.log('\n=== Calculator: no sheet, or on Pro ===');
  t = await setup(browser, base, { row: ROW({ rate_sheet: null }) });
  await t.page.goto(base + '/index.html');
  await t.page.waitForFunction(() => typeof regionalRates !== 'undefined' && regionalRates && typeof isProUser !== 'undefined' && isProUser);
  await t.page.waitForTimeout(300);
  check('without a sheet: no My rates, market rates as before', await t.page.isHidden('#btn-rate-sheet') && (await t.page.evaluate(() => rateMode)) !== 'sheet');
  await t.context.close();
  t = await setup(browser, base, { row: ROW({ plan: 'pro', rate_sheet: SHEET }) });
  await t.page.goto(base + '/index.html');
  await t.page.waitForFunction(() => typeof regionalRates !== 'undefined' && regionalRates && typeof isProUser !== 'undefined' && isProUser);
  await t.page.waitForTimeout(300);
  check('on Pro a saved sheet stays unused', await t.page.isHidden('#btn-rate-sheet') && (await t.page.evaluate(() => rateMode)) !== 'sheet');
  await t.context.close();

  // ── Multi-stop ────────────────────────────────────────────────────────────
  console.log('\n=== Multi-stop: Pro Plus with a rate sheet ===');
  t = await setup(browser, base, { row: ROW({ rate_sheet: SHEET }) });
  // The multi-stop page reads the account kept by the calculator
  await t.page.goto(base + '/index.html');
  await t.page.waitForFunction(() => { try { return !!JSON.parse(localStorage.getItem('qfc_pro_profile')).rateSheet; } catch (e) { return false; } });
  await t.page.goto(base + '/multistop.html');
  await t.page.waitForFunction(() => document.getElementById('ms-btn-sheet') && document.getElementById('ms-btn-sheet').style.display !== 'none' && typeof msRegionalRates !== 'undefined' && msRegionalRates);
  await t.page.waitForTimeout(200);
  await t.page.selectOption('#ms-trailer', 'van').catch(() => {});
  await t.page.evaluate(() => { onTrailerChange(); });
  await t.page.waitForTimeout(150);
  check('multi-stop starts from your sheet (all-regions van)', (await t.page.inputValue('#ms-rate')) === '3.10' && /Your rate sheet/.test(await text(t.page, '#ms-rate-label')), await t.page.inputValue('#ms-rate'));
  await t.page.click('#ms-btn-regional');
  await t.page.waitForTimeout(150);
  check('…and Regional switches it to the market rate', (await t.page.inputValue('#ms-rate')) !== '3.10', await t.page.inputValue('#ms-rate'));
  check('no page errors', t.errors.length === 0, t.errors.join(' | '));
  await t.context.close();

  await browser.close();
  server.close();
  console.log(`\nScreenshots: ${SHOTS}`);
  console.log(failures ? `\n${failures} FAILED` : '\nALL PASS');
  process.exit(failures ? 1 : 0);
})();
