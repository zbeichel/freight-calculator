// netlify/lib/fmcsa.js
// Carrier checks from FMCSA's public data on data.transportation.gov: no key needed,
// updated daily. Used by carrier-check.js (lookups) and carrier-monitor.js (alerts).
//
//   census       Company Census: names, address, phone, email, USDOT status, when the
//                USDOT number was added, MCS-150 date, fleet, safety rating
//   authority    Motus Carrier: each operating authority (carrier, broker, …) with its
//                status, and liability insurance required / on file
//   authHistory  Motus AuthHist: granted, suspended, reinstated…, with dates and reasons
//   insurance    Motus Insur: insurance and bond filings on file
//   insHistory   Motus InsHist: filings that ended or will end (cancellation dates)
//   orders       Motus RevokeSuspend: suspension orders
//   oos          Out-of-service orders (in effect while there's no rescind date)
//   inspections  SMS Input - Inspection: roadside inspections, last 24 months
//   crashes      SMS Input - Crash: reportable crashes, last 24 months
//
// FMCSA moved authority and insurance to its new registration system (Motus) in 2026;
// the older licensing datasets stopped updating in May 2026, so they aren't used.
// Optional SOCRATA_APP_TOKEN raises the open-data rate limits.

const BASE = 'https://data.transportation.gov/resource/';
const DS = {
  census: 'az4n-8mr2',
  authority: 'inys-ebih',
  authHistory: 'yu5v-wbh6',
  insurance: 'c5y8-a4uz',
  insHistory: '3uet-3z4i',
  orders: 'wb4f-neki',
  oos: 'p2mt-9ige',
  inspections: 'rbkj-cgst',
  crashes: '4wxs-vbns',
};
const DAY = 24 * 60 * 60 * 1000;

// ── Input ──────────────────────────────────────────────────────────────────
// "MC 135797", "mc-135797", "MC0135797" → { docket: 'MC135797' }; "DOT 80806", "USDOT#80806"
// → { dot: '80806' }; plain digits use `kind` ('mc' by default, or 'dot'). null if unreadable.
function parseQuery(input, kind) {
  const s = String(input == null ? '' : input).toUpperCase().replace(/[\s.\-#:_]/g, '');
  let m = s.match(/^(MC|MX|FF)(\d{1,8})$/);
  if (m) return Number(m[2]) > 0 ? { docket: m[1] + String(Number(m[2])) } : null;
  m = s.match(/^(?:US)?DOT(\d{1,8})$/);
  if (m) return Number(m[1]) > 0 ? { dot: String(Number(m[1])) } : null;
  if (/^\d{1,8}$/.test(s) && Number(s) > 0) return kind === 'dot' ? { dot: String(Number(s)) } : { docket: 'MC' + String(Number(s)) };
  return null;
}

// ── Open data ──────────────────────────────────────────────────────────────
async function soql(ds, params, opt = {}) {
  const url = new URL(BASE + ds + '.json');
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, String(v));
  const headers = { Accept: 'application/json' };
  const token = opt.token != null ? opt.token : process.env.SOCRATA_APP_TOKEN;
  if (token) headers['X-App-Token'] = token;
  // opt.timeoutMs bounds this request; opt.deadline (a Date.now() time) bounds the whole
  // check, so a slow day at data.transportation.gov can't run past the function's limit.
  let wait = opt.timeoutMs || 10000;
  if (opt.deadline) wait = Math.min(wait, opt.deadline - Date.now() - 100);
  if (wait < 250) throw new Error(`${ds}: out of time`);
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), wait);
  try {
    const resp = await (opt.fetchImpl || fetch)(url.toString(), { headers, signal: ctrl.signal });
    if (!resp.ok) throw new Error(`${ds} answered ${resp.status}`);
    const data = await resp.json();
    return Array.isArray(data) ? data : [];
  } finally {
    clearTimeout(timer);
  }
}
const digits = (s) => /^\d{1,8}$/.test(String(s)) ? String(Number(s)) : null;   // safe inside SoQL
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// New carriers are the usual fraud risk: authority under 90 days, or a USDOT number under 180.
const NEW_AUTHORITY_DAYS = 90, NEW_USDOT_DAYS = 180;
const docketSafe = (s) => /^(MC|MX|FF)\d{1,8}$/.test(String(s)) ? String(s) : null;

