// tests/pdf_test.js — the Modern / Classic quote PDFs (calculator, quote log,
// multi-stop and bulk), custom colors and their Profile settings, in a real browser (needs Playwright with Chromium). Network calls
// other than this site are stubbed. Run from the repository root:
//   node tests/pdf_test.js [folder for screenshots and a sample PDF]
const http = require('http');
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');
const os = require('os');
const ROOT = path.resolve(__dirname, '..');
const SHOTS = process.argv[2] || fs.mkdtempSync(path.join(os.tmpdir(), 'qfc-pdf-'));
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

const PROFILE = { companyName: 'Keystone Produce Logistics', contactName: 'Sam Rivera', phone: '(717) 555-0142',
  email: 'quotes@keystone.example', mcNumber: '123456', dotNumber: '7654321', footerText: 'Licensed Freight Broker',
  quotePrefix: 'KPL', quoteStart: 2041, colorScheme: 'midnight' };

async function setup(browser, base, profileOverrides, opts = {}) {
  const context = await browser.newContext({ viewport: { width: 1200, height: 900 }, deviceScaleFactor: 2 });
  const supa = { row: opts.row || null, patches: [] };
  await context.addInitScript(([profile, signedIn]) => {
    if (localStorage.getItem('__seeded')) return;
    localStorage.setItem('__seeded', '1');
    localStorage.setItem('qfc_pro_profile', JSON.stringify(profile));
    if (signedIn) {
      localStorage.setItem('sb-xgrmbhmgcsbnazupfybd-auth-token', JSON.stringify({ access_token: 'tok', refresh_token: 'r',
        expires_at: Math.floor(Date.now() / 1000) + 3600, user: { id: 'user-1', email: 'sam@example.com' } }));
    }
  }, [{ ...PROFILE, ...profileOverrides }, !!opts.signedIn]);
  await context.route('**/*', async (route) => {
    const url = route.request().url();
    const json = (b) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(b) });
    if (url.startsWith('blob:') || (url.startsWith(base) && !url.includes('/.netlify/functions/'))) return route.continue();
    if (url.includes('/rest/v1/pro_users')) {
      if (route.request().method() === 'PATCH') { supa.patches.push(JSON.parse(route.request().postData())); return route.fulfill({ status: 204, body: '' }); }
      return json(supa.row ? [supa.row] : []);
    }
    if (url.includes('/.netlify/functions/verify-pro')) return json({ active: true, plan: 'pro', paid: true, unlimitedUntilRenewal: false });
    if (url.includes('/.netlify/functions/')) return json({});
    if (url.includes('supabase.co')) return json([]);
    if (url.includes('fonts.googleapis.com') || url.includes('fonts.gstatic.com')) return route.continue();
    return route.abort();
  });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  return { context, page, errors, supa };
}

// Fills the calculator and returns the PDF tab it opens.
async function calculatorPDF(t, opts = {}) {
  await t.page.evaluate((o) => {
    const set = (id, v) => { document.getElementById(id).value = v; };
    set('origin', 'Hastings, FL'); set('dest', 'Lancaster, PA'); set('miles', 1042); set('weight', 42000);
    set('trailer', 'reefer'); set('commodity', 'food'); set('margin', 15);
    set('pickup', '2026-11-16'); set('delivery', '2026-11-18');
    set('load-notes', 'Keep at 34°F. <b>Appointment</b> required at delivery.');
    applyRegionalRates();
    document.getElementById('diesel-enabled').checked = !!o.diesel;
    if (o.diesel) set('diesel-price', 3.85);
    calc(); calcTransit();
  }, opts);
  const [tab] = await Promise.all([t.context.waitForEvent('page'), t.page.evaluate(() => generateQuotePDF())]);
  await tab.waitForLoadState('load');
  await tab.waitForTimeout(400);
  return tab;
}

