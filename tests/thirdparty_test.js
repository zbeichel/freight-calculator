// tests/thirdparty_test.js — Google's scripts load without slowing the pages down:
// the AdSense library loads only when there is an ad to show (real slot IDs, a
// visitor who isn't Pro) and only after the page has loaded, while the
// verification meta tag and ads.txt stay; the Google Ads tag (gtag.js) queues
// right away but loads on the first tap/click/key/scroll or a few seconds after
// load (at once for ad clicks and visitors back from checkout). In a real browser
// (needs Playwright with Chromium); Google's scripts are replaced by stubs.
// Run from the repository root:
//   node tests/thirdparty_test.js
const http = require('http');
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');
const ROOT = path.resolve(__dirname, '..');
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.json': 'application/json', '.css': 'text/css' };
let failures = 0;
// Somewhere to click or tap that isn't a link or a control: the hero's subtitle.
const quietSpot = async (page) => { const b = await page.locator('p.hero-sub').boundingBox(); return [b.x + b.width / 2, b.y + b.height / 2]; };
const check = (label, cond, detail) => { console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}${detail && !cond ? '  — ' + detail : ''}`); if (!cond) failures++; };

const PAGES = ['index', 'api', 'bulk', 'lanes', 'market-news', 'multistop', 'privacy', 'profile', 'signup', 'terms'];
const PUB = 'ca-pub-5621259704181475';

function serve(realSlots) {
  const server = http.createServer((req, res) => {
    const p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    const file = path.join(ROOT, p === '/' ? 'index.html' : p);
    if (!file.startsWith(ROOT) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404); res.end(); return; }
    let body = fs.readFileSync(file);
    // "After approval" copy of the page: real slot IDs in ADS_CONFIG.
    if (realSlots && p === '/') body = body.toString('utf8').replace(/"XXXXXXXXXX"/g, '"1234567890"');
    res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream' });
    res.end(body);
  });
  return new Promise((r) => server.listen(0, '127.0.0.1', () => r(server)));
}

async function open(browser, url, { wide = false, phone = false, pro = false } = {}) {
  const context = await browser.newContext(phone
    ? { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true }
    : { viewport: { width: wide ? 1700 : 1280, height: 900 } });
  const log = { gtag: [], adsense: [] };
  await context.addInitScript((isPro) => {
    window.__t0 = Date.now();
    if (!isPro || localStorage.getItem('__seeded')) return;
    localStorage.setItem('__seeded', '1');
    localStorage.setItem('sb-xgrmbhmgcsbnazupfybd-auth-token', JSON.stringify({ access_token: 'tok', refresh_token: 'r',
      expires_at: Math.floor(Date.now() / 1000) + 3600, user: { id: 'user-1', email: 'sam@example.com' } }));
    localStorage.setItem('qfc_pro_status', JSON.stringify({ isActive: true, userId: 'user-1', cachedAt: Date.now() }));
  }, pro);
  await context.route('**/*', async (route) => {
    const u = route.request().url();
    const js = (body) => route.fulfill({ status: 200, contentType: 'text/javascript', body });
    if (u.startsWith(url.replace(/\/[^/]*$/, '')) && !u.includes('/.netlify/functions/')) return route.continue();
    if (u.includes('googletagmanager.com/gtag/js')) {
      log.gtag.push({ url: u, at: Date.now() });
      return js('window.__gtagRan = (window.__gtagRan || 0) + 1; window.__gtagQueue = (window.dataLayer || []).map(function(a){ return Array.prototype.slice.call(a); });');
    }
    if (u.includes('pagead2.googlesyndication.com')) {
      log.adsense.push({ url: u, at: Date.now() });
      return js('window.__adsQueued = (window.adsbygoogle || []).length;');
    }
    if (u.includes('/.netlify/functions/verify-pro')) return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ active: pro, plan: 'plus', paid: true }) });
    if (u.includes('/.netlify/functions/') || u.includes('supabase.co')) return route.fulfill({ status: 200, contentType: 'application/json', body: '[]' });
    return route.abort();
  });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(url, { waitUntil: 'load' });
  const loadAt = await page.evaluate(() => window.__t0 + performance.getEntriesByType('navigation')[0].loadEventStart);
  return { context, page, errors, log, loadAt };
}

(async () => {
  // ── The pages themselves ───────────────────────────────────────────────────
  console.log('\n=== Pages ===');
  for (const name of PAGES) {
    const html = fs.readFileSync(path.join(ROOT, name + '.html'), 'utf8');
    check(`${name}.html: no AdSense loader in the page`, !/<script[^>]+adsbygoogle\.js/.test(html));
    check(`${name}.html: keeps the AdSense verification tag`, html.includes(`<meta name="google-adsense-account" content="${PUB}">`));
  }
  check('ads.txt still authorizes Google', fs.readFileSync(path.join(ROOT, 'ads.txt'), 'utf8').includes(PUB.replace('ca-', '')));
  const index = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
  check('index.html: no gtag.js <script src> in the page', !/<script[^>]+src="https:\/\/www\.googletagmanager\.com\/gtag\/js/.test(index));
  check('index.html: the gtag() queue is still set up in <head>',
    index.indexOf("gtag('config', 'AW-18077158957')") > 0 && index.indexOf("gtag('config', 'AW-18077158957')") < index.indexOf('</head>'));

  const server = await serve(false);
  const base = `http://127.0.0.1:${server.address().port}`;
  const browser = await chromium.launch();

  // ── Google Ads tag ─────────────────────────────────────────────────────────
  console.log('\n=== Google Ads tag: no interaction ===');
  let t = await open(browser, base + '/');
  check('not requested by the time the page has loaded', t.log.gtag.length === 0);
  const queued = await t.page.evaluate(() => (window.dataLayer || []).map((a) => Array.prototype.slice.call(a)[0]));
  check('js and config are queued right away', queued.includes('js') && queued.includes('config'), JSON.stringify(queued));
  await t.page.waitForTimeout(1500);
  check('still not requested 1.5 s after load', t.log.gtag.length === 0);
  await t.page.waitForFunction(() => window.__gtagRan === 1, null, { timeout: 6000 }).catch(() => {});
  check('loads a few seconds after load', t.log.gtag.length === 1, `${t.log.gtag.length} requests`);
  if (t.log.gtag.length) {
    const after = t.log.gtag[0].at - t.loadAt;
    check('…about 3.5 s after load', after >= 3000 && after < 6000, `${after} ms`);
    check('requests the AW-18077158957 tag', t.log.gtag[0].url.includes('id=AW-18077158957'));
  }
  const seen = await t.page.evaluate(() => (window.__gtagQueue || []).map((a) => a[0] + (a[1] && typeof a[1] === 'string' ? ':' + a[1] : '')));
  check('the tag finds the queued js + config commands', seen.includes('js') && seen.includes('config:AW-18077158957'), JSON.stringify(seen));
  await t.page.mouse.click(...(await quietSpot(t.page)));
  await t.page.keyboard.press('Tab');
  await t.page.mouse.wheel(0, 400);
  await t.page.waitForTimeout(300);
  check('still on the calculator page', new URL(t.page.url()).pathname === '/', t.page.url());
  check('loads only once', t.log.gtag.length === 1 && (await t.page.evaluate(() => window.__gtagRan)) === 1);
  check('no page errors', t.errors.length === 0, t.errors.join(' | '));
  await t.context.close();

  for (const [label, act] of [
    ['a click', async (p) => p.mouse.click(...(await quietSpot(p)))],
    ['a key', (p) => p.keyboard.press('Tab')],
    ['a scroll', (p) => p.mouse.wheel(0, 500)],
  ]) {
    console.log(`\n=== Google Ads tag: ${label} ===`);
    t = await open(browser, base + '/');
    await t.page.waitForTimeout(300);
    const at = Date.now();
    await act(t.page);
    await t.page.waitForFunction(() => window.__gtagRan === 1, null, { timeout: 3000 }).catch(() => {});
    check(`${label} loads it right away`, t.log.gtag.length === 1 && t.log.gtag[0].at - at < 1500, t.log.gtag.length ? `${t.log.gtag[0].at - at} ms` : 'not loaded');
    await t.page.waitForTimeout(4000);
    check('…and only once (the timer does not load it again)', t.log.gtag.length === 1, `${t.log.gtag.length} requests`);
    await t.context.close();
  }

  console.log('\n=== Google Ads tag: a phone tap ===');
  t = await open(browser, base + '/', { phone: true });
  await t.page.waitForTimeout(300);
  let at = Date.now();
  await t.page.touchscreen.tap(...(await quietSpot(t.page)));
  await t.page.waitForFunction(() => window.__gtagRan === 1, null, { timeout: 3000 }).catch(() => {});
  check('a tap loads it right away', t.log.gtag.length === 1 && t.log.gtag[0].at - at < 1500, t.log.gtag.length ? `${t.log.gtag[0].at - at} ms` : 'not loaded');
  await t.context.close();

  for (const q of ['?gclid=test123', '?gbraid=abc', '?checkout=success']) {
    console.log(`\n=== Google Ads tag: ${q} ===`);
    t = await open(browser, base + '/' + q);
    await t.page.waitForFunction(() => window.__gtagRan === 1, null, { timeout: 3000 }).catch(() => {});
    check(`${q}: loads as soon as the page has loaded`, t.log.gtag.length === 1 && t.log.gtag[0].at - t.loadAt < 1500,
      t.log.gtag.length ? `${t.log.gtag[0].at - t.loadAt} ms after load` : 'not loaded');
    check(`${q}: not before load`, t.log.gtag.length === 1 && t.log.gtag[0].at >= t.loadAt - 50);
    await t.context.close();
  }

  // ── AdSense ────────────────────────────────────────────────────────────────
  console.log('\n=== AdSense: no slot IDs yet ===');
  for (const opts of [{ wide: true }, { phone: true }]) {
    t = await open(browser, base + '/', opts);
    await t.page.mouse.click(...(await quietSpot(t.page))).catch(() => {});
    await t.page.waitForTimeout(4500);
    check(`${opts.wide ? 'wide window' : 'phone'}: the AdSense library is never requested`, t.log.adsense.length === 0, `${t.log.adsense.length} requests`);
    check(`${opts.wide ? 'wide window' : 'phone'}: the ad units stay hidden`,
      await t.page.evaluate(() => ['ad-left', 'ad-right', 'ad-bottom'].every((id) => getComputedStyle(document.getElementById(id)).display === 'none')));
    check('no page errors', t.errors.length === 0, t.errors.join(' | '));
    await t.context.close();
  }
  server.close();

  const live = await serve(true);
  const liveBase = `http://127.0.0.1:${live.address().port}`;
  console.log('\n=== AdSense: real slot IDs, wide window ===');
  t = await open(browser, liveBase + '/', { wide: true });
  await t.page.waitForFunction(() => window.__adsQueued !== undefined, null, { timeout: 3000 }).catch(() => {});
  check('the library is requested once', t.log.adsense.length === 1, `${t.log.adsense.length} requests`);
  if (t.log.adsense.length) {
    check('…after the page has loaded', t.log.adsense[0].at >= t.loadAt - 50, `${t.log.adsense[0].at - t.loadAt} ms after load`);
    check('…with the publisher ID', t.log.adsense[0].url.endsWith('adsbygoogle.js?client=' + encodeURIComponent(PUB)));
  }
  check('all three units are queued for an ad', (await t.page.evaluate(() => window.__adsQueued)) === 3, String(await t.page.evaluate(() => window.__adsQueued)));
  const units = await t.page.evaluate(() => ['ad-left', 'ad-right', 'ad-bottom'].map((id) => {
    const el = document.getElementById(id); const ins = el.querySelector('ins.adsbygoogle');
    return getComputedStyle(el).display !== 'none' && ins.getAttribute('data-ad-slot') === '1234567890' && ins.getAttribute('data-ad-client') === 'ca-pub-5621259704181475';
  }));
  check('the rails and the banner are shown with their slot IDs', units.every(Boolean), JSON.stringify(units));
  await t.page.setViewportSize({ width: 1200, height: 900 });
  await t.page.setViewportSize({ width: 1700, height: 900 });
  await t.page.waitForTimeout(600);
  check('resizing does not load it again', t.log.adsense.length === 1);
  check('no page errors', t.errors.length === 0, t.errors.join(' | '));
  await t.context.close();

  console.log('\n=== AdSense: real slot IDs, phone ===');
  t = await open(browser, liveBase + '/', { phone: true });
  await t.page.waitForFunction(() => window.__adsQueued !== undefined, null, { timeout: 3000 }).catch(() => {});
  check('the library is requested once, after load', t.log.adsense.length === 1 && t.log.adsense[0].at >= t.loadAt - 50);
  check('just the bottom banner is queued', (await t.page.evaluate(() => window.__adsQueued)) === 1);
  await t.context.close();

  console.log('\n=== AdSense: real slot IDs, Pro visitor ===');
  t = await open(browser, liveBase + '/', { wide: true, pro: true });
  await t.page.waitForTimeout(2500);
  check('a Pro visitor never downloads the library', t.log.adsense.length === 0, `${t.log.adsense.length} requests`);
  check('…and sees no ad units', await t.page.evaluate(() => ['ad-left', 'ad-right', 'ad-bottom'].every((id) => getComputedStyle(document.getElementById(id)).display === 'none')));
  await t.context.close();

  live.close();
  await browser.close();
  console.log(failures ? `\n${failures} FAILED` : '\nALL PASS');
  process.exit(failures ? 1 : 0);
})();
