// tests/email_ui_test.js — emailing a quote from the calculator and the quote
// log (Pro Plus and up), in a real browser (needs Playwright with Chromium):
// the window fills in from the linked customer, the PDF is made from the same
// page the PDF button opens (and carries one quote number, even across a
// retry), the quote log shows what was emailed, and Pro / signed-out accounts
// see the upgrade instead. Supabase and the send-quote-email function are
// replaced by small fakes. Run from the repository root:
//   node tests/email_ui_test.js [folder for screenshots]
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { chromium } = require('playwright');
const ROOT = path.resolve(__dirname, '..');
const SHOTS = process.argv[2] || fs.mkdtempSync(path.join(os.tmpdir(), 'qfc-email-'));
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.json': 'application/json', '.css': 'text/css' };
const DAY = 86400000;
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

const ACCT = (o) => Object.assign({ id: 'user-1', email: 'sam@example.com', company_name: 'Keystone Produce Logistics',
  contact_name: 'Sam Rivera', quote_prefix: 'KPL', quote_counter: 2041,
  is_active: true, plan: 'plus', stripe_customer_id: 'cus_1', stripe_subscription_id: 'sub_1' }, o);
const CUSTOMER = (id, name, o = {}) => Object.assign({ id, user_id: 'user-1', name, contact_name: null, email: null, phone: null,
  address: null, notes: null, default_margin: null, created_at: '2026-10-01T12:00:00Z', updated_at: '2026-10-01T12:00:00Z' }, o);
const QUOTE = (id, daysAgo, o = {}) => Object.assign({
  id, user_id: 'user-1', date: 'Nov 1, 26', origin: 'Lancaster, PA', destination: 'New York, NY',
  miles: 166, trailer: 'van', weight: '40000', pickup_date: '2026-11-20', delivery_date: null,
  commodity: 'Standard', commodity_key: 'standard', margin: '15%', base_rpm: '2.40', quote: 1850, rpm: '11.14',
  notes: '', created_at: new Date(Date.now() - daysAgo * DAY).toISOString(), tracked: true,
  customer: null, customer_id: null, outcome: 'open', outcome_at: null, final_rate: null, lost_reason: null,
}, o);
const SEED_CUSTOMERS = [CUSTOMER(1, 'Acme Foods', { contact_name: 'Jo Smith', email: 'ap@acme.example' })];
const LONG_NOTES = Array.from({ length: 70 }, (_, i) => `Stop ${i + 1}: call ahead, dock hours 7am-3pm, lumper paid by receiver.`).join('\n');
const SEED_QUOTES = [
  QUOTE(201, 1),
  QUOTE(202, 2, { customer: 'Acme Foods', customer_id: 1 }),
  QUOTE(203, 3, { notes: LONG_NOTES }),
];

