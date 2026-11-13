// tests/sections_test.js — the optional sections on Modern quotes (Profile →
// Quote sections): the transit estimate (hours-of-service rules, the same as
// the calculator's trip plan) and the user's accessorial charges, with their
// switches in Profile and in the Email quote window. In a real browser (needs
// Playwright with Chromium); Supabase and the functions are replaced by fakes.
// Run from the repository root:
//   node tests/sections_test.js [folder for screenshots]
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { chromium } = require('playwright');
const ROOT = path.resolve(__dirname, '..');
const SHOTS = process.argv[2] || fs.mkdtempSync(path.join(os.tmpdir(), 'qfc-sections-'));
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.json': 'application/json', '.css': 'text/css' };
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

const RATES = { detentionRate: 75, detentionFree: 2, layover: 250, tonu: 250, extraStop: 100, lumper: 'Billed at cost with receipt',
  other: [{ label: 'Tarping', charge: '$75 per load' }] };
const PROFILE = { companyName: 'Keystone Produce Logistics', contactName: 'Sam Rivera', quotePrefix: 'KPL', quoteStart: 2041 };
const ROW = (o) => Object.assign({ id: 'user-1', email: 'sam@example.com', company_name: 'Keystone Produce Logistics', contact_name: 'Sam Rivera',
  quote_prefix: 'KPL', quote_counter: 2041, is_active: true, plan: 'plus', stripe_customer_id: 'cus_1', stripe_subscription_id: 'sub_1',
  pdf_style: 'modern', pdf_sections: { transit: true, accessorials: true }, pdf_accessorials: RATES }, o);

async function setup(browser, base, { profile = {}, signedIn = false, row = null } = {}) {
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, deviceScaleFactor: 1 });
  const db = { row, patches: [], sends: [], replies: [] };
  await context.addInitScript(([prof, signed]) => {
    if (localStorage.getItem('__seeded')) return;
    localStorage.setItem('__seeded', '1');
    localStorage.setItem('qfc_pro_profile', JSON.stringify(prof));
    if (signed) {
      localStorage.setItem('sb-xgrmbhmgcsbnazupfybd-auth-token', JSON.stringify({ access_token: 'tok', refresh_token: 'r',
        expires_at: Math.floor(Date.now() / 1000) + 3600, user: { id: 'user-1', email: 'sam@example.com' } }));
    }
  }, [{ ...PROFILE, ...profile }, signedIn]);
  await context.route('**/*', async (route) => {
    const req = route.request();
    const url = req.url();
    const json = (b, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(b) });
    if (url.startsWith('blob:') || (url.startsWith(base) && !url.includes('/.netlify/functions/'))) return route.continue();
    if (url.includes('/rest/v1/rpc/my_account')) return json({ row: db.row || null, team: null });
    if (url.includes('/rest/v1/pro_users')) {
      if (req.method() === 'PATCH') { db.patches.push(JSON.parse(req.postData())); return route.fulfill({ status: 204, body: '' }); }
      return json(db.row ? [db.row] : []);
    }
    if (url.includes('/.netlify/functions/send-quote-email')) {
      db.sends.push(JSON.parse(req.postData()));
      const r = db.replies.shift() || { status: 200, body: { status: 'sent', id: 'em_1', sentAt: new Date().toISOString() } };
      return json(r.body, r.status);
    }
    if (url.includes('/.netlify/functions/verify-pro')) {
      const a = db.row || {};
      return json({ active: a.is_active === true, plan: a.plan || 'pro', paid: !!a.stripe_subscription_id, unlimitedUntilRenewal: false });
    }
    if (url.includes('/.netlify/functions/')) return json({});
    if (url.includes('supabase.co')) return json([]);
    if (url.includes('fonts.googleapis.com') || url.includes('fonts.gstatic.com')) return route.continue();
    return route.abort();
  });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('dialog', (d) => d.accept());
  return { context, page, errors, db };
}

