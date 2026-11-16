// tests/quote_box_test.js — the calculator's quote box and quote log in a real browser (needs
// Playwright with Chromium): the extra-transit-day charge, checks on what's typed in, which
// market rates the quote uses, the default pickup date, saving and loading quotes, the quote
// log's PDFs, deleting with Undo, and the route request behind the miles. Supabase and the
// Netlify functions are fakes. Run from the repository root:
//   node tests/quote_box_test.js [folder for screenshots]
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { chromium } = require('playwright');
const ROOT = path.resolve(__dirname, '..');
const SHOTS = process.argv[2] || fs.mkdtempSync(path.join(os.tmpdir(), 'qfc-quotebox-'));
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.json': 'application/json', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png' };
let failures = 0;
const check = (label, cond, detail) => { console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}${detail && !cond ? '  — ' + detail : ''}`); if (!cond) failures++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(cond, ms = 6000) { const end = Date.now() + ms; while (Date.now() < end) { if (await cond()) return true; await sleep(50); } return cond(); }

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

const ROW = { id: 'user-1', email: 'sam@example.com', company_name: 'Keystone Produce Logistics', contact_name: 'Sam Rivera', is_active: true, plan: 'plus',
  stripe_customer_id: 'cus_1', stripe_subscription_id: 'sub_1', quote_prefix: 'KPL', quote_counter: 2041 };
const PLACES = {
  'hastings fl': { name: 'Hastings, FL 32145', city: 'Hastings', state: 'FL', zip: '32145', lat: 29.71802479999999, lon: -81.5081338 },
  'lancaster pa': { name: 'Lancaster, PA', city: 'Lancaster', state: 'PA', lat: 40.0403279, lon: -76.30418329999999 },
};
const placeKey = (t) => String(t || '').toLowerCase().replace(/[.,]/g, ' ').replace(/\b\d{5}\b/g, '').replace(/\s+/g, ' ').trim();

async function setup(browser, base, { profile = {}, row = {}, quotes = [], geocodeDown = [], contextOpts = {}, clock = null } = {}) {
  const account = Object.assign({}, ROW, row);
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, ...contextOpts });
  if (clock) await context.clock.setFixedTime(clock);
  const db = { quotes: quotes.slice(), posts: [], deletes: [], routes: [], dialogs: [], nextId: 501 };
  await context.addInitScript((profile) => {
    if (localStorage.getItem('__seeded')) return;
    localStorage.setItem('__seeded', '1');
    localStorage.setItem('sb-xgrmbhmgcsbnazupfybd-auth-token', JSON.stringify({ access_token: 'tok', refresh_token: 'r',
      expires_at: Math.floor(Date.now() / 1000) + 3600, user: { id: 'user-1', email: 'sam@example.com' } }));
    localStorage.setItem('qfc_pro_profile', JSON.stringify(Object.assign({ companyName: 'Keystone Produce Logistics', contactName: 'Sam Rivera',
      quotePrefix: 'KPL', quoteStart: 2041, plan: 'plus' }, profile)));
  }, profile);
  await context.route('**/*', async (route) => {
    const req = route.request();
    const url = req.url();
    const json = (b, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(b) });
    if (url.startsWith('blob:') || (url.startsWith(base) && !url.includes('/.netlify/functions/'))) return route.continue();
    if (url.includes('/.netlify/functions/verify-pro')) return json({ active: true, plan: 'plus', paid: true, unlimitedUntilRenewal: false });
    if (url.includes('/.netlify/functions/geocode')) {
      const a = new URL(url).searchParams.get('address');
      if (geocodeDown.includes(placeKey(a))) return route.abort();
      return json(PLACES[placeKey(a)] || { error: 'No results' });
    }
    if (url.includes('/.netlify/functions/routes')) {
      const b = JSON.parse(req.postData() || '{}');
      if (b.usage) return json({ usage: { used: 1, limit: 250, plan: 'plus' } });
      db.routes.push(b);
      const legs = b.includeLegs ? [{ startLocation: { latLng: { latitude: 29.7, longitude: -81.5 } }, endLocation: { latLng: { latitude: 40.04, longitude: -76.3 } } }] : undefined;
      return json({ routes: [Object.assign({ distanceMeters: Math.round((b.includeLegs ? 882 : 877) * 1609.34), duration: '46789s' }, legs ? { legs } : {})] });
    }
    if (url.includes('/.netlify/functions/diesel-price')) return json({ error: 'off in this test' }, 502);
    if (url.includes('/.netlify/functions/')) return json({});
    if (url.includes('/rest/v1/rpc/my_account')) return json({ row: account, team: null });
    if (url.includes('/rest/v1/quote_log')) {
      if (req.method() === 'POST') {
        const row = Object.assign({ id: db.nextId++, created_at: new Date().toISOString() }, JSON.parse(req.postData() || '{}'));
        db.posts.push(row); db.quotes.unshift(row);
        return json([row], 201);
      }
      if (req.method() === 'DELETE') {
        const q = new URL(url).search;
        db.deletes.push(q);
        const id = (q.match(/id=eq\.(\d+)/) || [])[1];
        const gone = db.quotes.filter((r) => String(r.id) === id);
        db.quotes = db.quotes.filter((r) => String(r.id) !== id);
        return json(gone);
      }
      return json(db.quotes);
    }
    if (url.includes('/rest/v1/pro_users')) return req.method() === 'GET' ? json([account]) : route.fulfill({ status: 204, body: '' });
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
const openCalc = async (t, base) => {
  await t.page.goto(base + '/index.html');
  await t.page.waitForFunction(() => typeof regionalRates !== 'undefined' && regionalRates !== null && typeof isProUser !== 'undefined' && isProUser && window.QFCQuotePDF);
  await t.page.waitForTimeout(300);
};
const money = (s) => Number(String(s || '').replace(/[^0-9.-]/g, '')) || 0;
const box = (page) => page.evaluate(() => {
  const v = (id) => (document.getElementById(id) || {}).textContent || '';
  return { quote: v('r-quote'), cost: v('r-cost'), extra: v('r-extra'), extraShown: document.getElementById('r-extra-row').style.display !== 'none',
    margin: v('r-margin'), problem: document.getElementById('r-problem').hidden ? '' : v('r-problem'),
    added: document.getElementById('transit-added-badge').style.display === 'flex' };
});
// A lane typed in with miles entered (no lookup), dates and margin
const lane = (page, o = {}) => page.evaluate((o) => {
  const set = (id, v) => { document.getElementById(id).value = v; };
  set('origin', o.origin || 'Hastings, FL'); set('dest', 'Lancaster, PA');
  set('miles', o.miles || 882); set('weight', o.weight || 42000); set('trailer', o.trailer || 'van'); set('commodity', 'standard');
  set('margin', o.margin != null ? o.margin : 18); set('pickup', o.pickup || '2026-11-20'); set('delivery', o.delivery != null ? o.delivery : '2026-11-27');
  manualMiles = true;
  calc(); calcTransit();
}, o);
const setVal = (page, id, v, ev = 'input') => page.evaluate(([id, v, ev]) => { const e = document.getElementById(id); e.value = v; e.dispatchEvent(new Event(ev)); }, [id, v, ev]);

(async () => {
  const server = await serve();
  const base = `http://127.0.0.1:${server.address().port}`;
  const browser = await chromium.launch();

  // ── The extra-day charge ──────────────────────────────────────────────
  console.log('\n=== Quote box: extra transit days ===');
  let t = await setup(browser, base);
  await openCalc(t, base);
  await lane(t.page);
  let b = await box(t.page);
  check('before adding: no extra-day line, cost + margin = quote', !b.extraShown && Math.abs(money(b.cost) * 1.18 - money(b.quote)) <= 1, JSON.stringify(b));
  const plain = money(b.quote);
  await t.page.click('#transit-add-btn');
  b = await box(t.page);
  check('added: 5 extra days × $200 = $1,000 on its own line', b.extraShown && b.extra === '$1,000' && b.added, JSON.stringify(b));
  const marginAmt = money(b.margin.split('(')[1]);
  check('the margin covers the extra days too, and the lines add up to the quote',
    Math.abs(marginAmt - (money(b.cost) + 1000) * 0.18) <= 1 && Math.abs(money(b.cost) + 1000 + marginAmt - money(b.quote)) <= 1, JSON.stringify(b));
  await setVal(t.page, 'extra-day-rate', '0');
  b = await box(t.page);
  check('a $0 extra-day rate charges $0 (not $200)', !b.extraShown && money(b.quote) === plain, JSON.stringify(b));
  await setVal(t.page, 'extra-day-rate', '150');
  b = await box(t.page);
  check('changing the rate after adding updates the quote ($750)', b.extra === '$750' && Math.abs(money(b.quote) - (plain + 750 * 1.18)) <= 1, JSON.stringify(b));
  await setVal(t.page, 'delivery', '2026-11-25', 'change');
  b = await box(t.page);
  check('a shorter window: 3 extra days, $450', b.extra === '$450', JSON.stringify(b));
  await setVal(t.page, 'delivery', '', 'change');
  b = await box(t.page);
  check('clearing the delivery date takes the charge off', !b.extraShown && !b.added && money(b.quote) === plain, JSON.stringify(b));
  await setVal(t.page, 'delivery', '2026-11-27', 'change');
  b = await box(t.page);
  check('…and it isn’t quietly added back with a new date', !b.extraShown && money(b.quote) === plain && await t.page.isVisible('#transit-add-btn'), JSON.stringify(b));
  check('no page errors', t.errors.length === 0, t.errors.join(' | '));
  await t.context.close();

  // ── Checks on what's typed ────────────────────────────────────────────
  console.log('\n=== Quote box: boxes the quote can’t be priced from ===');
  t = await setup(browser, base);
  await openCalc(t, base);
  await lane(t.page, { delivery: '' });
  const good = (await box(t.page)).quote;
  for (const [label, id, value, ev, want] of [
    ['negative weight', 'weight', '-500', 'input', /Weight has to be more than 0/],
    ['a weight of 0', 'weight', '0', 'input', /Weight has to be more than 0/],
    ['a negative margin', 'margin', '-10', 'input', /Margin has to be between 0% and 100%/],
    ['a margin over 100%', 'margin', '150', 'input', /Margin has to be between 0% and 100%/],
    ['delivery before pickup', 'delivery', '2026-11-18', 'change', /delivery date is before the pickup date/],
    ['a blank base rate', 'rate-van', '', 'input', /Enter a base rate per mile for Dry Van/],
    ['a $0 base rate', 'rate-van', '0', 'input', /Enter a base rate per mile for Dry Van/],
  ]) {
    const before = await t.page.inputValue('#' + id);
    await setVal(t.page, id, value, ev);
    b = await box(t.page);
    const marked = await t.page.$eval('#' + id, (e) => e.getAttribute('aria-invalid') === 'true');
    check(`${label}: no quote, the box marked and why`, b.quote === '—' && want.test(b.problem) && marked && b.margin === '—', JSON.stringify(b));
    await setVal(t.page, id, before, ev);
    b = await box(t.page);
    check(`…fixing it brings the quote back`, b.quote === good && !b.problem && !(await t.page.$eval('#' + id, (e) => e.hasAttribute('aria-invalid'))), JSON.stringify(b));
  }
  await setVal(t.page, 'margin', '-10');
  await t.page.evaluate(() => saveQuote());
  await t.page.waitForTimeout(300);
  check('Save with a problem: refused, says why', t.db.posts.length === 0 && /Margin has to be between/.test(await t.page.textContent('#save-toast')));
  await t.page.evaluate(() => generateQuotePDF());
  await t.page.waitForTimeout(200);
  check('PDF with a problem: refused, says why', /Margin has to be between/.test(t.db.dialogs.join('|')), t.db.dialogs.join('|'));
  await setVal(t.page, 'margin', '18');
  await t.page.evaluate(() => setShipType('ltl'));
  await setVal(t.page, 'weight', '20000');
  b = await box(t.page);
  check('LTL over 15,000 lbs: said, not quietly priced at 15,000', b.quote === '—' && /LTL is priced up to 15,000 lbs/.test(b.problem), JSON.stringify(b));
  await setVal(t.page, 'weight', '12000');
  b = await box(t.page);
  check('…12,000 lbs prices', b.quote !== '—' && !b.problem, JSON.stringify(b));
  await t.page.evaluate(() => setShipType('ftl'));
  await t.page.locator('.result-card:not(#prof-result-card)').screenshot({ path: path.join(SHOTS, 'quote-box.png') }).catch(() => {});
  check('no page errors', t.errors.length === 0, t.errors.join(' | '));
  await t.context.close();

  // ── Which market rates ────────────────────────────────────────────────
  console.log('\n=== Quote box: which market rates it uses ===');
  t = await setup(browser, base);
  await openCalc(t, base);
  await setVal(t.page, 'origin', 'Hastings, FL');
  const disc = () => t.page.$eval('#rate-disclaimer', (e) => e.textContent.replace(/\s+/g, ' '));
  check('a Florida pickup: the Southeast region’s rates, said as such', /based on current SOUTHEAST REGION market rates/.test(await disc()), await disc());
  await setVal(t.page, 'origin', 'Lancaster, PA');
  check('a Pennsylvania pickup: the Northeast region', /NORTHEAST REGION/.test(await disc()), await disc());
  await t.page.evaluate(() => setRateMode('national'));
  check('National Avg: US AVERAGE', /based on current US AVERAGE market rates/.test(await disc()), await disc());
  await t.context.close();

  // ── The default pickup date in the evening ───────────────────────────
  console.log('\n=== Default pickup date: the local day ===');
  t = await setup(browser, base, { contextOpts: { timezoneId: 'America/New_York' }, clock: new Date('2026-11-17T02:30:00Z') });   // 9:30 PM Nov 16 in New York
  await openCalc(t, base);
  check('9:30 PM in New York: pickup defaults to today (Nov 16), not tomorrow', (await t.page.inputValue('#pickup')) === '2026-11-16', await t.page.inputValue('#pickup'));
  await t.page.evaluate(() => clearShipmentForm());
  check('…and after clearing the form', (await t.page.inputValue('#pickup')) === '2026-11-16', await t.page.inputValue('#pickup'));
  await t.context.close();

  // ── Save, Load, and the log's PDF ─────────────────────────────────────
  console.log('\n=== Quote log: saved as priced, loaded as saved ===');
  t = await setup(browser, base);
  await openCalc(t, base);
  await lane(t.page);
  await t.page.evaluate(() => {
    document.getElementById('diesel-enabled').checked = true; dieselSource = 'manual';
    document.getElementById('diesel-price').value = '6.13';
    setMilesSource('google'); lastDriveSecs = 46789; lastDriveText = '13 hr';
    addTransitCharge();
  });
  const priced = await box(t.page);
  const [calcTab] = await Promise.all([t.context.waitForEvent('page'), t.page.evaluate(() => generateQuotePDF())]);
  await calcTab.waitForLoadState('load');
  const lines = (tab) => tab.$$eval('.line-item', (els) => els.map((e) => e.innerText.replace(/\s+/g, ' ').trim()));
  const transitText = (tab) => tab.$eval('.transit', (e) => e.innerText.replace(/\s+/g, ' ').trim()).catch(() => '');
  const calcLines = await lines(calcTab), calcTransit = await transitText(calcTab);
  await t.page.evaluate(() => saveQuote());
  await until(() => t.db.posts.length >= 1);
  const det = (t.db.posts[0] || {}).details || {};
  check('Save keeps how it was priced: fuel $0.75/mi, 5 extra days at $200 ($1,000), the drive time', det.v === 1 && det.fsc === 0.75 && det.extra === 1000
    && det.extraDays === 5 && det.extraRate === 200 && det.driveSecs === 46789, JSON.stringify(det));
  const id = await t.page.evaluate(() => quoteLog[0].id);
  const [logTab] = await Promise.all([t.context.waitForEvent('page'), t.page.evaluate((i) => generateQuotePDFFromLog(i), id)]);
  await logTab.waitForLoadState('load');
  const logLines = await lines(logTab), logTransit = await transitText(logTab);
  check('the log’s PDF has the same lines as the calculator’s (fuel, extra days)', calcLines.length === 3 && JSON.stringify(logLines) === JSON.stringify(calcLines),
    JSON.stringify(calcLines) + ' vs ' + JSON.stringify(logLines));
  check('…and the same driving time', calcTransit && logTransit === calcTransit, calcTransit + ' vs ' + logTransit);
  const metaValid = await logTab.$eval('.meta', (e) => e.textContent.replace(/\s+/g, ' ')).catch(() => '');
  check('Modern PDFs say the time zone after "Valid until"', /Valid until\s*[A-Z][a-z]{2} \d+, \d{4}, \d+:\d{2} [AP]M [A-Z]{2,5}\b/.test(metaValid), metaValid);
  await t.page.evaluate(() => clearShipmentForm());
  await t.page.evaluate((i) => loadQuoteIntoCalc(i), id);
  await t.page.waitForTimeout(200);
  b = await box(t.page);
  check('Load brings back the extra days and the same price', b.extra === '$1,000' && b.added && b.quote === priced.quote
    && await t.page.$eval('#r-saved-note', (e) => e.hidden), JSON.stringify(b) + ' saved ' + priced.quote);
  await t.page.evaluate(() => { document.getElementById('diesel-enabled').checked = false; toggleDiesel(); });
  await t.page.evaluate((i) => loadQuoteIntoCalc(i), id);
  await t.page.waitForTimeout(200);
  const note = await t.page.$eval('#r-saved-note', (e) => e.hidden ? '' : e.textContent);
  check('loaded with different settings today (fuel off): says it was saved at a different price', new RegExp(`Saved at \\${priced.quote}`).test(note)
    && /Today’s rates and settings price it at \$[\d,]+/.test(note) && (await box(t.page)).quote !== priced.quote, note);
  await t.page.fill('#margin', '20');
  check('…until the quote is changed', await t.page.$eval('#r-saved-note', (e) => e.hidden));
  check('no page errors', t.errors.length === 0, t.errors.join(' | '));
  await t.context.close();

  console.log('\n=== Classic PDFs: valid until, dates ===');
  t = await setup(browser, base, { profile: { pdfStyle: 'classic' }, row: { pdf_style: 'classic' } });
  await openCalc(t, base);
  await lane(t.page);
  const [cTab] = await Promise.all([t.context.waitForEvent('page'), t.page.evaluate(() => generateQuotePDF())]);
  await cTab.waitForLoadState('load');
  const cText = (await cTab.textContent('body')).replace(/\s+/g, ' ');
  check('Classic calculator PDF: "Valid until" with the date, time and time zone', /Valid until: [A-Z][a-z]{2} \d+, \d{4}, \d+:\d{2} [AP]M [A-Z]{2,5}\b/.test(cText), cText.slice(0, 300));
  await t.page.evaluate(() => saveQuote());
  await until(() => t.db.posts.length >= 1);
  const cid = await t.page.evaluate(() => quoteLog[0].id);
  const [lTab] = await Promise.all([t.context.waitForEvent('page'), t.page.evaluate((i) => generateQuotePDFFromLog(i), cid)]);
  await lTab.waitForLoadState('load');
  const lText = (await lTab.textContent('body')).replace(/\s+/g, ' ');
  check('Classic quote-log PDF: "Valid until" too, and dates as "Fri, Nov 20" (not 2026-11-20)', /Valid until: [A-Z][a-z]{2} \d+, \d{4}/.test(lText)
    && lText.includes('Fri, Nov 20') && !lText.includes('2026-11-20'), lText.slice(0, 400));
  await t.context.close();

  // ── Deleting from the quote log ───────────────────────────────────────
  console.log('\n=== Quote log: delete with Undo ===');
  const Q = (id, o) => Object.assign({ id, user_id: 'user-1', date: 'Nov 15, 26', origin: 'Columbus, OH', destination: 'Atlanta, GA', miles: 571, trailer: 'van',
    commodity: 'Standard Freight', margin: '15%', base_rpm: '2.73', quote: 1890, rpm: '3.31', tracked: true, created_at: '2026-11-15T15:00:00Z' }, o);
  t = await setup(browser, base, { quotes: [Q(301), Q(302, { origin: 'Harrisburg, PA', destination: 'Boston, MA' })] });
  await openCalc(t, base);
  await t.page.waitForFunction(() => quoteLog.length === 2);
  await t.page.click('#log-body tr:first-child .del-btn');
  check('✕ takes it off the log at once, with Undo; nothing deleted yet', (await t.page.evaluate(() => quoteLog.map((q) => q.id).join())) === '302'
    && await t.page.isVisible('#undo-toast.show') && t.db.deletes.length === 0);
  await t.page.click('#undo-toast .undo-btn');
  check('Undo puts it back in its place', (await t.page.evaluate(() => quoteLog.map((q) => q.id).join())) === '301,302' && t.db.deletes.length === 0
    && !(await t.page.isVisible('#undo-toast.show')));
  await t.page.click('#log-body tr:first-child .del-btn');
  await sleep(6600);
  check('left alone, it’s deleted from the account after a few seconds', t.db.deletes.join() === '?id=eq.301' && !(await t.page.isVisible('#undo-toast.show')), t.db.deletes.join());
  check('no page errors', t.errors.length === 0, t.errors.join(' | '));
  await t.context.close();

  // ── The route request ─────────────────────────────────────────────────
  console.log('\n=== Miles: the same route request as the other pages ===');
  t = await setup(browser, base);
  await openCalc(t, base);
  await t.page.fill('#origin', 'hastings fl');
  await t.page.fill('#dest', 'lancaster pa');
  await t.page.$eval('#dest', (e) => e.blur());
  await until(() => t.db.routes.length >= 1);
  await t.page.waitForFunction(() => document.getElementById('miles').value !== '');
  const r1 = t.db.routes[0] || {};
  check('both places checked: routed between their coordinates, without asking for the legs (as Bulk and multi-stop do)', !r1.includeLegs
    && r1.originLatLng && Math.abs(r1.originLatLng.lat - 29.718) < 0.001 && r1.destinationLatLng && Math.abs(r1.destinationLatLng.lat - 40.04) < 0.001, JSON.stringify(r1));
  check('…877 miles, and the weather gets the checked points', (await t.page.inputValue('#miles')) === '877'
    && await t.page.evaluate(() => !!(origCoords && Math.abs(origCoords.lat - 29.718) < 0.001 && destCoords && Math.abs(destCoords.lat - 40.04) < 0.001)));
  check('the status says Google Maps', /877 miles · .* drive \(Google Maps\)/.test(await t.page.textContent('#miles-status-text').catch(() => '')) || /Google Maps/.test(await t.page.textContent('#miles-status-row')));
  await t.context.close();
  t = await setup(browser, base, { geocodeDown: ['lancaster pa'] });
  await openCalc(t, base);
  await t.page.fill('#origin', 'hastings fl');
  await t.page.fill('#dest', 'lancaster pa');
  await t.page.$eval('#dest', (e) => e.blur());
  await until(() => t.db.routes.length >= 1);
  const r2 = t.db.routes[0] || {};
  check('a place that couldn’t be checked (lookup down): routed by its text, with the legs for its point', r2.includeLegs === true && !r2.destinationLatLng, JSON.stringify(r2));
  await t.context.close();

  await browser.close();
  server.close();
  console.log(`\nScreenshots: ${SHOTS}`);
  console.log(failures ? `\n${failures} FAILED` : '\nALL PASS');
  process.exit(failures ? 1 : 0);
})();
