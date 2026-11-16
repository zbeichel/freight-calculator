// tests/multistop_test.js — the multi-stop builder's totals in a real browser (needs Playwright
// with Chromium): removing stops, $0 stop and day charges, saving and loading a quote, and
// starting from your rate sheet when rate-sheet.js arrives late. Supabase and the Netlify
// functions are fakes. Run from the repository root:
//   node tests/multistop_test.js [folder for screenshots]
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { chromium } = require('playwright');
const ROOT = path.resolve(__dirname, '..');
const SHOTS = process.argv[2] || fs.mkdtempSync(path.join(os.tmpdir(), 'qfc-multistop-'));
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

// The fake geocoder's places and the fake router's miles between them.
const PLACES = {
  'lancaster, pa': { name: 'Lancaster, PA', city: 'Lancaster', state: 'PA', lat: 40.0379, lon: -76.3055 },
  'york, pa': { name: 'York, PA', city: 'York', state: 'PA', lat: 39.9626, lon: -76.7277 },
  'hanover, pa': { name: 'Hanover, PA', city: 'Hanover', state: 'PA', lat: 39.8007, lon: -76.983 },
};
const MILES = { 'Lancaster, PA|York, PA': 26, 'York, PA|Hanover, PA': 19, 'Lancaster, PA|Hanover, PA': 41 };

async function setup(browser, base, { plan = 'plus', rateSheet = null, sheetDelay = 0, sheetFails = false, log = null } = {}) {
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const calls = { routes: [], geocode: [], logPosts: [], dialogs: [] };
  const db = { rows: [] };
  await context.addInitScript(([profile, log]) => {
    if (localStorage.getItem('__seeded')) return;
    localStorage.setItem('__seeded', '1');
    localStorage.setItem('qfc_pro_profile', JSON.stringify(profile));
    localStorage.setItem('sb-xgrmbhmgcsbnazupfybd-auth-token', JSON.stringify({ access_token: 'tok', refresh_token: 'r',
      expires_at: Math.floor(Date.now() / 1000) + 3600, user: { id: 'user-1', email: 'sam@example.com' } }));
    if (log) localStorage.setItem('qfc_ms_quote_log', JSON.stringify(log));
  }, [{ plan, companyName: 'Keystone Produce Logistics', ...(rateSheet ? { rateSheet } : {}) }, log]);
  await context.route('**/*', async (route) => {
    const req = route.request();
    const url = req.url();
    const json = (b, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(b) });
    if (url.startsWith(base + '/rate-sheet.js')) {
      if (sheetFails) return route.abort();
      if (sheetDelay) await new Promise((r) => setTimeout(r, sheetDelay));
      return route.continue();
    }
    if (url.startsWith(base) && !url.includes('/.netlify/functions/')) return route.continue();
    if (url.includes('/.netlify/functions/verify-pro')) return json({ active: true, plan, paid: true, unlimitedUntilRenewal: false });
    if (url.includes('/.netlify/functions/geocode')) {
      const a = new URL(url).searchParams.get('address');
      calls.geocode.push(a);
      return json(PLACES[a.toLowerCase().replace(/\s+/g, ' ').trim()] || { error: 'No results' });
    }
    if (url.includes('/.netlify/functions/routes')) {
      const b = JSON.parse(req.postData());
      if (b.usage) return json({});   // the usage meter (plans-ui.js)
      const key = b.origin.replace(/, USA$/, '') + '|' + b.destination.replace(/, USA$/, '');
      calls.routes.push(key);
      const mi = MILES[key];
      return json(mi ? { routes: [{ distanceMeters: Math.round(mi * 1609.34) }] } : { routes: [] });
    }
    if (url.includes('/rest/v1/ms_quote_log')) {
      if (req.method() === 'POST') { const row = JSON.parse(req.postData()); calls.logPosts.push(row); db.rows.unshift(row); return route.fulfill({ status: 201, body: '' }); }
      return json(db.rows);
    }
    if (url.includes('/rest/v1/rpc/my_account')) return json({ row: null, team: null });
    if (url.includes('/.netlify/functions/')) return json({});
    if (url.includes('supabase.co')) return json([]);
    if (url.includes('fonts.googleapis.com') || url.includes('fonts.gstatic.com')) return route.continue();
    return route.abort();
  });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('dialog', async (d) => { calls.dialogs.push(d.message()); await d.accept(); });
  return { context, page, errors, calls, db };
}

