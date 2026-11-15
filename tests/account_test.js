// tests/account_test.js — accounts without an active plan (a sign-up that never reached payment,
// or a subscription that ended), the email printed on quotes, and the quote counter on Profile.
// In a real browser (needs Playwright with Chromium); Supabase, Stripe and the functions are
// fakes. Run from the repository root:
//   node tests/account_test.js [folder for screenshots]
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { chromium } = require('playwright');
const ROOT = path.resolve(__dirname, '..');
const SHOTS = process.argv[2] || fs.mkdtempSync(path.join(os.tmpdir(), 'qfc-account-'));
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
const OPTIONS = { yearly: ['pro', 'plus', 'max'], prices: PRICES, trial: { days: 7, plans: ['plus', 'max'], dailyLimit: 100 } };
const ROW = (o) => Object.assign({ id: 'user-1', email: 'pat@example.com', company_name: 'Morgan Freight', contact_name: 'Pat Morgan', is_active: true, plan: 'pro',
  stripe_customer_id: 'cus_1', stripe_subscription_id: 'sub_1', grandfathered: false, quote_prefix: 'MF', quote_counter: 1001, contact_email: null }, o);
// Signed up, never paid: no Stripe customer, not active (what create-checkout leaves behind).
const UNPAID = ROW({ is_active: false, stripe_customer_id: null, stripe_subscription_id: null });
// A subscription that ended (or whose payment failed): still a Stripe customer, not active.
const ENDED = ROW({ is_active: false });
const COMP = ROW({ plan: 'max', stripe_customer_id: null, stripe_subscription_id: null });
const VERIFY = (o) => Object.assign({ active: true, plan: 'pro', paid: true, unlimitedUntilRenewal: false, nextPlan: null, planChosen: false, cancelAt: null,
  interval: 'month', trialEndsAt: null, trialEligible: false, renewsAt: null, team: null }, o);
const NO_PLAN = (o) => VERIFY(Object.assign({ active: false, paid: false, interval: null, trialEligible: true }, o));

