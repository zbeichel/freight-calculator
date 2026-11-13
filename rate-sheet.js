// rate-sheet.js — your own rate sheet (Pro Plus and up): base rates in dollars per mile by
// region and trailer, used on every quote instead of the market averages (rates.json).
// Shared by the pages (window.QFCRateSheet) and the API (require: netlify/lib/quote-engine.js),
// so a quote comes out the same everywhere.
//
// Saved on the account (pro_users.rate_sheet; a team shares the owner's) as
//   { all: { van: 2.95, reefer: 3.40 }, northeast: { flatbed: 3.80 }, ... }
// Each box is optional. For a quote, a region's own rate wins, then the sheet's "all regions"
// rate, then the market rate for the region.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.QFCRateSheet = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  // "all" is the default for every region; the rest are rates.json's regions. A pickup
  // outside them uses "all", then the national market rate.
  const ROWS = ['all', 'northeast', 'southeast', 'midwest', 'southwest', 'west'];
  const ROW_LABEL = {
    all: 'All regions', northeast: 'Northeast', southeast: 'Southeast',
    midwest: 'Midwest', southwest: 'Southwest', west: 'West',
  };
  const TRAILERS = ['van', 'reefer', 'flatbed'];
  const TRAILER_LABEL = { van: 'Dry Van', reefer: 'Reefer', flatbed: 'Flatbed' };
  const MIN = 0.5;
  const MAX = 20;

  // A rate as saved: dollars per mile, two decimals, MIN to MAX. Blank is null; anything
  // else is NaN (not a rate).
  function parseRate(v) {
    if (v === null || v === undefined) return null;
    const s = String(v).replace(/[$,\s]/g, '').replace(/\/mi(le)?$/i, '');
    if (s === '') return null;
    const n = Number(s);
    if (!Number.isFinite(n) || n < MIN || n > MAX) return NaN;
    return Math.round(n * 100) / 100;
  }

  // Just the known rows and trailers with a valid rate, or null when nothing is set.
  function clean(sheet) {
    if (!sheet || typeof sheet !== 'object') return null;
    const out = {};
    for (const r of ROWS) {
      const row = sheet[r];
      if (!row || typeof row !== 'object') continue;
      const o = {};
      for (const t of TRAILERS) {
        const v = parseRate(row[t]);
        if (v !== null && !Number.isNaN(v)) o[t] = v;
      }
      if (Object.keys(o).length) out[r] = o;
    }
    return Object.keys(out).length ? out : null;
  }

  // The sheet's rate for a pickup region and trailer, or null when the market rate applies.
  function sheetRate(sheet, region, trailer) {
    const s = clean(sheet);
    if (!s) return null;
    if (s[region] && s[region][trailer] != null) return s[region][trailer];
    if (s.all && s.all[trailer] != null) return s.all[trailer];
    return null;
  }

  // Base rates for a pickup region: the sheet's where set, otherwise the market's.
  // market: { northeast: { van, reefer, flatbed }, ..., national: {...} } (rates.json regions)
  // Returns { rates: { van, reefer, flatbed }, from: { van: 'sheet' | 'market', ... } }.
  function ratesFor(sheet, market, region) {
    const m = (market && (market[region] || market.national)) || {};
    const rates = {}, from = {};
    for (const t of TRAILERS) {
      const own = sheetRate(sheet, region, t);
      rates[t] = own != null ? own : (Number(m[t]) || null);
      from[t] = own != null ? 'sheet' : 'market';
    }
    return { rates, from };
  }

  // Who gets a rate sheet: Pro Plus, Pro Max, API and comp accounts.
  function allowed(plan, comp) {
    return comp === true || ['plus', 'max', 'api'].includes(plan);
  }

  return { ROWS, ROW_LABEL, TRAILERS, TRAILER_LABEL, MIN, MAX, parseRate, clean, sheetRate, ratesFor, allowed };
});