(async () => {
  const server = await serve();
  const base = `http://127.0.0.1:${server.address().port}`;
  const browser = await chromium.launch();

  console.log('\n=== Modern PDF from the calculator (default) ===');
  let t = await setup(browser, base, {});
  await t.page.goto(base + '/index.html');
  await t.page.waitForFunction(() => typeof regionalRates !== 'undefined' && regionalRates !== null && window.QFCQuotePDF);
  let tab = await calculatorPDF(t, { diesel: true });
  let text = (await tab.textContent('body')).replace(/\s+/g, ' ');
  const shownQuote = await t.page.textContent('#r-quote');
  check('Modern by default: "Freight Quote", not "Rate Confirmation"', text.includes('Freight Quote') && !text.includes('Rate Confirmation'));
  check('quote number KPL-YYYYMMDD-2041 and counter advanced', /KPL-\d{8}-2041/.test(text)
    && (await t.page.evaluate(() => JSON.parse(localStorage.getItem('qfc_pro_profile')).quoteStart)) === 2042);
  check('company, contact strip, MC/DOT', text.includes('Keystone Produce Logistics') && text.includes('(717) 555-0142') && text.includes('MC# 123456') && text.includes('DOT# 7654321'));
  check('lane, dates, miles, equipment, weight, commodity, transit', text.includes('Hastings, FL') && text.includes('Lancaster, PA')
    && text.includes('1,042 mi') && text.includes('Reefer') && text.includes('42,000 lbs') && text.includes('Food / Perishable') && text.includes('2 days'));
  check('all-in rate matches the calculator', text.includes(shownQuote), `${shownQuote}`);
  const lines = await tab.$$eval('.line-item', (els) => els.map((e) => e.textContent.replace(/\s+/g, ' ').trim()));
  const amounts = lines.map((l) => Number(l.replace(/[^0-9]/g, '')));
  check('breakdown: linehaul + fuel add up to the total', lines.length === 2 && /^Linehaul/.test(lines[0]) && /^Fuel surcharge/.test(lines[1])
    && amounts[0] + amounts[1] === Number(shownQuote.replace(/[^0-9]/g, '')), JSON.stringify(lines));
  check('valid-until time and signature lines', text.includes('Valid until') && text.includes('Accepted by') && text.includes('Authorized by — Sam Rivera'));
  check('notes shown as text (no HTML from notes)', text.includes('<b>Appointment</b>') && !(await tab.$('.notes-text b')));
  await tab.screenshot({ path: path.join(SHOTS, 'modern_screen.png'), fullPage: true });
  await tab.pdf({ path: path.join(SHOTS, 'modern.pdf'), format: 'Letter', printBackground: true });
  await tab.emulateMedia({ media: 'print' });
  const pageCount = await tab.evaluate(() => Math.ceil(document.querySelector('.doc').getBoundingClientRect().height / 1056));
  check('prints on one Letter page', pageCount === 1, String(pageCount));
  check('no page errors', t.errors.length === 0, t.errors.join(' | '));

  console.log('\n=== Modern without fuel: no breakdown ===');
  tab = await calculatorPDF(t, { diesel: false });
  check('no fuel or extra days → just the all-in rate', (await tab.$$('.line-item')).length === 0
    && (await tab.textContent('.terms')).includes('includes linehaul and fuel'));
  await t.context.close();

  console.log('\n=== Breakdown turned off ===');
  t = await setup(browser, base, { pdfBreakdown: false });
  await t.page.goto(base + '/index.html');
  await t.page.waitForFunction(() => typeof regionalRates !== 'undefined' && regionalRates !== null && window.QFCQuotePDF);
  tab = await calculatorPDF(t, { diesel: true });
  check('pdfBreakdown false → no line items', (await tab.$$('.line-item')).length === 0);
  await t.context.close();

  console.log('\n=== Classic PDF (kept for anyone who chooses it) ===');
  t = await setup(browser, base, { pdfStyle: 'classic' });
  await t.page.goto(base + '/index.html');
  await t.page.waitForFunction(() => typeof regionalRates !== 'undefined' && regionalRates !== null && window.QFCQuotePDF);
  tab = await calculatorPDF(t, { diesel: true });
  text = (await tab.textContent('body')).replace(/\s+/g, ' ');
  check('Classic: the original "Rate Confirmation" template', text.includes('Rate Confirmation') && text.includes('Total Quote to Customer') && !text.includes('Freight Quote'));
  await tab.screenshot({ path: path.join(SHOTS, 'classic_screen.png'), fullPage: true });

  console.log('\n=== Quote log PDF ===');
  const logPDF = async (pg, ctx) => {
    const [tb] = await Promise.all([ctx.waitForEvent('page'), pg.evaluate(() => {
      quoteLog.push({ id: 99, orig: 'Chicago, IL', dest: 'Dallas, TX', miles: 925, quote: 2875, rpm: '3.11', trailer: 'van',
        commodity: 'Standard Freight', weight: '38000', pickup: 'Tue, Nov 17', delivery: 'Thu, Nov 19', notes: 'Logged quote' });
      generateQuotePDFFromLog(99);
    })]);
    await tb.waitForLoadState('load');
    return (await tb.textContent('body')).replace(/\s+/g, ' ');
  };
  text = await logPDF(t.page, t.context);
  check('quote log, Classic chosen → Classic', text.includes('Rate Confirmation'));
  await t.context.close();
  t = await setup(browser, base, {});
  await t.page.goto(base + '/index.html');
  await t.page.waitForFunction(() => typeof quoteLog !== 'undefined' && window.QFCQuotePDF);
  text = await logPDF(t.page, t.context);
  check('quote log, default → Modern with the logged numbers', text.includes('Freight Quote') && text.includes('Chicago, IL') && text.includes('$2,875')
    && text.includes('$3.11') && text.includes('925 mi') && text.includes('38,000 lbs'));
  check('no page errors', t.errors.length === 0, t.errors.join(' | '));
  await t.context.close();

  console.log('\n=== Profile: style, breakdown, hide logo, preview, save, load ===');
  t = await setup(browser, base, {}, { signedIn: true, row: { id: 'user-1', is_active: true, plan: 'pro', stripe_customer_id: 'cus_1',
    company_name: 'Keystone Produce Logistics', contact_name: 'Sam Rivera', color_scheme: 'ocean', pdf_style: 'classic', pdf_breakdown: false, hide_logo: true } });
  await t.page.goto(base + '/profile.html'); await t.page.waitForTimeout(1800);
  check('loads saved settings: Classic, breakdown off, hide logo on', await t.page.isChecked('input[name="pdf-style"][value="classic"]')
    && !(await t.page.isChecked('#pdf-breakdown')) && await t.page.isChecked('#hide-logo'));
  check('Classic: sample button and breakdown option hidden, preview says Rate Confirmation',
    !(await t.page.isVisible('#pdf-sample-btn')) && !(await t.page.isVisible('#pdf-breakdown-wrap'))
    && (await t.page.textContent('#preview-title')) === 'Rate Confirmation');
  await t.page.click('input[name="pdf-style"][value="modern"]');
  await t.page.waitForTimeout(500);
  check('Modern: preview switches to the white letterhead', (await t.page.textContent('#preview-title')) === 'Freight Quote'
    && (await t.page.$eval('#preview-header', (e) => getComputedStyle(e).backgroundColor)) === 'rgb(255, 255, 255)');
  await t.page.locator('.section-card:has(#pdf-sample-btn)').screenshot({ path: path.join(SHOTS, 'profile_style.png') });
  const [sample] = await Promise.all([t.context.waitForEvent('page'), t.page.click('#pdf-sample-btn')]);
  await sample.waitForLoadState('load');
  const sampleText = await sample.textContent('body');
  check('sample quote opens with your company and the ocean colors', sampleText.includes('Keystone Produce Logistics') && sampleText.includes('Hastings, FL')
    && (await sample.$eval('.rule', (e) => getComputedStyle(e).backgroundColor)) === 'rgb(8, 145, 178)');
  check('sample doesn\'t use up a quote number', (await t.page.evaluate(() => JSON.parse(localStorage.getItem('qfc_pro_profile') || '{}').quoteStart)) === 2041);
  await t.page.check('#pdf-breakdown');
  await t.page.click('.save-btn'); await t.page.waitForTimeout(800);
  const patch = t.supa.patches.at(-1) || {};
  check('save sends style, breakdown and hide logo to the account', patch.pdf_style === 'modern' && patch.pdf_breakdown === true && patch.hide_logo === true, JSON.stringify(patch));
  const local = await t.page.evaluate(() => JSON.parse(localStorage.getItem('qfc_pro_profile')));
  check('and keeps them in this browser for the PDFs', local.pdfStyle === 'modern' && local.pdfBreakdown === true && local.hideLogo === true);
  check('no page errors', t.errors.length === 0, t.errors.join(' | '));
  await t.context.close();

  console.log('\n=== Calculator: account settings reach the PDFs, quote counter never goes back ===');
  t = await setup(browser, base, { quoteStart: 2050, hideLogo: false }, { signedIn: true, row: { id: 'user-1', is_active: true, plan: 'pro',
    company_name: 'Keystone Produce Logistics', quote_prefix: 'KPL', quote_counter: 2041, color_scheme: 'midnight', pdf_style: 'classic', pdf_breakdown: true, hide_logo: true } });
  await t.page.goto(base + '/index.html'); await t.page.waitForTimeout(2000);
  const synced = await t.page.evaluate(() => JSON.parse(localStorage.getItem('qfc_pro_profile')));
  check('sync keeps the higher counter (2050, not 2041)', synced.quoteStart === 2050, String(synced.quoteStart));
  check('sync brings Classic + hide logo from the account', synced.pdfStyle === 'classic' && synced.hideLogo === true);
  await t.context.close();

  // ── Multi-stop ──────────────────────────────────────────────────────────
  const multiStopPDF = async (t) => {
    await t.page.goto(base + '/multistop.html');
    await t.page.waitForFunction(() => typeof calcTotal === 'function' && window.QFCQuotePDF);
    await t.page.waitForTimeout(800);
    await t.page.evaluate(() => {
      stops = [
        { id: 1, type: 'pickup', location: 'Hastings, FL', miles: 0, weight: '20000', date: '2026-11-16' },
        { id: 2, type: 'pickup', location: 'Palatka, FL', miles: 0, weight: '18000', date: '2026-11-16' },
        { id: 3, type: 'delivery', location: 'Lancaster, PA', miles: 0, weight: '', date: '2026-11-18' },
        { id: 4, type: 'delivery', location: 'Allentown, PA', miles: 0, weight: '', date: '2026-11-18' },
      ];
      stopIdCounter = 4;
      legMiles = { 1: 25, 2: 1010, 3: 80 };
      document.getElementById('ms-diesel-enabled').checked = true;
      document.getElementById('ms-diesel-price').value = 3.85;
      document.getElementById('ms-load-notes').value = 'Two pickups, two drops.';
      calcTotal();
    });
    const [tb] = await Promise.all([t.context.waitForEvent('page'), t.page.evaluate(() => generateMultiStopPDF())]);
    await tb.waitForLoadState('load');
    await tb.waitForTimeout(300);
    return tb;
  };

  console.log('\n=== Multi-stop: Modern ===');
  t = await setup(browser, base, {}, { signedIn: true });
  tab = await multiStopPDF(t);
  text = (await tab.textContent('body')).replace(/\s+/g, ' ');
  const msTotal = await t.page.textContent('#ms-quote');
  check('Modern multi-stop: title, all four stops in order', text.includes('Multi-Stop Freight Quote')
    && /Hastings, FL.*Palatka, FL.*Lancaster, PA.*Allentown, PA/.test(text));
  check('totals: 1,115 mi, 38,000 lbs, 4 stops (2 pickups, 2 deliveries)', text.includes('Total miles')
    && text.includes('1,115 mi') && text.includes('38,000 lbs') && text.includes('4 stops · 2 pickups · 2 deliveries'));
  check('the two extra stops are marked', (await tab.$$('.s-chip')).length === 2);
  check('all-in rate matches the page', text.includes(msTotal), msTotal);
  const msLines = await tab.$$eval('.line-item', (els) => els.map((e) => Number(e.lastElementChild.textContent.replace(/[^0-9]/g, ''))));
  const msLabels = await tab.$$eval('.line-item', (els) => els.map((e) => e.firstElementChild.textContent));
  check('linehaul + fuel + stop charges add up to the total (margin spread, not shown)',
    msLabels.join('|') === 'Linehaul|Fuel surcharge|Stop charges' && msLines.reduce((a, b) => a + b, 0) === Number(msTotal.replace(/[^0-9]/g, '')),
    msLabels.join('|') + ' ' + msLines.join('+'));
  check('quote numbered in sequence (not random)', /KPL-\d{8}-2041/.test(text));
  await tab.screenshot({ path: path.join(SHOTS, 'modern_multistop.png'), fullPage: true });
  await tab.emulateMedia({ media: 'print' });
  await tab.pdf({ path: path.join(SHOTS, 'modern_multistop.pdf'), format: 'Letter', printBackground: true });
  const msPages = (fs.readFileSync(path.join(SHOTS, 'modern_multistop.pdf')).toString('latin1').match(/\/Type\s*\/Page[^s]/g) || []).length;
  check('a 4-stop quote prints on one Letter page', msPages === 1, msPages + ' pages');
  check('no page errors', t.errors.length === 0, t.errors.join(' | '));
  await t.context.close();

  console.log('\n=== Multi-stop: Classic ===');
  t = await setup(browser, base, { pdfStyle: 'classic' }, { signedIn: true });
  tab = await multiStopPDF(t);
  check('Classic multi-stop: the original template', (await tab.textContent('body')).includes('Multi-Stop Rate Confirmation'));
  await t.context.close();

  // ── Bulk ────────────────────────────────────────────────────────────────
  const bulkPDF = async (t) => {
    await t.page.goto(base + '/bulk.html');
    await t.page.waitForFunction(() => typeof generateBulkPDF === 'function' && window.QFCQuotePDF);
    await t.page.waitForTimeout(800);
    await t.page.evaluate(() => {
      const set = (id, v) => { document.getElementById(id).value = v; };
      set('origin', 'Presque Isle, ME'); set('dest', 'Hanover, PA'); set('loaded-miles', 712); set('deadhead-miles', 40);
      set('cwt', 450); set('target-rpm', 2.5); set('offered-rate', 4.35);
      calc();
    });
    const [tb] = await Promise.all([t.context.waitForEvent('page'), t.page.evaluate(() => generateBulkPDF())]);
    await tb.waitForLoadState('load');
    await tb.waitForTimeout(300);
    return tb;
  };

  console.log('\n=== Bulk: Modern ===');
  t = await setup(browser, base, {}, { signedIn: true });
  tab = await bulkPDF(t);
  text = (await tab.textContent('body')).replace(/\s+/g, ' ');
  check('Modern bulk: title, B-numbered quote, lane and deadhead', text.includes('Bulk Load Quote') && /KPL-B-\d{8}-2041/.test(text)
    && text.includes('Presque Isle, ME') && text.includes('Hanover, PA') && text.includes('712 loaded mi') && text.includes('40 mi deadhead'));
  check('rate per cwt, base and fuel lines, total load revenue', text.includes('$4.35 / cwt') && text.includes('Base rate')
    && text.includes('$4.35 × 450 cwt') && text.includes('Fuel surcharge') && text.includes('Total load revenue'));
  check('target comparison like the Classic one', text.includes('Target comparison') && /profit margin over target|short of target/.test(text));
  check('no "valid until" or signatures on the bulk sheet (same as Classic)', !text.includes('Valid until') && !text.includes('Accepted by'));
  await tab.screenshot({ path: path.join(SHOTS, 'modern_bulk.png'), fullPage: true });
  check('no page errors', t.errors.length === 0, t.errors.join(' | '));
  await t.context.close();

  console.log('\n=== Bulk: Classic ===');
  t = await setup(browser, base, { pdfStyle: 'classic' }, { signedIn: true });
  tab = await bulkPDF(t);
  text = (await tab.textContent('body')).replace(/\s+/g, ' ');
  check('Classic bulk: the original template', text.includes('Total Load Revenue') && text.includes('Calculation Settings'));
  await t.context.close();

  // ── Custom colors ───────────────────────────────────────────────────────
  console.log('\n=== Custom colors ===');
  const custom = { colorScheme: 'custom', pdfAccent: '#7c3aed', pdfInk: '#123456' };
  t = await setup(browser, base, custom);
  await t.page.goto(base + '/index.html');
  await t.page.waitForFunction(() => typeof regionalRates !== 'undefined' && regionalRates !== null && window.QFCQuotePDF);
  tab = await calculatorPDF(t, { diesel: true });
  check('Modern: your accent on the rule, your heading color on the title',
    (await tab.$eval('.rule', (e) => getComputedStyle(e).backgroundColor)) === 'rgb(124, 58, 237)'
    && (await tab.$eval('.title', (e) => getComputedStyle(e).color)) === 'rgb(18, 52, 86)');
  await tab.screenshot({ path: path.join(SHOTS, 'modern_custom.png'), fullPage: true });
  await t.context.close();
  t = await setup(browser, base, { ...custom, pdfStyle: 'classic' });
  await t.page.goto(base + '/index.html');
  await t.page.waitForFunction(() => typeof regionalRates !== 'undefined' && regionalRates !== null && window.QFCQuotePDF);
  tab = await calculatorPDF(t, { diesel: true });
  check('Classic: header bar in your heading color, accent bar in your accent',
    (await tab.$eval('.doc-header', (e) => getComputedStyle(e).backgroundColor)) === 'rgb(18, 52, 86)'
    && (await tab.$eval('.accent-bar', (e) => getComputedStyle(e).backgroundImage)).includes('rgb(124, 58, 237)'));
  await tab.screenshot({ path: path.join(SHOTS, 'classic_custom.png'), fullPage: true });
  await t.context.close();
  t = await setup(browser, base, { colorScheme: 'custom', pdfAccent: 'red;}</style><script>window.__x=1</script>', pdfInk: '#f5f5f5' });
  await t.page.goto(base + '/index.html');
  await t.page.waitForFunction(() => typeof regionalRates !== 'undefined' && regionalRates !== null && window.QFCQuotePDF);
  tab = await calculatorPDF(t, {});
  check('a bad color value is ignored (default accent), never added to the page',
    (await tab.$eval('.rule', (e) => getComputedStyle(e).backgroundColor)) === 'rgb(240, 165, 0)'
    && !(await tab.content()).includes('window.__x') && !(await tab.evaluate(() => window.__x)));
  check('a heading color too light for paper falls back to near-black on Modern',
    (await tab.$eval('.title', (e) => getComputedStyle(e).color)) === 'rgb(31, 41, 55)');
  await t.context.close();

  console.log('\n=== Profile: custom color pickers ===');
  t = await setup(browser, base, {}, { signedIn: true, row: { id: 'user-1', is_active: true, plan: 'pro', stripe_customer_id: 'cus_1',
    company_name: 'Keystone Produce Logistics', color_scheme: 'midnight' } });
  await t.page.goto(base + '/profile.html'); await t.page.waitForTimeout(1800);
  check('pickers hidden until Custom is chosen', !(await t.page.isVisible('#custom-colors')));
  await t.page.click('#scheme-custom');
  check('Custom card shows the pickers', await t.page.isVisible('#custom-colors') && await t.page.$eval('#scheme-custom', (e) => e.classList.contains('active')));
  await t.page.evaluate(() => {
    const a = document.getElementById('pdf-accent'); a.value = '#0f766e'; a.dispatchEvent(new Event('input', { bubbles: true }));
    const i = document.getElementById('pdf-ink'); i.value = '#3b0764'; i.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await t.page.waitForTimeout(450);
  check('live preview uses the picked colors (Modern)', (await t.page.$eval('#preview-bar', (e) => getComputedStyle(e).backgroundColor)) === 'rgb(15, 118, 110)'
    && (await t.page.$eval('#preview-title', (e) => getComputedStyle(e).color)) === 'rgb(59, 7, 100)');
  check('hex codes shown under the pickers', (await t.page.textContent('#pdf-accent-hex')) === '#0F766E' && (await t.page.textContent('#pdf-ink-hex')) === '#3B0764');
  await t.page.click('input[name="pdf-style"][value="classic"]');
  await t.page.waitForTimeout(450);
  check('live preview uses them for Classic too', (await t.page.$eval('#preview-header', (e) => getComputedStyle(e).backgroundColor)) === 'rgb(59, 7, 100)');
  await t.page.locator('.section-card:has(#scheme-grid)').screenshot({ path: path.join(SHOTS, 'profile_custom_colors.png') });
  await t.page.click('.save-btn'); await t.page.waitForTimeout(800);
  const cpatch = t.supa.patches.at(-1) || {};
  check('save sends Custom with both colors', cpatch.color_scheme === 'custom' && cpatch.pdf_accent === '#0f766e' && cpatch.pdf_ink === '#3b0764', JSON.stringify(cpatch));
  check('no page errors', t.errors.length === 0, t.errors.join(' | '));
  await t.context.close();
  t = await setup(browser, base, {}, { signedIn: true, row: { id: 'user-1', is_active: true, plan: 'pro', stripe_customer_id: 'cus_1',
    color_scheme: 'custom', pdf_accent: '#0f766e', pdf_ink: '#3b0764' } });
  await t.page.goto(base + '/profile.html'); await t.page.waitForTimeout(1800);
  check('loads saved custom colors from the account', await t.page.$eval('#scheme-custom', (e) => e.classList.contains('active'))
    && (await t.page.inputValue('#pdf-accent')) === '#0f766e' && (await t.page.inputValue('#pdf-ink')) === '#3b0764');
  await t.context.close();

  await browser.close();
  server.close();
  console.log(failures ? `\n${failures} CHECK(S) FAILED` : `\nALL PDF CHECKS PASSED (screenshots in ${SHOTS})`);
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
