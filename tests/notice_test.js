// tests/notice_test.js — the reminder to subscribers on the original Pro plan
// (pro-notice.js) and the Profile page around it: the reminder comes back until they
// choose their January plan or cancel, every showing and every way of closing it is
// recorded, an expired sign-in is refreshed first, and the site owner's report on the
// Profile page. In a real browser (needs Playwright with Chromium); Supabase and the
// functions are replaced by fakes. Run from the repository root:
//   node tests/notice_test.js [folder for screenshots]
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { chromium } = require('playwright');
const ROOT = path.resolve(__dirname, '..');
const SHOTS = process.argv[2] || fs.mkdtempSync(path.join(os.tmpdir(), 'qfc-notice-'));
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

const KEY = 'sb_publishable_zSa4XpzakcntdkZfTzUPlg_FigYcISZ';
const USER = { id: 'user-1', email: 'pat@example.com' };
const VERIFY = { active: true, plan: 'pro', paid: true, unlimitedUntilRenewal: true, nextPlan: 'pro', planChosen: false, cancelAt: null,
  newPlansStart: '2027-01-01T05:00:00.000Z', renewsAt: null, team: null };
const ROW = { id: 'user-1', email: 'pat@example.com', company_name: 'Morgan Freight', contact_name: 'Pat Morgan', is_active: true, plan: 'pro',
  stripe_customer_id: 'cus_1', stripe_subscription_id: 'sub_1', grandfathered: true };
const REPORT = [
  { email: 'alex@example.com', plan: 'pro', next_plan: null, cancel_at: null, renews_at: null, billing_period_start: null,
    times_shown: 0, first_shown: null, last_shown: null, got_it: 0, chose_plan: 0, closed: 0, last_action: null, last_action_at: null },
  { email: 'jordan@example.com', plan: 'pro', next_plan: null, cancel_at: null, renews_at: null, billing_period_start: null,
    times_shown: 4, first_shown: '2026-11-14T14:00:00Z', last_shown: '2026-11-17T15:20:00Z', got_it: 1, chose_plan: 0, closed: 3,
    last_action: 'clicked_outside', last_action_at: '2026-11-17T15:21:00Z' },
  { email: 'casey@example.com', plan: 'pro', next_plan: 'plus', cancel_at: null, renews_at: null, billing_period_start: null,
    times_shown: 2, first_shown: '2026-11-14T13:00:00Z', last_shown: '2026-11-15T13:00:00Z', got_it: 1, chose_plan: 1, closed: 0,
    last_action: 'choose_plan', last_action_at: '2026-11-15T13:01:00Z' },
  { email: '<img src=x onerror="window.__x=1">@example.com', plan: 'pro', next_plan: null, cancel_at: '2026-12-14T10:00:00Z', renews_at: null, billing_period_start: null,
    times_shown: 1, first_shown: '2026-11-14T12:00:00Z', last_shown: '2026-11-14T12:00:00Z', got_it: 0, chose_plan: 0, closed: 1,
    last_action: 'escape_key', last_action_at: '2026-11-14T12:00:30Z' },
];

