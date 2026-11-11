// tests/quote_parity_test.js
//
// Checks that the API's quote math (netlify/lib/quote-engine.js) gives exactly
// the same numbers as the calculator page's own calc() in index.html.
// Run from the repository root (needs Playwright with Chromium):
//
//   node tests/quote_parity_test.js
//
// It serves the site locally, opens index.html with every network call except
// the local site stubbed, then prices a few hundred lanes both ways: random
// mixes of miles, weight, trailer, commodity, dates, margin, region and every
// Advanced setting (fuel surcharge, capacity, seasonality, holidays, market,
// extra transit days). The page's quote and cost must equal the engine's to
// the last bit, and its displayed total and $/mile must match.
const http = require('http');
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');
const engine = require('../netlify/lib/quote-engine.js');

const ROOT = path.resolve(__dirname, '..');
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.json': 'application/json', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png' };

function serve() {
  const server = http.createServer((req, res) => {
    const p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    const file = path.join(ROOT, p === '/' ? 'index.html' : p);
    if (!file.startsWith(ROOT) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
      res.writeHead(404); res.end(); return;
    }
    res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream' });
    fs.createReadStream(file).pipe(res);
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)));
}

// Small seeded PRNG so a failure can be reproduced.
let seed = Number(process.env.SEED || 20261111);
function rand() { seed = (seed * 1664525 + 1013904223) % 4294967296; return seed / 4294967296; }
const pick = (arr) => arr[Math.floor(rand() * arr.length)];
const chance = (p) => rand() < p;
const int = (lo, hi) => lo + Math.floor(rand() * (hi - lo + 1));

const ORIGINS = ['Lancaster, PA', 'Hastings, FL 32145', 'Chicago, IL', 'Dallas, TX', 'Fresno, CA',
  'Boise, ID', 'Portland, ME', 'Phoenix, AZ', 'Toronto, ON', 'Springfield'];
const MILE_EDGES = [1, 50, 99, 100, 101, 250, 300, 301, 450, 600, 601, 999, 1000, 1001, 1499, 1500, 1501, 2000, 2499, 2500, 2501, 3100];
const WEIGHT_EDGES = [0, 1, 9999, 10000, 29999, 30000, 43999, 44000, 44001, 48000, 999999];

function makeCase(i) {
  const pickupMonth = int(1, 12);
  const pickup = chance(0.85) ? `2027-${String(pickupMonth).padStart(2, '0')}-${String(int(1, 28)).padStart(2, '0')}` : '';
  const c = {
    origin: pick(ORIGINS),
    miles: chance(0.3) ? pick(MILE_EDGES) : int(1, 3200),
    weight: chance(0.4) ? pick(WEIGHT_EDGES) : int(1000, 48000),
    trailer: pick(engine.TRAILERS),
    commodity: pick(engine.COMMODITIES),
    pickup,
    margin: chance(0.3) ? 15 : pick([0, 5, 10, 12.5, 18, 20, 25, 33.3, 40]),
    national: chance(0.15),
    manualRate: chance(0.1) ? Math.round((1.5 + rand() * 3) * 100) / 100 : null,
    diesel: chance(0.4) ? pick([1.0, 1.25, 1.26, 3.85, 4.129, 5.5]) : null,
    capacity: chance(0.4),
    season: chance(0.4) ? pick(engine.SEASON_REGIONS) : null,
    holidays: chance(0.35) ? engine.HOLIDAY_IDS.filter(() => chance(0.3)) : [],
    market: chance(0.4) ? int(-10, 30) : 0,
    extraDayRate: null,
    delivery: '',
  };
  if (pickup && chance(0.35)) {
    const d = new Date(pickup + 'T12:00:00Z');
    d.setUTCDate(d.getUTCDate() + int(0, 9));
    c.delivery = d.toISOString().slice(0, 10);
    // Not 0: the page reads a 0 rate as blank and uses $200/day; the API charges nothing.
    c.extraDayRate = pick([150, 200, 275.5]);
  }
  if (i === 0) Object.assign(c, { origin: 'Lancaster, PA', miles: 166, weight: 42000, trailer: 'van', commodity: 'standard',
    pickup: '', margin: 15, national: false, manualRate: null, diesel: null, capacity: false, season: null, holidays: [], market: 0,
    extraDayRate: null, delivery: '' });
  return c;
}

// The engine's input for a case, the way the API builds it.
function engineInput(c) {
  const m = c.origin.match(/[\s,]+([A-Za-z]{2})\b(?:\s+\d{5}(?:-\d{4})?)?(?:\s*,\s*USA?)?\s*$/i);
  const state = m ? m[1].toUpperCase() : null;
  return {
    miles: c.miles,
    trailer: c.trailer,
    weight: c.weight || undefined,
    commodity: c.commodity,
    pickupDate: c.pickup || undefined,
    deliveryDate: c.delivery || undefined,
    marginPercent: c.margin,
    rateRegion: c.national ? 'national' : engine.regionForState(state),
    baseRatePerMile: c.manualRate != null ? c.manualRate : undefined,
    dieselPrice: c.diesel != null ? c.diesel : undefined,
    capacity: c.capacity,
    seasonRegion: c.season || undefined,
    holidays: c.holidays,
    marketPercent: c.market,
    extraDayRate: c.extraDayRate != null ? c.extraDayRate : undefined,
  };
}

