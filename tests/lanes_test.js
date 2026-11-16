// tests/lanes_test.js — the lane tracker (lanes.html) in a real browser (needs Playwright with
// Chromium): its adjustment settings surviving a reload, and lane totals priced with the
// calculator's distance factor, so a lane's total matches the calculator's linehaul.
// Supabase and the Netlify functions are fakes. Run from the repository root:
//   node tests/lanes_test.js [folder for screenshots]
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { chromium } = require('playwright');
const ROOT = path.resolve(__dirname, '..');
const SHOTS = process.argv[2] || fs.mkdtempSync(path.join(os.tmpdir(), 'qfc-lanes-'));
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

// Two monthly snapshots for the Northeast (where a Pennsylvania pickup lands)
const HISTORY = [
  { snapshot_date: '2026-10-01', region: 'northeast', van: 2.9, reefer: 3.3, flatbed: 3.4 }, { snapshot_date: '2026-10-01', region: 'national', van: 2.7, reefer: 3.1, flatbed: 3.3 },
  { snapshot_date: '2026-11-01', region: 'northeast', van: 3.0, reefer: 3.4, flatbed: 3.5 }, { snapshot_date: '2026-11-01', region: 'national', van: 2.8, reefer: 3.2, flatbed: 3.4 },
];
const LANE = { origin: 'Lancaster, PA', destination: 'Baltimore, MD', miles: 163, trailer: 'van', date: 'Nov 15, 26' };

async function setup(browser, base, { local = {} } = {}) {
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  await context.addInitScript((local) => {
    if (localStorage.getItem('__seeded')) return;
    localStorage.setItem('__seeded', '1');
    localStorage.setItem('sb-xgrmbhmgcsbnazupfybd-auth-token', JSON.stringify({ access_token: 'tok', refresh_token: 'r',
      expires_at: Math.floor(Date.now() / 1000) + 3600, user: { id: 'user-1', email: 'sam@example.com' } }));
    Object.entries(local).forEach(([k, v]) => localStorage.setItem(k, JSON.stringify(v)));
  }, local);
  await context.route('**/*', async (route) => {
    const url = route.request().url();
    const json = (b, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(b) });
    if (url.startsWith(base) && !url.includes('/.netlify/functions/')) return route.continue();
    if (url.includes('/.netlify/functions/verify-pro')) return json({ active: true, plan: 'plus', paid: true, unlimitedUntilRenewal: false });
    if (url.includes('/.netlify/functions/')) return json({});
    if (url.includes('/rest/v1/rate_history')) return json(HISTORY);
    if (url.includes('/rest/v1/quote_log')) return json([LANE]);
    if (url.includes('/rest/v1/rpc/my_account')) return json({ row: { id: 'user-1', is_active: true, plan: 'plus', stripe_customer_id: 'cus_1' }, team: null });
    if (url.includes('supabase.co')) return json([]);
    if (url.includes('fonts.googleapis.com') || url.includes('fonts.gstatic.com') || url.startsWith('https://cdnjs.cloudflare.com/')) return route.continue();
    return route.abort();
  });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  return { context, page, errors };
}
const openLanes = async (t, base) => {
  await t.page.goto(base + '/lanes.html');
  await t.page.waitForFunction(() => document.querySelectorAll('#lane-list .lane-name').length === 1, null, { timeout: 8000 });
  await t.page.click('#lane-list .lane-name');
  await t.page.waitForTimeout(300);
};
// The calculator's van curve at 163 mi: 1.85 at 100, 1.05 at 300
const VAN_163 = 1.85 + (1.05 - 1.85) * (163 - 100) / 200;

