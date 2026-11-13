// netlify/lib/quote-engine.js
//
// The truckload quote math from the calculator (index.html → calc()), for the
// API. It must quote exactly what the site quotes for the same inputs, so the
// constants below are copied from index.html, and tests/quote_parity_test.js
// checks this file against the page's own calc() on many lanes.
//
// If you change a constant or the formula in index.html, change it here too
// and run the parity test.
//
//   adjusted rate/mi = base × weight × distance × commodity × capacity × season × holiday × market
//   cost             = (adjusted rate/mi + fuel surcharge/mi) × miles
//   total            = (cost + extra-day charge) × (1 + margin)
//
// Defaults match a first visit to the calculator: regional rates by pickup
// state, no fuel surcharge, capacity / seasonality / holidays off, market 0%,
// 15% margin.

const RATES = require('../../rates.json');
const SHEET = require('../../rate-sheet.js');   // your own rate sheet, as the pages read it

// ── Copied from index.html ──────────────────────────────────────────────────
const CMULT={standard:1.0,food:1.08,hazmat:1.20,highval:1.12,oversized:1.25};
const WTIERS=[{max:9999,m:0.95,l:'0.95×'},{max:29999,m:0.97,l:'0.97×'},{max:44000,m:1.00,l:'1.00×'},{max:999999,m:1.08,l:'1.08×'}];
const DMULTS={
  van:    [{mi:100,m:1.85},{mi:300,m:1.05},{mi:600,m:1.00},{mi:1000,m:1.00},{mi:1500,m:0.85},{mi:2500,m:0.75}],
  reefer: [{mi:100,m:1.80},{mi:300,m:1.05},{mi:600,m:1.00},{mi:1000,m:1.00},{mi:1500,m:0.87},{mi:2500,m:0.77}],
  flatbed:[{mi:100,m:1.55},{mi:300,m:1.05},{mi:600,m:1.00},{mi:1000,m:1.00},{mi:1500,m:0.90},{mi:2500,m:0.80}],
  // Neutral averaged curve for LTL and any caller without trailer context.
  ltl:    [{mi:100,m:1.73},{mi:300,m:1.05},{mi:600,m:1.00},{mi:1000,m:1.00},{mi:1500,m:0.87},{mi:2500,m:0.77}]
};
const LT_BASELINE={van:6.0,reefer:10.0,flatbed:25.0};
const SEASON_PROFILES={
  fl:{label:'Florida produce',sub:'Reefer · potatoes, citrus, tomatoes',
    reefer:[0.94,0.95,1.00,1.06,1.12,1.10,0.97,0.95,0.97,1.04,1.06,0.97],
    van:[0.95,0.96,0.99,1.03,1.06,1.05,0.98,0.97,0.99,1.02,1.03,0.97],
    flatbed:[0.97,0.97,1.00,1.02,1.03,1.02,0.99,0.98,1.00,1.01,1.01,0.98]},
  se:{label:'Southeast spring/summer',sub:'GA, SC, NC · peaches, watermelon, sweet potatoes',
    reefer:[0.95,0.96,1.02,1.07,1.10,1.08,0.98,0.96,0.98,1.02,1.03,0.96],
    van:[0.96,0.97,1.01,1.04,1.06,1.05,0.98,0.97,0.99,1.01,1.02,0.97],
    flatbed:[0.97,0.98,1.01,1.03,1.05,1.04,1.00,0.99,1.01,1.02,1.01,0.97]},
  ca:{label:'California / San Joaquin Valley',sub:'Reefer · grapes, stone fruit, tomatoes, onions',
    reefer:[0.95,0.96,0.98,1.02,1.06,1.10,1.12,1.10,1.07,1.03,0.98,0.95],
    van:[0.96,0.96,0.99,1.01,1.04,1.07,1.08,1.07,1.05,1.02,0.99,0.96],
    flatbed:[0.96,0.97,1.00,1.02,1.04,1.06,1.07,1.06,1.04,1.02,0.99,0.96]},
  pnw:{label:'Pacific Northwest harvest',sub:'WA, OR, ID · apples, pears, potatoes',
    reefer:[0.95,0.95,0.97,0.99,1.01,1.03,1.06,1.10,1.13,1.10,1.02,0.96],
    van:[0.95,0.96,0.98,1.00,1.02,1.03,1.05,1.08,1.10,1.08,1.01,0.96],
    flatbed:[0.95,0.96,0.99,1.02,1.05,1.06,1.07,1.08,1.08,1.05,1.00,0.95]},
  tx:{label:'Texas / Rio Grande Valley',sub:'Reefer · winter citrus, onions, cabbage',
    reefer:[1.07,1.09,1.06,1.02,0.99,0.97,0.96,0.97,1.00,1.02,1.04,1.06],
    van:[1.04,1.05,1.03,1.01,0.99,0.98,0.97,0.98,1.00,1.01,1.02,1.03],
    flatbed:[1.02,1.03,1.04,1.05,1.06,1.04,1.01,1.00,1.02,1.03,1.02,1.00]},
  az:{label:'Arizona / Yuma winter',sub:'Reefer · lettuce, winter vegetables',
    reefer:[1.08,1.10,1.07,1.02,0.97,0.95,0.94,0.95,0.98,1.02,1.05,1.07],
    van:[1.04,1.05,1.03,1.01,0.98,0.97,0.96,0.97,0.99,1.01,1.02,1.03],
    flatbed:[1.01,1.02,1.02,1.02,1.01,0.99,0.98,0.99,1.01,1.02,1.01,1.00]},
  gl:{label:'Great Lakes / Michigan',sub:'Reefer · blueberries, cherries, apples, asparagus',
    reefer:[0.95,0.96,0.98,1.01,1.04,1.06,1.09,1.11,1.08,1.04,0.99,0.96],
    van:[0.95,0.96,0.98,1.01,1.03,1.04,1.07,1.08,1.06,1.03,0.99,0.96],
    flatbed:[0.95,0.96,1.00,1.03,1.06,1.07,1.07,1.06,1.05,1.03,0.99,0.95]},
  ne_produce:{label:'Northeast fall harvest',sub:'NY, NJ, PA, NE · apples, cranberries, potatoes',
    reefer:[0.97,0.97,0.98,0.99,1.01,1.02,1.04,1.06,1.10,1.12,1.07,1.01],
    van:[0.97,0.97,0.98,1.00,1.01,1.02,1.03,1.05,1.08,1.10,1.06,1.01],
    flatbed:[0.96,0.96,0.99,1.02,1.04,1.05,1.05,1.05,1.06,1.06,1.02,0.97]},
  storage:{label:'Storage season / Northern origin',sub:'ME, WI, MI, NY · potatoes, root vegetables',
    reefer:[1.06,1.05,1.03,1.00,0.97,0.96,0.96,0.97,0.99,1.03,1.07,1.08],
    van:[1.04,1.03,1.02,1.00,0.98,0.97,0.97,0.98,1.00,1.02,1.04,1.05],
    flatbed:[1.02,1.01,1.01,1.01,1.01,1.00,1.00,1.00,1.01,1.02,1.02,1.02]},
  mw:{label:'Midwest general',sub:'Grain, manufacturing',
    reefer:[0.96,0.96,0.99,1.02,1.04,1.03,1.01,1.02,1.04,1.05,1.03,0.97],
    van:[0.95,0.96,1.00,1.02,1.03,1.02,1.01,1.02,1.04,1.06,1.04,0.97],
    flatbed:[0.94,0.95,1.01,1.05,1.08,1.07,1.04,1.03,1.05,1.04,1.00,0.95]},
  ne:{label:'Northeast general',sub:'General freight, retail',
    reefer:[0.96,0.97,1.00,1.02,1.04,1.03,1.00,0.99,1.01,1.05,1.06,1.01],
    van:[0.96,0.97,1.00,1.01,1.03,1.02,1.00,0.99,1.01,1.05,1.07,1.02],
    flatbed:[0.95,0.96,1.02,1.05,1.07,1.06,1.02,1.01,1.03,1.03,1.00,0.95]},
  sw:{label:'Southwest / Texas general',sub:'General, oil field, construction',
    reefer:[0.97,0.97,1.00,1.02,1.03,1.02,0.99,0.99,1.01,1.02,1.02,0.98],
    van:[0.97,0.97,1.00,1.02,1.03,1.02,0.99,0.99,1.01,1.02,1.02,0.98],
    flatbed:[0.97,0.98,1.01,1.04,1.06,1.05,1.01,1.00,1.02,1.02,1.00,0.96]},
  national:{label:'National average',sub:'No specific region',
    reefer:[0.95,0.96,0.99,1.02,1.05,1.04,1.00,0.99,1.01,1.03,1.04,0.98],
    van:[0.95,0.96,0.99,1.02,1.04,1.03,1.00,0.99,1.01,1.03,1.05,0.99],
    flatbed:[0.95,0.96,1.01,1.04,1.06,1.05,1.02,1.01,1.03,1.03,1.01,0.96]}
};
const HOLIDAY_EVENTS = [
  { id:'roadcheck',   label:'DOT Roadcheck',        mult:1.125, hint:'Mid-May, ~3 days' },
  { id:'brake_week',  label:'Brake Safety Week',    mult:1.05,  hint:'Mid-August' },
  { id:'memorial',    label:'Memorial Day',         mult:1.065, hint:'Last Mon. of May' },
  { id:'july4',       label:'July 4th',             mult:1.055, hint:'Independence Day week' },
  { id:'labor',       label:'Labor Day',            mult:1.065, hint:'First Mon. of Sept.' },
  { id:'thanksgiving',label:'Thanksgiving',         mult:1.125, hint:'4th Thu. of Nov.' },
  { id:'xmas_nye',    label:'Christmas / New Year', mult:1.15,  hint:'Dec 22 – Jan 2' },
  { id:'mothers_day', label:"Mother's Day",         mult:1.125, hint:'2nd Sun. of May — floral surge' }
];
const DOE_FSC_MPG = 6.5;
const DOE_FSC_BASELINE = 1.25;
const MP_MIN = -10;
const MP_MAX = 30;
// Fallback rates the page uses when rates.json can't be read.
const FALLBACK_RATES = { van: 2.73, reefer: 3.15, flatbed: 3.38 };
// ────────────────────────────────────────────────────────────────────────────