// The calculator with a quote: Harrisburg → Boston, 384 miles, picked up Nov 12
async function calculator(t, base, { google = true, driveSecs = 22200, delivery = '' } = {}) {
  await t.page.goto(base + '/index.html');
  await t.page.waitForFunction(() => typeof regionalRates !== 'undefined' && regionalRates !== null && window.QFCQuotePDF);
  await t.page.evaluate(([g, secs, del]) => {
    const set = (id, v) => { document.getElementById(id).value = v; };
    set('origin', 'Harrisburg, PA'); set('dest', 'Boston, MA'); set('miles', 384); set('weight', 38000);
    set('trailer', 'van'); set('commodity', 'standard'); set('margin', 15);
    set('pickup', '2026-11-12'); set('delivery', del);
    setMilesSource(g ? 'google' : 'manual');
    lastDriveSecs = g ? secs : 0;
    applyRegionalRates(); calc(); calcTransit();   // as the date fields do when they change
  }, [google, driveSecs, delivery]);
}
const calcDoc = (t) => t.page.evaluate(() => generateQuotePDF({ returnDoc: true }).html);
// What a quote page says, as text: tags become spaces, so a label and its value stay apart
const docText = (t, html) => String(html).replace(/<style[\s\S]*?<\/style>/g, '').replace(/<[^>]+>/g, ' ')
  .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/\s+/g, ' ');