// An MC/MX/FF number → its USDOT number (authority records first, then the census).
async function resolveDot(q, opt = {}) {
  if (q.dot) return digits(q.dot);
  const docket = docketSafe(q.docket);
  if (!docket) return null;
  const rows = await soql(DS.authority, { $select: 'usdot_number', $where: `docket_number='${docket}'`, $limit: 5 }, opt);
  const hit = rows.find((r) => digits(r.usdot_number));
  if (hit) return digits(hit.usdot_number);
  const prefix = docket.slice(0, 2), num = docket.slice(2);
  const c = await soql(DS.census, { $select: 'dot_number',
    $where: `(docket1prefix='${prefix}' AND docket1='${num}') OR (docket2prefix='${prefix}' AND docket2='${num}')`, $limit: 2 }, opt);
  const hit2 = c.find((r) => digits(r.dot_number));
  return hit2 ? digits(hit2.dot_number) : null;
}

// Everything about one USDOT number, as the datasets have it. Parts that fail come back
// as null (the report says which parts couldn't be loaded) instead of failing the check.
// opt.deadline: when the check must be done (default 8 seconds from now). Each part gets up
// to 5 seconds; parts that fail get one more try if there's time left.
async function fetchCarrier(dot, opt = {}) {
  const d = digits(dot);
  if (!d) throw new Error('bad USDOT number');
  const yearAgo = ymd(new Date(Date.now() - 365 * DAY));
  const queries = {
    census: [DS.census, { $where: `dot_number='${d}'`, $limit: 1 }],
    authority: [DS.authority, { $where: `usdot_number='${d}'`, $limit: 50 }],
    authHistory: [DS.authHistory, { $where: `usdot_number='${d}'`, $order: 'status_change_date DESC', $limit: 300 }],
    insurance: [DS.insurance, { $where: `usdot_number='${d}'`, $limit: 100 }],
    insHistory: [DS.insHistory, { $where: `usdot_number='${d}' AND cancl_effective_date >= '${yearAgo}'`, $order: 'cancl_effective_date DESC', $limit: 50 }],
    orders: [DS.orders, { $where: `usdot_number='${d}'`, $order: 'order1_serve_date DESC', $limit: 20 }],
    oos: [DS.oos, { $where: `dot_number='${d}'`, $order: 'oos_date DESC', $limit: 20 }],
    inspections: [DS.inspections, { $select: "insp_level_id, vehicle_oos_total != '0' as v_oos, driver_oos_total != '0' as d_oos, count(*) as n",
      $where: `dot_number='${d}'`, $group: 'insp_level_id, v_oos, d_oos', $limit: 100 }],
    crashes: [DS.crashes, { $select: "fatalities != '0' as fatal, injuries != '0' as inj, tow_away, count(*) as n",
      $where: `dot_number='${d}'`, $group: 'fatal, inj, tow_away', $limit: 50 }],
  };
  const deadline = opt.deadline || Date.now() + 8000;
  const run = (k, timeoutMs) => soql(queries[k][0], queries[k][1], Object.assign({}, opt, { deadline, timeoutMs }));
  const raw = { dot: d };
  let todo = Object.keys(queries);
  for (let attempt = 0; attempt < 2 && todo.length; attempt++) {
    if (attempt && deadline - Date.now() < 1500) break;
    const settled = await Promise.allSettled(todo.map((k) => run(k, attempt ? opt.timeoutMs : opt.timeoutMs || 5000)));
    const failed = [];
    settled.forEach((r, i) => {
      if (r.status === 'fulfilled') raw[todo[i]] = r.value;
      else { raw[todo[i]] = null; failed.push(todo[i]); }
    });
    todo = failed;
  }
  return raw;
}

// National out-of-service averages from the same 24 months of inspections:
// vehicle = Level I, II, V, VI inspections; driver = Level I, II, III, VI (FMCSA's definitions).
async function nationalAverages(opt = {}) {
  const [v, dr] = await Promise.all([
    soql(DS.inspections, { $select: "vehicle_oos_total != '0' as oos, count(*) as n", $where: "insp_level_id in ('1','2','5','6')", $group: 'oos' }, opt),
    soql(DS.inspections, { $select: "driver_oos_total != '0' as oos, count(*) as n", $where: "insp_level_id in ('1','2','3','6')", $group: 'oos' }, opt),
  ]);
  const rate = (rows) => {
    let n = 0, o = 0;
    for (const r of rows) { const k = Number(r.n) || 0; n += k; if (r.oos === true || r.oos === 'true') o += k; }
    return n ? o / n : null;
  };
  return { vehicle: rate(v), driver: rate(dr) };
}