const TRAILERS = ['van', 'reefer', 'flatbed'];
const COMMODITIES = Object.keys(CMULT);
const SEASON_REGIONS = Object.keys(SEASON_PROFILES);
const HOLIDAY_IDS = HOLIDAY_EVENTS.map((e) => e.id);

const STATE_TO_REGION = {};
Object.entries((RATES && RATES.regions) || {}).forEach(([region, data]) => {
  ((data && data.states) || []).forEach((s) => { STATE_TO_REGION[s] = region; });
});

function regionForState(state) {
  return STATE_TO_REGION[String(state || '').toUpperCase()] || 'national';
}

// The page puts the rate into a text box with toFixed(2) and reads it back.
function twoDecimals(n) {
  return parseFloat(parseFloat(n).toFixed(2));
}

// Base $/mile for the trailer: the region's rate from rates.json, or the
// national rate, or the page's built-in fallback.
function baseRate(trailer, region) {
  const regions = (RATES && RATES.regions) || {};
  const r = regions[region] || regions.national || null;
  const value = r && parseFloat(r[trailer]);
  return Number.isFinite(value) && value > 0 ? twoDecimals(value) : FALLBACK_RATES[trailer];
}

function wTier(w) { return WTIERS.find((t) => w <= t.max) || WTIERS[3]; }