async function setup(browser, base, { verify = {}, signedIn = true, expired = false, width = 1280, admin = false, report = REPORT } = {}) {
  const context = await browser.newContext(width < 500
    ? { viewport: { width, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true }
    : { viewport: { width, height: 900 }, deviceScaleFactor: 1 });
  const db = { verify: { ...VERIFY, ...verify }, events: [], verifyCalls: [], refreshes: [], reportCalls: 0, planChanges: [] };
  await context.addInitScript(([u, signed, old]) => {
    if (localStorage.getItem('__seeded')) return;
    localStorage.setItem('__seeded', '1');
    if (signed) {
      localStorage.setItem('sb-xgrmbhmgcsbnazupfybd-auth-token', JSON.stringify({ access_token: old ? 'old-token' : 'tok', refresh_token: 'r1', token_type: 'bearer',
        expires_at: Math.floor(Date.now() / 1000) + (old ? -120 : 3600), user: { id: u.id, email: u.email } }));
    }
  }, [USER, signedIn, expired]);
  await context.route('**/*', async (route) => {
    const req = route.request();
    const url = req.url();
    const json = (b, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(b) });
    if (url.startsWith('blob:') || (url.startsWith(base) && !url.includes('/.netlify/functions/'))) return route.continue();
    if (url.includes('/auth/v1/token')) {
      db.refreshes.push(JSON.parse(req.postData() || '{}'));
      return json({ access_token: 'fresh-token', refresh_token: 'r2', expires_in: 3600, token_type: 'bearer', user: { id: USER.id, email: USER.email } });
    }
    if (url.includes('/rest/v1/plan_notice_events')) {
      const h = req.headers();
      db.events.push({ ...JSON.parse(req.postData() || '{}'), method: req.method(), auth: h['authorization'], apikey: h['apikey'], prefer: h['prefer'] });
      return route.fulfill({ status: 201, body: '' });
    }
    if (url.includes('/rest/v1/rpc/is_site_admin')) return json(admin);
    if (url.includes('/rest/v1/rpc/plan_notice_report')) { db.reportCalls++; return json(admin ? report : []); }
    if (url.includes('/rest/v1/rpc/my_account')) return json({ row: ROW, team: null });
    if (url.includes('/rest/v1/pro_users')) {
      if (req.method() === 'PATCH') return route.fulfill({ status: 204, body: '' });
      return json([ROW]);
    }
    if (url.includes('/.netlify/functions/verify-pro')) { db.verifyCalls.push(JSON.parse(req.postData() || '{}')); return json(db.verify); }
    if (url.includes('/.netlify/functions/change-plan')) {
      const b = JSON.parse(req.postData() || '{}');
      db.planChanges.push(b);
      db.verify = { ...db.verify, nextPlan: b.plan, planChosen: true };
      return json({ status: 'ok', plan: b.plan, atRenewal: true, startsAt: '2027-01-01T05:00:00.000Z', renewsAt: null });
    }
    if (url.includes('/.netlify/functions/')) return json({});
    if (url.includes('supabase.co')) return json([]);
    if (url.includes('fonts.googleapis.com') || url.includes('fonts.gstatic.com')) return route.continue();
    return route.abort();
  });
  return { context, db };
}

async function open(t, base, page = '/index.html') {
  const p = await t.context.newPage();
  const errors = [];
  p.on('pageerror', (e) => errors.push(e.message));
  p.on('dialog', (d) => d.accept());
  await p.goto(base + page);
  return { p, errors };
}
const shownSoon = (p, ms = 8000) => p.waitForSelector('#qfc-plan-notice', { timeout: ms }).then(() => true, () => false);
const actions = (t) => t.db.events.map((e) => e.action);

