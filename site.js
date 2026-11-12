// site.js — the shared header and footer for every page: navigation
// (Calculator, Market Rates, Tools, Pricing), the account menu with sign-out,
// a mobile menu, and light/dark mode. Load it in <head> (not deferred) so the
// theme is set before the page paints:
//   <link rel="stylesheet" href="/site.css">
//   <script src="/site.js"></script>
// The nav goes at the top of <body>; the footer fills any element with
// data-qf-footer (its contents stay, as a note under the links).
//   QFCNav.refresh()   redraw the account area (after sign-in or profile changes)
//   QFCNav.setTheme(light)
//   QFCNav.signOut()
(function () {
  var SUPABASE_URL = 'https://xgrmbhmgcsbnazupfybd.supabase.co';
  var SUPABASE_KEY = 'sb_publishable_zSa4XpzakcntdkZfTzUPlg_FigYcISZ';
  var THEME_KEY = 'qfc_theme';

  // ── Light / dark, before the page paints ──
  function saved(key) { try { return localStorage.getItem(key); } catch (e) { return null; } }
  function prefersLight() { return !!(window.matchMedia && window.matchMedia('(prefers-color-scheme: light)').matches); }
  function isLight() { return document.documentElement.classList.contains('light'); }
  var t = saved(THEME_KEY);
  document.documentElement.classList.toggle('light', t ? t === 'light' : prefersLight());

  // ── Icons (24×24, stroke) ──
  var ICONS = {
    truck: '<path d="M3 6.5h10.5v9H3z"/><path d="M13.5 9.5h3.8l3.2 3.4v2.6h-7"/><circle cx="7" cy="17.5" r="1.8"/><circle cx="17" cy="17.5" r="1.8"/>',
    calc: '<rect x="5" y="3" width="14" height="18" rx="2.5"/><path d="M8.5 7.5h7M8.5 12h.01M12 12h.01M15.5 12h.01M8.5 15.5h.01M12 15.5h.01M15.5 15.5h.01"/>',
    map: '<path d="M9 4.5 3.5 6.8v12.7L9 17.2l6 2.3 5.5-2.3V4.5L15 6.8z"/><path d="M9 4.5v12.7M15 6.8v12.7"/>',
    route: '<circle cx="6" cy="6" r="2.2"/><circle cx="18" cy="18" r="2.2"/><path d="M8.2 6H15a3 3 0 0 1 0 6H9a3 3 0 0 0 0 6h6.8"/>',
    box: '<path d="M12 3 20 7.5v9L12 21l-8-4.5v-9z"/><path d="m4 7.5 8 4.5 8-4.5M12 12v9"/>',
    chart: '<path d="M4 19.5h16"/><path d="m5.5 15 4-4.5 3.5 3 5.5-6.5"/><path d="M15 7h3.5v3.5"/>',
    users: '<circle cx="9" cy="8.5" r="3.2"/><path d="M3.5 19.5c.6-3 2.8-4.8 5.5-4.8s4.9 1.8 5.5 4.8"/><path d="M15.5 5.6a3.2 3.2 0 0 1 0 5.8M17.3 14.9c1.6.6 2.8 2.2 3.2 4.6"/>',
    code: '<path d="m8.5 8-4 4 4 4M15.5 8l4 4-4 4M13.5 5.5l-3 13"/>',
    tag: '<path d="M3.5 12.5V4.5a1 1 0 0 1 1-1h8l8 8-9 9z"/><circle cx="8" cy="8" r="1.4"/>',
    user: '<circle cx="12" cy="8.5" r="3.5"/><path d="M5 20c.8-3.6 3.6-5.6 7-5.6s6.2 2 7 5.6"/>',
    logout: '<path d="M14 4.5h4.5a1 1 0 0 1 1 1v13a1 1 0 0 1-1 1H14"/><path d="M10 16l-4-4 4-4M6 12h9"/>',
    sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2.5v2M12 19.5v2M2.5 12h2M19.5 12h2M5.3 5.3l1.4 1.4M17.3 17.3l1.4 1.4M5.3 18.7l1.4-1.4M17.3 6.7l1.4-1.4"/>',
    moon: '<path d="M20 14.5A8 8 0 0 1 9.5 4a8 8 0 1 0 10.5 10.5z"/>',
    chevron: '<path d="m6 9 6 6 6-6"/>',
    menu: '<path d="M4 7h16M4 12h16M4 17h16"/>',
    close: '<path d="M6 6l12 12M18 6 6 18"/>',
  };
  // The logo mark: the front of a big rig. Its windshield is a calculator screen and its grille is the
  // keypad; roof lights, exhaust stacks, fenders, bumper. Drawn on a 32-unit grid, centered as drawn
  // (favicon.svg and the app icons use the same drawing).
  var LOGO = '<svg class="qf-logo-svg" viewBox="0 0 32 32" aria-hidden="true"><g>' +
    '<path fill="currentColor" fill-rule="evenodd" d="M10.5 4.5H21.5A2.5 2.5 0 0 1 24 7V24H8V7A2.5 2.5 0 0 1 10.5 4.5ZM5.6 17.6H8V24H4.9A0.9 0.9 0 0 1 4 23.1V19.2A1.6 1.6 0 0 1 5.6 17.6ZM5 3H5A1 1 0 0 1 6 4V15.4A1 1 0 0 1 5 16.4H5A1 1 0 0 1 4 15.4V4A1 1 0 0 1 5 3ZM5.8 26.8H9.6V28.1A0.9 0.9 0 0 1 8.7 29H6.7A0.9 0.9 0 0 1 5.8 28.1V26.8ZM24 17.6H26.4A1.6 1.6 0 0 1 28 19.2V23.1A0.9 0.9 0 0 1 27.1 24H24V17.6ZM27 3H27A1 1 0 0 1 28 4V15.4A1 1 0 0 1 27 16.4H27A1 1 0 0 1 26 15.4V4A1 1 0 0 1 27 3ZM22.4 26.8H26.2V28.1A0.9 0.9 0 0 1 25.3 29H23.3A0.9 0.9 0 0 1 22.4 28.1V26.8ZM4.5 24.8H27.5A1 1 0 0 1 28.5 25.8V25.8A1 1 0 0 1 27.5 26.8H4.5A1 1 0 0 1 3.5 25.8V25.8A1 1 0 0 1 4.5 24.8ZM11.4 5.45H11.8A0.4 0.4 0 0 1 12.2 5.85V5.85A0.4 0.4 0 0 1 11.8 6.25H11.4A0.4 0.4 0 0 1 11 5.85V5.85A0.4 0.4 0 0 1 11.4 5.45ZM13.6 5.45H14A0.4 0.4 0 0 1 14.4 5.85V5.85A0.4 0.4 0 0 1 14 6.25H13.6A0.4 0.4 0 0 1 13.2 5.85V5.85A0.4 0.4 0 0 1 13.6 5.45ZM15.8 5.45H16.2A0.4 0.4 0 0 1 16.6 5.85V5.85A0.4 0.4 0 0 1 16.2 6.25H15.8A0.4 0.4 0 0 1 15.4 5.85V5.85A0.4 0.4 0 0 1 15.8 5.45ZM18 5.45H18.4A0.4 0.4 0 0 1 18.8 5.85V5.85A0.4 0.4 0 0 1 18.4 6.25H18A0.4 0.4 0 0 1 17.6 5.85V5.85A0.4 0.4 0 0 1 18 5.45ZM20.2 5.45H20.6A0.4 0.4 0 0 1 21 5.85V5.85A0.4 0.4 0 0 1 20.6 6.25H20.2A0.4 0.4 0 0 1 19.8 5.85V5.85A0.4 0.4 0 0 1 20.2 5.45ZM10.5 12.6H12.7A0.5 0.5 0 0 1 13.2 13.1V14.3A0.5 0.5 0 0 1 12.7 14.8H10.5A0.5 0.5 0 0 1 10 14.3V13.1A0.5 0.5 0 0 1 10.5 12.6ZM14.9 12.6H17.1A0.5 0.5 0 0 1 17.6 13.1V14.3A0.5 0.5 0 0 1 17.1 14.8H14.9A0.5 0.5 0 0 1 14.4 14.3V13.1A0.5 0.5 0 0 1 14.9 12.6ZM19.3 12.6H21.5A0.5 0.5 0 0 1 22 13.1V14.3A0.5 0.5 0 0 1 21.5 14.8H19.3A0.5 0.5 0 0 1 18.8 14.3V13.1A0.5 0.5 0 0 1 19.3 12.6ZM10.5 15.7H12.7A0.5 0.5 0 0 1 13.2 16.2V17.4A0.5 0.5 0 0 1 12.7 17.9H10.5A0.5 0.5 0 0 1 10 17.4V16.2A0.5 0.5 0 0 1 10.5 15.7ZM14.9 15.7H17.1A0.5 0.5 0 0 1 17.6 16.2V17.4A0.5 0.5 0 0 1 17.1 17.9H14.9A0.5 0.5 0 0 1 14.4 17.4V16.2A0.5 0.5 0 0 1 14.9 15.7ZM19.3 15.7H21.5A0.5 0.5 0 0 1 22 16.2V20.5A0.5 0.5 0 0 1 21.5 21H19.3A0.5 0.5 0 0 1 18.8 20.5V16.2A0.5 0.5 0 0 1 19.3 15.7ZM10.5 18.8H12.7A0.5 0.5 0 0 1 13.2 19.3V20.5A0.5 0.5 0 0 1 12.7 21H10.5A0.5 0.5 0 0 1 10 20.5V19.3A0.5 0.5 0 0 1 10.5 18.8ZM14.9 18.8H17.1A0.5 0.5 0 0 1 17.6 19.3V20.5A0.5 0.5 0 0 1 17.1 21H14.9A0.5 0.5 0 0 1 14.4 20.5V19.3A0.5 0.5 0 0 1 14.9 18.8ZM5.5 19.6H6.5A0.6 0.6 0 0 1 7.1 20.2V20.6A0.6 0.6 0 0 1 6.5 21.2H5.5A0.6 0.6 0 0 1 4.9 20.6V20.2A0.6 0.6 0 0 1 5.5 19.6ZM25.5 19.6H26.5A0.6 0.6 0 0 1 27.1 20.2V20.6A0.6 0.6 0 0 1 26.5 21.2H25.5A0.6 0.6 0 0 1 24.9 20.6V20.2A0.6 0.6 0 0 1 25.5 19.6ZM14.5 25.35H17.5A0.3 0.3 0 0 1 17.8 25.65V25.95A0.3 0.3 0 0 1 17.5 26.25H14.5A0.3 0.3 0 0 1 14.2 25.95V25.65A0.3 0.3 0 0 1 14.5 25.35Z"/>' +
    '<path fill="#fff4da" d="M11 7.2H21A1 1 0 0 1 22 8.2V10.4A1 1 0 0 1 21 11.4H11A1 1 0 0 1 10 10.4V8.2A1 1 0 0 1 11 7.2Z"/><path fill="currentColor" d="M16.05 8.65H20.15A0.45 0.45 0 0 1 20.6 9.1V9.5A0.45 0.45 0 0 1 20.15 9.95H16.05A0.45 0.45 0 0 1 15.6 9.5V9.1A0.45 0.45 0 0 1 16.05 8.65Z"/></g></svg>';

  function icon(name, cls) {
    return '<svg class="qf-icon' + (cls ? ' ' + cls : '') + '" viewBox="0 0 24 24" aria-hidden="true">' + ICONS[name] + '</svg>';
  }
  function esc(s) {
    return String(s === null || s === undefined ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;')
      .replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  // ── Who's signed in (the same keys the pages use) ──
  function session() {
    try {
      var keys = Object.keys(localStorage).filter(function (k) { return k.indexOf('sb-') === 0; }).concat('qfc_session');
      for (var i = 0; i < keys.length; i++) {
        var v = JSON.parse(localStorage.getItem(keys[i]) || '{}');
        if (v && v.access_token) return v;
      }
    } catch (e) {}
    return null;
  }
  function account() {
    var s = session();
    if (!s) return null;
    var p = {}, st = {};
    try { p = JSON.parse(localStorage.getItem('qfc_pro_profile') || '{}') || {}; } catch (e) {}
    try { st = JSON.parse(localStorage.getItem('qfc_pro_status') || '{}') || {}; } catch (e) {}
    var email = (s.user && s.user.email) || p.email || '';
    var uid = s.user && (s.user.id || s.user.sub);
    return {
      name: p.contactName || p.companyName || email || 'Account',
      email: email,
      pro: !!(st.isActive && (!st.userId || st.userId === uid)),
    };
  }

  var TOOLS = [
    ['/multistop.html', 'route', 'Multi-Stop Builder', 'Several pickups and drops, per-stop charges', 'Pro'],
    ['/bulk.html', 'box', 'Bulk Load Calculator', 'Rate per cwt with fuel surcharge', 'Pro'],
    ['/lanes.html', 'chart', 'Lane Rate Tracker', 'Follow rates on the lanes you run', 'Pro'],
    ['/customers.html', 'users', 'Customers', 'Saved customers on every quote', 'Plus'],
    ['/api.html', 'code', 'API', 'Quotes inside your own site or TMS', 'API'],
  ];
  function here(paths) {
    var p = location.pathname.replace(/\/+$/, '') || '/';
    return paths.some(function (x) { return p === x || p === x.replace(/\.html$/, ''); });
  }

  function navHTML() {
    var a = account();
    var toolsActive = here(TOOLS.map(function (x) { return x[0]; }));
    var tools = TOOLS.map(function (x) {
      return '<a href="' + x[0] + '"><span class="qf-dd-ico">' + icon(x[1]) + '</span><span><b>' + esc(x[2]) +
        ' <em class="qf-tag">' + x[4] + '</em></b><small>' + esc(x[3]) + '</small></span></a>';
    }).join('');
    var themeBtn = '<button type="button" class="qf-icon-btn qf-theme" aria-label="' + (isLight() ? 'Switch to dark mode' : 'Switch to light mode') +
      '" title="' + (isLight() ? 'Dark mode' : 'Light mode') + '">' + icon(isLight() ? 'moon' : 'sun') + '</button>';
    var acct = a
      ? (a.pro ? '' : '<a class="qf-btn qf-btn-primary qf-getpro" href="/signup.html">Get Pro</a>') +
        '<div class="qf-acct"><button type="button" class="qf-acct-btn" aria-haspopup="true" aria-expanded="false">' +
        '<span class="qf-avatar">' + esc(a.name.trim().charAt(0).toUpperCase() || '?') + '</span>' +
        '<span class="qf-acct-name">' + esc(a.name.split(/[\s@]/)[0]) + '</span>' + icon('chevron') + '</button>' +
        '<div class="qf-acct-menu" role="menu"><div class="qf-acct-head"><small>Signed in as</small><b>' + esc(a.name) + '</b>' +
        (a.email && a.email !== a.name ? '<small>' + esc(a.email) + '</small>' : '') + '</div>' +
        '<a href="/profile.html" role="menuitem">' + icon('user') + 'Profile &amp; settings</a>' +
        '<a href="/customers.html" role="menuitem">' + icon('users') + 'Customers</a>' +
        '<a href="/signup.html" role="menuitem">' + icon('tag') + 'Plans &amp; pricing</a>' +
        '<button type="button" class="qf-signout" role="menuitem">' + icon('logout') + 'Sign out</button></div></div>'
      : '<a class="qf-btn qf-btn-ghost qf-signin" href="/signup.html?login">Sign in</a>' +
        '<a class="qf-btn qf-btn-primary qf-getpro" href="/signup.html">Get Pro</a>';
    var mobileTools = TOOLS.map(function (x) {
      return '<a href="' + x[0] + '">' + icon(x[1]) + esc(x[2]) + '</a>';
    }).join('');
    return '<div class="qf-nav-inner">' +
      '<a class="qf-logo" href="/" aria-label="QuickFreightCalc home"><span class="qf-logo-mark">' + LOGO + '</span>' +
      '<span class="qf-logo-text">Quick<b>Freight</b>Calc</span></a>' +
      '<nav class="qf-links" aria-label="Main">' +
      '<a href="/"' + (here(['/', '/index.html']) ? ' class="active" aria-current="page"' : '') + '>Calculator</a>' +
      '<a href="/rates.html"' + (here(['/rates.html']) ? ' class="active" aria-current="page"' : '') + '>Market Rates</a>' +
      '<div class="qf-dd"><button type="button" class="qf-dd-btn' + (toolsActive ? ' active' : '') + '" aria-haspopup="true" aria-expanded="false">Tools' + icon('chevron') + '</button>' +
      '<div class="qf-dd-menu">' + tools + '</div></div>' +
      '<a href="/signup.html"' + (here(['/signup.html']) ? ' class="active" aria-current="page"' : '') + '>Pricing</a>' +
      '</nav>' +
      '<div class="qf-actions">' + themeBtn + acct +
      '<button type="button" class="qf-icon-btn qf-burger" aria-label="Menu" aria-expanded="false">' + icon('menu') + '</button></div>' +
      '</div>' +
      '<div class="qf-mobile" hidden>' +
      '<a href="/">' + icon('calc') + 'Calculator</a><a href="/rates.html">' + icon('map') + 'Market Rates</a>' +
      '<a href="/signup.html">' + icon('tag') + 'Pricing</a>' +
      '<div class="qf-mobile-label">Tools</div>' + mobileTools +
      (a ? '<div class="qf-mobile-label">Account</div><a href="/profile.html">' + icon('user') + 'Profile &amp; settings</a>' +
        '<a href="#" class="qf-signout-m">' + icon('logout') + 'Sign out</a>'
        : '<div class="qf-mobile-cta"><a class="qf-btn qf-btn-ghost" href="/signup.html?login">Sign in</a>' +
          '<a class="qf-btn qf-btn-primary" href="/signup.html">Get Pro</a></div>') +
      '</div>';
  }

  var nav = null;
  function closeMenus(except) {
    if (!nav) return;
    nav.querySelectorAll('.qf-dd.open, .qf-acct.open').forEach(function (el) {
      if (el === except) return;
      el.classList.remove('open');
      var b = el.querySelector('[aria-expanded]');
      if (b) b.setAttribute('aria-expanded', 'false');
    });
  }
  function toggle(wrap) {
    var open = !wrap.classList.contains('open');
    closeMenus(wrap);
    wrap.classList.toggle('open', open);
    var b = wrap.querySelector('[aria-expanded]');
    if (b) b.setAttribute('aria-expanded', open ? 'true' : 'false');
  }

  function render() {
    if (!nav) {
      nav = document.createElement('header');
      nav.className = 'qf-nav';
      nav.id = 'qf-nav';
      document.body.insertBefore(nav, document.body.firstChild);
      nav.addEventListener('click', function (e) {
        var t = e.target;
        if (t.closest('.qf-theme')) { setTheme(!isLight()); return; }
        if (t.closest('.qf-dd-btn')) { toggle(t.closest('.qf-dd')); return; }
        if (t.closest('.qf-acct-btn')) { toggle(t.closest('.qf-acct')); return; }
        if (t.closest('.qf-signout') || t.closest('.qf-signout-m')) { e.preventDefault(); signOut(); return; }
        if (t.closest('.qf-burger')) {
          var m = nav.querySelector('.qf-mobile');
          var open = m.hidden;
          m.hidden = !open;
          var b = nav.querySelector('.qf-burger');
          b.setAttribute('aria-expanded', open ? 'true' : 'false');
          b.innerHTML = icon(open ? 'close' : 'menu');
        }
      });
      // Clicks elsewhere and Escape close the menus.
      document.addEventListener('click', function (e) { if (!e.target.closest('.qf-dd, .qf-acct')) closeMenus(); });
      document.addEventListener('keydown', function (e) { if (e.key === 'Escape') closeMenus(); });
    }
    nav.innerHTML = navHTML();
  }

  function setTheme(light) {
    document.documentElement.classList.toggle('light', !!light);
    try { localStorage.setItem(THEME_KEY, light ? 'light' : 'dark'); } catch (e) {}
    if (nav) {
      var b = nav.querySelector('.qf-theme');
      if (b) {
        b.innerHTML = icon(light ? 'moon' : 'sun');
        b.setAttribute('aria-label', light ? 'Switch to dark mode' : 'Switch to light mode');
        b.title = light ? 'Dark mode' : 'Light mode';
      }
    }
    try { document.dispatchEvent(new CustomEvent('qf-theme', { detail: { light: !!light } })); } catch (e) {}
  }

  function signOut() {
    var s = session();
    var done = function () {
      try {
        Object.keys(localStorage).filter(function (k) { return k.indexOf('sb-') === 0; }).forEach(function (k) { localStorage.removeItem(k); });
        ['qfc_pro_status', 'qfc_pro_profile', 'qfc_session'].forEach(function (k) { localStorage.removeItem(k); });
      } catch (e) {}
      window.location.href = '/';
    };
    if (!s) { done(); return; }
    try {
      fetch(SUPABASE_URL + '/auth/v1/logout', { method: 'POST', headers: { apikey: SUPABASE_KEY, Authorization: 'Bearer ' + s.access_token } })
        .then(done, done);
    } catch (e) { done(); }
  }

  function footer() {
    document.querySelectorAll('[data-qf-footer]').forEach(function (el) {
      var note = el.innerHTML.trim();
      var year = new Date().getFullYear();
      el.className = 'qf-footer';
      el.innerHTML = '<div class="qf-footer-inner"><div class="qf-footer-top">' +
        '<div class="qf-footer-brand"><a class="qf-logo" href="/"><span class="qf-logo-mark">' + LOGO + '</span>' +
        '<span class="qf-logo-text">Quick<b>Freight</b>Calc</span></a>' +
        '<p>Truckload rate quotes in seconds for brokers, dispatchers and owner-operators — van, reefer and flatbed, anywhere in the US.</p></div>' +
        '<div class="qf-footer-col"><h4>Quote</h4><a href="/">Rate calculator</a><a href="/multistop.html">Multi-stop builder</a>' +
        '<a href="/bulk.html">Bulk load calculator</a><a href="/lanes.html">Lane rate tracker</a></div>' +
        '<div class="qf-footer-col"><h4>Market</h4><a href="/rates.html">Market rates map</a><a href="/signup.html">Plans &amp; pricing</a>' +
        '<a href="/api.html">API</a><a href="/customers.html">Customers</a></div>' +
        '<div class="qf-footer-col"><h4>Company</h4><a href="/terms.html">Terms of Service</a><a href="/privacy.html">Privacy Policy</a>' +
        '<a href="mailto:info@quickfreightcalc.com">info@quickfreightcalc.com</a></div>' +
        '</div>' +
        (note ? '<div class="qf-footer-note">' + note + '</div>' : '') +
        '<div class="qf-footer-bottom"><span>© ' + year + ' QuickFreightCalc LLC</span>' +
        '<span>Rates are regional market averages and estimates, not guaranteed.</span></div></div>';
    });
  }

  function start() { render(); footer(); }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
  else start();
  // Signing in or out in another tab.
  window.addEventListener('storage', function (e) {
    if (!e.key || e.key.indexOf('sb-') === 0 || e.key === 'qfc_pro_profile' || e.key === 'qfc_pro_status') render();
  });

  window.QFCNav = { refresh: function () { if (nav) render(); }, setTheme: setTheme, signOut: signOut, icon: icon };
})();