const ready = (page) => page.waitForFunction(() => typeof stops !== 'undefined' && stops.length >= 2 && document.getElementById('stop-card-' + stops[0].id));
// Types a place into a stop and leaves the box, as a person would.
async function setStop(page, idx, text) {
  const id = await page.evaluate((i) => stops[i].id, idx);
  const sel = `#stop-card-${id} input[type="text"]`;
  await page.fill(sel, text);
  await page.$eval(sel, (e) => e.blur());
}
const totalMiles = (page) => page.textContent('#ms-total-miles');
const waitMiles = (page, want) => page.waitForFunction((w) => document.getElementById('ms-total-miles').textContent === w, want, { timeout: 8000 })
  .then(() => true, () => false);
const money = (s) => Number(String(s).replace(/[^0-9.]/g, '')) || 0;

(async () => {
  const server = await serve();
  const base = `http://127.0.0.1:${server.address().port}`;
  const browser = await chromium.launch();

  // ── Removing stops ──────────────────────────────────────────────────────
  console.log('\n=== Removing stops ===');
  let t = await setup(browser, base);
  await t.page.goto(base + '/multistop.html');
  await ready(t.page);
  await setStop(t.page, 0, 'lancaster pa');
  await setStop(t.page, 1, 'york pa');
  check('two stops: Lancaster → York is 26 mi', await waitMiles(t.page, '26 mi'), await totalMiles(t.page));
  await t.page.click('.add-btn-delivery');
  await setStop(t.page, 2, 'hanover pa');
  check('a third stop adds York → Hanover: 45 mi', await waitMiles(t.page, '45 mi'), await totalMiles(t.page));
  const q45 = money(await t.page.textContent('#ms-quote'));
  const lastId = await t.page.evaluate(() => stops[2].id);
  await t.page.click(`#stop-card-${lastId} .stop-remove`);
  check('removing the last stop takes its leg off the total: back to 26 mi', await waitMiles(t.page, '26 mi'), await totalMiles(t.page));
  const after = await t.page.evaluate(() => ({ quote: document.getElementById('ms-quote').textContent, miles: msLastCalc.totalMiles,
    badge: document.getElementById('leg-badge-' + stops[0].id).textContent, legs: Object.keys(legMiles).length }));
  check('…and the price follows (26 mi, below the 45-mi price), with one leg left', after.miles === 26 && money(after.quote) > 0 && money(after.quote) < q45
    && after.badge === '26 mi' && after.legs === 1, JSON.stringify(after));
  await t.page.click('.add-btn-delivery');
  await setStop(t.page, 2, 'hanover pa');
  check('adding it back: 45 mi again', await waitMiles(t.page, '45 mi'), await totalMiles(t.page));
  const midId = await t.page.evaluate(() => stops[1].id);
  const before = t.calls.routes.length;
  await t.page.click(`#stop-card-${midId} .stop-remove`);
  check('removing the middle stop routes Lancaster → Hanover directly: 41 mi', await waitMiles(t.page, '41 mi'), await totalMiles(t.page));
  check('…looking up only the new leg', t.calls.routes.slice(before).join(',') === 'Lancaster, PA|Hanover, PA', t.calls.routes.slice(before).join(','));
  check('no page errors', t.errors.length === 0, t.errors.join(' | '));
  await t.context.close();

  // ── $0 charges ──────────────────────────────────────────────────────────
  console.log('\n=== $0 stop fee and extra-day charge ===');
  t = await setup(browser, base);
  await t.page.goto(base + '/multistop.html');
  await ready(t.page);
  await setStop(t.page, 0, 'lancaster pa');
  await setStop(t.page, 1, 'york pa');
  await t.page.click('.add-btn-delivery');
  await setStop(t.page, 2, 'hanover pa');
  await waitMiles(t.page, '45 mi');
  await t.page.evaluate(() => adjustExtraDays(1));
  const withFees = await t.page.evaluate(() => ({ quote: document.getElementById('ms-quote').textContent, stops: msLastCalc.stopChargesTotal, days: msLastCalc.extraDayTotal }));
  check('the defaults: one extra stop at $150, one extra day at $200', withFees.stops === 150 && withFees.days === 200, JSON.stringify(withFees));
  await t.page.fill('#ms-stop-fee', '0');
  await t.page.fill('#ms-day-charge', '0');
  const zero = await t.page.evaluate(() => ({ quote: document.getElementById('ms-quote').textContent, stops: msLastCalc.stopChargesTotal, days: msLastCalc.extraDayTotal,
    stopsText: document.getElementById('ms-stop-charges-total').textContent, daysText: document.getElementById('ms-extra-day-charges').textContent,
    dayTotal: document.getElementById('ms-day-charge-total').textContent }));
  check('a $0 stop fee charges $0, not $150', zero.stops === 0 && zero.stopsText === '$0', JSON.stringify(zero));
  check('a $0 extra-day charge charges $0, not $200', zero.days === 0 && /1 day × \$0 = \$0/.test(zero.daysText) && zero.dayTotal === '$0', JSON.stringify(zero));
  check('the quote drops by the $350 in charges plus margin ($402.50)', Math.abs(money(withFees.quote) - money(zero.quote) - 402.5) <= 1, `${withFees.quote} → ${zero.quote}`);
  const chargeRow = await t.page.$eval('#charges-rows', (e) => e.innerText.replace(/\s+/g, ' '));
  check('the per-stop charges list shows $0 too', !/\$150/.test(chargeRow), chargeRow);
  await t.page.fill('#ms-stop-fee', '');
  const blank = await t.page.evaluate(() => msLastCalc.stopChargesTotal);
  check('a blank stop fee still uses the $150 default', blank === 150, String(blank));
  check('no page errors', t.errors.length === 0, t.errors.join(' | '));
  await t.context.close();

  // ── Save, then Load ─────────────────────────────────────────────────────
  console.log('\n=== Save and Load from the quote log ===');
  t = await setup(browser, base);
  await t.page.goto(base + '/multistop.html');
  await ready(t.page);
  await setStop(t.page, 0, 'lancaster pa');
  await setStop(t.page, 1, 'york pa');
  await t.page.click('.add-btn-delivery');
  await setStop(t.page, 2, 'hanover pa');
  await waitMiles(t.page, '45 mi');
  await t.page.fill('#ms-margin', '0');
  const saved = await t.page.evaluate(() => document.getElementById('ms-quote').textContent);
  await t.page.evaluate(() => saveMsQuote());
  await t.page.waitForFunction(() => getMsLog().length === 1);
  await t.page.waitForTimeout(300);
  const post = t.calls.logPosts[0] || {};
  check('the saved quote keeps each leg’s miles with its stop', JSON.stringify((post.stop_data || []).map((s) => s.legMiles || null)) === '[26,19,null]',
    JSON.stringify(post.stop_data));
  const id = await t.page.evaluate(() => getMsLog()[0].id);
  await t.page.reload();
  await ready(t.page);
  await t.page.waitForFunction(() => getMsLog().length === 1 && getMsLog()[0].stopData.length === 3);
  const routesBefore = t.calls.routes.length;
  await t.page.evaluate((i) => loadMsQuote(i), id);
  const loaded = await waitMiles(t.page, '45 mi');
  await t.page.waitForTimeout(1500);   // past the 900 ms lookup delay
  const back = await t.page.evaluate(() => ({ quote: document.getElementById('ms-quote').textContent, margin: document.getElementById('ms-margin').value,
    places: stops.map((s) => s.location).join(' → '), badges: stops.slice(0, -1).map((s) => document.getElementById('leg-badge-' + s.id).textContent).join(', ') }));
  check('Load brings back the stops, the miles and the total', loaded && back.quote === saved && back.places === 'Lancaster, PA → York, PA → Hanover, PA'
    && back.badges === '26 mi, 19 mi', JSON.stringify(back) + ' saved ' + saved);
  check('…using the saved miles (no new route lookups)', t.calls.routes.length === routesBefore, t.calls.routes.slice(routesBefore).join(','));
  check('…and a 0% margin stays 0% (synced from the account)', back.margin === '0', back.margin);
  const card = await t.page.evaluate((i) => {
    const c = document.getElementById('stop-card-' + stops[i].id);
    return { invalid: c.querySelector('input[type="text"]').classList.contains('invalid'), note: (document.getElementById('stop-note-' + stops[i].id) || {}).textContent || '' };
  }, 0);
  check('the loaded stops are checked places, ready to edit', !card.invalid, JSON.stringify(card));
  check('no page errors', t.errors.length === 0, t.errors.join(' | '));
  await t.context.close();

  console.log('\n=== Load a quote saved before leg miles were kept ===');
  const OLD = { id: 1731600000000, date: 'Nov 14, 26', route: 'Lancaster, PA → Hanover, PA (1 stops)', miles: 45, stopsCount: '1P / 2D',
    commodity: 'Standard', margin: '15%', quote: 999, rpm: '22.20', notes: '', trailer: 'reefer', commodityKey: 'standard', marginVal: 15, baseRate: 3.15,
    stopData: [{ type: 'pickup', location: 'Lancaster, PA', weight: '' }, { type: 'delivery', location: 'York, PA', weight: '' }, { type: 'delivery', location: 'Hanover, PA', weight: '' }] };
  t = await setup(browser, base, { log: [OLD] });
  await t.page.goto(base + '/multistop.html');
  await ready(t.page);
  await t.page.waitForTimeout(300);
  await t.page.evaluate((i) => loadMsQuote(i), OLD.id);
  check('the legs are looked up again and the total comes back', await waitMiles(t.page, '45 mi'), await totalMiles(t.page));
  check('…one lookup per leg', t.calls.routes.slice().sort().join(',') === 'Lancaster, PA|York, PA,York, PA|Hanover, PA', t.calls.routes.join(','));
  check('…and the quote shows a price', money(await t.page.textContent('#ms-quote')) > 0);
  check('no page errors', t.errors.length === 0, t.errors.join(' | '));
  await t.context.close();

  // ── Extra days and the stop dates ───────────────────────────────────────
  console.log('\n=== Extra days follow the stop dates ===');
  t = await setup(browser, base);
  await t.page.goto(base + '/multistop.html');
  await ready(t.page);
  await setStop(t.page, 0, 'lancaster pa');
  await setStop(t.page, 1, 'york pa');
  await t.page.click('.add-btn-delivery');
  await setStop(t.page, 2, 'hanover pa');
  await waitMiles(t.page, '45 mi');
  const days = () => t.page.evaluate(() => ({ count: document.getElementById('ms-extra-days-count').textContent, total: msLastCalc.extraDayTotal,
    shown: document.getElementById('ms-day-charges-row').style.display !== 'none', line: document.getElementById('ms-extra-day-charges').textContent }));
  const date = (i, d) => t.page.evaluate(([i, d]) => updateStopDate(stops[i].id, d), [i, d]);
  const noDates = money(await t.page.textContent('#ms-quote'));
  await date(0, '2026-11-20');
  await date(2, '2026-11-24');
  let dd = await days();
  check('pickup Nov 20, last delivery Nov 24 on a 45-mile route: 3 extra days, $600', dd.count === '3' && dd.total === 600 && dd.shown && /3 days × \$200 = \$600/.test(dd.line), JSON.stringify(dd));
  await t.page.evaluate(() => adjustExtraDays(-1));
  await t.page.fill('#ms-margin', '20');
  dd = await days();
  check('− takes one off, and it stays when something else changes', dd.count === '2' && dd.total === 400, JSON.stringify(dd));
  await t.page.fill('#ms-margin', '15');
  await date(2, '2026-11-25');
  dd = await days();
  check('a new delivery date sets them from the dates again (4 days)', dd.count === '4' && dd.total === 800, JSON.stringify(dd));
  await date(2, '');
  dd = await days();
  check('clearing the delivery date takes the extra days off the total', dd.count === '0' && dd.total === 0 && !dd.shown
    && money(await t.page.textContent('#ms-quote')) === noDates, JSON.stringify(dd));
  await t.page.evaluate(() => adjustExtraDays(1));
  dd = await days();
  check('without dates, + still adds a day by hand', dd.count === '1' && dd.total === 200, JSON.stringify(dd));
  check('no page errors', t.errors.length === 0, t.errors.join(' | '));
  await t.context.close();

  console.log('\n=== A stop changed to a place that can’t be found ===');
  t = await setup(browser, base);
  await t.page.goto(base + '/multistop.html');
  await ready(t.page);
  await setStop(t.page, 0, 'lancaster pa');
  await setStop(t.page, 1, 'york pa');
  await t.page.click('.add-btn-delivery');
  await setStop(t.page, 2, 'hanover pa');
  await waitMiles(t.page, '45 mi');
  await setStop(t.page, 1, 'zzqx plorb');
  check('its legs come off the total (no miles from the old place)', await waitMiles(t.page, '—'), await totalMiles(t.page));
  const bad = await t.page.evaluate(() => ({ invalid: stops[1].invalid, legs: Object.keys(legMiles).length, quote: document.getElementById('ms-quote').textContent }));
  check('…the stop is marked and there’s no quote', bad.invalid && bad.legs === 0 && bad.quote === '—', JSON.stringify(bad));
  await setStop(t.page, 1, 'york pa');
  check('putting a real place back brings the miles back', await waitMiles(t.page, '45 mi'), await totalMiles(t.page));
  check('no page errors', t.errors.length === 0, t.errors.join(' | '));
  await t.context.close();

  // ── The customer on saved quotes ────────────────────────────────────────
  console.log('\n=== The customer goes with saved quotes ===');
  t = await setup(browser, base);
  await t.page.goto(base + '/multistop.html');
  await ready(t.page);
  await setStop(t.page, 0, 'lancaster pa');
  await setStop(t.page, 1, 'york pa');
  await waitMiles(t.page, '26 mi');
  await t.page.fill('#ms-customer', 'Keystone Produce');
  await t.page.evaluate(() => { document.getElementById('ms-customer').dataset.customerId = '77'; saveMsQuote(); });
  await t.page.waitForFunction(() => getMsLog().length === 1);
  await t.page.waitForTimeout(300);
  const cpost = t.calls.logPosts[0] || {};
  check('Save sends the customer and, picked from the list, its id', cpost.customer === 'Keystone Produce' && cpost.customer_id === 77, JSON.stringify({ c: cpost.customer, id: cpost.customer_id }));
  check('the log row shows the customer', (await t.page.textContent('#ms-log-body .log-cust').catch(() => '')) === 'Keystone Produce');
  const cid = await t.page.evaluate(() => getMsLog()[0].id);
  await t.page.reload();
  await ready(t.page);
  await t.page.waitForFunction(() => getMsLog().length === 1 && getMsLog()[0].customer === 'Keystone Produce');
  await t.page.evaluate((i) => loadMsQuote(i), cid);
  check('Load puts the customer back in the box', (await t.page.inputValue('#ms-customer')) === 'Keystone Produce', await t.page.inputValue('#ms-customer'));
  check('no page errors', t.errors.length === 0, t.errors.join(' | '));
  await t.context.close();

  // ── Rate sheet arriving late ────────────────────────────────────────────
  console.log('\n=== Rate sheet: rate-sheet.js arrives 1.5 seconds late ===');
  const SHEET = { all: { van: 3.4, reefer: 3.4, flatbed: 3.4 } };
  for (let run = 1; run <= 3; run++) {
    t = await setup(browser, base, { rateSheet: SHEET, sheetDelay: 1500 });
    await t.page.goto(base + '/multistop.html');
    await ready(t.page);
    await t.page.waitForTimeout(200);
    const st = await t.page.evaluate(() => ({ rate: document.getElementById('ms-rate').value, btn: document.getElementById('ms-btn-sheet').style.display,
      on: document.getElementById('ms-btn-sheet').classList.contains('on'), label: document.getElementById('ms-rate-label').textContent }));
    check(`run ${run}: the quote starts from your rate sheet ($3.40), not the market rate`, st.rate === '3.40' && st.btn !== 'none' && st.on
      && /Your rate sheet/.test(st.label), JSON.stringify(st));
    check(`run ${run}: no page errors`, t.errors.length === 0, t.errors.join(' | '));
    await t.context.close();
  }

  console.log('\n=== No rate sheet saved and rate-sheet.js blocked ===');
  t = await setup(browser, base, { sheetFails: true });
  const t0 = Date.now();
  await t.page.goto(base + '/multistop.html', { waitUntil: 'commit' });
  await ready(t.page);
  const ms = Date.now() - t0;
  check('the page doesn’t wait for a sheet it doesn’t have (stops ready in under 2.5 s)', ms < 2500, ms + ' ms');
  check('…and starts from the market rate', (await t.page.inputValue('#ms-rate')) !== '3.40' && await t.page.isHidden('#ms-btn-sheet'));
  await t.page.screenshot({ path: path.join(SHOTS, 'multistop.png'), fullPage: false });
  await t.context.close();

  await browser.close();
  server.close();
  console.log(`\nScreenshots: ${SHOTS}`);
  console.log(failures ? `\n${failures} FAILED` : '\nALL PASS');
  process.exit(failures ? 1 : 0);
})();