(async () => {
  const server = await serve();
  const base = `http://127.0.0.1:${server.address().port}`;
  const browser = await chromium.launch();
  let t, v, w;

  console.log('=== The reminder on the calculator ===');
  t = await setup(browser, base);
  v = await open(t, base);
  check('a subscriber on the original plan gets the reminder', await shownSoon(v.p));
  const text = await v.p.locator('#qfc-plan-notice').innerText();
  check('it says what they pay now and what they will pay: $4.99/month, then $9.99/month for Pro',
    /unlimited quotes with automatic miles at \$4\.99\/month until your first bill on or after January 1/.test(text)
    && /At that bill, your price goes to \$9\.99\/month for Pro, unless you choose a different plan or cancel before then/.test(text), text);
  check('…lists Pro Plus with emailed quotes and the rate sheet, and Pro Max with a team of 3',
    /Pro Plus — \$19\.99\/month · automatic miles on 250 quotes per day, win\/loss tracking, a customer list, emailed quotes and your own rate sheet/.test(text)
    && /Pro Max — \$49\.99\/month · everything in Pro Plus, automatic miles on 1,000 quotes per day, white-label PDFs and a team of 3 people/.test(text));
  check('…and says it will keep coming back until they choose', /This reminder will keep coming back until you choose your plan for January in your Profile/.test(text));
  await v.p.screenshot({ path: path.join(SHOTS, 'notice-desktop.png') });
  await until(() => t.db.events.length >= 1);
  const ev = t.db.events[0] || {};
  check('the showing is recorded: "shown" on the calculator, as the signed-in subscriber, without reading anything back',
    ev.action === 'shown' && ev.page === 'calculator' && ev.method === 'POST' && ev.auth === 'Bearer tok' && ev.apikey === KEY && ev.prefer === 'return=minimal',
    JSON.stringify(ev));
  check('the verify call uses their sign-in', t.db.verifyCalls.length === 1 && t.db.verifyCalls[0].userId === USER.id && t.db.verifyCalls[0].accessToken === 'tok');

  await v.p.click('#qfc-plan-notice button[aria-label="Close"]');
  await until(() => t.db.events.length >= 2);
  check('✕ closes it and is recorded as "closed_x"', (await v.p.locator('#qfc-plan-notice').count()) === 0 && actions(t)[1] === 'closed_x', actions(t).join());
  check('…and the page scrolls again', (await v.p.evaluate(() => document.body.style.overflow)) !== 'hidden');
  await v.p.reload();
  check('closed with ✕: not again on this visit', !(await shownSoon(v.p, 2500)) && actions(t).length === 2);
  await v.p.close();

  v = await open(t, base);
  check('…but back on the next visit', await shownSoon(v.p));
  await v.p.mouse.click(8, 8);
  await until(() => actions(t).length >= 4);
  check('a click outside closes it and is recorded as "clicked_outside"',
    (await v.p.locator('#qfc-plan-notice').count()) === 0 && actions(t).slice(2, 4).join() === 'shown,clicked_outside', actions(t).join());
  await v.p.close();

  v = await open(t, base);
  check('back again on the next visit', await shownSoon(v.p));
  await v.p.keyboard.press('Escape');
  await until(() => actions(t).length >= 6);
  check('Escape closes it and is recorded as "escape_key"',
    (await v.p.locator('#qfc-plan-notice').count()) === 0 && actions(t).slice(4, 6).join() === 'shown,escape_key', actions(t).join());
  await v.p.close();

  v = await open(t, base);
  check('and again on the next visit', await shownSoon(v.p));
  await v.p.click('#qfc-plan-notice button:has-text("Got it")');
  await until(() => actions(t).length >= 8);
  check('"Got it" closes it and is recorded as "got_it"',
    (await v.p.locator('#qfc-plan-notice').count()) === 0 && actions(t).slice(6, 8).join() === 'shown,got_it', actions(t).join());
  const verifiesBefore = t.db.verifyCalls.length;
  await v.p.close();
  v = await open(t, base);
  check('after "Got it": not again today, on any visit (no check made either)', !(await shownSoon(v.p, 2500)) && t.db.verifyCalls.length === verifiesBefore);
  await v.p.evaluate(() => {
    const all = JSON.parse(localStorage.getItem('qfc_plan_notice_ack') || '{}');
    const d = new Date(Date.now() - 86400000);
    all['user-1'] = d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
    localStorage.setItem('qfc_plan_notice_ack', JSON.stringify(all));
  });
  await v.p.close();
  v = await open(t, base);
  check('…and back the next day', await shownSoon(v.p));
  await v.p.click('#qfc-plan-notice button:has-text("Choose my plan or cancel")');
  await v.p.waitForURL('**/profile.html#subscription-paid', { timeout: 8000 }).catch(() => {});
  await until(() => actions(t).length >= 10);
  check('"Choose my plan or cancel" opens Profile → Subscription and is recorded as "choose_plan"',
    /\/profile\.html#subscription-paid$/.test(v.p.url()) && actions(t).slice(8, 10).join() === 'shown,choose_plan', `${v.p.url()} ${actions(t).join()}`);
  check('no page errors on the calculator', v.errors.length === 0, v.errors.join(' | '));
  await t.context.close();

  console.log('\n=== Who doesn’t get it ===');
  for (const [label, verify, signedIn] of [
    ['someone who has chosen their January plan', { planChosen: true, nextPlan: 'plus' }, true],
    ['someone whose subscription is set to end', { cancelAt: '2026-12-14T10:00:00Z' }, true],
    ['a team member (the owner handles billing)', { paid: false, unlimitedUntilRenewal: false, team: { role: 'member', seated: true, size: 3 } }, true],
    ['a subscriber on the new plans', { plan: 'plus', unlimitedUntilRenewal: false, nextPlan: null }, true],
    ['someone without an active subscription', { active: false, paid: false, unlimitedUntilRenewal: false }, true],
  ]) {
    t = await setup(browser, base, { verify, signedIn });
    v = await open(t, base);
    await until(() => t.db.verifyCalls.length >= 1);
    check(`not shown to ${label}`, !(await shownSoon(v.p, 2000)) && t.db.events.length === 0);
    await v.p.close();
    w = await open(t, base);
    await sleep(1500);
    check('…and not checked again for a day', t.db.verifyCalls.length === 1, `${t.db.verifyCalls.length} checks`);
    await t.context.close();
  }
  t = await setup(browser, base, { signedIn: false });
  v = await open(t, base);
  await sleep(2000);
  check('signed out: nothing is checked or shown', t.db.verifyCalls.length === 0 && (await v.p.locator('#qfc-plan-notice').count()) === 0);
  await t.context.close();
  t = await setup(browser, base);
  t.db.verify = { active: false, reason: 'Invalid session' };
  v = await open(t, base);
  await until(() => t.db.verifyCalls.length >= 1);
  await sleep(500);
  await v.p.close();
  t.db.verify = { ...VERIFY };
  v = await open(t, base);
  check('a check that fails is not remembered: the next visit checks again and shows it', await shownSoon(v.p) && t.db.verifyCalls.length === 2);
  await t.context.close();

  console.log('\n=== An expired sign-in, on the other pages ===');
  t = await setup(browser, base, { expired: true });
  v = await open(t, base, '/bulk.html');
  check('Bulk load: with a sign-in over an hour old, the reminder still shows', await shownSoon(v.p, 12000));
  check('…after refreshing the sign-in once', t.db.refreshes.length === 1 && t.db.refreshes[0].refresh_token === 'r1', JSON.stringify(t.db.refreshes));
  check('…and checking with the new one', t.db.verifyCalls.some((c) => c.accessToken === 'fresh-token'));
  const stored = await v.p.evaluate(() => JSON.parse(localStorage.getItem('sb-xgrmbhmgcsbnazupfybd-auth-token')));
  check('the new sign-in is stored for the page, keeping the rest of it', stored.access_token === 'fresh-token' && stored.refresh_token === 'r2'
    && stored.expires_at > Date.now() / 1000 + 3000 && stored.user.id === USER.id && stored.token_type === 'bearer', JSON.stringify(stored));
  await until(() => t.db.events.length >= 1);
  check('recorded as shown on "bulk", with the new sign-in', t.db.events[0] && t.db.events[0].page === 'bulk' && t.db.events[0].auth === 'Bearer fresh-token', JSON.stringify(t.db.events));
  check('no page errors on Bulk load', v.errors.length === 0, v.errors.join(' | '));
  await t.context.close();

  for (const [page, name] of [['/multistop.html', 'multistop'], ['/lanes.html', 'lanes']]) {
    t = await setup(browser, base);
    v = await open(t, base, page);
    const ok = await shownSoon(v.p);
    await until(() => t.db.events.length >= 1);
    check(`${name}: shown and recorded with the page name`, ok && t.db.events[0] && t.db.events[0].page === name, JSON.stringify(t.db.events));
    check(`no page errors on ${name}`, v.errors.length === 0, v.errors.join(' | '));
    await t.context.close();
  }

  console.log('\n=== On a phone ===');
  t = await setup(browser, base, { width: 390 });
  v = await open(t, base);
  check('shown on a phone', await shownSoon(v.p));
  const fit = await v.p.evaluate(() => {
    const card = document.querySelector('.qfc-plan-notice-card').getBoundingClientRect();
    const el = document.querySelector('.qfc-plan-notice-card');
    return { left: card.left, right: card.right, top: card.top, bottom: card.bottom, vw: innerWidth, vh: innerHeight, page: document.documentElement.scrollWidth,
      scrolled: el.scrollTop, focused: document.activeElement && document.activeElement.textContent };
  });
  check('it fits the screen, no sideways scrolling', fit.left >= 0 && fit.right <= fit.vw && fit.top >= 0 && fit.bottom <= fit.vh && fit.page <= fit.vw, JSON.stringify(fit));
  check('it opens at the top (title showing), with "Got it" focused for the keyboard', fit.scrolled === 0 && fit.focused === 'Got it', JSON.stringify(fit));
  await v.p.screenshot({ path: path.join(SHOTS, 'notice-phone.png') });
  await v.p.locator('#qfc-plan-notice button:has-text("Got it")').scrollIntoViewIfNeeded();
  await v.p.screenshot({ path: path.join(SHOTS, 'notice-phone-bottom.png') });
  await v.p.locator('#qfc-plan-notice button:has-text("Got it")').tap();
  await until(() => actions(t).includes('got_it'));
  check('"Got it" can be reached and tapped', (await v.p.locator('#qfc-plan-notice').count()) === 0 && actions(t).includes('got_it'));
  await t.context.close();

  console.log('\n=== Profile → Subscription ===');
  t = await setup(browser, base);
  v = await open(t, base, '/profile.html');
  await v.p.waitForFunction(() => /\$4\.99/.test(document.getElementById('sub-plan-legacy').textContent), null, { timeout: 8000 }).catch(() => {});
  const sub = await v.p.evaluate(() => ({
    legacy: document.getElementById('sub-plan-legacy').textContent,
    shown: getComputedStyle(document.getElementById('sub-plan-legacy')).display !== 'none',
    name: document.getElementById('sub-plan-name').textContent,
    detail: document.getElementById('sub-plan-detail').textContent,
    btn: document.getElementById('sub-plan-switch').textContent.trim(),
    options: [...document.querySelectorAll('#sub-plan-select option')].map((o) => o.textContent),
    selected: document.getElementById('sub-plan-select').value,
    foot: document.getElementById('sub-plan-footnote').textContent.replace(/\s+/g, ' '),
  }));
  check('the original plan, at $4.99/month', sub.name === 'QuickFreightCalc Pro · original plan' && /^\$4\.99\/month · Unlimited quotes/.test(sub.detail), sub.detail);
  check('the note: $4.99/month until the first January bill, then Pro at $9.99/month unless they choose',
    sub.shown && /at \$4\.99\/month until your first bill on or after January 1\. From that bill, your subscription moves to Pro at \$9\.99\/month unless you choose a different plan or cancel before then\. Choose your plan for January below\./.test(sub.legacy), sub.legacy);
  check('Pro is selected and the button says "Choose this plan"', sub.selected === 'pro' && sub.btn === 'Choose this plan', `${sub.selected} ${sub.btn}`);
  check('the plan menu matches the pop-up (emailed quotes and rate sheet for Pro Plus, team of 3 for Pro Max, team of 6 for API)',
    sub.options[1] === 'Pro Plus — $19.99/mo · 250 quotes/day, win/loss, customer list, emailed quotes, your own rate sheet'
    && sub.options[2] === 'Pro Max — $49.99/mo · 1,000 quotes/day, all of Pro Plus, white-label PDFs, team of 3'
    && sub.options[3] === 'API — $199.99/mo · Pro Max with a team of 6, plus 5,000 API quotes/mo', sub.options.join(' | '));
  check('the fine print too', /Pro Plus \$19\.99\/month: 250 per day, win\/loss tracking, a customer list, emailed quotes and your own rate sheet · Pro Max \$49\.99\/month: everything in Pro Plus, 1,000 per day, white-label PDFs and a team of 3 people · API \$199\.99\/month: Pro Max with a team of 6 people, plus 5,000 API quotes per month\./.test(sub.foot), sub.foot);
  const layout = await v.p.evaluate(() => {
    const sel = document.getElementById('sub-plan-select').getBoundingClientRect();
    const btn = document.getElementById('sub-plan-switch').getBoundingClientRect();
    return { selW: sel.width, sameRow: Math.abs(sel.top - btn.top) < 4 };
  });
  check('the longer plan names don’t push the buttons off the row', layout.selW <= 381 && layout.sameRow, JSON.stringify(layout));
  await v.p.locator('#subscription-paid').screenshot({ path: path.join(SHOTS, 'profile-original.png') });
  check('not the site owner: no report, and none asked for', (await v.p.locator('#plan-notice-report').isVisible()) === false && t.db.reportCalls === 0);

  await v.p.click('#sub-plan-switch');
  await v.p.waitForFunction(() => /you'll be on Pro at \$9\.99\/month/.test(document.getElementById('sub-plan-status').textContent), null, { timeout: 8000 }).catch(() => {});
  const after = await v.p.evaluate(() => ({ status: document.getElementById('sub-plan-status').textContent,
    legacy: document.getElementById('sub-plan-legacy').textContent, btn: document.getElementById('sub-plan-switch').textContent.trim() }));
  check('choosing Pro for January is saved (change-plan, plan "pro")', t.db.planChanges.length === 1 && t.db.planChanges[0].plan === 'pro');
  check('…and confirmed with the price', /From your first bill on or after January 1, 2027, you'll be on Pro at \$9\.99\/month\./.test(after.status), after.status);
  check('…the note now says it’s their choice, and the button says "Change plan"',
    /From that bill, you'll be on Pro at \$9\.99\/month, the plan you chose\./.test(after.legacy) && after.btn === 'Change plan', `${after.legacy} | ${after.btn}`);
  check('no page errors on Profile', v.errors.length === 0, v.errors.join(' | '));
  await t.context.close();

  t = await setup(browser, base, { verify: { planChosen: true, nextPlan: 'plus' } });
  v = await open(t, base, '/profile.html');
  await v.p.waitForFunction(() => /the plan you chose/.test(document.getElementById('sub-plan-legacy').textContent), null, { timeout: 8000 }).catch(() => {});
  let legacy = await v.p.locator('#sub-plan-legacy').textContent();
  check('chose Pro Plus: "you’ll be on Pro Plus at $19.99/month, the plan you chose"', /From that bill, you'll be on Pro Plus at \$19\.99\/month, the plan you chose\./.test(legacy), legacy);
  await t.context.close();

  t = await setup(browser, base, { verify: { cancelAt: '2026-12-14T15:00:00Z' } });
  v = await open(t, base, '/profile.html');
  await v.p.waitForFunction(() => /set to end/.test(document.getElementById('sub-plan-legacy').textContent), null, { timeout: 8000 }).catch(() => {});
  legacy = await v.p.locator('#sub-plan-legacy').textContent();
  check('set to end: "Your subscription is set to end on December 14, 2026…"', legacy === 'Your subscription is set to end on December 14, 2026, so the January 1, 2027 plan change won\'t apply to you.', legacy);
  await t.context.close();

  console.log('\n=== The site owner’s report ===');
  t = await setup(browser, base, { admin: true });
  v = await open(t, base, '/profile.html');
  check('the site owner sees the Plan change notice report', await v.p.waitForSelector('#plan-notice-report', { state: 'visible', timeout: 8000 }).then(() => true, () => false));
  const rep = await v.p.evaluate(() => ({
    summary: document.getElementById('pn-summary').textContent,
    rows: [...document.querySelectorAll('#pn-rows tr')].map((tr) => [...tr.children].map((td) => td.innerText.replace(/\s+/g, ' ').trim())),
    xss: window.__x === 1 || !!document.querySelector('#pn-rows img'),
  }));
  check('a summary: 4 subscribers, 2 chose a plan or cancelled, 2 clicked "Got it" or "Choose my plan", 1 hasn’t seen it',
    rep.summary === '4 subscribers are on the original plan. 2 chose a January plan or cancelled, 2 clicked “Got it” or “Choose my plan” at least once, and 1 hasn’t seen the reminder yet.', rep.summary);
  const [r0, r1, r2, r3] = rep.rows;
  check('not seen yet: Pro, hasn’t chosen, shown "Not yet"', r0 && r0[0] === 'alex@example.com' && /^Pro hasn’t chosen yet$/.test(r0[1]) && r0[2] === 'Not yet' && r0[5] === 'None', JSON.stringify(r0));
  check('seen 4 times, read once, closed 3 times without "Got it", last clicked outside',
    r1 && r1[2].startsWith('4 times last Nov 17') && r1[3] === '1 time' && r1[4] === '3 times' && r1[5].startsWith('Clicked outside Nov 17'), JSON.stringify(r1));
  check('chose Pro Plus: "Pro Plus they chose it", last "Choose my plan"', r2 && r2[1] === 'Pro Plus they chose it' && r2[3] === '2 times' && r2[5].startsWith('Choose my plan'), JSON.stringify(r2));
  check('cancelling: "Cancelling ends December 14, 2026", last pressed Escape', r3 && r3[1] === 'Cancelling ends December 14, 2026' && r3[5].startsWith('Pressed Escape'), JSON.stringify(r3));
  check('an email address is shown as text, never as page code', !rep.xss && r3 && r3[0].startsWith('<img'), JSON.stringify(r3));
  await v.p.locator('#plan-notice-report').screenshot({ path: path.join(SHOTS, 'profile-report.png') });
  await t.context.close();

  t = await setup(browser, base, { admin: true, width: 390 });
  v = await open(t, base, '/profile.html');
  await v.p.waitForSelector('#plan-notice-report', { state: 'visible', timeout: 8000 }).catch(() => {});
  const phone = await v.p.evaluate(() => ({ page: document.documentElement.scrollWidth, vw: innerWidth,
    head: getComputedStyle(document.querySelector('.pn-table thead')).display, label: getComputedStyle(document.querySelector('#pn-rows td:nth-child(2)'), '::before').content }));
  check('on a phone: one card per subscriber with labels, no sideways scrolling', phone.page <= phone.vw && phone.head === 'none' && phone.label === '"January plan"', JSON.stringify(phone));
  await v.p.locator('#plan-notice-report').screenshot({ path: path.join(SHOTS, 'profile-report-phone.png') });
  await t.context.close();

  t = await setup(browser, base, { admin: true, report: [] });
  v = await open(t, base, '/profile.html');
  await v.p.waitForSelector('#plan-notice-report', { state: 'visible', timeout: 8000 }).catch(() => {});
  check('with nobody left on the original plan: says so', (await v.p.locator('#pn-summary').textContent()) === 'No subscribers are on the original plan.');
  await t.context.close();

  await browser.close();
  server.close();
  console.log(`\nScreenshots in ${SHOTS}`);
  console.log(failures ? `\n${failures} NOTICE TEST(S) FAILED` : '\nALL NOTICE TESTS PASSED');
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
