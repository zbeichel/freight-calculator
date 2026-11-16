// tests/pagebreak_test.js — where printed PDFs break onto new pages, in a real browser (needs
// Playwright with Chromium and poppler's pdftotext): the footer and the signatures never print on a
// page of their own, a heading never ends a page, nothing is lost from long notes, and a bulk quote
// with a customer fits on one page. Supabase and the Netlify functions are fakes. Run from the
// repository root:
//   node tests/pagebreak_test.js [folder for the PDFs]
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { chromium } = require('playwright');
const ROOT = path.resolve(__dirname, '..');
const SHOTS = process.argv[2] || fs.mkdtempSync(path.join(os.tmpdir(), 'qfc-quotebox-'));
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.json': 'application/json', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png' };
let failures = 0;
const check = (label, cond, detail) => { console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}${detail && !cond ? '  — ' + detail : ''}`); if (!cond) failures++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(cond, ms = 6000) { const end = Date.now() + ms; while (Date.now() < end) { if (await cond()) return true; await sleep(50); } return cond(); }

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

const ROW = { id: 'user-1', email: 'sam@example.com', company_name: 'Keystone Produce Logistics', contact_name: 'Sam Rivera', is_active: true, plan: 'plus',
  stripe_customer_id: 'cus_1', stripe_subscription_id: 'sub_1', quote_prefix: 'KPL', quote_counter: 2041 };
const PLACES = {
  'hastings fl': { name: 'Hastings, FL 32145', city: 'Hastings', state: 'FL', zip: '32145', lat: 29.71802479999999, lon: -81.5081338 },
  'lancaster pa': { name: 'Lancaster, PA', city: 'Lancaster', state: 'PA', lat: 40.0403279, lon: -76.30418329999999 },
};
const placeKey = (t) => String(t || '').toLowerCase().replace(/[.,]/g, ' ').replace(/\b\d{5}\b/g, '').replace(/\s+/g, ' ').trim();

async function setup(browser, base, { profile = {}, row = {}, quotes = [], geocodeDown = [], contextOpts = {}, clock = null } = {}) {
  const account = Object.assign({}, ROW, row);
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, ...contextOpts });
  if (clock) await context.clock.setFixedTime(clock);
  const db = { quotes: quotes.slice(), posts: [], deletes: [], routes: [], dialogs: [], nextId: 501 };
  await context.addInitScript((profile) => {
    if (localStorage.getItem('__seeded')) return;
    localStorage.setItem('__seeded', '1');
    localStorage.setItem('sb-xgrmbhmgcsbnazupfybd-auth-token', JSON.stringify({ access_token: 'tok', refresh_token: 'r',
      expires_at: Math.floor(Date.now() / 1000) + 3600, user: { id: 'user-1', email: 'sam@example.com' } }));
    localStorage.setItem('qfc_pro_profile', JSON.stringify(Object.assign({ companyName: 'Keystone Produce Logistics', contactName: 'Sam Rivera',
      quotePrefix: 'KPL', quoteStart: 2041, plan: 'plus' }, profile)));
  }, profile);
  await context.route('**/*', async (route) => {
    const req = route.request();
    const url = req.url();
    const json = (b, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(b) });
    if (url.startsWith('blob:') || (url.startsWith(base) && !url.includes('/.netlify/functions/'))) return route.continue();
    if (url.includes('/.netlify/functions/verify-pro')) return json({ active: true, plan: 'plus', paid: true, unlimitedUntilRenewal: false });
    if (url.includes('/.netlify/functions/geocode')) {
      const a = new URL(url).searchParams.get('address');
      if (geocodeDown.includes(placeKey(a))) return route.abort();
      return json(PLACES[placeKey(a)] || { error: 'No results' });
    }
    if (url.includes('/.netlify/functions/routes')) {
      const b = JSON.parse(req.postData() || '{}');
      if (b.usage) return json({ usage: { used: 1, limit: 250, plan: 'plus' } });
      db.routes.push(b);
      const legs = b.includeLegs ? [{ startLocation: { latLng: { latitude: 29.7, longitude: -81.5 } }, endLocation: { latLng: { latitude: 40.04, longitude: -76.3 } } }] : undefined;
      return json({ routes: [Object.assign({ distanceMeters: Math.round((b.includeLegs ? 882 : 877) * 1609.34), duration: '46789s' }, legs ? { legs } : {})] });
    }
    if (url.includes('/.netlify/functions/diesel-price')) return json({ error: 'off in this test' }, 502);
    if (url.includes('/.netlify/functions/')) return json({});
    if (url.includes('/rest/v1/rpc/my_account')) return json({ row: account, team: null });
    if (url.includes('/rest/v1/quote_log')) {
      if (req.method() === 'POST') {
        const row = Object.assign({ id: db.nextId++, created_at: new Date().toISOString() }, JSON.parse(req.postData() || '{}'));
        db.posts.push(row); db.quotes.unshift(row);
        return json([row], 201);
      }
      if (req.method() === 'DELETE') {
        if (db.failDeletes) return route.abort();
        const q = new URL(url).search;
        db.deletes.push(q);
        const id = (q.match(/id=eq\.(\d+)/) || [])[1];
        const gone = db.quotes.filter((r) => String(r.id) === id);
        db.quotes = db.quotes.filter((r) => String(r.id) !== id);
        return json(gone);
      }
      return json(db.quotes);
    }
    if (url.includes('/rest/v1/pro_users')) return req.method() === 'GET' ? json([account]) : route.fulfill({ status: 204, body: '' });
    if (url.includes('supabase.co')) return json([]);
    if (url.includes('fonts.googleapis.com') || url.includes('fonts.gstatic.com')) return route.continue();
    return route.abort();
  });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('dialog', async (d) => { db.dialogs.push(d.message()); await d.accept(); });
  return { context, page, errors, db };
}
const openCalc = async (t, base) => {
  await t.page.goto(base + '/index.html');
  await t.page.waitForFunction(() => typeof regionalRates !== 'undefined' && regionalRates !== null && typeof isProUser !== 'undefined' && isProUser && window.QFCQuotePDF);
  await t.page.waitForTimeout(300);
};
const money = (s) => Number(String(s || '').replace(/[^0-9.-]/g, '')) || 0;
const box = (page) => page.evaluate(() => {
  const v = (id) => (document.getElementById(id) || {}).textContent || '';
  return { quote: v('r-quote'), cost: v('r-cost'), extra: v('r-extra'), extraShown: document.getElementById('r-extra-row').style.display !== 'none',
    margin: v('r-margin'), problem: document.getElementById('r-problem').hidden ? '' : v('r-problem'),
    added: document.getElementById('transit-added-badge').style.display === 'flex' };
});
// A lane typed in with miles entered (no lookup), dates and margin
const lane = (page, o = {}) => page.evaluate((o) => {
  const set = (id, v) => { document.getElementById(id).value = v; };
  set('origin', o.origin || 'Hastings, FL'); set('dest', 'Lancaster, PA');
  set('miles', o.miles || 882); set('weight', o.weight || 42000); set('trailer', o.trailer || 'van'); set('commodity', 'standard');
  set('margin', o.margin != null ? o.margin : 18); set('pickup', o.pickup || '2026-11-20'); set('delivery', o.delivery != null ? o.delivery : '2026-11-27');
  manualMiles = true;
  calc(); calcTransit();
}, o);
const setVal = (page, id, v, ev = 'input') => page.evaluate(([id, v, ev]) => { const e = document.getElementById(id); e.value = v; e.dispatchEvent(new Event(ev)); }, [id, v, ev]);


const { execFileSync } = require('child_process');

// Prints one PDF: kind is calc / log (calculator, quote log), ms (multi-stop) or bulk, with n lines of notes.
async function printed(browser, base, kind, n, style) {
  const t = await setup(browser, base, { row: { pdf_style: style, pdf_terms: 'Rates valid for 48 hours. Detention after 2 free hours.\nSecond line of terms.', footer_text: 'Licensed & Bonded' } });
  const notes = Array.from({ length: n }, (_, i) => 'Note line ' + (i + 1) + ': deliver to dock 4, call ahead.').join('\n');
  let tab;
  if (kind === 'ms') {
    await t.page.goto(base + '/multistop.html');
    await t.page.waitForFunction(() => typeof calcTotal === 'function' && window.QFCQuotePDF);
    await t.page.waitForTimeout(800);
    await t.page.evaluate((notes) => {
      stops = [{ id: 1, type: 'pickup', location: 'Hastings, FL', miles: 0, weight: '20000', date: '2026-11-16' },
        { id: 2, type: 'delivery', location: 'Lancaster, PA', miles: 0, weight: '', date: '2026-11-18' },
        { id: 3, type: 'delivery', location: 'Allentown, PA', miles: 0, weight: '', date: '2026-11-18' }];
      stopIdCounter = 3; legMiles = { 1: 1010, 2: 80 };
      document.getElementById('ms-customer').value = 'Acme Foods';
      document.getElementById('ms-load-notes').value = notes;
      calcTotal();
    }, notes);
    [tab] = await Promise.all([t.context.waitForEvent('page'), t.page.evaluate(() => generateMultiStopPDF())]);
  } else if (kind === 'bulk') {
    await t.page.goto(base + '/bulk.html');
    await t.page.waitForFunction(() => typeof generateBulkPDF === 'function' && window.QFCQuotePDF);
    await t.page.waitForTimeout(800);
    await t.page.evaluate(() => {
      const set = (id, v) => { document.getElementById(id).value = v; };
      set('origin', 'Presque Isle, ME'); set('dest', 'Hanover, PA'); set('loaded-miles', 712); set('deadhead-miles', 40);
      set('cwt', 450); set('target-rpm', 2.5); set('offered-rate', 4.35); set('bulk-customer', 'Acme Foods');
      calc();
    });
    [tab] = await Promise.all([t.context.waitForEvent('page'), t.page.evaluate(() => generateBulkPDF())]);
  } else {
    await openCalc(t, base);
    await lane(t.page);
    await t.page.evaluate((notes) => { document.getElementById('load-notes').value = notes; }, notes);
    if (kind === 'log') {
      await t.page.evaluate(() => saveQuote());
      await until(() => t.db.posts.length >= 1);
      const id = await t.page.evaluate(() => quoteLog[0].id);
      [tab] = await Promise.all([t.context.waitForEvent('page'), t.page.evaluate((i) => generateQuotePDFFromLog(i), id)]);
    } else {
      [tab] = await Promise.all([t.context.waitForEvent('page'), t.page.evaluate(() => generateQuotePDF())]);
    }
  }
  await tab.waitForLoadState('load');
  await tab.emulateMedia({ media: 'print' });
  const pdf = path.join(SHOTS, `${style}-${kind}-${n}.pdf`);
  await tab.pdf({ path: pdf, format: 'Letter', printBackground: true });
  const errors = t.errors.slice();
  await t.context.close();
  const pages = execFileSync('pdftotext', ['-layout', pdf, '-']).toString().split('\f').filter((p, i, a) => i < a.length - 1 || p.trim());
  const last = (pages[pages.length - 1] || '').replace(/\s+/g, ' ').trim();
  return {
    pages: pages.length,
    // A last page with no signatures and no notes: only the footer (and terms) went over
    footerAlone: pages.length > 1 && !/Signature|signature|Printed Name|Note line|CALCULATION SETTINGS/.test(last),
    loneHeading: pages.slice(0, -1).some((p) => /(NOTES|REQUIREMENTS|ACCEPTANCE & AUTHORIZATION|CALCULATION SETTINGS)\s*$/.test(p.trim())),
    notes: (pages.join(' ').match(/Note line \d+/g) || []).length,
    errors,
  };
}

(async () => {
  const server = await serve();
  const base = `http://127.0.0.1:${server.address().port}`;
  const browser = await chromium.launch();

  console.log('\n=== Classic PDFs: the footer and the signatures go over together ===');
  const CASES = [
    ['classic', 'calc', 3, 1], ['classic', 'calc', 4, 2], ['classic', 'calc', 30, 3], ['classic', 'calc', 60, 3],
    ['classic', 'log', 0, 1], ['classic', 'log', 4, 2], ['classic', 'log', 41, 2],
    ['classic', 'ms', 0, null], ['classic', 'ms', 20, null], ['classic', 'bulk', 0, 1],
    ['modern', 'calc', 8, null], ['modern', 'calc', 24, null], ['modern', 'ms', 24, null],
  ];
  for (const [style, kind, n, pagesWant] of CASES) {
    const r = await printed(browser, base, kind, n, style);
    const label = `${style} ${kind === 'calc' ? 'calculator' : kind === 'log' ? 'quote log' : kind === 'ms' ? 'multi-stop' : 'bulk'}, ${n} note line${n === 1 ? '' : 's'}`;
    check(`${label}: no page with only the footer, no heading ending a page, every note line printed${pagesWant ? `, ${pagesWant} page${pagesWant === 1 ? '' : 's'}` : ''}`,
      !r.footerAlone && !r.loneHeading && r.notes === n && (!pagesWant || r.pages === pagesWant) && !r.errors.length, JSON.stringify(r));
  }

  await browser.close();
  server.close();
  console.log(`\nPDFs: ${SHOTS}`);
  console.log(failures ? `\n${failures} FAILED` : '\nALL PASS');
  process.exit(failures ? 1 : 0);
})();
