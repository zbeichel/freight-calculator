// tests/pdf_test.js — the Modern / Classic quote PDFs and their Profile
// settings, in a real browser (needs Playwright with Chromium). Network calls
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
    if (url.startsWith(base) || url.startsWith('blob:')) return route.continue();
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

  await browser.close();
  server.close();
  console.log(failures ? `\n${failures} CHECK(S) FAILED` : `\nALL PDF CHECKS PASSED (screenshots in ${SHOTS})`);
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
