// customers.js — the customer list (Pro Plus and up, and comp accounts):
// saved customers whose details fill into quotes and PDFs. Used by the
// calculator, multi-stop, bulk and the Customers page. The database enforces
// the same rules (customers_enforce_plan): who can add or edit customers and
// how many each plan can save.
//
//   QFCCustomers.ready()               works out the plan and loads the list (Promise)
//   QFCCustomers.allowed()             this account can save customers
//   QFCCustomers.all() / byId(id) / byName(name)
//   QFCCustomers.save(customer, id?)   add or update (Promise of the saved customer)
//   QFCCustomers.remove(id)            delete (saved quotes keep the name)
//   QFCCustomers.onChange(fn)          after the list loads or changes
//   QFCCustomers.attachPicker(input, { details, onChange })
//                                      search-as-you-type on a customer text box
//   QFCCustomers.openEditor(customer | { name })   add / edit window (Promise)
//   QFCCustomers.forPDF(name, id)      { name, contactName, email, phone, address }
//                                      for "Prepared for" on PDFs
//   QFCCustomers.summary(customer)     "Attn: … · email · phone"
(function () {
  const SUPABASE_URL = 'https://xgrmbhmgcsbnazupfybd.supabase.co';
  const SUPABASE_KEY = 'sb_publishable_zSa4XpzakcntdkZfTzUPlg_FigYcISZ';
  const WITH_LIST = ['plus', 'max', 'api', 'comp'];
  const LIMIT = { plus: 1000, max: 5000, api: 5000, comp: 5000 };

  let customers = [];
  let tier = null;
  let readyPromise = null;
  const listeners = [];

  const esc = (s) => (s === null || s === undefined ? '' : String(s))
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  const tidy = (s) => String(s === null || s === undefined ? '' : s).trim().replace(/\s+/g, ' ');
  const key = (s) => tidy(s).toLowerCase();

  function session() {
    const keys = Object.keys(localStorage).filter((k) => k.indexOf('sb-') === 0).concat('qfc_session');
    for (const k of keys) {
      try {
        const v = JSON.parse(localStorage.getItem(k) || '{}');
        if (v && v.access_token) return v;
      } catch (e) {}
    }
    return null;
  }
  const userIdOf = (s) => (s && s.user && (s.user.id || s.user.sub)) || null;

  // Until ready() has asked the database: what the calculator last saw.
  function cachedTier() {
    try {
      const uid = userIdOf(session());
      const st = JSON.parse(localStorage.getItem('qfc_pro_status') || '{}') || {};
      if (!uid || !st.isActive || (st.userId && st.userId !== uid)) return 'none';
      const p = JSON.parse(localStorage.getItem('qfc_pro_profile') || '{}') || {};
      if (p.comp === true) return 'comp';
      return ['plus', 'max', 'api'].includes(p.plan) ? p.plan : 'pro';
    } catch (e) { return 'none'; }
  }
  const currentTier = () => tier || cachedTier();
  const allowed = () => WITH_LIST.includes(currentTier());
  const limit = () => LIMIT[currentTier()] || 0;

  async function api(method, path, body, prefer) {
    const s = session();
    if (!s) { const e = new Error('Sign in again to continue.'); e.code = 'auth'; throw e; }
    const headers = { apikey: SUPABASE_KEY, Authorization: 'Bearer ' + s.access_token };
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    if (prefer) headers.Prefer = prefer;
    const resp = await fetch(SUPABASE_URL + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await resp.text();
    let data = null;
    try { data = text ? JSON.parse(text) : null; } catch (e) {}
    if (!resp.ok) {
      const e = new Error((data && data.message) || 'Request failed');
      e.code = data && data.code;
      e.status = resp.status;
      throw e;
    }
    return data;
  }

  function fromRow(r) {
    return {
      id: r.id,
      name: r.name || '',
      contactName: r.contact_name || '',
      email: r.email || '',
      phone: r.phone || '',
      address: r.address || '',
      notes: r.notes || '',
      defaultMargin: r.default_margin === null || r.default_margin === undefined ? null : Number(r.default_margin),
      createdAt: r.created_at || null,
      updatedAt: r.updated_at || null,
    };
  }
  function sortList() { customers.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' })); }
  function emit() { listeners.forEach((fn) => { try { fn(customers); } catch (e) {} }); }
  function onChange(fn) { listeners.push(fn); }

  const all = () => customers.slice();
  const byId = (id) => customers.find((c) => String(c.id) === String(id)) || null;
  const byName = (name) => { const k = key(name); return k ? customers.find((c) => key(c.name) === k) || null : null; };

  // Works out the account's plan from the database (multi-stop and bulk only
  // check that Pro is active) and, with the customer list, loads it.
  function ready() {
    if (readyPromise) return readyPromise;
    readyPromise = (async () => {
      const uid = userIdOf(session());
      if (!uid) { tier = 'none'; return customers; }
      try {
        const rows = await api('GET', `/rest/v1/pro_users?id=eq.${encodeURIComponent(uid)}&select=is_active,plan,stripe_subscription_id`);
        const row = Array.isArray(rows) ? rows[0] : null;
        tier = !row || row.is_active !== true ? 'none'
          : !row.stripe_subscription_id ? 'comp'
          : ['plus', 'max', 'api'].includes(row.plan) ? row.plan : 'pro';
      } catch (e) {
        tier = cachedTier();
      }
      if (allowed()) { try { await load(); } catch (e) {} }
      return customers;
    })();
    return readyPromise;
  }

  async function load() {
    const uid = userIdOf(session());
    let rows = [];
    for (let offset = 0; offset < 5000; offset += 1000) {
      const page = await api('GET', `/rest/v1/customers?user_id=eq.${encodeURIComponent(uid)}&select=*&order=name.asc&limit=1000&offset=${offset}`);
      if (!Array.isArray(page)) break;
      rows = rows.concat(page);
      if (page.length < 1000) break;
    }
    customers = rows.map(fromRow);
    sortList();
    emit();
    return customers;
  }

  function friendly(e, name) {
    if (e && e.friendly) return e;
    const code = e && e.code;
    const msg = code === '23505' ? `You already have a customer named ${name}.`
      : code === '42501' ? 'The customer list comes with Pro Plus and up.'
      : code === '54000' ? `You've saved ${limit().toLocaleString()} customers, the most your plan allows.`
      : code === '23514' ? 'One of the fields is too long, or the margin is outside 0–200%.'
      : code === 'auth' ? e.message
      : "Couldn't save. Check your connection and try again.";
    const out = new Error(msg);
    out.friendly = true;
    return out;
  }
  function clip(v, n) { const s = String(v === null || v === undefined ? '' : v).trim(); return s ? s.slice(0, n) : null; }

  async function save(c, id) {
    const body = {
      name: tidy(c.name).slice(0, 120),
      contact_name: clip(c.contactName, 120),
      email: clip(c.email, 200),
      phone: clip(c.phone, 40),
      address: clip(c.address, 400),
      notes: clip(c.notes, 2000),
      default_margin: c.defaultMargin === '' || c.defaultMargin === null || c.defaultMargin === undefined || !isFinite(Number(c.defaultMargin))
        ? null : Number(c.defaultMargin),
    };
    if (!body.name) throw Object.assign(new Error("Enter the customer's name."), { friendly: true });
    const dupe = byName(body.name);
    if (dupe && String(dupe.id) !== String(id)) throw Object.assign(new Error(`You already have a customer named ${dupe.name}.`), { friendly: true });
    let rows;
    try {
      rows = id
        ? await api('PATCH', `/rest/v1/customers?id=eq.${encodeURIComponent(id)}`, body, 'return=representation')
        : await api('POST', '/rest/v1/customers', body, 'return=representation');
    } catch (e) { throw friendly(e, body.name); }
    if (!Array.isArray(rows) || !rows[0]) throw friendly(null, body.name);
    const saved = fromRow(rows[0]);
    customers = customers.filter((x) => String(x.id) !== String(saved.id)).concat(saved);
    sortList();
    emit();
    return saved;
  }

  async function remove(id) {
    try {
      await api('DELETE', `/rest/v1/customers?id=eq.${encodeURIComponent(id)}`);
    } catch (e) { throw friendly(e, ''); }
    customers = customers.filter((x) => String(x.id) !== String(id));
    emit();
  }

  function summary(c) {
    if (!c) return '';
    return [c.contactName ? 'Attn: ' + c.contactName : '', c.email, c.phone].filter(Boolean).join(' · ');
  }

  // For "Prepared for" on PDFs: the saved details when this account has the
  // customer list and the name (or id) is a saved customer; otherwise the name.
  function forPDF(name, id) {
    const c = allowed() ? ((id && byId(id)) || byName(name)) : null;
    if (c) return { name: c.name, contactName: c.contactName, email: c.email, phone: c.phone, address: c.address };
    const n = tidy(name);
    return n ? { name: n } : null;
  }

  // ── Styles (each page's own colors) ───────────────────────────────────────
  let styled = false;
  function injectCSS() {
    if (styled) return;
    styled = true;
    const css = `
.qfcc-pop{position:fixed;z-index:10050;background:var(--panel,#1f2330);border:1px solid var(--border2,rgba(255,255,255,.12));border-radius:10px;box-shadow:0 14px 40px rgba(0,0,0,.35);padding:4px;max-height:300px;overflow-y:auto;font-family:'Space Grotesk',sans-serif}
.qfcc-pop[hidden]{display:none}
.qfcc-item{padding:8px 10px;border-radius:7px;cursor:pointer}
.qfcc-item.active,.qfcc-item:hover{background:var(--accentbg,rgba(240,165,0,.1))}
.qfcc-name{font-size:13px;font-weight:600;color:var(--text,#fff)}
.qfcc-sub{font-size:11px;color:var(--text3,#8896a8);margin-top:1px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.qfcc-create{font-size:12px;font-weight:600;color:var(--accent,#f0a500)}
.qfcc-details{font-size:11px;color:var(--text3,#8896a8);margin-top:5px;line-height:1.5;overflow-wrap:anywhere}
.qfcc-details[hidden]{display:none}
.qfcc-link{background:none;border:none;padding:0;font:inherit;font-weight:600;color:var(--accent,#f0a500);cursor:pointer}
.qfcc-link:hover{text-decoration:underline}
.qfcc-overlay{position:fixed;inset:0;z-index:10060;background:rgba(0,0,0,.7);backdrop-filter:blur(4px);display:flex;align-items:center;justify-content:center;padding:20px;font-family:'Space Grotesk',sans-serif}
.qfcc-overlay[hidden]{display:none}
.qfcc-modal{background:var(--panel,#1f2330);border:1px solid var(--border,rgba(255,255,255,.07));border-radius:16px;max-width:480px;width:100%;max-height:calc(100vh - 40px);overflow-y:auto;box-shadow:0 24px 60px rgba(0,0,0,.5)}
.qfcc-head{display:flex;align-items:center;justify-content:space-between;padding:16px 22px;border-bottom:1px solid var(--border,rgba(255,255,255,.07))}
.qfcc-title{font-size:14px;font-weight:700;color:var(--text,#fff)}
.qfcc-x{font-size:18px;line-height:1;background:none;border:none;color:var(--text3,#8896a8);cursor:pointer;padding:2px 6px;border-radius:6px}
.qfcc-body{padding:14px 22px 20px}
.qfcc-body label{display:block;font-size:11px;font-weight:600;color:var(--text2,#b0c4d8);margin-top:10px}
.qfcc-body label span{font-weight:400;color:var(--text3,#8896a8)}
.qfcc-body input,.qfcc-body textarea{display:block;width:100%;margin-top:5px;background:var(--card2,#272c38);border:1px solid var(--border2,rgba(255,255,255,.12));border-radius:8px;color:var(--text,#fff);font-family:'Space Grotesk',sans-serif;font-size:13px;padding:8px 12px;outline:none;resize:vertical;line-height:1.45}
.qfcc-body input:focus,.qfcc-body textarea:focus{border-color:var(--accent,#f0a500)}
.qfcc-grid{display:grid;grid-template-columns:1fr 1fr;gap:10px;align-items:end}
.qfcc-hint{font-size:11px;color:var(--text3,#8896a8);line-height:1.45;padding-bottom:8px}
.qfcc-help{font-size:11px;color:var(--text3,#8896a8);line-height:1.5;margin-top:12px}
.qfcc-actions{display:flex;align-items:center;gap:8px;margin-top:16px}
.qfcc-status{flex:1;font-size:11px;color:var(--red,#f87171);line-height:1.4}
.qfcc-btn{font-family:'Space Grotesk',sans-serif;font-size:12px;font-weight:700;padding:8px 16px;border-radius:8px;border:1px solid var(--border2,rgba(255,255,255,.12));background:transparent;color:var(--text2,#b0c4d8);cursor:pointer}
.qfcc-save{background:var(--accent-fill,var(--accent,#f0a500));border-color:var(--accent-fill,var(--accent,#f0a500));color:#1b1305}
.qfcc-save:disabled{opacity:.6;cursor:default}
.qfcc-del{color:var(--red,#f87171);border-color:rgba(239,68,68,.35)}
.qfcc-del[hidden]{display:none}
@media (max-width:520px){.qfcc-grid{grid-template-columns:1fr}.qfcc-hint{padding-bottom:0}}`;
    const el = document.createElement('style');
    el.textContent = css;
    document.head.appendChild(el);
  }

  // ── Add / edit window ─────────────────────────────────────────────────────
  let editor = null;
  function buildEditor() {
    if (editor) return editor;
    injectCSS();
    const wrap = document.createElement('div');
    wrap.className = 'qfcc-overlay';
    wrap.id = 'qfcc-editor';
    wrap.hidden = true;
    wrap.innerHTML = `
      <div class="qfcc-modal" role="dialog" aria-modal="true" aria-labelledby="qfcc-title">
        <div class="qfcc-head"><div class="qfcc-title" id="qfcc-title">New customer</div><button type="button" class="qfcc-x" aria-label="Close">✕</button></div>
        <form class="qfcc-body" novalidate>
          <label>Customer name<input name="name" maxlength="120" autocomplete="off" /></label>
          <div class="qfcc-grid">
            <label>Contact<input name="contactName" maxlength="120" autocomplete="off" /></label>
            <label>Phone<input name="phone" maxlength="40" autocomplete="off" inputmode="tel" /></label>
          </div>
          <label>Email<input name="email" type="email" maxlength="200" autocomplete="off" /></label>
          <label>Address<textarea name="address" rows="2" maxlength="400"></textarea></label>
          <div class="qfcc-grid">
            <label>Default margin % <span>(optional)</span><input name="defaultMargin" type="number" inputmode="decimal" min="0" max="200" step="0.5" /></label>
            <div class="qfcc-hint">Picking this customer on the calculator sets the margin.</div>
          </div>
          <label>Notes <span>(only you see these)</span><textarea name="notes" rows="2" maxlength="2000"></textarea></label>
          <div class="qfcc-help">The name, contact, email, phone and address print under “Prepared for” on your PDF quotes.</div>
          <div class="qfcc-actions">
            <button type="button" class="qfcc-btn qfcc-del">Delete</button>
            <span class="qfcc-status" role="status"></span>
            <button type="button" class="qfcc-btn qfcc-cancel">Cancel</button>
            <button type="submit" class="qfcc-btn qfcc-save">Save customer</button>
          </div>
        </form>
      </div>`;
    document.body.appendChild(wrap);
    const form = wrap.querySelector('form');
    const status = wrap.querySelector('.qfcc-status');
    const saveBtn = wrap.querySelector('.qfcc-save');
    const delBtn = wrap.querySelector('.qfcc-del');
    let current = null;   // { id, resolve }

    function finish(result) {
      wrap.hidden = true;
      const r = current && current.resolve;
      current = null;
      if (r) r(result);
    }
    wrap.querySelector('.qfcc-x').onclick = () => finish(null);
    wrap.querySelector('.qfcc-cancel').onclick = () => finish(null);
    wrap.addEventListener('mousedown', (e) => { if (e.target === wrap) finish(null); });
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !wrap.hidden) finish(null); });

    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const f = form.elements;
      const email = f.email.value.trim();
      const margin = f.defaultMargin.value.trim();
      if (!tidy(f.name.value)) { status.textContent = "Enter the customer's name."; f.name.focus(); return; }
      if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) { status.textContent = 'Check the email address.'; f.email.focus(); return; }
      if (margin && !(Number(margin) >= 0 && Number(margin) <= 200)) { status.textContent = 'Margin must be between 0 and 200%.'; f.defaultMargin.focus(); return; }
      status.textContent = '';
      saveBtn.disabled = true;
      try {
        const saved = await save({
          name: f.name.value, contactName: f.contactName.value, phone: f.phone.value, email,
          address: f.address.value, notes: f.notes.value, defaultMargin: margin,
        }, current && current.id);
        finish(saved);
      } catch (err) {
        status.textContent = err.message;
      } finally {
        saveBtn.disabled = false;
      }
    });

    delBtn.onclick = async () => {
      if (!current || !current.id) return;
      const c = byId(current.id);
      if (!window.confirm(`Delete ${c ? c.name : 'this customer'}? Saved quotes keep the name.`)) return;
      delBtn.disabled = true;
      try {
        await remove(current.id);
        finish(null);
      } catch (err) {
        status.textContent = err.message;
      } finally {
        delBtn.disabled = false;
      }
    };

    editor = {
      open(c) {
        return new Promise((resolve) => {
          if (current && current.resolve) current.resolve(null);
          const existing = c && c.id ? byId(c.id) || c : null;
          current = { id: existing ? existing.id : null, resolve };
          const src = existing || c || {};
          const f = form.elements;
          f.name.value = src.name || '';
          f.contactName.value = src.contactName || '';
          f.phone.value = src.phone || '';
          f.email.value = src.email || '';
          f.address.value = src.address || '';
          f.notes.value = src.notes || '';
          f.defaultMargin.value = src.defaultMargin === null || src.defaultMargin === undefined ? '' : String(src.defaultMargin);
          wrap.querySelector('.qfcc-title').textContent = existing ? 'Edit customer' : 'New customer';
          delBtn.hidden = !existing;
          status.textContent = '';
          wrap.hidden = false;
          setTimeout(() => (existing ? f.contactName : f.name).focus(), 30);
        });
      },
    };
    return editor;
  }
  function openEditor(c) {
    if (!allowed()) return Promise.resolve(null);
    return buildEditor().open(c);
  }

  // ── Search-as-you-type on a customer text box ─────────────────────────────
  // opts.details: element (or id) for the saved customer's details and the
  //   "Save as a customer" link under the box.
  // opts.onChange(customer | null, picked): the box now names a saved
  //   customer (or none); picked is true when the user chose it.
  function attachPicker(input, opts) {
    opts = opts || {};
    if (!input) return null;
    if (input.__qfccPicker) return input.__qfccPicker;
    injectCSS();
    const pop = document.createElement('div');
    pop.className = 'qfcc-pop';
    pop.setAttribute('role', 'listbox');
    pop.hidden = true;
    document.body.appendChild(pop);
    input.setAttribute('autocomplete', 'off');
    input.setAttribute('aria-autocomplete', 'list');
    input.setAttribute('aria-expanded', 'false');
    const details = typeof opts.details === 'string' ? document.getElementById(opts.details) : opts.details || null;
    if (details) details.classList.add('qfcc-details');
    let items = [];
    let active = -1;

    const linked = () => (input.dataset.customerId ? byId(input.dataset.customerId) : null);
    function setLinked(c, picked) {
      if (c) input.dataset.customerId = String(c.id);
      else delete input.dataset.customerId;
      renderDetails();
      if (opts.onChange) opts.onChange(c || null, !!picked);
    }
    // Typing a saved customer's exact name links it; anything else unlinks.
    function relink() {
      const c = allowed() ? byName(input.value) : null;
      const cur = linked();
      if ((c ? c.id : null) !== (cur ? cur.id : null)) setLinked(c, false);
      else renderDetails();
    }
    function createFromInput() {
      openEditor({ name: tidy(input.value) }).then((saved) => {
        if (saved) { input.value = saved.name; setLinked(saved, true); }
      });
    }
    function renderDetails() {
      if (!details) return;
      if (!allowed()) { details.innerHTML = ''; details.hidden = true; return; }
      const c = linked();
      if (c) {
        details.innerHTML = `<span>${esc(summary(c) || 'Saved customer')}</span> · <button type="button" class="qfcc-link">Edit</button>`;
        details.querySelector('button').onclick = () => openEditor(c).then((saved) => {
          if (saved) { input.value = saved.name; setLinked(saved, false); }
          else if (!byId(c.id)) setLinked(null, false);
        });
      } else if (tidy(input.value)) {
        details.innerHTML = `<button type="button" class="qfcc-link">+ Save “${esc(tidy(input.value))}” as a customer</button>`;
        details.querySelector('button').onclick = createFromInput;
      } else {
        details.innerHTML = '';
      }
      details.hidden = !details.innerHTML;
    }
    function matches(q) {
      const k = key(q);
      if (!k) return customers.slice(0, 8);
      const starts = [], contains = [];
      customers.forEach((c) => {
        const n = key(c.name);
        if (n.startsWith(k)) starts.push(c);
        else if (n.includes(k) || key(c.contactName).includes(k) || key(c.email).includes(k)) contains.push(c);
      });
      return starts.concat(contains).slice(0, 8);
    }
    // Under the box, or above it when the window has more room there, so the
    // list never opens off-screen (a box near the bottom of the window).
    function position() {
      const r = input.getBoundingClientRect();
      pop.style.left = Math.max(8, r.left) + 'px';
      pop.style.width = Math.min(r.width, window.innerWidth - 16) + 'px';
      const below = window.innerHeight - r.bottom - 12;
      const above = r.top - 12;
      const want = Math.min(pop.scrollHeight || 0, 300);
      const up = want > below && above > below;
      const room = Math.max(120, Math.min(300, up ? above : below));
      pop.style.maxHeight = room + 'px';
      pop.style.top = (up ? Math.max(8, r.top - 4 - Math.min(want, room)) : r.bottom + 4) + 'px';
    }
    function close() { pop.hidden = true; active = -1; input.setAttribute('aria-expanded', 'false'); }
    function render() {
      if (!allowed() || document.activeElement !== input) { close(); return; }
      const q = tidy(input.value);
      items = matches(q).map((c) => ({ c }));
      if (q && !byName(q)) items.push({ create: q });
      if (!items.length) { close(); return; }
      if (active >= items.length) active = items.length - 1;
      pop.innerHTML = items.map((it, i) => it.c
        ? `<div class="qfcc-item${i === active ? ' active' : ''}" role="option" data-i="${i}"><div class="qfcc-name">${esc(it.c.name)}</div>${summary(it.c) ? `<div class="qfcc-sub">${esc(summary(it.c))}</div>` : ''}</div>`
        : `<div class="qfcc-item qfcc-create${i === active ? ' active' : ''}" role="option" data-i="${i}">+ Save “${esc(it.create)}” as a new customer</div>`).join('');
      pop.hidden = false;   // shown first so position() can measure it
      position();
      input.setAttribute('aria-expanded', 'true');
    }
    function choose(i) {
      const it = items[i];
      if (!it) return;
      close();
      if (it.c) { input.value = it.c.name; setLinked(it.c, true); }
      else createFromInput();
    }

    input.addEventListener('focus', () => { ready().then(render); });
    input.addEventListener('input', () => { active = -1; relink(); render(); });
    input.addEventListener('keydown', (e) => {
      if (pop.hidden) return;
      if (e.key === 'ArrowDown') { e.preventDefault(); active = (active + 1) % items.length; render(); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); active = active <= 0 ? items.length - 1 : active - 1; render(); }
      else if (e.key === 'Enter' && active >= 0) { e.preventDefault(); choose(active); }
      else if (e.key === 'Escape') { e.stopPropagation(); close(); }
    });
    input.addEventListener('blur', () => setTimeout(close, 150));
    pop.addEventListener('mousedown', (e) => {
      e.preventDefault();
      const el = e.target.closest('[data-i]');
      if (el) choose(Number(el.dataset.i));
    });
    window.addEventListener('scroll', () => { if (!pop.hidden) position(); }, true);
    window.addEventListener('resize', () => { if (!pop.hidden) position(); });
    onChange(() => { relink(); });

    const picker = {
      customer: linked,
      // Fill the box (e.g. loading a saved quote) without counting as a pick.
      set(name, id) {
        input.value = name || '';
        const c = allowed() ? ((id && byId(id)) || byName(name)) : null;
        if (c) input.dataset.customerId = String(c.id);
        else delete input.dataset.customerId;
        renderDetails();
      },
      refresh: relink,
    };
    input.__qfccPicker = picker;
    ready().then(relink);
    return picker;
  }

  window.QFCCustomers = {
    ready, load, allowed, limit, tier: currentTier, all, byId, byName, save, remove, onChange,
    attachPicker, openEditor, forPDF, summary,
  };
})();
