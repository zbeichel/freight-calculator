// tests/lane_test.js — "Lane details" under the calculator (lane.js): the
// lane's market rate tiles and history chart, your quotes on the lane, the
// route on Google's map (or a link to it), the markets at both ends, trip and
// fuel, per load / per mile, what each plan sees, phones, and the maps-config
// function. In a real browser (needs Playwright with Chromium); network calls
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

async function setup(browser, base, { plan = 'plus', signedIn = true, theme = 'dark', phone = false, mapsKey = null, quotes = QUOTES } = {}) {
  const context = await browser.newContext(phone
    ? { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true }
    : { viewport: { width: 1440, height: 900 } });
  const calls = { routes: 0, maps: 0, diesel: 0, embeds: [] };
  await context.addInitScript(([s, p, th]) => {
    if (localStorage.getItem('__seeded')) return;
    localStorage.setItem('__seeded', '1');
    localStorage.setItem('qfc_theme', th);
    localStorage.setItem('qfc_plan_notice_seen', '1');
    if (s) {
      localStorage.setItem('sb-xgrmbhmgcsbnazupfybd-auth-token', JSON.stringify({ access_token: 'tok', refresh_token: 'r',
        expires_at: Math.floor(Date.now() / 1000) + 3600, user: { id: 'user-1', email: 'sam@example.com' } }));
      localStorage.setItem('qfc_pro_profile', JSON.stringify({ contactName: 'Sam Rivera', companyName: 'Keystone Produce Logistics', plan: p }));
    }
  }, [signedIn, plan, theme]);
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
    if (url.includes('api.open-meteo.com/v1/forecast')) {
      return json({ daily: { weathercode: [3], temperature_2m_max: [11.2], temperature_2m_min: [2.1], precipitation_sum: [0.4],
        windspeed_10m_max: [18], precipitation_probability_max: [35], relative_humidity_2m_max: [78] } });
    }
    if (url.includes('/.netlify/functions/verify-pro')) return json({ active: signedIn, plan, paid: true, unlimitedUntilRenewal: false });
    const account = { id: 'user-1', is_active: true, plan, stripe_customer_id: 'cus_1', stripe_subscription_id: 'sub_1',
      contact_name: 'Sam Rivera', company_name: 'Keystone Produce Logistics', email: 'sam@example.com' };
    if (url.includes('/rest/v1/rpc/my_account')) return json({ row: signedIn ? account : null, team: null });
    if (url.includes('/rest/v1/pro_users')) return json(signedIn ? [account] : []);
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
  await t.page.waitForSelector('#lane-view:not([hidden]) .lv-tile');
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

  // ── Pro Plus with saved quotes ───────────────────────────────────────────
  console.log('\n=== Pricing a lane ===');
  let t = await setup(browser, base, { plan: 'plus' });
  await t.page.goto(base + '/index.html');
  await t.page.waitForFunction(() => typeof quoteLog !== 'undefined' && quoteLog.length === 8 && window.QFC_RATES && window.QFCLane);
  await t.page.waitForTimeout(400);
  check('nothing shows before a lane is priced', await t.page.isHidden('#lane-view') && await t.page.isHidden('#lane-jump'));
  await priceLane(t, base, 8);
  check('the route lookup ran once', t.calls.routes === 1);
  check('the title bar: lane, trailer, miles, drive time, both markets, per load / per mile', (await text(t.page, '#lane-view .lv-bar')) ===
    'LANE DETAILS Lancaster, PA → Atlanta, GA REEFER 690 mi 10 h 30 m drive Pickup Northeast Delivery Southeast Per load Per mile', await text(t.page, '#lane-view .lv-bar'));
  check('the title bar is a solid color', await t.page.$eval('#lane-view .lv-bar', (e) => { const c = getComputedStyle(e); return c.backgroundImage === 'none' && c.backgroundColor !== 'rgba(0, 0, 0, 0)'; }));
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
  const shortLabel = (h) => h.label.replace(/\s+\d{4}$/, '');
  check('cards read at a glance: a title, then the month', tl[0].startsWith(`This month ${shortLabel(last)} `) && tl[1].startsWith(`Last month ${shortLabel(prev)} `), tl[0] + ' / ' + tl[1]);
  check('last month', tl[1].includes(money0(ne(prev) * 690)), tl[1]);
  const avg3 = H.slice(-3).reduce((s, h) => s + ne(h), 0) / 3;
  check('3-month average', tl[2].includes(money0(avg3 * 690)) && tl[2].includes(money2(avg3) + '/mi'), tl[2]);
  const lows = H.map(ne);
  check('range since the first month', tl[3].startsWith(`Range Since ${shortLabel(H[0])}`)
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
  const mk = await t.page.$$eval('#lane-view .lv-end', (els) => els.map((e) => e.innerText.replace(/\s+/g, ' ').trim()));
  const natR = RATES.regions.national.reefer, neR = RATES.regions.northeast.reefer, seR = RATES.regions.southeast.reefer;
  const pd = (x) => Math.abs((x / natR - 1) * 100).toFixed(0);
  check('pickup: Northeast reefer out vs national', mk[0].startsWith(`PICKUP Lancaster, PA Northeast market ${money2(neR)}/mi out`)
    && mk[0].includes(`Trucks leaving the Northeast earn ${pd(neR)}% ${neR > natR ? 'more' : 'less'} than the national rate.`), mk[0]);
  check('pickup and delivery side by side', mk.length === 2 && await t.page.$eval('#lane-view .lv-ends', (e) => getComputedStyle(e).gridTemplateColumns.split(' ').length) === 2);
  check('delivery: Southeast, and what it means for the reload', mk[1].startsWith(`DELIVERY Atlanta, GA Southeast market ${money2(seR)}/mi out`)
    && mk[1].includes(seR < natR ? 'A weaker reload: carriers may ask more to deliver here.' : 'A strong reload'), mk[1]);
  const lt = RATES.loadToTruck.reefer;
  check('load-to-truck for the trailer', (await text(t.page, '[data-part="markets"] .lv-panel-foot')).startsWith(`Reefer load-to-truck nationally: ${lt.current} loads per truck`));
  const trip = await text(t.page, '[data-part="trip"]');
  check('trip: miles from Google', trip.includes('MILES 690 Google Maps') && !/drive time/i.test(trip), trip);
  check('fuel at the EIA price: gallons, cost and the DOE surcharge', trip.includes('FUEL 106 gal At 6.5 mpg') && trip.includes(`FUEL COST ${money0(690 / 6.5 * 3.851)} $3.85/gal · EIA Nov 9`)
    && trip.includes(`FUEL SURCHARGE ${money2((3.851 - 1.25) / 6.5)}/mi DOE method`), trip);
  const hos = await t.page.evaluate(() => {
    const c = document.getElementById('hos-card');
    return { inLane: !!c.closest('#lane-view .lv-row') && c.nextElementSibling === document.querySelector('[data-part="trip"]'), shown: c.offsetParent !== null,
      days: document.getElementById('hos-drive-days').textContent.trim(), total: document.getElementById('hos-total-time').textContent.trim() };
  });
  // 10 h 30 m of driving needs a 30-minute break after 8 hours: 11 hours in all, one day
  check('the HOS trip plan sits in Lane details beside Trip and fuel, with the drive time', hos.inLane && hos.shown && hos.days === '1' && hos.total === '11h', JSON.stringify(hos));
  await t.page.waitForSelector('#lane-view #weather-locations', { state: 'visible', timeout: 5000 }).catch(() => {});
  const wx = await t.page.evaluate(() => {
    const c = document.getElementById('weather-card');
    return { inLane: !!c.closest('#lane-view .lv-row') && c.previousElementSibling === document.querySelector('[data-part="markets"]'), shown: c.offsetParent !== null,
      temp: (document.getElementById('wo-temp') || {}).textContent || '' };
  });
  check('the weather outlook sits beside the markets, with the forecast', wx.inLane && wx.shown && /°F/.test(wx.temp), JSON.stringify(wx));
  check('under the form there is nothing else now', await t.page.evaluate(() =>
    [...document.querySelector('.main > .calc-col').children].every((c) => c.classList.contains('card') && !c.id)));
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
  t = await setup(browser, base, { plan: 'plus', mapsKey: KEY });
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
    && (await text(t.page, '#lane-view .lv-bar')).includes('Lancaster, PA → Franklin, WI'), src2);
  check('no page errors', t.errors.length === 0, t.errors.join(' | '));
  await t.context.close();

  console.log('\n=== The form box and the quote box ===');
  const level = (pg) => pg.evaluate(() => {
    const cols = document.querySelectorAll('.main > .calc-col');
    const box = (col) => [...col.children].find((c) => c.offsetParent !== null && (c.classList.contains('card') || c.classList.contains('result-card')));
    const r = (e) => e.getBoundingClientRect();
    return { left: Math.round(r(box(cols[0])).bottom), right: Math.round(r(box(cols[1])).bottom) };
  });
  for (const [label, opts, after] of [['free account', { signedIn: false }, null], ['Pro Plus', { plan: 'plus' }, null],
    ['Advanced adjustments open', { plan: 'plus' }, (pg) => pg.evaluate(() => toggleAdv())], ['LTL', { plan: 'plus' }, (pg) => pg.click('#btn-ltl')]]) {
    t = await setup(browser, base, opts);
    await priceLane(t, base, opts.signedIn === false ? 0 : 8);
    await t.page.evaluate(() => window.scrollTo(0, 0));
    if (after) await after(t.page);
    await t.page.waitForTimeout(300);
    const lv = await level(t.page);
    check(`${label}: the two boxes end level`, Math.abs(lv.left - lv.right) <= 1, JSON.stringify(lv));
    if (label === 'Advanced adjustments open') {
      // Scrolled well into the long form: the quote's contents stay in view below the navigation
      const y = await t.page.evaluate(() => { const c = document.querySelector('.result-card'); return c.getBoundingClientRect().top + window.scrollY + 300; });
      await t.page.evaluate((yy) => window.scrollTo(0, yy), y);
      await t.page.waitForTimeout(200);
      const pos = await t.page.evaluate(() => ({ card: Math.round(document.querySelector('.result-card').getBoundingClientRect().top),
        inner: Math.round(document.querySelector('.result-card .result-inner').getBoundingClientRect().top),
        nav: Math.round(document.getElementById('qf-nav').getBoundingClientRect().bottom) }));
      check('scrolling a long form keeps the quote in view, below the navigation', pos.card < 0 && pos.inner >= pos.nav && pos.inner <= pos.nav + 24, JSON.stringify(pos));
    }
    check('no page errors', t.errors.length === 0, t.errors.join(' | '));
    await t.context.close();
  }

  console.log('\n=== Pro, free, light, phone ===');
  t = await setup(browser, base, { plan: 'pro', theme: 'light' });
  await priceLane(t, base, 8);
  const proQuotes = await text(t.page, '[data-part="quotes"]');
  check('Pro: their quotes on the lane without won/lost', (await t.page.$$('[data-part="quotes"] tbody tr')).length === 6
    && !(await t.page.$('[data-part="quotes"] .lv-result')) && proQuotes.includes('Mark quotes won or lost with Pro Plus')
    && (await text(t.page, '#lane-view .lv-legend')) === 'This lane National, same distance Your quotes', proQuotes);
  check('light mode', await t.page.evaluate(() => document.documentElement.classList.contains('light')) && t.errors.length === 0, t.errors.join(' | '));
  await t.page.addStyleTag({ content: '.qf-nav{position:relative!important}' });
  await t.page.locator('#lane-view').screenshot({ path: path.join(SHOTS, 'lane_light_pro.png') });
  // The plan changing after the lane is drawn (e.g. an upgrade): won/lost appear
  await t.page.evaluate(() => {
    const p = JSON.parse(localStorage.getItem('qfc_pro_profile')); p.plan = 'plus';
    localStorage.setItem('qfc_pro_profile', JSON.stringify(p)); updateProUI();
  });
  await t.page.waitForTimeout(400);
  check('moving up to Pro Plus redraws it with won and lost', (await t.page.$$('[data-part="quotes"] .lv-result')).length === 6
    && (await text(t.page, '#lane-view .lv-legend')) === 'This lane National, same distance Won Lost Open');
  await t.context.close();

  t = await setup(browser, base, { signedIn: false });
  await priceLane(t, base, 0);
  check('free: the market numbers, and plans for keeping their quotes', (await tiles(t.page)).length === 5
    && (await text(t.page, '[data-part="quotes"]')).includes('Pro saves every quote you send')
    && (await t.page.getAttribute('[data-part="quotes"] a.qf-btn', 'href')) === '/signup.html');
  check('no page errors', t.errors.length === 0, t.errors.join(' | '));
  await t.context.close();

  t = await setup(browser, base, { plan: 'plus', phone: true, mapsKey: KEY });
  await priceLane(t, base, 8);
  const sideways = await t.page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  check('phone: no sideways scrolling', sideways <= 1, `${sideways}px`);
  const cols = await t.page.$eval('#lane-view .lv-tiles', (e) => getComputedStyle(e).gridTemplateColumns.split(' ').length);
  check('phone: tiles two across, panels stacked', cols === 2
    && await t.page.$eval('#lane-view .lv-row-wide', (e) => getComputedStyle(e).gridTemplateColumns.split(' ').length) === 1);
  // A phone can't hover: a tap on the chart shows that month, and it stays up until a tap elsewhere
  await t.page.locator('#lane-view .lv-chart').scrollIntoViewIfNeeded();
  const pbox = await t.page.$eval('#lane-view .lv-chart svg', (s) => { const r = s.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height }; });
  await t.page.touchscreen.tap(pbox.x + pbox.w * 0.55, pbox.y + pbox.h * 0.85);
  await t.page.waitForTimeout(250);
  const ptip = await text(t.page, '#lane-view .lv-tip');
  check('phone: tapping the chart shows that month, and it stays up', /^\w+ \d{4} This lane \$[\d,]+ National \$[\d,]+/.test(ptip), ptip);
  const pdot = await t.page.$eval('#lane-view .lv-q[data-i="0"] circle', (c) => { const r = c.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; });
  await t.page.touchscreen.tap(pdot.x, pdot.y);
  await t.page.waitForTimeout(250);
  check('phone: tapping a dot shows that quote', (await text(t.page, '#lane-view .lv-tip')).includes('Hanover Foods'));
  await t.page.locator('#lane-view .lv-tiles').scrollIntoViewIfNeeded();
  const away = await t.page.$eval('#lane-view .lv-tiles', (e) => { const r = e.getBoundingClientRect(); return { x: r.x + 10, y: r.y + 10 }; });
  await t.page.touchscreen.tap(away.x, away.y);
  await t.page.waitForTimeout(200);
  check('phone: a tap somewhere else puts it away', await t.page.isHidden('#lane-view .lv-tip'));
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
