// tests/diesel_test.js — the diesel-price function: this week's price for one region (the
// calculator, multi-stop and bulk pages) and weekly history for the US average and the five
// EIA regions (Market Rates page). EIA is replaced by a stub; no network.
// Run from the repository root:
//   node tests/diesel_test.js
const path = require('path');
const ROOT = path.resolve(__dirname, '..');
let failures = 0;
const check = (label, cond, detail) => { console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}${detail && !cond ? '  — ' + detail : ''}`); if (!cond) failures++; };

const fn = require(path.join(ROOT, 'netlify/functions/diesel-price.js'));
const { SERIES } = fn._internal;
const CODES = Object.keys(SERIES);

// Weekly EIA rows for every series, newest first or oldest first as asked, like the real API.
function weeks(n, endIso) {
  const end = Date.parse(endIso + 'T00:00:00Z');
  const out = [];
  for (let i = n - 1; i >= 0; i--) out.push(new Date(end - i * 7 * 86400000).toISOString().slice(0, 10));
  return out;
}
const PRICE = (code, i) => 3.5 + CODES.indexOf(code) * 0.1 + i * 0.01;
function eiaRows(n, endIso) {
  const rows = [];
  weeks(n, endIso).forEach((period, i) => CODES.forEach((code) => rows.push({ period, series: SERIES[code], value: String(PRICE(code, i).toFixed(3)), units: '$/GAL' })));
  return rows;
}

let calls = [];
let reply = null;
global.fetch = async (url) => {
  calls.push(url);
  const r = typeof reply === 'function' ? reply(url) : reply;
  return { ok: r.status === 200, status: r.status, json: async () => r.body };
};
const run = async (q) => { const res = await fn.handler({ queryStringParameters: q }); return { ...res, json: JSON.parse(res.body) }; };

(async () => {
  process.env.EIA_API_KEY = 'test-key';

  console.log('\n=== This week, one region ===');
  reply = (url) => {
    const desc = /sort\[0\]\[direction\]=desc/.test(url);
    const code = CODES.find((c) => url.includes(SERIES[c]));
    const rows = eiaRows(2, '2026-11-09').filter((r) => r.series === SERIES[code]);
    return { status: 200, body: { response: { data: desc ? rows.reverse() : rows } } };
  };
  calls = [];
  let r = await run({});
  check('US average by default: price, period, last week', r.statusCode === 200 && r.json.region === 'NUS' && r.json.period === '2026-11-09'
    && r.json.price === PRICE('NUS', 1) && r.json.previous === PRICE('NUS', 0) && r.json.previousPeriod === '2026-11-02', JSON.stringify(r.json));
  check('asks EIA for the two newest weeks of that series only', calls.length === 1 && calls[0].includes(SERIES.NUS) && /length=2/.test(calls[0]) && !calls[0].includes(SERIES.R10));
  check('cached: 30 minutes in the browser, an hour at Netlify', r.headers['Cache-Control'] === 'public, max-age=1800' && /durable, max-age=3600/.test(r.headers['Netlify-CDN-Cache-Control']));
  r = await run({ region: 'R30' });
  check('a region (Gulf Coast)', r.statusCode === 200 && r.json.region === 'R30' && r.json.price === PRICE('R30', 1));
  r = await run({ region: 'XX' });
  check('an unknown region is refused', r.statusCode === 400 && r.json.error === 'Invalid region');

  console.log('\n=== Weekly history ===');
  reply = (url) => ({ status: 200, body: { response: { data: eiaRows(70, '2026-11-09') } } });
  calls = [];
  r = await run({ history: '1' });
  const w = r.json.weeks || [];
  check('one EIA call for all six series, from a start date, oldest first', calls.length === 1 && CODES.every((c) => calls[0].includes(SERIES[c]))
    && /&start=\d{4}-\d{2}-\d{2}/.test(calls[0]) && /direction\]=asc/.test(calls[0]), calls[0]);
  check('60 weeks by default, oldest first, ending with the latest week', w.length === 60 && w[0].period < w[59].period && w[59].period === '2026-11-09' && r.json.latest === '2026-11-09', `${w.length} ${w[0] && w[0].period}`);
  check('every week has the US average and the five regions', w.every((x) => CODES.every((c) => typeof x[c] === 'number')) && w[59].R50 === Number(PRICE('R50', 69).toFixed(3)), JSON.stringify(w[59]));
  check('the region names come along', r.json.regions.NUS === 'U.S. average' && r.json.regions.R10 === 'East Coast' && r.json.regions.R40 === 'Rocky Mountain');
  check('cached like the weekly price', r.headers['Cache-Control'] === 'public, max-age=1800');
  r = await run({ history: '1', weeks: '13' });
  check('weeks=13 gives 13 weeks', r.json.weeks.length === 13 && r.json.weeks[12].period === '2026-11-09');
  r = await run({ history: '1', weeks: '9999' });
  const start = Date.parse(calls[calls.length - 1].match(/&start=(\d{4}-\d{2}-\d{2})/)[1] + 'T00:00:00Z');
  const back = Math.round((Date.now() - start) / (7 * 86400000));
  check('weeks is capped at 104 (asks EIA for about two years)', back >= 104 && back <= 106 && r.json.weeks.length === 70, `${back} weeks back`);
  r = await run({ history: '1', weeks: 'abc' });
  check('a bad weeks value uses 60', r.json.weeks.length === 60);

  reply = () => ({ status: 200, body: { response: { data: eiaRows(3, '2026-11-09').concat([{ period: '2026-11-16', series: SERIES.R10, value: '' }, { period: '2026-11-16', series: 'SOMETHING_ELSE', value: '4.1' }]) } } });
  r = await run({ history: '1' });
  check('blank values and other series are left out; a week needs the US average', r.json.weeks.length === 3 && r.json.latest === '2026-11-09');

  console.log('\n=== Errors ===');
  reply = () => ({ status: 503, body: {} });
  r = await run({ history: '1' });
  check('EIA down: 502 and the reason, not cached', r.statusCode === 502 && /HTTP 503/.test(r.json.error) && !r.headers['Cache-Control']);
  reply = () => ({ status: 200, body: { response: { data: [] } } });
  r = await run({});
  check('no rows: 502', r.statusCode === 502 && r.json.error === 'No data');
  delete process.env.EIA_API_KEY;
  r = await run({ history: '1' });
  check('no EIA key: 500', r.statusCode === 500 && /EIA_API_KEY/.test(r.json.error));

  console.log(failures ? `\n${failures} DIESEL CHECK(S) FAILED` : '\nALL DIESEL CHECKS PASSED');
  process.exit(failures ? 1 : 0);
})();