async function setup(browser, base, { account, customers = SEED_CUSTOMERS, quotes = SEED_QUOTES, emails = [], signedIn = true, profile = {}, phone = false }) {
  const context = await browser.newContext(phone
    ? { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true }
    : { viewport: { width: 1280, height: 900 }, deviceScaleFactor: 2 });
  const db = { account, customers: customers.map((c) => ({ ...c })), quotes: quotes.map((q) => ({ ...q })), emails: emails.slice(),
    nextQuote: 5000, sends: [], replies: [] };
  await context.addInitScript(([signed, prof]) => {
    if (localStorage.getItem('__seeded')) return;
    localStorage.setItem('__seeded', '1');
    if (signed) {
      localStorage.setItem('sb-xgrmbhmgcsbnazupfybd-auth-token', JSON.stringify({ access_token: 'tok', refresh_token: 'r',
        expires_at: Math.floor(Date.now() / 1000) + 3600, user: { id: 'user-1', email: 'sam@example.com' } }));
    }
    localStorage.setItem('qfc_pro_profile', JSON.stringify(Object.assign({ companyName: 'Keystone Produce Logistics',
      contactName: 'Sam Rivera', quotePrefix: 'KPL', quoteStart: 2041 }, prof)));
  }, [signedIn, profile]);
  await context.route('**/*', async (route) => {
    const req = route.request();
    const url = req.url();
    const method = req.method();
    const json = (b, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(b) });
    if (url.startsWith('blob:') || (url.startsWith(base) && !url.includes('/.netlify/functions/'))) return route.continue();
    const u = new URL(url);
    if (url.includes('/rest/v1/customers')) return json(method === 'GET' ? db.customers : []);
    if (url.includes('/rest/v1/quote_emails')) return json(db.emails);
    if (url.includes('/rest/v1/quote_log')) {
      if (method === 'GET') {
        const sorted = db.quotes.slice().sort((a, b) => b.created_at.localeCompare(a.created_at) || b.id - a.id);
        const offset = Number(u.searchParams.get('offset') || 0), limit = Number(u.searchParams.get('limit') || 1000);
        return json(sorted.slice(offset, offset + limit));
      }
      if (method === 'POST') {
        const row = QUOTE(db.nextQuote++, 0, JSON.parse(req.postData()));
        db.quotes.push(row);
        return json([row], 201);
      }
      return json([]);
    }
    if (url.includes('/rest/v1/pro_users')) {
      if (method === 'PATCH') return route.fulfill({ status: 204, body: '' });
      return json(db.account ? [db.account] : []);
    }
    if (url.includes('/.netlify/functions/send-quote-email')) {
      db.sends.push({ body: JSON.parse(req.postData()), auth: req.headers().authorization });
      const r = db.replies.shift() || { status: 200, body: { status: 'sent', id: 'em_' + db.sends.length, sentAt: new Date().toISOString() } };
      return json(r.body, r.status);
    }
    if (url.includes('/.netlify/functions/verify-pro')) {
      const a = db.account || {};
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

const flat = (s) => String(s || '').replace(/\s+/g, ' ').trim();
const text = (pg, sel) => pg.$eval(sel, (e) => e.innerText).then(flat).catch(() => '');
const visible = (pg, sel) => pg.isVisible(sel).catch(() => false);
const pdfInfo = (b64) => {
  const raw = Buffer.from(b64 || '', 'base64').toString('latin1');
  return { isPdf: raw.startsWith('%PDF-'), pages: (raw.match(/\/Type \/Page[^s]/g) || []).length, image: /\/Subtype \/Image/.test(raw), kb: Math.round(raw.length / 1024) };
};

async function openCalculator(t, base, quoteCount, { customers = 1 } = {}) {
  await t.page.goto(base + '/index.html');
  await t.page.waitForFunction(([q, c]) => typeof quoteLog !== 'undefined' && quoteLog.length === q
    && typeof regionalRates !== 'undefined' && regionalRates !== null && window.QFCQuotePDF && window.QFCEmailQuote
    && (!c || (window.QFCCustomers && QFCCustomers.all().length === c)), [quoteCount, customers]);
  await t.page.evaluate(() => {
    const set = (id, v) => { document.getElementById(id).value = v; };
    set('origin', 'Harrisburg, PA'); set('dest', 'Boston, MA'); set('miles', 384); set('weight', 38000);
    set('trailer', 'van'); set('commodity', 'standard'); set('margin', 15);
    applyRegionalRates(); calc();
  });
}
const linkCustomer = (t, id, name) => t.page.evaluate(([cid, cname]) => {
  const el = document.getElementById('quote-customer');
  el.value = cname; el.dataset.customerId = String(cid);
}, [id, name]);
const quoteStart = (t) => t.page.evaluate(() => JSON.parse(localStorage.getItem('qfc_pro_profile') || '{}').quoteStart);
async function send(t) {
  await t.page.click('#qfce-dialog .qfce-form .qfce-send');
  await t.page.waitForFunction(() => {
    const st = document.querySelector('#qfce-dialog .qfce-status');
    const done = document.querySelector('#qfce-dialog .qfce-done');
    return (done && !done.hidden) || (st && st.textContent && !st.classList.contains('busy'));
  }, null, { timeout: 20000 });
}

(async () => {
  const server = await serve();
  const base = `http://127.0.0.1:${server.address().port}`;
  const browser = await chromium.launch();
  let t;

  console.log('=== Pro Plus: emailing from the calculator ===');
  t = await setup(browser, base, { account: ACCT() });
  await openCalculator(t, base, 3);
  check('the Email button sits beside Download, ready, with no plan tag',
    await t.page.isEnabled('#btn-email-quote') && !(await visible(t.page, '#email-plus-tag'))
    && (await t.page.$eval('#btn-email-quote', (b) => b.parentElement === document.getElementById('btn-download-quote').parentElement)));
  await linkCustomer(t, 1, 'Acme Foods');
  await t.page.click('#btn-email-quote');
  await t.page.waitForSelector('#qfce-dialog:not([hidden])');
  const rQuote = await text(t.page, '#r-quote');
  check('filled in from the linked customer', (await t.page.inputValue('#qfce-dialog input[name=to]')) === 'ap@acme.example'
    && (await t.page.inputValue('#qfce-dialog textarea[name=message]')).startsWith('Hi Jo,'));
  check('the subject names the lane', (await t.page.inputValue('#qfce-dialog input[name=subject]')) === 'Rate quote: Harrisburg, PA to Boston, MA');
  const lane = await text(t.page, '#qfce-dialog .qfce-lane');
  check('the window shows the lane, equipment, rate and customer', lane.includes('Harrisburg, PA → Boston, MA') && lane.includes('Dry Van') && lane.includes(rQuote) && lane.includes('For Acme Foods'), lane);
  check('how long it’s good for (24 hours on Pro Plus, not changeable)', /Good for 24 hours, until about/.test(await text(t.page, '#qfce-dialog .qfce-valid'))
    && !(await text(t.page, '#qfce-dialog .qfce-valid')).includes('Profile'));
  const help = await text(t.page, '#qfce-dialog .qfce-help');
  check('who it’s from, and where replies go', help.includes('Keystone Produce Logistics via QuickFreightCalc') && help.includes('sam@example.com'), help);
  await t.page.screenshot({ path: path.join(SHOTS, 'email-window.png') });

  await t.page.fill('#qfce-dialog input[name=to]', 'jo-at-acme');
  await t.page.click('#qfce-dialog .qfce-form .qfce-send');
  check('a bad address is caught before anything is made or sent', (await text(t.page, '#qfce-dialog .qfce-status')) === 'Enter the customer’s email address.'
    && t.db.sends.length === 0 && (await quoteStart(t)) === 2041);
  await t.page.fill('#qfce-dialog input[name=to]', 'Jo@Acme.example');
  t.db.replies.push({ status: 502, body: { error: 'send', message: 'The email couldn’t be sent. Check the address and try again.' } });
  await send(t);
  check('a failed send says so, and the window stays open', (await text(t.page, '#qfce-dialog .qfce-status')).startsWith('The email couldn’t be sent')
    && t.db.sends.length === 1 && !(await visible(t.page, '#qfce-dialog .qfce-done')));
  await send(t);
  check('sending again works', await visible(t.page, '#qfce-dialog .qfce-done') && (await text(t.page, '#qfce-dialog .qfce-done-sub')).startsWith('Sent to jo@acme.example'));
  const [s1, s2] = t.db.sends.map((x) => x.body);
  check('the retry sends the same PDF and quote number, and only one number was used',
    s1.pdf === s2.pdf && s1.summary.quoteNumber === s2.summary.quoteNumber && (await quoteStart(t)) === 2042 && /^KPL-\d{8}-2041$/.test(s2.summary.quoteNumber), s2.summary.quoteNumber);
  check('each attempt has its own key, signed in as the user', s1.sendKey !== s2.sendKey && t.db.sends.every((x) => x.auth === 'Bearer tok'));
  const pdf1 = pdfInfo(s2.pdf);
  check('a real one-page PDF of the quote', pdf1.isPdf && pdf1.pages === 1 && pdf1.image && pdf1.kb > 20 && pdf1.kb < 3000, JSON.stringify(pdf1));
  check('named for its quote number', s2.filename === `Quote ${s2.summary.quoteNumber}.pdf`, s2.filename);
  check('the email body gets the lane, rate and valid-until', s2.summary.origin === 'Harrisburg, PA' && s2.summary.destination === 'Boston, MA'
    && s2.summary.rate === rQuote && s2.summary.equipment === 'Dry Van' && s2.summary.miles === '384' && /\d{4}, \d{1,2}:\d{2}\s?[AP]M/.test(s2.validLabel)
    && new Date(s2.validUntil) - Date.now() > 23 * 3600000, JSON.stringify({ s: s2.summary, v: s2.validLabel }));
  check('to, subject, copy setting as entered; not linked to a log entry', s2.to === 'jo@acme.example' && s2.subject === 'Rate quote: Harrisburg, PA to Boston, MA' && s2.ccMe === false && s2.quoteId === null);
  await t.page.click('#qfce-dialog .qfce-close');
  check('Done closes the window', !(await visible(t.page, '#qfce-dialog')));

  // Save, then email: linked to the saved quote, and the log says so
  await t.page.evaluate(() => saveQuote());
  await t.page.waitForFunction(() => quoteLog[0] && quoteLog[0].id === 5000 && !quoteLog[0].pending);
  await t.page.click('#btn-email-quote');
  await t.page.waitForSelector('#qfce-dialog:not([hidden])');
  await t.page.check('#qfce-dialog input[name=ccMe]');
  await send(t);
  const s3 = t.db.sends[2].body;
  check('emailed right after saving: linked to the saved quote, copy to me', s3.quoteId === 5000 && s3.ccMe === true, JSON.stringify({ q: s3.quoteId, cc: s3.ccMe }));
  await t.page.click('#qfce-dialog .qfce-close');
  check('the log marks it sent', (await t.page.$eval('button.log-email-btn[onclick="emailQuoteFromLog(5000)"]', (b) => b.innerText + '|' + b.title))
    .startsWith('✓ Sent|Emailed to ap@acme.example'));
  check('the copy setting is remembered', (await t.page.evaluate(() => localStorage.getItem('qfc_email_cc'))) === '1');

  console.log('\n=== Pro Plus: emailing from the quote log ===');
  await t.page.click('button.log-email-btn[onclick="emailQuoteFromLog(201)"]');
  await t.page.waitForSelector('#qfce-dialog:not([hidden])');
  check('a quote with no customer: the address is left to fill in', (await t.page.inputValue('#qfce-dialog input[name=to]')) === ''
    && (await t.page.inputValue('#qfce-dialog input[name=subject]')) === 'Rate quote: Lancaster, PA to New York, NY'
    && (await t.page.inputValue('#qfce-dialog textarea[name=message]')).startsWith('Hi,'));
  await t.page.fill('#qfce-dialog input[name=to]', 'dispatch@shipper.example');
  await send(t);
  const s4 = t.db.sends[3].body;
  check('sent with the logged quote’s details and id', s4.quoteId === 201 && s4.summary.rate === '$1,850' && s4.summary.pickup === 'Nov 20, 2026'
    && s4.summary.origin === 'Lancaster, PA' && pdfInfo(s4.pdf).pages === 1, JSON.stringify(s4.summary));
  await t.page.click('#qfce-dialog .qfce-close');
  check('and the log marks it sent', (await text(t.page, 'button.log-email-btn[onclick="emailQuoteFromLog(201)"]')) === '✓ Sent');
  await t.page.$eval('.log-wrap', (el) => el.scrollIntoView({ block: 'center' }));
  await (await t.page.$('.log-wrap')).screenshot({ path: path.join(SHOTS, 'quote-log.png') });
  await t.page.$eval('#btn-email-quote', (el) => el.scrollIntoView({ block: 'center' }));
  await (await t.page.$('.result-card')).screenshot({ path: path.join(SHOTS, 'quote-card.png') });
  await t.page.click('button.log-email-btn[onclick="emailQuoteFromLog(203)"]');
  await t.page.fill('#qfce-dialog input[name=to]', 'dispatch@shipper.example');
  await send(t);
  const long = pdfInfo(t.db.sends[4].body.pdf);
  check('a long quote (long notes) runs onto more pages', long.pages >= 2 && long.pages <= 4, JSON.stringify(long));
  check('PDFs from the log show dates the way the calculator does', await t.page.evaluate(() => /Fri, Nov 20/.test(generateQuotePDFFromLog(201, { returnDoc: true }).html)));
  fs.writeFileSync(path.join(SHOTS, 'long.pdf'), Buffer.from(t.db.sends[4].body.pdf, 'base64'));
  await t.page.click('#qfce-dialog .qfce-close');
  check('no page errors', t.errors.length === 0, t.errors.join(' | '));
  await t.context.close();

  // Emails already sent show in the log after a reload
  t = await setup(browser, base, { account: ACCT(), emails: [{ quote_id: 202, to_email: 'ap@acme.example', created_at: '2026-11-10T15:00:00Z' }] });
  await openCalculator(t, base, 3);
  await t.page.waitForFunction(() => document.querySelector('button.log-email-btn[onclick="emailQuoteFromLog(202)"]')?.classList.contains('sent'));
  check('quotes emailed before show as sent, with who and when', (await t.page.$eval('button.log-email-btn[onclick="emailQuoteFromLog(202)"]', (b) => b.innerText + '|' + b.title))
    === '✓ Sent|Emailed to ap@acme.example on Nov 10. Click to send it again.');
  check('others don’t', (await text(t.page, 'button.log-email-btn[onclick="emailQuoteFromLog(201)"]')) === '✉ Email');

  // Errors from the server are shown as they come
  await t.page.click('button.log-email-btn[onclick="emailQuoteFromLog(202)"]');
  await t.page.waitForSelector('#qfce-dialog:not([hidden])');
  check('the customer’s email fills in from the logged quote', (await t.page.inputValue('#qfce-dialog input[name=to]')) === 'ap@acme.example');
  t.db.replies.push({ status: 429, body: { error: 'limit', limit: 100, message: 'You’ve emailed 100 quotes in the last 24 hours, the most Pro Plus allows. Try again later. Pro Max sends up to 300 a day.' } });
  await send(t);
  check('the daily limit', (await text(t.page, '#qfce-dialog .qfce-status')).startsWith('You’ve emailed 100 quotes in the last 24 hours'));
  t.db.replies.push({ status: 401, body: { error: 'auth', message: 'Sign in again to send quotes.' } });
  await send(t);
  check('an expired sign-in', (await text(t.page, '#qfce-dialog .qfce-status')) === 'Your sign-in expired. Sign in again, then send.');
  await t.page.keyboard.press('Escape');
  check('Escape closes the window', !(await visible(t.page, '#qfce-dialog')));
  check('no page errors', t.errors.length === 0, t.errors.join(' | '));
  await t.context.close();

  console.log('\n=== Classic PDFs and white-label ===');
  t = await setup(browser, base, { account: ACCT({ pdf_style: 'classic' }), profile: { pdfStyle: 'classic' } });
  await openCalculator(t, base, 3);
  await t.page.click('#btn-email-quote');
  await t.page.waitForSelector('#qfce-dialog:not([hidden])');
  await t.page.fill('#qfce-dialog input[name=to]', 'ap@acme.example');
  await send(t);
  const c1 = t.db.sends[0].body;
  check('it really is the Classic design', await t.page.evaluate(() => /Rate Confirmation/.test(generateQuotePDF({ returnDoc: true }).html)));
  check('Classic quotes email too, on one page, with their number', pdfInfo(c1.pdf).pages === 1 && /^KPL-\d{8}-2041$/.test(c1.summary.quoteNumber) && /\d{4}, \d{1,2}:\d{2}\s?[AP]M/.test(c1.validLabel), JSON.stringify(pdfInfo(c1.pdf)));
  fs.writeFileSync(path.join(SHOTS, 'classic.pdf'), Buffer.from(c1.pdf, 'base64'));
  await t.page.click('#qfce-dialog .qfce-close');
  await t.page.click('button.log-email-btn[onclick="emailQuoteFromLog(202)"]');
  await t.page.fill('#qfce-dialog input[name=to]', 'ap@acme.example');
  await send(t);
  check('and from the log', pdfInfo(t.db.sends[1].body.pdf).pages === 1 && t.db.sends[1].body.quoteId === 202);
  check('no page errors', t.errors.length === 0, t.errors.join(' | '));
  await t.context.close();

  t = await setup(browser, base, { account: ACCT({ plan: 'max', pdf_white_label: true, pdf_valid_hours: 72 }), profile: { plan: 'max', pdfWhiteLabel: true, pdfValidHours: 72 } });
  await openCalculator(t, base, 3);
  await t.page.click('#btn-email-quote');
  await t.page.waitForSelector('#qfce-dialog:not([hidden])');
  check('white-label (Pro Max): sends as just the company', (await text(t.page, '#qfce-dialog .qfce-help')).startsWith('Sends as Keystone Produce Logistics from'));
  check('Pro Max’s own validity, and where to change it', /Good for 72 hours/.test(await text(t.page, '#qfce-dialog .qfce-valid')) && (await text(t.page, '#qfce-dialog .qfce-valid')).includes('Profile → PDF quotes'));
  await t.page.fill('#qfce-dialog input[name=to]', 'ap@acme.example');
  await send(t);
  const m1 = t.db.sends[0].body;
  check('valid for 72 hours', new Date(m1.validUntil) - Date.now() > 71 * 3600000);
  fs.writeFileSync(path.join(SHOTS, 'modern.pdf'), Buffer.from(m1.pdf, 'base64'));
  check('no page errors', t.errors.length === 0, t.errors.join(' | '));
  await t.context.close();

  console.log('\n=== A saved quote keeps the extra transit-day charge (what the log emails) ===');
  t = await setup(browser, base, { account: ACCT() });
  await openCalculator(t, base, 3);
  const totals = await t.page.evaluate(async () => {
    document.getElementById('pickup').value = '2026-11-16';
    document.getElementById('delivery').value = '2026-11-20';   // 4 days for a 1-day run: 3 extra
    document.getElementById('extra-day-rate').value = 200;
    calc();
    const before = Math.round(lastFtlQuote.quote);
    addTransitCharge();
    const shown = Math.round(lastFtlQuote.quote);
    await saveQuote();
    return { before, shown, extra: transitChargeAmount, saved: quoteLog[0].quote };
  });
  check('the logged total matches the calculator\u2019s, extra days included', totals.extra === 600 && totals.shown > totals.before && totals.saved === totals.shown, JSON.stringify(totals));
  check('no page errors', t.errors.length === 0, t.errors.join(' | '));
  await t.context.close();

  console.log('\n=== Pro and signed out ===');
  t = await setup(browser, base, { account: ACCT({ plan: 'pro' }) });
  await openCalculator(t, base, 3, { customers: 0 });
  check('Pro: the button shows it’s a Pro Plus feature', await t.page.isEnabled('#btn-email-quote') && await visible(t.page, '#email-plus-tag'));
  await t.page.click('#btn-email-quote');
  check('and offers the upgrade instead of the window', (await t.page.$eval('#upg-modal-overlay', (e) => e.style.display)) === 'flex'
    && (await text(t.page, '#upg-modal-desc')).startsWith('Emailing quotes comes with Pro Plus') && !(await visible(t.page, '#qfce-dialog')));
  check('the log’s Email buttons are locked', (await text(t.page, 'button.log-email-btn[onclick="emailQuoteFromLog(201)"]')) === '🔒 Email');
  check('nothing was sent', t.db.sends.length === 0);
  check('no page errors', t.errors.length === 0, t.errors.join(' | '));
  await t.context.close();

  // The tightest fit: a phone, with the PLUS tag on the Email button
  t = await setup(browser, base, { account: ACCT({ plan: 'pro' }), phone: true });
  await openCalculator(t, base, 3, { customers: 0 });
  const fit = await t.page.$$eval('#btn-download-quote, #btn-email-quote', (bs) => bs.map((b) => ({ w: b.clientWidth, need: b.scrollWidth, top: Math.round(b.getBoundingClientRect().top) })));
  check('on a phone, both buttons fit side by side, text and tag included', fit.length === 2 && fit.every((b) => b.need <= b.w + 1) && fit[0].top === fit[1].top, JSON.stringify(fit));
  await t.page.$eval('#btn-email-quote', (el) => el.scrollIntoView({ block: 'center' }));
  await t.page.screenshot({ path: path.join(SHOTS, 'phone-buttons.png') });
  await t.context.close();

  t = await setup(browser, base, { account: null, signedIn: false, quotes: [] });
  await t.page.goto(base + '/index.html');
  await t.page.waitForFunction(() => window.QFCEmailQuote && typeof regionalRates !== 'undefined' && regionalRates !== null);
  check('signed out: the Email button is off, like Download', !(await t.page.isEnabled('#btn-email-quote')) && !(await t.page.isEnabled('#btn-download-quote')));
  check('no page errors', t.errors.length === 0, t.errors.join(' | '));
  await t.context.close();

  await browser.close();
  server.close();
  console.log(failures ? `\n${failures} EMAIL UI CHECK(S) FAILED` : `\nALL EMAIL UI CHECKS PASSED (screenshots in ${SHOTS})`);
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