// Distance multiplier: linear interpolation between the curve's breakpoints.
function dMult(mi, trailer) {
  const curve = DMULTS[trailer] || DMULTS.ltl;
  if (mi <= curve[0].mi) return curve[0].m;
  if (mi >= curve[curve.length - 1].mi) return curve[curve.length - 1].m;
  for (let i = 0; i < curve.length - 1; i++) {
    const lo = curve[i];
    const hi = curve[i + 1];
    if (mi >= lo.mi && mi <= hi.mi) {
      const t = (mi - lo.mi) / (hi.mi - lo.mi);
      return lo.m + (hi.m - lo.m) * t;
    }
  }
  return curve[curve.length - 1].m;
}

// Load-to-truck ratio → capacity multiplier (±12% at most). The page fills its
// ratio boxes from rates.json's loadToTruck.*.current.
function loadToTruck(trailer) {
  const lt = RATES && RATES.loadToTruck && RATES.loadToTruck[trailer];
  const v = lt && parseFloat(lt.current);
  return Number.isFinite(v) && v > 0 ? v : LT_BASELINE[trailer];
}
function capacityMult(trailer) {
  const lt = loadToTruck(trailer);
  return 1 + Math.min(0.12, Math.max(-0.12, ((lt - LT_BASELINE[trailer]) / LT_BASELINE[trailer]) * 0.15));
}

// Month index (0–11) of a YYYY-MM-DD date, or this month (UTC) without one.
function monthOf(date) {
  return date ? parseInt(date.slice(5, 7), 10) - 1 : new Date().getUTCMonth();
}
function seasonMult(trailer, pickupDate, region) {
  const profile = SEASON_PROFILES[region];
  return (profile[trailer] || profile.van)[monthOf(pickupDate)];
}

function holidayMult(ids) {
  let m = 1.0;
  for (const ev of HOLIDAY_EVENTS) {
    if (ids.includes(ev.id)) m *= ev.mult;
  }
  return m;
}

function marketMult(pct) {
  const clamped = Math.max(MP_MIN, Math.min(MP_MAX, pct));
  return 1 + clamped / 100;
}

// DOE-style fuel surcharge per mile: (price − $1.25) ÷ 6.5 MPG, to the cent.
function fuelSurchargePerMile(dieselPrice) {
  if (!(dieselPrice > 0)) return 0;
  if (dieselPrice <= DOE_FSC_BASELINE) return 0;
  return Math.round(((dieselPrice - DOE_FSC_BASELINE) / DOE_FSC_MPG) * 100) / 100;
}

