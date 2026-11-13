// tests/site_test.js — the shared look (site.js / site.css): navigation,
// account menu, light/dark, footer; the Market Rates page (map, tooltip,
// region table, history chart, equipment switch); the plan columns on the
// signup page; and the calculator's national rates. In a real browser (needs
// Playwright with Chromium); network calls other than this site are stubbed.
// Run from the repository root:
//   node tests/site_test.js [folder for screenshots]
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { chromium } = require('playwright');
const ROOT = path.resolve(__dirname, '..');
const SHOTS = process.argv[2] || fs.mkdtempSync(path.join(os.tmpdir(), 'qfc-site-'));
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.json': 'application/json', '.css': 'text/css' };
const RATES = JSON.parse(fs.readFileSync(path.join(ROOT, 'rates.json'), 'utf8'));
let failures = 0;
const check = (label, cond, detail) => { console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}${detail && !cond ? '  — ' + detail : ''}`); if (!cond) failures++; };
const money = (n) => '$' + Number(n).toFixed(2);

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

async function setup(browser, base, { signedIn = false, plan = 'plus', theme = 'dark', phone = false, diesel = true } = {}) {
  const context = await browser.newContext(phone
    ? { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true }
    : { viewport: { width: 1440, height: 900 } });
  const calls = { logout: 0 };
  await context.addInitScript(([s, p, th]) => {
    if (localStorage.getItem('__seeded')) return;
    localStorage.setItem('__seeded', '1');
    if (th) localStorage.setItem('qfc_theme', th);
    if (s) {
      localStorage.setItem('sb-xgrmbhmgcsbnazupfybd-auth-token', JSON.stringify({ access_token: 'tok', refresh_token: 'r',
        expires_at: Math.floor(Date.now() / 1000) + 3600, user: { id: 'user-1', email: 'sam@example.com' } }));
      localStorage.setItem('qfc_pro_status', JSON.stringify({ isActive: true, userId: 'user-1', cachedAt: Date.now() }));
      localStorage.setItem('qfc_pro_profile', JSON.stringify({ contactName: 'Sam Rivera', companyName: 'Keystone Produce Logistics', plan: p }));
    }
  }, [signedIn, plan, theme]);
  await context.route('**/*', async (route) => {
    const url = route.request().url();
    const json = (b) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(b) });
    if (url.startsWith(base) && !url.includes('/.netlify/functions/')) return route.continue();
    if (url.includes('/auth/v1/logout')) { calls.logout++; return route.fulfill({ status: 204, body: '' }); }
    if (url.includes('diesel-price')) return diesel ? json({ price: 3.851, previous: 3.951, period: '2026-11-09', previousPeriod: '2026-11-02' }) : route.fulfill({ status: 502, body: '{}' });
    const account = { id: 'user-1', is_active: true, plan, stripe_customer_id: 'c', stripe_subscription_id: 's', contact_name: 'Sam Rivera', company_name: 'Keystone Produce Logistics' };
    if (url.includes('/rest/v1/rpc/my_account')) return json({ row: signedIn ? account : null, team: null });
    if (url.includes('/rest/v1/pro_users')) return json(signedIn ? [account] : []);
    if (url.includes('/.netlify/functions/verify-pro')) return json({ active: signedIn, plan, paid: true, unlimitedUntilRenewal: false });
    if (url.includes('/.netlify/functions/')) return json({});
    if (url.includes('supabase.co')) return json([]);
    if (url.includes('fonts.googleapis.com') || url.includes('fonts.gstatic.com')) return route.continue();
    return route.abort();
  });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  return { context, page, errors, calls };
}
const text = (pg, sel) => pg.$eval(sel, (e) => e.innerText.replace(/\s+/g, ' ').trim()).catch(() => '');

(async () => {
  const server = await serve();
  const base = `http://127.0.0.1:${server.address().port}`;
  const browser = await chromium.launch();
  const last = RATES.history[RATES.history.length - 1];
  const prev = RATES.history[RATES.history.length - 2];

  // ── Navigation ───────────────────────────────────────────────────────────
  console.log('\n=== Navigation, signed out ===');
  let t = await setup(browser, base);
  await t.page.goto(base + '/rates.html');
  await t.page.waitForSelector('#qf-nav .qf-links');
  check('links: Calculator, Market Rates, Tools, Pricing', (await text(t.page, '#qf-nav .qf-links')) === 'Calculator Market Rates Tools Pricing');
  check('the current page is marked', (await text(t.page, '#qf-nav .qf-links a.active')) === 'Market Rates'
    && (await t.page.getAttribute('#qf-nav .qf-links a.active', 'aria-current')) === 'page');
  check('signed out: Sign in and Get Pro', (await t.page.getAttribute('#qf-nav .qf-signin', 'href')) === '/signup.html?login'
    && (await t.page.getAttribute('#qf-nav .qf-getpro', 'href')) === '/signup.html');
  await t.page.click('#qf-nav .qf-dd-btn');
  await t.page.waitForSelector('#qf-nav .qf-dd-menu a', { state: 'visible', timeout: 2000 }).catch(() => {});
  const tools = await t.page.$$eval('#qf-nav .qf-dd-menu a', (as) => as.map((a) => a.getAttribute('href')));
  check('Tools opens the five tools', await t.page.isVisible('#qf-nav .qf-dd-menu a')
    && JSON.stringify(tools) === JSON.stringify(['/multistop.html', '/bulk.html', '/lanes.html', '/customers.html', '/api.html']), JSON.stringify(tools));
  await t.page.locator('#qf-nav .qf-dd').screenshot({ path: path.join(SHOTS, 'nav_tools.png') }).catch(() => {});
  await t.page.keyboard.press('Escape');
  check('Escape closes it', (await t.page.getAttribute('#qf-nav .qf-dd-btn', 'aria-expanded')) === 'false');
  await t.page.click('#qf-nav .qf-theme');
  check('the theme button switches to light and remembers it', await t.page.evaluate(() => document.documentElement.classList.contains('light') && localStorage.getItem('qfc_theme') === 'light'));
  await t.page.reload();
  await t.page.waitForSelector('#qf-nav .qf-links');
  check('and light stays after a reload', await t.page.evaluate(() => document.documentElement.classList.contains('light')));
  check('footer: columns, links and the page note', (await t.page.$$('.qf-footer .qf-footer-col')).length === 3
    && !!(await t.page.$('.qf-footer a[href="/terms.html"]')) && !!(await t.page.$('.qf-footer a[href="/privacy.html"]')));
  check('no page errors', t.errors.length === 0, t.errors.join(' | '));
  await t.context.close();

  console.log('\n=== Navigation, signed in ===');
  t = await setup(browser, base, { signedIn: true });
  await t.page.goto(base + '/rates.html');
  await t.page.waitForSelector('#qf-nav .qf-acct-btn');
  check('the account button shows the name, no Sign in', (await text(t.page, '#qf-nav .qf-acct-btn')) === 'S Sam' && !(await t.page.$('#qf-nav .qf-signin')) && !(await t.page.$('#qf-nav .qf-getpro')));
  await t.page.click('#qf-nav .qf-acct-btn');
  await t.page.waitForSelector('#qf-nav .qf-acct-menu .qf-signout', { state: 'visible', timeout: 2000 }).catch(() => {});
  check('its menu: who, Profile, Customers, Plans, Sign out', (await text(t.page, '#qf-nav .qf-acct-menu')).startsWith('Signed in as Sam Rivera sam@example.com Profile & settings Customers Plans & pricing Sign out'));
  await Promise.all([t.page.waitForURL(base + '/'), t.page.click('#qf-nav .qf-signout')]);
  check('Sign out tells Supabase, clears this browser, goes home', t.calls.logout === 1
    && await t.page.evaluate(() => !Object.keys(localStorage).some((k) => k.startsWith('sb-')) && !localStorage.getItem('qfc_pro_profile')));
  await t.context.close();

  console.log('\n=== Navigation on a phone ===');
  t = await setup(browser, base, { phone: true });
  await t.page.goto(base + '/rates.html');
  await t.page.waitForSelector('#qf-nav .qf-burger');
  check('links fold into the menu button', !(await t.page.isVisible('#qf-nav .qf-links')) && await t.page.isVisible('#qf-nav .qf-burger'));
  await t.page.click('#qf-nav .qf-burger');
  check('the menu lists pages, tools and sign in', await t.page.isVisible('#qf-nav .qf-mobile')
    && (await text(t.page, '#qf-nav .qf-mobile')).includes('Market Rates') && (await text(t.page, '#qf-nav .qf-mobile')).includes('Multi-Stop Builder')
    && (await text(t.page, '#qf-nav .qf-mobile')).includes('Sign in'));
  const sideways = await t.page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  check('Market Rates on a phone: no sideways scrolling', sideways <= 1, `${sideways}px`);
  await t.page.click('#qf-nav .qf-burger');
  await t.page.screenshot({ path: path.join(SHOTS, 'rates_phone.png'), fullPage: true });
  check('no page errors', t.errors.length === 0, t.errors.join(' | '));
  await t.context.close();

  // ── Market Rates ─────────────────────────────────────────────────────────
  console.log('\n=== Market Rates ===');
  t = await setup(browser, base);
  await t.page.goto(base + '/rates.html');
  await t.page.waitForFunction(() => document.querySelectorAll('#mr-svg path[data-state]').length === 51 && document.querySelector('#mr-conditions .mr-tile:nth-child(4)'));
  const tiles = await t.page.$$eval('#mr-national .mr-tile', (els) => els.map((e) => e.innerText.replace(/\s+/g, ' ')));
  const natVan = RATES.regions.national.van, prevVan = prev.regions.national.van;
  const vanTrend = (natVan - prevVan) / prevVan;
  check('national tiles: rate and change since last month', tiles.length === 3 && tiles[0].replace(/\s/g, '').includes(`${money(natVan)}/mi`)
    && tiles[0].includes(`${vanTrend >= 0 ? 'Up' : 'Down'} ${Math.abs(vanTrend * 100).toFixed(1)}%`), tiles[0]);
  check('six months of bars, the latest highlighted', (await t.page.$$('#mr-national .mr-tile:first-child .mr-spark span')).length === 6
    && (await t.page.$$('#mr-national .mr-tile:first-child .mr-spark span.now')).length === 1);
  const cond = await t.page.$$eval('#mr-conditions .mr-tile', (els) => els.map((e) => e.innerText.replace(/\s+/g, ' ')));
  check('market conditions: load-to-truck and diesel with its weekly change', cond.length === 4
    && cond[0].includes(String(RATES.loadToTruck.van.current)) && cond[3].includes('$3.85') && cond[3].includes('Down 2.5% vs last week'), cond.join(' / '));

  const fills = await t.page.$$eval('#mr-svg path[data-state]', (ps) => Object.fromEntries(ps.map((p) => [p.dataset.state, [p.dataset.region, p.style.fill]])));
  const sameRegionSameColor = Object.keys(RATES.regions).filter((r) => r !== 'national')
    .every((r) => new Set(RATES.regions[r].states.map((s) => fills[s][1])).size === 1 && RATES.regions[r].states.every((s) => fills[s][0] === r));
  check('every state is shaded by its region', sameRegionSameColor && fills.DC[0] === 'northeast');
  const vans = ['northeast', 'southeast', 'midwest', 'southwest', 'west'].map((r) => [r, RATES.regions[r].van]).sort((a, b) => b[1] - a[1]);
  const rows = await t.page.$$eval('#mr-regions tbody tr', (trs) => trs.map((tr) => [...tr.cells].map((c) => c.innerText.trim())));
  check('region table: highest first, then national', JSON.stringify(rows.map((r) => r[0])) === JSON.stringify(vans.map(([r]) => r[0].toUpperCase() + r.slice(1)).concat('National'))
    && rows[0][1] === money(vans[0][1]), JSON.stringify(rows.map((r) => r.join(' '))));

  await t.page.hover('#mr-svg path[data-state="PA"]');
  let tip = await text(t.page, '#mr-tip');
  const ne = RATES.regions.northeast.van, nat = RATES.regions.national.van;
  check('hover: the state, its region and rate, and how it compares', tip.startsWith('Pennsylvania Northeast region') && tip.includes(`${money(ne)} /mi van`)
    && tip.includes(`vs national (${money(nat)}) ${ne - nat >= 0 ? '+' : '−'}$${Math.abs(ne - nat).toFixed(2)}`), tip);
  check('and its region lights up on the map', await t.page.$eval('#mr-svg path[data-state="NY"]', (p) => p.classList.contains('on'))
    && !(await t.page.$eval('#mr-svg path[data-state="TX"]', (p) => p.classList.contains('on'))));
  await t.page.mouse.move(5, 5);
  check('leaving the map hides it', await t.page.isHidden('#mr-tip'));

  await t.page.click('#mr-eq button[data-eq="reefer"]');
  check('Reefer switches the map, table and chart', (await text(t.page, '#map-title')) === 'Reefer rates by region'
    && (await text(t.page, '#hist-title')) === 'Reefer rate per mile by month'
    && (await t.page.getAttribute('#mr-eq button[data-eq="reefer"]', 'aria-checked')) === 'true');
  await t.page.hover('#mr-svg path[data-state="TX"]');
  tip = await text(t.page, '#mr-tip');
  check('the tooltip follows: Texas, Southwest reefer', tip.startsWith('Texas Southwest region') && tip.includes(`${money(RATES.regions.southwest.reefer)} /mi reefer`), tip);
  await t.page.mouse.move(5, 5);

  await t.page.click('#mr-regions tbody tr[data-region="southeast"]');
  check('picking a region highlights it in the chart', (await t.page.$eval('#mr-regions tbody tr[data-region="southeast"]', (tr) => tr.classList.contains('sel')))
    && (await text(t.page, '#mr-hist-legend')).includes('Southeast'));
  check('the chart draws national, the region and the others', (await t.page.$$('#mr-chart svg path')).length === 6);
  await t.page.locator('#mr-chart svg').scrollIntoViewIfNeeded();
  const box = await t.page.$eval('#mr-chart svg', (s) => { const r = s.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height }; });
  await t.page.mouse.move(box.x + box.w - 140, box.y + box.h / 2);
  const ctip = await text(t.page, '#mr-chart-tip');
  check('hovering the chart lists every series for that month', ctip.startsWith(new Date(last.date + 'T12:00:00').toLocaleDateString('en-US', { month: 'long', year: 'numeric' }))
    && ctip.includes('National') && ctip.includes('Southeast') && ctip.includes('Midwest'), ctip);
  await t.page.click('#mr-table-toggle');
  check('the chart has a table view', await t.page.isVisible('#mr-hist-table table')
    && (await t.page.$$('#mr-hist-table tbody tr')).length === RATES.history.length);
  await t.page.screenshot({ path: path.join(SHOTS, 'rates.png'), fullPage: true });
  check('no page errors', t.errors.length === 0, t.errors.join(' | '));
  await t.context.close();

  t = await setup(browser, base, { diesel: false });
  await t.page.goto(base + '/rates.html');
  await t.page.waitForFunction(() => document.querySelectorAll('#mr-conditions .mr-tile').length >= 3);
  await t.page.waitForTimeout(400);
  check('without diesel data the page still works (3 tiles)', (await t.page.$$('#mr-conditions .mr-tile')).length === 3 && t.errors.length === 0);
  await t.context.close();

  // ── Plans on the signup page ─────────────────────────────────────────────
  console.log('\n=== Plans ===');
  t = await setup(browser, base);
  await t.page.goto(base + '/signup.html?plan=plus');
  await t.page.waitForSelector('.su-plan');
  const cols = await t.page.$$eval('.su-plan', (els) => els.map((e) => ({ plan: e.dataset.plan, price: e.querySelector('.su-price').innerText.replace(/\s+/g, ''),
    yes: e.querySelectorAll('li.yes').length, no: e.querySelectorAll('li.no').length })));
  check('four plans with their prices', cols.map((c) => `${c.plan} ${c.price}`).join(' | ') === 'pro $9.99/month | plus $19.99/month | max $49.99/month | api $199.99/month');
  check('each lists every feature, checked or crossed (Pro 9 crossed, Plus 3, Max 1, API 0)',
    cols.every((c) => c.yes + c.no === 20) && cols.map((c) => c.no).join() === '9,3,1,0', JSON.stringify(cols));
  const teamRow = await t.page.$$eval('.su-plan', (els) => els.map((e) => [...e.querySelectorAll('li')].find((li) => /Team/.test(li.innerText))).map((li) => li && `${li.className}:${li.innerText.replace(/\s+/g, ' ').replace(/ \((not )?included\)$/, '').trim()}`));
  check('team members are listed from Pro Max: 3 people, 6 on API', JSON.stringify(teamRow) === JSON.stringify([
    'no:Team members', 'no:Team members', 'yes:Team of 3: you and 2 more, each with their own login', 'yes:Team of 6: you and 5 more, each with their own login']), JSON.stringify(teamRow));
  const emailRow = await t.page.$$eval('.su-plan', (els) => els.map((e) => [...e.querySelectorAll('li')].find((li) => /Email the PDF/.test(li.innerText))).map((li) => li && `${li.className}:${li.innerText.replace(/\s+/g, ' ').replace(/ \((not )?included\)$/, '').trim()}`));
  check('emailing quotes is listed from Pro Plus, with each plan\u2019s daily limit', JSON.stringify(emailRow) === JSON.stringify([
    'no:Email the PDF to your customer', 'yes:Email the PDF to your customer: 100 a day', 'yes:Email the PDF to your customer: 300 a day', 'yes:Email the PDF to your customer: 300 a day']), JSON.stringify(emailRow));
  check('?plan=plus marks Pro Plus', (await t.page.$$eval('.su-plan.sel', (e) => e.map((x) => x.dataset.plan))).join() === 'plus'
    && (await text(t.page, '#su-selected-name')) === 'Pro Plus $19.99/month');
  await t.page.click('.su-plan[data-plan="max"] .su-start');
  await t.page.waitForTimeout(700);
  check('Start now picks the plan and goes to the account form', await t.page.isChecked('input[name="su-plan"][value="max"]')
    && (await text(t.page, '#su-selected-name')) === 'Pro Max $49.99/month' && (await text(t.page, '#su-btn')) === 'Sign up for Pro Max →'
    && await t.page.evaluate(() => document.activeElement && document.activeElement.id === 'su-email'));
  check('no page errors', t.errors.length === 0, t.errors.join(' | '));
  await t.context.close();

  t = await setup(browser, base);
  await t.page.goto(base + '/signup.html?login');
  await t.page.waitForSelector('#form-login');
  check('a sign-in link shows just the sign-in card', await t.page.isVisible('#form-login') && await t.page.isHidden('.su-plans') && await t.page.isHidden('.su-hero'));
  await t.page.click('#tab-signup');
  check('Create Account brings the plans back', await t.page.isVisible('.su-plans') && await t.page.isVisible('#form-signup'));
  await t.context.close();

  t = await setup(browser, base, { signedIn: true, plan: 'max' });
  await t.page.goto(base + '/signup.html');
  await t.page.waitForSelector('.su-signed');
  check('signed in: the plans stay, with their plan marked', (await t.page.$$eval('.su-plan.sel', (e) => e.map((x) => x.dataset.plan))).join() === 'max'
    && (await text(t.page, '.su-plan.sel .su-start')) === 'Manage on Profile' && (await text(t.page, '.su-side h2')) === "You're signed in"
    && (await t.page.getAttribute('.su-signed a', 'href')) === '/profile.html#subscription-paid');
  await t.context.close();

  t = await setup(browser, base, { phone: true });
  await t.page.goto(base + '/signup.html');
  await t.page.waitForSelector('.su-plan');
  check('phone: features fold away under each plan', await t.page.isHidden('.su-plan[data-plan="plus"] .su-groups'));
  await t.page.click('.su-plan[data-plan="plus"] .su-more');
  check('and open on request', await t.page.isVisible('.su-plan[data-plan="plus"] .su-groups'));
  const sw = await t.page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  check('no sideways scrolling', sw <= 1, `${sw}px`);
  await t.context.close();

  // ── Every other page ─────────────────────────────────────────────────────
  console.log('\n=== Every page has the shared look ===');
  const PAGES = [['/profile.html', null], ['/multistop.html', 'Tools'], ['/bulk.html', 'Tools'], ['/lanes.html', 'Tools'],
    ['/customers.html', 'Tools'], ['/api.html', 'Tools'], ['/terms.html', null], ['/privacy.html', null]];
  for (const theme of ['dark', 'light']) {
    t = await setup(browser, base, { signedIn: true, plan: 'plus', theme });
    for (const [url, active] of PAGES) {
      t.errors.length = 0;
      await t.page.goto(base + url);
      await t.page.waitForSelector('#qf-nav .qf-acct-btn');
      await t.page.waitForSelector('.qf-footer .qf-footer-col');
      await t.page.waitForTimeout(250);
      const r = await t.page.evaluate(() => ({
        path: location.pathname,
        navs: document.querySelectorAll('header, .header').length,
        oldTheme: !!document.getElementById('theme-btn') || typeof window.toggleTheme === 'function',
        inlineVars: document.documentElement.style.length,
        light: document.documentElement.classList.contains('light'),
        bg: getComputedStyle(document.body).backgroundColor,
        active: (document.querySelector('#qf-nav .qf-links .active') || {}).textContent || null,
        footers: document.querySelectorAll('footer').length,
      }));
      const bg = theme === 'light' ? 'rgb(244, 246, 250)' : 'rgb(11, 16, 24)';
      check(`${url} (${theme}): the nav and footer, the shared ${theme} colors, no old header or theme code`,
        r.path === url && r.navs === 1 && r.footers === 1 && !r.oldTheme && r.inlineVars === 0 && r.light === (theme === 'light') && r.bg === bg
          && (active ? r.active && r.active.startsWith(active) : r.active === null) && t.errors.length === 0, JSON.stringify(r) + ' ' + t.errors.join(' | '));
    }
    await t.context.close();
  }
  t = await setup(browser, base, { signedIn: true, plan: 'plus' });
  await t.page.goto(base + '/terms.html#quotes');
  await t.page.waitForSelector('#qf-nav .qf-acct-btn');
  await t.page.waitForTimeout(300);
  const below = await t.page.evaluate(() => { const s = document.getElementById('quotes'); return s ? Math.round(s.getBoundingClientRect().top) : -1; });
  check('a link to a section lands below the navigation', below >= 64 && below <= 120, `${below}px`);

  // The logo: a drawn truck mark (no tile), centered in its box; the same mark is the tab and app icon
  const logo = await t.page.$eval('#qf-nav .qf-logo-mark', (m) => {
    const r = m.getBoundingClientRect(), g = m.querySelector('svg g').getBoundingClientRect();
    return { dx: (g.left + g.width / 2) - (r.left + r.width / 2), dy: (g.top + g.height / 2) - (r.top + r.height / 2), fill: g.width / r.width };
  });
  check('the logo mark is centered in its box and fills it well', Math.abs(logo.dx) <= 0.5 && Math.abs(logo.dy) <= 0.5 && logo.fill > 0.9, JSON.stringify(logo));
  const logoColors = () => t.page.$eval('#qf-nav .qf-logo-mark', (m) => {
    const fill = (sel) => getComputedStyle(m.querySelector(sel)).fill;
    return { tile: getComputedStyle(m).backgroundImage, truck: fill('.qf-logo-truck'), calc: fill('.qf-logo-calc'), lit: fill('.qf-logo-lit'),
      word: getComputedStyle(document.querySelector('#qf-nav .qf-logo-text b')).color };
  });
  const darkLogo = await logoColors();
  await t.page.evaluate(() => QFCNav.setTheme(true));
  const lightLogo = await logoColors();
  await t.page.evaluate(() => QFCNav.setTheme(false));
  check('no tile: an amber truck that matches "Freight" in both themes, a black calculator, light keys',
    darkLogo.tile === 'none' && darkLogo.truck === 'rgb(245, 165, 36)' && darkLogo.truck === darkLogo.word && lightLogo.truck === 'rgb(212, 130, 0)'
      && lightLogo.truck === lightLogo.word && darkLogo.calc === 'rgb(13, 13, 13)' && lightLogo.calc === darkLogo.calc && darkLogo.lit === 'rgb(255, 244, 218)',
    JSON.stringify({ darkLogo, lightLogo }));
  check('the footer uses the same mark', (await t.page.$$('.qf-footer .qf-logo-mark svg.qf-logo-svg')).length === 1);
  // The files, fetched from this site's server (the browser's own favicon handling skips test interception)
  const status = (u) => new Promise((res) => http.get(base + u, (r) => { r.resume(); res(r.statusCode); }).on('error', () => res(0)));
  const icons = { links: await t.page.$$eval('link[rel="icon"]', (ls) => ls.map((l) => l.getAttribute('href'))), files: {},
    manifest: JSON.parse(fs.readFileSync(path.join(ROOT, 'manifest.json'), 'utf8')).icons.map((i) => i.src + ' ' + (i.purpose || '')) };
  for (const f of ['/favicon.svg', '/favicon.ico', '/apple-touch-icon.png', '/icon-192.png', '/icon-512.png', '/icon-maskable-512.png']) icons.files[f] = await status(f);
  check('the tab icon is the mark (SVG, with an .ico fallback), not the emoji', JSON.stringify(icons.links) === JSON.stringify(['/favicon.ico', '/favicon.svg']), JSON.stringify(icons.links));
  check('every icon file is there and the app manifest lists them, with a separate maskable icon',
    Object.values(icons.files).every((c) => c === 200) && icons.manifest.includes('/icon-maskable-512.png maskable') && icons.manifest.includes('/favicon.ico '), JSON.stringify(icons));
  const pagesWithEmoji = [];
  for (const f of fs.readdirSync(ROOT).filter((n) => n.endsWith('.html'))) {
    const html = fs.readFileSync(path.join(ROOT, f), 'utf8');
    if (html.includes('font-size=\'90\'>🚛') || !html.includes('<link rel="icon" href="/favicon.svg" type="image/svg+xml">')) pagesWithEmoji.push(f);
  }
  check('every page uses the new tab icon', pagesWithEmoji.length === 0, pagesWithEmoji.join(', '));
  await t.page.goto(base + '/profile.html');
  await t.page.waitForSelector('#qf-nav .qf-acct-btn');
  await t.page.click('#qf-nav .qf-theme');
  check('the theme button works on pages that had their own', await t.page.evaluate(() => document.documentElement.classList.contains('light')
    && getComputedStyle(document.body).backgroundColor === 'rgb(244, 246, 250)'));
  await t.context.close();

  // ── Calculator ───────────────────────────────────────────────────────────
  console.log('\n=== Calculator ===');
  t = await setup(browser, base);
  await t.page.goto(base + '/index.html');
  await t.page.waitForFunction(() => typeof regionalRates !== 'undefined' && regionalRates !== null && document.getElementById('gl-van').textContent !== '—');
  const reeferTrend = (RATES.regions.national.reefer - prev.regions.national.reefer) / prev.regions.national.reefer;
  check('national rates under the headline, with their change', (await text(t.page, '#gl-van')) === money(RATES.regions.national.van)
    && (await text(t.page, '#gl-reefer-d')) === (Math.abs(reeferTrend) < 0.0005 ? '' : Math.abs(reeferTrend * 100).toFixed(1) + '%')
    && (await text(t.page, '#gl-note')).includes(last.label));
  check('they link to the rate map', (await t.page.getAttribute('#glance a', 'href')) === '/rates.html');
  check('the tools sit together as tiles', (await t.page.$$('.calc-tools .calc-tool')).length === 4 && !!(await t.page.$('#customers-btn.calc-tool')));
  await t.page.fill('#origin', 'Lancaster, PA');
  await t.page.evaluate(() => applyRegionalRates());
  check('changing the origin still applies regional rates (no header chips needed)', (await t.page.inputValue('#rate-van')) === RATES.regions.northeast.van.toFixed(2));
  check('one navigation bar, no old header or theme button', (await t.page.$$('header')).length === 1 && !(await t.page.$('#theme-btn')));
  check('no page errors', t.errors.length === 0, t.errors.join(' | '));
  await t.context.close();

  await browser.close();
  server.close();
  console.log(failures ? `\n${failures} SITE CHECK(S) FAILED` : `\nALL SITE CHECKS PASSED (screenshots in ${SHOTS})`);
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
