// Netlify serverless function — proxies EIA API to avoid CORS
// Deploy to: netlify/functions/diesel-price.js in your GitHub repo
// Set EIA_API_KEY as an environment variable in Netlify dashboard:
//   Site configuration → Environment variables → Add variable
//   Key: EIA_API_KEY   Value: your_eia_key_here
//
// Two ways to call it:
//   ?region=NUS (default) or R10…R50 → this week's price and last week's, for one region
//     { price, period, region, seriesId, previous, previousPeriod }
//   ?history=1[&weeks=60] → weekly prices for the US average and the five EIA regions,
//     oldest week first (Market Rates page)
//     { regions: { NUS: 'U.S. average', … }, latest, weeks: [{ period, NUS, R10, … }, …] }
// EIA posts a new week on Monday afternoons; answers are cached for an hour.

const SERIES = {
  R10: 'EMD_EPD2D_PTE_R10_DPG', // East Coast
  R20: 'EMD_EPD2D_PTE_R20_DPG', // Midwest
  R30: 'EMD_EPD2D_PTE_R30_DPG', // Gulf Coast
  R40: 'EMD_EPD2D_PTE_R40_DPG', // Rocky Mountain
  R50: 'EMD_EPD2D_PTE_R50_DPG', // West Coast
  NUS: 'EMD_EPD2D_PTE_NUS_DPG', // National Average
};
const REGION_NAME = {
  NUS: 'U.S. average', R10: 'East Coast', R20: 'Midwest', R30: 'Gulf Coast', R40: 'Rocky Mountain', R50: 'West Coast',
};
const BASE = 'https://api.eia.gov/v2/petroleum/pri/gnd/data/';
const DAY = 86400000;

// Successful answers are cached by the browser for 30 minutes and by Netlify's CDN for an
// hour (served stale for up to a day while it refreshes), so EIA sees a handful of calls.
const CACHED = {
  'Content-Type': 'application/json',
  'Cache-Control': 'public, max-age=1800',
  'Netlify-CDN-Cache-Control': 'public, durable, max-age=3600, stale-while-revalidate=86400',
};
const json = (statusCode, body, headers) => ({ statusCode, headers: headers || { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

// The weekly rows EIA returns for several series, as one row per week, oldest first.
function weeksFromRows(rows) {
  const byPeriod = new Map();
  const code = Object.fromEntries(Object.entries(SERIES).map(([k, v]) => [v, k]));
  for (const r of rows || []) {
    const key = code[r.series];
    const v = parseFloat(r.value);
    if (!key || !r.period || !Number.isFinite(v)) continue;
    if (!byPeriod.has(r.period)) byPeriod.set(r.period, { period: r.period });
    byPeriod.get(r.period)[key] = Math.round(v * 1000) / 1000;
  }
  return [...byPeriod.values()].sort((a, b) => a.period.localeCompare(b.period));
}

async function history(event, apiKey) {
  const asked = parseInt(event.queryStringParameters?.weeks, 10);
  const weeks = Math.min(104, Math.max(4, Number.isFinite(asked) ? asked : 60));
  const start = new Date(Date.now() - (weeks * 7 + 6) * DAY).toISOString().slice(0, 10);
  const url = BASE + `?api_key=${apiKey}&frequency=weekly&data[0]=value`
    + Object.values(SERIES).map((s) => `&facets[series][]=${s}`).join('')
    + `&start=${start}&sort[0][column]=period&sort[0][direction]=asc&length=5000`;
  const resp = await fetch(url);
  if (!resp.ok) throw new Error(`EIA returned HTTP ${resp.status}`);
  const data = await resp.json();
  const all = weeksFromRows(data?.response?.data).filter((w) => Number.isFinite(w.NUS));
  if (!all.length) throw new Error('No data');
  const list = all.slice(-weeks);
  return json(200, { regions: REGION_NAME, latest: list[list.length - 1].period, weeks: list }, CACHED);
}

exports.handler = async (event) => {
  const q = event.queryStringParameters || {};
  const apiKey = process.env.EIA_API_KEY;
  const wantsHistory = q.history !== undefined && q.history !== '0' && q.history !== 'false';

  const region = q.region || 'NUS';
  const seriesId = SERIES[region];
  if (!wantsHistory && !seriesId) return json(400, { error: 'Invalid region' });
  if (!apiKey) return json(500, { error: 'EIA_API_KEY not configured' });

  try {
    if (wantsHistory) return await history(event, apiKey);

    const url = BASE
      + `?api_key=${apiKey}`
      + `&frequency=weekly`
      + `&data[0]=value`
      + `&facets[series][]=${seriesId}`
      + `&sort[0][column]=period`
      + `&sort[0][direction]=desc`
      + `&length=2`;
    const resp = await fetch(url);
    if (!resp.ok) throw new Error(`EIA returned HTTP ${resp.status}`);
    const data = await resp.json();

    const rows = data?.response?.data;
    if (!rows || rows.length === 0) throw new Error('No data');

    const latest = rows[0];
    const price = parseFloat(latest.value);
    const period = latest.period;
    // The week before, for the weekly change on the Market Rates page.
    const before = rows[1] ? parseFloat(rows[1].value) : NaN;

    if (isNaN(price)) throw new Error('Invalid price');

    return json(200, {
      price, period, region, seriesId,
      previous: isNaN(before) ? null : before,
      previousPeriod: rows[1] ? rows[1].period : null,
    }, CACHED);
  } catch (err) {
    return json(502, { error: err.message });
  }
};

exports._internal = { SERIES, REGION_NAME, weeksFromRows };
