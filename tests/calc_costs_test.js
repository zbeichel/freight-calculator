// tests/calc_costs_test.js — the calculator's cost inputs in a real browser (needs Playwright with
// Chromium): Profitability's default costs when a box is left blank, and the diesel price behind
// the FTL and LTL fuel surcharges (this week's EIA price, not the old $3.85 placeholder).
// Supabase and the Netlify functions are fakes. Run from the repository root:
//   node tests/calc_costs_test.js [folder for screenshots]
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { chromium } = require('playwright');
const ROOT = path.resolve(__dirname, '..');
const SHOTS = process.argv[2] || fs.mkdtempSync(path.join(os.tmpdir(), 'qfc-costs-'));
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

// This week's EIA diesel: $5.92 national, $6.13 East Coast.
const DIESEL = { NUS: 5.92, R10: 6.13, R20: 5.71, R30: 5.55, R40: 5.88, R50: 6.6 };
const ROW = { id: 'user-1', email: 'sam@example.com', is_active: true, plan: 'plus', stripe_customer_id: 'cus_1', stripe_subscription_id: 'sub_1' };

async function setup(browser, base, { diesel = true, saved = null } = {}) {
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const calls = { diesel: [] };
  await context.addInitScript(([saved]) => {
    if (localStorage.getItem('__seeded')) return;
    localStorage.setItem('__seeded', '1');
    localStorage.setItem('sb-xgrmbhmgcsbnazupfybd-auth-token', JSON.stringify({ access_token: 'tok', refresh_token: 'r',
      expires_at: Math.floor(Date.now() / 1000) + 3600, user: { id: 'user-1', email: 'sam@example.com' } }));
    if (saved) localStorage.setItem('frc_diesel', JSON.stringify(saved));
  }, [saved]);
  await context.route('**/*', async (route) => {
    const req = route.request();
    const url = req.url();
    const json = (b, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(b) });
    if (url.startsWith(base) && !url.includes('/.netlify/functions/')) return route.continue();
    if (url.includes('/.netlify/functions/diesel-price')) {
      const region = new URL(url).searchParams.get('region') || 'NUS';
      calls.diesel.push(region);
      if (!diesel) return json({ error: 'EIA unavailable' }, 502);
      return json({ price: DIESEL[region], period: '20261109', region });
    }
    if (url.includes('/.netlify/functions/verify-pro')) return json({ active: true, plan: 'plus', paid: true, unlimitedUntilRenewal: false });
    if (url.includes('/rest/v1/rpc/my_account')) return json({ row: ROW, team: null });
    if (url.includes('/rest/v1/pro_users')) return json([ROW]);
    if (url.includes('/.netlify/functions/')) return json({});
    if (url.includes('supabase.co')) return json([]);
    if (url.includes('fonts.googleapis.com') || url.includes('fonts.gstatic.com')) return route.continue();
    return route.abort();
  });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  return { context, page, errors, calls };
}
const open = async (t, base) => {
  await t.page.goto(base + '/index.html');
  await t.page.waitForFunction(() => typeof regionalRates !== 'undefined' && regionalRates !== null && typeof calcProfit === 'function');
  await t.page.waitForTimeout(300);
};
const prof = (page) => page.evaluate(() => ({
  verdict: document.getElementById('p-verdict').textContent.trim(), cpm: document.getElementById('pv-cpm').textContent,
  cost: document.getElementById('pv-cost').textContent, note: ((document.getElementById('p-defaults-note') || {}).textContent || '').trim(),
  fuelHint: document.getElementById('p-fuel').placeholder, driverHint: document.getElementById('p-driver').placeholder,
  fixedHint: document.getElementById('p-fixed').placeholder,
}));
const setVal = (page, id, v) => page.evaluate(([id, v]) => { const e = document.getElementById(id); e.value = v; e.dispatchEvent(new Event('input')); }, [id, v]);

