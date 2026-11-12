// tests/customers_test.js — the customer list (Pro Plus and up, and comp
// accounts): picking saved customers on the calculator, multi-stop and bulk
// pages, "Prepared for" on Modern and Classic PDFs, the add/edit window, the
// Customers page, and what Pro accounts see, in a real browser (needs
// Playwright with Chromium). Supabase is replaced by a small in-memory
// database that follows the real rules (customers_enforce_plan,
// quote_log_enforce_plan). Run from the repository root:
//   node tests/customers_test.js [folder for screenshots]
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { chromium } = require('playwright');
const ROOT = path.resolve(__dirname, '..');
const SHOTS = process.argv[2] || fs.mkdtempSync(path.join(os.tmpdir(), 'qfc-customers-'));
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
  miles: 166, trailer: 'van', weight: '40000', pickup_date: null, delivery_date: null,
  commodity: 'Standard', commodity_key: 'standard', margin: '15%', base_rpm: '2.40', quote: 1850, rpm: '11.14',
  notes: '', created_at: new Date(Date.now() - daysAgo * DAY).toISOString(), tracked: true,
  customer: null, customer_id: null, outcome: 'open', outcome_at: null, final_rate: null, lost_reason: null,
}, o);

const SEED_CUSTOMERS = [
  CUSTOMER(1, 'Acme Foods', { contact_name: 'Jo Smith', email: 'ap@acme.example', phone: '(717) 555-0100',
    address: '123 Main St\nLancaster, PA 17601', default_margin: 18, notes: 'Pays net 30' }),
  CUSTOMER(2, 'Keystone Produce', { email: 'loads@keystone.example' }),
  CUSTOMER(3, 'Sunrise Farms'),
];
const SEED_QUOTES = [
  QUOTE(201, 1, { notes: 'q201' }),
  QUOTE(202, 2, { customer: 'Acme Foods', customer_id: 1, outcome: 'won' }),
  QUOTE(203, 3, { customer: 'Acme Foods', customer_id: 1, outcome: 'won' }),
  QUOTE(204, 4, { customer: 'Acme Foods', customer_id: 1, outcome: 'lost', lost_reason: 'price' }),
  QUOTE(205, 5, { customer: 'keystone produce', outcome: 'won' }),
  QUOTE(206, 6, { customer: 'Keystone Produce' }),
  QUOTE(207, 7, { customer: 'Lone Star Grocers' }),
  QUOTE(208, 8, { customer: 'lone star grocers', outcome: 'lost' }),
  QUOTE(209, 9, { customer: 'Valley Fresh' }),
];

const LIST_TIERS = ['plus', 'max', 'api', 'comp'];
const QUOTE_CAP = { pro: 100, plus: 1000, max: 5000, api: 5000, comp: 5000, none: 0 };
function tierOf(a) {
  if (!a || a.is_active !== true) return 'none';
  if (!a.stripe_subscription_id) return 'comp';
  return a.plan || 'pro';
}

