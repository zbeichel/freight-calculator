#!/usr/bin/env node
// scripts/update-dat-rates.mjs
// ─────────────────────────────────────────────────────────────────────────
// Refreshes rates.json from DAT Trendlines — the same numbers shown on the
// dropdown pages at https://www.dat.com/trendlines-legacy/reefer/national-rates
// (National Van/Reefer/Flatbed Rates and Van/Reefer/Flatbed Demand & Capacity).
// Calls the public JSON API those pages load from; no key or browser needed.
//
//   node scripts/update-dat-rates.mjs            # update rates.json in place
//   node scripts/update-dat-rates.mjs --dry-run  # print the summary only
//
// What gets written:
//   regions.<region>.<trailer>  previous week's average outbound rate (the map)
//   regions.national.<trailer>  latest month's national spot rate incl. fuel
//                               surcharge (latest point on "National Averages")
//   loadToTruck.<trailer>       latest full month's load-to-truck ratio
//   history[]                   a snapshot of all regions for today's date
//
// Prints a Markdown old → new summary to stdout (used as the PR body) and
// exits non-zero without writing anything if DAT returns missing or
// implausible values.
// ─────────────────────────────────────────────────────────────────────────

import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const RATES_PATH = fileURLToPath(new URL('../rates.json', import.meta.url));
const API = 'https://analytics.api.dat.com/v2/trendlines';
const TRAILERS = { van: 'VAN', reefer: 'REEFER', flatbed: 'FLATBED' };
const LT_PATH = { van: 'Van', reefer: 'Reefer', flatbed: 'Flatbed' };

// DAT region code → our region key. DAT's "North" is our Midwest and its
// "South" is our Southwest; the state lists match.
const REGION_MAP = {
  NORTHEAST: 'northeast',
  SOUTHEAST: 'southeast',
  NORTH: 'midwest',
  SOUTH: 'southwest',
  WEST: 'west',
};
const REGIONS = [...Object.values(REGION_MAP), 'national'];

// Sanity bounds — anything outside these means the API changed or broke.
const RATE_MIN = 1, RATE_MAX = 10;
const LT_MIN = 0.5, LT_MAX = 300;
// Changes bigger than this are flagged in the summary for a human to eyeball.
const BIG_CHANGE = 0.15;

const TZ = 'America/New_York';
const MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];

const round = (n, places) => Math.round(n * 10 ** places) / 10 ** places;

async function getJSON(path, body){
  const resp = await fetch(`${API}/${path}`, body ? {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify(body),
  } : { headers: { accept: 'application/json' } });
  if(!resp.ok) throw new Error(`${path}: HTTP ${resp.status}`);
  return resp.json();
}

function check(label, value, min, max){
  if(typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max){
    throw new Error(`${label}: implausible value ${JSON.stringify(value)} (expected ${min}–${max})`);
  }
  return value;
}

async function fetchTrailer(trailer){
  const code = TRAILERS[trailer];
  const [regional, national, lt] = await Promise.all([
    getJSON(`${code}/regionalRates`),
    getJSON('nationalHistory', { equipment: code, rateType: 'SPOT', periodType: 'Month', country: 'US' }),
    getJSON(`${code}/loadAndTruckRatio`),
  ]);

  const rates = {};
  for(const r of regional){
    const key = REGION_MAP[r.regionCode];
    if(key) rates[key] = check(`${trailer} ${key}`, round(r.tripRatePerMileInDollars, 2), RATE_MIN, RATE_MAX);
  }
  for(const key of Object.values(REGION_MAP)){
    if(rates[key] === undefined) throw new Error(`${trailer}: DAT returned no rate for ${key}`);
  }

  const months = national?.response?.rates || [];
  const latest = months[months.length - 1];
  if(!latest) throw new Error(`${trailer}: DAT returned no national history`);
  rates.national = check(`${trailer} national`,
    round(latest.rateUSD + (latest.averageFuelSurchargePerTripUsd || 0), 2), RATE_MIN, RATE_MAX);

  const ltMonths = lt?.threeYearMonthly || [];
  const ltLatest = ltMonths[ltMonths.length - 1];
  if(!ltLatest) throw new Error(`${trailer}: DAT returned no load-to-truck data`);

  return {
    rates,
    nationalMonth: `${MONTHS[latest.month - 1]} ${latest.year}`,
    lt: check(`${trailer} load-to-truck`, round(ltLatest.ratio, 1), LT_MIN, LT_MAX),
    ltMonth: ltLatest.monthAndYearWhen,
  };
}

