// pdf-quote.js — the Modern quote PDF, the default for single-lane quotes.
// The Classic design is the original template in index.html, kept exactly as
// it was for anyone who chooses "Classic" on their Profile (profile.pdfStyle).
//
// Like Classic, it opens a print-ready page in a new tab; the browser's
// "Print / Save as PDF" makes the PDF. Used by the calculator and the quote
// log (index.html) and by the sample preview on the Profile page.
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
  var TRAILERS = { van: 'Dry Van', reefer: 'Reefer', flatbed: 'Flatbed' };

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }
  function dollars(n) { return '$' + Math.round(n).toLocaleString('en-US'); }
  function cents(n) { return '$' + n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }); }

  // The style a profile asked for: 'classic' or 'modern' (the default).
  function style(profile) {
    return profile && profile.pdfStyle === 'classic' ? 'classic' : 'modern';
  }

  // Quote number and dates, numbered the same way as the Classic PDFs
  // (PREFIX-YYYYMMDD-counter), advancing the counter in the saved profile.
  function nextQuoteNumber(profile, persist) {
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
      number: prefix + '-' + ymd + '-' + num,
      issued: now.toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' }),
      validUntil: valid.toLocaleString('en-US', { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' }),
    };
  }

  // q: { total, ratePerMile, miles, origin, destination, pickup, delivery,
  //      trailer, commodity, weight, transit, notes,
  //      breakdown: { fuel, extra } | null }   (money in dollars)
  // meta: from nextQuoteNumber.
  function modernHTML(q, profile, meta) {
    var s = SCHEMES[profile.colorScheme] || SCHEMES.midnight;
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

    var total = Math.round(q.total);
    var lines = [];
    var b = q.breakdown;
    if (b && profile.pdfBreakdown !== false) {
      var fuel = Math.round(b.fuel || 0);
      var extra = Math.round(b.extra || 0);
      if (fuel > 0 || extra > 0) {
        lines.push(['Linehaul', total - fuel - extra]);
        if (fuel > 0) lines.push(['Fuel surcharge', fuel]);
        if (extra > 0) lines.push(['Extra transit days', extra]);
      }
    }
    var breakdown = lines.map(function (l) {
      return '<div class="line-item"><span>' + l[0] + '</span><span>' + dollars(l[1]) + '</span></div>';
    }).join('');

    var facts = [
      ['Equipment', TRAILERS[q.trailer] || q.trailer],
      ['Weight', q.weight ? Number(q.weight).toLocaleString('en-US') + ' lbs' : ''],
      ['Commodity', q.commodity],
      ['Transit', q.transit],
    ].filter(function (f) { return f[1] && f[1] !== '—'; }).map(function (f) {
      return '<div class="fact"><div class="k">' + f[0] + '</div><div class="v">' + esc(f[1]) + '</div></div>';
    }).join('');

    var milesText = q.miles ? Number(q.miles).toLocaleString('en-US') + ' mi' : '';
    var notes = q.notes
      ? '<section class="notes"><div class="k">Notes</div><div class="notes-text">' + esc(q.notes).replace(/\n/g, '<br>') + '</div></section>'
      : '';
    var signer = profile.contactName || company;

    return '<!DOCTYPE html>\n<html lang="en">\n<head>\n<meta charset="UTF-8">\n' +
      '<title>Freight Quote ' + esc(meta.number) + '</title>\n' +
      '<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&display=swap" rel="stylesheet">\n' +
      '<style>\n' +
      '*{box-sizing:border-box;margin:0;padding:0}\n' +
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
      '.rule{height:3px;background:' + s.accent + ';border-radius:2px;margin:18px 0 30px;-webkit-print-color-adjust:exact;print-color-adjust:exact}\n' +
      '.lane{display:flex;align-items:center;gap:18px;margin-bottom:26px}\n' +
      '.stop{flex:1;min-width:0}\n' +
      '.stop.right{text-align:right}\n' +
      '.city{font-size:22px;font-weight:700;color:#111827;letter-spacing:-.01em;line-height:1.25;overflow-wrap:anywhere}\n' +
      '.date{font-size:12.5px;color:#4b5563;margin-top:4px}\n' +
      '.leg{flex:0 0 150px;text-align:center}\n' +
      '.leg .mi{font-size:13px;font-weight:700;color:' + s.ink + '}\n' +
      '.leg .track{position:relative;height:2px;background:' + s.accent + ';margin:8px 4px;-webkit-print-color-adjust:exact;print-color-adjust:exact}\n' +
      '.leg .track:before,.leg .track:after{content:"";position:absolute;top:-4px;width:10px;height:10px;border-radius:50%;background:#fff;border:2px solid ' + s.accent + '}\n' +
      '.leg .track:before{left:-6px}.leg .track:after{right:-6px;background:' + s.accent + '}\n' +
      '.facts{display:flex;border-top:1px solid #e5e7eb;border-bottom:1px solid #e5e7eb;margin-bottom:26px}\n' +
      '.fact{flex:1;padding:14px 16px 14px 0}\n' +
      '.fact + .fact{padding-left:16px;border-left:1px solid #e5e7eb}\n' +
      '.fact .v{font-size:14px;font-weight:600;color:#111827}\n' +
      '.rate{border:1px solid #e5e7eb;border-left:4px solid ' + s.accent + ';border-radius:8px;padding:18px 22px;margin-bottom:26px;-webkit-print-color-adjust:exact;print-color-adjust:exact}\n' +
      '.line-item{display:flex;justify-content:space-between;font-size:13px;color:#374151;padding:4px 0}\n' +
      '.line-item span:last-child{font-variant-numeric:tabular-nums}\n' +
      '.total-row{display:flex;justify-content:space-between;align-items:flex-end;gap:16px}\n' +
      '.has-lines .total-row{border-top:1px solid #e5e7eb;margin-top:10px;padding-top:12px}\n' +
      '.total{font-size:38px;font-weight:800;color:' + s.ink + ';letter-spacing:-.02em;line-height:1;font-variant-numeric:tabular-nums}\n' +
      '.rpm{font-size:13px;color:#4b5563;text-align:right}\n' +
      '.rpm strong{display:block;font-size:16px;color:#111827}\n' +
      '.notes{margin-bottom:26px}\n' +
      '.notes-text{font-size:13px;line-height:1.6;color:#374151;background:#f9fafb;border-radius:8px;padding:12px 16px;-webkit-print-color-adjust:exact;print-color-adjust:exact}\n' +
      '.terms{font-size:11.5px;color:#6b7280;line-height:1.6;margin-bottom:30px}\n' +
      '.sign{display:flex;gap:36px;margin-top:auto;margin-bottom:28px}\n' +
      '.sig{flex:1}\n' +
      '.sig .line{border-bottom:1px solid #111827;height:34px}\n' +
      '.sig .lbl{font-size:10.5px;color:#6b7280;margin-top:6px}\n' +
      '.sig .lbl strong{color:#374151;font-weight:600}\n' +
      'footer{display:flex;justify-content:space-between;gap:16px;font-size:10px;color:#9ca3af;border-top:1px solid #f0f2f5;padding-top:12px}\n' +
      '@media print{\n' +
      '  @page{size:letter portrait;margin:0}\n' +
      '  body{background:#fff;padding:0}\n' +
      '  .controls{display:none!important}\n' +
      '  .doc{box-shadow:none;border-radius:0;max-width:none;min-height:100vh;padding:0.55in 0.6in 0.45in}\n' +
      '  .lane,.facts,.rate,.notes,.sign{break-inside:avoid;page-break-inside:avoid}\n' +
      '}\n' +
      '</style>\n</head>\n<body>\n' +
      '<div class="controls"><button onclick="window.print()">🖨 Print / Save as PDF</button>' +
      '<span>Use your browser\'s Print dialog → Save as PDF</span></div>\n' +
      '<div class="doc">\n' +
      '<header>\n' +
      '  <div class="brand">' + brand + '<div>' + brandText + '</div></div>\n' +
      '  <div class="doc-id"><div class="title">Freight Quote</div>' +
      '<table class="meta"><tr><td>Quote #</td><td>' + esc(meta.number) + '</td></tr>' +
      '<tr><td>Issued</td><td>' + esc(meta.issued) + '</td></tr>' +
      '<tr><td>Valid until</td><td>' + esc(meta.validUntil) + '</td></tr></table></div>\n' +
      '</header>\n' +
      (contact ? '<div class="contact">' + contact + '</div>\n' : '') +
      '<div class="rule"></div>\n' +
      '<section class="lane">\n' +
      '  <div class="stop"><div class="k">Pickup</div><div class="city">' + esc(q.origin) + '</div>' +
      (q.pickup ? '<div class="date">' + esc(q.pickup) + '</div>' : '') + '</div>\n' +
      '  <div class="leg"><div class="mi">' + esc(milesText) + '</div><div class="track"></div></div>\n' +
      '  <div class="stop right"><div class="k">Delivery</div><div class="city">' + esc(q.destination) + '</div>' +
      (q.delivery ? '<div class="date">' + esc(q.delivery) + '</div>' : '') + '</div>\n' +
      '</section>\n' +
      (facts ? '<section class="facts">' + facts + '</section>\n' : '') +
      '<section class="rate' + (lines.length ? ' has-lines' : '') + '">\n' + breakdown +
      '  <div class="total-row"><div><div class="k">All-in rate</div><div class="total">' + dollars(total) + '</div></div>' +
      (q.ratePerMile ? '<div class="rpm">Rate per mile<strong>' + cents(q.ratePerMile) + '</strong></div>' : '') +
      '</div>\n</section>\n' +
      notes +
      '<section class="terms">Rates are subject to change and valid for 24 hours from issue.' +
      (lines.length ? '' : ' The all-in rate includes linehaul and fuel.') + '</section>\n' +
      '<section class="sign">\n' +
      '  <div class="sig"><div class="line"></div><div class="lbl"><strong>Accepted by</strong> — signature, printed name &amp; date</div></div>\n' +
      '  <div class="sig"><div class="line"></div><div class="lbl"><strong>Authorized by</strong>' + (signer ? ' — ' + esc(signer) : '') + '</div></div>\n' +
      '</section>\n' +
      '<footer><span>' + (company ? esc(company) + ' · ' : '') + 'Quote ' + esc(meta.number) + '</span>' +
      '<span>Prepared with QuickFreightCalc</span></footer>\n' +
      '</div>\n</body>\n</html>';
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

  // Builds and opens a Modern quote, numbering it like the Classic PDFs.
  function openModern(q, profile) {
    var meta = nextQuoteNumber(profile, true);
    openHTML(modernHTML(q, profile, meta));
  }

  window.QFCQuotePDF = { schemes: SCHEMES, style: style, modernHTML: modernHTML, nextQuoteNumber: nextQuoteNumber,
    openHTML: openHTML, openModern: openModern };
})();
