// pdf-quote.js — the Modern quote PDFs, the default design for single-lane
// quotes (calculator and quote log, index.html), multi-stop quotes
// (multistop.html) and bulk load quotes (bulk.html). The Classic designs are
// the original templates in those pages, kept exactly as they were for anyone
// who chooses "Classic" on their Profile (profile.pdfStyle).
//
// Like Classic, each opens a print-ready page in a new tab; the browser's
// "Print / Save as PDF" makes the PDF.
//
// Colors: the profile's color scheme (profile.colorScheme), or 'custom' with
// the user's own accent and heading colors (profile.pdfAccent / pdfInk, #rrggbb).
// classicScheme() gives the Classic templates the same custom colors.
(function () {
  'use strict';

  // Per color scheme (same ids as profile.html): ink for headings and the
  // total on white paper, accent for the rule, lane line and price panel edge.
  // Accents are the stronger end of each scheme's header bar, so they read on white.
  var SCHEMES = {
    midnight:  { ink: '#1a1f2e', accent: '#f0a500' },
    slate:     { ink: '#1e2535', accent: '#3b82f6' },
    forest:    { ink: '#14281d', accent: '#22c55e' },
    steel:     { ink: '#1c2228', accent: '#ea580c' },
    executive: { ink: '#0d0d0d', accent: '#94a3b8' },
    crimson:   { ink: '#1f0d0d', accent: '#dc2626' },
    ocean:     { ink: '#0c1f2e', accent: '#0891b2' },
    carbon:    { ink: '#111111', accent: '#16a34a' },
    paper:     { ink: '#1a2540', accent: '#8a6a1a' },
    mist:      { ink: '#1a202c', accent: '#2d3748' },
    sand:      { ink: '#4a2412', accent: '#8b3a1f' },
    arctic:    { ink: '#0b2d38', accent: '#0f3d4c' },
  };
  var DEFAULT_INK = '#1a1f2e';
  var DEFAULT_ACCENT = '#f0a500';
  var HEX = /^#[0-9a-fA-F]{6}$/;
  var TRAILERS = { van: 'Dry Van', reefer: 'Reefer', flatbed: 'Flatbed' };

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }
  function dollars(n) { return '$' + Math.round(n).toLocaleString('en-US'); }
  function cents(n) { return '$' + n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }); }

  // Relative luminance of #rrggbb, 0 (black) to 1 (white).
  function luminance(hex) {
    var c = [1, 3, 5].map(function (i) {
      var v = parseInt(hex.slice(i, i + 2), 16) / 255;
      return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
    });
    return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
  }

  // The user's own colors, if they chose Custom and they're valid #rrggbb.
  function customColors(profile) {
    if (!profile || profile.colorScheme !== 'custom') return null;
    return {
      accent: HEX.test(profile.pdfAccent || '') ? profile.pdfAccent : DEFAULT_ACCENT,
      ink: HEX.test(profile.pdfInk || '') ? profile.pdfInk : DEFAULT_INK,
    };
  }

  // Colors for the Modern PDFs. A custom heading color too light to read on
  // white paper falls back to near-black (it still colors the Classic header).
  function colorsFor(profile) {
    var custom = customColors(profile);
    if (custom) {
      return { accent: custom.accent, ink: luminance(custom.ink) > 0.45 ? '#1f2937' : custom.ink };
    }
    return SCHEMES[profile && profile.colorScheme] || SCHEMES.midnight;
  }

  // Custom colors in the shape the Classic templates use (header background,
  // accent, bar and header text tones), or null for the built-in schemes.
  function classicScheme(profile) {
    var c = customColors(profile);
    if (!c) return null;
    var light = luminance(c.ink) > 0.45;
    var rgb = light ? '26,32,44' : '255,255,255';
    return {
      header: c.ink,
      accent: c.accent,
      bar: 'linear-gradient(to right,' + c.accent + ',' + c.accent + ',' + c.accent + ')',
      headerText: light ? '#1a202c' : '#ffffff',
      headerTextSoft: 'rgba(' + rgb + ',' + (light ? '.58' : '.4') + ')',
      headerTextFaint: 'rgba(' + rgb + ',' + (light ? '.48' : '.35') + ')',
    };
  }

  // The style a profile asked for: 'classic' or 'modern' (the default).
  function style(profile) {
    return profile && profile.pdfStyle === 'classic' ? 'classic' : 'modern';
  }

  // Quote number and dates, numbered the same way as the Classic PDFs
  // (PREFIX-YYYYMMDD-counter, or PREFIX-TAG-YYYYMMDD-counter), advancing the
  // counter in the saved profile when `persist` is set.
  function nextQuoteNumber(profile, persist, tag) {
    var now = new Date();
    var prefix = String(profile.quotePrefix || 'QFC').toUpperCase();
    var num = profile.quoteStart || 1001;
    var ymd = now.getFullYear() + String(now.getMonth() + 1).padStart(2, '0') + String(now.getDate()).padStart(2, '0');
    if (persist) {
      try {
        profile.quoteStart = num + 1;
        localStorage.setItem('qfc_pro_profile', JSON.stringify(profile));
      } catch (e) {}
    }
    var valid = new Date(now.getTime() + 24 * 60 * 60 * 1000);
    return {
      number: prefix + '-' + (tag ? tag + '-' : '') + ymd + '-' + num,
      issued: now.toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' }),
      validUntil: valid.toLocaleString('en-US', { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' }),
    };
  }

  // ── Shared pieces ──────────────────────────────────────────────────────────
  function css(s) {
    return '*{box-sizing:border-box;margin:0;padding:0}\n' +
      'body{background:#e9edf2;font-family:Inter,"Segoe UI",Helvetica,Arial,sans-serif;color:#1f2937;padding:32px 16px;-webkit-font-smoothing:antialiased}\n' +
      '.controls{max-width:816px;margin:0 auto 18px;display:flex;gap:12px;align-items:center;flex-wrap:wrap}\n' +
      '.controls button{font:600 13px Inter,sans-serif;padding:10px 20px;border-radius:8px;border:0;background:' + s.ink + ';color:#fff;cursor:pointer}\n' +
      '.controls span{font-size:12px;color:#6b7280}\n' +
      '.doc{max-width:816px;margin:0 auto;background:#fff;box-shadow:0 6px 40px rgba(15,23,42,.12);border-radius:6px;padding:52px 56px 40px;min-height:1056px;display:flex;flex-direction:column}\n' +
      '.k{font-size:10px;font-weight:600;letter-spacing:.09em;text-transform:uppercase;color:#6b7280;margin-bottom:5px}\n' +
      'header{display:flex;justify-content:space-between;align-items:flex-start;gap:24px}\n' +
      '.brand{display:flex;align-items:center;gap:14px;min-width:0}\n' +
      '.logo{max-height:56px;max-width:180px;object-fit:contain}\n' +
      '.mark{width:48px;height:48px;border-radius:10px;background:' + s.ink + ';color:#fff;font-weight:800;font-size:22px;display:flex;align-items:center;justify-content:center;flex-shrink:0;-webkit-print-color-adjust:exact;print-color-adjust:exact}\n' +
      '.company{font-size:20px;font-weight:700;color:' + s.ink + ';letter-spacing:-.01em;line-height:1.2}\n' +
      '.tagline{font-size:11px;color:#6b7280;margin-top:3px}\n' +
      '.doc-id{text-align:right;flex-shrink:0}\n' +
      '.title{font-size:26px;font-weight:800;color:' + s.ink + ';letter-spacing:-.02em;margin-bottom:8px}\n' +
      '.meta{border-collapse:collapse;margin-left:auto;font-size:12px}\n' +
      '.meta td{padding:2px 0 2px 14px;color:#374151;white-space:nowrap}\n' +
      '.meta td:first-child{color:#6b7280}\n' +
      '.contact{margin-top:14px;font-size:11.5px;color:#4b5563}\n' +
      '.contact .dot{color:#c7ced8;margin:0 8px}\n' +
      '.rule{height:3px;background:' + s.accent + ';border-radius:2px;margin:18px 0 26px;-webkit-print-color-adjust:exact;print-color-adjust:exact}\n' +
      '.lane{display:flex;align-items:center;gap:18px;margin-bottom:22px}\n' +
      '.stop{flex:1;min-width:0}\n' +
      '.stop.right{text-align:right}\n' +
      '.city{font-size:22px;font-weight:700;color:#111827;letter-spacing:-.01em;line-height:1.25;overflow-wrap:anywhere}\n' +
      '.date{font-size:12.5px;color:#4b5563;margin-top:4px}\n' +
      '.leg{flex:0 0 150px;text-align:center}\n' +
      '.leg .mi{font-size:13px;font-weight:700;color:' + s.ink + '}\n' +
      '.leg .sub{font-size:11px;color:#6b7280}\n' +
      '.leg .track{position:relative;height:2px;background:' + s.accent + ';margin:8px 4px;-webkit-print-color-adjust:exact;print-color-adjust:exact}\n' +
      '.leg .track:before,.leg .track:after{content:"";position:absolute;top:-4px;width:10px;height:10px;border-radius:50%;background:#fff;border:2px solid ' + s.accent + '}\n' +
      '.leg .track:before{left:-6px}.leg .track:after{right:-6px;background:' + s.accent + '}\n' +
      '.facts{display:flex;border-top:1px solid #e5e7eb;border-bottom:1px solid #e5e7eb;margin-bottom:22px}\n' +
      '.fact{flex:1;padding:14px 16px 14px 0}\n' +
      '.fact + .fact{padding-left:16px;border-left:1px solid #e5e7eb}\n' +
      '.fact .v{font-size:14px;font-weight:600;color:#111827}\n' +
      '.rate{border:1px solid #e5e7eb;border-left:4px solid ' + s.accent + ';border-radius:8px;padding:18px 22px;margin-bottom:22px;-webkit-print-color-adjust:exact;print-color-adjust:exact}\n' +
      '.line-item{display:flex;justify-content:space-between;gap:16px;font-size:13px;color:#374151;padding:4px 0}\n' +
      '.line-item span:last-child{font-variant-numeric:tabular-nums;white-space:nowrap}\n' +
      '.line-item small{display:block;font-size:11px;color:#6b7280}\n' +
      '.total-row{display:flex;justify-content:space-between;align-items:flex-end;gap:16px}\n' +
      '.has-lines .total-row{border-top:1px solid #e5e7eb;margin-top:10px;padding-top:12px}\n' +
      '.total{font-size:38px;font-weight:800;color:' + s.ink + ';letter-spacing:-.02em;line-height:1;font-variant-numeric:tabular-nums}\n' +
      '.total-sub{font-size:12px;color:#4b5563;margin-top:6px}\n' +
      '.rpm{font-size:13px;color:#4b5563;text-align:right}\n' +
      '.rpm strong{display:block;font-size:16px;color:#111827}\n' +
      '.rpm em{display:block;font-style:normal;font-size:11px;color:#6b7280;margin-top:4px}\n' +
      '.section{margin-bottom:22px}\n' +
      '.stops{border-top:1px solid #e5e7eb}\n' +
      '.s-row{display:grid;grid-template-columns:14px 104px minmax(0,1fr) auto;align-items:center;gap:12px;padding:9px 0;border-bottom:1px solid #eef0f3}\n' +
      '.s-dot{width:12px;height:12px;border-radius:50%;border:2px solid ' + s.accent + ';background:#fff;-webkit-print-color-adjust:exact;print-color-adjust:exact}\n' +
      '.s-row.delivery .s-dot{background:' + s.accent + '}\n' +
      '.s-kind{font-size:10px;font-weight:600;letter-spacing:.09em;text-transform:uppercase;color:#6b7280;line-height:1.3}\n' +
      '.s-place{font-size:14px;font-weight:700;color:#111827;overflow-wrap:anywhere}\n' +
      '.s-chip{display:inline-block;font-size:9.5px;font-weight:600;color:' + s.ink + ';border:1px solid ' + s.accent + ';border-radius:10px;padding:0 7px;margin-left:8px;vertical-align:2px}\n' +
      '.s-meta{font-size:11.5px;color:#4b5563;margin-top:1px}\n' +
      '.s-leg{font-size:11.5px;color:#4b5563;text-align:right;white-space:nowrap}\n' +
      '.s-leg small{display:block;font-size:10px;color:#9ca3af}\n' +
      '.status{border-radius:8px;padding:12px 16px;font-size:12.5px;line-height:1.55;-webkit-print-color-adjust:exact;print-color-adjust:exact}\n' +
      '.status strong{display:block;font-size:14px;margin-bottom:2px}\n' +
      '.status.good{background:#ecfdf3;color:#14532d;border:1px solid #a7e3bd}\n' +
      '.status.short{background:#fff8eb;color:#7a4b00;border:1px solid #f3d38a}\n' +
      '.notes-text{font-size:13px;line-height:1.6;color:#374151;background:#f9fafb;border-radius:8px;padding:12px 16px;-webkit-print-color-adjust:exact;print-color-adjust:exact}\n' +
      '.terms{font-size:11.5px;color:#6b7280;line-height:1.6;margin-bottom:26px}\n' +
      '.sign{display:flex;gap:36px;margin-top:auto;margin-bottom:28px}\n' +
      '.sig{flex:1}\n' +
      '.sig .line{border-bottom:1px solid #111827;height:34px}\n' +
      '.sig .lbl{font-size:10.5px;color:#6b7280;margin-top:6px}\n' +
      '.sig .lbl strong{color:#374151;font-weight:600}\n' +
      'footer{display:flex;justify-content:space-between;gap:16px;font-size:10px;color:#9ca3af;border-top:1px solid #f0f2f5;padding-top:12px;margin-top:auto}\n' +
      '.sign + footer{margin-top:0}\n' +
      '@media print{\n' +
      '  @page{size:letter portrait;margin:0}\n' +
      '  body{background:#fff;padding:0}\n' +
      '  .controls{display:none!important}\n' +
      '  .doc{box-shadow:none;border-radius:0;max-width:none;min-height:100vh;padding:0.55in 0.6in 0.45in}\n' +
      '  .lane,.facts,.rate,.sign,.s-row{break-inside:avoid;page-break-inside:avoid}\n' +
      '}\n';
  }

  function letterhead(profile, s, title, meta) {
    var company = profile.companyName || '';
    var showLogo = !profile.hideLogo && profile.logoBase64;
    var brand = showLogo
      ? '<img class="logo" src="' + esc(profile.logoBase64) + '" alt="" />'
      : '<div class="mark">' + esc((company || 'Q').trim().charAt(0).toUpperCase()) + '</div>';
    var brandText = company
      ? '<div class="company">' + esc(company) + '</div>' + (profile.footerText ? '<div class="tagline">' + esc(profile.footerText) + '</div>' : '')
      : '<div class="company">Quick<span style="color:' + s.accent + '">Freight</span>Calc</div><div class="tagline">Freight Rate Calculator</div>';
    var contact = [
      profile.contactName,
      profile.phone,
      profile.email,
      profile.mcNumber ? 'MC# ' + profile.mcNumber : '',
      profile.dotNumber ? 'DOT# ' + profile.dotNumber : '',
    ].filter(Boolean).map(esc).join('<span class="dot">·</span>');
    return '<header>\n' +
      '  <div class="brand">' + brand + '<div>' + brandText + '</div></div>\n' +
      '  <div class="doc-id"><div class="title">' + esc(title) + '</div>' +
      '<table class="meta"><tr><td>Quote #</td><td>' + esc(meta.number) + '</td></tr>' +
      '<tr><td>Issued</td><td>' + esc(meta.issued) + '</td></tr>' +
      (meta.validUntil ? '<tr><td>Valid until</td><td>' + esc(meta.validUntil) + '</td></tr>' : '') + '</table></div>\n' +
      '</header>\n' +
      (contact ? '<div class="contact">' + contact + '</div>\n' : '') +
      '<div class="rule"></div>\n';
  }

  // Line items that add up to the total: `extras` are [label, amount] pairs
  // as the customer pays them; Linehaul takes the rest. None when there are
  // no extras or the profile turned the breakdown off.
  function rateLines(total, extras, profile) {
    if (profile.pdfBreakdown === false) return [];
    var items = (extras || []).map(function (e) { return [e[0], Math.round(e[1] || 0), e[2]]; })
      .filter(function (e) { return e[1] > 0; });
    if (!items.length) return [];
    var sum = items.reduce(function (a, e) { return a + e[1]; }, 0);
    return [['Linehaul', total - sum]].concat(items);
  }

  // The price panel. `right`: [label, value text, note] shown beside the total.
  function rateBlock(totalLabel, totalText, lines, right, sub) {
    var items = lines.map(function (l) {
      return '<div class="line-item"><span>' + esc(l[0]) + (l[2] ? '<small>' + esc(l[2]) + '</small>' : '') + '</span>' +
        '<span>' + (typeof l[1] === 'number' ? dollars(l[1]) : esc(l[1])) + '</span></div>';
    }).join('');
    return '<section class="rate' + (lines.length ? ' has-lines' : '') + '">\n' + items +
      '  <div class="total-row"><div><div class="k">' + esc(totalLabel) + '</div><div class="total">' + esc(totalText) + '</div>' +
      (sub ? '<div class="total-sub">' + esc(sub) + '</div>' : '') + '</div>' +
      (right ? '<div class="rpm">' + esc(right[0]) + '<strong>' + esc(right[1]) + '</strong>' + (right[2] ? '<em>' + esc(right[2]) + '</em>' : '') + '</div>' : '') +
      '</div>\n</section>\n';
  }

  function factsBlock(facts) {
    var cells = facts.filter(function (f) { return f[1] && f[1] !== '—'; }).map(function (f) {
      return '<div class="fact"><div class="k">' + esc(f[0]) + '</div><div class="v">' + esc(f[1]) + '</div></div>';
    }).join('');
    return cells ? '<section class="facts">' + cells + '</section>\n' : '';
  }

  function laneBlock(fromLabel, from, fromDate, toLabel, to, toDate, milesText, sub) {
    return '<section class="lane">\n' +
      '  <div class="stop"><div class="k">' + esc(fromLabel) + '</div><div class="city">' + esc(from) + '</div>' +
      (fromDate ? '<div class="date">' + esc(fromDate) + '</div>' : '') + '</div>\n' +
      '  <div class="leg"><div class="mi">' + esc(milesText) + '</div><div class="track"></div>' +
      (sub ? '<div class="sub">' + esc(sub) + '</div>' : '') + '</div>\n' +
      '  <div class="stop right"><div class="k">' + esc(toLabel) + '</div><div class="city">' + esc(to) + '</div>' +
      (toDate ? '<div class="date">' + esc(toDate) + '</div>' : '') + '</div>\n' +
      '</section>\n';
  }

  function notesBlock(notes) {
    return notes
      ? '<section class="section"><div class="k">Notes</div><div class="notes-text">' + esc(notes).replace(/\n/g, '<br>') + '</div></section>\n'
      : '';
  }

  function closing(profile, meta, terms, signatures) {
    var company = profile.companyName || '';
    var signer = profile.contactName || company;
    return '<section class="terms">' + esc(terms) + '</section>\n' +
      (signatures === false ? '' :
        '<section class="sign">\n' +
        '  <div class="sig"><div class="line"></div><div class="lbl"><strong>Accepted by</strong> — signature, printed name &amp; date</div></div>\n' +
        '  <div class="sig"><div class="line"></div><div class="lbl"><strong>Authorized by</strong>' + (signer ? ' — ' + esc(signer) : '') + '</div></div>\n' +
        '</section>\n') +
      '<footer><span>' + (company ? esc(company) + ' · ' : '') + 'Quote ' + esc(meta.number) + '</span>' +
      '<span>Prepared with QuickFreightCalc</span></footer>\n';
  }

  function page(title, s, body) {
    return '<!DOCTYPE html>\n<html lang="en">\n<head>\n<meta charset="UTF-8">\n' +
      '<title>' + esc(title) + '</title>\n' +
      '<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&display=swap" rel="stylesheet">\n' +
      '<style>\n' + css(s) + '</style>\n</head>\n<body>\n' +
      '<div class="controls"><button onclick="window.print()">🖨 Print / Save as PDF</button>' +
      '<span>Use your browser\'s Print dialog → Save as PDF</span></div>\n' +
      '<div class="doc">\n' + body + '</div>\n</body>\n</html>';
  }

  var TERMS = 'Rates are subject to change and valid for 24 hours from issue.';

  // ── Single lane (calculator and quote log) ─────────────────────────────────
  // q: { total, ratePerMile, miles, origin, destination, pickup, delivery,
  //      trailer, commodity, weight, transit, notes,
  //      breakdown: { fuel, extra } | null }   (money in dollars, as charged)
  function modernHTML(q, profile, meta) {
    var s = colorsFor(profile);
    var total = Math.round(q.total);
    var b = q.breakdown || {};
    var lines = rateLines(total, [['Fuel surcharge', b.fuel], ['Extra transit days', b.extra]], profile);
    var body = letterhead(profile, s, 'Freight Quote', meta) +
      laneBlock('Pickup', q.origin, q.pickup, 'Delivery', q.destination, q.delivery,
        q.miles ? Number(q.miles).toLocaleString('en-US') + ' mi' : '') +
      factsBlock([
        ['Equipment', TRAILERS[q.trailer] || q.trailer],
        ['Weight', q.weight ? Number(q.weight).toLocaleString('en-US') + ' lbs' : ''],
        ['Commodity', q.commodity],
        ['Transit', q.transit],
      ]) +
      rateBlock('All-in rate', dollars(total), lines, q.ratePerMile ? ['Rate per mile', cents(q.ratePerMile)] : null) +
      notesBlock(q.notes) +
      closing(profile, meta, TERMS + (lines.length ? '' : ' The all-in rate includes linehaul and fuel.'));
    return page('Freight Quote ' + meta.number, s, body);
  }

  // ── Multi-stop ─────────────────────────────────────────────────────────────
  // d: { total, totalMiles, totalWeight, trailer (text), commodity (text),
  //      stops: [{ type: 'pickup'|'delivery', location, date, weight, legMiles, extra }],
  //      charges: { fuel, stops, extra } (as charged), notes }
  function multiStopHTML(d, profile, meta) {
    var s = colorsFor(profile);
    var total = Math.round(d.total);
    var stops = d.stops || [];
    var pickups = stops.filter(function (x) { return x.type === 'pickup'; }).length;
    var c = d.charges || {};
    var lines = rateLines(total, [['Fuel surcharge', c.fuel], ['Stop charges', c.stops], ['Extra transit days', c.extra]], profile);
    var miles = d.totalMiles ? Number(d.totalMiles).toLocaleString('en-US') + ' mi' : '';

    // One row per stop: marker, stop number and type, place (with date and
    // weight), and the miles on to the next stop.
    var stopItems = stops.map(function (x, i) {
      var kind = x.type === 'pickup' ? 'Pickup' : 'Delivery';
      var meta2 = [x.date, x.type === 'pickup' && x.weight ? Number(x.weight).toLocaleString('en-US') + ' lbs' : ''].filter(Boolean).join(' · ');
      var next = i < stops.length - 1
        ? (x.legMiles ? Number(x.legMiles).toLocaleString('en-US') + ' mi' : '— mi') + '<small>to next stop</small>'
        : '';
      return '<div class="s-row ' + (x.type === 'pickup' ? 'pickup' : 'delivery') + '">' +
        '<span class="s-dot"></span>' +
        '<span class="s-kind">Stop ' + (i + 1) + '<br>' + kind + '</span>' +
        '<div><div class="s-place">' + esc(x.location || '—') + (x.extra ? '<span class="s-chip">Extra stop</span>' : '') + '</div>' +
        (meta2 ? '<div class="s-meta">' + esc(meta2) + '</div>' : '') + '</div>' +
        '<span class="s-leg">' + next + '</span>' +
        '</div>';
    }).join('');

    var drops = stops.length - pickups;
    var counts = pickups + ' pickup' + (pickups === 1 ? '' : 's') + ' · ' + drops + ' deliver' + (drops === 1 ? 'y' : 'ies');
    var body = letterhead(profile, s, 'Multi-Stop Freight Quote', meta) +
      factsBlock([
        ['Equipment', d.trailer],
        ['Total weight', d.totalWeight ? Number(d.totalWeight).toLocaleString('en-US') + ' lbs' : ''],
        ['Commodity', d.commodity],
        ['Total miles', miles],
      ]) +
      '<section class="section"><div class="k">' + stops.length + ' stops · ' + counts + '</div><div class="stops">' + stopItems + '</div></section>\n' +
      rateBlock('All-in rate', dollars(total), lines,
        d.totalMiles ? ['Rate per mile', cents(total / d.totalMiles), miles + ' total'] : null) +
      notesBlock(d.notes) +
      closing(profile, meta, TERMS + (lines.length ? '' : ' The all-in rate includes linehaul, fuel and stop charges.'));
    return page('Multi-Stop Quote ' + meta.number, s, body);
  }

  // ── Bulk load (rate per cwt) ───────────────────────────────────────────────
  // d: { origin, destination, loadedMiles, deadhead, cwt, ratePerCwt, base,
  //      fuel, fuelNote, total, rpmLoaded, rpmAll, meetsTarget, statusText,
  //      statusDetail, targetText, fscMethod, diesel }
  function bulkHTML(d, profile, meta) {
    var s = colorsFor(profile);
    var totalMiles = (d.loadedMiles || 0) + (d.deadhead || 0);
    var lines = [
      ['Base rate', cents(d.base), '$' + d.ratePerCwt.toFixed(2) + ' × ' + d.cwt.toLocaleString('en-US') + ' cwt'],
      ['Fuel surcharge', cents(d.fuel), d.fuelNote],
    ];
    var body = letterhead(profile, s, 'Bulk Load Quote', meta) +
      laneBlock('Origin', d.origin, '', 'Destination', d.destination, '',
        d.loadedMiles.toLocaleString('en-US') + ' loaded mi',
        d.deadhead > 0 ? '+ ' + d.deadhead.toLocaleString('en-US') + ' mi deadhead' : '') +
      factsBlock([
        ['Load', d.cwt.toLocaleString('en-US') + ' cwt'],
        ['Rate', '$' + d.ratePerCwt.toFixed(2) + ' / cwt'],
        ['Total miles', totalMiles.toLocaleString('en-US') + ' mi'],
        ['Fuel surcharge', d.fscMethod],
      ]) +
      rateBlock('Total load revenue', cents(d.total), lines,
        ['Per loaded mile', cents(d.rpmLoaded), d.deadhead > 0 ? cents(d.rpmAll) + ' per mile, all miles' : ''],
        d.cwt.toLocaleString('en-US') + ' cwt @ $' + d.ratePerCwt.toFixed(2) + '/cwt + fuel') +
      '<section class="section"><div class="k">Target comparison</div>' +
      '<div class="status ' + (d.meetsTarget ? 'good' : 'short') + '"><strong>' + (d.meetsTarget ? '▲ ' : '▼ ') + esc(d.statusText) + '</strong>' +
      esc(d.statusDetail) + ' Target: ' + esc(d.targetText) + '.</div></section>\n' +
      factsBlock([['Diesel reference', '$' + d.diesel.toFixed(2) + '/gal (EIA national)']]) +
      closing(profile, meta, TERMS, false);
    return page('Bulk Load Quote ' + meta.number, s, body);
  }

  // Opens the page in a new tab, the same way the Classic PDFs do.
  function openHTML(html) {
    var blob = new Blob([html], { type: 'text/html' });
    var url = URL.createObjectURL(blob);
    var tab = window.open(url, '_blank');
    if (tab) {
      tab.addEventListener('load', function () { URL.revokeObjectURL(url); }, { once: true });
    } else {
      URL.revokeObjectURL(url);
      alert('Pop-up blocked — please allow pop-ups for this site to download quotes.');
    }
  }

  // Build and open, numbering each like its Classic PDF (bulk quotes carry "B").
  function openModern(q, profile) { openHTML(modernHTML(q, profile, nextQuoteNumber(profile, true))); }
  function openMultiStop(d, profile) { openHTML(multiStopHTML(d, profile, nextQuoteNumber(profile, true))); }
  function openBulk(d, profile) {
    var meta = nextQuoteNumber(profile, true, 'B');
    meta.validUntil = '';
    openHTML(bulkHTML(d, profile, meta));
  }

  window.QFCQuotePDF = {
    schemes: SCHEMES, style: style, colorsFor: colorsFor, classicScheme: classicScheme, isHex: function (v) { return HEX.test(v || ''); },
    nextQuoteNumber: nextQuoteNumber, modernHTML: modernHTML, multiStopHTML: multiStopHTML, bulkHTML: bulkHTML,
    openHTML: openHTML, openModern: openModern, openMultiStop: openMultiStop, openBulk: openBulk,
  };
})();
