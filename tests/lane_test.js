// tests/lane_test.js — "Lane details" under the calculator (lane.js): the
// lane's market rate tiles and history chart, your quotes on the lane, the
// route on Google's map (or a link to it), the markets at both ends, trip and
// fuel, per load / per mile, phones, and the maps-config function. Lane details
// are for Pro Max, API and comp accounts; every other plan gets a locked card
// that looks nothing up. In a real browser (needs Playwright with Chromium); network calls
// other than this site are stubbed. Run from the repository root:
//   node tests/lane_test.js [folder for screenshots]
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { chromium } = require('playwright');
const ROOT = path.resolve(__dirname, '..');
const SHOTS = process.argv[2] || fs.mkdtempSync(path.join(os.tmpdir(), 'qfc-lane-'));
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.json': 'application/json', '.css': 'text/css' };
const RATES = JSON.parse(fs.readFileSync(path.join(ROOT, 'rates.json'), 'utf8'));
const DAY = 86400000;
const KEY = 'AIzaTestKeyForTheLaneViewTests00000000';
let failures = 0;
const check = (label, cond, detail) => { console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}${detail && !cond ? '  — ' + detail : ''}`); if (!cond) failures++; };
const money0 = (n) => '$' + Math.round(n).toLocaleString('en-US');
const money2 = (n) => '$' + Number(n).toFixed(2);
const flat = (s) => String(s || '').replace(/\s+/g, ' ').trim();

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

// Saved quotes: six reefer quotes on Lancaster → Atlanta (3 won, 2 lost, 1 open),
// one van quote on the lane, and one on another lane.
const Q = (id, days, o) => Object.assign({ id, user_id: 'user-1', date: '', origin: 'Lancaster, PA 17601', destination: 'Atlanta, GA',
  miles: 690, trailer: 'reefer', weight: '40000', commodity: 'Standard', commodity_key: 'standard', quote: 2950, rpm: '4.28', margin: '15%',
  base_rpm: '3.36', created_at: new Date(Date.now() - days * DAY).toISOString(), customer: 'Hanover Foods', customer_id: null,
  outcome: 'open', outcome_at: null, final_rate: null, lost_reason: null, tracked: true, notes: '' }, o);
const QUOTES = [
  Q(1, 3, { outcome: 'won', final_rate: 2900 }),
  Q(2, 20, { outcome: 'lost', final_rate: 2700, customer: 'Keystone Produce', quote: 3050 }),
  Q(3, 45, {}),
  Q(4, 80, { outcome: 'won', quote: 2800, origin: 'lancaster pa', destination: 'Atlanta, GA 30301' }),
  Q(5, 150, { outcome: 'lost', quote: 2990 }),
  Q(6, 200, { outcome: 'won', quote: 2650, customer: 'Valley Fresh' }),
  Q(7, 10, { trailer: 'van', quote: 2400 }),
  Q(8, 5, { destination: 'Boston, MA', quote: 1500 }),
];

async function setup(browser, base, { plan = 'max', signedIn = true, theme = 'dark', phone = false, mapsKey = null, quotes = QUOTES, comp = false } = {}) {
  const context = await browser.newContext(phone
    ? { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true }
    : { viewport: { width: 1440, height: 900 } });
  const calls = { routes: 0, maps: 0, diesel: 0, embeds: [] };
  await context.addInitScript(([s, p, th, c]) => {
    if (localStorage.getItem('__seeded')) return;
    localStorage.setItem('__seeded', '1');
    localStorage.setItem('qfc_theme', th);
    localStorage.setItem('qfc_plan_notice_seen', '1');
    if (s) {
      localStorage.setItem('sb-xgrmbhmgcsbnazupfybd-auth-token', JSON.stringify({ access_token: 'tok', refresh_token: 'r',
        expires_at: Math.floor(Date.now() / 1000) + 3600, user: { id: 'user-1', email: 'sam@example.com' } }));
      localStorage.setItem('qfc_pro_profile', JSON.stringify({ contactName: 'Sam Rivera', companyName: 'Keystone Produce Logistics', plan: p, comp: c }));
    }
  }, [signedIn, plan, theme, comp]);
  await context.route('**/*', async (route) => {
    const req = route.request();
    const url = req.url();
    const json = (b) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(b) });
    if (url.startsWith(base) && !url.includes('/.netlify/functions/')) return route.continue();
    if (url.includes('/.netlify/functions/maps-config')) { calls.maps++; return json({ embedKey: mapsKey }); }
    if (url.includes('/.netlify/functions/diesel-price')) { calls.diesel++; return json({ price: 3.851, previous: 3.951, period: '2026-11-09', previousPeriod: '2026-11-02' }); }
    if (url.includes('/.netlify/functions/routes')) {
      calls.routes++;
      return json({ routes: [{ distanceMeters: 690 * 1609.34, duration: '37800s',
        legs: [{ startLocation: { latLng: { latitude: 40.0379, longitude: -76.3055 } }, endLocation: { latLng: { latitude: 33.749, longitude: -84.388 } } }] }] });
    }
    if (url.includes('/.netlify/functions/verify-pro')) return json({ active: signedIn, plan, paid: !comp, unlimitedUntilRenewal: false });
    if (url.includes('/rest/v1/pro_users')) return json(signedIn ? [{ id: 'user-1', is_active: true, plan, comp, stripe_customer_id: comp ? null : 'cus_1', stripe_subscription_id: comp ? null : 'sub_1',
      contact_name: 'Sam Rivera', company_name: 'Keystone Produce Logistics', email: 'sam@example.com' }] : []);
    if (url.includes('/rest/v1/quote_log')) return json(signedIn && req.method() === 'GET' ? quotes : []);
    if (url.includes('/.netlify/functions/')) return json({});
    if (url.includes('supabase.co')) return json([]);
    if (url.includes('google.com/maps/embed')) {
      calls.embeds.push(url);
      return route.fulfill({ status: 200, contentType: 'text/html', body: '<body style="margin:0;background:#e5e3df">map</body>' });
    }
    if (url.includes('fonts.googleapis.com') || url.includes('fonts.gstatic.com')) return route.continue();
    return route.abort();
  });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  return { context, page, errors, calls };
}

// Opens the calculator and prices Lancaster, PA → Atlanta, GA through the
// calculator's own route lookup (stubbed Google: 690 miles, 10 h 30 m).
async function priceLane(t, base, quoteCount, { trailer = 'reefer' } = {}) {
  await t.page.goto(base + '/index.html');
  await t.page.waitForFunction((n) => typeof quoteLog !== 'undefined' && quoteLog.length === n && window.QFC_RATES && window.QFCLane, quoteCount);
  await t.page.evaluate(async (tr) => {
    const set = (id, v) => { document.getElementById(id).value = v; };
    set('origin', 'Lancaster, PA'); set('dest', 'Atlanta, GA'); set('weight', 40000); set('trailer', tr); set('margin', 15);
    applyRegionalRates();
    await tryLookupMiles();
  }, trailer);
  await t.page.waitForSelector('#lane-view:not([hidden]) .lv-card');
  await t.page.waitForTimeout(400);
}
const text = (pg, sel) => pg.$eval(sel, (e) => e.innerText.replace(/\s+/g, ' ').trim()).catch(() => '');
const tiles = (pg) => pg.$$eval('#lane-view .lv-tile', (els) => els.map((e) => e.innerText.replace(/\s+/g, ' ').trim()));

(async () => {
  const server = await serve();
  const base = `http://127.0.0.1:${server.address().port}`;
  const browser = await chromium.launch();
  const H = RATES.history.slice().sort((a, b) => a.date.localeCompare(b.date));
  const last = H[H.length - 1], prev = H[H.length - 2];

  // ── Pro Max with saved quotes ────────────────────────────────────────────
  console.log('\n=== Pricing a lane (Pro Max) ===');
  let t = await setup(browser, base, { plan: 'max' });
  await t.page.goto(base + '/index.html');
  await t.page.waitForFunction(() => typeof quoteLog !== 'undefined' && quoteLog.length === 8 && window.QFC_RATES && window.QFCLane);
  await t.page.waitForTimeout(400);
  check('nothing shows before a lane is priced', await t.page.isHidden('#lane-view') && await t.page.isHidden('#lane-jump'));
  await priceLane(t, base, 8);
  check('the route lookup ran once', t.calls.routes === 1);
  check('the lane, trailer, miles, drive time and both markets', (await text(t.page, '#lane-view .lv-head')).startsWith(
    'LANE DETAILS Lancaster, PA → Atlanta, GA REEFER 690 mi 10 h 30 m drive Pickup market Northeast Delivery market Southeast'), await text(t.page, '#lane-view .lv-head'));
  check('"Lane details" link under the quote', await t.page.isVisible('#lane-jump') && (await t.page.getAttribute('#lane-jump', 'href')) === '#lane-view');

  const dm = await t.page.evaluate(() => dMult(690, 'reefer').m);
  const ne = (h) => h.regions.northeast.reefer * dm;
  let tl = await tiles(t.page);
  const trend = ne(last) / ne(prev) - 1;
  check('this month: Northeast reefer × distance × miles, and the change since last month',
    tl[0].includes(money0(ne(last) * 690)) && tl[0].includes(money2(ne(last)) + '/mi')
      && tl[0].includes(`${trend > 0 ? 'Up' : 'Down'} ${Math.abs(trend * 100).toFixed(1)}% vs ${prev.label.replace(/\s+\d{4}$/, '')}`), tl[0]);
  check('it matches the calculator\'s regional base rate', Math.abs(RATES.regions.northeast.reefer - last.regions.northeast.reefer) < 1e-9
    && (await t.page.inputValue('#rate-reefer')) === RATES.regions.northeast.reefer.toFixed(2));
  check('last month', tl[1].includes(`Last month · ${prev.label}`) && tl[1].includes(money0(ne(prev) * 690)), tl[1]);
  const avg3 = H.slice(-3).reduce((s, h) => s + ne(h), 0) / 3;
  check('3-month average', tl[2].includes(money0(avg3 * 690)) && tl[2].includes(money2(avg3) + '/mi'), tl[2]);
  const lows = H.map(ne);
  check('range since the first month', tl[3].includes(`Range since ${H[0].label}`)
    && tl[3].includes(`${money0(Math.min(...lows) * 690)}–${money0(Math.max(...lows) * 690)}`), tl[3]);
  const quoteText = await text(t.page, '#r-quote');
  const quoteVal = Number(quoteText.replace(/[$,]/g, ''));
  const vs = quoteVal / (ne(last) * 690) - 1;
  check('your quote, as on the result card, against this month\'s market', tl[4].startsWith('Your quote ' + quoteText)
    && tl[4].includes(`${vs >= 0 ? '+' : '−'}${Math.abs(vs * 100).toFixed(0)}% vs this month's market`), tl[4] + ' / ' + quoteText);

  console.log('\n=== Chart ===');
  check('two lines: this lane and national at the same distance', (await t.page.$$('#lane-view .lv-chart svg path')).length === 2);
  check('your six reefer quotes on the lane as dots (the van quote and the Boston lane left out)', (await t.page.$$('#lane-view .lv-q')).length === 6);
  check('the legend explains won, lost and open', (await text(t.page, '#lane-view .lv-legend')) === 'This lane National, same distance Won Lost Open');
  await t.page.locator('#lane-view .lv-chart').scrollIntoViewIfNeeded();
  const box = await t.page.$eval('#lane-view .lv-chart svg', (s) => { const r = s.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height }; });
  await t.page.mouse.move(box.x + box.w * 0.55, box.y + box.h * 0.85);
  let tip = await text(t.page, '#lane-view .lv-tip');
  check('hovering the chart: that month, this lane and national', /^\w+ \d{4} This lane \$[\d,]+ National \$[\d,]+/.test(tip), tip);
  const dot = await t.page.$eval('#lane-view .lv-q[data-i="0"] circle', (c) => { const r = c.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; });
  await t.page.mouse.move(dot.x, dot.y);
  tip = await text(t.page, '#lane-view .lv-tip');
  check('hovering a dot: the quote, its customer and result', tip.includes('Hanover Foods') && tip.includes('Quoted $2,950 · $4.28/mi')
    && tip.includes('Won at $2,900') && tip.includes('Market then'), tip);
  await t.page.mouse.move(5, 5);
  await t.page.click('#lane-view [data-act="table"]');
  const rows = await t.page.$$eval('#lane-view .lv-chart ~ .lv-table-wrap tbody tr', (trs) => trs.map((tr) => tr.innerText.replace(/\s+/g, ' ').trim()));
  check('the chart has a table view, newest month first', await t.page.isHidden('#lane-view .lv-chart') && rows.length === H.length
    && rows[0] === `${last.label} ${money0(ne(last) * 690)} ${money0(last.regions.national.reefer * dm * 690)}`, rows[0]);
  await t.page.click('#lane-view [data-act="table"]');

  console.log('\n=== Per mile ===');
  await t.page.click('#lane-view [data-mode="mile"]');
  tl = await tiles(t.page);
  check('per mile: the tiles lead with the rate per mile', tl[0].includes(`${money2(ne(last))}/mi`) && tl[0].includes(`${money0(ne(last) * 690)} per load`), tl[0]);
  check('the chart axis is per mile', (await t.page.$$eval('#lane-view .lv-chart svg text', (ts) => ts.map((x) => x.textContent))).some((s) => /^\$\d\.\d\d$/.test(s)));
  check('and the choice is remembered', await t.page.evaluate(() => localStorage.getItem('qfc_lane_mode')) === 'mile');
  await t.page.click('#lane-view [data-mode="load"]');

  console.log('\n=== Your quotes on this lane ===');
  const stats = await t.page.$$eval('#lane-view .lv-stat', (els) => els.map((e) => e.innerText.replace(/\s+/g, ' ').trim()));
  check('six quotes, 60% won (3 won · 2 lost), averages', stats[0] === 'Quotes 6' && stats[1] === 'Win rate 60% 3 won · 2 lost'
    && stats[2] === `Avg quoted ${money2((2950 + 3050 + 2950 + 2800 + 2990 + 2650) / 690 / 6)}/mi`
    && stats[3] === `Avg booked ${money2((2900 + 2800 + 2650) / 690 / 3)}/mi` && stats[4].startsWith('Quoted vs market +'), JSON.stringify(stats));
  const qrows = await t.page.$$eval('[data-part="quotes"] tbody tr', (trs) => trs.map((tr) => tr.innerText.replace(/\s+/g, ' ').trim()));
  check('newest first, with result and final rate; ZIPs and spelling still match the lane', qrows.length === 6
    && /Hanover Foods \$2,950 \$4\.28 Won \$2,900$/i.test(qrows[0]) && /Keystone Produce \$3,050 \$4\.42 Lost went for \$2,700$/i.test(qrows[1])
    && /Hanover Foods \$2,800 \$4\.06 Won \$2,800$/i.test(qrows[3]), JSON.stringify(qrows));
  check('the van quote is counted separately', (await text(t.page, '[data-part="quotes"] .lv-muted')).startsWith('1 more on another trailer'));

  console.log('\n=== Markets, trip and fuel ===');
  const mk = await t.page.$$eval('#lane-view .lv-mkt', (els) => els.map((e) => e.innerText.replace(/\s+/g, ' ').trim()));
  const natR = RATES.regions.national.reefer, neR = RATES.regions.northeast.reefer, seR = RATES.regions.southeast.reefer;
  const pd = (x) => Math.abs((x / natR - 1) * 100).toFixed(0);
  check('pickup: Northeast reefer out vs national', mk[0].startsWith(`PICKUP ${money2(neR)}/mi out Lancaster, PA · Northeast`)
    && mk[0].includes(`Trucks leaving the Northeast earn ${pd(neR)}% ${neR > natR ? 'more' : 'less'} than the national rate.`), mk[0]);
  check('delivery: Southeast, and what it means for the reload', mk[1].startsWith(`DELIVERY ${money2(seR)}/mi out Atlanta, GA · Southeast`)
    && mk[1].includes(seR < natR ? 'A weaker reload: carriers may ask more to deliver here.' : 'A strong reload'), mk[1]);
  const lt = RATES.loadToTruck.reefer;
  check('load-to-truck for the trailer', (await text(t.page, '[data-part="markets"] .lv-muted')).startsWith(`Reefer load-to-truck nationally: ${lt.current} loads per truck`));
  const trip = await text(t.page, '[data-part="trip"]');
  check('trip: miles and drive time from Google, driving days', trip.includes('Miles 690 Google Maps') && trip.includes('Drive time 10 h 30 m Google Maps')
    && trip.includes('Driving days 1 At 11 hours a day'), trip);
  check('fuel at the EIA price: gallons, cost and the DOE surcharge', trip.includes('Fuel 106 gal At 6.5 mpg') && trip.includes(`Fuel cost ${money0(690 / 6.5 * 3.851)} $3.85/gal · EIA, week of Nov 9`)
    && trip.includes(`Fuel surcharge ${money2((3.851 - 1.25) / 6.5)}/mi DOE method`), trip);
  check('diesel and the map key were each fetched once', t.calls.diesel === 1 && t.calls.maps === 1, JSON.stringify(t.calls));

  console.log('\n=== Route ===');
  const link = await t.page.getAttribute('[data-part="map"] .lv-map-empty a', 'href');
  check('without a map key: a link to the route on Google Maps', !(await t.page.$('[data-part="map"] iframe'))
    && link === 'https://www.google.com/maps/dir/?api=1&origin=Lancaster%2C%20PA&destination=Atlanta%2C%20GA&travelmode=driving', link);
  check('credit for the miles', (await text(t.page, '[data-part="map"] .lv-credit')) === 'Miles and drive time from Google Maps.');
  await t.page.addStyleTag({ content: '.qf-nav{position:relative!important}' });
  await t.page.locator('#lane-view').screenshot({ path: path.join(SHOTS, 'lane_dark.png') });

  // Switching the trailer: van rates, the one van quote
  await t.page.selectOption('#trailer', 'van');
  await t.page.waitForTimeout(400);
  tl = await tiles(t.page);
  const dmVan = await t.page.evaluate(() => dMult(690, 'van').m);
  check('switching to van redraws for van', (await text(t.page, '#lane-view .lv-eq')) === 'VAN'
    && tl[0].includes(money0(last.regions.northeast.van * dmVan * 690)) && (await t.page.$$('#lane-view .lv-q')).length === 1, tl[0]);
  await t.page.selectOption('#trailer', 'reefer');
  await t.page.click('#btn-ltl');
  await t.page.waitForTimeout(400);
  check('LTL hides the lane view', await t.page.isHidden('#lane-view') && await t.page.isHidden('#lane-jump'));
  await t.page.click('#btn-ftl');
  await t.page.waitForTimeout(400);
  check('and FTL brings it back', await t.page.isVisible('#lane-view'));
  check('no page errors', t.errors.length === 0, t.errors.join(' | '));
  await t.context.close();

  console.log('\n=== Route on Google\'s map (with a key) ===');
  t = await setup(browser, base, { plan: 'max', mapsKey: KEY });
  await priceLane(t, base, 8);
  await t.page.waitForSelector('[data-part="map"] iframe');
  const src = await t.page.getAttribute('[data-part="map"] iframe', 'src');
  check('the route is drawn by the Maps Embed API with the browser key', src ===
    `https://www.google.com/maps/embed/v1/directions?key=${KEY}&origin=Lancaster%2C%20PA&destination=Atlanta%2C%20GA&mode=driving&units=imperial`, src);
  check('the frame is titled for screen readers', (await t.page.getAttribute('[data-part="map"] iframe', 'title')) === 'Route from Lancaster, PA to Atlanta, GA on Google Maps');
  await t.page.evaluate(() => { const f = document.querySelector('[data-part="map"] iframe'); f.dataset.mark = 'same'; });
  await t.page.fill('#margin', '22');
  await t.page.evaluate(() => calc());
  await t.page.waitForTimeout(400);
  check('changing the margin redraws the numbers but keeps the map loaded', (await t.page.getAttribute('[data-part="map"] iframe', 'data-mark')) === 'same'
    && (await tiles(t.page))[4].startsWith('Your quote ' + (await text(t.page, '#r-quote'))));
  await t.page.evaluate(async () => {
    const d = document.getElementById('dest');
    d.value = 'Franklin, WI';
    VERIFIED_PLACE.set(d, { name: 'Franklin, WI', lat: 43.5, lon: -90.9, note: '📍 Vernon County, WI' });
    await tryLookupMiles();
  });
  await t.page.waitForTimeout(400);
  const src2 = await t.page.getAttribute('[data-part="map"] iframe', 'src');
  check('a new destination reloads the map; a checked place goes with its county', src2.includes('&destination=Franklin%2C%20Vernon%20County%2C%20WI&')
    && (await text(t.page, '#lane-view .lv-head')).includes('Lancaster, PA → Franklin, WI'), src2);
  check('no page errors', t.errors.length === 0, t.errors.join(' | '));
  await t.context.close();

  console.log('\n=== Who gets lane details ===');
  for (const [plan, opts, label] of [['plus', {}, 'Pro Plus'], ['pro', {}, 'Pro'], [null, { signedIn: false }, 'free']]) {
    t = await setup(browser, base, Object.assign({ plan: plan || 'pro', mapsKey: KEY }, opts));
    await priceLane(t, base, plan ? 8 : 0);
    const card = await text(t.page, '#lane-view');
    check(`${label}: a locked card naming the lane and what Pro Max adds, no numbers`, !!(await t.page.$('#lane-view .lv-locked'))
      && card.startsWith('LANE DETAILS · PRO MAX Lancaster, PA → Atlanta, GA') && card.includes('Also included with the API plan')
      && !(await t.page.$('#lane-view .lv-tile')) && !/\$\d/.test(card), card);
    check(`${label}: nothing looked up (no diesel, no map key, no map)`, t.calls.diesel === 0 && t.calls.maps === 0 && t.calls.embeds.length === 0, JSON.stringify(t.calls));
    check(`${label}: the link under the quote says Pro Max`, (await text(t.page, '#lane-jump')) === 'Lane details with Pro Max ↓');
    if (label === 'Pro Plus') {
      await t.page.addStyleTag({ content: '.qf-nav{position:relative!important}' });
      await t.page.locator('#lane-view').screenshot({ path: path.join(SHOTS, 'lane_locked.png') });
    }
    await t.page.click('#lane-view [data-act="upgrade"]');
    check(`${label}: Get Pro Max opens the upgrade window with only Pro Max`, await t.page.isVisible('#upg-modal-overlay')
      && await t.page.isVisible('#upg-option-max') && await t.page.isHidden('#upg-option-plus')
      && (await text(t.page, '#upg-modal-desc')).startsWith('Lane details come with Pro Max'));
    check('no page errors', t.errors.length === 0, t.errors.join(' | '));
    await t.context.close();
  }
  for (const [plan, comp, label] of [['api', false, 'API'], ['api', true, 'comp']]) {
    t = await setup(browser, base, { plan, comp, theme: 'light' });
    await priceLane(t, base, 8);
    check(`${label}: the full lane view`, (await tiles(t.page)).length === 5 && (await t.page.$$('#lane-view .lv-q')).length === 6
      && await t.page.evaluate(() => accountTier()) === (comp ? 'comp' : 'api'));
    check('light mode, no page errors', await t.page.evaluate(() => document.documentElement.classList.contains('light')) && t.errors.length === 0, t.errors.join(' | '));
    if (!comp) {
      await t.page.addStyleTag({ content: '.qf-nav{position:relative!important}' });
      await t.page.locator('#lane-view').screenshot({ path: path.join(SHOTS, 'lane_light.png') });
    }
    await t.context.close();
  }
  // The plan changing after the page has drawn the lane: Pro Plus locks it, Pro Max unlocks it
  t = await setup(browser, base, { plan: 'max' });
  await priceLane(t, base, 8);
  const setPlan = (pl) => t.page.evaluate((x) => {
    const p = JSON.parse(localStorage.getItem('qfc_pro_profile')); p.plan = x; localStorage.setItem('qfc_pro_profile', JSON.stringify(p)); updateProUI();
  }, pl);
  await setPlan('plus');
  await t.page.waitForTimeout(400);
  const lockedNow = !!(await t.page.$('#lane-view .lv-locked'));
  await setPlan('max');
  await t.page.waitForTimeout(400);
  check('changing plans redraws it (Pro Plus locks, Pro Max unlocks)', lockedNow && (await tiles(t.page)).length === 5
    && !!(await t.page.$('[data-part="map"] .lv-panel-head')));
  check('no page errors', t.errors.length === 0, t.errors.join(' | '));
  await t.context.close();

  console.log('\n=== Phone ===');
  t = await setup(browser, base, { plan: 'max', phone: true, mapsKey: KEY });
  await priceLane(t, base, 8);
  const sideways = await t.page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  check('phone: no sideways scrolling', sideways <= 1, `${sideways}px`);
  const cols = await t.page.$eval('#lane-view .lv-tiles', (e) => getComputedStyle(e).gridTemplateColumns.split(' ').length);
  check('phone: tiles two across, panels stacked', cols === 2
    && await t.page.$eval('#lane-view .lv-body', (e) => getComputedStyle(e).gridTemplateColumns.split(' ').length) === 1);
  await t.page.addStyleTag({ content: '.qf-nav{position:relative!important}' });
  await t.page.locator('#lane-view').screenshot({ path: path.join(SHOTS, 'lane_phone.png') });
  check('no page errors', t.errors.length === 0, t.errors.join(' | '));
  await t.context.close();

  // ── maps-config ──────────────────────────────────────────────────────────
  console.log('\n=== maps-config function ===');
  const fn = require(path.join(ROOT, 'netlify/functions/maps-config.js'));
  const run = async (v) => { if (v === undefined) delete process.env.GMAPS_EMBED_KEY; else process.env.GMAPS_EMBED_KEY = v; return JSON.parse((await fn.handler({})).body); };
  check('hands out the browser key when it is set', (await run(KEY)).embedKey === KEY);
  check('nothing when it is missing or malformed', (await run(undefined)).embedKey === null && (await run('not a key<script>')).embedKey === null);
  delete process.env.GMAPS_EMBED_KEY;

  await browser.close();
  server.close();
  console.log(failures ? `\n${failures} LANE CHECK(S) FAILED` : `\nALL LANE CHECKS PASSED (screenshots in ${SHOTS})`);
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