(async () => {
  const server = await serve();
  const base = `http://127.0.0.1:${server.address().port}`;
  const browser = await chromium.launch();

  // ── Profitability ───────────────────────────────────────────────────────
  console.log('\n=== Profitability: blank cost boxes ===');
  let t = await setup(browser, base);
  await open(t, base);
  await t.page.evaluate(() => setShipType('prof'));
  await t.page.waitForFunction(() => /National avg \$5\.92/.test(document.getElementById('ltl-diesel-status').textContent), null, { timeout: 5000 }).catch(() => {});
  await setVal(t.page, 'p-miles', '500');
  await setVal(t.page, 'p-rate', '700');   // $1.40 a mile
  let p = await prof(t.page);
  check('blank boxes use the stated defaults: fuel $0.91 (this week’s $5.92 ÷ 6.5 MPG), driver $0.55, fixed $0.30 = $1.76/mi',
    p.cpm === '$1.76' && p.cost === '$880', JSON.stringify(p));
  check('a $700 load over 500 miles loses money: Decline, not Accept', /^✗ Decline — loses \$180/.test(p.verdict), p.verdict);
  check('the note and the boxes say which defaults are in use', p.note === 'Blank costs use the defaults: $0.91 fuel · $0.55 driver · $0.30 fixed per mile. Adjust to your actual costs.'
    && p.fuelHint === '0.91 (default)' && p.driverHint === '0.55 (default)' && p.fixedHint === '0.30 (default)', JSON.stringify(p));
  await setVal(t.page, 'p-empty', '100');
  p = await prof(t.page);
  check('dead-head miles cost money: 100 empty miles add $176', p.cost === '$1,056' && /loses \$356/.test(p.verdict), JSON.stringify(p));
  await setVal(t.page, 'p-empty', '0');
  await setVal(t.page, 'p-rate', '1400');
  p = await prof(t.page);
  check('a well-paid load is still an Accept', /^✓ Accept — \$520 net profit/.test(p.verdict), p.verdict);
  await setVal(t.page, 'p-driver', '0.70');
  await setVal(t.page, 'p-fixed', '0');
  p = await prof(t.page);
  check('what you type replaces a default, and 0 means 0', p.cpm === '$1.61' && p.cost === '$805', JSON.stringify(p));
  check('no page errors', t.errors.length === 0, t.errors.join(' | '));
  await t.page.screenshot({ path: path.join(SHOTS, 'profitability.png') });
  await t.context.close();

  console.log('\n=== Profitability: EIA unavailable ===');
  t = await setup(browser, base, { diesel: false });
  await open(t, base);
  await t.page.evaluate(() => setShipType('prof'));
  await t.page.waitForFunction(() => /Could not fetch/.test(document.getElementById('ltl-diesel-status').textContent), null, { timeout: 5000 }).catch(() => {});
  await setVal(t.page, 'p-miles', '500');
  await setVal(t.page, 'p-rate', '700');
  p = await prof(t.page);
  check('without a live price, fuel falls back to the stated $0.58 (not $0.59 from the old $3.85)', p.cpm === '$1.43' && /\$0\.58 fuel/.test(p.note), JSON.stringify(p));
  await t.context.close();

  // ── FTL diesel surcharge ────────────────────────────────────────────────
  console.log('\n=== FTL fuel surcharge ===');
  t = await setup(browser, base);
  await open(t, base);
  check('the price box starts at the $3.85 placeholder', (await t.page.inputValue('#diesel-price')) === '3.85');
  await t.page.evaluate(() => { const c = document.getElementById('diesel-enabled'); c.checked = true; c.dispatchEvent(new Event('change')); });
  await t.page.waitForFunction(() => document.getElementById('diesel-price').value === '6.13', null, { timeout: 5000 }).catch(() => {});
  let d = await t.page.evaluate(() => ({ price: document.getElementById('diesel-price').value, fsc: getDieselFSC(), status: document.getElementById('eia-status').textContent,
    shown: document.getElementById('diesel-fsc-display').textContent, saved: JSON.parse(localStorage.getItem('frc_diesel') || '{}') }));
  check('turning the surcharge on fills in this week’s East Coast price ($6.13)', d.price === '6.13' && /\$6\.13\/gal · East Coast/.test(d.status), JSON.stringify(d));
  check('…so the surcharge is $0.75/mi, not $0.40', d.fsc === 0.75 && /\+\$0\.75\/mile FSC at \$6\.13\/gal/.test(d.shown), JSON.stringify(d));
  check('…and it’s remembered as the live price', d.saved.price === '6.13' && d.saved.source === 'live' && d.saved.enabled === true, JSON.stringify(d.saved));
  await t.page.evaluate(() => { const c = document.getElementById('diesel-enabled'); c.checked = false; c.dispatchEvent(new Event('change')); c.checked = true; c.dispatchEvent(new Event('change')); });
  await t.page.waitForTimeout(400);
  check('turning it off and on again doesn’t ask EIA twice', t.calls.diesel.filter((r) => r === 'R10').length === 1, t.calls.diesel.join(','));
  check('no page errors', t.errors.length === 0, t.errors.join(' | '));
  await t.context.close();

  console.log('\n=== FTL: a price you typed stays ===');
  t = await setup(browser, base, { saved: { price: '4.50', source: 'manual', region: 'R10', enabled: true } });
  await open(t, base);
  await t.page.waitForTimeout(600);
  d = await t.page.evaluate(() => ({ price: document.getElementById('diesel-price').value, fsc: getDieselFSC() }));
  check('a typed $4.50 isn’t replaced on the next visit', d.price === '4.50' && d.fsc === 0.5 && !t.calls.diesel.includes('R10'), JSON.stringify(d) + ' ' + t.calls.diesel.join(','));
  await t.context.close();
  t = await setup(browser, base);
  await open(t, base);
  await t.page.evaluate(() => { const c = document.getElementById('diesel-enabled'); c.checked = true; c.dispatchEvent(new Event('change')); });
  await t.page.waitForFunction(() => document.getElementById('diesel-price').value === '6.13', null, { timeout: 5000 }).catch(() => {});
  await setVal(t.page, 'diesel-price', '4.25');
  const typed = await t.page.evaluate(() => JSON.parse(localStorage.getItem('frc_diesel')));
  check('typing a price saves it as yours', typed.price === '4.25' && typed.source === 'manual', JSON.stringify(typed));
  await t.context.close();

  console.log('\n=== FTL: an old saved price is refreshed ===');
  t = await setup(browser, base, { saved: { price: '3.85', region: 'R10', enabled: true } });
  await open(t, base);
  await t.page.waitForFunction(() => document.getElementById('diesel-price').value === '6.13', null, { timeout: 5000 }).catch(() => {});
  check('opening the page with the surcharge on (saved before this change) fetches this week’s price', (await t.page.inputValue('#diesel-price')) === '6.13'
    && (await t.page.evaluate(() => getDieselFSC())) === 0.75, await t.page.inputValue('#diesel-price'));
  await t.context.close();

  // ── LTL fuel surcharge ──────────────────────────────────────────────────
  console.log('\n=== LTL fuel surcharge ===');
  t = await setup(browser, base);
  await open(t, base);
  await t.page.evaluate(() => setShipType('ltl'));
  await t.page.waitForFunction(() => /National avg \$5\.92/.test(document.getElementById('ltl-diesel-status').textContent), null, { timeout: 5000 }).catch(() => {});
  const l = await t.page.evaluate(() => ({ label: document.getElementById('fsc-fee-label').textContent, status: document.getElementById('ltl-diesel-status').textContent,
    want: (getLTLFSCRate(5.92) * 100).toFixed(1), stale: (getLTLFSCRate(3.85) * 100).toFixed(1), price: ltlDieselPrice }));
  check('opening LTL loads this week’s national price ($5.92)', l.price === 5.92 && /National avg \$5\.92\/gal/.test(l.status), JSON.stringify(l));
  check(`…and the LTL surcharge uses it (${l.want}% of linehaul, not ${l.stale}%)`, l.label.startsWith(l.want + '% of linehaul') && l.want !== l.stale, JSON.stringify(l));
  await t.page.evaluate(() => { setShipType('ftl'); setShipType('ltl'); });
  await t.page.waitForTimeout(300);
  check('switching back and forth loads it once', t.calls.diesel.filter((r) => r === 'NUS').length === 1, t.calls.diesel.join(','));
  check('no page errors', t.errors.length === 0, t.errors.join(' | '));
  await t.context.close();

  // ── Multi-stop fuel surcharge ───────────────────────────────────────────
  console.log('\n=== Multi-stop fuel surcharge ===');
  t = await setup(browser, base);
  await t.page.goto(base + '/multistop.html');
  await t.page.waitForFunction(() => typeof stops !== 'undefined' && stops.length >= 2);
  await t.page.evaluate(() => { const c = document.getElementById('ms-diesel-enabled'); c.checked = true; c.dispatchEvent(new Event('change')); });
  await t.page.waitForFunction(() => document.getElementById('ms-diesel-price').value !== '3.85', null, { timeout: 5000 }).catch(() => {});
  const m = await t.page.evaluate(() => ({ price: document.getElementById('ms-diesel-price').value, region: document.getElementById('ms-diesel-region').value, fsc: msGetDieselFSC() }));
  check('turning multi-stop’s surcharge on fills in this week’s price too', m.price === DIESEL[m.region].toFixed(2) && m.fsc > 0.6, JSON.stringify(m));
  await t.context.close();
  t = await setup(browser, base);
  await t.page.goto(base + '/multistop.html');
  await t.page.waitForFunction(() => typeof stops !== 'undefined' && stops.length >= 2);
  await setVal(t.page, 'ms-diesel-price', '4.10');
  await t.page.evaluate(() => { const c = document.getElementById('ms-diesel-enabled'); c.checked = true; c.dispatchEvent(new Event('change')); });
  await t.page.waitForTimeout(500);
  check('…unless you typed your own', (await t.page.inputValue('#ms-diesel-price')) === '4.10' && t.calls.diesel.length === 0, t.calls.diesel.join(','));
  check('no page errors', t.errors.length === 0, t.errors.join(' | '));
  await t.context.close();

  // ── Bulk: the same fuel economy as everywhere else ──────────────────────
  console.log('\n=== Bulk fuel surcharge: 6.5 MPG ===');
  t = await setup(browser, base);
  await t.page.goto(base + '/bulk.html');
  await t.page.waitForFunction(() => typeof calc === 'function' && DIESEL_PRICE === 5.92, null, { timeout: 8000 }).catch(() => {});
  const bk = await t.page.evaluate(() => {
    const set = (id, v) => { document.getElementById(id).value = v; };
    set('loaded-miles', 712); set('deadhead-miles', 0); set('cwt', 450); set('offered-rate', 4.35);
    calc();
    const baseline = +document.getElementById('baseline').value || 0;
    return { mpg: document.getElementById('mpg').value, label: document.getElementById('r-fsc-label').textContent,
      want: ((DIESEL_PRICE - baseline) / 6.5).toFixed(2), diesel: DIESEL_PRICE };
  });
  check('Bulk assumes 6.5 MPG (as the calculator, the API and Market Rates do), and its surcharge per mile uses it',
    bk.mpg === '6.5' && bk.diesel === 5.92 && bk.label.includes('$' + bk.want + '/mi'), JSON.stringify(bk));
  const bf = await t.page.evaluate(() => {
    const set = (id, v) => { document.getElementById(id).value = v; };
    const read = () => ({ head: document.getElementById('comp-headline-text').textContent, detail: document.getElementById('comp-detail').textContent });
    set('loaded-miles', 712); set('deadhead-miles', 0); set('cwt', 450); set('offered-rate', 9.5); set('target-rpm', 2.5); calc();
    const over = read();
    set('offered-rate', 1.1); set('target-rpm', 7); calc();
    const short = read();
    set('offered-rate', 1.85); set('target-rpm', 0.3); calc();
    const covered = read();
    setFsc('percent'); calc();
    const pct = { label: document.getElementById('r-fsc-label').textContent, help: document.getElementById('fsc-pct-help').textContent, ph: document.getElementById('fsc-pct').placeholder };
    setFsc('permile'); calc();
    return { over, short, covered, pct };
  });
  check('Bulk dollar amounts have thousands separators (“$1,495.99”, not “$1495.99”)',
    /^\$\d{1,3}(,\d{3})+\.\d{2} profit margin over target$/.test(bf.over.head) && /^\$\d{1,3}(,\d{3})+\.\d{2} short of target$/.test(bf.short.head), JSON.stringify([bf.over.head, bf.short.head]));
  check('a target the fuel surcharge alone covers: said so, with no negative minimum (“$-0.71/cwt”)',
    /fuel surcharge alone covers your target/.test(bf.covered.detail) && !/\$-/.test(bf.covered.detail + bf.covered.head), JSON.stringify(bf.covered));
  check('the surcharge percent reads the same in the label, the help and the box (not 96.5% beside 97%)',
    bf.pct.ph !== '' && bf.pct.label.includes('(' + bf.pct.ph + '% of base)') && bf.pct.help.endsWith('= ' + bf.pct.ph + '%'), JSON.stringify(bf.pct));
  check('no page errors', t.errors.length === 0, t.errors.join(' | '));
  await t.context.close();

  await browser.close();
  server.close();
  console.log(`\nScreenshots: ${SHOTS}`);
  console.log(failures ? `\n${failures} FAILED` : '\nALL PASS');
  process.exit(failures ? 1 : 0);
})();