function today(){
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', {
    timeZone: TZ, year: 'numeric', month: 'numeric', day: 'numeric',
  }).formatToParts(new Date()).map(p => [p.type, p.value]));
  const y = Number(parts.year), m = Number(parts.month), d = Number(parts.day);
  return {
    iso:   `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`,
    long:  new Date(Date.UTC(y, m - 1, d)).toLocaleDateString('en-US', { timeZone: 'UTC', month: 'long', day: 'numeric', year: 'numeric' }),
    label: `${MONTHS[m - 1]} ${y}`,
  };
}

function fmtChange(oldVal, newVal, digits){
  const fmt = v => (typeof v === 'number' ? v.toFixed(digits) : '—');
  if(oldVal === newVal) return fmt(newVal);
  const flag = typeof oldVal === 'number' && Math.abs(newVal - oldVal) / oldVal > BIG_CHANGE ? ' ⚠️' : '';
  return `${fmt(oldVal)} → **${fmt(newVal)}**${flag}`;
}

async function main(){
  const dryRun = process.argv.includes('--dry-run');
  const original = readFileSync(RATES_PATH, 'utf8');
  const data = JSON.parse(original);

  const trailers = Object.keys(TRAILERS);
  const results = Object.fromEntries(await Promise.all(trailers.map(async t => [t, await fetchTrailer(t)])));
  const date = today();

  const titleCase = s => s[0].toUpperCase() + s.slice(1);
  const lines = [
    `## Rates ($/mile)`, ``,
    `| Region | Van | Reefer | Flatbed |`, `|---|---|---|---|`,
    ...REGIONS.map(region => `| ${titleCase(region)} | ` +
      trailers.map(t => fmtChange(data.regions[region]?.[t], results[t].rates[region], 2)).join(' | ') + ' |'),
    ``,
    `Regional rates are DAT's previous-week outbound averages. National is the ${results.van.nationalMonth} spot average including fuel surcharge.`,
    ``,
    `## Load-to-truck (${results.van.ltMonth})`, ``,
    `| | Van | Reefer | Flatbed |`, `|---|---|---|---|`,
    `| current | ` + trailers.map(t => fmtChange(data.loadToTruck?.[t]?.current, results[t].lt, 1)).join(' | ') + ' |',
  ];
  if(lines.some(l => l.includes('⚠️'))){
    lines.push('', `⚠️ = changed more than ${BIG_CHANGE * 100}% since the last update; worth a second look on the DAT page.`);
  }

  for(const t of trailers){
    for(const region of REGIONS) data.regions[region][t] = results[t].rates[region];
    data.loadToTruck[t].current = results[t].lt;
  }
  data.loadToTruck.updated = date.long;
  data.updated = date.long;

  const snapshot = {
    date: date.iso,
    label: date.label,
    regions: Object.fromEntries(REGIONS.map(region =>
      [region, Object.fromEntries(trailers.map(t => [t, results[t].rates[region]]))])),
  };
  // Re-running on the same day replaces that day's snapshot instead of duplicating it.
  data.history = (data.history || []).filter(h => h.date !== date.iso);
  data.history.push(snapshot);

  const output = JSON.stringify(data, null, 2) + (original.endsWith('\n') ? '\n' : '');
  if(!dryRun) writeFileSync(RATES_PATH, output);
  console.log(lines.join('\n'));
}

main().catch(err => {
  console.error(`update-dat-rates: ${err.message}`);
  process.exit(1);
});
