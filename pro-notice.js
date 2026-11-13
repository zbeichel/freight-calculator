// pro-notice.js — reminds subscribers on the original Pro plan ($4.99/month) that
// the plans change on January 1, 2027. Included on the calculator, bulk, multi-stop
// and lanes pages; the Profile page shows the same information inline.
//
// Shown to a signed-in, paid subscriber still on the original plan (verify-pro's
// unlimitedUntilRenewal, from the rule in netlify/lib/plans.js) until they pick their
// January plan in Profile (planChosen) or set their subscription to end (cancelAt).
// It keeps coming back so the new price doesn't surprise anyone:
//   "Got it" or "Choose my plan or cancel"   → not again on this browser until tomorrow
//   ✕, a click outside it, or Escape          → not again until their next visit
// Each time it's shown, and how it was closed, is recorded (plan_notice_events);
// the site owner sees that on the Profile page (plan_notice_report).
(function () {
  var SUPABASE_URL = 'https://xgrmbhmgcsbnazupfybd.supabase.co';
  var SUPABASE_KEY = 'sb_publishable_zSa4XpzakcntdkZfTzUPlg_FigYcISZ';
  var ACK_KEY = 'qfc_plan_notice_ack';           // localStorage: { userId: 'YYYY-MM-DD' } (day of "Got it")
  var LATER_KEY = 'qfc_plan_notice_later';       // sessionStorage: { userId: true } (closed this visit)
  var NOT_DUE_KEY = 'qfc_plan_notice_not_due';   // localStorage: { userId: time } (nothing to remind them of)
  var NOT_DUE_FOR = 24 * 3600 * 1000;

  function readJson(storage, key) {
    try { return JSON.parse(storage.getItem(key) || '{}') || {}; } catch (e) { return {}; }
  }
  function writeJson(storage, key, userId, value) {
    var all = readJson(storage, key);
    all[userId] = value;
    try { storage.setItem(key, JSON.stringify(all)); } catch (e) {}
  }
  function wait(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

  // Local date, e.g. "2026-11-14": "Got it" quiets the reminder for the rest of the day.
  function today() {
    var d = new Date();
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
  }

  // Which page it was shown on, for the owner's report: calculator, bulk, multistop, lanes.
  function pageName() {
    var base = (location.pathname || '/').replace(/\/+$/, '').split('/').pop().replace(/\.html$/, '').toLowerCase();
    if (!base || base === 'index') return 'calculator';
    base = base.replace(/[^a-z0-9_-]/g, '').slice(0, 40);
    return base || null;
  }

  // The stored sign-in ({ key, value }), as the pages keep it.
  function sessionEntry() {
    try {
      var keys = Object.keys(localStorage).filter(function (k) { return k.indexOf('sb-') === 0; });
      for (var i = 0; i < keys.length; i++) {
        var v = JSON.parse(localStorage.getItem(keys[i]) || '{}');
        if (v && v.access_token) return { key: keys[i], value: v };
      }
    } catch (e) {}
    return null;
  }
  function expiring(v) { return !!(v && v.expires_at && v.expires_at < Math.floor(Date.now() / 1000) + 60); }

  // A sign-in is good for an hour. The calculator refreshes an old one as it loads,
  // so give it a moment; the other pages don't, so then refresh it here the same way
  // (and store it the same way, so the page's own calls use the new one too).
  async function freshSession() {
    var e = sessionEntry();
    if (!e || !expiring(e.value)) return e && e.value;
    for (var i = 0; i < 6; i++) {
      await wait(500);
      e = sessionEntry();
      if (!e) return null;
      if (!expiring(e.value)) return e.value;
    }
    if (!e.value.refresh_token) return null;
    try {
      var resp = await fetch(SUPABASE_URL + '/auth/v1/token?grant_type=refresh_token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', apikey: SUPABASE_KEY },
        body: JSON.stringify({ refresh_token: e.value.refresh_token })
      });
      var data = await resp.json();
      if (!data || !data.access_token) return null;
      var latest = sessionEntry();                   // refreshed by the page meanwhile?
      if (latest && !expiring(latest.value)) return latest.value;
      var next = Object.assign({}, e.value, {
        access_token: data.access_token,
        refresh_token: data.refresh_token || e.value.refresh_token,
        expires_in: data.expires_in || 3600,
        expires_at: Math.floor(Date.now() / 1000) + (data.expires_in || 3600),
        user: data.user || e.value.user
      });
      localStorage.setItem(e.key, JSON.stringify(next));
      return next;
    } catch (err) { return null; }
  }

  // Adds one row to plan_notice_events: 'shown', 'got_it', 'choose_plan', 'closed_x',
  // 'clicked_outside' or 'escape_key'. keepalive lets it finish when the page changes.
  function record(s, action) {
    try {
      fetch(SUPABASE_URL + '/rest/v1/plan_notice_events', {
        method: 'POST',
        keepalive: true,
        headers: {
          apikey: SUPABASE_KEY,
          Authorization: 'Bearer ' + s.access_token,
          'Content-Type': 'application/json',
          Prefer: 'return=minimal'
        },
        body: JSON.stringify({ action: action, page: pageName() })
      }).catch(function () {});
    } catch (e) {}
  }

  function el(tag, style, html) {
    var n = document.createElement(tag);
    if (style) n.style.cssText = style;
    if (html != null) n.innerHTML = html;
    return n;
  }

  function show(userId, s) {
    var overlay = el('div',
      'position:fixed;inset:0;z-index:10001;background:rgba(0,0,0,.7);backdrop-filter:blur(4px);' +
      'display:flex;align-items:center;justify-content:center;padding:20px;font-family:"Space Grotesk",sans-serif');
    overlay.id = 'qfc-plan-notice';
    overlay.setAttribute('role', 'dialog');
    overlay.setAttribute('aria-modal', 'true');
    overlay.setAttribute('aria-labelledby', 'qfc-plan-notice-title');

    var card = el('div',
      'background:var(--panel,#1f2330);border:1px solid var(--border,rgba(255,255,255,.07));border-radius:16px;' +
      'max-width:460px;width:100%;max-height:calc(100vh - 40px);overflow:auto;position:relative;' +
      'box-shadow:0 24px 60px rgba(0,0,0,.5);color:var(--text2,#b0c4d8);font-size:13px;line-height:1.55');
    card.className = 'qfc-plan-notice-card';

    var close = el('button',
      'position:absolute;top:14px;right:14px;width:30px;height:30px;border-radius:8px;cursor:pointer;' +
      'background:var(--card2,#272c38);border:1px solid var(--border2,rgba(255,255,255,.12));color:var(--text3,#8896a8);font-size:18px;line-height:1',
      '✕');
    close.setAttribute('aria-label', 'Close');

    var strong = function (t) { return '<strong style="color:var(--text,#fff)">' + t + '</strong>'; };
    var head = el('div',
      'background:linear-gradient(135deg,#1a1f2e 0%,#0f1318 100%);padding:26px 28px 20px;border-bottom:1px solid var(--border,rgba(255,255,255,.07))',
      '<div style="font-size:12px;font-weight:700;letter-spacing:.06em;text-transform:uppercase;color:#f0a500;margin-bottom:6px">Important</div>' +
      '<div id="qfc-plan-notice-title" style="font-size:19px;font-weight:700;color:#f0f4f8">Changes coming to QuickFreightCalc Pro</div>');

    var body = el('div', 'padding:20px 28px 4px',
      '<p style="margin:0 0 12px">Because of increased server costs, our Pro plans are changing on ' + strong('January 1, 2027') + '.</p>' +
      '<p style="margin:0 0 12px;color:var(--text,#fff)"><strong>Nothing changes for you until then.</strong> You keep unlimited quotes with automatic miles at ' +
        strong('$4.99/month') + ' until your first bill on or after January 1.</p>' +
      '<p class="qfc-plan-notice-price" style="margin:0 0 14px;padding:10px 12px;border-radius:8px;background:rgba(240,165,0,.1);border:1px solid rgba(240,165,0,.45);color:var(--text,#fff)">' +
        'At that bill, your price goes to <strong>$9.99/month</strong> for Pro, unless you choose a different plan or cancel before then.</p>' +
      '<p style="margin:0 0 8px">From then, you can choose:</p>' +
      '<ul style="margin:0 0 12px;padding-left:18px">' +
        '<li>' + strong('Pro') + ' — $9.99/month · automatic miles on 100 quotes per day</li>' +
        '<li>' + strong('Pro Plus') + ' — $19.99/month · automatic miles on 250 quotes per day, win/loss tracking, a customer list, emailed quotes and your own rate sheet</li>' +
        '<li>' + strong('Pro Max') + ' — $49.99/month · everything in Pro Plus, automatic miles on 1,000 quotes per day, white-label PDFs and a team of 3 people</li>' +
      '</ul>' +
      '<p style="margin:0 0 4px">' + strong('New: API access') + ' — $199.99/month · get quotes on your own website or system, 5,000 quotes per month, and everything in Pro Max. ' +
        '<a href="/api.html" target="_blank" rel="noopener" style="color:var(--accent,#f0a500)">API docs</a></p>' +
      '<p style="margin:0 0 14px"><a href="/terms.html#quotes" target="_blank" rel="noopener" style="color:var(--accent,#f0a500)">What counts as a quote?</a></p>' +
      '<p class="qfc-plan-notice-repeat" style="margin:0 0 14px;font-size:12px;color:var(--text3,#8896a8)">' +
        'This reminder will keep coming back until you choose your plan for January in your Profile.</p>');

    var actions = el('div', 'padding:0 28px 24px;display:flex;flex-direction:column;gap:8px');
    var choose = el('button',
      'width:100%;padding:12px;border-radius:8px;border:none;cursor:pointer;background:#f0a500;color:#000;' +
      'font-family:inherit;font-size:14px;font-weight:700',
      'Choose my plan or cancel →');
    var ok = el('button',
      'width:100%;padding:10px;border-radius:8px;cursor:pointer;background:none;' +
      'border:1px solid var(--border2,rgba(255,255,255,.12));color:var(--text2,#b0c4d8);font-family:inherit;font-size:13px;font-weight:600',
      'Got it');
    actions.appendChild(choose);
    actions.appendChild(ok);

    card.appendChild(close);
    card.appendChild(head);
    card.appendChild(body);
    card.appendChild(actions);
    overlay.appendChild(card);
    document.body.appendChild(overlay);
    var prevOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    record(s, 'shown');

    function hide() {
      overlay.remove();
      document.body.style.overflow = prevOverflow;
      document.removeEventListener('keydown', onKey);
    }
    // Closed without "Got it": back on their next visit.
    function later(action) {
      record(s, action);
      writeJson(sessionStorage, LATER_KEY, userId, true);
      hide();
    }
    // Read it: back tomorrow (until they choose their plan).
    function acknowledged(action) {
      record(s, action);
      writeJson(localStorage, ACK_KEY, userId, today());
    }
    function onKey(e) { if (e.key === 'Escape') later('escape_key'); }
    close.addEventListener('click', function () { later('closed_x'); });
    overlay.addEventListener('click', function (e) { if (e.target === overlay) later('clicked_outside'); });
    document.addEventListener('keydown', onKey);
    ok.addEventListener('click', function () { acknowledged('got_it'); hide(); });
    choose.addEventListener('click', function () {
      acknowledged('choose_plan');
      window.location.href = '/profile.html#subscription-paid';
    });
    // Keyboard focus on "Got it" without scrolling the card: on a phone it opens at the top.
    ok.focus({ preventScroll: true });
    card.scrollTop = 0;
  }

  async function check() {
    var e = sessionEntry();
    var u = e && e.value.user;
    var userId = u && (u.id || u.sub);
    if (!userId) return;
    if (readJson(localStorage, ACK_KEY)[userId] === today()) return;
    if (readJson(sessionStorage, LATER_KEY)[userId]) return;
    var notDue = readJson(localStorage, NOT_DUE_KEY)[userId];
    if (notDue && Date.now() - notDue < NOT_DUE_FOR) return;

    var s = await freshSession();
    if (!s) return;
    try {
      var resp = await fetch('/.netlify/functions/verify-pro', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userId: userId, accessToken: s.access_token })
      });
      if (!resp.ok) return;
      var data = await resp.json();
      if (!data || !('unlimitedUntilRenewal' in data)) return;   // not a real answer (e.g. signed out)
      var due = data.active && data.paid && data.unlimitedUntilRenewal && !data.planChosen && !data.cancelAt;
      // Nobody else has anything to be reminded of: skip the check for a day.
      if (!due) { writeJson(localStorage, NOT_DUE_KEY, userId, Date.now()); return; }
      if (!document.getElementById('qfc-plan-notice')) show(userId, s);
    } catch (err) {}
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', check);
  else check();
})();
