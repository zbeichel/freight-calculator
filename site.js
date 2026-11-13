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
  // The logo mark: the front of a semi whose windshield and grille are a calculator. No tile: the truck
  // is the site's amber (site.css deepens it in light mode, like the wordmark), the calculator is black
  // with light keys. Drawn on a 32-unit grid; the view box hugs the drawing (favicon.svg and the app icons
  // use the same drawing).
  var LOGO = '<svg class="qf-logo-svg" viewBox="4.1 2.5 23.8 27" aria-hidden="true"><g>' +
    '<path class="qf-logo-truck" fill="#f5a524" fill-rule="evenodd" d="M10.45,5.85h11.1c0.654,0 1.177,0.741 1.65,2.224v-3.774c0,-0.75 0.3,-1.3 0.85,-1.3h0.6c0.2,0 0.3,0.1 0.3,0.3v0.55c0,0.45 -0.5,0.55 -0.5,1l0,4.8l0.75,0c0.391,0 0.716,0.28 0.786,0.65l0.364,0c0.304,0 0.55,0.246 0.55,0.55v2.95c0,0.304 -0.246,0.55 -0.55,0.55l-0.375,0c-0.089,0.345 -0.402,0.6 -0.775,0.6h-0.75l0,3.886l1.15,0.264c0.8,0.2 1.2,0.5 1.2,1.3v3.3h-6.8v-5.15l2.7,0l0,1.95l0.5,-1.95v-8.7c0,-0.878 -0.712,-1.59 -1.59,-1.59h-11.22c-0.878,0 -1.59,0.712 -1.59,1.59v8.7l0.5,1.95l0,-1.95l2.7,0v5.15h-6.8v-3.3c0,-0.8 0.4,-1.1 1.2,-1.3l1.15,-0.264l0,-3.886h-0.75c-0.373,0 -0.686,-0.255 -0.775,-0.6l-0.375,0c-0.304,0 -0.55,-0.246 -0.55,-0.55v-2.95c0,-0.304 0.246,-0.55 0.55,-0.55l0.364,0c0.07,-0.37 0.395,-0.65 0.786,-0.65l0.75,0v-4.8c0,-0.45 -0.5,-0.55 -0.5,-1v-0.55c0,-0.2 0.1,-0.3 0.3,-0.3h0.6c0.55,0 0.85,0.55 0.85,1.3v3.774c0.473,-1.482 0.996,-2.224 1.65,-2.224zM6.85,10.1c-0.186,0 -0.342,0.126 -0.387,0.298c0.143,0.099 0.237,0.265 0.237,0.452v2.95c0,0.182 -0.088,0.343 -0.224,0.443c0.058,0.15 0.203,0.257 0.374,0.257l0.7,0l0,-4.4zM25.15,14.5c0.171,0 0.316,-0.107 0.374,-0.257c-0.136,-0.1 -0.224,-0.261 -0.224,-0.443v-2.95c0,-0.187 0.094,-0.353 0.237,-0.452c-0.045,-0.171 -0.201,-0.298 -0.387,-0.298h-0.7l0,4.4zM9.3,9.85c0,-0.525 0.425,-0.95 0.95,-0.95h11.5c0.525,0 0.95,0.425 0.95,0.95v0.35l-13.4,0zM4.9,24.3h22.2c0.166,0 0.3,0.134 0.3,0.3v1.6c0,0.414 -0.336,0.75 -0.75,0.75h-0.65v1.45c0,0.331 -0.269,0.6 -0.6,0.6h-2.3c-0.331,0 -0.6,-0.269 -0.6,-0.6v-1.45l-13,0v1.45c0,0.331 -0.269,0.6 -0.6,0.6h-2.3c-0.331,0 -0.6,-0.269 -0.6,-0.6l0,-1.45l-0.65,0c-0.414,0 -0.75,-0.336 -0.75,-0.75v-1.6c0,-0.166 0.134,-0.3 0.3,-0.3z"/>' +
    '<path class="qf-logo-calc" fill="#0d0d0d" d="M10.25,8.9h11.5c0.525,0 0.95,0.425 0.95,0.95v13.85h-13.4v-13.85c0,-0.525 0.425,-0.95 0.95,-0.95z"/>' +
    '<path class="qf-logo-lit" fill="#fff4da" d="M11,10.1h10c0.276,0 0.5,0.224 0.5,0.5v2.6c0,0.276 -0.224,0.5 -0.5,0.5h-10c-0.276,0 -0.5,-0.224 -0.5,-0.5v-2.6c0,-0.276 0.224,-0.5 0.5,-0.5zM10.95,15h1.1c0.249,0 0.45,0.201 0.45,0.45v0.05c0,0.249 -0.201,0.45 -0.45,0.45h-1.1c-0.249,0 -0.45,-0.201 -0.45,-0.45v-0.05c0,-0.249 0.201,-0.45 0.45,-0.45zM13.95,15h1.1c0.249,0 0.45,0.201 0.45,0.45v0.05c0,0.249 -0.201,0.45 -0.45,0.45h-1.1c-0.249,0 -0.45,-0.201 -0.45,-0.45v-0.05c0,-0.249 0.201,-0.45 0.45,-0.45zM16.95,15h1.1c0.249,0 0.45,0.201 0.45,0.45v0.05c0,0.249 -0.201,0.45 -0.45,0.45h-1.1c-0.249,0 -0.45,-0.201 -0.45,-0.45v-0.05c0,-0.249 0.201,-0.45 0.45,-0.45zM19.95,15h1.1c0.249,0 0.45,0.201 0.45,0.45v0.05c0,0.249 -0.201,0.45 -0.45,0.45h-1.1c-0.249,0 -0.45,-0.201 -0.45,-0.45v-0.05c0,-0.249 0.201,-0.45 0.45,-0.45zM10.9,16.8h1.2c0.221,0 0.4,0.179 0.4,0.4v0.6c0,0.221 -0.179,0.4 -0.4,0.4h-1.2c-0.221,0 -0.4,-0.179 -0.4,-0.4v-0.6c0,-0.221 0.179,-0.4 0.4,-0.4zM13.9,16.8h1.2c0.221,0 0.4,0.179 0.4,0.4v0.6c0,0.221 -0.179,0.4 -0.4,0.4h-1.2c-0.221,0 -0.4,-0.179 -0.4,-0.4v-0.6c0,-0.221 0.179,-0.4 0.4,-0.4zM16.9,16.8h1.2c0.221,0 0.4,0.179 0.4,0.4v0.6c0,0.221 -0.179,0.4 -0.4,0.4h-1.2c-0.221,0 -0.4,-0.179 -0.4,-0.4v-0.6c0,-0.221 0.179,-0.4 0.4,-0.4zM10.9,19h1.2c0.221,0 0.4,0.179 0.4,0.4v0.6c0,0.221 -0.179,0.4 -0.4,0.4h-1.2c-0.221,0 -0.4,-0.179 -0.4,-0.4v-0.6c0,-0.221 0.179,-0.4 0.4,-0.4zM13.9,19h1.2c0.221,0 0.4,0.179 0.4,0.4v0.6c0,0.221 -0.179,0.4 -0.4,0.4h-1.2c-0.221,0 -0.4,-0.179 -0.4,-0.4v-0.6c0,-0.221 0.179,-0.4 0.4,-0.4zM16.9,19h1.2c0.221,0 0.4,0.179 0.4,0.4v0.6c0,0.221 -0.179,0.4 -0.4,0.4h-1.2c-0.221,0 -0.4,-0.179 -0.4,-0.4v-0.6c0,-0.221 0.179,-0.4 0.4,-0.4zM10.9,21.2h1.2c0.221,0 0.4,0.179 0.4,0.4v0.6c0,0.221 -0.179,0.4 -0.4,0.4h-1.2c-0.221,0 -0.4,-0.179 -0.4,-0.4v-0.6c0,-0.221 0.179,-0.4 0.4,-0.4zM13.9,21.2h1.2c0.221,0 0.4,0.179 0.4,0.4v0.6c0,0.221 -0.179,0.4 -0.4,0.4h-1.2c-0.221,0 -0.4,-0.179 -0.4,-0.4v-0.6c0,-0.221 0.179,-0.4 0.4,-0.4zM16.9,21.2h1.2c0.221,0 0.4,0.179 0.4,0.4v0.6c0,0.221 -0.179,0.4 -0.4,0.4h-1.2c-0.221,0 -0.4,-0.179 -0.4,-0.4v-0.6c0,-0.221 0.179,-0.4 0.4,-0.4zM19.9,16.8h1.2c0.221,0 0.4,0.179 0.4,0.4v0.6c0,0.221 -0.179,0.4 -0.4,0.4h-1.2c-0.221,0 -0.4,-0.179 -0.4,-0.4v-0.6c0,-0.221 0.179,-0.4 0.4,-0.4zM19.9,19h1.2c0.221,0 0.4,0.179 0.4,0.4v2.8c0,0.221 -0.179,0.4 -0.4,0.4h-1.2c-0.221,0 -0.4,-0.179 -0.4,-0.4v-2.8c0,-0.221 0.179,-0.4 0.4,-0.4zM6.5,20.9c1,0 1.85,0.35 2.45,0.85v0.9h-2.5c-0.333,0 -0.5,-0.167 -0.5,-0.5v-0.75c0,-0.333 0.183,-0.5 0.55,-0.5zM26.05,21.4v0.75c0,0.333 -0.167,0.5 -0.5,0.5h-2.5v-0.9c0.6,-0.5 1.45,-0.85 2.45,-0.85c0.367,0 0.55,0.167 0.55,0.5zM13.9,25.2h4.2c0.166,0 0.3,0.134 0.3,0.3v0.35c0,0.166 -0.134,0.3 -0.3,0.3h-4.2c-0.166,0 -0.3,-0.134 -0.3,-0.3v-0.35c0,-0.166 0.134,-0.3 0.3,-0.3z"/></g></svg>';

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
        '<div class="qf-footer-col"><h2 class="qf-footer-h">Quote</h2><a href="/">Rate calculator</a><a href="/multistop.html">Multi-stop builder</a>' +
        '<a href="/bulk.html">Bulk load calculator</a><a href="/lanes.html">Lane rate tracker</a></div>' +
        '<div class="qf-footer-col"><h2 class="qf-footer-h">Market</h2><a href="/rates.html">Market rates map</a><a href="/signup.html">Plans &amp; pricing</a>' +
        '<a href="/api.html">API</a><a href="/customers.html">Customers</a></div>' +
        '<div class="qf-footer-col"><h2 class="qf-footer-h">Company</h2><a href="/terms.html">Terms of Service</a><a href="/privacy.html">Privacy Policy</a>' +
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
