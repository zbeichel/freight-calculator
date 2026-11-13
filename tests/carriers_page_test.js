// tests/carriers_page_test.js — the Carrier check page (carriers.html) in a real browser:
// what each plan sees (previews for visitors, free accounts and Pro; checks for Pro Plus;
// the watch list and alerts for Pro Max), the report for a clean carrier, one to check and
// one not to book, errors and limits, deep links, signing in again, and the phone layout.
// Reports are built by the server's own code (netlify/lib/fmcsa.js) from made-up FMCSA
// rows; the carrier-check function, Supabase and the plan functions are fakes.
// Needs Playwright with Chromium. Run from the repository root:
//   node tests/carriers_page_test.js [folder for screenshots]
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { chromium } = require('playwright');
const F = require('../netlify/lib/fmcsa.js');
const ROOT = path.resolve(__dirname, '..');
const SHOTS = process.argv[2] || fs.mkdtempSync(path.join(os.tmpdir(), 'qfc-carriers-'));
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.json': 'application/json', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png' };
let failures = 0;
const check = (label, cond, detail) => { console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}${detail && !cond ? '  — ' + detail : ''}`); if (!cond) failures++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(cond, ms = 6000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (cond()) return true; await sleep(50); }
  return cond();
}
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

// ── Made-up carriers, as FMCSA's open data would describe them ──────────────
const PROPERTY = 'Motor Carrier of Property (Except Household Goods)';
const ymd = (days) => new Date(Date.now() + days * 86400000).toISOString().slice(0, 10).replace(/-/g, '');
function rows(dot, mc, o = {}) {
  return Object.assign({
    dot: String(dot),
    census: [Object.assign({ dot_number: String(dot), legal_name: 'KEYSTONE RIDGE TRANSPORT LLC', phy_street: '2200 VALLEY RD', phy_city: 'HARRISBURG', phy_state: 'PA', phy_zip: '17104',
      phone: '7175550142', email_address: 'DISPATCH@EXAMPLE.COM', status_code: 'A', add_date: '20150612', mcs150_date: '20260215', power_units: '38', total_drivers: '41',
      carrier_operation: 'A', classdef: 'AUTHORIZED FOR HIRE', safety_rating: 'S', safety_rating_date: '20190807' }, o.census || {})],
    authority: o.authority || [{ docket_number: mc, usdot_number: String(dot), op_auth_type: PROPERTY, op_auth_status: 'Active', min_cov_amount: '750000.00', bipd_file: '1000000.00' }],
    authHistory: o.authHistory || [{ op_auth_type: PROPERTY, op_auth_status: 'Active', reason: 'Granted', status_change_date: '20150901' }],
    insurance: o.insurance || [
      { ins_type_code: '1', ins_class_code: 'P', max_cov_amount: '1000000.00', effective_date: '20260101', insurance_company_name: 'Granite State Mutual', policy_no: 'GS-1' },
      { ins_type_code: '2', ins_class_code: 'P', max_cov_amount: '100000.00', effective_date: '20260101', insurance_company_name: 'Granite State Mutual', policy_no: 'GS-2' }],
    insHistory: o.insHistory || [],
    orders: o.orders || [],
    oos: o.oos || [],
    inspections: o.inspections || [{ insp_level_id: '1', v_oos: false, d_oos: false, n: '61' }, { insp_level_id: '1', v_oos: true, d_oos: false, n: '9' },
      { insp_level_id: '3', v_oos: false, d_oos: false, n: '30' }, { insp_level_id: '3', v_oos: false, d_oos: true, n: '2' }],
    crashes: o.crashes || [{ fatal: false, inj: true, tow_away: 'true', n: '1' }, { fatal: false, inj: false, tow_away: 'true', n: '2' }],
  });
}
const NATIONAL = { vehicle: 0.2259, driver: 0.0614 };
const CARRIERS = {
  '9900001': rows(9900001, 'MC9900101'),
  '9900002': rows(9900002, 'MC9900102', {
    census: { legal_name: 'BLUE HERON LOGISTICS LLC', phy_street: '48 HARBOR WAY', phy_city: 'SAVANNAH', phy_state: 'GA', phy_zip: '31401', phone: '9125550177', email_address: 'OPS@EXAMPLE.COM',
      add_date: ymd(-75), mcs150_date: ymd(-75), power_units: '2', total_drivers: '2', safety_rating: null, safety_rating_date: null },
    authority: [{ docket_number: 'MC9900102', usdot_number: '9900002', op_auth_type: PROPERTY, op_auth_status: 'Active', min_cov_amount: '750000.00', bipd_file: '750000.00' }],
    authHistory: [{ op_auth_type: PROPERTY, op_auth_status: 'Active', reason: 'Granted', status_change_date: ymd(-28) }],
    insurance: [{ ins_type_code: '1', ins_class_code: 'P', max_cov_amount: '750000.00', effective_date: ymd(-40), insurance_company_name: 'Coastal Plains Insurance', policy_no: 'CP-7' }],
    insHistory: [{ ins_type_code: '1', ins_type_desc: 'BIPD', filing_status_reason: 'CANCEL', cancl_effective_date: ymd(19), policy_no: 'CP-7', insurance_company_name: 'Coastal Plains Insurance' }],
    inspections: [{ insp_level_id: '2', v_oos: false, d_oos: false, n: '2' }], crashes: [] }),
  '9900003': rows(9900003, 'MC9900103', {
    census: { legal_name: 'RAPID LANE FREIGHT INC', phy_street: '9 DEPOT ST', phy_city: 'GARY', phy_state: 'IN', phy_zip: '46402', phone: '2195550110', email_address: '',
      add_date: '20190304', mcs150_date: '20230110', power_units: '11', total_drivers: '9', safety_rating: 'C', safety_rating_date: '20240502' },
    authority: [{ docket_number: 'MC9900103', usdot_number: '9900003', op_auth_type: PROPERTY, op_auth_status: 'Inactive', min_cov_amount: '750000.00', bipd_file: '0' }],
    authHistory: [{ op_auth_type: PROPERTY, op_auth_status: 'Inactive', reason: 'Involuntary Suspension - insurance cancellation effective', status_change_date: ymd(-12) },
      { op_auth_type: PROPERTY, op_auth_status: 'Active', reason: 'Granted', status_change_date: '20190601' }],
    insurance: [],
    oos: [{ oos_date: new Date(Date.now() - 5 * 86400000).toISOString().slice(0, 10), oos_reason: 'Imminent Hazard' }],
    inspections: [{ insp_level_id: '1', v_oos: true, d_oos: false, n: '14' }, { insp_level_id: '1', v_oos: false, d_oos: true, n: '5' }, { insp_level_id: '1', v_oos: false, d_oos: false, n: '11' }],
    crashes: [{ fatal: true, inj: false, tow_away: 'true', n: '1' }, { fatal: false, inj: false, tow_away: 'true', n: '3' }] }),
};
const DOCKETS = { MC9900101: '9900001', MC9900102: '9900002', MC9900103: '9900003' };
const report = (dot, missing = []) => {
  const raw = Object.assign({}, CARRIERS[dot]);
  for (const k of missing) raw[k] = null;   // a part FMCSA didn't answer for
  return F.buildReport(raw, { national: NATIONAL, now: Date.now() });
};

// ── The carrier-check function, faked with the server's own number reading ─
function fakeFunction(acct) {
  const st = Object.assign({ plan: 'plus', used: 3, saved: [], alerts: [], calls: [], checkedToday: new Set(), nextId: 1 }, acct);
  st.limit = { plus: 100, max: 500, api: 500, comp: 500 }[st.plan] || 0;
  const canLookup = () => st.limit > 0;
  const canMonitor = () => ['max', 'api', 'comp'].includes(st.plan);
  const usage = () => (canLookup() ? { used: st.used, limit: st.limit } : null);
  const id = () => '00000000-0000-4000-8000-' + String(st.nextId++).padStart(12, '0');
  st.handle = (body, token) => {
    st.calls.push(Object.assign({ token }, body));
    if (token === 'expired') return [401, { error: 'auth', message: 'Sign in to check carriers.' }];
    switch (body.action) {
      case 'list':
        return [200, { plan: st.plan, canLookup: canLookup(), canMonitor: canMonitor(), usage: usage(), saved: canMonitor() ? st.saved : [], alerts: canMonitor() ? st.alerts : [], savedLimit: canMonitor() ? 500 : 0 }];
      case 'lookup': {
        if (!canLookup()) return [403, { error: 'plan', message: 'Carrier checks come with Pro Plus.' }];
        const q = F.parseQuery(body.query, body.kind === 'dot' ? 'dot' : 'mc');
        if (!q) return [400, { error: 'invalid', message: 'Enter an MC number (e.g. MC 135797) or a USDOT number (e.g. DOT 80806).' }];
        if (st.down) return [502, { error: 'source', message: 'FMCSA’s data isn’t answering right now. Try again in a minute.' }];
        const dot = q.dot || DOCKETS[q.docket];
        if (!dot || !CARRIERS[dot]) return [404, { error: 'not_found', message: q.docket ? `No carrier with ${q.docket.replace(/^(MC|MX|FF)/, '$1 ')} in FMCSA’s records.` : `No carrier with USDOT ${q.dot} in FMCSA’s records.` }];
        if (!st.checkedToday.has(dot) && st.used >= st.limit) return [429, { error: 'limit', message: `You’ve checked ${st.limit} carriers today. Checks reset at midnight UTC (7 p.m. Eastern).`, usage: usage() }];
        if (!st.checkedToday.has(dot)) { st.checkedToday.add(dot); st.used++; }
        const r = report(dot, (st.missing || {})[dot]);
        if (st.rename && st.rename[dot]) r.name = st.rename[dot];
        const saved = canMonitor() ? st.saved.find((s) => s.dot_number === dot) || null : null;
        return [200, { report: r, usage: usage(), plan: st.plan, canMonitor: canMonitor(), saved: saved && { id: saved.id } }];
      }
      case 'save': {
        if (!canMonitor()) return [403, { error: 'plan', message: 'Saving carriers and alerts come with Pro Max.' }];
        let row = st.saved.find((s) => s.dot_number === String(body.dot));
        if (!row) {
          const r = report(String(body.dot));
          row = { id: id(), dot_number: String(body.dot), docket: body.docket || null, name: body.name || null, note: null, verdict: r.verdict, facts: {}, checked_at: new Date().toISOString(), created_at: new Date().toISOString() };
          st.saved.unshift(row);
        }
        return [200, { saved: row }];
      }
      case 'remove': {
        const before = st.saved.length;
        st.saved = st.saved.filter((s) => s.id !== body.id);
        return st.saved.length < before ? [200, { removed: body.id }] : [404, { error: 'not_found', message: 'That carrier isn’t on your list.' }];
      }
      case 'note': {
        const row = st.saved.find((s) => s.id === body.id);
        if (!row) return [404, { error: 'not_found' }];
        row.note = String(body.note || '').trim() || null;
        return [200, { saved: row }];
      }
      case 'seen':
        st.alerts.forEach((a) => { a.seen_at = a.seen_at || new Date().toISOString(); });
        return [200, { ok: true }];
      default: return [400, { error: 'invalid' }];
    }
  };
  return st;
}

async function setup(browser, base, { signedIn = true, token = 'tok', expired = false, plan = 'plus', fn = {}, width = 1280, theme = 'dark', verify = {} } = {}) {
  const context = await browser.newContext(width < 500
    ? { viewport: { width, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true }
    : { viewport: { width, height: 900 }, deviceScaleFactor: 1 });
  await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: base });
  const st = fakeFunction(Object.assign({ plan }, fn));
  const db = { st, refreshes: 0, verify: Object.assign({ active: !!plan && plan !== 'none', plan: plan || null, paid: true, trialEligible: false }, verify) };
  await context.addInitScript(([signed, tok, exp, th]) => {
    if (localStorage.getItem('__seeded')) return;
    localStorage.setItem('__seeded', '1');
    localStorage.setItem('qfc_theme', th);
    if (signed) localStorage.setItem('sb-xgrmbhmgcsbnazupfybd-auth-token', JSON.stringify({ access_token: tok, refresh_token: 'r', expires_at: Math.floor(Date.now() / 1000) + (exp ? -60 : 3600), user: { id: 'user-1', email: 'pat@example.com' } }));
  }, [signedIn, token, expired, theme]);
  await context.route('**/*', async (route) => {
    const req = route.request();
    const url = req.url();
    const json = (b, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(b) });
    if (url.startsWith(base) && !url.includes('/.netlify/functions/')) return route.continue();
    if (url.includes('/.netlify/functions/carrier-check')) {
      const [status, body] = st.handle(JSON.parse(req.postData() || '{}'), (req.headers().authorization || '').replace('Bearer ', ''));
      return json(body, status);
    }
    if (url.includes('/auth/v1/token')) { db.refreshes++; return json({ access_token: 'tok-fresh', refresh_token: 'r2', expires_in: 3600, user: { id: 'user-1', email: 'pat@example.com' } }); }
    if (url.includes('/.netlify/functions/plan-options')) return json({ yearly: ['pro', 'plus', 'max'], prices: {}, trial: { days: 7, plans: ['plus', 'max'], dailyLimit: 100 } });
    if (url.includes('/.netlify/functions/verify-pro')) return json(db.verify);
    if (url.includes('/.netlify/functions/')) return json({});
    if (url.includes('/rest/v1/rpc/my_account')) return json({ row: plan ? { id: 'user-1', is_active: true, plan } : null, team: null });
    if (url.includes('/rest/v1/rpc/is_site_admin')) return json(false);
    if (url.includes('supabase.co')) return json([]);
    if (url.includes('fonts.googleapis.com') || url.includes('fonts.gstatic.com')) return route.continue();
    return route.abort();
  });
  return { context, db, st };
}
async function open(t, base, page) {
  const p = await t.context.newPage();
  const errors = [];
  p.on('pageerror', (e) => errors.push(e.message));
  await p.goto(base + page);
  return { p, errors };
}
const text = (pg, sel) => pg.$eval(sel, (e) => e.innerText.replace(/\s+/g, ' ').trim()).catch(() => '');
const texts = (pg, sel) => pg.$$eval(sel, (els) => els.map((e) => e.innerText.replace(/\s+/g, ' ').trim()));
async function lookup(v, q, kind) {
  if (kind) await v.p.click(`.cc-kind button[data-kind="${kind}"]`);
  await v.p.fill('#cc-q', q);
  const before = await v.p.evaluate(() => document.getElementById('cc-report').innerHTML.length + '|' + document.getElementById('cc-status').textContent);
  await v.p.click('#cc-go');
  await v.p.waitForFunction((b) => !document.getElementById('cc-go').disabled
    && (document.getElementById('cc-report').innerHTML.length + '|' + document.getElementById('cc-status').textContent) !== b, before, { timeout: 8000 }).catch(() => {});
  await v.p.waitForTimeout(150);
}

(async () => {
  const server = await serve();
  const base = `http://127.0.0.1:${server.address().port}`;
  const browser = await chromium.launch();
  let t, v;

  // ── Who sees what ──────────────────────────────────────────────────────────
  console.log('=== Visitors, free accounts and Pro: a preview ===');
  t = await setup(browser, base, { signedIn: false, plan: null });
  v = await open(t, base, '/carriers.html');
  await v.p.waitForSelector('#gate .qf-lp-card');
  await v.p.waitForFunction(() => !document.querySelector('#gate .qf-lp-trial').hidden, null, { timeout: 4000 }).catch(() => {});
  check('signed out: the preview of a carrier report, with Sign in and the free trial',
    (await v.p.isHidden('#app')) && (await text(v.p, '#gate .qf-lp-title')) === 'Carrier check' && (await v.p.$eval('#gate .qf-lp-badge', (e) => e.textContent.trim())) === 'Pro Plus'
      && (await text(v.p, '#gate .qf-lp-main')) === 'Sign in' && (await text(v.p, '#gate .qf-lp-trial')) === 'Try Pro Plus free for 7 days', await text(v.p, '#gate'));
  check('…behind it, a made-up sample report that can’t be clicked', /Example Freight Lines LLC/.test(await text(v.p, '#gate .qf-lp-sample'))
    && (await v.p.$eval('#gate .qf-lp-sample', (e) => e.hasAttribute('inert') && e.getAttribute('aria-hidden') === 'true')) && (await v.p.$$('#gate .qf-lp-sample #cc-copy')).length === 0);
  check('…and nothing asked of the carrier-check function', t.st.calls.length === 0);
  await v.p.screenshot({ path: path.join(SHOTS, 'carriers-signed-out.png') });
  await v.p.click('#gate .qf-lp-main');
  await v.p.waitForURL(/signup\.html\?login/, { timeout: 4000 }).catch(() => {});
  check('Sign in goes to the sign-in page', /\/signup\.html\?login$/.test(v.p.url()), v.p.url());
  check('no page errors (signed out)', v.errors.length === 0, v.errors.join(' | '));
  await t.context.close();

  t = await setup(browser, base, { plan: null, verify: { active: false, plan: null, trialEligible: true } });
  v = await open(t, base, '/carriers.html');
  await v.p.waitForSelector('#gate .qf-lp-card');
  await v.p.waitForFunction(() => !document.querySelector('#gate .qf-lp-trial').hidden, null, { timeout: 4000 }).catch(() => {});
  check('free account: Get Pro Plus, and the 7-day trial', (await text(v.p, '#gate .qf-lp-main')) === 'Get Pro Plus' && (await text(v.p, '#gate .qf-lp-trial')) === 'Try Pro Plus free for 7 days'
    && (await v.p.isHidden('#app')), await text(v.p, '#gate .qf-lp-actions'));
  await v.p.click('#gate .qf-lp-trial');
  await v.p.waitForURL(/signup\.html\?plan=plus/, { timeout: 4000 }).catch(() => {});
  check('…the trial starts from the sign-up page with Pro Plus picked', /\/signup\.html\?plan=plus$/.test(v.p.url()), v.p.url());
  await t.context.close();

  t = await setup(browser, base, { plan: 'pro' });
  v = await open(t, base, '/carriers.html');
  await v.p.waitForSelector('#gate .qf-lp-card');
  await v.p.waitForTimeout(600);
  check('Pro subscriber: Change plan (to Profile), no trial', (await text(v.p, '#gate .qf-lp-main')) === 'Change plan' && (await v.p.isHidden('#gate .qf-lp-trial')) && (await v.p.isHidden('#app')));
  await v.p.click('#gate .qf-lp-main');
  await v.p.waitForURL(/profile\.html/, { timeout: 4000 }).catch(() => {});
  check('…to the plan section of Profile', /\/profile\.html#subscription-paid$/.test(v.p.url()), v.p.url());
  check('no page errors (Pro)', v.errors.length === 0, v.errors.join(' | '));
  await t.context.close();

  // ── Pro Plus: checking carriers ────────────────────────────────────────────
  console.log('\n=== Pro Plus: checking carriers ===');
  t = await setup(browser, base, { plan: 'plus' });
  v = await open(t, base, '/carriers.html');
  await v.p.waitForSelector('#app:not([hidden])');
  await v.p.waitForSelector('#cc-watch-preview .qf-lp-card');
  check('the search, with how many checks are left today', (await v.p.isHidden('#gate')) && (await text(v.p, '#cc-usage')) === '3 of 100 carrier checks used today · checking a carrier again the same day is free',
    await text(v.p, '#cc-usage'));
  check('MC is the default; the box is ready to type in', (await v.p.$eval('.cc-kind button.on', (e) => e.dataset.kind)) === 'mc' && (await v.p.evaluate(() => document.activeElement.id)) === 'cc-q');
  check('below: the Pro Max watch list, as a preview', (await text(v.p, '#cc-watch-preview .qf-lp-title')) === 'Watch your carriers' && (await v.p.isHidden('#cc-watch'))
    && (await v.p.$eval('#cc-watch-preview .qf-lp-badge', (e) => e.textContent.trim())) === 'Pro Max');

  await lookup(v, 'MC 9900101');
  const req = t.st.calls.filter((c) => c.action === 'lookup').pop();
  check('MC 9900101 is sent as typed, with the sign-in token', req && req.query === 'MC 9900101' && req.kind === 'mc' && req.token === 'tok', JSON.stringify(req));
  check('a clean carrier: No problems found', (await text(v.p, '.cc-verdict.ok h2')) === 'No problems found'
    && /Active authority, liability insurance on file and no out-of-service orders/.test(await text(v.p, '.cc-verdict')), await text(v.p, '.cc-verdict'));
  check('name, numbers and contact', (await text(v.p, '.cc-name')) === 'Keystone Ridge Transport LLC' && (await texts(v.p, '.cc-id')).join('|') === 'USDOT 9900001|MC 9900101'
    && /2200 Valley Rd · Harrisburg, PA · 17104 \(717\) 555-0142 · dispatch@example\.com/.test(await text(v.p, '.cc-contact')), await text(v.p, '.cc-head'));
  check('four sections: authority, insurance, safety, registration', (await v.p.$$eval('.cc-sec h3', (els) => els.map((e) => e.textContent.trim()))).join('|') === 'Operating authority|Insurance|Safety (last 2 years)|Registration');
  const sec = async (i) => text(v.p, `.cc-sec:nth-child(${i})`);
  check('authority: carrier of property, active, since Sep 1, 2015', /Carrier of Property Active/.test(await sec(1)) && /First granted Sep 1, 2015/.test(await sec(1)), await sec(1));
  check('insurance: $1,000,000 liability on file, $750,000 required, each filing listed', /Liability on file \$1,000,000/.test(await sec(2)) && /Required \$750,000/.test(await sec(2))
    && /Granite State Mutual · \$1,000,000 · since Jan 1, 2026/.test(await sec(2)), await sec(2));
  check('safety: Satisfactory; out-of-service rates against the U.S. average; crashes, each counted once by its worst outcome (as SAFER does)', /Safety rating Satisfactory · Aug 7, 2019/.test(await sec(3))
    && /Trucks put out of service 12\.9% of 70/.test(await sec(3)) && /U\.S\. average 22\.6%/.test(await sec(3)) && /Drivers put out of service 2% of 102/.test(await sec(3))
    && /Crashes 3 \(0 fatal, 1 injury, 2 tow-away\)/.test(await sec(3)) && /Out-of-service orders None/.test(await sec(3)), await sec(3));
  check('registration: active USDOT, MCS-150, fleet', /USDOT status Active/.test(await sec(4)) && /Last MCS-150 update Feb 15, 2026/.test(await sec(4)) && /Fleet 38 trucks · 41 drivers/.test(await sec(4)), await sec(4));
  check('the usage line counts it: 4 of 100', /^4 of 100 /.test(await text(v.p, '#cc-usage')));
  check('the address bar links to this carrier (?dot=9900001)', new URL(v.p.url()).searchParams.get('dot') === '9900001');
  check('Watch is a Pro Max link to Profile', (await text(v.p, '.cc-actions a[href="/profile.html#subscription-paid"]')) === 'Watch with Pro Max' && (await v.p.$$('#cc-watch-btn')).length === 0);
  check('FMCSA record opens SAFER for this USDOT number', /safer\.fmcsa\.dot\.gov\/query\.asp\?.*query_string=9900001$/.test(await v.p.$eval('.cc-actions a[target="_blank"]', (a) => a.href)));
  await v.p.screenshot({ path: path.join(SHOTS, 'carrier-ok.png'), fullPage: true });
  await v.p.click('#cc-copy');
  await v.p.waitForTimeout(200);
  const clip = await v.p.evaluate(() => navigator.clipboard.readText()).catch((e) => 'ERR ' + e.message);
  check('Copy summary: the verdict and key facts, ready to paste into a load note', /^Keystone Ridge Transport LLC \(USDOT 9900001, MC9900101\): No problems found\nAuthority: Carrier of Property Active\. Liability on file \$1,000,000 \(required \$750,000\)\.\nOut of service, last 2 years: trucks 12\.9%, drivers 2%\.\nChecked .+ with QuickFreightCalc from FMCSA's records\.$/.test(clip)
    && (await text(v.p, '#cc-copy')) === 'Copied', clip);

  await lookup(v, '9900002', 'dot');
  check('USDOT 9900002: Check before booking', (await text(v.p, '.cc-verdict.warn h2')) === 'Check before booking', await text(v.p, '.cc-verdict'));
  const warnFlags = await texts(v.p, '.cc-flags li');
  check('…authority 28 days old (a fraud risk) and liability being cancelled; the new USDOT number isn’t a second fraud warning', warnFlags.length === 2
    && warnFlags.some((f) => /^Authority granted 28 days ago .*fraud risk/.test(f))
    && warnFlags.some((f) => /^Liability insurance with Coastal Plains Insurance is being cancelled on .+\. Unless they file new coverage, their authority will be suspended\.$/.test(f)), warnFlags.join(' | '));
  check('…the cancellation shows under Insurance too', /Cancels .+ Liability/.test(await sec(2)), await sec(2));
  check('…USDOT kept for the next number', (await v.p.$eval('.cc-kind button.on', (e) => e.dataset.kind)) === 'dot' && (await v.p.$eval('#cc-q', (e) => e.placeholder)) === 'USDOT number, e.g. 80806');
  await v.p.screenshot({ path: path.join(SHOTS, 'carrier-warn.png'), fullPage: true });

  await lookup(v, 'MC9900103', 'mc');
  const stopFlags = await texts(v.p, '.cc-flags li');
  check('MC 9900103: Don’t book this carrier', (await text(v.p, '.cc-verdict.stop h2')) === 'Don’t book this carrier', await text(v.p, '.cc-verdict'));
  check('…suspended authority with FMCSA’s reason, an out-of-service order, no liability on file', stopFlags.some((f) => /^No active operating authority: Involuntary Suspension - insurance cancellation effective/.test(f))
    && stopFlags.some((f) => /out-of-service order/i.test(f)) && /Liability on file \$0|Liability on file —/.test(await sec(2)), stopFlags.join(' | '));
  check('…the order and a fatal crash under Safety', /In effect Out-of-service order .+: Imminent Hazard/.test(await sec(3)) && /Crashes 4 \(1 fatal/.test(await sec(3)), await sec(3));
  check('…stop flags first, then warnings, then notes', await v.p.$$eval('.cc-flags li', (els) => { const rank = { stop: 0, warn: 1, info: 2 }; const r = els.map((e) => rank[e.className]); return r.every((x, i) => i === 0 || r[i - 1] <= x); }));
  await v.p.screenshot({ path: path.join(SHOTS, 'carrier-stop.png'), fullPage: true });

  await lookup(v, 'MC 9900101');
  check('the same carrier again today: free (still 6 of 100)', /^6 of 100 /.test(await text(v.p, '#cc-usage')), await text(v.p, '#cc-usage'));
  await lookup(v, 'MC 9999999');
  check('an MC FMCSA doesn’t have: said plainly, and the last report is cleared', (await text(v.p, '#cc-status')) === 'No carrier with MC 9999999 in FMCSA’s records.'
    && (await v.p.$eval('#cc-status', (e) => e.classList.contains('err'))) && (await v.p.isHidden('#cc-report')) && !new URL(v.p.url()).searchParams.has('dot'));
  await lookup(v, 'hello');
  check('something that isn’t a number: how to type one', /^Enter an MC number \(e\.g\. MC 135797\) or a USDOT number/.test(await text(v.p, '#cc-status')));
  await v.p.fill('#cc-q', '');
  await v.p.click('#cc-go');
  await v.p.waitForTimeout(150);
  check('an empty box: asks for a number, nothing sent', (await text(v.p, '#cc-status')) === 'Enter an MC or USDOT number.' && t.st.calls.filter((c) => c.action === 'lookup').length === 6);
  t.st.used = 100;
  await lookup(v, '9900002', 'dot');
  check('a carrier already checked today still opens at the limit', (await text(v.p, '.cc-verdict h2')) === 'Check before booking');
  t.st.checkedToday.delete('9900003');
  await lookup(v, '9900003', 'dot');
  check('a new carrier past the day’s 100: the limit and when it resets; the usage line says 100 of 100',
    (await text(v.p, '#cc-status')) === 'You’ve checked 100 carriers today. Checks reset at midnight UTC (7 p.m. Eastern).' && /^100 of 100 /.test(await text(v.p, '#cc-usage')) && (await v.p.isHidden('#cc-report')));
  check('no page errors (Pro Plus)', v.errors.length === 0, v.errors.join(' | '));
  await t.context.close();

  t = await setup(browser, base, { plan: 'plus', fn: { rename: { '9900001': '<img src=x onerror="window.__xss=1">Keystone' } } });
  v = await open(t, base, '/carriers.html?dot=9900001');
  await v.p.waitForSelector('#cc-report:not([hidden])', { timeout: 8000 }).catch(() => {});
  check('a link with ?dot= opens that carrier’s report (USDOT picked)', (await v.p.$eval('#cc-q', (e) => e.value)) === '9900001' && (await v.p.$eval('.cc-kind button.on', (e) => e.dataset.kind)) === 'dot'
    && (await text(v.p, '.cc-verdict h2')) === 'No problems found');
  check('names from FMCSA are shown as text, never run', (await v.p.evaluate(() => window.__xss)) === undefined && /^<img src=x/.test(await text(v.p, '.cc-name')), await text(v.p, '.cc-name'));
  await t.context.close();

  t = await setup(browser, base, { plan: 'plus', expired: true, token: 'expired' });
  v = await open(t, base, '/carriers.html');
  await v.p.waitForSelector('#app:not([hidden])', { timeout: 6000 }).catch(() => {});
  await lookup(v, 'MC 9900101');
  check('an expired sign-in is renewed first; every call uses the new token', t.db.refreshes >= 1 && t.st.calls.length >= 2 && t.st.calls.every((c) => c.token === 'tok-fresh')
    && (await text(v.p, '.cc-verdict h2')) === 'No problems found', JSON.stringify(t.st.calls.map((c) => c.token)));
  await t.context.close();

  console.log('\n=== When FMCSA’s data is slow or down ===');
  t = await setup(browser, base, { plan: 'plus', fn: { missing: { '9900001': ['oos', 'inspections'] } } });
  v = await open(t, base, '/carriers.html');
  await v.p.waitForSelector('#app:not([hidden])');
  await lookup(v, 'MC 9900101');
  check('part of the record didn’t load: “Check before booking”, saying which part — never “No problems found”',
    (await text(v.p, '.cc-verdict.warn h2')) === 'Check before booking'
      && (await text(v.p, '.cc-flags')) === 'Part of FMCSA’s records didn’t load (out-of-service orders and inspections), so this check isn’t complete. Check again before booking.',
    await text(v.p, '.cc-verdict'));
  const safety = await text(v.p, '.cc-sec:nth-child(3)');
  check('…each missing part says “Didn’t load” where it would be, never “None”', /Inspections Didn’t load/.test(safety) && /Out-of-service orders Didn’t load/.test(safety)
    && !/Out-of-service orders None/.test(safety) && /Crashes 3/.test(safety), safety);
  check('…and offers Check again, free', /Part of it didn’t load: checking this carrier again today is free\./.test(await text(v.p, '.cc-foot')) && (await v.p.isVisible('#cc-again')));
  await v.p.screenshot({ path: path.join(SHOTS, 'carrier-incomplete.png'), fullPage: true });
  delete t.st.missing['9900001'];
  await v.p.click('#cc-again');
  await v.p.waitForFunction(() => /No problems found/.test((document.querySelector('.cc-verdict h2') || {}).textContent || ''), null, { timeout: 6000 }).catch(() => {});
  check('Check again: the full report, and it didn’t count again (4 of 100)', (await text(v.p, '.cc-verdict h2')) === 'No problems found' && /^4 of 100 /.test(await text(v.p, '#cc-usage'))
    && t.st.calls.filter((c) => c.action === 'lookup').pop().query === '9900001', await text(v.p, '#cc-usage'));
  t.st.missing['9900002'] = ['authority'];
  await lookup(v, '9900002', 'dot');
  const auth = await text(v.p, '.cc-sec:nth-child(1)'), insur = await text(v.p, '.cc-sec:nth-child(2)');
  check('the authority part didn’t load: “Didn’t load” for authority and liability, not “None on file” or “$0”, and no “Don’t book”',
    /Operating authority Didn’t load/.test(auth) && /Liability on file Didn’t load/.test(insur) && !/None on file|\$0/.test(auth + insur) && (await text(v.p, '.cc-verdict h2')) === 'Check before booking', auth + ' | ' + insur);
  await v.p.click('#cc-copy');
  await v.p.waitForTimeout(200);
  const clip2 = await v.p.evaluate(() => navigator.clipboard.readText()).catch((e) => 'ERR ' + e.message);
  check('…the copied summary says so too', /\nAuthority and liability on file: didn’t load from FMCSA\.\n/.test(clip2) && !/no carrier authority/.test(clip2), clip2);
  t.st.down = true;
  await lookup(v, 'MC 9900102', 'mc');
  check('FMCSA not answering: “try again in a minute”, nothing counted, no stale report', (await text(v.p, '#cc-status')) === 'FMCSA’s data isn’t answering right now. Try again in a minute.'
    && /^5 of 100 /.test(await text(v.p, '#cc-usage')) && (await v.p.isHidden('#cc-report')), (await text(v.p, '#cc-status')) + ' | ' + (await text(v.p, '#cc-usage')));
  check('no page errors (FMCSA slow or down)', v.errors.length === 0, v.errors.join(' | '));
  await t.context.close();

  // ── Pro Max: watching carriers ─────────────────────────────────────────────
  console.log('\n=== Pro Max: the watch list and alerts ===');
  const iso = (h) => new Date(Date.now() - h * 3600000).toISOString();
  t = await setup(browser, base, { plan: 'max', fn: {
    used: 12,
    saved: [
      { id: '00000000-0000-4000-8000-0000000000a1', dot_number: '9900003', docket: 'MC9900103', name: 'Rapid Lane Freight Inc', note: null, verdict: 'stop', checked_at: iso(3), created_at: iso(400) },
      { id: '00000000-0000-4000-8000-0000000000a2', dot_number: '9900001', docket: 'MC9900101', name: 'Keystone Ridge Transport LLC', note: 'Good on reefer to the Northeast', verdict: 'ok', checked_at: iso(3), created_at: iso(900) }],
    alerts: [
      { id: 'al-1', dot_number: '9900003', name: 'Rapid Lane Freight Inc', kind: 'authority', message: 'Rapid Lane Freight Inc: operating authority is now inactive. Don’t tender them loads until it’s active again.', created_at: iso(3), seen_at: null },
      { id: 'al-2', dot_number: '9900003', name: 'Rapid Lane Freight Inc', kind: 'insurance_cancelling', message: 'Rapid Lane Freight Inc: liability insurance with Lakeshore Casualty is being cancelled on Nov 1, 2026.', created_at: iso(330), seen_at: iso(300) }] } });
  v = await open(t, base, '/carriers.html');
  await v.p.waitForSelector('#cc-watch:not([hidden])');
  check('the watch list instead of the preview; 500 checks a day', (await v.p.isHidden('#cc-watch-preview')) && /^12 of 500 /.test(await text(v.p, '#cc-usage')));
  const savedRows = await v.p.$$eval('#cc-saved tr', (trs) => trs.map((tr) => ({ name: tr.querySelector('.nm').textContent, sub: tr.querySelector('.sub').textContent, chip: tr.querySelector('.chip').textContent,
    cls: tr.querySelector('.chip').className, note: tr.querySelector('input').value })));
  check('saved carriers with their status from this morning’s check', savedRows.length === 2 && savedRows[0].name === 'Rapid Lane Freight Inc' && savedRows[0].chip === 'Don’t book' && /stop/.test(savedRows[0].cls)
    && savedRows[1].chip === 'No problems' && savedRows[1].sub === 'USDOT 9900001 · MC 9900101' && savedRows[1].note === 'Good on reefer to the Northeast', JSON.stringify(savedRows));
  const alertItems = await v.p.$$eval('#cc-alerts li', (lis) => lis.map((li) => ({ isNew: li.classList.contains('new'), text: li.innerText.replace(/\s+/g, ' ') })));
  check('alerts, newest first, unread marked', alertItems.length === 2 && alertItems[0].isNew && !alertItems[1].isNew && /operating authority is now inactive/.test(alertItems[0].text), JSON.stringify(alertItems));
  await v.p.screenshot({ path: path.join(SHOTS, 'carrier-watch-list.png'), fullPage: true });
  await v.p.click('#cc-seen');
  await until(() => t.st.calls.some((c) => c.action === 'seen'));
  await v.p.waitForTimeout(150);
  check('Mark all read', (await v.p.$$('#cc-alerts li.new')).length === 0 && (await v.p.isHidden('#cc-seen')));

  await lookup(v, '9900002', 'dot');
  check('a carrier not on the list: Watch this carrier', (await text(v.p, '#cc-watch-btn')) === 'Watch this carrier');
  await v.p.click('#cc-watch-btn');
  await until(() => t.st.calls.some((c) => c.action === 'save'));
  await v.p.waitForFunction(() => /Watching/.test((document.getElementById('cc-watch-btn') || {}).textContent || ''), null, { timeout: 4000 }).catch(() => {});
  const saveReq = t.st.calls.find((c) => c.action === 'save');
  check('Watch saves it with its numbers and name', saveReq.dot === '9900002' && saveReq.docket === 'MC9900102' && saveReq.name === 'Blue Heron Logistics LLC', JSON.stringify(saveReq));
  check('…“Watching”, it’s at the top of the list, and the page says what happens next', (await text(v.p, '#cc-watch-btn')) === 'Watching' && (await v.p.$eval('#cc-watch-btn', (b) => b.classList.contains('on')))
    && (await texts(v.p, '#cc-saved .nm'))[0] === 'Blue Heron Logistics LLC' && (await text(v.p, '#cc-status')) === 'Watching Blue Heron Logistics LLC: we’ll re-check it every morning.');
  await v.p.click('#cc-watch-btn');
  await until(() => t.st.calls.some((c) => c.action === 'remove'));
  await v.p.waitForFunction(() => /Watch this carrier/.test((document.getElementById('cc-watch-btn') || {}).textContent || ''), null, { timeout: 4000 }).catch(() => {});
  check('clicking Watching again stops watching it', (await texts(v.p, '#cc-saved .nm')).length === 2 && (await text(v.p, '#cc-status')) === 'Removed from your carriers.');

  await v.p.fill('#cc-saved tr:nth-child(1) input', 'Called 11/12, new insurer pending');
  await v.p.press('#cc-saved tr:nth-child(1) input', 'Tab');
  await until(() => t.st.calls.some((c) => c.action === 'note'));
  await v.p.waitForTimeout(150);
  const noteReq = t.st.calls.find((c) => c.action === 'note');
  check('a note on a saved carrier is saved when you leave the box', noteReq && noteReq.id === '00000000-0000-4000-8000-0000000000a1' && noteReq.note === 'Called 11/12, new insurer pending'
    && (await text(v.p, '#cc-status')) === 'Note saved.', JSON.stringify(noteReq));
  await v.p.click('#cc-saved tr:nth-child(2) button[data-act="check"]');
  await v.p.waitForFunction(() => /Keystone Ridge/.test((document.querySelector('.cc-name') || {}).textContent || ''), null, { timeout: 6000 }).catch(() => {});
  check('Check on a saved carrier opens its report (already watching)', (await text(v.p, '.cc-name')) === 'Keystone Ridge Transport LLC' && (await text(v.p, '#cc-watch-btn')) === 'Watching'
    && t.st.calls.filter((c) => c.action === 'lookup').pop().kind === 'dot');
  await v.p.click('#cc-saved tr:nth-child(1) button[data-act="remove"]');
  await v.p.waitForTimeout(400);
  await v.p.click('#cc-saved tr:nth-child(1) button[data-act="remove"]');
  await v.p.waitForTimeout(400);
  check('an empty list explains how to add carriers', (await v.p.$$('#cc-saved tr')).length === 0 && (await v.p.isVisible('#cc-saved-empty')) && /Watch this carrier/.test(await text(v.p, '#cc-saved-empty')));
  check('no page errors (Pro Max)', v.errors.length === 0, v.errors.join(' | '));
  await t.context.close();

  // ── Phone ──────────────────────────────────────────────────────────────────
  console.log('\n=== On a phone ===');
  t = await setup(browser, base, { plan: 'max', width: 390, fn: { saved: [
    { id: '00000000-0000-4000-8000-0000000000b1', dot_number: '9900002', docket: 'MC9900102', name: 'Blue Heron Logistics LLC', note: null, verdict: 'warn', checked_at: iso(2), created_at: iso(50) }] } });
  v = await open(t, base, '/carriers.html?dot=9900003');
  await v.p.waitForSelector('#cc-report:not([hidden])', { timeout: 8000 }).catch(() => {});
  await v.p.waitForTimeout(300);
  const ph = await v.p.evaluate(() => ({
    sideways: document.documentElement.scrollWidth - window.innerWidth,
    lefts: [...document.querySelectorAll('.cc-sec')].map((s) => Math.round(s.getBoundingClientRect().left)),
    hidden: [...document.querySelectorAll('.cc-saved .hide-sm')].every((e) => getComputedStyle(e).display === 'none'),
    input: getComputedStyle(document.getElementById('cc-q')).fontSize,
    buttons: [...document.querySelectorAll('.cc-actions .btn')].every((b) => b.getBoundingClientRect().right <= window.innerWidth),
  }));
  check('no sideways scrolling', ph.sideways <= 1, `${ph.sideways}px`);
  check('the four sections stack in one column', ph.lefts.length === 4 && new Set(ph.lefts).size === 1, JSON.stringify(ph.lefts));
  check('the watch list drops the last-checked and note columns', ph.hidden);
  check('a 16px search box (no zoom on iPhone); the buttons fit', ph.input === '16px' && ph.buttons, JSON.stringify(ph));
  await v.p.screenshot({ path: path.join(SHOTS, 'carrier-phone.png'), fullPage: true });
  check('no page errors (phone)', v.errors.length === 0, v.errors.join(' | '));
  await t.context.close();

  t = await setup(browser, base, { plan: 'plus', theme: 'light' });
  v = await open(t, base, '/carriers.html?dot=9900002');
  await v.p.waitForSelector('#cc-report:not([hidden])', { timeout: 8000 }).catch(() => {});
  await v.p.waitForTimeout(300);
  check('light theme: the report reads the same', (await text(v.p, '.cc-verdict h2')) === 'Check before booking' && (await v.p.evaluate(() => document.documentElement.classList.contains('light'))));
  await v.p.screenshot({ path: path.join(SHOTS, 'carrier-warn-light.png'), fullPage: true });
  await t.context.close();

  await browser.close();
  server.close();
  console.log(`\nScreenshots in ${SHOTS}`);
  console.log(failures ? `\n${failures} CARRIER PAGE TEST(S) FAILED` : '\nALL CARRIER PAGE TESTS PASSED');
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
