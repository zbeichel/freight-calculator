// tests/upgrades_test.js — what the site offers to move people up a plan: yearly billing
// (sign-up page, upgrade windows, Profile), the free trial of Pro Plus and Pro Max, the
// "quotes with automatic miles today" meter (calculator, multi-stop, bulk), and the
// grayed-out previews of higher plans (quote log for free accounts). In a real browser
// (needs Playwright with Chromium); Supabase, Stripe and the functions are fakes.
// Run from the repository root:
//   node tests/upgrades_test.js [folder for screenshots]
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { chromium } = require('playwright');
const ROOT = path.resolve(__dirname, '..');
const SHOTS = process.argv[2] || fs.mkdtempSync(path.join(os.tmpdir(), 'qfc-upgrades-'));
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

const PRICES = { pro: { month: '$9.99', year: '$99' }, plus: { month: '$19.99', year: '$199' }, max: { month: '$49.99', year: '$499' }, api: { month: '$199.99' } };
const OPTIONS = (yearly = ['pro', 'plus', 'max']) => ({ yearly, prices: PRICES, trial: { days: 7, plans: ['plus', 'max'], dailyLimit: 100 } });
const ROW = (o) => Object.assign({ id: 'user-1', email: 'pat@example.com', company_name: 'Morgan Freight', contact_name: 'Pat Morgan', is_active: true, plan: 'pro',
  stripe_customer_id: 'cus_1', stripe_subscription_id: 'sub_1', grandfathered: false, quote_prefix: 'MF', quote_counter: 1001 }, o);
const FREE_ROW = ROW({ is_active: false, stripe_customer_id: null, stripe_subscription_id: null });
const VERIFY = (o) => Object.assign({ active: true, plan: 'pro', paid: true, unlimitedUntilRenewal: false, nextPlan: null, planChosen: false, cancelAt: null,
  interval: 'month', trialEndsAt: null, trialEligible: false, renewsAt: null, team: null }, o);

async function setup(browser, base, { signedIn = true, row = ROW(), verify = VERIFY(), options = OPTIONS(), usage = { used: 42, limit: 100, plan: 'pro', trial: false, team: false },
  lookupUsage = null, width = 1280 } = {}) {
  const context = await browser.newContext(width < 500
    ? { viewport: { width, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true }
    : { viewport: { width, height: 900 }, deviceScaleFactor: 1 });
  const db = { row, verify, options, usage, lookupUsage, checkouts: [], changes: [], usageCalls: 0, lookups: 0, dialogs: [], signups: [] };
  await context.addInitScript((signed) => {
    if (localStorage.getItem('__seeded')) return;
    localStorage.setItem('__seeded', '1');
    if (signed) localStorage.setItem('sb-xgrmbhmgcsbnazupfybd-auth-token', JSON.stringify({ access_token: 'tok', refresh_token: 'r', expires_at: Math.floor(Date.now() / 1000) + 3600, user: { id: 'user-1', email: 'pat@example.com' } }));
  }, signedIn);
  await context.route('**/*', async (route) => {
    const req = route.request();
    const url = req.url();
    const json = (b, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(b) });
    if (url.startsWith('https://checkout.stripe.com/')) return route.fulfill({ status: 200, contentType: 'text/html', body: '<title>Stripe Checkout</title><h1>Stripe Checkout</h1>' });
    if (url.startsWith('blob:') || (url.startsWith(base) && !url.includes('/.netlify/functions/'))) return route.continue();
    if (url.includes('/auth/v1/authorize')) return route.fulfill({ status: 200, contentType: 'text/html', body: '<h1>Google</h1>' });
    if (url.includes('/auth/v1/signup')) {
      db.signups.push(JSON.parse(req.postData() || '{}'));
      return json({ access_token: 'tok-new', refresh_token: 'r2', expires_in: 3600, user: { id: 'new-1', email: 'new@example.com' } });
    }
    if (url.includes('/.netlify/functions/plan-options')) return json(db.options);
    if (url.includes('/.netlify/functions/verify-pro')) return json(db.verify);
    if (url.includes('/.netlify/functions/create-checkout')) { db.checkouts.push(JSON.parse(req.postData() || '{}')); return json({ url: 'https://checkout.stripe.com/c/pay/cs_test_1' }); }
    if (url.includes('/.netlify/functions/change-plan')) {
      const b = JSON.parse(req.postData() || '{}');
      db.changes.push(b);
      db.verify = { ...db.verify, plan: b.plan, interval: b.interval || db.verify.interval };   // as change-plan records it
      return json({ status: 'ok', plan: b.plan, interval: b.interval || 'month', atRenewal: false, renewsAt: '2027-11-13T15:00:00Z' });
    }
    if (url.includes('/.netlify/functions/routes')) {
      const b = JSON.parse(req.postData() || '{}');
      if (b.usage === true) { db.usageCalls++; return json({ usage: db.usage }); }
      db.lookups++;
      return json({ routes: [{ distanceMeters: 690 * 1609.34, duration: '37800s', legs: [] }], usage: db.lookupUsage });
    }
    if (url.includes('/.netlify/functions/api-keys')) return json({ access: 'plan_required', keys: [] });
    if (url.includes('/.netlify/functions/team')) return json({ role: null, members: [], invites: [], size: 1 });
    if (url.includes('/.netlify/functions/')) return json({});
    if (url.includes('/rest/v1/rpc/my_account')) return json({ row: db.row, team: null });
    if (url.includes('/rest/v1/rpc/is_site_admin')) return json(false);
    if (url.includes('/rest/v1/pro_users')) {
      if (req.method() !== 'GET') return route.fulfill({ status: 201, body: '' });
      return json(db.row ? [db.row] : []);
    }
    if (url.includes('supabase.co')) return json([]);
    if (url.includes('fonts.googleapis.com') || url.includes('fonts.gstatic.com')) return route.continue();
    return route.abort();
  });
  return { context, db };
}
async function open(t, base, page) {
  const p = await t.context.newPage();
  const errors = [];
  p.on('pageerror', (e) => errors.push(e.message));
  p.on('dialog', (d) => { t.db.dialogs.push(d.message()); d.accept(); });
  await p.goto(base + page);
  return { p, errors };
}
const text = (pg, sel) => pg.$eval(sel, (e) => e.innerText.replace(/\s+/g, ' ').trim()).catch(() => '');