// Days between two YYYY-MM-DD dates (noon to noon, like the page).
function daysBetween(a, b) {
  return Math.round((new Date(b + 'T12:00:00Z') - new Date(a + 'T12:00:00Z')) / 86400000);
}

function round2(n) { return Math.round(n * 100) / 100; }
function round4(n) { return Math.round(n * 10000) / 10000; }

// Quote one truckload lane. `input` has already been validated (see
// validateQuoteInput); every field but miles is optional.
//   miles, trailer, weight, commodity, pickupDate, deliveryDate, marginPercent,
//   rateRegion (a rates.json region) or baseRatePerMile (your own rate),
//   rateSheet (the account's rate sheet: its rate for the region and trailer,
//   when it has one, replaces the market rate), dieselPrice, capacity (bool),
//   seasonRegion, holidays [ids], marketPercent, extraDayRate
function computeQuote(input) {
  const miles = input.miles;
  const trailer = input.trailer || 'van';
  const commodity = input.commodity || 'standard';
  const weight = input.weight || 0;
  const pickupDate = input.pickupDate || '';
  const marginPct = (input.marginPercent == null ? 15 : input.marginPercent) / 100;
  const region = input.rateRegion || 'national';

  const own = input.baseRatePerMile == null && input.rateSheet ? SHEET.sheetRate(input.rateSheet, region, trailer) : null;
  const base = input.baseRatePerMile != null ? input.baseRatePerMile : own != null ? own : baseRate(trailer, region);
  const rateSource = input.baseRatePerMile != null ? 'provided' : own != null ? 'sheet' : 'market';
  const wt = weight ? wTier(weight).m : 1.0;
  const dm = miles ? dMult(miles, trailer) : 1.0;
  const cm = CMULT[commodity];
  const capM = input.capacity ? capacityMult(trailer) : 1.0;
  const seasM = input.seasonRegion ? seasonMult(trailer, pickupDate, input.seasonRegion) : 1.0;
  const holM = input.holidays && input.holidays.length ? holidayMult(input.holidays) : 1.0;
  const mpM = marketMult(input.marketPercent || 0);

  const adjRpm = base * wt * dm * cm * capM * seasM * holM * mpM;
  const fscPerMile = fuelSurchargePerMile(input.dieselPrice);
  const cost = miles ? (adjRpm + fscPerMile) * miles : 0;

  // Extra days in transit beyond ~500 miles a day, charged per day — the
  // page's "Add to quote" in the transit check. Only with both dates and a rate.
  let extraDays = 0;
  let extraDayCharge = 0;
  if (input.extraDayRate != null && input.pickupDate && input.deliveryDate) {
    const actualDays = daysBetween(input.pickupDate, input.deliveryDate);
    const standardDays = miles > 0 ? Math.ceil(miles / 500) : 1;
    extraDays = actualDays > 0 ? Math.max(0, actualDays - standardDays) : 0;
    extraDayCharge = extraDays * input.extraDayRate;
  }

  const total = (cost + extraDayCharge) * (1 + marginPct);

  return {
    total,
    ratePerMile: miles > 0 ? total / miles : 0,
    cost,
    extraDays,
    extraDayCharge,
    margin: total - cost - extraDayCharge,
    marginPercent: marginPct * 100,
    rateRegion: input.baseRatePerMile != null ? null : region,
    rateSource,
    baseRatePerMile: base,
    adjustedRatePerMile: adjRpm,
    fuelSurchargePerMile: fscPerMile,
    multipliers: {
      weight: wt,
      distance: dm,
      commodity: cm,
      capacity: capM,
      season: seasM,
      holidays: holM,
      market: mpM,
    },
  };
}

// The quote as the API returns it: money to the cent, multipliers to 4 places.
function presentQuote(q) {
  const m = {};
  Object.entries(q.multipliers).forEach(([k, v]) => { m[k] = round4(v); });
  return {
    total: round2(q.total),
    ratePerMile: round2(q.ratePerMile),
    breakdown: {
      rateRegion: q.rateRegion,
      rateSource: q.rateSource,
      baseRatePerMile: round2(q.baseRatePerMile),
      multipliers: m,
      adjustedRatePerMile: round4(q.adjustedRatePerMile),
      fuelSurchargePerMile: round2(q.fuelSurchargePerMile),
      cost: round2(q.cost),
      extraDays: q.extraDays,
      extraDayCharge: round2(q.extraDayCharge),
      marginPercent: round2(q.marginPercent),
      margin: round2(q.margin),
    },
  };
}

module.exports = {
  RATES,
  TRAILERS,
  COMMODITIES,
  SEASON_REGIONS,
  HOLIDAY_IDS,
  MP_MIN,
  MP_MAX,
  regionForState,
  baseRate,
  computeQuote,
  presentQuote,
};