(async () => {
  const server = await serve();
  const base = `http://127.0.0.1:${server.address().port}`;
  const browser = await chromium.launch();
  let t;

  console.log('=== The transit estimate agrees with the calculator’s trip plan ===');
  t = await setup(browser, base);
  await calculator(t, base);
  const hosCases = [3600, 22200, 8 * 3600, 8.5 * 3600, 11 * 3600, 11 * 3600 + 60, 19 * 3600, 22 * 3600, 30 * 3600, 45 * 3600];
  const disagree = await t.page.evaluate((cases) => cases.map((secs) => {
    calcHOS(secs, '', 'A', 'B');
    const card = { days: Number(document.getElementById('hos-drive-days').textContent), total: document.getElementById('hos-total-time').textContent,
      rests: Number(document.getElementById('hos-rest-stops').textContent), breaks: Number(document.getElementById('hos-breaks').textContent) };
    const p = QFCQuotePDF.transitPlan(secs);
    const ours = { days: p.days, total: fmtTotalTime(p.elapsedSecs), rests: p.rests, breaks: p.breaks };
    return JSON.stringify(card) === JSON.stringify(ours) ? null : { secs, card, ours };
  }).filter(Boolean), hosCases);
  check(`days, rests, breaks and total time match the trip plan for ${hosCases.length} driving times (1 to 45 hours)`, disagree.length === 0, JSON.stringify(disagree));
  const est = await t.page.evaluate(() => [QFCQuotePDF.transitPlan(0, 1042), QFCQuotePDF.transitPlan(0, 0), QFCQuotePDF.transitPlan(0, 384)]);
  check('typed-in miles are estimated at 50 mph (1,042 mi: 20h 50m, 2 days); nothing without miles', est[0].driveSecs === 75024 && est[0].days === 2 && est[0].fromMiles === true && est[1] === null && est[2].days === 1);
  await t.context.close();

  console.log('\n=== The calculator’s quote ===');
  t = await setup(browser, base, { profile: { pdfAccessorials: RATES } });
  await calculator(t, base);
  let html = await calcDoc(t);
  let text = docText(t, html);
  check('a transit estimate from Google’s driving time: 6h 10m, 1 day, no overnight', /Transit estimate/.test(text) && /Driving time About 6h 10m/.test(text) && /Transit 1 day/.test(text) && /Overnight rest None needed/.test(text), text.slice(0, 400));
  check('with a pickup date and no delivery date: the estimated delivery day', /Est\. delivery Thu, Nov 12/.test(text));
  check('it explains the hours-of-service rules it used', /up to 11 hours of driving a day, a 30-minute break after 8 hours, and 10 hours off/.test(text));
  check('the accessorial charges as entered, only the lines filled in', /Accessorial charges Detention \$75 per hour after 2 free hours Layover \$250 per day Truck ordered, not used \$250 Extra stop \$100 per stop Lumper \/ unloading Billed at cost with receipt Tarping \$75 per load Charged only if they apply\. Not part of the all-in rate\./.test(text), text);
  check('the sections come after the rate, before the terms', text.indexOf('All-in rate') < text.indexOf('Transit estimate') && text.indexOf('Transit estimate') < text.indexOf('Accessorial charges') && text.indexOf('Accessorial charges') < text.indexOf('Rates are subject to change'));
  await t.page.setContent(html); await t.page.waitForTimeout(300);
  await t.page.screenshot({ path: path.join(SHOTS, 'quote-with-sections.png'), fullPage: true });

  await calculator(t, base, { google: false });
  text = docText(t, await calcDoc(t));
  check('typed-in miles: driving time estimated from the miles (384 mi at 50 mph: 7h 41m)', /Driving time About 7h 41m/.test(text), text.slice(0, 600));
  await calculator(t, base, { delivery: '2026-11-13' });
  text = docText(t, await calcDoc(t));
  check('with a delivery date set: no estimate of it, and no duplicate "Transit" fact', !/Est\. delivery/.test(text) && !/COMMODITY Standard Freight TRANSIT/i.test(text) && /Transit estimate/.test(text));
  await calculator(t, base, { driveSecs: 15 * 3600 });
  text = docText(t, await calcDoc(t));
  check('a 15-hour drive: 2 days with one overnight rest, delivered the next day', /Transit 2 days/.test(text) && /Overnight rest 1 overnight \(10 h\)/.test(text) && /Est\. delivery Fri, Nov 13/.test(text));
  await t.context.close();

  t = await setup(browser, base, { profile: { pdfAccessorials: RATES, pdfSections: { transit: false, accessorials: false } } });
  await calculator(t, base, { delivery: '2026-11-14' });
  text = docText(t, await calcDoc(t));
  check('switched off in Profile: neither section, and the one-line Transit fact is back', !/Transit estimate/.test(text) && !/Accessorial charges/.test(text) && /Transit \d+ days?/i.test(text), text.slice(0, 600));
  await t.context.close();
  t = await setup(browser, base, { profile: {} });
  await calculator(t, base);
  text = docText(t, await calcDoc(t));
  check('no rates entered: no accessorial section (the transit estimate still shows)', !/Accessorial charges/.test(text) && /Transit estimate/.test(text));
  await t.context.close();
  t = await setup(browser, base, { profile: { pdfStyle: 'classic', pdfAccessorials: RATES } });
  await calculator(t, base);
  html = await calcDoc(t);
  check('Classic quotes are unchanged', /Rate Confirmation/.test(html) && !/Transit estimate|Accessorial charges/.test(html));
  await t.context.close();

  console.log('\n=== Quote log and multi-stop ===');
  t = await setup(browser, base, { profile: { pdfAccessorials: RATES } });
  await calculator(t, base);
  const logged = await t.page.evaluate(() => {
    quoteLog = [{ id: 77, date: 'Nov 1, 26', orig: 'Lancaster, PA', dest: 'New York, NY', miles: 166, trailer: 'van', weight: '40000', pickup: '2026-11-20', delivery: '',
      commodity: 'Standard', quote: 1850, rpm: '11.14', notes: '', customer: null, customerId: null }];
    return generateQuotePDFFromLog(77, { returnDoc: true }).html;
  });
  text = docText(t, logged);
  check('a quote from the log: transit estimated from its miles, delivery from its pickup date, accessorials', /Driving time About 3h 19m/.test(text) && /Est\. delivery Fri, Nov 20/.test(text) && /Accessorial charges Detention/.test(text), text.slice(0, 700));
  const multi = await t.page.evaluate((rates) => QFCQuotePDF.multiStopHTML({ total: 4100, totalMiles: 900, totalWeight: 40000, trailer: 'Dry Van', commodity: 'Produce',
    stops: [{ type: 'pickup', location: 'Hastings, FL', legMiles: 900 }, { type: 'delivery', location: 'Lancaster, PA' }], charges: {}, notes: '' },
    { companyName: 'Keystone', pdfAccessorials: rates }, { number: 'KPL-1', issued: 'Nov 1', validUntil: '' }), RATES);
  check('multi-stop quotes carry the accessorial charges too', /Accessorial charges/.test(multi) && /Extra stop/.test(multi));
  check('no page errors', t.errors.length === 0, t.errors.join(' | '));
  await t.context.close();

  console.log('\n=== Profile → Quote sections ===');
  t = await setup(browser, base, { signedIn: true, row: ROW({ pdf_sections: { transit: true, accessorials: true }, pdf_accessorials: null }) });
  await t.page.goto(base + '/profile.html'); await t.page.waitForTimeout(1800);
  check('the card is there, both switches on by default, no rates yet', await t.page.isVisible('#quote-sections-card') && await t.page.isChecked('#sec-transit') && await t.page.isChecked('#sec-accessorials')
    && (await t.page.inputValue('#acc-detention')) === '');
  await t.page.fill('#acc-detention', '80'); await t.page.fill('#acc-detention-free', '2');
  await t.page.fill('#acc-layover', '275'); await t.page.fill('#acc-tonu', '200'); await t.page.fill('#acc-stop', '');
  await t.page.fill('#acc-lumper', '  Billed   at cost  ');
  await t.page.fill('#acc-o1-label', 'Tarping'); await t.page.fill('#acc-o1-charge', '$75 per load');
  await t.page.fill('#acc-o2-label', 'Half filled'); await t.page.fill('#acc-o2-charge', '');
  await t.page.uncheck('#sec-transit');
  await t.page.locator('#quote-sections-card').screenshot({ path: path.join(SHOTS, 'profile-quote-sections.png') });
  await t.page.click('.save-btn'); await t.page.waitForTimeout(800);
  const patch = t.db.patches.at(-1) || {};
  check('saving sends the switches and the rates, tidied (empty and half-filled lines left out)',
    JSON.stringify(patch.pdf_sections) === JSON.stringify({ transit: false, accessorials: true })
    && JSON.stringify(patch.pdf_accessorials) === JSON.stringify({ detentionRate: 80, detentionFree: 2, layover: 275, tonu: 200, lumper: 'Billed at cost', other: [{ label: 'Tarping', charge: '$75 per load' }] }),
    JSON.stringify({ s: patch.pdf_sections, a: patch.pdf_accessorials }));
  const saved = await t.page.evaluate(() => JSON.parse(localStorage.getItem('qfc_pro_profile')));
  check('and keeps them in this browser for the PDFs', saved.pdfSections.transit === false && saved.pdfAccessorials.layover === 275);
  await t.page.click('input[name="pdf-style"][value="classic"]');
  check('with Classic chosen, the card says the sections are part of the Modern design', await t.page.isVisible('#sec-classic')
    && (await t.page.$eval('#sec-fields', (e) => e.style.opacity)) === '0.55');
  check('no page errors', t.errors.length === 0, t.errors.join(' | '));
  await t.context.close();
  t = await setup(browser, base, { signedIn: true, row: ROW({ pdf_sections: { transit: false, accessorials: true } }) });
  await t.page.goto(base + '/profile.html'); await t.page.waitForTimeout(1800);
  check('loads saved switches and rates from the account', !(await t.page.isChecked('#sec-transit')) && await t.page.isChecked('#sec-accessorials')
    && (await t.page.inputValue('#acc-detention')) === '75' && (await t.page.inputValue('#acc-o1-charge')) === '$75 per load' && (await t.page.inputValue('#acc-o2-label')) === '');
  await t.context.close();

  console.log('\n=== The calculator keeps them when it refreshes the account ===');
  t = await setup(browser, base, { signedIn: true, row: ROW({ pdf_sections: { transit: false, accessorials: true } }) });
  await t.page.goto(base + '/index.html');
  await t.page.waitForFunction(() => { try { return JSON.parse(localStorage.getItem('qfc_pro_profile')).plan === 'plus'; } catch (e) { return false; } });
  const synced = await t.page.evaluate(() => JSON.parse(localStorage.getItem('qfc_pro_profile')));
  check('the section switches and rates come from the account', synced.pdfSections && synced.pdfSections.transit === false && synced.pdfAccessorials && synced.pdfAccessorials.detentionRate === 75, JSON.stringify(synced.pdfSections));
  await t.context.close();

  console.log('\n=== The Email quote window ===');
  t = await setup(browser, base, { signedIn: true, row: ROW() });
  await calculator(t, base);
  await t.page.waitForFunction(() => window.QFCEmailQuote && winLossAllowed());
  await t.page.evaluate(() => {
    window.__built = [];
    const orig = QFCQuotePDF.modernHTML;
    QFCQuotePDF.modernHTML = (q, profile, meta) => { window.__built.push({ sections: profile.pdfSections, number: meta.number }); return orig(q, profile, meta); };
  });
  await t.page.click('#btn-email-quote');
  await t.page.waitForSelector('#qfce-dialog:not([hidden])');
  check('the switches show, set from Profile', await t.page.isVisible('#qfce-dialog .qfce-sections') && await t.page.isChecked('#qfce-dialog input[name=secTransit]')
    && await t.page.isChecked('#qfce-dialog input[name=secAcc]') && (await t.page.textContent('#qfce-dialog .qfce-sec-hint')) === '');
  await t.page.screenshot({ path: path.join(SHOTS, 'email-window-sections.png') });
  await t.page.fill('#qfce-dialog input[name=to]', 'ap@acme.example');
  await t.page.uncheck('#qfce-dialog input[name=secAcc]');
  t.db.replies.push({ status: 502, body: { error: 'send', message: 'The email couldn’t be sent. Check the address and try again.' } });
  const sendNow = async () => {
    await t.page.click('#qfce-dialog .qfce-form .qfce-send');
    await t.page.waitForFunction(() => { const st = document.querySelector('#qfce-dialog .qfce-status'), done = document.querySelector('#qfce-dialog .qfce-done');
      return (done && !done.hidden) || (st && st.textContent && !st.classList.contains('busy')); }, null, { timeout: 20000 });
  };
  await sendNow();
  let built = await t.page.evaluate(() => window.__built);
  check('this quote only: built without the accessorials', built.length === 1 && built[0].sections.transit === true && built[0].sections.accessorials === false, JSON.stringify(built));
  await t.page.check('#qfce-dialog input[name=secAcc]');
  await t.page.uncheck('#qfce-dialog input[name=secTransit]');
  await sendNow();
  built = await t.page.evaluate(() => window.__built);
  const counter = await t.page.evaluate(() => JSON.parse(localStorage.getItem('qfc_pro_profile')).quoteStart);
  check('changing the switches after a failed send makes the page again with the same quote number',
    built.length === 2 && built[1].sections.transit === false && built[1].sections.accessorials === true && built[1].number === built[0].number && counter === 2042 && t.db.sends.length === 2
    && t.db.sends[0].summary.quoteNumber === t.db.sends[1].summary.quoteNumber && t.db.sends[0].pdf !== t.db.sends[1].pdf, JSON.stringify({ built, counter }));
  const prof = await t.page.evaluate(() => JSON.parse(localStorage.getItem('qfc_pro_profile')).pdfSections);
  check('Profile’s settings stay as they were', prof.transit === true && prof.accessorials === true, JSON.stringify(prof));
  check('no page errors', t.errors.length === 0, t.errors.join(' | '));
  await t.context.close();

  t = await setup(browser, base, { signedIn: true, row: ROW({ pdf_accessorials: null }) });
  await calculator(t, base);
  await t.page.waitForFunction(() => window.QFCEmailQuote && winLossAllowed());
  await t.page.click('#btn-email-quote');
  await t.page.waitForSelector('#qfce-dialog:not([hidden])');
  check('no rates yet: the accessorials switch is off and says where to add them', !(await t.page.isChecked('#qfce-dialog input[name=secAcc]')) && await t.page.isDisabled('#qfce-dialog input[name=secAcc]')
    && (await t.page.textContent('#qfce-dialog .qfce-sec-hint')) === '(add your rates under Profile → Quote sections)');
  await t.context.close();
  t = await setup(browser, base, { signedIn: true, row: ROW({ pdf_style: 'classic' }) });
  await calculator(t, base);
  await t.page.waitForFunction(() => window.QFCEmailQuote && winLossAllowed());
  await t.page.click('#btn-email-quote');
  await t.page.waitForSelector('#qfce-dialog:not([hidden])');
  check('Classic quotes: no section switches in the window', !(await t.page.isVisible('#qfce-dialog .qfce-sections')));
  check('no page errors', t.errors.length === 0, t.errors.join(' | '));
  await t.context.close();

  await browser.close();
  server.close();
  console.log(failures ? `\n${failures} SECTIONS CHECK(S) FAILED` : `\nALL SECTIONS CHECKS PASSED (screenshots in ${SHOTS})`);
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