// ── The report ─────────────────────────────────────────────────────────────
// The parts of a check, as the report names them when one didn't load.
const PARTS = { census: 'registration', authority: 'operating authority', authHistory: 'authority history', insurance: 'insurance filings',
  insHistory: 'insurance cancellations', orders: 'suspension orders', oos: 'out-of-service orders', inspections: 'inspections', crashes: 'crashes' };
const listWords = (a) => (a.length < 2 ? a.join('') : `${a.slice(0, -1).join(', ')} and ${a[a.length - 1]}`);

function ymd(date) {
  const d = new Date(date);
  return d.getUTCFullYear() + String(d.getUTCMonth() + 1).padStart(2, '0') + String(d.getUTCDate()).padStart(2, '0');
}
// '20261119' / '2026-11-19' / '11/19/2026' / '19-NOV-26' → '2026-11-19' (or null)
function isoDate(s) {
  if (!s) return null;
  const t = String(s).trim();
  let m = t.match(/^(\d{4})(\d{2})(\d{2})$/) || t.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  m = t.match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
  if (m) return `${m[3]}-${m[1]}-${m[2]}`;
  return null;
}
const money = (s) => { const n = Number(s); return Number.isFinite(n) ? Math.round(n) : null; };
const daysSince = (iso, now) => (iso ? Math.floor((now - Date.parse(iso + 'T00:00:00Z')) / DAY) : null);
const CARRIER_AUTH = /^(Mexico Domiciled )?(Enterprise )?Motor Carrier of (Property|Household Goods)/i;
const BROKER_AUTH = /^Broker of /i;
const INS_KIND = { 1: 'Liability (BIPD)', 2: 'Cargo', 3: 'Surety bond', 4: 'Trust fund' };
const OPERATION = { A: 'Interstate', B: 'Intrastate (hazmat)', C: 'Intrastate (non-hazmat)' };
const SAFETY = { S: 'Satisfactory', C: 'Conditional', U: 'Unsatisfactory' };
const titleCase = (s) => String(s || '').toLowerCase().replace(/\b([a-z])/g, (c) => c.toUpperCase())
  .replace(/\b(Llc|Lp|Llp|Usa|Us|Po)\b/g, (w) => w.toUpperCase());
const phone = (s) => { const d = String(s || '').replace(/\D/g, ''); return d.length === 10 ? `(${d.slice(0, 3)}) ${d.slice(3, 6)}-${d.slice(6)}` : (d || null); };

function inspectionTotals(rows) {
  if (!rows) return null;
  const t = { vehicle: { n: 0, oos: 0 }, driver: { n: 0, oos: 0 }, total: 0 };
  for (const r of rows) {
    const k = Number(r.n) || 0, lvl = String(r.insp_level_id);
    const v = r.v_oos === true || r.v_oos === 'true', dr = r.d_oos === true || r.d_oos === 'true';
    t.total += k;
    if (['1', '2', '5', '6'].includes(lvl)) { t.vehicle.n += k; if (v) t.vehicle.oos += k; }
    if (['1', '2', '3', '6'].includes(lvl)) { t.driver.n += k; if (dr) t.driver.oos += k; }
  }
  t.vehicle.rate = t.vehicle.n ? t.vehicle.oos / t.vehicle.n : null;
  t.driver.rate = t.driver.n ? t.driver.oos / t.driver.n : null;
  return t;
}
function crashTotals(rows) {
  if (!rows) return null;
  const t = { total: 0, fatal: 0, injury: 0, tow: 0 };
  for (const r of rows) {
    const k = Number(r.n) || 0;
    t.total += k;
    if (r.fatal === true || r.fatal === 'true') t.fatal += k;
    else if (r.inj === true || r.inj === 'true') t.injury += k;
    else if (r.tow_away === true || r.tow_away === 'true') t.tow += k;
  }
  return t;
}