async function setup(browser, base, { account, customers = [], quotes = [], signedIn = true, profile = {}, phone = false }) {
  const context = await browser.newContext(phone
    ? { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true }
    : { viewport: { width: 1280, height: 900 }, deviceScaleFactor: 2 });
  const db = { account, customers: customers.map((c) => ({ ...c })), quotes: quotes.map((q) => ({ ...q })),
    nextCustomer: 100, nextQuote: 5000, custPosts: [], custPatches: [], custDeletes: [], quotePosts: [], quotePatches: [] };
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
    const idParam = () => Number((u.searchParams.get('id') || '').replace('eq.', ''));
    const tier = tierOf(db.account);
    if (url.includes('/rest/v1/customers')) {
      const lower = (s) => String(s || '').trim().replace(/\s+/g, ' ').toLowerCase();
      if (method === 'GET') {
        const sorted = db.customers.slice().sort((a, b) => a.name.localeCompare(b.name));
        const offset = Number(u.searchParams.get('offset') || 0), limit = Number(u.searchParams.get('limit') || 1000);
        return json(sorted.slice(offset, offset + limit));
      }
      if (method === 'DELETE') {
        const id = idParam();
        db.custDeletes.push(id);
        db.customers = db.customers.filter((c) => c.id !== id);
        db.quotes.forEach((q) => { if (q.customer_id === id) q.customer_id = null; });
        return route.fulfill({ status: 204, body: '' });
      }
      const body = JSON.parse(req.postData());
      if (!LIST_TIERS.includes(tier)) return json({ code: '42501', message: 'The customer list comes with Pro Plus and up' }, 403);
      const name = String(body.name || '').trim().replace(/\s+/g, ' ');
      if (method === 'POST') {
        db.custPosts.push(body);
        if (db.customers.some((c) => lower(c.name) === lower(name))) return json({ code: '23505', message: 'duplicate key' }, 409);
        if (db.customers.length >= (tier === 'plus' ? 1000 : 5000)) return json({ code: '54000', message: 'Customer limit reached' }, 400);
        const row = CUSTOMER(db.nextCustomer++, name, { ...body, name, created_at: new Date().toISOString(), updated_at: new Date().toISOString() });
        db.customers.push(row);
        return json([row], 201);
      }
      if (method === 'PATCH') {
        const id = idParam();
        db.custPatches.push({ id, body });
        const row = db.customers.find((c) => c.id === id);
        if (!row) return json([]);
        if (db.customers.some((c) => c.id !== id && lower(c.name) === lower(name))) return json({ code: '23505', message: 'duplicate key' }, 409);
        const renamed = row.name !== name;
        Object.assign(row, body, { name, updated_at: new Date().toISOString() });
        if (renamed) db.quotes.forEach((q) => { if (q.customer_id === id) q.customer = name; });
        return json([row]);
      }
    }
    if (url.includes('/rest/v1/quote_log')) {
      if (method === 'GET') {
        const sorted = db.quotes.slice().sort((a, b) => b.created_at.localeCompare(a.created_at) || b.id - a.id);
        const offset = Number(u.searchParams.get('offset') || 0), limit = Number(u.searchParams.get('limit') || 1000);
        return json(sorted.slice(offset, offset + limit));
      }
      if (method === 'POST') {
        const body = JSON.parse(req.postData());
        db.quotePosts.push(body);
        if (db.quotes.length >= QUOTE_CAP[tier]) return json({ code: '54000', message: 'Saved quote limit reached' }, 400);
        if (body.customer_id && !db.customers.some((c) => c.id === body.customer_id)) return json({ code: '23503', message: 'Unknown customer' }, 409);
        const row = QUOTE(db.nextQuote++, 0, body);
        db.quotes.push(row);
        return json([row], 201);
      }
      if (method === 'PATCH') {
        const id = idParam();
        const body = JSON.parse(req.postData());
        db.quotePatches.push({ id, body });
        const row = db.quotes.find((q) => q.id === id);
        if (!row) return json([]);
        if (body.customer_id && !db.customers.some((c) => c.id === body.customer_id)) return json({ code: '23503', message: 'Unknown customer' }, 409);
        Object.assign(row, body);
        return json([row]);
      }
      if (method === 'DELETE') return route.fulfill({ status: 204, body: '' });
    }
    if (url.includes('/rest/v1/pro_users')) {
      if (method === 'PATCH') return route.fulfill({ status: 204, body: '' });
      return json(db.account ? [db.account] : []);
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
const popItems = (pg) => pg.$$eval('.qfcc-pop:not([hidden]) .qfcc-item', (els) => els.map((e) => e.innerText.replace(/\s+/g, ' ').trim()));
const shown = (pg, sel) => pg.$eval(sel, (e) => e.innerText).then(flat).catch(() => '');

async function openCalculator(t, base, quoteCount, customerCount) {
  await t.page.goto(base + '/index.html');
  await t.page.waitForFunction(([q, c]) => typeof quoteLog !== 'undefined' && quoteLog.length === q
    && typeof regionalRates !== 'undefined' && regionalRates !== null && window.QFCQuotePDF && window.QFCCustomers
    && QFCCustomers.all().length === c, [quoteCount, customerCount]);
  await t.page.evaluate(() => {
    const set = (id, v) => { document.getElementById(id).value = v; };
    set('origin', 'Harrisburg, PA'); set('dest', 'Boston, MA'); set('miles', 384); set('weight', 38000);
    set('trailer', 'van'); set('commodity', 'standard'); set('margin', 15);
    applyRegionalRates(); calc();
  });
}
async function newTab(t, fn) {
  const [tab] = await Promise.all([t.context.waitForEvent('page'), t.page.evaluate(fn)]);
  await tab.waitForLoadState('load');
  await tab.waitForTimeout(300);
  return tab;
}

(async () => {
  const server = await serve();
  const base = `http://127.0.0.1:${server.address().port}`;
  const browser = await chromium.launch();

  // ── Pro Plus on the calculator ──────────────────────────────────────────
  console.log('\n=== Pro Plus: picking a saved customer ===');
  let t = await setup(browser, base, { account: ACCT(), customers: SEED_CUSTOMERS, quotes: SEED_QUOTES });
  await openCalculator(t, base, 9, 3);
  check('the Customers button has no PLUS tag for Pro Plus', !(await t.page.isVisible('#customers-plus-tag')));
  await t.page.click('#quote-customer');
  await t.page.keyboard.type('acm');
  await t.page.waitForSelector('.qfcc-pop:not([hidden]) .qfcc-item');
  let items = await popItems(t.page);
  check('typing offers the saved customer with its contact, and saving a new one', items.length === 2
    && items[0] === 'Acme Foods Attn: Jo Smith · ap@acme.example · (717) 555-0100' && items[1] === '+ Save “acm” as a new customer', JSON.stringify(items));
  await t.page.locator('.qfcc-pop:not([hidden]) .qfcc-item').first().click();
  check('picked: the box names the customer and links it', (await t.page.inputValue('#quote-customer')) === 'Acme Foods'
    && (await t.page.getAttribute('#quote-customer', 'data-customer-id')) === '1');
  check('its details show under the box, with Edit', await shown(t.page, '#quote-customer-details') === 'Attn: Jo Smith · ap@acme.example · (717) 555-0100 · Edit');
  check("the customer's default margin is applied", (await t.page.inputValue('#margin')) === '18');
  await t.page.locator('#customer-field').screenshot({ path: path.join(SHOTS, 'customer_field.png') });

  await t.page.evaluate(() => saveQuote());
  await t.page.waitForFunction(() => quoteLog[0] && !quoteLog[0].pending);
  let post = t.db.quotePosts.at(-1);
  check('saving the quote links it to the customer', post.customer === 'Acme Foods' && post.customer_id === 1, JSON.stringify(post));

  let tab = await newTab(t, () => generateQuotePDF());
  let pf = await shown(tab, '.prepared');
  check('Modern PDF: "Prepared for" with name, contact, email, phone and address',
    pf === 'PREPARED FOR Acme Foods Attn: Jo Smith · ap@acme.example · (717) 555-0100 123 Main St, Lancaster, PA 17601', pf);
  check('it sits between the letterhead and the lane', await tab.evaluate(() => {
    const p = document.querySelector('.prepared'), r = document.querySelector('.rule'), l = document.querySelector('.lane');
    return !!(r.compareDocumentPosition(p) & Node.DOCUMENT_POSITION_FOLLOWING) && !!(p.compareDocumentPosition(l) & Node.DOCUMENT_POSITION_FOLLOWING);
  }));
  await tab.screenshot({ path: path.join(SHOTS, 'customer_modern_pdf.png'), clip: { x: 0, y: 0, width: 1280, height: 520 } });
  await tab.emulateMedia({ media: 'print' });
  await tab.pdf({ path: path.join(SHOTS, 'customer_modern.pdf'), format: 'Letter', printBackground: true });
  const pages = (fs.readFileSync(path.join(SHOTS, 'customer_modern.pdf')).toString('latin1').match(/\/Type\s*\/Page[^s]/g) || []).length;
  check('still prints on one Letter page', pages === 1, pages + ' pages');
  await tab.close();

  tab = await newTab(t, () => generateQuotePDFFromLog(quoteLog[0].id));
  check('quote log PDF: the saved quote prints its customer too', (await shown(tab, '.prepared')).startsWith('PREPARED FOR Acme Foods Attn: Jo Smith'));
  await tab.close();
  await t.page.evaluate(() => {
    const p = JSON.parse(localStorage.getItem('qfc_pro_profile'));
    p.pdfStyle = 'classic';
    localStorage.setItem('qfc_pro_profile', JSON.stringify(p));
  });
  tab = await newTab(t, () => generateQuotePDF());
  let body = await shown(tab, 'body');
  check('Classic PDF: "Prepared For" block with the details', body.includes('Rate Confirmation') && body.includes('PREPARED FOR Acme Foods Attn: Jo Smith · ap@acme.example · (717) 555-0100 123 Main St, Lancaster, PA 17601'));
  await tab.close();
  tab = await newTab(t, () => generateQuotePDFFromLog(quoteLog[0].id));
  check('Classic quote log PDF too', (await shown(tab, 'body')).includes('PREPARED FOR Acme Foods'));
  await tab.close();
  await t.page.evaluate(() => {
    const p = JSON.parse(localStorage.getItem('qfc_pro_profile'));
    delete p.pdfStyle;
    localStorage.setItem('qfc_pro_profile', JSON.stringify(p));
  });

  console.log('\n=== Adding, editing and deleting customers ===');
  await t.page.fill('#quote-customer', '');
  await t.page.click('#quote-customer');
  await t.page.keyboard.type('Blue  Ridge Farms');
  check('a new name: the box unlinks and offers to save it', (await t.page.getAttribute('#quote-customer', 'data-customer-id')) === null
    && await shown(t.page, '#quote-customer-details') === '+ Save “Blue Ridge Farms” as a customer');
  check('the suggestions offer to save it too', (await popItems(t.page)).join('|') === '+ Save “Blue Ridge Farms” as a new customer');
  await t.page.keyboard.press('Escape');
  check('Escape closes the suggestions', (await popItems(t.page)).length === 0);
  await t.page.click('#quote-customer-details button');
  check('the add window opens with the name filled in', await t.page.isVisible('#qfcc-editor')
    && (await t.page.inputValue('#qfcc-editor input[name=name]')) === 'Blue Ridge Farms'
    && flat(await t.page.textContent('#qfcc-editor .qfcc-title')) === 'New customer' && !(await t.page.isVisible('#qfcc-editor .qfcc-del')));
  await t.page.fill('#qfcc-editor input[name=contactName]', 'Pat Lee');
  await t.page.fill('#qfcc-editor input[name=email]', 'pat-at-blueridge');
  await t.page.click('#qfcc-editor .qfcc-save');
  check('a bad email is caught before saving', flat(await t.page.textContent('#qfcc-editor .qfcc-status')) === 'Check the email address.' && t.db.custPosts.length === 0);
  await t.page.fill('#qfcc-editor input[name=email]', 'pat@blueridge.example');
  await t.page.fill('#qfcc-editor input[name=defaultMargin]', '250');
  await t.page.click('#qfcc-editor .qfcc-save');
  check('and a margin over 200%', flat(await t.page.textContent('#qfcc-editor .qfcc-status')).startsWith('Margin must be between') && t.db.custPosts.length === 0);
  await t.page.fill('#qfcc-editor input[name=defaultMargin]', '');
  await t.page.fill('#qfcc-editor textarea[name=address]', '9 Orchard Rd\nChambersburg, PA');
  await t.page.locator('#qfcc-editor .qfcc-modal').screenshot({ path: path.join(SHOTS, 'customer_editor.png') });
  await t.page.click('#qfcc-editor .qfcc-save');
  await t.page.waitForFunction(() => document.getElementById('qfcc-editor').hidden);
  post = t.db.custPosts.at(-1);
  check('saved with tidy fields; empty ones sent as nothing', JSON.stringify(post) === JSON.stringify({ name: 'Blue Ridge Farms', contact_name: 'Pat Lee',
    email: 'pat@blueridge.example', phone: null, address: '9 Orchard Rd\nChambersburg, PA', notes: null, default_margin: null }), JSON.stringify(post));
  check('the box now names and links the new customer', (await t.page.inputValue('#quote-customer')) === 'Blue Ridge Farms'
    && (await t.page.getAttribute('#quote-customer', 'data-customer-id')) === '100'
    && await shown(t.page, '#quote-customer-details') === 'Attn: Pat Lee · pat@blueridge.example · Edit');

  await t.page.click('#quote-customer-details button');
  check('Edit opens the saved customer', flat(await t.page.textContent('#qfcc-editor .qfcc-title')) === 'Edit customer'
    && (await t.page.inputValue('#qfcc-editor input[name=contactName]')) === 'Pat Lee' && await t.page.isVisible('#qfcc-editor .qfcc-del'));
  await t.page.fill('#qfcc-editor input[name=name]', 'ACME foods');
  await t.page.click('#qfcc-editor .qfcc-save');
  check('another customer\'s name (any case) is refused before saving', flat(await t.page.textContent('#qfcc-editor .qfcc-status')) === 'You already have a customer named Acme Foods.'
    && t.db.custPatches.length === 0);
  await t.page.fill('#qfcc-editor input[name=name]', 'Blue Ridge Farms');
  await t.page.fill('#qfcc-editor input[name=phone]', '(717) 555-0199');
  await t.page.click('#qfcc-editor .qfcc-save');
  await t.page.waitForFunction(() => document.getElementById('qfcc-editor').hidden);
  check('edits save to the customer', t.db.custPatches.at(-1).id === 100 && t.db.custPatches.at(-1).body.phone === '(717) 555-0199'
    && (await shown(t.page, '#quote-customer-details')).includes('(717) 555-0199'));

  await t.page.click('#quote-customer-details button');
  await t.page.click('#qfcc-editor .qfcc-del');
  await t.page.waitForFunction(() => document.getElementById('qfcc-editor').hidden);
  check('Delete (after confirming) removes it; the box keeps the name, unlinked', t.db.custDeletes.at(-1) === 100
    && (await t.page.inputValue('#quote-customer')) === 'Blue Ridge Farms' && (await t.page.getAttribute('#quote-customer', 'data-customer-id')) === null
    && (await shown(t.page, '#quote-customer-details')).startsWith('+ Save'));

  await t.page.fill('#quote-customer', '');
  await t.page.click('#quote-customer');
  await t.page.keyboard.type('s');
  await t.page.waitForSelector('.qfcc-pop:not([hidden]) .qfcc-item');
  await t.page.keyboard.press('ArrowDown');
  await t.page.keyboard.press('Enter');
  check('keyboard: arrow down and Enter pick', (await t.page.inputValue('#quote-customer')) === 'Sunrise Farms'
    && (await t.page.getAttribute('#quote-customer', 'data-customer-id')) === '3');
  check('a customer without a default margin leaves the margin alone', (await t.page.inputValue('#margin')) === '18');

  console.log('\n=== The Result window picks customers too ===');
  await t.page.locator('#log-body tr:has(button[onclick="openNotesModal(201)"]) .wl-pill').click();
  await t.page.click('#wl-customer');
  await t.page.keyboard.type('Keyst');
  await t.page.waitForSelector('.qfcc-pop:not([hidden]) .qfcc-item');
  await t.page.locator('.qfcc-pop:not([hidden]) .qfcc-item').first().click();
  await t.page.click('#wl-modal-overlay .wl-seg [data-outcome="won"]');
  await t.page.click('#wl-modal-save');
  await t.page.waitForFunction(() => document.getElementById('wl-modal-overlay').style.display === 'none');
  const qp = t.db.quotePatches.at(-1);
  check('the result saves the customer and its link', qp.id === 201 && qp.body.customer === 'Keystone Produce' && qp.body.customer_id === 2, JSON.stringify(qp));
  check('no page errors', t.errors.length === 0, t.errors.join(' | '));
  await Promise.all([t.page.waitForURL('**/customers.html'), t.page.click('#customers-btn')]);
  check('the Customers button opens the Customers page', t.page.url().endsWith('/customers.html'));
  await t.context.close();

  // ── Pro: just the name ──────────────────────────────────────────────────
  console.log('\n=== Pro: the name prints, no saved list ===');
  t = await setup(browser, base, { account: ACCT({ plan: 'pro' }), customers: SEED_CUSTOMERS, quotes: SEED_QUOTES.slice(0, 3) });
  await openCalculator(t, base, 3, 0);
  await t.page.click('#quote-customer');
  await t.page.keyboard.type('Acme Foods');
  await t.page.waitForTimeout(300);
  check('no suggestions and no details line', (await popItems(t.page)).length === 0 && !(await t.page.isVisible('#quote-customer-details')));
  tab = await newTab(t, () => generateQuotePDF());
  pf = await shown(tab, '.prepared');
  check('the PDF shows the typed name only', pf === 'PREPARED FOR Acme Foods', pf);
  await tab.close();
  await t.page.evaluate(() => saveQuote());
  await t.page.waitForFunction(() => quoteLog[0] && !quoteLog[0].pending);
  check('the saved quote keeps the name, unlinked', t.db.quotePosts.at(-1).customer === 'Acme Foods' && t.db.quotePosts.at(-1).customer_id === null);
  check('the Customers button carries a PLUS tag', await t.page.isVisible('#customers-plus-tag'));
  await t.page.click('#customers-btn');
  check('and opens the upgrade window on Pro Plus', await t.page.isVisible('#upg-modal-overlay')
    && (await t.page.textContent('#upg-modal-desc')).includes('customer list comes with Pro Plus') && await t.page.isChecked('#upg-option-plus input'));
  check('no page errors', t.errors.length === 0, t.errors.join(' | '));
  await t.context.close();

  console.log("\n=== The database's rules win ===");
  t = await setup(browser, base, { account: ACCT(), customers: SEED_CUSTOMERS, quotes: [] });
  await openCalculator(t, base, 0, 3);
  t.db.account.plan = 'pro';   // plan changed elsewhere; this page still thinks Pro Plus
  await t.page.click('#quote-customer');
  await t.page.keyboard.type('Harbor Freight Co');
  await t.page.locator('.qfcc-pop:not([hidden]) .qfcc-create').click();
  await t.page.click('#qfcc-editor .qfcc-save');
  await t.page.waitForFunction(() => document.querySelector('#qfcc-editor .qfcc-status').textContent !== '');
  check('a save the database refuses says why and stays open', flat(await t.page.textContent('#qfcc-editor .qfcc-status')) === 'The customer list comes with Pro Plus and up.'
    && await t.page.isVisible('#qfcc-editor'));
  await t.context.close();

  // ── Multi-stop and bulk ─────────────────────────────────────────────────
  console.log('\n=== Multi-stop and bulk ===');
  t = await setup(browser, base, { account: ACCT(), customers: SEED_CUSTOMERS });
  await t.page.goto(base + '/multistop.html');
  await t.page.waitForFunction(() => typeof calcTotal === 'function' && window.QFCQuotePDF && window.QFCCustomers && QFCCustomers.all().length === 3);
  await t.page.evaluate(() => {
    stops = [
      { id: 1, type: 'pickup', location: 'Hastings, FL', miles: 0, weight: '20000', date: '2026-11-16' },
      { id: 2, type: 'pickup', location: 'Palatka, FL', miles: 0, weight: '18000', date: '2026-11-16' },
      { id: 3, type: 'delivery', location: 'Lancaster, PA', miles: 0, weight: '', date: '2026-11-18' },
      { id: 4, type: 'delivery', location: 'Allentown, PA', miles: 0, weight: '', date: '2026-11-18' },
    ];
    stopIdCounter = 4;
    legMiles = { 1: 25, 2: 1010, 3: 80 };
    calcTotal();
  });
  await t.page.click('#ms-customer');
  await t.page.keyboard.type('acme');
  await t.page.waitForSelector('.qfcc-pop:not([hidden]) .qfcc-item');
  await t.page.locator('.qfcc-pop:not([hidden]) .qfcc-item').first().click();
  check('multi-stop: pick a customer, its margin applies', (await t.page.inputValue('#ms-customer')) === 'Acme Foods' && (await t.page.inputValue('#ms-margin')) === '18');
  tab = await newTab(t, () => generateMultiStopPDF());
  pf = await shown(tab, '.prepared');
  check('multi-stop Modern PDF: "Prepared for" with details', pf.startsWith('PREPARED FOR Acme Foods Attn: Jo Smith'), pf);
  await tab.emulateMedia({ media: 'print' });
  await tab.pdf({ path: path.join(SHOTS, 'customer_multistop.pdf'), format: 'Letter', printBackground: true });
  const msPages = (fs.readFileSync(path.join(SHOTS, 'customer_multistop.pdf')).toString('latin1').match(/\/Type\s*\/Page[^s]/g) || []).length;
  check('a 4-stop quote with a customer still prints on one page', msPages === 1, msPages + ' pages');
  await tab.close();
  await t.page.evaluate(() => {
    const p = JSON.parse(localStorage.getItem('qfc_pro_profile'));
    p.pdfStyle = 'classic';
    localStorage.setItem('qfc_pro_profile', JSON.stringify(p));
  });
  tab = await newTab(t, () => generateMultiStopPDF());
  check('multi-stop Classic PDF: "Prepared For"', (await shown(tab, 'body')).includes('PREPARED FOR Acme Foods Attn: Jo Smith'));
  await tab.close();
  check('no page errors', t.errors.length === 0, t.errors.join(' | '));

  await t.page.goto(base + '/bulk.html');
  await t.page.waitForFunction(() => typeof generateBulkPDF === 'function' && window.QFCQuotePDF && window.QFCCustomers && QFCCustomers.all().length === 3);
  await t.page.evaluate(() => {
    const set = (id, v) => { document.getElementById(id).value = v; };
    set('origin', 'Presque Isle, ME'); set('dest', 'Hanover, PA'); set('loaded-miles', 712); set('deadhead-miles', 40);
    set('cwt', 450); set('target-rpm', 2.5); set('offered-rate', 4.35);
    calc();
  });
  await t.page.click('#bulk-customer');
  await t.page.keyboard.type('keys');
  await t.page.waitForSelector('.qfcc-pop:not([hidden]) .qfcc-item');
  await t.page.locator('.qfcc-pop:not([hidden]) .qfcc-item').first().click();
  check('bulk: pick a customer, its details show', await shown(t.page, '#bulk-customer-details') === 'loads@keystone.example · Edit');
  tab = await newTab(t, () => generateBulkPDF());
  check('bulk Classic PDF: "Prepared For"', (await shown(tab, 'body')).includes('PREPARED FOR Keystone Produce loads@keystone.example'));
  await tab.close();
  await t.page.evaluate(() => {
    const p = JSON.parse(localStorage.getItem('qfc_pro_profile'));
    delete p.pdfStyle;
    localStorage.setItem('qfc_pro_profile', JSON.stringify(p));
  });
  tab = await newTab(t, () => generateBulkPDF());
  check('bulk Modern PDF: "Prepared for"', await shown(tab, '.prepared') === 'PREPARED FOR Keystone Produce loads@keystone.example');
  await tab.close();
  check('no page errors', t.errors.length === 0, t.errors.join(' | '));
  await t.context.close();

  // ── The Customers page ──────────────────────────────────────────────────
  console.log('\n=== Customers page ===');
  t = await setup(browser, base, { account: ACCT(), customers: SEED_CUSTOMERS, quotes: SEED_QUOTES });
  await t.page.goto(base + '/customers.html');
  await t.page.waitForFunction(() => document.querySelectorAll('#rows tr').length === 3 && !document.getElementById('import-btn').hidden);
  const rows = () => t.page.$$eval('#rows tr', (trs) => trs.map((tr) => [...tr.cells].slice(0, 8).map((c) => c.innerText.replace(/\s+/g, ' ').trim()).join('|')));
  let r = await rows();
  check('lists customers with their quotes, wins, losses and margin', r[0].startsWith('Acme Foods ap@acme.example · (717) 555-0100|Jo Smith|3|2|1|67%|')
    && r[0].endsWith('|18%') && r[1].startsWith('Keystone Produce loads@keystone.example|—|2|1|0|100%|') && r[2].startsWith('Sunrise Farms|—|0|0|0|—|—'), JSON.stringify(r));
  check('count against the plan limit', flat(await t.page.textContent('#count')) === '3 / 1,000 customers');
  check('names on saved quotes that aren\'t listed can be added', flat(await t.page.textContent('#import-btn')) === 'Add 2 from saved quotes');
  await t.page.screenshot({ path: path.join(SHOTS, 'customers_page.png'), fullPage: true });
  await t.page.click('#import-btn');
  await t.page.waitForFunction(() => document.querySelectorAll('#rows tr').length === 5);
  check('adds each once, as first written', JSON.stringify(t.db.custPosts.map((p) => p.name)) === JSON.stringify(['Lone Star Grocers', 'Valley Fresh'])
    && await t.page.isHidden('#import-btn') && flat(await t.page.textContent('#status')) === 'Added 2 customers.');
  r = await rows();
  check('their numbers come from the saved quotes', r.some((x) => x.startsWith('Lone Star Grocers|—|2|0|1|0%|')), JSON.stringify(r));

  await t.page.fill('#search', 'LONE');
  check('search', (await t.page.$$('#rows tr')).length === 1);
  await t.page.fill('#search', 'zzz');
  check('no matches says so', flat(await t.page.textContent('#empty')) === 'No customers match “zzz”.');
  await t.page.fill('#search', '');

  await t.page.locator('#rows tr', { hasText: 'Acme Foods' }).click();
  check('a row opens it for editing', flat(await t.page.textContent('#qfcc-editor .qfcc-title')) === 'Edit customer'
    && (await t.page.inputValue('#qfcc-editor textarea[name=notes]')) === 'Pays net 30');
  await t.page.fill('#qfcc-editor input[name=name]', 'Acme Foods Inc');
  await t.page.click('#qfcc-editor .qfcc-save');
  await t.page.waitForFunction(() => document.getElementById('qfcc-editor').hidden);
  r = await rows();
  check('renamed in the list, keeping its quotes', r.some((x) => x.startsWith('Acme Foods Inc ap@acme.example') && x.includes('|3|2|1|67%|')), JSON.stringify(r));
  check('and on its saved quotes (database)', t.db.quotes.filter((q) => q.customer_id === 1).every((q) => q.customer === 'Acme Foods Inc'));

  await t.page.click('#add-btn');
  await t.page.fill('#qfcc-editor input[name=name]', 'Zephyr Logistics');
  await t.page.click('#qfcc-editor .qfcc-save');
  await t.page.waitForFunction(() => document.querySelectorAll('#rows tr').length === 6);
  check('+ New customer adds one', flat(await t.page.textContent('#count')) === '6 / 1,000 customers');
  check('no page errors', t.errors.length === 0, t.errors.join(' | '));
  await t.context.close();

  t = await setup(browser, base, { account: ACCT(), customers: SEED_CUSTOMERS, quotes: SEED_QUOTES, phone: true });
  await t.page.goto(base + '/customers.html');
  await t.page.waitForFunction(() => document.querySelectorAll('#rows tr').length === 3);
  const sideways = await t.page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  check('phone: no sideways scrolling, extra columns tucked away', sideways <= 1 && !(await t.page.isVisible('#rows tr:first-child td.hide-sm')), `${sideways}px`);
  await t.page.screenshot({ path: path.join(SHOTS, 'customers_phone.png') });
  await t.context.close();

  t = await setup(browser, base, { account: ACCT({ plan: 'pro' }), customers: SEED_CUSTOMERS });
  await t.page.goto(base + '/customers.html');
  await t.page.waitForSelector('#gate:not([hidden])');
  check('Pro: what the list does, and Change plan', flat(await t.page.textContent('#gate')).startsWith('The customer list comes with Pro Plus')
    && (await t.page.getAttribute('#gate a', 'href')) === '/profile.html#subscription-paid' && await t.page.isHidden('#app'));
  await t.page.locator('#gate').screenshot({ path: path.join(SHOTS, 'customers_gate.png') });
  await t.context.close();

  t = await setup(browser, base, { account: null, signedIn: false });
  await t.page.goto(base + '/customers.html');
  await t.page.waitForSelector('#gate:not([hidden])');
  check('signed out: sign in', flat(await t.page.textContent('#gate')).startsWith('Sign in to see your customers'));
  await t.context.close();

  t = await setup(browser, base, { account: ACCT({ stripe_subscription_id: null, stripe_customer_id: null, plan: 'pro' }), customers: SEED_CUSTOMERS });
  await t.page.goto(base + '/customers.html');
  await t.page.waitForFunction(() => document.querySelectorAll('#rows tr').length === 3);
  check('comp accounts get the list (5,000)', flat(await t.page.textContent('#count')) === '3 / 5,000 customers');
  await t.context.close();

  await browser.close();
  server.close();
  console.log(failures ? `\n${failures} CUSTOMER CHECK(S) FAILED` : `\nALL CUSTOMER CHECKS PASSED (screenshots in ${SHOTS})`);
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
