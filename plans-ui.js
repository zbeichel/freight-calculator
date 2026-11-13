// plans-ui.js — the parts of the pages that show what the higher plans offer.
//   QFCPlans.options()             what can be bought right now (plan-options function):
//                                  { yearly: ['pro','plus','max'], prices, trial: { days, plans, dailyLimit } }
//   QFCPlans.trialEligible()       whether this person can start a free trial (a visitor can;
//                                  a signed-in account only if it never had a subscription)
//   QFCPlans.price(plan, interval) "$19.99/month" or "$199/year"
//   QFCPlans.monthlyEquivalent(plan) "$16.58" (a yearly price per month)
//   QFCPlans.meter                 the "automatic miles today" meter:
//                                  mount(el, { onUpgrade }), update(usage), refresh()
//   QFCPlans.preview(el, opts)     a grayed-out sample of a higher plan's feature, with a
//                                  lock, the plan's name and a button
// Styles live in site.css (.qf-usage, .qf-lp).
(function () {
  'use strict';
  const SUPABASE_URL = 'https://xgrmbhmgcsbnazupfybd.supabase.co';
  const SUPABASE_KEY = 'sb_publishable_zSa4XpzakcntdkZfTzUPlg_FigYcISZ';
  const NAME = { pro: 'Pro', plus: 'Pro Plus', max: 'Pro Max', api: 'API', free: 'Free' };
  const DEFAULT = {
    yearly: [],
    prices: { pro: { month: '$9.99', year: '$99' }, plus: { month: '$19.99', year: '$199' }, max: { month: '$49.99', year: '$499' }, api: { month: '$199.99' } },
    trial: { days: 7, plans: ['plus', 'max'], dailyLimit: 100 },
  };
  const CACHE_KEY = 'qfc_plan_options';
  const LIMIT_NEXT = { free: { plan: 'pro', n: 100 }, pro: { plan: 'plus', n: 250 }, plus: { plan: 'max', n: 1000 } };
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const LOCK = '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="5" y="10.5" width="14" height="9.5" rx="2"/><path d="M8.5 10.5V8a3.5 3.5 0 0 1 7 0v2.5"/></svg>';

  let current = DEFAULT;
  let optionsPromise = null;
  let eligiblePromise = null;

  function session() {
    try {
      const keys = Object.keys(localStorage).filter((k) => k.indexOf('sb-') === 0);
      for (const k of keys) {
        const v = JSON.parse(localStorage.getItem(k) || '{}');
        if (v && v.access_token) return v;
      }
    } catch (e) {}
    return null;
  }

  function options() {
    if (optionsPromise) return optionsPromise;
    optionsPromise = (async () => {
      try {
        const kept = JSON.parse(sessionStorage.getItem(CACHE_KEY) || 'null');
        if (kept && kept.at > Date.now() - 10 * 60 * 1000 && kept.data) return (current = kept.data);
      } catch (e) {}
      try {
        const resp = await fetch('/.netlify/functions/plan-options');
        if (!resp.ok) return current;
        const data = await resp.json();
        if (data && Array.isArray(data.yearly) && data.trial && data.prices) {
          current = data;
          try { sessionStorage.setItem(CACHE_KEY, JSON.stringify({ at: Date.now(), data })); } catch (e) {}
        }
      } catch (e) {}
      return current;
    })();
    return optionsPromise;
  }

  function trialEligible() {
    if (eligiblePromise) return eligiblePromise;
    eligiblePromise = (async () => {
      const s = session();
      const uid = s && s.user && (s.user.id || s.user.sub);
      if (!uid) return true;                       // a visitor signs up as a new account
      try {
        const resp = await fetch('/.netlify/functions/verify-pro', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ userId: uid, accessToken: s.access_token }),
        });
        if (!resp.ok) return false;
        const data = await resp.json();
        return data && data.trialEligible === true;
      } catch (e) {
        return false;
      }
    })();
    return eligiblePromise;
  }

  function price(plan, interval) {
    const p = (current.prices && current.prices[plan]) || DEFAULT.prices[plan] || DEFAULT.prices.pro;
    return interval === 'year' && p.year ? `${p.year}/year` : `${p.month}/month`;
  }
  function monthlyEquivalent(plan) {
    const p = (current.prices && current.prices[plan]) || DEFAULT.prices[plan];
    const n = p && p.year ? Number(String(p.year).replace(/[^0-9.]/g, '')) : NaN;
    return Number.isFinite(n) ? '$' + (n / 12).toFixed(2) : '';
  }
  // "Save $40.88" against twelve months.
  function yearlySaving(plan) {
    const p = (current.prices && current.prices[plan]) || DEFAULT.prices[plan];
    if (!p || !p.year) return '';
    const m = Number(String(p.month).replace(/[^0-9.]/g, '')), y = Number(String(p.year).replace(/[^0-9.]/g, ''));
    return Number.isFinite(m) && Number.isFinite(y) && m * 12 > y ? '$' + (m * 12 - y).toFixed(2) : '';
  }

  // ── The usage meter ──────────────────────────────────────────────────────
  const meter = {
    el: null, usage: null, opts: {},
    mount(el, opts) {
      this.el = el || null;
      this.opts = opts || {};
      if (this.el) { this.el.classList.add('qf-usage'); render(); }
    },
    update(usage) {
      if (!usage || typeof usage !== 'object') return;
      this.usage = usage;
      render();
    },
    async refresh() {
      const s = session();
      const headers = { 'Content-Type': 'application/json' };
      if (s && s.access_token) headers.Authorization = 'Bearer ' + s.access_token;
      try {
        const resp = await fetch('/.netlify/functions/routes', { method: 'POST', headers, body: JSON.stringify({ usage: true }) });
        if (!resp.ok) return;
        const data = await resp.json();
        if (data && data.usage) this.update(data.usage);
      } catch (e) {}
    },
  };

  function render() {
    const el = meter.el, u = meter.usage;
    if (!el) return;
    if (!u || !Number.isFinite(u.limit) || u.limit <= 0) { el.hidden = true; el.innerHTML = ''; return; }
    const used = Math.max(0, Math.min(Number.isFinite(u.used) ? u.used : 0, u.limit));
    const pct = used / u.limit;
    const full = used >= u.limit;
    const near = !full && pct >= 0.8;
    el.classList.toggle('near', near);
    el.classList.toggle('full', full);
    const n = (x) => x.toLocaleString('en-US');
    const lead = u.plan === 'free' ? 'Free quotes with automatic miles today'
      : u.trial ? 'Free trial · quotes with automatic miles today'
      : u.team ? 'Your team’s quotes with automatic miles today'
      : 'Quotes with automatic miles today';
    const next = !u.trial && LIMIT_NEXT[u.plan];
    const offer = next && (u.plan === 'free' || near || full)
      ? `<button type="button" class="qf-usage-up">Get ${n(next.n)} a day with ${esc(NAME[next.plan])}</button>` : '';
    el.innerHTML = `<span class="qf-usage-text">${esc(lead)}: <b>${n(used)}</b> of ${n(u.limit)}</span>` +
      `<span class="qf-usage-bar" role="progressbar" aria-label="${esc(lead)}" aria-valuemin="0" aria-valuemax="${u.limit}" aria-valuenow="${used}"><span style="width:${(pct * 100).toFixed(1)}%"></span></span>` +
      offer;
    el.title = 'Counts reset every day at midnight UTC (7 p.m. Eastern Standard Time). Re-pricing a lane you already ran today and typing the miles yourself don’t count.';
    el.hidden = false;
    const btn = el.querySelector('.qf-usage-up');
    if (btn) btn.addEventListener('click', () => {
      if (typeof meter.opts.onUpgrade === 'function') meter.opts.onUpgrade(u, next.plan);
      else window.location.href = u.plan === 'free' ? '/signup.html?plan=' + next.plan : '/profile.html#subscription-paid';
    });
  }

  // ── Grayed-out previews of a higher plan's feature ─────────────────────────
  // opts: { plan, title, text, sample (HTML of made-up example content),
  //         action: { label, onClick | href }, trialAction?: { onClick | href } (shown as
  //         "Try <plan> free for N days" when the person can start a trial),
  //         onClose? (adds a ✕) }
  function preview(el, opts) {
    if (!el || !opts) return;
    const o = opts;
    const plan = NAME[o.plan] || o.plan;
    el.innerHTML = `<div class="qf-lp">
        <div class="qf-lp-sample" aria-hidden="true" inert>${o.sample || ''}</div>
        <div class="qf-lp-card" role="group" aria-label="${esc(o.title)} · ${esc(plan)}">
          ${o.onClose ? '<button type="button" class="qf-lp-close" aria-label="Hide">✕</button>' : ''}
          <span class="qf-lp-badge">${LOCK}${esc(plan)}</span>
          <div class="qf-lp-title">${esc(o.title)}</div>
          <div class="qf-lp-text">${esc(o.text)}</div>
          <div class="qf-lp-actions">
            <button type="button" class="qf-lp-btn qf-lp-main">${esc((o.action && o.action.label) || 'See ' + plan)}</button>
            <button type="button" class="qf-lp-btn qf-lp-trial" hidden></button>
          </div>
        </div>
      </div>`;
    const go = (a) => { if (!a) return; if (typeof a.onClick === 'function') a.onClick(); else if (a.href) window.location.href = a.href; };
    el.querySelector('.qf-lp-main').addEventListener('click', () => go(o.action));
    const close = el.querySelector('.qf-lp-close');
    if (close) close.addEventListener('click', () => o.onClose());
    if (o.trialAction) {
      const tp = o.trialAction.plan || o.plan;   // the plan to try (the free quote log offers Pro Plus)
      Promise.all([options(), trialEligible()]).then(([opt, eligible]) => {
        const trial = opt && opt.trial;
        if (!eligible || !trial || !trial.plans.includes(tp)) return;
        const b = el.querySelector('.qf-lp-trial');
        if (!b) return;
        b.textContent = `Try ${NAME[tp] || tp} free for ${trial.days} days`;
        b.hidden = false;
        b.addEventListener('click', () => go(o.trialAction));
      });
    }
  }

  window.QFCPlans = { options, trialEligible, price, monthlyEquivalent, yearlySaving, meter, preview, name: (p) => NAME[p] || p,
    current: () => current, _reset: () => { optionsPromise = null; eligiblePromise = null; current = DEFAULT; } };
})();