// The raw rows → what the page shows.
function buildReport(raw, { national = null, now = Date.now() } = {}) {
  const c = raw.census && raw.census[0] ? raw.census[0] : null;
  const auth = raw.authority || [];
  const authorities = [];
  for (const r of auth) {
    const key = `${r.docket_number}|${r.op_auth_type}`;
    if (authorities.some((a) => a.key === key)) continue;
    authorities.push({ key, docket: r.docket_number || null, type: r.op_auth_type || '', status: r.op_auth_status || '',
      minCoverage: money(r.min_cov_amount), bipdOnFile: money(r.bipd_file),
      cargoRequired: r.cargo_req === 'Y', cargoOnFile: r.cargo_file === 'Y', bondRequired: r.bond_req === 'Y', bondOnFile: r.bond_file === 'Y' });
  }
  const carrierAuth = authorities.filter((a) => CARRIER_AUTH.test(a.type));
  const brokerAuth = authorities.filter((a) => BROKER_AUTH.test(a.type));
  const dockets = [...new Set(authorities.map((a) => a.docket).filter(Boolean))];
  if (!dockets.length && c && c.docket1prefix && c.docket1) dockets.push(c.docket1prefix + String(Number(c.docket1)));

  // Authority history (newest first): when the carrier authority was first granted, and
  // the suspensions / reinstatements of the last year.
  const hist = (raw.authHistory || []).map((h) => ({ docket: h.docket_number, type: h.op_auth_type || '', status: h.op_auth_status || '',
    reason: h.reason || '', date: isoDate(h.status_change_date) })).filter((h) => h.date);
  hist.sort((a, b) => b.date.localeCompare(a.date));
  const carrierHist = hist.filter((h) => CARRIER_AUTH.test(h.type));
  const granted = carrierHist.filter((h) => /^(granted|reinstated)/i.test(h.reason) && h.status === 'Active').map((h) => h.date).sort();
  const firstGranted = carrierHist.filter((h) => /^granted/i.test(h.reason)).map((h) => h.date).sort()[0] || granted[0] || null;
  const recentChanges = carrierHist.filter((h) => daysSince(h.date, now) <= 365 && !/^(initial status|published)/i.test(h.reason)).slice(0, 8);

  // Insurance on file (each filing appears once per authority type: show it once).
  const policies = [];
  for (const r of raw.insurance || []) {
    const p = { kind: INS_KIND[r.ins_type_code] || r.ins_form_code || 'Filing', form: r.ins_form_code || '', layer: r.ins_class_code === 'E' ? 'Excess' : 'Primary',
      insurer: r.insurance_company_name || '', policy: r.policy_no || '', coverage: money(r.max_cov_amount), underlying: money(r.underl_lim_amount),
      effective: isoDate(r.effective_date) };
    if (!policies.some((x) => x.kind === p.kind && x.insurer === p.insurer && x.policy === p.policy && x.effective === p.effective && x.layer === p.layer)) policies.push(p);
  }
  policies.sort((a, b) => a.kind.localeCompare(b.kind) || (a.layer === 'Primary' ? -1 : 1));
  const today = new Date(now).toISOString().slice(0, 10);
  // Filings set to end: "TERM/REPL" filings are being replaced by a new one, so only real
  // cancellations (CANCEL, or no reason given) of liability, cargo or bond are a risk.
  const ending = [];
  for (const r of raw.insHistory || []) {
    const when = isoDate(r.cancl_effective_date);
    if (!when || when < today) continue;
    const reason = String(r.filing_status_reason || '').toUpperCase();
    if (reason === 'TERM/REPL' || reason === 'NAMECHG') continue;
    const e = { kind: INS_KIND[r.ins_type_code] || (r.ins_type_desc || 'Filing'), insurer: r.insurance_company_name || '', policy: r.policy_no || '', cancels: when, reason };
    if (!ending.some((x) => x.kind === e.kind && x.policy === e.policy && x.cancels === e.cancels)) ending.push(e);
  }
  ending.sort((a, b) => a.cancels.localeCompare(b.cancels));

  // What FMCSA requires of the carrier's live authority; for one that's been revoked or
  // suspended, what it required (shown beside the $0 on file, it explains why).
  const minOf = (list) => Math.max(0, ...list.map((a) => a.minCoverage || 0));
  const required = minOf(carrierAuth.filter((a) => a.status === 'Active' || a.status === 'Pending')) || minOf(carrierAuth);
  const onFile = Math.max(0, ...authorities.map((a) => a.bipdOnFile || 0));

  const oosOrders = (raw.oos || []).map((o) => ({ date: isoDate(o.oos_date), reason: o.oos_reason || '', rescinded: isoDate(o.rescind_date) }));
  const suspensionOrders = (raw.orders || []).map((o) => ({ date: isoDate(o.order1_serve_date), type: o.order1_type_desc || '' })).filter((o) => o.date);

  const inspections = inspectionTotals(raw.inspections);
  if (inspections && national) {
    inspections.vehicle.national = national.vehicle;
    inspections.driver.national = national.driver;
  }
  const legalName = (c && c.legal_name) || (auth[0] && auth[0].legal_name) || null;
  const report = {
    dot: raw.dot,
    dockets,
    found: !!(c || authorities.length),
    name: legalName ? titleCase(legalName) : null,
    dba: c && c.dba_name ? titleCase(c.dba_name) : null,
    address: c ? [titleCase(c.phy_street), [titleCase(c.phy_city), c.phy_state].filter(Boolean).join(', '), c.phy_zip].filter(Boolean).join(' · ') : null,
    phone: phone((c && c.phone) || (auth[0] && auth[0].bus_telno)),
    email: c && c.email_address ? String(c.email_address).toLowerCase() : null,
    usdotStatus: c ? ({ A: 'Active', I: 'Inactive', P: 'Pending' }[c.status_code] || c.status_code || null) : null,
    usdotAdded: c ? isoDate(c.add_date) : null,
    mcs150: c ? isoDate(c.mcs150_date) : null,
    operation: c ? (OPERATION[c.carrier_operation] || null) : null,
    classes: c && c.classdef ? String(c.classdef).split(';').map((x) => titleCase(x.trim())).filter(Boolean) : [],
    powerUnits: c && c.power_units != null ? Number(c.power_units) : null,
    drivers: c && c.total_drivers != null ? Number(c.total_drivers) : null,
    safetyRating: c && c.safety_rating ? (SAFETY[c.safety_rating] || c.safety_rating) : null,
    safetyRatingDate: c ? isoDate(c.safety_rating_date) : null,
    authority: {
      carrier: carrierAuth.map(({ key, ...a }) => a),
      broker: brokerAuth.map(({ key, ...a }) => a),
      other: authorities.filter((a) => !CARRIER_AUTH.test(a.type) && !BROKER_AUTH.test(a.type)).map(({ key, ...a }) => a),
      activeCarrier: carrierAuth.some((a) => a.status === 'Active'),
      pendingCarrier: carrierAuth.some((a) => a.status === 'Pending'),
      activeBroker: brokerAuth.some((a) => a.status === 'Active'),
      firstGranted,
      recentChanges,
    },
    insurance: { required: required || null, onFile, policies, ending },
    oosOrders,
    suspensionOrders,
    inspections,
    crashes: crashTotals(raw.crashes),
    missing: Object.keys(PARTS).filter((k) => raw[k] == null),
    // Neither the registration nor any authority could be read: FMCSA's data isn't
    // answering, which isn't the same as "no such carrier".
    unavailable: raw.census == null && !(raw.authority && raw.authority.length),
    checkedAt: new Date(now).toISOString(),
  };
  const a = assess(report, now);
  report.verdict = a.verdict;
  report.flags = a.flags;
  return report;
}

