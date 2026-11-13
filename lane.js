/* lane.js — "Lane details" under the calculator, in the spirit of DAT RateView:
   pull up a lane and see its market rate this month and over time, your own
   quotes on it, the route on Google's map, the markets at both ends, and trip
   and fuel.

   Where the numbers come from
   - Market rate: rates.json, the regional averages by month (window.QFC_RATES,
     set by the calculator). The lane's market rate is the pickup region's rate
     for the trailer times the calculator's distance multiplier for the lane's
     miles (the same dMult the quote uses): the calculator before your load
     details and margin.
   - Your quotes: the calculator's quote log (Pro). Won and lost show for plans
     with win/loss tracking (Pro Plus and up, comp).
   - Diesel: the EIA weekly price (diesel-price function), sharing the
     calculator's 30-minute cache (qfc_diesel_cache).
   - Route map: Google's Maps Embed API (free) once GMAPS_EMBED_KEY is set (the
     maps-config function hands the page that browser key). Google's terms
     don't allow its routes, miles or places on or near a non-Google map, so the
     route is only drawn on Google's own map; until there's a key the panel
     links to the route on Google Maps.

   The page's own HOS trip plan and weather cards (marked data-lane-slot="hos"
   and "weather") move into their places in the view and keep their ids, so the
   code that fills them works as before. They wait inside the hidden view until a lane
   shows, so they never flash under the form.

   The calculator supplies the lane:
     QFCLane.init({ container, jump, getLane })   once
     QFCLane.refresh()                             whenever the quote changes
   getLane() returns null when there's no full-truckload lane to show, or
     { orig, dest, mapOrig, mapDest, trailer, miles, milesSource ('google' |
       'manual'), driveSecs, distMult, quoteTotal, quoteRpm, quotes, tier } */
