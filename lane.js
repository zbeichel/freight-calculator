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
  const HOS_HOURS = 11;      // FMCSA daily driving limit
  const WINLOSS = ['plus', 'max', 'api', 'comp'];
  const MODE_KEY = 'qfc_lane_mode';
  const DAY = 86400000;
  const ROWS = 8;            // quotes listed before "Show all"

  let host = null, jump = null, getLane = null;
  let mode = 'load';
  try { if (localStorage.getItem(MODE_KEY) === 'mile') mode = 'mile'; } catch (e) {}
  let showTable = false, showAllQuotes = false;
  let timer = null, resizeTimer = null;
  let diesel;                // undefined: not asked yet · null: unavailable · { price, period }
  let mapsKey;               // undefined: not asked yet · null: none set · 'key'
  let current = null;        // the model on screen
  let mapShown = '';         // what the route panel shows, so the map isn't reloaded needlessly
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
  const ICON_ROUTE = '<svg class="qf-icon" viewBox="0 0 24 24" aria-hidden="true"><circle cx="6" cy="6" r="2.2"/>' +
    '<path d="M8.2 6H15a3 3 0 0 1 0 6H9a3 3 0 0 0 0 6h6.8"/><circle cx="18" cy="18" r="2.2"/></svg>';

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
    return `<div>
      <div class="lv-kicker">Lane details</div>
      <div class="lv-title"><span>${esc(placeLabel(m.lane.orig))}</span><span class="lv-arrow">→</span><span>${esc(placeLabel(m.lane.dest))}</span>
        <span class="lv-eq">${EQ_NAME[m.eq]}</span></div>
      <div class="lv-sub"><span><b>${Math.round(m.miles).toLocaleString('en-US')}</b> mi</span>
        ${t.driveSecs ? `<span><b>${duration(t.driveSecs)}</b> drive</span>` : ''}
        <span>Pickup market <b>${REGION_NAME[m.oRegion]}</b></span>
        <span>Delivery market <b>${REGION_NAME[m.dRegion]}</b></span></div>
    </div>
    <div class="lv-seg" role="group" aria-label="Show rates">
      <button type="button" data-mode="load" aria-pressed="${perLoad()}">Per load</button>
      <button type="button" data-mode="mile" aria-pressed="${!perLoad()}">Per mile</button>
    </div>`;
  }

  function change(now, before, label) {
    if (!before) return '';
    const d = now / before - 1;
    if (Math.abs(d) < 0.0005) return `<span>Flat vs ${esc(label)}</span>`;
    return `<span>${d > 0 ? ARROW.up : ARROW.down}${d > 0 ? 'Up' : 'Down'} ${pctAbs(d)} vs ${esc(label)}</span>`;
  }

  function tilesHTML(m) {
    const mi = m.miles, last = m.last, prev = m.prev, first = m.months[0];
    const tile = (label, rpm, extra, cls) => `<div class="lv-tile${cls ? ' ' + cls : ''}"><small>${label}</small>
      <b>${showVal(rpm, mi)}${unit()}</b><span>${other(rpm, mi)}</span>${extra || ''}</div>`;
    const range = perLoad() ? `${money0(m.lo * mi)}–${money0(m.hi * mi)}` : `${money2(m.lo)}–${money2(m.hi)}`;
    const rangeOther = perLoad() ? `${money2(m.lo)}–${money2(m.hi)}/mi` : `${money0(m.lo * mi)}–${money0(m.hi * mi)} per load`;
    const q = m.quote;
    const vs = q.total > 0 && last.lane > 0 ? q.total / (last.lane * mi) - 1 : null;
    const short = (p) => esc(String(p.label).replace(/\s+\d{4}$/, ''));
    return tile(`This month · ${esc(last.label)}`, last.lane, prev ? change(last.lane, prev.lane, short(prev)) : '') +
      (prev ? tile(`Last month · ${esc(prev.label)}`, prev.lane) : '') +
      tile(`${m.months.length >= 3 ? '3-month' : `${m.months.length}-month`} average`, m.avg3,
        `<span>${esc(m.months.slice(-3).map((p) => monthShort(p.t)).filter((x, i, a) => i === 0 || i === a.length - 1).join('–'))}</span>`) +
      `<div class="lv-tile"><small>Range since ${esc(first.label)}</small><b style="font-size:18px">${range}</b><span>${rangeOther}</span></div>` +
      (q.total > 0 ? `<div class="lv-tile lv-you"><small>Your quote</small><b>${perLoad() ? money0(q.total) : money2(q.rpm)}${unit()}</b>
        <span>${perLoad() ? money2(q.rpm) + '/mi' : money0(q.total) + ' per load'}</span>
        ${vs !== null ? `<span>${signed(vs)} vs this month's market</span>` : ''}</div>` : '');
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
    return `<div class="lv-panel-head"><h3>Market rate history<small>${EQ_NAME[m.eq]} · ${perLoad() ? 'per load' : 'per mile'}</small></h3>
        <button type="button" class="lv-link" data-act="table" aria-expanded="${showTable}">${showTable ? 'Show chart' : 'Show as table'}</button></div>
      <div class="lv-legend">${legend}</div>
      <div class="lv-chart"${showTable ? ' hidden' : ''}><div class="lv-tip" hidden></div></div>
      <div class="lv-table-wrap"${showTable ? '' : ' hidden'}><table class="lv-table"><thead><tr><th scope="col">Month</th>
        <th scope="col" class="num">This lane</th><th scope="col" class="num">National, same distance</th></tr></thead><tbody>${rows}</tbody></table></div>`;
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
    svg.addEventListener('pointermove', (e) => {
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
    });
    svg.addEventListener('pointerleave', hide);
  }

  function quotesHTML(m) {
    const head = (extra) => `<div class="lv-panel-head"><h3>Your quotes on this lane<small>${EQ_NAME[m.eq]}</small></h3>${extra || ''}</div>`;
    if (!m.signedIn) {
      return head() + `<div class="lv-empty">Pro saves every quote you send. The next time you price this lane, your past quotes, and with
        Pro Plus what they booked at, show up here next to the market rate.<br><a class="qf-btn qf-btn-primary" href="/signup.html">See plans</a></div>`;
    }
    const others = m.otherTrailers ? `<div class="lv-muted">${m.otherTrailers} more on ${m.otherTrailers === 1 ? 'another trailer' : 'other trailers'}.</div>` : '';
    if (!m.points.length) {
      return head() + `<div class="lv-empty">No saved ${EQ_NAME[m.eq].toLowerCase()} quotes on this lane yet. Save this quote to the quote log and it shows up here,
        next to the market rate, the next time you pull up the lane.</div>${others}`;
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
    return head(more) + `<div class="lv-stats">${stats}</div>
      <div class="lv-table-wrap"><table class="lv-table"><thead><tr><th scope="col">Date</th><th scope="col">Customer</th><th scope="col" class="num">Quoted</th>
        <th scope="col" class="num">Per mile</th>${m.winLoss ? '<th scope="col">Result</th><th scope="col" class="num">Final rate</th>' : ''}</tr></thead>
        <tbody>${rows}</tbody></table></div>${others}` +
      (m.winLoss ? '' : `<div class="lv-muted">Mark quotes won or lost with Pro Plus to see your win rate and booked rates here.</div>`);
  }

  function marketsHTML(m) {
    const k = m.markets, nat = k.national;
    const one = (label, end, isDest) => {
      if (!end.rate || !nat) return '';
      const d = end.rate / nat - 1;
      const pos = 50 + Math.max(-1, Math.min(1, d / 0.25)) * 50;
      const where = end.region === 'national' ? 'the US' : 'the ' + REGION_NAME[end.region];
      let read = Math.abs(d) < 0.03 ? `Trucks leaving ${where} earn about the national rate.`
        : `Trucks leaving ${where} earn ${pctAbs(d, 0)} ${d > 0 ? 'more' : 'less'} than the national rate.`;
      if (isDest && Math.abs(d) >= 0.03) read += d < 0 ? ' A weaker reload: carriers may ask more to deliver here.' : ' A strong reload: carriers may take less to get here.';
      return `<div class="lv-mkt">
        <div class="lv-mkt-top"><small>${label}</small><b>${money2(end.rate)}<span style="font-size:12px;color:var(--text3);font-weight:500">/mi out</span></b></div>
        <div class="lv-mkt-place">${esc(end.place)} · ${REGION_NAME[end.region]}</div>
        <div class="lv-meter" role="img" aria-label="${pctAbs(d)} ${d >= 0 ? 'above' : 'below'} the national rate"><i style="left:${pos.toFixed(1)}%"></i></div>
        <div class="lv-meter-scale"><span>Below national</span><span>${money2(nat)}</span><span>Above</span></div>
        <p>${read}</p></div>`;
    };
    let lt = '';
    if (k.lt) {
      const d = k.lt.current / k.lt.base - 1;
      const word = d > 0.1 ? 'tight' : d < -0.1 ? 'loose' : 'balanced';
      lt = `<div class="lv-muted">${EQ_NAME[m.eq]} load-to-truck nationally: <b style="color:var(--text)">${k.lt.current}</b> loads per truck,
        ${pctAbs(d, 0)} ${d >= 0 ? 'above' : 'below'} usual (${k.lt.base}): a ${word} market.</div>`;
    }
    return `<div class="lv-panel-head"><h3>Markets at both ends<small>${EQ_NAME[m.eq]}</small></h3></div>` +
      one('Pickup', k.origin, false) + one('Delivery', k.dest, true) + lt;
  }

  function tripHTML(m) {
    const t = m.trip;
    const days = t.driveSecs ? Math.max(1, Math.ceil(t.driveSecs / 3600 / HOS_HOURS)) : null;
    const gal = t.miles / MPG;
    const fuel = diesel && diesel.price > 0 ? diesel : null;
    const period = fuel && fuel.period ? new Date(fuel.period + 'T12:00:00') : null;
    const fact = (label, value, sub) => `<div><small>${label}</small><b>${value}</b>${sub ? `<span>${sub}</span>` : ''}</div>`;
    return `<div class="lv-panel-head"><h3>Trip and fuel</h3></div><div class="lv-facts">` +
      fact('Miles', Math.round(t.miles).toLocaleString('en-US'), t.source === 'google' ? 'Google Maps' : 'Entered by you') +
      fact('Drive time', t.driveSecs ? duration(t.driveSecs) : '—', t.driveSecs ? 'Google Maps' : 'With Google miles') +
      fact('Driving days', days ? String(days) : '—', days ? `At ${HOS_HOURS} hours a day` : '') +
      fact('Fuel', `${Math.round(gal).toLocaleString('en-US')} gal`, `At ${MPG} mpg`) +
      fact('Fuel cost', fuel ? money0(gal * fuel.price) : diesel === undefined ? '…' : '—',
        fuel ? `${money2(fuel.price)}/gal${period && isFinite(period) ? ' · EIA, week of ' + period.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) : ''}` : 'Diesel price unavailable') +
      fact('Fuel surcharge', fuel ? money2(Math.max(0, (fuel.price - FSC_BASE) / MPG)) + '/mi' : '—', fuel ? 'DOE method, $1.25 base' : '') +
      '</div>';
  }

  function renderMap(m) {
    const o = m.map.orig, d = m.map.dest;
    const state = `${mapsKey === undefined ? 'wait' : mapsKey ? 'key' : 'none'}|${o}|${d}|${m.trip.source}`;
    if (state === mapShown) return;
    mapShown = state;
    const q = (s) => encodeURIComponent(s);
    const dir = `https://www.google.com/maps/dir/?api=1&origin=${q(o)}&destination=${q(d)}&travelmode=driving`;
    const embed = mapsKey ? `https://www.google.com/maps/embed/v1/directions?key=${q(mapsKey)}&origin=${q(o)}&destination=${q(d)}&mode=driving&units=imperial` : '';
    parts.map.innerHTML = `<div class="lv-panel-head"><h3>Route</h3>
        <a class="lv-link" href="${esc(dir)}" target="_blank" rel="noopener">Open in Google Maps ↗</a></div>
      <div class="lv-map">${embed
        ? `<iframe title="Route from ${esc(placeLabel(o))} to ${esc(placeLabel(d))} on Google Maps" src="${esc(embed)}" loading="lazy" referrerpolicy="no-referrer-when-downgrade"></iframe>`
        : `<div class="lv-map-empty">${ICON_ROUTE}<p>See the route from ${esc(placeLabel(o))} to ${esc(placeLabel(d))} on Google Maps.</p>
            <a class="qf-btn qf-btn-ghost" href="${esc(dir)}" target="_blank" rel="noopener">Open the route ↗</a></div>`}</div>
      <div class="lv-credit">${m.trip.source === 'google' ? 'Miles and drive time from Google Maps.' : 'Miles entered by you; Google Maps may route differently.'}</div>`;
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
    host.innerHTML = `<div class="lv-card">
      <div class="lv-head" data-part="head"></div>
      <div class="lv-tiles" data-part="tiles"></div>
      <div class="lv-note" data-part="note"></div>
      <div class="lv-body">
        <div class="lv-main"><section class="lv-panel" data-part="chart"></section><section class="lv-panel" data-part="quotes"></section>
          <section class="lv-panel" data-part="trip"></section></div>
        <div class="lv-side"><section class="lv-panel lv-map-panel" data-part="map"></section><section class="lv-panel" data-part="markets"></section></div>
      </div></div>`;
    host.querySelectorAll('[data-part]').forEach((el) => { parts[el.dataset.part] = el; });
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
    current = m;
    parts.head.innerHTML = headHTML(m);
    parts.tiles.innerHTML = tilesHTML(m);
    parts.note.innerHTML = noteHTML(m);
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
    host.addEventListener('click', (e) => {
      const b = e.target.closest('[data-mode]');
      if (b) { setMode(b.dataset.mode); return; }
      const a = e.target.closest('[data-act]');
      if (!a) return;
      if (a.dataset.act === 'table') { showTable = !showTable; if (current) { parts.chart.innerHTML = chartPanelHTML(current); drawChart(current); } }
      if (a.dataset.act === 'more') { showAllQuotes = !showAllQuotes; if (current) parts.quotes.innerHTML = quotesHTML(current); }
    });
    window.addEventListener('resize', () => {
      clearTimeout(resizeTimer);
      resizeTimer = setTimeout(() => { if (current) drawChart(current); }, 150);
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