// ── What to watch out for ─────────────────────────────────────────────────
// level 'stop' (don't book), 'warn' (check before booking) or 'info'. Plain words: a broker
// reads these before tendering a load.
// "liability insurance", "cargo insurance", "surety bond", "trust fund"
const coverageName = (kind) => ({ 'Liability (BIPD)': 'liability insurance', Cargo: 'cargo insurance', 'Surety bond': 'surety bond', 'Trust fund': 'trust fund' }[kind]
  || `${String(kind || 'insurance').toLowerCase()}`);
const fmtDate = (iso) => (iso ? new Date(iso + 'T12:00:00Z').toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' }) : '');
const usd = (n) => '$' + Math.round(n).toLocaleString('en-US');
const pct = (x) => Math.round(x * 100) + '%';

function assess(r, now = Date.now()) {
  const flags = [];
  const add = (level, code, text) => flags.push({ level, code, text });
  if (!r.found) {
    add('stop', 'not_found', 'No carrier with this number in FMCSA’s records. Check the number with the carrier.');
    return { verdict: 'stop', flags };
  }
  const A = r.authority;
  // A part that didn't load is unknown, not empty: nothing is concluded from it.
  const gone = (k) => (r.missing || []).includes(k);
  // Authority
  if (!A.activeCarrier && !gone('authority')) {
    const last = A.recentChanges.find((h) => h.status === 'Inactive');
    if (A.activeBroker) add('stop', 'broker_only', 'Licensed as a broker only, with no active carrier authority: they can’t haul the load themselves.');
    else if (A.pendingCarrier) add('stop', 'authority_pending', 'Their operating authority isn’t active yet (still pending with FMCSA).');
    else if (A.carrier.length) add('stop', 'authority_inactive', `No active operating authority${last ? `: ${last.reason.replace(/\s*\(.*?\)\s*$/, '')} (${fmtDate(last.date)})` : ''}.`);
    else add('stop', 'no_authority', 'No for-hire operating authority on file: they can’t haul for hire across state lines.');
  }
  if (r.usdotStatus && r.usdotStatus !== 'Active') add('stop', 'usdot_inactive', `Their USDOT number is ${r.usdotStatus.toLowerCase()}.`);
  const openOos = r.oosOrders.filter((o) => !o.rescinded);
  for (const o of openOos.slice(0, 2)) add('stop', 'oos_order', `Out-of-service order since ${fmtDate(o.date)}: ${o.reason}.`);
  if (r.safetyRating === 'Unsatisfactory') add('stop', 'safety_unsatisfactory', `Unsatisfactory safety rating (${fmtDate(r.safetyRatingDate)}).`);
  // Insurance
  if (A.activeCarrier && !gone('authority') && r.insurance.required && r.insurance.onFile < r.insurance.required) {
    add('stop', 'insurance_short', r.insurance.onFile
      ? `Liability insurance on file is ${usd(r.insurance.onFile)}, below the ${usd(r.insurance.required)} required.`
      : `No liability insurance on file (${usd(r.insurance.required)} required).`);
  }
  // A part that didn't load could hide any of the above: never "No problems found" then.
  const missing = (r.missing || []).filter((k) => PARTS[k]);
  if (missing.length) {
    add('warn', 'incomplete', `Part of FMCSA’s records didn’t load (${listWords(missing.map((k) => PARTS[k]))}), so this check isn’t complete. Check again before booking.`);
  }
  for (const e of r.insurance.ending.slice(0, 2)) {
    const what = coverageName(e.kind);
    add('warn', 'insurance_cancelling', `${what.charAt(0).toUpperCase() + what.slice(1)}${e.insurer ? ` with ${e.insurer}` : ''} is being cancelled on ${fmtDate(e.cancels)}. Unless they file new coverage, their authority will be suspended.`);
  }
  // New to the business: a common sign of fraud
  const authAge = A.firstGranted ? Math.floor((now - Date.parse(A.firstGranted + 'T00:00:00Z')) / DAY) : null;
  const dotAge = r.usdotAdded ? Math.floor((now - Date.parse(r.usdotAdded + 'T00:00:00Z')) / DAY) : null;
  if (authAge != null && authAge < NEW_AUTHORITY_DAYS) add('warn', 'new_authority', `Authority granted ${authAge} day${authAge === 1 ? '' : 's'} ago (${fmtDate(A.firstGranted)}). New carriers are a common fraud risk: verify them before booking.`);
  else if (dotAge != null && dotAge < NEW_USDOT_DAYS) add('warn', 'new_usdot', `USDOT number registered ${dotAge} day${dotAge === 1 ? '' : 's'} ago (${fmtDate(r.usdotAdded)}). New carriers are a common fraud risk: verify them before booking.`);
  else if (authAge != null && authAge < 365) add('info', 'young_authority', `Authority granted ${fmtDate(A.firstGranted)}, under a year ago.`);
  // Trouble in the last year
  const suspended = A.recentChanges.filter((h) => h.status === 'Inactive');
  if (A.activeCarrier && suspended.length) {
    const s = suspended[0];
    add('warn', 'recent_suspension', `Authority was suspended in the last year (${fmtDate(s.date)}: ${s.reason.replace(/\s*\(.*?\)\s*$/, '')}) and is active again.`);
  }
  if (r.safetyRating === 'Conditional') add('warn', 'safety_conditional', `Conditional safety rating (${fmtDate(r.safetyRatingDate)}).`);
  const i = r.inspections;
  if (i && i.vehicle.n >= 5 && i.vehicle.national && i.vehicle.rate > Math.max(i.vehicle.national * 1.5, i.vehicle.national + 0.1)) {
    add('warn', 'vehicle_oos_high', `Trucks put out of service in ${pct(i.vehicle.rate)} of inspections (U.S. average ${pct(i.vehicle.national)}).`);
  }
  if (i && i.driver.n >= 5 && i.driver.national && i.driver.rate > Math.max(i.driver.national * 2, i.driver.national + 0.08)) {
    add('warn', 'driver_oos_high', `Drivers put out of service in ${pct(i.driver.rate)} of inspections (U.S. average ${pct(i.driver.national)}).`);
  }
  const mcsAge = daysSince(r.mcs150, now);
  if (mcsAge != null && mcsAge > 730) add('warn', 'mcs150_old', `Registration (MCS-150) last updated ${fmtDate(r.mcs150)}: it's due every two years.`);
  // Good to know
  if (A.activeCarrier && A.activeBroker) add('info', 'also_broker', 'Also licensed as a broker. Make sure they’ll haul the load on their own trucks.');
  if (i && i.total === 0 && (authAge == null || authAge > 365)) add('info', 'no_inspections', 'No roadside inspections in the last two years.');
  if (r.crashes && r.crashes.fatal) add('info', 'fatal_crashes', `${r.crashes.fatal} fatal crash${r.crashes.fatal === 1 ? '' : 'es'} in the last two years (of ${r.crashes.total} reportable).`);
  const verdict = flags.some((f) => f.level === 'stop') ? 'stop' : flags.some((f) => f.level === 'warn') ? 'warn' : 'ok';
  return { verdict, flags };
}

// ── Monitoring (carrier-monitor.js) ───────────────────────────────────────
// The facts a daily check compares, for many carriers at once (batches of up to 100).
// Carriers whose batch couldn't be read even on a second try are left out of the answer:
// they keep yesterday's facts (no alerts from missing data).
async function monitorFacts(dots, opt = {}) {
  const twice = (ds, params, o) => soql(ds, params, o).catch(() => sleep(o.retryDelayMs != null ? o.retryDelayMs : 1000).then(() => soql(ds, params, o)));
  const list = [...new Set(dots.map(digits).filter(Boolean))];
  const out = {};
  for (const d of list) out[d] = { carrierStatus: [], onFile: 0, required: 0, cancels: [], oos: [], usdotStatus: null, safetyRating: null };
  const today = ymd(new Date(Date.now()));
  for (let i = 0; i < list.length; i += 100) {
    const batch = list.slice(i, i + 100);
    const inList = batch.map((d) => `'${d}'`).join(',');
    let auth, ins, oos, census;
    try {
      [auth, ins, oos, census] = await Promise.all([
        twice(DS.authority, { $select: 'usdot_number, docket_number, op_auth_type, op_auth_status, min_cov_amount, bipd_file', $where: `usdot_number in (${inList})`, $limit: 5000 }, opt),
        twice(DS.insHistory, { $select: 'usdot_number, ins_type_code, ins_type_desc, insurance_company_name, policy_no, cancl_effective_date, filing_status_reason',
          $where: `usdot_number in (${inList}) AND cancl_effective_date >= '${today}'`, $limit: 5000 }, opt),
        twice(DS.oos, { $select: 'dot_number, oos_date, oos_reason, rescind_date', $where: `dot_number in (${inList}) AND rescind_date IS NULL`, $limit: 5000 }, opt),
        twice(DS.census, { $select: 'dot_number, status_code, safety_rating', $where: `dot_number in (${inList})`, $limit: 5000 }, opt),
      ]);
    } catch (e) {
      console.warn(`[fmcsa] monitor batch of ${batch.length} not checked: ${e.message}`);
      for (const d of batch) delete out[d];
      continue;
    }
    for (const r of auth) {
      const f = out[digits(r.usdot_number)];
      if (!f || !CARRIER_AUTH.test(r.op_auth_type || '')) continue;
      f.carrierStatus.push(r.op_auth_status);
      f.onFile = Math.max(f.onFile, money(r.bipd_file) || 0);
      if (r.op_auth_status === 'Active') f.required = Math.max(f.required, money(r.min_cov_amount) || 0);
    }
    for (const r of ins) {
      const f = out[digits(r.usdot_number)];
      const reason = String(r.filing_status_reason || '').toUpperCase();
      if (!f || reason === 'TERM/REPL' || reason === 'NAMECHG') continue;
      const when = isoDate(r.cancl_effective_date);
      if (when && !f.cancels.some((c) => c.cancels === when && c.policy === r.policy_no)) {
        f.cancels.push({ kind: INS_KIND[r.ins_type_code] || r.ins_type_desc || 'Filing', insurer: r.insurance_company_name || '', policy: r.policy_no || '', cancels: when });
      }
    }
    for (const r of oos) {
      const f = out[digits(r.dot_number)];
      if (f) f.oos.push({ date: isoDate(r.oos_date), reason: r.oos_reason || '' });
    }
    for (const r of census) {
      const f = out[digits(r.dot_number)];
      if (f) { f.usdotStatus = { A: 'Active', I: 'Inactive', P: 'Pending' }[r.status_code] || r.status_code || null; f.safetyRating = SAFETY[r.safety_rating] || null; }
    }
  }
  for (const d of Object.keys(out)) {
    const f = out[d];
    f.authority = f.carrierStatus.includes('Active') ? 'Active' : f.carrierStatus.includes('Pending') ? 'Pending' : f.carrierStatus.length ? 'Inactive' : 'None';
    f.insuranceShort = f.authority === 'Active' && f.required > 0 && f.onFile < f.required;
    f.cancels.sort((a, b) => a.cancels.localeCompare(b.cancels) || a.policy.localeCompare(b.policy));
    f.oos.sort((a, b) => String(a.date).localeCompare(String(b.date)) || a.reason.localeCompare(b.reason));
    delete f.carrierStatus;
  }
  return out;
}

// A saved carrier's last facts vs today's → alerts { kind, text } (only what changed for the worse).
function diffFacts(prev, cur, name) {
  const alerts = [];
  const who = name || 'This carrier';
  if (!prev || !cur) return alerts;
  if (prev.authority === 'Active' && cur.authority !== 'Active') {
    const now = cur.authority === 'None' ? 'no longer has operating authority on file' : `operating authority is now ${String(cur.authority).toLowerCase()}`;
    alerts.push({ kind: 'authority', text: `${who}: ${now}. Don’t tender them loads until it’s active again.` });
  }
  if (!prev.insuranceShort && cur.insuranceShort) alerts.push({ kind: 'insurance', text: `${who}: liability insurance on file dropped to ${usd(cur.onFile)}, below the ${usd(cur.required)} required.` });
  for (const c of cur.cancels || []) {
    if (!(prev.cancels || []).some((p) => p.cancels === c.cancels && p.policy === c.policy)) {
      alerts.push({ kind: 'insurance_cancelling', text: `${who}: ${coverageName(c.kind)}${c.insurer ? ` with ${c.insurer}` : ''} is being cancelled on ${fmtDate(c.cancels)}.` });
    }
  }
  for (const o of cur.oos || []) {
    if (!(prev.oos || []).some((p) => p.date === o.date && p.reason === o.reason)) alerts.push({ kind: 'oos', text: `${who}: out-of-service order (${fmtDate(o.date)}): ${o.reason}.` });
  }
  if (prev.usdotStatus === 'Active' && cur.usdotStatus && cur.usdotStatus !== 'Active') alerts.push({ kind: 'usdot', text: `${who}: USDOT number is now ${cur.usdotStatus.toLowerCase()}.` });
  const bad = { Conditional: 1, Unsatisfactory: 2 };
  if ((bad[cur.safetyRating] || 0) > (bad[prev.safetyRating] || 0)) alerts.push({ kind: 'safety', text: `${who}: safety rating is now ${cur.safetyRating}.` });
  return alerts;
}

// The verdict from monitoring facts alone (for the saved list between full checks).
// The saved-list status from a carrier's facts: the same lines as the report's verdict.
// No facts yet (FMCSA didn't answer when it was saved) → null, "not checked yet".
// `granted` and `usdotAdded` come from the report when the carrier was saved, so a new
// carrier stays "check before booking" on the list until it's past the new-carrier window.
function factsVerdict(f, now = Date.now()) {
  if (!f || !Object.keys(f).length) return null;
  if (f.authority !== 'Active' || f.insuranceShort || (f.oos && f.oos.length) || (f.usdotStatus && f.usdotStatus !== 'Active') || f.safetyRating === 'Unsatisfactory') return 'stop';
  const age = (iso) => (iso ? Math.floor((now - Date.parse(iso + 'T00:00:00Z')) / DAY) : null);
  const authAge = age(f.granted), dotAge = age(f.usdotAdded);
  const isNew = (authAge != null && authAge < NEW_AUTHORITY_DAYS) || (dotAge != null && dotAge < NEW_USDOT_DAYS);
  if ((f.cancels && f.cancels.length) || f.safetyRating === 'Conditional' || isNew) return 'warn';
  return 'ok';
}

module.exports = { DS, PARTS, parseQuery, soql, resolveDot, fetchCarrier, nationalAverages, buildReport, assess, monitorFacts, diffFacts, factsVerdict, isoDate, _internal: { inspectionTotals, crashTotals, titleCase } };
