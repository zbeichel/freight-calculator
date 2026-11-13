// email-quote.js — "Email quote" for Pro Plus and up.
//
// Turns the quote document (the same page the PDF button opens) into a PDF file
// in the browser and sends it to the customer through
// /.netlify/functions/send-quote-email. The email goes out from
// quotes@quickfreightcalc.com as "<Company> via QuickFreightCalc" (just the
// company for white-label accounts), and replies go to the user.
//
//   QFCEmailQuote.open({
//     build()            makes the quote document when Send is pressed: { html, number, validUntil } or null
//                        (the same page and quote number the PDF button gives; validUntil is its printed text)
//     summary            { origin, destination, equipment, miles, rate, pickup, delivery } for the email body
//     quoteId            the quote_log id, when the quote is in the log
//     customer           { name, contactName, email } or null
//     validHours         how long a quote is good for (Profile → PDF quotes; 24 unless Pro Max sets it)
//     canChangeValidity  whether this account can change that (Pro Max, API, comp)
//     whiteLabel         whether the email goes out without the QuickFreightCalc name
//     sections           { transit, accessorials } as Profile has them, for switches in the window
//                        (Modern quotes; null hides them). build() gets { sections, meta } back.
//     hasAccessorials    whether Profile has any accessorial rates to show
//     onSent(result)
//   }) → Promise<{ to, id, sentAt, quoteId, number } | null>   (null if closed without sending)
//
//   QFCEmailQuote.makePdf(html) → Promise<string>   the PDF, base64
//
// The PDF libraries (vendor/) load the first time a quote is emailed.
(function () {
  'use strict';
  const FN = '/.netlify/functions/send-quote-email';
  const LIBS = ['/vendor/html2canvas-1.4.1.min.js', '/vendor/jspdf-4.2.1.umd.min.js'];
  const SUPABASE_URL = 'https://xgrmbhmgcsbnazupfybd.supabase.co';
  const SUPABASE_KEY = 'sb_publishable_zSa4XpzakcntdkZfTzUPlg_FigYcISZ';
  const PAGE_PX = 816;   // 8.5in at 96 px per inch: the width the quote documents are laid out for

  const esc = (s) => (s === null || s === undefined ? '' : String(s))
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  const tidy = (s) => String(s === null || s === undefined ? '' : s).trim().replace(/\s+/g, ' ');
  const EMAIL_RE = /^[^\s@,;<>]+@[^\s@,;<>]+\.[^\s@,;<>]{2,}$/;

  // ── Who's signed in (the same keys the other pages use) ──────────────────
  function sessionEntry() {
    const keys = Object.keys(localStorage).filter((k) => k.indexOf('sb-') === 0).concat('qfc_session');
    for (const k of keys) {
      try {
        const v = JSON.parse(localStorage.getItem(k) || '{}');
        if (v && v.access_token) return { key: k, val: v };
      } catch (e) {}
    }
    return null;
  }
  function profile() {
    try { return JSON.parse(localStorage.getItem('qfc_pro_profile') || '{}') || {}; } catch (e) { return {}; }
  }

  // A fresh access token (refreshing it when it's about to run out).
  async function accessToken() {
    const s = sessionEntry();
    if (!s) return null;
    const exp = Number(s.val.expires_at || 0) * 1000;
    if (exp && exp - Date.now() > 60000) return s.val.access_token;
    if (!s.val.refresh_token) return s.val.access_token;
    try {
      if (typeof window.refreshSession === 'function') {
        const v = await window.refreshSession(s.key, s.val);
        if (v && v.access_token) return v.access_token;
      } else {
        const resp = await fetch(SUPABASE_URL + '/auth/v1/token?grant_type=refresh_token', {
          method: 'POST', headers: { 'Content-Type': 'application/json', apikey: SUPABASE_KEY },
          body: JSON.stringify({ refresh_token: s.val.refresh_token }),
        });
        const d = await resp.json();
        if (d && d.access_token) {
          localStorage.setItem(s.key, JSON.stringify({ access_token: d.access_token, refresh_token: d.refresh_token || s.val.refresh_token,
            expires_at: Math.floor(Date.now() / 1000) + (d.expires_in || 3600), user: d.user || s.val.user }));
          return d.access_token;
        }
      }
    } catch (e) {}
    return s.val.access_token;
  }

  // ── The PDF ───────────────────────────────────────────────────────────────
  let libs = null;
  function loadScript(src) {
    return new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = src;
      s.onload = resolve;
      s.onerror = () => reject(new Error('Could not load ' + src));
      document.head.appendChild(s);
    });
  }
  function loadLibs() {
    if (window.html2canvas && window.jspdf) return Promise.resolve();
    if (!libs) libs = LIBS.reduce((p, src) => p.then(() => loadScript(src)), Promise.resolve()).catch((e) => { libs = null; throw e; });
    return libs;
  }

  // Lays the document out at letter width in a hidden frame, draws the sheet,
  // and puts it on letter pages. Returns the PDF as base64.
  async function makePdf(html) {
    await loadLibs();
    const frame = document.createElement('iframe');
    frame.setAttribute('aria-hidden', 'true');
    frame.setAttribute('sandbox', 'allow-same-origin');   // readable for drawing, but nothing in it runs
    frame.tabIndex = -1;
    frame.style.cssText = `position:fixed;left:-${PAGE_PX * 3}px;top:0;width:${PAGE_PX}px;height:1056px;border:0;opacity:0;pointer-events:none`;
    document.body.appendChild(frame);
    try {
      await new Promise((resolve) => { frame.onload = resolve; frame.srcdoc = html; });
      const doc = frame.contentDocument;
      // What only makes sense on screen: the print buttons, and the grey page around the sheet
      doc.querySelectorAll('.btn-print, .screen-controls, .controls, .no-print, [data-no-pdf]').forEach((el) => el.remove());
      doc.documentElement.style.background = '#ffffff';
      doc.body.style.padding = '0';
      doc.body.style.background = '#ffffff';
      const target = doc.querySelector('[data-pdf-page]') || doc.querySelector('.doc') || doc.body;
      target.style.boxShadow = 'none';
      target.style.borderRadius = '0';
      if (doc.fonts && doc.fonts.ready) { try { await doc.fonts.ready; } catch (e) {} }
      await Promise.all(Array.from(doc.images).map((img) => (img.complete ? null : new Promise((r) => { img.onload = img.onerror = r; }))));
      const canvas = await window.html2canvas(target, { scale: 2, backgroundColor: '#ffffff', logging: false, useCORS: true, windowWidth: PAGE_PX });
      const pdf = new window.jspdf.jsPDF({ unit: 'pt', format: 'letter', compress: true });
      const W = pdf.internal.pageSize.getWidth(), H = pdf.internal.pageSize.getHeight();
      const k = W / canvas.width;                       // points per canvas pixel, at full page width
      // A sheet up to 30% taller than a page (the Classic designs) is shrunk onto one page;
      // a long one (long notes or terms) runs onto more pages.
      if (canvas.height * k <= H * 1.3) {
        const fit = Math.min(k, H / canvas.height);
        const w = canvas.width * fit, h = canvas.height * fit;
        pdf.addImage(canvas.toDataURL('image/jpeg', 0.92), 'JPEG', (W - w) / 2, 0, w, h);
        return pdf.output('datauristring').split(',')[1];
      }
      const TOP = 36;                                   // pages after the first get a half-inch top margin
      const src = canvas.getContext('2d');
      for (let y = 0, page = 0; y < canvas.height; page++) {
        const pageH = Math.floor((page ? H - TOP : H) / k);   // canvas pixels that fit on this page
        // Break the page on a blank row, so no line of text is cut in half
        let h = Math.min(pageH, canvas.height - y);
        if (y + h < canvas.height) h = quietRow(src, canvas.width, y + Math.floor(pageH * 0.8), y + h) - y;
        if (page && h < 40) break;                      // a sliver of empty margin isn't worth a page
        const slice = document.createElement('canvas');
        slice.width = canvas.width;
        slice.height = h;
        const ctx = slice.getContext('2d');
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(0, 0, slice.width, h);
        ctx.drawImage(canvas, 0, -y);
        if (page) pdf.addPage();
        pdf.addImage(slice.toDataURL('image/jpeg', 0.92), 'JPEG', 0, page ? TOP : 0, W, h * k);
        y += h;
      }
      return pdf.output('datauristring').split(',')[1];
    } finally {
      frame.remove();
    }
  }
  // The lowest blank (near-white) pixel row between `from` and `to`, or `to` if there's none.
  function quietRow(ctx, width, from, to) {
    const rows = ctx.getImageData(0, from, width, to - from).data;
    for (let r = to - from - 1; r >= 0; r--) {
      let blank = true;
      for (let x = 0; x < width; x += 3) {
        const i = (r * width + x) * 4;
        if (rows[i] < 245 || rows[i + 1] < 245 || rows[i + 2] < 245) { blank = false; break; }
      }
      if (blank) return from + r;
    }
    return to;
  }

  // ── Wording ───────────────────────────────────────────────────────────────
  const firstName = (s) => tidy(s).split(' ')[0] || '';
  const laneText = (sum) => [sum.origin, sum.destination].filter(Boolean).join(' to ');
  function defaultSubject(sum) {
    const lane = laneText(sum);
    return lane ? `Rate quote: ${lane}` : 'Rate quote';
  }
  function defaultMessage(sum, customer) {
    const hi = customer && firstName(customer.contactName) ? `Hi ${firstName(customer.contactName)},` : 'Hi,';
    const lane = laneText(sum);
    return `${hi}\n\nHere's our quote${lane ? ` for ${lane}` : ''}. The details are below, and the full quote is attached as a PDF.\n\nThanks!`;
  }
  // "Nov 13, 2026, 5:00 PM EST" in the user's own time zone
  function whenText(d) {
    return d.toLocaleString('en-US', { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit', timeZoneName: 'short' });
  }
  // The time zone's short name ("EST"), so a customer elsewhere reads the time right
  function tzName(d) {
    try { return d.toLocaleTimeString('en-US', { timeZoneName: 'short' }).split(' ').pop() || ''; } catch (e) { return ''; }
  }
  const hoursText = (h) => (h === 168 ? '7 days' : h + ' hours');
  function safeFilename(name) {
    const base = tidy(name || 'Quote').replace(/\.pdf$/i, '').replace(/[^A-Za-z0-9 ._-]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 70) || 'Quote';
    return base + '.pdf';
  }
  function newKey() {
    try { if (crypto.randomUUID) return crypto.randomUUID(); } catch (e) {}
    return 'k' + Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
  }

  // ── Styles (each page's own colors) ───────────────────────────────────────
  let styled = false;
  function injectCSS() {
    if (styled) return;
    styled = true;
    const css = `
.qfce-overlay{position:fixed;inset:0;z-index:10070;background:rgba(0,0,0,.7);backdrop-filter:blur(4px);display:flex;align-items:center;justify-content:center;padding:20px;font-family:'Space Grotesk',sans-serif}
.qfce-overlay[hidden]{display:none}
.qfce-modal{background:var(--panel,#1f2330);border:1px solid var(--border,rgba(255,255,255,.07));border-radius:16px;max-width:540px;width:100%;max-height:calc(100vh - 40px);overflow-y:auto;box-shadow:0 24px 60px rgba(0,0,0,.5)}
.qfce-head{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:16px 22px;border-bottom:1px solid var(--border,rgba(255,255,255,.07))}
.qfce-title{font-size:14px;font-weight:700;color:var(--text,#fff)}
.qfce-x{font-size:18px;line-height:1;background:none;border:none;color:var(--text3,#8896a8);cursor:pointer;padding:2px 6px;border-radius:6px}
.qfce-body{padding:12px 22px 20px}
.qfce-lane{font-size:12px;color:var(--text3,#8896a8);line-height:1.5;padding:2px 0 4px}
.qfce-lane b{color:var(--text,#fff);font-weight:600}
.qfce-body label{display:block;font-size:11px;font-weight:600;color:var(--text2,#b0c4d8);margin-top:11px}
.qfce-body label span{font-weight:400;color:var(--text3,#8896a8)}
.qfce-body input[type=email],.qfce-body input[type=text],.qfce-body textarea{display:block;width:100%;margin-top:5px;background:var(--card2,#272c38);border:1px solid var(--border2,rgba(255,255,255,.12));border-radius:8px;color:var(--text,#fff);font-family:'Space Grotesk',sans-serif;font-size:13px;padding:8px 12px;outline:none;resize:vertical;line-height:1.45}
.qfce-body input:focus,.qfce-body textarea:focus{border-color:var(--accent,#f0a500)}
.qfce-body input[aria-invalid=true]{border-color:var(--red,#f87171)}
.qfce-check{display:flex!important;align-items:center;gap:8px;font-size:12px!important;font-weight:500!important;color:var(--text2,#b0c4d8)!important;padding:4px 0 10px;cursor:pointer}
.qfce-check input{width:15px;height:15px;margin:0;accent-color:var(--accent-fill,#f5a524)}
.qfce-sections{display:flex;flex-wrap:wrap;align-items:center;gap:0 18px;margin:-4px 0 8px}
.qfce-sections[hidden]{display:none}
.qfce-sec-label{width:100%;font-size:11px;font-weight:600;color:var(--text2,#b0c4d8);margin-bottom:2px}
.qfce-sections .qfce-check{padding:3px 0}
.qfce-sec-hint{font-weight:400;color:var(--text3,#8896a8)}
.qfce-check input:disabled{cursor:default}
.qfce-valid{font-size:12px;color:var(--text2,#b0c4d8);line-height:1.5;padding:9px 12px;border-radius:8px;background:var(--accentbg,rgba(245,165,36,.1))}
.qfce-valid b{color:var(--text,#fff);font-weight:600}
.qfce-help{font-size:11px;color:var(--text3,#8896a8);line-height:1.5;margin-top:12px}
.qfce-help b{color:var(--text2,#b0c4d8);font-weight:600}
.qfce-actions{display:flex;align-items:center;gap:8px;margin-top:16px}
.qfce-status{flex:1;font-size:11.5px;color:var(--red,#f87171);line-height:1.4}
.qfce-status.busy{color:var(--text3,#8896a8)}
.qfce-btn{font-family:'Space Grotesk',sans-serif;font-size:12px;font-weight:700;padding:8px 16px;border-radius:8px;border:1px solid var(--border2,rgba(255,255,255,.12));background:transparent;color:var(--text2,#b0c4d8);cursor:pointer;white-space:nowrap}
.qfce-send{background:var(--accent-fill,var(--accent,#f0a500));border-color:var(--accent-fill,var(--accent,#f0a500));color:#1b1305}
.qfce-send:disabled{opacity:.6;cursor:default}
.qfce-done{text-align:center;padding:26px 22px 24px}
.qfce-done[hidden],.qfce-form[hidden]{display:none}
.qfce-tick{width:44px;height:44px;border-radius:50%;margin:0 auto 12px;display:grid;place-items:center;background:var(--accentbg,rgba(245,165,36,.12));color:var(--accent,#f5a524);font-size:22px;font-weight:700}
.qfce-done-title{font-size:15px;font-weight:700;color:var(--text,#fff)}
.qfce-done-sub{font-size:12px;color:var(--text3,#8896a8);margin:6px 0 18px;line-height:1.5;overflow-wrap:anywhere}`;
    const el = document.createElement('style');
    el.textContent = css;
    document.head.appendChild(el);
  }

  // ── The window ────────────────────────────────────────────────────────────
  let ui = null;
  function build() {
    if (ui) return ui;
    injectCSS();
    const wrap = document.createElement('div');
    wrap.className = 'qfce-overlay';
    wrap.id = 'qfce-dialog';
    wrap.hidden = true;
    wrap.innerHTML = `
      <div class="qfce-modal" role="dialog" aria-modal="true" aria-labelledby="qfce-title">
        <div class="qfce-head"><div class="qfce-title" id="qfce-title">Email quote</div><button type="button" class="qfce-x" aria-label="Close">✕</button></div>
        <form class="qfce-body qfce-form" novalidate>
          <div class="qfce-lane"></div>
          <label>To<input name="to" type="email" maxlength="200" autocomplete="off" placeholder="customer@example.com" /></label>
          <label>Subject<input name="subject" type="text" maxlength="150" autocomplete="off" /></label>
          <label>Message <span>(your name and contact details are added below it)</span><textarea name="message" rows="6" maxlength="2000"></textarea></label>
          <label class="qfce-check"><input name="ccMe" type="checkbox" /> Send me a copy</label>
          <div class="qfce-sections" hidden>
            <div class="qfce-sec-label">On the quote</div>
            <label class="qfce-check"><input name="secTransit" type="checkbox" /> Transit estimate</label>
            <label class="qfce-check"><input name="secAcc" type="checkbox" /> Accessorial charges <span class="qfce-sec-hint"></span></label>
          </div>
          <div class="qfce-valid"></div>
          <div class="qfce-help"></div>
          <div class="qfce-actions">
            <span class="qfce-status" role="status" aria-live="polite"></span>
            <button type="button" class="qfce-btn qfce-cancel">Cancel</button>
            <button type="submit" class="qfce-btn qfce-send">Send quote</button>
          </div>
        </form>
        <div class="qfce-done" hidden>
          <div class="qfce-tick" aria-hidden="true">✓</div>
          <div class="qfce-done-title">Quote sent</div>
          <div class="qfce-done-sub"></div>
          <button type="button" class="qfce-btn qfce-send qfce-close">Done</button>
        </div>
      </div>`;
    document.body.appendChild(wrap);
    const form = wrap.querySelector('form');
    const f = form.elements;
    const status = wrap.querySelector('.qfce-status');
    const sendBtn = form.querySelector('.qfce-send');
    const done = wrap.querySelector('.qfce-done');
    let current = null;   // { opts, resolve, result, busy, built, pdf }

    function say(text, busy) {
      status.textContent = text || '';
      status.classList.toggle('busy', !!busy);
    }
    function finish() {
      if (current && current.busy) return;   // let a send finish first
      wrap.hidden = true;
      const c = current;
      current = null;
      if (c) c.resolve(c.result || null);
    }
    wrap.querySelector('.qfce-x').onclick = finish;
    wrap.querySelector('.qfce-cancel').onclick = finish;
    wrap.querySelector('.qfce-close').onclick = finish;
    wrap.addEventListener('mousedown', (e) => { if (e.target === wrap) finish(); });
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !wrap.hidden) finish(); });
    f.to.addEventListener('input', () => f.to.removeAttribute('aria-invalid'));
    f.ccMe.addEventListener('change', () => { try { localStorage.setItem('qfc_email_cc', f.ccMe.checked ? '1' : '0'); } catch (e) {} });

    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      if (!current || current.busy) return;
      const c = current;
      const o = c.opts;
      const to = tidy(f.to.value).toLowerCase();
      const subject = tidy(f.subject.value);
      const message = String(f.message.value || '').replace(/\r\n/g, '\n').trim();
      if (!EMAIL_RE.test(to)) { f.to.setAttribute('aria-invalid', 'true'); f.to.focus(); say('Enter the customer’s email address.'); return; }
      if (!subject) { f.subject.focus(); say('Add a subject.'); return; }

      c.busy = true;
      sendBtn.disabled = true;
      try {
        say('Making the PDF…', true);
        // The quote document and its number are made once: a retry after a failed send keeps the
        // number, and so does a change to the section switches (the page is made again).
        const sections = o.sections ? { transit: f.secTransit.checked, accessorials: f.secAcc.checked } : null;
        const key = JSON.stringify(sections);
        if (!c.built || c.builtKey !== key) {
          const doc = typeof o.build === 'function' ? o.build({ sections, meta: c.built ? c.built.doc.meta : undefined }) : null;
          if (!doc || !doc.html) throw new Error('Finish the quote first, then email it.');
          if (c.built) {
            c.built.doc = doc;
          } else {
            const hours = Number(o.validHours) > 0 ? Number(o.validHours) : 24;
            const validDate = new Date(Date.now() + hours * 3600000);
            c.built = { doc, validDate, validLabel: doc.validUntil ? `${doc.validUntil} ${tzName(validDate)}`.trim() : whenText(validDate) };
          }
          c.builtKey = key;
          c.pdf = null;
        }
        if (!c.pdf) {
          try { c.pdf = await makePdf(c.built.doc.html); } catch (err) { throw new Error('Couldn’t make the PDF. Try again, or download it and attach it yourself.'); }
        }
        say('Sending…', true);
        const token = await accessToken();
        if (!token) throw new Error('Sign in again to send quotes.');
        const number = c.built.doc.number || '';
        let resp, data = null;
        try {
          resp = await fetch(FN, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
            body: JSON.stringify({
              to, subject, message, ccMe: f.ccMe.checked, quoteId: o.quoteId || null,
              validUntil: c.built.validDate.toISOString(), validLabel: c.built.validLabel,
              filename: safeFilename(number ? `Quote ${number}` : 'Quote'), pdf: c.pdf,
              summary: Object.assign({}, o.summary || {}, number ? { quoteNumber: number } : {}),
              sendKey: newKey(),
            }),
          });
          try { data = await resp.json(); } catch (err) {}
        } catch (err) {
          throw new Error('Couldn’t reach the server. Check your connection and try again.');
        }
        if (!resp.ok) {
          const m = (data && data.message) || '';
          if (resp.status === 401) throw new Error('Your sign-in expired. Sign in again, then send.');
          if (resp.status === 403) throw new Error(m || 'Emailing quotes comes with Pro Plus and up.');
          if (resp.status === 429) throw new Error(m || 'You’ve reached today’s limit for emailed quotes.');
          if (resp.status === 400 || resp.status === 413) {
            if (data && data.field === 'to') { f.to.setAttribute('aria-invalid', 'true'); f.to.focus(); }
            throw new Error(m || 'Check the details and try again.');
          }
          throw new Error(m || 'Couldn’t send the quote right now. Try again in a minute.');
        }
        c.result = { to, id: data && data.id, sentAt: (data && data.sentAt) || new Date().toISOString(), quoteId: o.quoteId || null, ccMe: f.ccMe.checked, number: number || null };
        c.busy = false;
        say('');
        form.hidden = true;
        done.hidden = false;
        done.querySelector('.qfce-done-sub').textContent = `Sent to ${to}${f.ccMe.checked ? ', with a copy to you' : ''}. Replies come straight to you.`;
        done.querySelector('.qfce-close').focus();
        if (typeof o.onSent === 'function') { try { o.onSent(c.result); } catch (err) {} }
      } catch (err) {
        say(err.message || 'Couldn’t send the quote.');
      } finally {
        c.busy = false;
        sendBtn.disabled = false;
      }
    });

    ui = {
      open(opts) {
        return new Promise((resolve) => {
          if (current) { const c = current; current = null; c.resolve(null); }
          current = { opts, resolve, result: null, busy: false, built: null, builtKey: null, pdf: null };
          const sum = opts.summary || {};
          const cust = opts.customer || null;
          const p = profile();
          const company = tidy(p.companyName) || tidy(p.contactName);
          const s = sessionEntry();
          const me = tidy((s && s.val.user && s.val.user.email) || p.email || '');
          form.hidden = false;
          done.hidden = true;
          say('');
          f.to.removeAttribute('aria-invalid');
          f.to.value = (cust && cust.email) || '';
          f.subject.value = defaultSubject(sum);
          f.message.value = defaultMessage(sum, cust);
          let cc = false;
          try { cc = localStorage.getItem('qfc_email_cc') === '1'; } catch (e) {}
          f.ccMe.checked = cc;
          const secs = opts.sections;
          wrap.querySelector('.qfce-sections').hidden = !secs;
          f.secTransit.checked = !!(secs && secs.transit);
          f.secAcc.disabled = !opts.hasAccessorials;
          f.secAcc.checked = !!(secs && secs.accessorials && opts.hasAccessorials);
          wrap.querySelector('.qfce-sec-hint').textContent = opts.hasAccessorials ? '' : '(add your rates under Profile → Quote sections)';
          const lane = [sum.origin, sum.destination].filter(Boolean).map(esc).join(' → ');
          wrap.querySelector('.qfce-lane').innerHTML = [
            lane ? `<b>${lane}</b>` : '', [esc(sum.equipment), esc(sum.rate)].filter(Boolean).join(' · '),
            cust && cust.name ? `For ${esc(cust.name)}` : '',
          ].filter(Boolean).join('<br>');
          const hours = Number(opts.validHours) > 0 ? Number(opts.validHours) : 24;
          const until = new Date(Date.now() + hours * 3600000);
          wrap.querySelector('.qfce-valid').innerHTML = `Good for <b>${esc(hoursText(hours))}</b>, until about <b>${esc(whenText(until))}</b>. That’s printed on the quote and in the email.` +
            (opts.canChangeValidity ? ' Change it under Profile → PDF quotes.' : '');
          const sender = company ? (opts.whiteLabel ? company : `${company} via QuickFreightCalc`) : 'QuickFreightCalc Quotes';
          wrap.querySelector('.qfce-help').innerHTML = `Sends as <b>${esc(sender)}</b> from quotes@quickfreightcalc.com, with your quote attached as a PDF.` +
            (me ? ` Replies go to you at <b>${esc(me)}</b>.` : ' Replies go to you.');
          wrap.hidden = false;
          (f.to.value ? f.message : f.to).focus();
        });
      },
    };
    return ui;
  }

  window.QFCEmailQuote = {
    open: (opts) => build().open(opts || {}),
    makePdf,
  };
})();
