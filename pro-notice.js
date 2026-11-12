// pro-notice.js — tells subscribers on the original Pro plan that the plans
// change on January 1, 2027. Included on the calculator, bulk, multi-stop and
// lanes pages; the Profile page shows the same information inline.
//
// Shown to a signed-in, paid subscriber still on the original plan
// (verify-pro's unlimitedUntilRenewal, from the rule in netlify/lib/plans.js).
// "Got it" or "Choose a plan" hides it for good on this browser; the ✕ hides
// it until the next visit.
(function () {
  var DISMISSED_KEY = 'qfc_notice_plan_changes_2026_11';   // localStorage: { userId: true }
  var LATER_KEY = 'qfc_notice_plan_changes_later';          // sessionStorage

  function readJson(storage, key) {
    try { return JSON.parse(storage.getItem(key) || '{}') || {}; } catch (e) { return {}; }
  }

  function currentSession() {
    try {
      var keys = Object.keys(localStorage).filter(function (k) { return k.indexOf('sb-') === 0; });
      for (var i = 0; i < keys.length; i++) {
        var v = JSON.parse(localStorage.getItem(keys[i]) || '{}');
        if (v && v.access_token) return v;
      }
    } catch (e) {}
    return null;
  }

  function dismiss(userId) {
    var all = readJson(localStorage, DISMISSED_KEY);
    all[userId] = true;
    try { localStorage.setItem(DISMISSED_KEY, JSON.stringify(all)); } catch (e) {}
  }

  function el(tag, style, html) {
    var n = document.createElement(tag);
    if (style) n.style.cssText = style;
    if (html != null) n.innerHTML = html;
    return n;
  }

  function show(userId) {
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

    var close = el('button',
      'position:absolute;top:14px;right:14px;width:30px;height:30px;border-radius:8px;cursor:pointer;' +
      'background:var(--card2,#272c38);border:1px solid var(--border2,rgba(255,255,255,.12));color:var(--text3,#8896a8);font-size:18px;line-height:1',
      '✕');
    close.setAttribute('aria-label', 'Close');

    var head = el('div',
      'background:linear-gradient(135deg,#1a1f2e 0%,#0f1318 100%);padding:26px 28px 20px;border-bottom:1px solid var(--border,rgba(255,255,255,.07))',
      '<div style="font-size:12px;font-weight:700;letter-spacing:.06em;text-transform:uppercase;color:#f0a500;margin-bottom:6px">Important</div>' +
      '<div id="qfc-plan-notice-title" style="font-size:19px;font-weight:700;color:#f0f4f8">Changes coming to QuickFreightCalc Pro</div>');

    var body = el('div', 'padding:20px 28px',
      '<p style="margin:0 0 12px">Because of increased server costs, our Pro plans are changing on <strong style="color:var(--text,#fff)">January 1, 2027</strong>.</p>' +
      '<p style="margin:0 0 12px;color:var(--text,#fff)"><strong>Nothing changes for you until then.</strong> You keep unlimited quotes with automatic miles at your current price until your first bill on or after January 1.</p>' +
      '<p style="margin:0 0 8px">From then, you can choose:</p>' +
      '<ul style="margin:0 0 12px;padding-left:18px">' +
        '<li><strong style="color:var(--text,#fff)">Pro</strong> — $9.99/month · automatic miles on 100 quotes per day</li>' +
        '<li><strong style="color:var(--text,#fff)">Pro Plus</strong> — $19.99/month · automatic miles on 250 quotes per day</li>' +
        '<li><strong style="color:var(--text,#fff)">Pro Max</strong> — $49.99/month · automatic miles on 1,000 quotes per day and white-label PDFs</li>' +
      '</ul>' +
      '<p style="margin:0 0 12px">If you don\'t choose, you\'ll move to Pro. You can choose a plan or cancel anytime before then from your Profile.</p>' +
      '<p style="margin:0 0 4px"><strong style="color:var(--text,#fff)">New: API access</strong> — $199.99/month · get quotes on your own website or system, 5,000 quotes per month, and everything in Pro Max. ' +
        '<a href="/api.html" target="_blank" rel="noopener" style="color:var(--accent,#f0a500)">API docs</a></p>' +
      '<p style="margin:0"><a href="/terms.html#quotes" target="_blank" rel="noopener" style="color:var(--accent,#f0a500)">What counts as a quote?</a></p>');

    var actions = el('div', 'padding:0 28px 24px;display:flex;flex-direction:column;gap:8px');
    var choose = el('button',
      'width:100%;padding:12px;border-radius:8px;border:none;cursor:pointer;background:#f0a500;color:#000;' +
      'font-family:inherit;font-size:14px;font-weight:700',
      'Choose a plan or cancel →');
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

    function hide() {
      overlay.remove();
      document.body.style.overflow = prevOverflow;
      document.removeEventListener('keydown', onKey);
    }
    function later() {
      var l = readJson(sessionStorage, LATER_KEY);
      l[userId] = true;
      try { sessionStorage.setItem(LATER_KEY, JSON.stringify(l)); } catch (e) {}
      hide();
    }
    function onKey(e) { if (e.key === 'Escape') later(); }
    close.addEventListener('click', later);
    overlay.addEventListener('click', function (e) { if (e.target === overlay) later(); });
    document.addEventListener('keydown', onKey);
    ok.addEventListener('click', function () { dismiss(userId); hide(); });
    choose.addEventListener('click', function () {
      dismiss(userId);
      window.location.href = '/profile.html#subscription-paid';
    });
    ok.focus();
  }

  async function check() {
    var s = currentSession();
    var userId = s && s.user && (s.user.id || s.user.sub);
    if (!userId) return;
    if (readJson(localStorage, DISMISSED_KEY)[userId]) return;
    if (readJson(sessionStorage, LATER_KEY)[userId]) return;
    try {
      var resp = await fetch('/.netlify/functions/verify-pro', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userId: userId, accessToken: s.access_token })
      });
      if (!resp.ok) return;
      var data = await resp.json();
      if (data && data.active && data.paid && data.unlimitedUntilRenewal) show(userId);
    } catch (e) {}
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', check);
  else check();
})();