(async () => {
  const server = await serve();
  const base = `http://127.0.0.1:${server.address().port}`;
  const browser = await chromium.launch();

  console.log('\n=== Lane tracker: adjustment settings after a reload ===');
  const SAVED = { commodity: 'food', seasonal: { enabled: true, region: 'ca' }, capacity: { enabled: true, overrides: { van: 7.5 } }, margin: { enabled: true, pct: 18 } };
  let t = await setup(browser, base, { local: { qfc_lane_adjustments: SAVED } });
  await openLanes(t, base);
  const adj = await t.page.evaluate(() => JSON.parse(JSON.stringify(adjustments)));
  check('the saved commodity, seasonal region, capacity override and margin come back (they all reset to defaults before)',
    adj.commodity === 'food' && adj.seasonal.enabled && adj.seasonal.region === 'ca' && adj.capacity.enabled && adj.capacity.overrides.van === 7.5
    && adj.margin.enabled && adj.margin.pct === 18, JSON.stringify(adj));
  check('no page errors', t.errors.length === 0, t.errors.join(' | '));
  await t.context.close();

  console.log('\n=== Lane tracker: the calculator’s distance factor ===');
  t = await setup(browser, base);
  await openLanes(t, base);
  const lane = await t.page.evaluate(() => {
    const d = buildChartData(profiles[0], 'van');
    return { rate: d.data[d.data.length - 1], total: d.totals[d.totals.length - 1], hint: document.getElementById('total-section-hint').textContent };
  });
  const want = 3.0 * VAN_163 * 163;
  check(`a 163-mile van lane at $3.00/mi: ${VAN_163.toFixed(2)}× for distance, $${want.toFixed(0)} (not $${(3 * 163).toFixed(0)})`,
    lane.rate === 3 && Math.abs(lane.total - want) < 0.01, JSON.stringify(lane));
  check('the chart says the distance factor is in it', /at 163 mi · 1\.60× for distance/.test(lane.hint), lane.hint);
  await t.page.screenshot({ path: path.join(SHOTS, 'lanes.png'), fullPage: true });
  check('no page errors', t.errors.length === 0, t.errors.join(' | '));

  // The calculator, same lane and rate: its linehaul is the lane total
  const calc = await t.context.newPage();
  await calc.goto(base + '/index.html');
  await calc.waitForFunction(() => typeof regionalRates !== 'undefined' && regionalRates !== null && typeof calc === 'function');
  const linehaul = await calc.evaluate(() => {
    const set = (id, v) => { document.getElementById(id).value = v; };
    set('origin', 'Lancaster, PA'); set('dest', 'Baltimore, MD'); set('miles', 163); set('trailer', 'van'); set('weight', ''); set('commodity', 'standard'); set('margin', 0);
    set('rate-van', '3.00'); ratesManualOverride = true; manualMiles = true;
    calc();
    return document.getElementById('r-cost').textContent;
  });
  check('the calculator’s linehaul for the same lane and rate matches the lane total', Number(linehaul.replace(/[^0-9.]/g, '')) === Math.round(want), `${linehaul} vs $${Math.round(want)}`);
  await t.context.close();

  console.log('\n=== Lane tracker: your own distance curve ===');
  const MINE = { van: [{ mi: 100, m: 1.5 }, { mi: 300, m: 1.1 }, { mi: 600, m: 1 }, { mi: 1000, m: 1 }, { mi: 1500, m: 0.85 }, { mi: 2500, m: 0.75 }] };
  t = await setup(browser, base, { local: { qfc_distance_curves: MINE } });
  await openLanes(t, base);
  const mine = await t.page.evaluate(() => { const d = buildChartData(profiles[0], 'van'); return d.totals[d.totals.length - 1]; });
  const wantMine = 3.0 * (1.5 + (1.1 - 1.5) * 63 / 200) * 163;
  check('a curve changed on the calculator applies here too', Math.abs(mine - wantMine) < 0.01, `${mine} vs ${wantMine}`);
  await t.context.close();

  await browser.close();
  server.close();
  console.log(`\nScreenshots: ${SHOTS}`);
  console.log(failures ? `\n${failures} FAILED` : '\nALL PASS');
  process.exit(failures ? 1 : 0);
})();