(async () => {
  const server = await serve();
  const base = `http://127.0.0.1:${server.address().port}`;
  const browser = await chromium.launch();
  let t, v;

  console.log('=== Sign-up page: monthly or yearly, and the free trial ===');
  t = await setup(browser, base, { signedIn: false, row: null });
  v = await open(t, base, '/signup.html');
  await v.p.waitForSelector('#su-interval:not([hidden])');
  const cols = () => v.p.$$eval('.su-plan', (els) => els.map((e) => ({ id: e.dataset.plan, price: e.querySelector('.su-price').innerText.replace(/\s+/g, ''),
    billing: e.querySelector('.su-billing').innerText.trim(), trial: e.querySelector('.su-trial').hidden ? '' : e.querySelector('.su-trial').textContent.trim(),
    start: e.querySelector('.su-start').innerText.trim() })));
  let c = await cols();
  check('monthly by default, with the monthly/yearly switch', c.map((x) => x.price).join() === '$9.99/month,$19.99/month,$49.99/month,$199.99/month', JSON.stringify(c));
  check('7-day free trial on Pro Plus and Pro Max (not Pro or API)', c.map((x) => x.trial).join('|') === '|7-day free trial|7-day free trial|'
    && c.map((x) => x.start).join('|') === 'Start now|Start free trial|Start free trial|Start now', JSON.stringify(c));
  await v.p.click('#su-interval .su-int[data-int="year"]');
  c = await cols();
  check('yearly: $99, $199 and $499 a year; API stays monthly', c.map((x) => x.price).join() === '$99/year,$199/year,$499/year,$199.99/month', JSON.stringify(c));
  check('…each with its monthly cost and what it saves', c[1].billing === '$16.58/mo, billed yearly · save $40.88' && c[0].billing === '$8.25/mo, billed yearly · save $20.88'
    && c[2].billing === '$41.58/mo, billed yearly · save $100.88' && c[3].billing === 'Monthly only · cancel anytime', JSON.stringify(c.map((x) => x.billing)));
  check('…on one line each', (await v.p.$$eval('.su-plan .su-billing', (els) => els.every((e) => e.getBoundingClientRect().height < 24))));
  await v.p.screenshot({ path: path.join(SHOTS, 'signup-yearly.png') });
  await v.p.click('.su-plan[data-plan="plus"] .su-start');
  await v.p.waitForTimeout(600);
  check('Pro Plus yearly picked: "Pro Plus $199/year · 7-day free trial"', (await text(v.p, '#su-selected-name')) === 'Pro Plus $199/year · 7-day free trial'
    && (await text(v.p, '#su-btn')) === 'Start my 7-day free trial →', await text(v.p, '#su-selected-name'));
  check('…and it says the card is charged only when the trial ends', /7-day free trial starts right away, and you're charged \$199\/year when it ends unless you cancel before then/.test(await text(v.p, '#su-side-note')),
    await text(v.p, '#su-side-note'));
  await v.p.fill('#su-email', 'new@example.com');
  await v.p.fill('#su-password', 'Abcdef1!x');
  await v.p.check('#su-agree');
  await v.p.click('#su-btn');
  await until(() => t.db.checkouts.length >= 1);
  check('signing up starts checkout for Pro Plus, billed yearly', t.db.checkouts[0] && t.db.checkouts[0].plan === 'plus' && t.db.checkouts[0].interval === 'year'
    && t.db.checkouts[0].userId === 'new-1', JSON.stringify(t.db.checkouts));
  await v.p.waitForURL('https://checkout.stripe.com/**', { timeout: 6000 }).catch(() => {});
  check('…and goes on to Stripe', v.p.url().startsWith('https://checkout.stripe.com/'), v.p.url());
  await t.context.close();

  t = await setup(browser, base, { signedIn: false, row: null });
  v = await open(t, base, '/signup.html?plan=max&interval=year');
  await v.p.waitForSelector('#su-interval:not([hidden])');
  await v.p.waitForTimeout(300);
  check('/signup.html?plan=max&interval=year: Pro Max yearly picked', (await text(v.p, '#su-selected-name')) === 'Pro Max $499/year · 7-day free trial');
  await v.p.check('#su-agree');
  await v.p.evaluate(() => handleGoogleAuth());
  await v.p.waitForTimeout(500);
  const kept = await t.context.newPage();
  await kept.goto(base + '/terms.html');
  const stored = await kept.evaluate(() => [localStorage.getItem('qfc_signup_plan'), localStorage.getItem('qfc_signup_interval')]);
  check('Google sign-up remembers the plan and the yearly billing through the redirect', stored.join() === 'max,year', stored.join());
  const terms = await kept.evaluate(() => [document.getElementById('yearly') && document.getElementById('yearly').innerText, document.getElementById('trial') && document.getElementById('trial').innerText]);
  check('Terms: yearly billing (charged up front, switching starts a new period, API monthly only)', /charged up front for the year/.test(terms[0]) && /The API plan is billed monthly only/.test(terms[0]) && /less credit for the unused part/.test(terms[0]), terms[0]);
  check('Terms: the free trial (never subscribed, 7 days, card charged when it ends, reminder, 100 a day, one per person)',
    /never had a subscription/.test(terms[1]) && /7 days/.test(terms[1]) && /reminder 3 days before/.test(terms[1]) && /100 quotes per day/.test(terms[1]) && /One free trial per person or business/.test(terms[1]), terms[1]);
  await t.context.close();

  t = await setup(browser, base, { signedIn: false, row: null, options: OPTIONS([]) });
  v = await open(t, base, '/signup.html?interval=year');
  await v.p.waitForTimeout(800);
  c = await cols();
  check('no yearly prices set up yet: no switch, monthly prices only', await v.p.isHidden('#su-interval') && c.map((x) => x.price).join() === '$9.99/month,$19.99/month,$49.99/month,$199.99/month'
    && c[1].billing === 'Billed monthly · cancel anytime' && (await v.p.evaluate(() => getSelectedInterval())) === 'month', JSON.stringify(c));
  check('no page errors on the sign-up page', v.errors.length === 0, v.errors.join(' | '));
  await t.context.close();

  t = await setup(browser, base, { signedIn: false, row: null, width: 390 });
  v = await open(t, base, '/signup.html');
  await v.p.waitForSelector('#su-interval:not([hidden])');
  await v.p.click('#su-interval .su-int[data-int="year"]');
  const wide = await v.p.evaluate(() => document.documentElement.scrollWidth - innerWidth);
  check('phone: the switch fits, no sideways scrolling', wide <= 1, `${wide}px`);
  await v.p.screenshot({ path: path.join(SHOTS, 'signup-yearly-phone.png') });
  await t.context.close();

  console.log('\n=== Calculator: the upgrade windows ===');
  t = await setup(browser, base, { row: FREE_ROW, verify: VERIFY({ active: false, paid: false, trialEligible: true, interval: null }), usage: { used: 2, limit: 5, plan: 'free', trial: false } });
  v = await open(t, base, '/index.html');
  await v.p.waitForFunction(() => typeof showUpgradeModal === 'function' && window.QFCPlans);
  await v.p.waitForTimeout(800);
  await v.p.evaluate(() => showUpgradeModal());
  await v.p.waitForSelector('#upg-billing:not([hidden])');
  await v.p.waitForFunction(() => /free trial/.test(document.getElementById('upg-modal-btn').textContent));
  check('a free account that never subscribed: "Start my 7-day free trial", then $19.99/month', (await text(v.p, '#upg-modal-btn')) === 'Start my 7-day free trial →'
    && (await text(v.p, '#upg-modal-billing')) === "Free for 7 days, then $19.99/month. Cancel before then and you won't be charged.", await text(v.p, '#upg-modal-billing'));
  await v.p.click('#upg-billing .upg-int[data-int="year"]');
  check('yearly in the upgrade window: $199/year and $499/year', (await text(v.p, '#upg-option-plus .upg-price')) === '$199/year' && (await text(v.p, '#upg-option-max .upg-price')) === '$499/year'
    && /then \$199\/year/.test(await text(v.p, '#upg-modal-billing')));
  await v.p.screenshot({ path: path.join(SHOTS, 'upgrade-trial-yearly.png') });
  await v.p.click('#upg-modal-btn');
  await until(() => t.db.checkouts.length >= 1);
  check('…starts checkout for Pro Plus, yearly', t.db.checkouts[0] && t.db.checkouts[0].plan === 'plus' && t.db.checkouts[0].interval === 'year', JSON.stringify(t.db.checkouts));
  await t.context.close();

  t = await setup(browser, base, { row: FREE_ROW, verify: VERIFY({ active: false, paid: false, trialEligible: true, interval: null }) });
  v = await open(t, base, '/index.html');
  await v.p.waitForFunction(() => typeof showProModal === 'function' && window.QFCPlans);
  await v.p.evaluate(() => showProModal());
  await v.p.waitForFunction(() => /Pro Plus free/.test(document.getElementById('pro-modal-more').textContent));
  check('the Pro window: $9.99/month or $99/year, and "Or try Pro Plus free for 7 days"', /\$9\.99\/month or \$99\/year/.test(await text(v.p, '#pro-modal-price'))
    && (await text(v.p, '#pro-modal-more')) === 'Or try Pro Plus free for 7 days →', await text(v.p, '#pro-modal-price'));
  await v.p.evaluate(() => closeProModal());

  console.log('\n=== Grayed-out previews ===');
  await v.p.waitForSelector('#quote-log-gate .qf-lp-card');
  await v.p.waitForSelector('#quote-log-gate .qf-lp-trial:not([hidden])');
  check('free account: the quote log as a grayed-out preview with made-up quotes, marked Pro',
    (await v.p.textContent('#quote-log-gate .qf-lp-badge')).trim() === 'Pro' && (await text(v.p, '#quote-log-gate .qf-lp-title')) === 'Your quote log'
    && (await v.p.$$eval('#quote-log-gate .ql-sample tbody tr', (r) => r.length)) === 4
    && (await v.p.getAttribute('#quote-log-gate .qf-lp-sample', 'aria-hidden')) === 'true');
  check('…with "Get Pro" and "Try Pro Plus free for 7 days"', (await text(v.p, '#quote-log-gate .qf-lp-main')) === 'Get Pro'
    && (await text(v.p, '#quote-log-gate .qf-lp-trial')) === 'Try Pro Plus free for 7 days');
  await v.p.locator('#quote-log-card').screenshot({ path: path.join(SHOTS, 'preview-quote-log.png') });
  await v.p.click('#quote-log-gate .qf-lp-main');
  check('"Get Pro" opens the Pro window', await v.p.isVisible('#pro-modal-overlay'));
  await v.p.evaluate(() => closeProModal());
  await v.p.click('#quote-log-gate .qf-lp-trial');
  check('the trial button opens the upgrade window on Pro Plus, as a free trial', await v.p.isVisible('#upg-modal-overlay') && (await v.p.isChecked('#upg-option-plus input'))
    && /free trial/.test(await text(v.p, '#upg-modal-btn')));
  check('no page errors on the calculator (free account)', v.errors.length === 0, v.errors.join(' | '));
  await t.context.close();

  t = await setup(browser, base, { row: FREE_ROW, verify: VERIFY({ active: false, paid: false, trialEligible: false, interval: null }) });
  v = await open(t, base, '/index.html');
  await v.p.waitForSelector('#quote-log-gate .qf-lp-card');
  await v.p.waitForTimeout(800);
  check('had a subscription before: no free trial offered on the preview', await v.p.isHidden('#quote-log-gate .qf-lp-trial'));
  await v.p.evaluate(() => showUpgradeModal());
  await v.p.waitForTimeout(500);
  check('…nor in the upgrade window: "Upgrade to Pro Plus", $19.99/month', (await text(v.p, '#upg-modal-btn')) === 'Upgrade to Pro Plus →'
    && (await text(v.p, '#upg-modal-billing')) === '$19.99/month · Cancel anytime', await text(v.p, '#upg-modal-billing'));
  await t.context.close();

  t = await setup(browser, base);
  v = await open(t, base, '/index.html');
  await v.p.waitForFunction(() => typeof isProUser !== 'undefined' && isProUser === true && window.QFCPlans);
  await v.p.evaluate(() => showUpgradeModal(null, ['plus', 'max']));
  await v.p.waitForTimeout(600);
  check('a subscriber: no billing switch (their billing stays), charged the prorated difference', await v.p.isHidden('#upg-billing')
    && (await text(v.p, '#upg-modal-billing')) === "You're charged the prorated difference today · Cancel anytime" && (await text(v.p, '#upg-modal-btn')) === 'Upgrade to Pro Plus →');
  await v.p.click('#upg-modal-btn');
  await until(() => t.db.changes.length >= 1);
  check('…and the switch keeps their billing (no interval sent)', t.db.changes[0] && t.db.changes[0].plan === 'plus' && !('interval' in t.db.changes[0]), JSON.stringify(t.db.changes));
  await v.p.evaluate(() => closeUpgradeModal());

  console.log('\n=== The usage meter ===');
  await v.p.waitForSelector('#qf-usage:not([hidden])');
  check('signed in: today\'s count when the page opens (42 of 100)', (await text(v.p, '#qf-usage .qf-usage-text')) === 'Quotes with automatic miles today: 42 of 100'
    && t.db.usageCalls === 1 && !(await v.p.$('#qf-usage .qf-usage-up')));
  check('…the bar at 42%', parseFloat(await v.p.$eval('#qf-usage .qf-usage-bar > span', (e) => e.style.width)) === 42);
  t.db.lookupUsage = { used: 85, limit: 100, plan: 'pro', trial: false, team: false };
  await v.p.evaluate(async () => {
    const set = (id, val) => { document.getElementById(id).value = val; };
    set('origin', 'Lancaster, PA'); set('dest', 'Atlanta, GA'); set('weight', 40000);
    await tryLookupMiles();
  });
  await v.p.waitForFunction(() => /85 of 100/.test(document.getElementById('qf-usage').textContent));
  check('after a lookup: 85 of 100, nearly used up, with "Get 250 a day with Pro Plus"', t.db.lookups >= 1 && (await v.p.$eval('#qf-usage', (e) => e.classList.contains('near')))
    && (await text(v.p, '#qf-usage .qf-usage-up')) === 'Get 250 a day with Pro Plus');
  await v.p.locator('#qf-usage').screenshot({ path: path.join(SHOTS, 'meter-near.png') });
  await v.p.click('#qf-usage .qf-usage-up');
  check('…which opens the upgrade window', await v.p.isVisible('#upg-modal-overlay') && await v.p.isVisible('#upg-option-plus'));
  await v.p.evaluate(() => closeUpgradeModal());
  const meterAs = async (u) => { await v.p.evaluate((x) => QFCPlans.meter.update(x), u); return [await text(v.p, '#qf-usage'), await v.p.isHidden('#qf-usage'), await v.p.$eval('#qf-usage', (e) => e.className)]; };
  let m = await meterAs({ used: 100, limit: 100, plan: 'pro', trial: false });
  check('used up: shown in red', /full/.test(m[2]) && /100 of 100/.test(m[0]));
  m = await meterAs({ used: 240, limit: 250, plan: 'plus', trial: false });
  check('Pro Plus near its 250: "Get 1,000 a day with Pro Max"', /Get 1,000 a day with Pro Max/.test(m[0]));
  m = await meterAs({ used: 95, limit: 100, plan: 'max', trial: true });
  check('on a free trial: "Free trial · …: 95 of 100", nothing to upgrade to', m[0] === 'Free trial · quotes with automatic miles today: 95 of 100');
  m = await meterAs({ used: 990, limit: 1000, plan: 'max', trial: false, team: true });
  check('a team: "Your team’s quotes …", no upgrade at the top plan', m[0] === 'Your team’s quotes with automatic miles today: 990 of 1,000');
  m = await meterAs({ used: null, limit: null, plan: 'pro' });
  check('no daily limit (comp or original plan): no meter', m[1] === true);
  check('no page errors on the calculator (subscriber)', v.errors.length === 0, v.errors.join(' | '));
  await t.context.close();

  t = await setup(browser, base, { signedIn: false, row: null, lookupUsage: { used: 3, limit: 5, plan: 'free', trial: false } });
  v = await open(t, base, '/index.html');
  await v.p.waitForFunction(() => typeof tryLookupMiles === 'function' && window.QFCPlans);
  await v.p.waitForTimeout(600);
  check('not signed in: nothing asked on load, no meter yet', t.db.usageCalls === 0 && await v.p.isHidden('#qf-usage'));
  await v.p.evaluate(async () => {
    document.getElementById('origin').value = 'Lancaster, PA'; document.getElementById('dest').value = 'Atlanta, GA';
    await tryLookupMiles();
  });
  await v.p.waitForSelector('#qf-usage:not([hidden])');
  check('after a lookup: "Free quotes with automatic miles today: 3 of 5" and "Get 100 a day with Pro"',
    (await text(v.p, '#qf-usage .qf-usage-text')) === 'Free quotes with automatic miles today: 3 of 5' && (await text(v.p, '#qf-usage .qf-usage-up')) === 'Get 100 a day with Pro');
  await v.p.click('#qf-usage .qf-usage-up');
  check('…which opens the Pro window', await v.p.isVisible('#pro-modal-overlay'));
  await t.context.close();

  for (const page of ['/multistop.html', '/bulk.html']) {
    t = await setup(browser, base);
    v = await open(t, base, page);
    const shown = await v.p.waitForSelector('#qf-usage:not([hidden])', { timeout: 8000 }).then(() => true, () => false);
    check(`${page.slice(1, -5)}: the meter shows today's count`, shown && (await text(v.p, '#qf-usage .qf-usage-text')) === 'Quotes with automatic miles today: 42 of 100');
    check(`no page errors on ${page.slice(1, -5)}`, v.errors.length === 0, v.errors.join(' | '));
    await t.context.close();
  }

  t = await setup(browser, base, { width: 390 });
  v = await open(t, base, '/index.html');
  await v.p.waitForSelector('#qf-usage:not([hidden])');
  const meterFits = await v.p.evaluate(() => { const r = document.getElementById('qf-usage').getBoundingClientRect(); return r.left >= 0 && r.right <= innerWidth && document.documentElement.scrollWidth <= innerWidth; });
  check('phone: the meter fits', meterFits);
  await t.context.close();

  console.log('\n=== Profile: monthly or yearly, and the free trial ===');
  t = await setup(browser, base, { row: ROW({ plan: 'plus' }), verify: VERIFY({ plan: 'plus' }) });
  v = await open(t, base, '/profile.html');
  await v.p.waitForFunction(() => getComputedStyle(document.getElementById('sub-interval-select')).display !== 'none', null, { timeout: 8000 }).catch(() => {});
  const opts = await v.p.$$eval('#sub-interval-select option', (o) => o.map((x) => x.textContent));
  check('Pro Plus monthly: a billing menu with both prices', opts.join(' | ') === 'Billed monthly · $19.99/month | Billed yearly · $199/year'
    && (await v.p.$eval('#sub-interval-select', (e) => e.value)) === 'month' && /^\$19\.99\/month · /.test(await text(v.p, '#sub-plan-detail')), opts.join(' | '));
  await v.p.selectOption('#sub-interval-select', 'year');
  await v.p.click('#sub-plan-switch');
  await until(() => t.db.changes.length >= 1);
  check('switching to yearly asks first: $199 today, less the unused month', /^Switch to yearly billing, \$199\/year\?/.test(t.db.dialogs[0] || '') && /charged \$199 today, less credit for the unused part of this month/.test(t.db.dialogs[0] || ''),
    t.db.dialogs[0]);
  check('…then switches: Pro Plus, yearly', t.db.changes[0] && t.db.changes[0].plan === 'plus' && t.db.changes[0].interval === 'year', JSON.stringify(t.db.changes));
  await v.p.waitForFunction(() => /\$199\/year/.test(document.getElementById('sub-plan-status').textContent));
  check('…and shows it: "You\'re on Pro Plus, $199/year", detail $199/year', /You're on Pro Plus, \$199\/year\./.test(await text(v.p, '#sub-plan-status')) && /^\$199\/year · /.test(await text(v.p, '#sub-plan-detail')));
  await v.p.locator('#subscription-paid').screenshot({ path: path.join(SHOTS, 'profile-yearly.png') });
  await v.p.selectOption('#sub-plan-select', 'api');
  check('the API plan is monthly only: no billing menu for it', await v.p.isHidden('#sub-interval-select'));
  check('no page errors on Profile', v.errors.length === 0, v.errors.join(' | '));
  await t.context.close();

  t = await setup(browser, base, { row: ROW({ plan: 'plus' }), verify: VERIFY({ plan: 'plus', trialEndsAt: '2026-11-27T15:00:00Z' }) });
  v = await open(t, base, '/profile.html');
  await v.p.waitForFunction(() => /free trial ends/.test(document.getElementById('sub-plan-legacy').textContent), null, { timeout: 8000 }).catch(() => {});
  check('on a free trial: the end date and what will be charged then', (await text(v.p, '#sub-plan-name')) === 'QuickFreightCalc Pro Plus · free trial'
    && (await text(v.p, '#sub-plan-legacy')) === 'Your free trial ends on November 27, 2026. Unless you cancel before then, your card will be charged $19.99/month that day.', await text(v.p, '#sub-plan-legacy'));
  await v.p.selectOption('#sub-plan-select', 'max');
  await v.p.click('#sub-plan-switch');
  await until(() => t.db.changes.length >= 1);
  check('changing plans on the trial: nothing charged now, the trial runs to Nov 27', /^Switch to Pro Max, \$49\.99\/month\?/.test(t.db.dialogs[0] || '')
    && /Nothing is charged now\. Your free trial continues until November 27, 2026; then it's \$49\.99\/month\./.test(t.db.dialogs[0] || ''), t.db.dialogs[0]);
  await t.context.close();

  t = await setup(browser, base, { row: ROW({ plan: 'max' }), verify: VERIFY({ plan: 'max', interval: 'year' }) });
  v = await open(t, base, '/profile.html');
  await v.p.waitForFunction(() => /^\$499\/year/.test(document.getElementById('sub-plan-detail').textContent), null, { timeout: 8000 }).catch(() => {});
  check('billed yearly: $499/year, the menu on yearly', /^\$499\/year · /.test(await text(v.p, '#sub-plan-detail')) && (await v.p.$eval('#sub-interval-select', (e) => e.value)) === 'year');
  await t.context.close();

  t = await setup(browser, base, { row: ROW({ grandfathered: true }), verify: VERIFY({ unlimitedUntilRenewal: true, nextPlan: 'pro' }) });
  v = await open(t, base, '/profile.html');
  await v.p.waitForFunction(() => /original plan/.test(document.getElementById('sub-plan-name').textContent), null, { timeout: 8000 }).catch(() => {});
  await v.p.waitForTimeout(400);
  check('original plan: no billing menu (yearly comes after the January move)', await v.p.isHidden('#sub-interval-select'));
  await t.context.close();

  t = await setup(browser, base, { row: ROW({ plan: 'plus' }), verify: VERIFY({ plan: 'plus' }), options: OPTIONS([]) });
  v = await open(t, base, '/profile.html');
  await v.p.waitForTimeout(1500);
  check('yearly prices not set up yet: no billing menu', await v.p.isHidden('#sub-interval-select'));
  await t.context.close();

  await browser.close();
  server.close();
  console.log(`\nScreenshots in ${SHOTS}`);
  console.log(failures ? `\n${failures} UPGRADE TEST(S) FAILED` : '\nALL UPGRADE TESTS PASSED');
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