async function setup(browser, base, { signedIn = true, row = ROW(), verify = VERIFY(), local = null, checkout = null } = {}) {
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const db = { row, verify, checkout, checkouts: [], patches: [], logins: [], proLookups: 0 };
  await context.addInitScript(([signed, local]) => {
    if (localStorage.getItem('__seeded')) return;
    localStorage.setItem('__seeded', '1');
    if (signed) localStorage.setItem('sb-xgrmbhmgcsbnazupfybd-auth-token', JSON.stringify({ access_token: 'tok', refresh_token: 'r',
      expires_at: Math.floor(Date.now() / 1000) + 3600, user: { id: 'user-1', email: 'pat@example.com' } }));
    if (local) Object.entries(local).forEach(([k, v]) => localStorage.setItem(k, JSON.stringify(v)));
  }, [signedIn, local]);
  await context.route('**/*', async (route) => {
    const req = route.request();
    const url = req.url();
    const json = (b, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(b) });
    if (url.startsWith('https://checkout.stripe.com/')) return route.fulfill({ status: 200, contentType: 'text/html', body: '<title>Stripe Checkout</title><h1>Stripe Checkout</h1>' });
    if (url.startsWith('blob:') || (url.startsWith(base) && !url.includes('/.netlify/functions/'))) return route.continue();
    if (url.includes('/auth/v1/token')) {
      db.logins.push(JSON.parse(req.postData() || '{}'));
      return json({ access_token: 'tok', refresh_token: 'r', expires_in: 3600, user: { id: 'user-1', email: 'pat@example.com' } });
    }
    if (url.includes('/.netlify/functions/plan-options')) return json(OPTIONS);
    if (url.includes('/.netlify/functions/verify-pro')) return json(db.verify);
    if (url.includes('/.netlify/functions/create-checkout')) {
      db.checkouts.push(JSON.parse(req.postData() || '{}'));
      return db.checkout ? json(db.checkout.body, db.checkout.status) : json({ url: 'https://checkout.stripe.com/c/pay/cs_test_1' });
    }
    if (url.includes('/.netlify/functions/routes')) return json({ usage: { used: 0, limit: 5, plan: 'free', trial: false } });
    if (url.includes('/.netlify/functions/api-keys')) return json({ access: 'plan_required', keys: [] });
    if (url.includes('/.netlify/functions/team')) return json({ role: null, members: [], invites: [], size: 1 });
    if (url.includes('/.netlify/functions/')) return json({});
    if (url.includes('/rest/v1/rpc/my_account')) return json({ row: db.row, team: null });
    if (url.includes('/rest/v1/rpc/is_site_admin')) return json(false);
    if (url.includes('/rest/v1/pro_users')) {
      if (req.method() === 'PATCH') { db.patches.push(JSON.parse(req.postData() || '{}')); return route.fulfill({ status: 204, body: '' }); }
      if (req.method() !== 'GET') return route.fulfill({ status: 201, body: '' });
      db.proLookups++;
      return json(db.row ? [db.row] : []);
    }
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
const text = (pg, sel) => pg.$eval(sel, (e) => e.innerText.replace(/\s+/g, ' ').trim()).catch(() => '');
const shown = (pg, sel) => pg.$eval(sel, (e) => !!(e.offsetWidth || e.offsetHeight || e.getClientRects().length)).catch(() => false);
const cards = (pg) => pg.evaluate(() => Object.fromEntries(['subscription-paid', 'subscription-comp', 'subscription-none', 'subscription-none-billing']
  .map((id) => { const e = document.getElementById(id); return [id.replace('subscription-', '').replace('none-', ''), !!(e && e.offsetParent !== null)]; })));
const profileReady = (pg) => pg.waitForFunction(() => ['subscription-paid', 'subscription-comp', 'subscription-none']
  .some((id) => { const e = document.getElementById(id); return e && e.style.display !== 'none'; }), null, { timeout: 8000 }).catch(() => {});

(async () => {
  const server = await serve();
  const base = `http://127.0.0.1:${server.address().port}`;
  const browser = await chromium.launch();
  let t, c;

  // ── Profile: which plan card ────────────────────────────────────────────
  console.log('\n=== Profile: the plan card for each kind of account ===');
  t = await setup(browser, base, { row: UNPAID, verify: NO_PLAN() });
  await t.page.goto(base + '/profile.html');
  await profileReady(t.page);
  c = await cards(t.page);
  check('signed up but never paid: "No active plan" (not "Comp account · Active")', c.none && !c.comp && !c.paid && !c.billing, JSON.stringify(c));
  check('…with a way to pick a plan', (await t.page.$eval('#subscription-none .plan-cta', (a) => a.getAttribute('href')).catch(() => null)) === '/signup.html'
    && /You don't have an active plan/.test(await text(t.page, '#subscription-none')));
  check('…and the page’s Save button is still the only .save-btn', (await t.page.$$('.save-btn')).length === 1);
  await t.page.locator('#subscription-none').screenshot({ path: path.join(SHOTS, 'profile-no-plan.png') }).catch(() => {});
  check('no page errors', t.errors.length === 0, t.errors.join(' | '));
  await t.context.close();

  t = await setup(browser, base, { row: ENDED, verify: NO_PLAN({ paid: true, trialEligible: false }) });
  await t.page.goto(base + '/profile.html#subscription-paid');
  await profileReady(t.page);
  await t.page.waitForTimeout(300);
  c = await cards(t.page);
  check('a subscription that ended (or a payment that failed): "No active plan", plus Manage billing', c.none && c.billing && !c.paid && !c.comp, JSON.stringify(c));
  const top = await t.page.$eval('#subscription-none', (e) => Math.round(e.getBoundingClientRect().top));
  check('a link to the plan section lands on that card', top >= -5 && top < 300, String(top));
  await t.context.close();

  t = await setup(browser, base, { row: COMP, verify: VERIFY({ plan: 'max', paid: false }) });
  await t.page.goto(base + '/profile.html');
  await profileReady(t.page);
  c = await cards(t.page);
  check('a comp account stays comp', c.comp && !c.none && !c.paid, JSON.stringify(c));
  await t.context.close();

  t = await setup(browser, base);
  await t.page.goto(base + '/profile.html');
  await profileReady(t.page);
  c = await cards(t.page);
  check('a paying subscriber keeps the subscription card', c.paid && !c.none && !c.comp, JSON.stringify(c));
  await t.context.close();

  // ── Sign-up page, signed in without a plan ──────────────────────────────
  console.log('\n=== Pricing page: signed in, no plan, free trial available ===');
  t = await setup(browser, base, { row: UNPAID, verify: NO_PLAN() });
  await t.page.goto(base + '/signup.html');
  await t.page.waitForFunction(() => document.body.classList.contains('su-no-plan'));
  await t.page.waitForFunction(() => !document.getElementById('su-interval').hidden);
  await t.page.waitForTimeout(300);
  const starts = () => t.page.$$eval('.su-plan .su-start', (els) => els.map((e) => e.textContent.trim()).join('|'));
  check('the plans read as for a new visitor: Start now / Start free trial', (await starts()) === 'Start now|Start free trial|Start free trial|Start now', await starts());
  check('…not "Switch on Profile", and no plan is marked "Your plan"', !(await t.page.$$eval('.su-chip', (els) => els.some((e) => e.textContent === 'Your plan'))));
  check('the side card says to finish signing up', (await text(t.page, '.su-side h2')) === 'Finish signing up' && /Pick a plan to finish signing up/.test(await text(t.page, '#su-card')));
  await t.page.click('.su-plan[data-plan="plus"]');
  check('picking Pro Plus: "Start my 7-day free trial →"', (await text(t.page, '#su-checkout')) === 'Start my 7-day free trial →', await text(t.page, '#su-checkout'));
  await t.page.click('.su-plan[data-plan="pro"]');
  check('picking Pro: "Continue to checkout for Pro →"', (await text(t.page, '#su-checkout')) === 'Continue to checkout for Pro →', await text(t.page, '#su-checkout'));
  await t.page.click('#su-interval .su-int[data-int="year"]');
  await t.page.click('.su-plan[data-plan="max"] .su-start');
  await until(() => t.db.checkouts.length >= 1);
  const co = t.db.checkouts[0] || {};
  check('Start free trial on Pro Max, yearly, goes straight to checkout for that plan and billing',
    co.plan === 'max' && co.interval === 'year' && co.userId === 'user-1' && co.email === 'pat@example.com' && co.accessToken === 'tok', JSON.stringify(co));
  await t.page.waitForURL('https://checkout.stripe.com/**', { timeout: 6000 }).catch(() => {});
  check('…on to Stripe', t.page.url().startsWith('https://checkout.stripe.com/'), t.page.url());
  check('no page errors', t.errors.length === 0, t.errors.join(' | '));
  await t.context.close();

  console.log('\n=== Pricing page: no plan, trial already used ===');
  t = await setup(browser, base, { row: ENDED, verify: NO_PLAN({ paid: true, trialEligible: false }) });
  await t.page.goto(base + '/signup.html?plan=max');
  await t.page.waitForFunction(() => document.body.classList.contains('su-no-plan'));
  await t.page.waitForTimeout(500);
  check('no trial offered: Start now on every plan', (await starts()) === 'Start now|Start now|Start now|Start now', await starts());
  check('the plan from the link is picked: "Continue to checkout for Pro Max →"', (await text(t.page, '#su-checkout')) === 'Continue to checkout for Pro Max →', await text(t.page, '#su-checkout'));
  t.db.checkout = { status: 409, body: { error: 'payment_issue', status: 'past_due',
    message: 'Your subscription is still open, but its last payment didn’t go through. Update your card under Manage billing on your Profile page to keep it.' } };
  await t.page.click('#su-checkout');
  await until(() => t.db.checkouts.length >= 1);
  await t.page.waitForTimeout(300);
  check('an earlier subscription still open (failed payment): says so, links to Profile, no Stripe page', /last payment didn’t go through/.test(await text(t.page, '#su-checkout-msg'))
    && (await t.page.$eval('#su-checkout-msg a', (a) => a.getAttribute('href')).catch(() => '')) === '/profile.html#subscription-none'
    && t.page.url().startsWith(base) && !(await t.page.$eval('#su-checkout', (b) => b.disabled)), await text(t.page, '#su-checkout-msg'));
  await t.context.close();

  console.log('\n=== Pricing page: this browser still thinks the plan is active ===');
  t = await setup(browser, base, { row: UNPAID, verify: NO_PLAN(), local: { qfc_pro_status: { isActive: true, userId: 'user-1' }, qfc_pro_profile: { plan: 'plus' } } });
  await t.page.goto(base + '/signup.html');
  await t.page.waitForFunction(() => document.body.classList.contains('su-no-plan'), null, { timeout: 6000 }).catch(() => {});
  check('the server’s answer wins: shown as no plan, with checkout', await t.page.evaluate(() => document.body.classList.contains('su-no-plan'))
    && await shown(t.page, '#su-checkout'));
  await t.context.close();

  console.log('\n=== Pricing page: a subscriber ===');
  t = await setup(browser, base, { verify: VERIFY({ plan: 'plus' }), row: ROW({ plan: 'plus' }), local: { qfc_pro_status: { isActive: true, userId: 'user-1' }, qfc_pro_profile: { plan: 'plus' } } });
  await t.page.goto(base + '/signup.html');
  await t.page.waitForFunction(() => document.body.classList.contains('su-signed-in'));
  await t.page.waitForTimeout(600);
  check('a subscriber still manages plans on Profile', !(await t.page.evaluate(() => document.body.classList.contains('su-no-plan')))
    && (await starts()) === 'Switch on Profile|Manage on Profile|Switch on Profile|Switch on Profile', await starts());
  await t.page.click('.su-plan[data-plan="max"] .su-start');
  await t.page.waitForURL('**/profile.html**', { timeout: 5000 }).catch(() => {});
  check('…and never starts a second checkout', t.db.checkouts.length === 0 && /\/profile\.html/.test(t.page.url()), t.page.url());
  await t.context.close();

  t = await setup(browser, base, { verify: VERIFY({ plan: 'max' }), row: ROW({ plan: 'max' }) });
  await t.page.goto(base + '/signup.html');
  await t.page.waitForTimeout(1200);
  check('this browser had no plan saved, the server says Pro Max: shown as a subscriber', !(await t.page.evaluate(() => document.body.classList.contains('su-no-plan')))
    && (await starts()) === 'Switch on Profile|Switch on Profile|Manage on Profile|Switch on Profile', await starts());
  await t.context.close();

  // ── Arriving from a paid page, or back from a cancelled checkout ───────
  console.log('\n=== Arriving from a paid page ===');
  t = await setup(browser, base, { row: UNPAID, verify: NO_PLAN() });
  await t.page.goto(base + '/signup.html?reason=pro-required');
  await t.page.waitForFunction(() => document.body.classList.contains('su-no-plan'), null, { timeout: 6000 }).catch(() => {});
  check('signed in with no plan: the plans, and why you’re here', await t.page.evaluate(() => document.body.classList.contains('su-no-plan') && !document.body.classList.contains('su-auth-only'))
    && /That page comes with a paid plan\./.test(await text(t.page, '#su-card')), await text(t.page, '#su-card'));
  await t.context.close();

  t = await setup(browser, base, { signedIn: false, row: null });
  await t.page.goto(base + '/signup.html?reason=pro-required');
  await t.page.waitForTimeout(500);
  check('signed out: the sign-in form says the page needs a plan', await shown(t.page, '#error-msg') && await shown(t.page, '#form-login')
    && (await text(t.page, '#error-msg')) === 'That page comes with a paid plan. Sign in, or see plans & pricing below to sign up.', await text(t.page, '#error-msg'));
  check('…with the link to the plans', await shown(t.page, '.su-auth-plans a'));
  await t.context.close();

  t = await setup(browser, base, { signedIn: false, row: null });
  await t.page.goto(base + '/signup.html?checkout=cancelled');
  await t.page.waitForTimeout(500);
  check('back from a cancelled checkout: "nothing was charged" shows', await shown(t.page, '#error-msg') && /Checkout cancelled, and nothing was charged/.test(await text(t.page, '#error-msg')),
    await text(t.page, '#error-msg'));
  await t.context.close();

  // ── Signing in without a plan ───────────────────────────────────────────
  console.log('\n=== Signing in with no plan ===');
  t = await setup(browser, base, { signedIn: false, row: UNPAID, verify: NO_PLAN() });
  await t.page.goto(base + '/signup.html?login');
  await t.page.fill('#li-email', 'pat@example.com');
  await t.page.fill('#li-password', 'Abcdef1!x');
  await t.page.click('#li-btn');
  await t.page.waitForFunction(() => document.body.classList.contains('su-no-plan'), null, { timeout: 6000 }).catch(() => {});
  await t.page.waitForTimeout(600);
  check('signing in shows the plans to choose from (no checkout nobody picked)', t.db.checkouts.length === 0
    && await t.page.evaluate(() => document.body.classList.contains('su-no-plan')) && await shown(t.page, '#su-plans'), JSON.stringify(t.db.checkouts));
  check('…and the sign-in button is ready again', (await text(t.page, '#li-btn')) === 'Sign In' || !(await shown(t.page, '#li-btn')));
  await t.page.screenshot({ path: path.join(SHOTS, 'signin-no-plan.png') });
  check('no page errors', t.errors.length === 0, t.errors.join(' | '));
  await t.context.close();

  t = await setup(browser, base, { signedIn: false, row: UNPAID, verify: NO_PLAN() });
  await t.page.goto(base + '/signup.html?login&plan=max');
  await t.page.fill('#li-email', 'pat@example.com');
  await t.page.fill('#li-password', 'Abcdef1!x');
  await t.page.click('#li-btn');
  await until(() => t.db.checkouts.length >= 1);
  check('signing in from a plan link (?plan=max) continues to checkout for that plan', t.db.checkouts[0] && t.db.checkouts[0].plan === 'max', JSON.stringify(t.db.checkouts));
  await t.context.close();

  // ── Profile: the email on quotes, and the quote counter ─────────────────
  console.log('\n=== Profile: email on quotes ===');
  t = await setup(browser, base, { row: ROW({ contact_email: null }) });
  await t.page.goto(base + '/profile.html');
  await t.page.waitForFunction(() => document.getElementById('contact-email').value !== '');
  check('no quote email set: the box shows your sign-in email', (await t.page.inputValue('#contact-email')) === 'pat@example.com');
  check('…labeled as the email on quotes', (await t.page.$eval('label[for="contact-email"]', (e) => e.textContent.trim())) === 'Email on quotes');
  await t.page.fill('#contact-email', 'quotes@morgan.example');
  await t.page.click('.save-btn');
  await until(() => t.db.patches.length >= 1);
  check('Save sends it to the account (contact_email)', t.db.patches[0] && t.db.patches[0].contact_email === 'quotes@morgan.example', JSON.stringify(t.db.patches[0]));
  check('…and the PDFs in this browser use it', await t.page.evaluate(() => JSON.parse(localStorage.getItem('qfc_pro_profile')).email) === 'quotes@morgan.example');
  await t.page.fill('#contact-email', '');
  await t.page.click('.save-btn');
  await until(() => t.db.patches.length >= 2);
  check('clearing it saves none (quotes print the sign-in email)', t.db.patches[1] && t.db.patches[1].contact_email === null, JSON.stringify(t.db.patches[1]));
  await t.context.close();

  t = await setup(browser, base, { row: ROW({ contact_email: 'quotes@morgan.example' }) });
  await t.page.goto(base + '/profile.html');
  await t.page.waitForFunction(() => document.getElementById('contact-email').value !== '');
  check('it comes back after a reload', (await t.page.inputValue('#contact-email')) === 'quotes@morgan.example');
  await t.context.close();

  console.log('\n=== Profile: the quote counter ===');
  t = await setup(browser, base, { row: ROW({ quote_counter: 1001 }), local: { qfc_pro_profile: { quoteStart: 1009, quotePrefix: 'MF' } } });
  await t.page.goto(base + '/profile.html');
  await t.page.waitForFunction(() => document.getElementById('quote-start').value !== '');
  await t.page.waitForTimeout(300);
  check('PDFs made in this browser moved the counter to 1009: Profile shows 1009, not the account’s 1001', (await t.page.inputValue('#quote-start')) === '1009',
    await t.page.inputValue('#quote-start'));
  await t.page.click('.save-btn');
  await until(() => t.db.patches.length >= 1);
  check('…and saving keeps 1009 (never back to a used number)', t.db.patches[0] && t.db.patches[0].quote_counter === 1009, JSON.stringify(t.db.patches[0] && t.db.patches[0].quote_counter));
  await t.context.close();

  t = await setup(browser, base, { row: ROW({ quote_counter: 1020 }), local: { qfc_pro_profile: { quoteStart: 1009 } } });
  await t.page.goto(base + '/profile.html');
  await t.page.waitForFunction(() => document.getElementById('quote-start').value !== '');
  await t.page.waitForTimeout(300);
  check('another device got further (1020): Profile shows 1020', (await t.page.inputValue('#quote-start')) === '1020', await t.page.inputValue('#quote-start'));
  await t.context.close();

  await browser.close();
  server.close();
  console.log(`\nScreenshots: ${SHOTS}`);
  console.log(failures ? `\n${failures} FAILED` : '\nALL PASS');
  process.exit(failures ? 1 : 0);
})();