const money = (n) => '$' + n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const moneyInt = (n) => '$' + Math.round(n).toLocaleString('en-US');

(async () => {
  const server = await serve();
  const base = `http://127.0.0.1:${server.address().port}`;
  const browser = await chromium.launch();
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.route('**/*', (route) => {
    const url = route.request().url();
    if (url.startsWith(base)) return route.continue();
    if (url.includes('/.netlify/functions/')) return route.fulfill({ status: 200, contentType: 'application/json', body: '{}' });
    if (url.includes('supabase.co')) return route.fulfill({ status: 200, contentType: 'application/json', body: '[]' });
    return route.abort();
  });
  await page.goto(base + '/index.html');
  await page.waitForFunction(() => typeof regionalRates !== 'undefined' && regionalRates !== null, null, { timeout: 15000 });
  await page.waitForTimeout(500);

  // The page's ratio boxes must hold rates.json's current load-to-truck values.
  const lt = await page.evaluate(() => ['van', 'reefer', 'flatbed'].map((t) => parseFloat(document.getElementById('lt-' + t).value)));
  const ltWant = ['van', 'reefer', 'flatbed'].map((t) => engine.RATES.loadToTruck[t].current);
  let failures = 0;
  if (JSON.stringify(lt) !== JSON.stringify(ltWant)) { failures++; console.log('FAIL load-to-truck boxes', lt, ltWant); }

  const N = Number(process.env.CASES || 400);
  for (let i = 0; i < N; i++) {
    const c = makeCase(i);
    const got = await page.evaluate((c) => {
      const set = (id, v) => { document.getElementById(id).value = v; };
      set('origin', c.origin);
      set('miles', c.miles);
      set('weight', c.weight || '');
      set('trailer', c.trailer);
      set('commodity', c.commodity);
      set('pickup', c.pickup);
      set('delivery', c.delivery);
      set('margin', c.margin);
      // Rates: regional by pickup state, national, or typed in by hand.
      ratesManualOverride = false;
      rateMode = c.national ? 'national' : 'regional';
      if (c.national) {
        const nat = getRatesForRegion('national');
        ['van', 'reefer', 'flatbed'].forEach((t) => set('rate-' + t, parseFloat(nat[t]).toFixed(2)));
      } else {
        applyRegionalRates();
        if (!detectOriginState()) {
          // No state: the page keeps national rates.
          const nat = getRatesForRegion('national');
          ['van', 'reefer', 'flatbed'].forEach((t) => set('rate-' + t, parseFloat(nat[t]).toFixed(2)));
        }
      }
      if (c.manualRate != null) { ratesManualOverride = true; set('rate-' + c.trailer, c.manualRate); }
      // Advanced settings.
      document.getElementById('diesel-enabled').checked = c.diesel != null;
      if (c.diesel != null) set('diesel-price', c.diesel);
      document.getElementById('cap-enabled').checked = c.capacity;
      document.getElementById('seas-enabled').checked = !!c.season;
      if (c.season) set('seas-region', c.season);
      document.getElementById('hol-enabled').checked = c.holidays.length > 0;
      HOLIDAY_EVENTS.forEach((ev) => { document.getElementById('hol-' + ev.id).checked = c.holidays.includes(ev.id); });
      mpValue = c.market;
      transitChargeAdded = false;
      transitChargeAmount = 0;
      if (c.extraDayRate != null) { set('extra-day-rate', c.extraDayRate); addTransitCharge(); }
      // Record every number calc() formats as whole dollars (quote and cost among them).
      const realFmtInt = fmtInt;
      const seen = [];
      fmtInt = (n) => { seen.push(n); return realFmtInt(n); };
      try { calc(); } finally { fmtInt = realFmtInt; }
      return {
        seen,
        quoteText: document.getElementById('r-quote').textContent,
        rpmText: document.getElementById('r-rpm').textContent,
        base: getBase()[c.trailer],
      };
    }, c);

    const q = engine.computeQuote(engineInput(c));
    const problems = [];
    if (got.base !== q.baseRatePerMile) problems.push(`base rate page ${got.base} vs engine ${q.baseRatePerMile}`);
    if (!got.seen.some((v) => v === q.total)) problems.push(`quote ${q.total} not among page values ${JSON.stringify(got.seen)}`);
    if (!got.seen.some((v) => v === q.cost)) problems.push(`cost ${q.cost} not among page values`);
    if (got.quoteText !== moneyInt(q.total)) problems.push(`shown total ${got.quoteText} vs ${moneyInt(q.total)}`);
    if (got.rpmText !== money(q.ratePerMile) + ' per mile') problems.push(`shown $/mi ${got.rpmText} vs ${money(q.ratePerMile)}`);
    if (problems.length) {
      failures++;
      if (failures <= 10) console.log(`FAIL case ${i}`, JSON.stringify(c), '\n   ', problems.join('\n    '));
    }
  }
  if (errors.length) { failures++; console.log('FAIL page errors:', errors.slice(0, 5)); }
  console.log(failures ? `\n${failures} failure(s) in ${N} cases` : `\nAll ${N} cases match the page exactly.`);
  await browser.close();
  server.close();
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