(function () {
  'use strict';
  const REGION_NAME = { northeast: 'Northeast', southeast: 'Southeast', midwest: 'Midwest', southwest: 'Southwest', west: 'West', national: 'National' };
  const EQ_NAME = { van: 'Van', reefer: 'Reefer', flatbed: 'Flatbed' };
  const MPG = 6.5;           // the calculator's fuel surcharge assumption (DOE_FSC_MPG)
  const FSC_BASE = 1.25;     // DOE fuel surcharge baseline, $/gal
  const WINLOSS = ['plus', 'max', 'api', 'comp'];
  const MODE_KEY = 'qfc_lane_mode';
  const DAY = 86400000;
  const ROWS = 8;            // quotes listed before "Show all"

  let host = null, jump = null, getLane = null;
  let mode = 'load';
  try { if (localStorage.getItem(MODE_KEY) === 'mile') mode = 'mile'; } catch (e) {}
  let showTable = false, showAllQuotes = false;
  let timer = null, resizeTimer = null;
  let tapAwayWired = false;  // one page-wide listener puts a chart's tapped numbers away
  let diesel;                // undefined: not asked yet · null: unavailable · { price, period }
  let mapsKey;               // undefined: not asked yet · null: none set · 'key'
  let current = null;        // the model on screen
  let mapShown = '';         // what the route panel shows, so the map isn't reloaded needlessly
  let adopted = [];          // the page's cards placed in the view: [{ el, slot }]
  let weatherFor = '';       // the lane the weather outlook was last asked for
  const parts = {};

  const esc = (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  const money0 = (n) => '$' + Math.round(n).toLocaleString('en-US');
  const money2 = (n) => '$' + Number(n).toFixed(2);
  const pctAbs = (x, d = 1) => Math.abs(x * 100).toFixed(d) + '%';
  const signed = (x, d = 0) => (x >= 0 ? '+' : '−') + pctAbs(x, d);
  const ARROW = {
    up: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 19V5M6 11l6-6 6 6"/></svg>',
    down: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5v14M6 13l6 6 6-6"/></svg>',
  };
  const svg = (d) => `<svg class="lv-icon" viewBox="0 0 24 24" aria-hidden="true">${d}</svg>`;
  const ICON = {
    chart: svg('<path d="M4 19.5h16"/><path d="m5.5 15 4-4.5 3.5 3 5.5-6.5"/><path d="M15 7h3.5v3.5"/>'),
    route: svg('<circle cx="6" cy="6" r="2.2"/><path d="M8.2 6H15a3 3 0 0 1 0 6H9a3 3 0 0 0 0 6h6.8"/><circle cx="18" cy="18" r="2.2"/>'),
    markets: svg('<path d="M4 8h13M13 4l4 4-4 4"/><path d="M20 16H7M11 12l-4 4 4 4"/>'),
    fuel: svg('<path d="M4 21V5a2 2 0 0 1 2-2h6a2 2 0 0 1 2 2v16"/><path d="M3 21h12M7 7h4"/><path d="M14 10h2a2 2 0 0 1 2 2v4a1.5 1.5 0 0 0 3 0V8l-3-3"/>'),
    quotes: svg('<rect x="5" y="4" width="14" height="17" rx="2"/><path d="M9 4V3h6v1M9 10h6M9 14h6M9 18h3"/>'),
    clock: svg('<circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3 2"/>'),
    pin: svg('<path d="M12 21s-6.5-5.6-6.5-11a6.5 6.5 0 0 1 13 0c0 5.4-6.5 11-6.5 11z"/><circle cx="12" cy="10" r="2.3"/>'),
    flag: svg('<path d="M5 21V4"/><path d="M5 4h11l-2 4 2 4H5"/>'),
  };
  const panelHead = (icon, title, sub, extra) => `<div class="lv-panel-head"><h3><span class="lv-ico">${icon}</span>${title}` +
    `${sub ? `<small>${sub}</small>` : ''}</h3>${extra || ''}</div>`;

  // ── Places and markets ──────────────────────────────────────────────────
  // The state from "Hastings, FL", "Hastings, FL 32145" or "Hastings, FL, USA",
  // as the calculator reads it for regional rates.
  function stateOf(text) {
    const m = String(text || '').trim().match(/[\s,]+([A-Za-z]{2})\b(?:\s+\d{5}(?:-\d{4})?)?(?:\s*,\s*USA?)?\s*$/i);
    return m ? m[1].toUpperCase() : null;
  }
  function regionOf(rates, state) {
    if (!state) return 'national';
    for (const [r, d] of Object.entries(rates.regions || {})) {
      if (r !== 'national' && d && Array.isArray(d.states) && d.states.includes(state)) return r;
    }
    return 'national';
  }
  function rateIn(regions, region, eq) {
    const v = Number(regions && regions[region] && regions[region][eq]);
    if (v > 0) return v;
    const n = Number(regions && regions.national && regions.national[eq]);
    return n > 0 ? n : null;
  }
  // "Lancaster, PA 17601" and "lancaster pa" are the same place (as in the quote log's win/loss by lane).
  const placeKey = (s) => String(s || '').toLowerCase().replace(/\b\d{5}(?:-\d{4})?\b/g, ' ')
    .replace(/\b(usa|united states)\b/g, ' ').replace(/[^a-z0-9]+/g, ' ').trim();
  const placeLabel = (s) => String(s || '').replace(/\s*\b\d{5}(?:-\d{4})?\b/g, '')
    .replace(/,\s*(USA|United States)\s*$/i, '').replace(/[\s,]+$/, '').trim();
  const monthShort = (t) => new Date(t).toLocaleDateString('en-US', { month: 'short' });
  const monthLong = (t) => new Date(t).toLocaleDateString('en-US', { month: 'long', year: 'numeric' });
  const dayLabel = (t) => new Date(t).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
  function duration(secs) {
    const m = Math.round(secs / 60), h = Math.floor(m / 60);
    return h ? `${h} h ${m % 60} m` : `${m} m`;
  }

  // ── The model: everything the view shows, from the lane and rates.json ──
  function build(lane, rates) {
    const eq = EQ_NAME[lane.trailer] ? lane.trailer : 'van';
    const miles = Number(lane.miles);
    const dm = Number(lane.distMult) > 0 ? Number(lane.distMult) : 1;
    const oState = stateOf(lane.orig), dState = stateOf(lane.dest);
    const oRegion = regionOf(rates, oState), dRegion = regionOf(rates, dState);

    let months = (rates.history || [])
      .filter((h) => h && h.date && h.regions)
      .map((h) => ({ t: Date.parse(h.date + 'T12:00:00'), label: h.label || h.date,
        lane: rateIn(h.regions, oRegion, eq), national: rateIn(h.regions, 'national', eq) }))
      .filter((p) => isFinite(p.t) && p.lane && p.national)
      .sort((a, b) => a.t - b.t);
    if (!months.length) {
      months = [{ t: Date.now(), label: 'This month', lane: rateIn(rates.regions, oRegion, eq), national: rateIn(rates.regions, 'national', eq) }];
    }
    months.forEach((p) => { p.lane *= dm; p.national *= dm; });   // $/mi for this lane's length
    const last = months[months.length - 1];
    const prev = months.length > 1 ? months[months.length - 2] : null;
    const recent = months.slice(-3);
    const avg3 = recent.reduce((s, p) => s + p.lane, 0) / recent.length;
    const lanes = months.map((p) => p.lane);
    const marketAt = (t) => { let m = months[0]; months.forEach((p) => { if (p.t <= t + 15 * DAY) m = p; }); return m.lane; };

    // Your saved quotes on this lane (same pickup and delivery; this trailer)
    const key = placeKey(lane.orig) + '>' + placeKey(lane.dest);
    const winLoss = WINLOSS.includes(lane.tier);
    const onLane = (lane.quotes || []).filter((q) => q && placeKey(q.orig) + '>' + placeKey(q.dest) === key);
    const points = onLane.filter((q) => (q.trailer || 'van') === eq).map((q) => {
      const t = Date.parse(q.createdAt || '');
      const qMiles = Number(q.miles) > 0 ? Number(q.miles) : miles;
      const quoted = Number(q.quote) || 0;
      const outcome = winLoss && (q.outcome === 'won' || q.outcome === 'lost') ? q.outcome : 'open';
      const final = Number(q.finalRate) > 0 ? Number(q.finalRate) : null;
      const booked = outcome === 'won' ? (final || quoted) : null;
      const value = booked || quoted;
      return { t, q, outcome, quoted, booked, wentFor: outcome === 'lost' ? final : null, miles: qMiles,
        load: value, mile: value / qMiles, quotedMile: quoted / qMiles, market: isFinite(t) ? marketAt(t) : null };
    }).filter((p) => p.quoted > 0).sort((a, b) => (b.t || 0) - (a.t || 0));
    const won = points.filter((p) => p.outcome === 'won'), lost = points.filter((p) => p.outcome === 'lost');
    const avg = (xs) => (xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : null);
    const vsMarket = avg(points.filter((p) => p.market).map((p) => p.quotedMile / p.market - 1));

    const nat = rateIn(rates.regions, 'national', eq);
    const lt = rates.loadToTruck && rates.loadToTruck[eq];
    return {
      lane, eq, miles, dm, months, last, prev, avg3, lo: Math.min(...lanes), hi: Math.max(...lanes),
      oState, dState, oRegion, dRegion, updated: rates.updated || '',
      quote: { total: Number(lane.quoteTotal) || 0, rpm: Number(lane.quoteRpm) || 0 },
      winLoss, signedIn: lane.tier && lane.tier !== 'none', points, otherTrailers: onLane.length - points.length,
      stats: { quotes: points.length, won: won.length, lost: lost.length,
        winRate: won.length + lost.length ? won.length / (won.length + lost.length) : null,
        avgQuoted: avg(points.map((p) => p.quotedMile)), avgBooked: avg(won.map((p) => p.mile)), vsMarket },
      markets: {
        national: nat,
        origin: { place: placeLabel(lane.orig), region: oRegion, rate: rateIn(rates.regions, oRegion, eq) },
        dest: { place: placeLabel(lane.dest), region: dRegion, rate: rateIn(rates.regions, dRegion, eq) },
        lt: lt && Number(lt.current) > 0 && Number(lt.base) > 0 ? { current: Number(lt.current), base: Number(lt.base) } : null,
      },
      trip: { miles, source: lane.milesSource === 'google' ? 'google' : 'manual', driveSecs: Number(lane.driveSecs) || 0 },
      map: { orig: lane.mapOrig || lane.orig, dest: lane.mapDest || lane.dest },
    };
  }

  // ── Parts ───────────────────────────────────────────────────────────────
  const perLoad = () => mode === 'load';
  const showVal = (rpm, miles) => (perLoad() ? money0(rpm * miles) : money2(rpm));
  const unit = () => (perLoad() ? '' : '<em>/mi</em>');
  const other = (rpm, miles) => (perLoad() ? money2(rpm) + '/mi' : money0(rpm * miles) + ' per load');

  function headHTML(m) {
    const t = m.trip;
    const chip = (icon, html) => `<span class="lv-chip">${icon}${html}</span>`;
    return `<div class="lv-bar-main">
      <div class="lv-kicker">Lane details</div>
      <div class="lv-title"><span>${esc(placeLabel(m.lane.orig))}</span><span class="lv-arrow">→</span><span>${esc(placeLabel(m.lane.dest))}</span>
        <span class="lv-eq">${EQ_NAME[m.eq]}</span></div>
      <div class="lv-chips">${chip(ICON.route, `<b>${Math.round(m.miles).toLocaleString('en-US')}</b> mi`)}` +
        (t.driveSecs ? chip(ICON.clock, `<b>${duration(t.driveSecs)}</b> drive`) : '') +
        chip(ICON.pin, `Pickup <b>${REGION_NAME[m.oRegion]}</b>`) + chip(ICON.flag, `Delivery <b>${REGION_NAME[m.dRegion]}</b>`) + `</div>
    </div>
    <div class="lv-seg" role="group" aria-label="Show rates">
      <button type="button" data-mode="load" aria-pressed="${perLoad()}">Per load</button>
      <button type="button" data-mode="mile" aria-pressed="${!perLoad()}">Per mile</button>
    </div>`;
  }

  function change(now, before, label) {
    if (!before) return '';
    const d = now / before - 1;
    if (Math.abs(d) < 0.0005) return `Flat vs ${label}`;
    return `${d > 0 ? ARROW.up : ARROW.down}${d > 0 ? 'Up' : 'Down'} ${pctAbs(d)} vs ${label}`;
  }

  function tilesHTML(m) {
    const mi = m.miles, last = m.last, prev = m.prev, first = m.months[0];
    const short = (p) => esc(String(p.label).replace(/\s+\d{4}$/, ''));
    const tile = ({ title, tag, val, sub, foot, cls, small }) => `<div class="lv-tile${cls ? ' ' + cls : ''}">
      <div class="lv-tile-head"><span class="lv-tile-title">${title}</span>${tag ? `<span class="lv-tile-tag">${tag}</span>` : ''}</div>
      <b class="lv-tile-val${small ? ' small' : ''}">${val}</b><span class="lv-tile-sub">${sub}</span>${foot ? `<div class="lv-tile-foot">${foot}</div>` : ''}</div>`;
    const q = m.quote;
    const vs = q.total > 0 && last.lane > 0 ? q.total / (last.lane * mi) - 1 : null;
    const recent = m.months.slice(-3).map((p) => monthShort(p.t));
    return tile({ title: 'This month', tag: short(last), val: showVal(last.lane, mi) + unit(), sub: other(last.lane, mi),
        foot: prev ? change(last.lane, prev.lane, short(prev)) : '' }) +
      (prev ? tile({ title: 'Last month', tag: short(prev), val: showVal(prev.lane, mi) + unit(), sub: other(prev.lane, mi) }) : '') +
      tile({ title: m.months.length >= 3 ? '3-month avg' : `${m.months.length}-month avg`,
        tag: esc(recent.length > 1 ? recent[0] + '–' + recent[recent.length - 1] : recent[0] || ''),
        val: showVal(m.avg3, mi) + unit(), sub: other(m.avg3, mi) }) +
      tile({ title: 'Range', tag: 'Since ' + short(first), small: true,
        val: perLoad() ? `${money0(m.lo * mi)}–${money0(m.hi * mi)}` : `${money2(m.lo)}–${money2(m.hi)}`,
        sub: perLoad() ? `${money2(m.lo)}–${money2(m.hi)}/mi` : `${money0(m.lo * mi)}–${money0(m.hi * mi)} per load` }) +
      (q.total > 0 ? tile({ title: 'Your quote', cls: 'lv-you', val: (perLoad() ? money0(q.total) : money2(q.rpm)) + unit(),
        sub: perLoad() ? money2(q.rpm) + '/mi' : money0(q.total) + ' per load', foot: vs !== null ? `${signed(vs)} vs this month's market` : '' }) : '');
  }

  function noteHTML(m) {
    const region = m.oRegion === 'national' ? 'national' : REGION_NAME[m.oRegion];
    return `Market rate: this month's ${esc(region)} ${EQ_NAME[m.eq].toLowerCase()} average × ${m.dm.toFixed(2)} for ${Math.round(m.miles).toLocaleString('en-US')} miles ` +
      `(the calculator's distance curve), before your load details and margin.${m.oRegion === 'national' && !m.oState ? ' Add the pickup state (e.g. "Hastings, FL") to use its region.' : ''}` +
      (m.updated ? ` Rates updated ${esc(m.updated)}.` : '');
  }

  function chartPanelHTML(m) {
    const legend = `<span><i style="background:var(--series-region)"></i>This lane</span>` +
      `<span><i style="background:var(--series-national)"></i>National, same distance</span>` +
      (m.points.length ? (m.winLoss
        ? `<span><i class="dot"></i>Won</span><span><i class="ring"></i>Lost</span><span><i class="open"></i>Open</span>`
        : `<span><i class="open"></i>Your quotes</span>`) : '');
    const rows = m.months.slice().reverse().map((p) => `<tr><td>${esc(p.label)}</td><td class="num strong">${showVal(p.lane, m.miles)}</td>` +
      `<td class="num">${showVal(p.national, m.miles)}</td></tr>`).join('');
    return panelHead(ICON.chart, 'Market rate history', `${EQ_NAME[m.eq]} · ${perLoad() ? 'per load' : 'per mile'}`,
        `<button type="button" class="lv-link" data-act="table" aria-expanded="${showTable}">${showTable ? 'Show chart' : 'Show as table'}</button>`) +
      `<div class="lv-panel-body">
        <div class="lv-legend">${legend}</div>
        <div class="lv-chart"${showTable ? ' hidden' : ''}><div class="lv-tip" hidden></div></div>
        <div class="lv-table-wrap"${showTable ? '' : ' hidden'}><table class="lv-table"><thead><tr><th scope="col">Month</th>
          <th scope="col" class="num">This lane</th><th scope="col" class="num">National, same distance</th></tr></thead><tbody>${rows}</tbody></table></div>
      </div>
      <div class="lv-panel-foot">${noteHTML(m)}</div>`;
  }

  function niceScale(lo, hi) {
    let range = hi - lo;
    if (!(range > 0)) range = Math.abs(hi) * 0.1 || 1;
    const rough = range / 4, mag = Math.pow(10, Math.floor(Math.log10(rough))), n = rough / mag;
    const step = (n <= 1 ? 1 : n <= 2 ? 2 : n <= 2.5 ? 2.5 : n <= 5 ? 5 : 10) * mag;
    let y0 = Math.floor(lo / step) * step, y1 = Math.ceil(hi / step) * step;
    if (y1 - y0 < step * 2) { y0 -= step; y1 += step; }
    if (y0 < 0) y0 = 0;
    return { y0, y1, step };
  }

  function drawChart(m) {
    const box = host.querySelector('.lv-chart');
    if (!box || box.hidden) return;
    const tip = box.querySelector('.lv-tip');
    const W = Math.max(300, Math.round(box.clientWidth || 640)), H = 260;
    const narrow = W < 560;
    const load = perLoad();
    const v = (rpm) => (load ? rpm * m.miles : rpm);
    const fmt = (x) => (load ? money0(x) : money2(x));
    const pad = { l: load ? 60 : 48, r: narrow ? 14 : 124, t: 12, b: 28 };
    const dots = m.points.filter((p) => isFinite(p.t));
    let t0 = m.months[0].t, t1 = m.months[m.months.length - 1].t;
    dots.forEach((p) => { t0 = Math.min(t0, p.t); t1 = Math.max(t1, p.t); });
    if (t1 - t0 < 30 * DAY) { t0 -= 15 * DAY; t1 += 15 * DAY; }
    const vals = m.months.map((p) => v(p.lane)).concat(m.months.map((p) => v(p.national)), dots.map((p) => (load ? p.load : p.mile)));
    const { y0, y1, step } = niceScale(Math.min(...vals), Math.max(...vals));
    const X = (t) => pad.l + (W - pad.l - pad.r) * ((t - t0) / (t1 - t0));
    const Y = (x) => pad.t + (H - pad.t - pad.b) * (1 - (x - y0) / (y1 - y0));
    const ticks = [];
    for (let y = y0; y <= y1 + step / 1000; y += step) ticks.push(y);
    const path = (key) => m.months.map((p, i) => (i ? 'L' : 'M') + X(p.t).toFixed(1) + ' ' + Y(v(p[key])).toFixed(1)).join(' ');
    // End labels, spread apart with a leader line when they'd collide
    const last = m.months[m.months.length - 1];
    const ends = [{ name: 'This lane', c: 'var(--series-region)', val: v(last.lane) }, { name: 'National', c: 'var(--series-national)', val: v(last.national) }];
    ends.forEach((e) => { e.y = Y(e.val); e.ly = e.y; });
    if (Math.abs(ends[0].y - ends[1].y) < 16) {
      const mid = (ends[0].y + ends[1].y) / 2, top = ends[0].y <= ends[1].y ? 0 : 1;
      ends[top].ly = mid - 8; ends[1 - top].ly = mid + 8;
    }
    const lx = X(last.t);
    const endMarks = ends.map((e) => `<circle cx="${lx}" cy="${e.y}" r="4" fill="${e.c}" stroke="var(--card)" stroke-width="2"/>` +
      (narrow ? '' : (e.ly !== e.y ? `<line x1="${lx + 5}" y1="${e.y}" x2="${lx + 12}" y2="${e.ly}" stroke="var(--axis)" stroke-width="1"/>` : '') +
        `<text class="lbl" x="${lx + 14}" y="${e.ly + 4}">${e.name} ${fmt(e.val)}</text>`)).join('');
    const dotMarks = dots.map((p, i) => {
      const cx = X(p.t).toFixed(1), cy = Y(load ? p.load : p.mile).toFixed(1);
      const mark = p.outcome === 'won' ? `<circle cx="${cx}" cy="${cy}" r="4.5" fill="var(--text)" stroke="var(--card)" stroke-width="2"/>`
        : p.outcome === 'lost' ? `<circle cx="${cx}" cy="${cy}" r="4" fill="var(--card)" stroke="var(--text)" stroke-width="2"/>`
          : `<circle cx="${cx}" cy="${cy}" r="4" fill="var(--text3)" stroke="var(--card)" stroke-width="1.5"/>`;
      return `<g class="lv-q" data-i="${i}">${mark}<circle cx="${cx}" cy="${cy}" r="10" fill="transparent"/></g>`;
    }).join('');
    const labels = m.months.map((p, i) => (narrow && m.months.length > 6 && i % 2 !== (m.months.length - 1) % 2) ? ''
      : `<text x="${X(p.t)}" y="${H - 8}" text-anchor="middle">${esc(monthShort(p.t))}</text>`).join('');
    box.innerHTML = `<svg viewBox="0 0 ${W} ${H}" height="${H}" role="img" aria-label="${EQ_NAME[m.eq]} market rate ${load ? 'per load' : 'per mile'} for this lane by month, with the national rate for the same distance${dots.length ? ' and your quotes' : ''}. The table view lists every value.">
      ${ticks.map((y) => `<line x1="${pad.l}" x2="${W - pad.r + (narrow ? 0 : 8)}" y1="${Y(y)}" y2="${Y(y)}" stroke="var(--grid)" stroke-width="1"/>
        <text x="${pad.l - 10}" y="${Y(y) + 4}" text-anchor="end" style="font-variant-numeric:tabular-nums">${fmt(y)}</text>`).join('')}
      ${labels}
      <path d="${path('national')}" fill="none" stroke="var(--series-national)" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>
      <path d="${path('lane')}" fill="none" stroke="var(--series-region)" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>
      ${endMarks}
      <line class="lv-cross" x1="0" x2="0" y1="${pad.t}" y2="${H - pad.b}" stroke="var(--axis)" stroke-width="1" visibility="hidden"/>
      <rect class="lv-hit" x="${pad.l}" y="${pad.t}" width="${W - pad.l - pad.r}" height="${H - pad.t - pad.b}" fill="transparent"/>
      ${dotMarks}
    </svg>`;
    box.appendChild(tip);
    const svg = box.querySelector('svg'), cross = box.querySelector('.lv-cross');
    const place = (cx, cy) => {
      const r = box.getBoundingClientRect(), scale = r.width / W;
      let x = cx * scale + 14;
      if (x + tip.offsetWidth > r.width) x = cx * scale - tip.offsetWidth - 14;
      tip.style.left = Math.max(0, x) + 'px';
      tip.style.top = Math.max(0, Math.min(cy * scale - 20, r.height - tip.offsetHeight)) + 'px';
    };
    const hide = () => { tip.hidden = true; cross.setAttribute('visibility', 'hidden'); };
    const show = (e) => {
      const g = e.target.closest && e.target.closest('.lv-q');
      const r = box.getBoundingClientRect(), px = (e.clientX - r.left) * (W / r.width);
      if (g) {
        const p = dots[Number(g.dataset.i)];
        const q = p.q;
        const res = p.outcome === 'won' ? `Won${p.booked ? ' at ' + money0(p.booked) : ''}` : p.outcome === 'lost' ? `Lost${p.wentFor ? ' · went for ' + money0(p.wentFor) : ''}` : (m.winLoss ? 'Open' : '');
        tip.innerHTML = `<b>${esc(dayLabel(p.t))}${q.customer ? ' · ' + esc(q.customer) : ''}</b>` +
          `<div class="row"><span>Quoted</span><strong>${money0(p.quoted)} · ${money2(p.quotedMile)}/mi</strong></div>` +
          (res ? `<div class="row"><span>Result</span><strong>${esc(res)}</strong></div>` : '') +
          (p.market ? `<div class="row"><span>Market then</span><strong>${money2(p.market)}/mi</strong></div>` : '');
        tip.hidden = false;
        cross.setAttribute('visibility', 'hidden');
        place(X(p.t), Y(load ? p.load : p.mile));
        return;
      }
      if (px < pad.l || px > W - pad.r) { hide(); return; }
      let best = 0;
      m.months.forEach((p, i) => { if (Math.abs(X(p.t) - px) < Math.abs(X(m.months[best].t) - px)) best = i; });
      const p = m.months[best], cx = X(p.t);
      cross.setAttribute('x1', cx); cross.setAttribute('x2', cx); cross.setAttribute('visibility', 'visible');
      const mine = dots.filter((d) => Math.abs(d.t - p.t) <= 15 * DAY).length;
      tip.innerHTML = `<b>${esc(monthLong(p.t))}</b>` +
        `<div class="row"><span><i style="background:var(--series-region)"></i>This lane</span><strong>${fmt(v(p.lane))}</strong></div>` +
        `<div class="row"><span><i style="background:var(--series-national)"></i>National</span><strong>${fmt(v(p.national))}</strong></div>` +
        (mine ? `<div class="row"><span>Your quotes that month</span><strong>${mine}</strong></div>` : '');
      tip.hidden = false;
      place(cx, pad.t + 8);
    };
    // A mouse shows the numbers on hover. A finger or pen shows them on a tap, and they stay
    // up until a tap somewhere else: a touch "leaves" the chart as soon as the finger lifts.
    svg.addEventListener('pointermove', (e) => { if (e.pointerType === 'mouse') show(e); });
    svg.addEventListener('pointerleave', (e) => { if (e.pointerType === 'mouse') hide(); });
    let down = null;
    svg.addEventListener('pointerdown', (e) => { down = e.pointerType === 'mouse' ? null : { x: e.clientX, y: e.clientY, t: Date.now() }; });
    svg.addEventListener('pointercancel', () => { down = null; });
    svg.addEventListener('pointerup', (e) => {
      const d = down;
      down = null;
      if (d && e.pointerType !== 'mouse' && Math.hypot(e.clientX - d.x, e.clientY - d.y) < 12 && Date.now() - d.t < 800) show(e);
    });
    if (!tapAwayWired) {
      tapAwayWired = true;
      document.addEventListener('pointerdown', (e) => {
        if (e.pointerType === 'mouse') return;
        document.querySelectorAll('.lv-chart').forEach((b) => {
          if (b.contains(e.target)) return;
          const t = b.querySelector('.lv-tip'), c = b.querySelector('.lv-cross');
          if (t) t.hidden = true;
          if (c) c.setAttribute('visibility', 'hidden');
        });
      });
    }
  }

  function quotesHTML(m) {
    const head = (extra) => panelHead(ICON.quotes, 'Your quotes on this lane', EQ_NAME[m.eq], extra);
    const body = (html) => `<div class="lv-panel-body">${html}</div>`;
    if (!m.signedIn) {
      return head() + body(`<div class="lv-empty">Pro saves every quote you send. The next time you price this lane, your past quotes, and with
        Pro Plus what they booked at, show up here next to the market rate.<br><a class="qf-btn qf-btn-primary" href="/signup.html">See plans</a></div>`);
    }
    const others = m.otherTrailers ? `<div class="lv-muted">${m.otherTrailers} more on ${m.otherTrailers === 1 ? 'another trailer' : 'other trailers'}.</div>` : '';
    if (!m.points.length) {
      return head() + body(`<div class="lv-empty">No saved ${EQ_NAME[m.eq].toLowerCase()} quotes on this lane yet. Save this quote to the quote log and it shows up here,
        next to the market rate, the next time you pull up the lane.</div>${others}`);
    }
    const s = m.stats;
    const stat = (label, value) => `<div class="lv-stat">${label}<b>${value}</b></div>`;
    const stats = stat('Quotes', s.quotes.toLocaleString('en-US')) +
      (m.winLoss ? stat('Win rate', s.winRate === null ? '—' : `${Math.round(s.winRate * 100)}% <small style="font-size:11px;color:var(--text3);font-weight:500">${s.won} won · ${s.lost} lost</small>`) : '') +
      stat('Avg quoted', s.avgQuoted ? money2(s.avgQuoted) + '/mi' : '—') +
      (m.winLoss ? stat('Avg booked', s.avgBooked ? money2(s.avgBooked) + '/mi' : '—') : '') +
      (s.vsMarket !== null ? stat('Quoted vs market', signed(s.vsMarket)) : '');
    const list = showAllQuotes ? m.points : m.points.slice(0, ROWS);
    const rows = list.map((p) => {
      const q = p.q;
      const result = p.outcome === 'won' ? `<span class="lv-result won">Won</span>` : p.outcome === 'lost' ? `<span class="lv-result lost">Lost</span>` : `<span class="lv-result">Open</span>`;
      const final = p.outcome === 'won' ? money0(p.booked) : p.outcome === 'lost' && p.wentFor ? 'went for ' + money0(p.wentFor) : '—';
      return `<tr><td>${isFinite(p.t) ? esc(dayLabel(p.t)) : esc(q.date || '')}</td><td class="wrap">${esc(q.customer || '—')}</td>` +
        `<td class="num strong">${money0(p.quoted)}</td><td class="num">${money2(p.quotedMile)}</td>` +
        (m.winLoss ? `<td>${result}</td><td class="num">${final}</td>` : '') + '</tr>';
    }).join('');
    const more = m.points.length > ROWS
      ? `<button type="button" class="lv-link" data-act="more">${showAllQuotes ? 'Show fewer' : `Show all ${m.points.length}`}</button>` : '';
    return head(more) + body(`<div class="lv-stats">${stats}</div>
      <div class="lv-table-wrap"><table class="lv-table"><thead><tr><th scope="col">Date</th><th scope="col">Customer</th><th scope="col" class="num">Quoted</th>
        <th scope="col" class="num">Per mile</th>${m.winLoss ? '<th scope="col">Result</th><th scope="col" class="num">Final rate</th>' : ''}</tr></thead>
        <tbody>${rows}</tbody></table></div>${others}` +
      (m.winLoss ? '' : `<div class="lv-muted">Mark quotes won or lost with Pro Plus to see your win rate and booked rates here.</div>`));
  }

  function marketsHTML(m) {
    const k = m.markets, nat = k.national;
    const end = (label, e, isDest) => {
      if (!e.rate || !nat) return '';
      const d = e.rate / nat - 1;
      const pos = 50 + Math.max(-1, Math.min(1, d / 0.25)) * 50;
      const where = e.region === 'national' ? 'the US' : 'the ' + REGION_NAME[e.region];
      let read = Math.abs(d) < 0.03 ? `Trucks leaving ${where} earn about the national rate.`
        : `Trucks leaving ${where} earn ${pctAbs(d, 0)} ${d > 0 ? 'more' : 'less'} than the national rate.`;
      if (isDest && Math.abs(d) >= 0.03) read += d < 0 ? ' A weaker reload: carriers may ask more to deliver here.' : ' A strong reload: carriers may take less to get here.';
      return `<div class="lv-end">
        <div class="lv-end-label">${label}</div>
        <div class="lv-end-place">${esc(e.place)}</div>
        <div class="lv-end-region">${REGION_NAME[e.region]} market</div>
        <div class="lv-end-rate">${money2(e.rate)}<em>/mi out</em></div>
        <div class="lv-meter" role="img" aria-label="${pctAbs(d)} ${d >= 0 ? 'above' : 'below'} the national rate"><i style="left:${pos.toFixed(1)}%"></i></div>
        <div class="lv-meter-scale"><span>Below</span><span>National ${money2(nat)}</span><span>Above</span></div>
        <p>${read}</p></div>`;
    };
    let lt = '';
    if (k.lt) {
      const d = k.lt.current / k.lt.base - 1;
      const word = d > 0.1 ? 'tight' : d < -0.1 ? 'loose' : 'balanced';
      lt = `${EQ_NAME[m.eq]} load-to-truck nationally: <b style="color:var(--text)">${k.lt.current}</b> loads per truck,
        ${pctAbs(d, 0)} ${d >= 0 ? 'above' : 'below'} usual (${k.lt.base}): a ${word} market.`;
    }
    return panelHead(ICON.markets, 'Markets at both ends', EQ_NAME[m.eq]) +
      `<div class="lv-panel-body"><div class="lv-ends">${end('Pickup', k.origin, false)}${end('Delivery', k.dest, true)}</div></div>` +
      (lt ? `<div class="lv-panel-foot">${lt}</div>` : '');
  }

  // Miles and fuel. Drive time and driving days are in the HOS trip plan below
  // (the calculator's own card, shown whenever Google gave a drive time).
  function tripHTML(m) {
    const t = m.trip;
    const gal = t.miles / MPG;
    const fuel = diesel && diesel.price > 0 ? diesel : null;
    const period = fuel && fuel.period ? new Date(fuel.period + 'T12:00:00') : null;
    const fact = (label, value, sub) => `<div><small>${label}</small><b>${value}</b>${sub ? `<span>${sub}</span>` : ''}</div>`;
    return panelHead(ICON.fuel, 'Trip and fuel') + `<div class="lv-panel-body"><div class="lv-facts">` +
      fact('Miles', Math.round(t.miles).toLocaleString('en-US'), t.source === 'google' ? 'Google Maps' : 'Entered by you') +
      fact('Fuel', `${Math.round(gal).toLocaleString('en-US')} gal`, `At ${MPG} mpg`) +
      fact('Fuel cost', fuel ? money0(gal * fuel.price) : diesel === undefined ? '…' : '—',
        fuel ? `${money2(fuel.price)}/gal${period && isFinite(period) ? ' · EIA ' + period.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) : ''}` : 'Diesel price unavailable') +
      fact('Fuel surcharge', fuel ? money2(Math.max(0, (fuel.price - FSC_BASE) / MPG)) + '/mi' : '—', fuel ? 'DOE method, $1.25 base' : '') +
      '</div></div>';
  }

  function renderMap(m) {
    const o = m.map.orig, d = m.map.dest;
    const state = `${mapsKey === undefined ? 'wait' : mapsKey ? 'key' : 'none'}|${o}|${d}|${m.trip.source}`;
    if (state === mapShown) return;
    mapShown = state;
    const q = (s) => encodeURIComponent(s);
    const dir = `https://www.google.com/maps/dir/?api=1&origin=${q(o)}&destination=${q(d)}&travelmode=driving`;
    const embed = mapsKey ? `https://www.google.com/maps/embed/v1/directions?key=${q(mapsKey)}&origin=${q(o)}&destination=${q(d)}&mode=driving&units=imperial` : '';
    parts.map.innerHTML = panelHead(ICON.route, 'Route', '',
        `<a class="lv-link" href="${esc(dir)}" target="_blank" rel="noopener">Open in Google Maps ↗</a>`) + `
      <div class="lv-panel-body"><div class="lv-map">${embed
        ? `<iframe title="Route from ${esc(placeLabel(o))} to ${esc(placeLabel(d))} on Google Maps" src="${esc(embed)}" loading="lazy" referrerpolicy="no-referrer-when-downgrade"></iframe>`
        : `<div class="lv-map-empty">${ICON.route}<p>See the route from ${esc(placeLabel(o))} to ${esc(placeLabel(d))} on Google Maps.</p>
            <a class="qf-btn qf-btn-ghost" href="${esc(dir)}" target="_blank" rel="noopener">Open the route ↗</a></div>`}</div></div>
      <div class="lv-panel-foot lv-credit">${m.trip.source === 'google' ? 'Miles and drive time from Google Maps.' : 'Miles entered by you; Google Maps may route differently.'}</div>`;
  }

  // ── Data the view fetches itself: diesel and the map key, once each ────
  let dieselAsked = false, mapAsked = false;
  function loadExtras() {
    const redrawTrip = () => { if (current) parts.trip.innerHTML = tripHTML(current); };
    if (!dieselAsked) {
      dieselAsked = true;
      let cached = null;
      try {
        const c = JSON.parse(sessionStorage.getItem('qfc_diesel_cache') || '{}');
        if (Number(c.price) > 0 && c.ts && Date.now() - c.ts < 1800000) cached = { price: Number(c.price), period: c.period || '' };
      } catch (e) {}
      if (cached) { diesel = cached; redrawTrip(); }
      else {
        fetch('/.netlify/functions/diesel-price').then((r) => r.json()).then((d) => {
          const price = Number(d && d.price);
          diesel = price > 0 ? { price, period: d.period || '' } : null;
          if (diesel) { try { sessionStorage.setItem('qfc_diesel_cache', JSON.stringify({ price, period: diesel.period, ts: Date.now() })); } catch (e) {} }
        }).catch(() => { diesel = null; }).then(redrawTrip);
      }
    }
    if (!mapAsked) {
      mapAsked = true;
      fetch('/.netlify/functions/maps-config').then((r) => r.json()).then((d) => {
        mapsKey = d && typeof d.embedKey === 'string' && d.embedKey ? d.embedKey : null;
      }).catch(() => { mapsKey = null; }).then(() => { if (current) renderMap(current); });
    }
  }

  // ── Render ──────────────────────────────────────────────────────────────
  function skeleton() {
    if (parts.head) return;
    adopted.forEach((a) => a.el.remove());   // kept, and put back below
    host.innerHTML = `<div class="lv-bar" data-part="head"></div>
      <div class="lv-tiles" data-part="tiles"></div>
      <div class="lv-grid">
        <div class="lv-row lv-row-wide"><section class="lv-panel" data-part="chart"></section><section class="lv-panel" data-part="map"></section></div>
        <div class="lv-row"><section class="lv-panel" data-part="markets"></section><div data-slot="weather"></div></div>
        <div class="lv-row"><div data-slot="hos"></div><section class="lv-panel" data-part="trip"></section></div>
        <section class="lv-panel" data-part="quotes"></section>
      </div>`;
    host.querySelectorAll('[data-part]').forEach((el) => { parts[el.dataset.part] = el; });
    adopted.forEach((a) => {
      const slot = host.querySelector(`[data-slot="${a.slot}"]`);
      if (slot) slot.replaceWith(a.el);
      else host.querySelector('.lv-grid').appendChild(a.el);
    });
    host.querySelectorAll('[data-slot]').forEach((el) => el.remove());   // slots with no card
  }

  function render() {
    timer = null;
    const lane = getLane ? getLane() : null;
    const rates = window.QFC_RATES;
    const ok = !!(lane && lane.orig && lane.dest && Number(lane.miles) > 0 && rates && rates.regions);
    host.hidden = !ok;
    if (jump) jump.hidden = !ok;
    if (!ok) { current = null; return; }
    skeleton();
    const m = build(lane, rates);
    if (current && placeKey(current.lane.orig) + '>' + placeKey(current.lane.dest) + current.eq !== placeKey(lane.orig) + '>' + placeKey(lane.dest) + m.eq) showAllQuotes = false;
    const laneKey = placeKey(lane.orig) + '>' + placeKey(lane.dest);
    if (laneKey !== weatherFor && typeof window.triggerWeatherUpdate === 'function') { weatherFor = laneKey; window.triggerWeatherUpdate(); }
    current = m;
    parts.head.innerHTML = headHTML(m);
    parts.tiles.innerHTML = tilesHTML(m);
    parts.chart.innerHTML = chartPanelHTML(m);
    drawChart(m);
    parts.quotes.innerHTML = quotesHTML(m);
    parts.markets.innerHTML = marketsHTML(m);
    parts.trip.innerHTML = tripHTML(m);
    renderMap(m);
    loadExtras();
  }

  function setMode(next) {
    if (next !== 'load' && next !== 'mile') return;
    mode = next;
    try { localStorage.setItem(MODE_KEY, next); } catch (e) {}
    if (current) render();
  }

  function init(opts) {
    host = opts.container;
    jump = opts.jump || null;
    getLane = opts.getLane;
    if (!host) return;
    host.hidden = true;
    if (jump) jump.hidden = true;
    adopted = [...document.querySelectorAll('[data-lane-slot]')].filter((el) => !host.contains(el))
      .map((el) => ({ el, slot: el.dataset.laneSlot }));
    adopted.forEach((a) => host.appendChild(a.el));   // hidden with the view until a lane shows
    host.addEventListener('click', (e) => {
      const b = e.target.closest('[data-mode]');
      if (b) { setMode(b.dataset.mode); return; }
      const a = e.target.closest('[data-act]');
      if (!a) return;
      if (a.dataset.act === 'table') { showTable = !showTable; if (current) { parts.chart.innerHTML = chartPanelHTML(current); drawChart(current); } }
      if (a.dataset.act === 'more') { showAllQuotes = !showAllQuotes; if (current) parts.quotes.innerHTML = quotesHTML(current); }
    });
    // Redraw when the chart gets wider or narrower. A phone's address bar showing and hiding
    // while scrolling only changes the height, and a redraw then would put tapped numbers away.
    let chartW = 0;
    window.addEventListener('resize', () => {
      clearTimeout(resizeTimer);
      resizeTimer = setTimeout(() => {
        const b = host && host.querySelector('.lv-chart'), w = b ? b.clientWidth : 0;
        if (current && w !== chartW) { chartW = w; drawChart(current); }
      }, 150);
    });
    refresh();
  }

  function refresh(now) {
    if (!host) return;
    clearTimeout(timer);
    if (now === true) render();
    else timer = setTimeout(render, 150);
  }

  window.QFCLane = { init, refresh, _build: build };

  // On the calculator: the section under the quote, fed by its laneForView().
  function auto() {
    const el = document.getElementById('lane-view');
    if (el && typeof window.laneForView === 'function') {
      init({ container: el, jump: document.getElementById('lane-jump'), getLane: window.laneForView });
    }
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', auto);
  else auto();
})();
