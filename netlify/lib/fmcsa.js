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
//   legacyCarrier, legacyAuthHist, legacyInsurance, legacyInsHist
//                Carrier / AuthHist / Insur / InsHist - All With History: FMCSA's licensing
//                records from before Motus (see below)
// and FMCSA's website (SAFER's company snapshot) for the authority status it shows today.
//
// FMCSA moved authority and insurance to its new registration system (Motus) in May 2026.
// The Motus datasets only have a docket (MC/MX/FF number) once something about it has changed
// since then: a new filing, a status change. Most carriers' dockets haven't, so their authority,
// history and insurance are only in the older licensing datasets, which took no new actions after
// May 20, 2026. Each docket is read from Motus when Motus has it, else from the older records;
// never "no authority" just because Motus hasn't got it.
// The published data still misses some changes since May 2026 (a revocation pending then that
// took effect later, coverage filed since), so every check also reads the authority status
// FMCSA's website shows today, and that wins: "AUTHORIZED FOR …", "NOT AUTHORIZED" or
// "OUT-OF-SERVICE". Insurance from the older records leaves out filings cancelled since.
// Optional SOCRATA_APP_TOKEN raises the open-data rate limits; if it's refused, checks go on without it.

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
  legacyCarrier: '6eyk-hxee',
  legacyAuthHist: '9mw4-x3tu',
  legacyInsurance: 'ypjt-5ydn',
  legacyInsHist: '6sqe-dvqs',
};
// FMCSA's company snapshot (its website): the authority status it shows today
const SAFER_URL = 'https://safer.fmcsa.dot.gov/query.asp?searchtype=ANY&query_type=queryCarrierSnapshot&query_param=USDOT&query_string=';
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
// The app token only raises the rate limits, so a bad one mustn't stop the checks.
// data.transportation.gov refuses every request carrying a token it doesn't accept
// (403 "Invalid app_token specified": mistyped or revoked), and fetch throws on a character
// no header can carry (a zero-width space picked up in a copy). A refused request is asked
// again without the token, and once that works the token isn't sent again until the next
// deploy. Either way, the function log says to check SOCRATA_APP_TOKEN in Netlify; when the
// token works, the log says so once (so a missing token and a working one can be told apart).
let tokenRefused = false;
const said = new Set();
const sayOnce = (key, msg, warn) => { if (!said.has(key)) { said.add(key); (warn ? console.warn : console.log)('[fmcsa] ' + msg); } };
function appToken(opt) {
  const fromEnv = opt.token == null;
  if (fromEnv && tokenRefused) return '';
  const t = String((fromEnv ? process.env.SOCRATA_APP_TOKEN : opt.token) || '').trim();
  if (t && !/^[\x21-\x7e]+$/.test(t)) {   // tokens are letters and digits: no spaces, nothing unusual
    sayOnce('chars', 'SOCRATA_APP_TOKEN has spaces or characters a token doesn\'t have, so it isn\'t sent. Check it in Netlify.', true);
    return '';
  }
  return t;
}

async function soql(ds, params, opt = {}) {
  const url = new URL(BASE + ds + '.json');
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, String(v));
  const headers = { Accept: 'application/json' };
  const token = appToken(opt);
  if (token) headers['X-App-Token'] = token;
  // opt.timeoutMs bounds this request; opt.deadline (a Date.now() time) bounds the whole
  // check, so a slow day at data.transportation.gov can't run past the function's limit.
  let wait = opt.timeoutMs || 10000;
  if (opt.deadline) wait = Math.min(wait, opt.deadline - Date.now() - 100);
  if (wait < 250) throw new Error(`${ds}: out of time`);
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), wait);
  try {
    const get = (h) => (opt.fetchImpl || fetch)(url.toString(), { headers: h, signal: ctrl.signal });
    let resp = await get(headers);
    let sent = !!token;
    if (resp.status === 403 && token) {
      if (resp.body && typeof resp.body.cancel === 'function') resp.body.cancel().catch(() => {});
      const plain = Object.assign({}, headers);
      delete plain['X-App-Token'];
      resp = await get(plain);
      sent = false;
      if (resp.ok && opt.token == null) {
        tokenRefused = true;
        sayOnce('refused', 'data.transportation.gov refused SOCRATA_APP_TOKEN, so checks go on without it (at lower rate limits). Check the token in Netlify.', true);
      }
    }
    if (!resp.ok) throw new Error(`${ds} answered ${resp.status}`);
    if (sent && opt.token == null) sayOnce('accepted', 'data.transportation.gov accepted SOCRATA_APP_TOKEN.');
    const data = await resp.json();
    return Array.isArray(data) ? data : [];
  } finally {
    clearTimeout(timer);
  }
}
const digits = (s) => /^\d{1,8}$/.test(String(s)) ? String(Number(s)) : null;   // safe inside SoQL

// ── FMCSA's website ────────────────────────────────────────────────────────
// The "Operating Authority Status" SAFER's company snapshot shows today, from its page:
//   { status: 'authorized', authorized: ['Motor Carrier of Property (Except Household Goods)', …] }
//   { status: 'not-authorized' }  or  { status: 'out-of-service' }
// null when the page has no such field (no carrier with that USDOT number, or the page changed).
function parseSafer(html) {
  const m = String(html || '').match(/Operating Authority Status:\s*<\/a>\s*<\/th>\s*<td[^>]*>([\s\S]*?)<\/td>/i);
  if (!m) return null;
  const lines = m[1].replace(/<br\s*\/?>/gi, '\n').replace(/<[^>]+>/g, ' ').replace(/&nbsp;/gi, ' ').replace(/&amp;/gi, '&')
    .split('\n').map((s) => s.replace(/\s+/g, ' ').trim()).filter(Boolean);
  const first = (lines[0] || '').toUpperCase();
  if (/^OUT-OF-SERVICE/.test(first)) return { status: 'out-of-service', authorized: [] };
  if (/^NOT AUTHORIZED/.test(first)) return { status: 'not-authorized', authorized: [] };
  if (/^AUTHORIZED FOR/.test(first)) {
    const rest = first.replace(/^AUTHORIZED FOR:?\s*/, '') ? [lines[0].replace(/^AUTHORIZED FOR:?\s*/i, '')] : [];
    const authorized = rest.concat(lines.slice(1)).filter((l) => !/^for licensing|click here|please note/i.test(l));
    return authorized.length ? { status: 'authorized', authorized } : null;
  }
  return null;
}
// Ask FMCSA's website for one USDOT number. Throws when it doesn't answer; null when it answers
// without an authority status (see parseSafer).
async function saferStatus(dot, opt = {}) {
  const d = digits(dot);
  if (!d) throw new Error('bad USDOT number');
  const left = (opt.deadline || Date.now() + 8000) - Date.now();
  if (left < 500) throw new Error('out of time');
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), Math.min(opt.saferTimeoutMs || 6000, left));
  try {
    const resp = await (opt.fetchImpl || fetch)(SAFER_URL + d, { headers: { Accept: 'text/html' }, signal: ctrl.signal });
    if (!resp.ok) throw new Error(`FMCSA's website answered ${resp.status}`);
    return parseSafer(await resp.text());
  } finally {
    clearTimeout(timer);
  }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// New carriers are the usual fraud risk: authority under 90 days, or a USDOT number under 180.
const NEW_AUTHORITY_DAYS = 90, NEW_USDOT_DAYS = 180;
// The report's format: carrier-check.js reuses a cached report only if it was built with this one
// (2: USDOT "Out of service", suspension orders, history without FMCSA's bookkeeping;
// 3: dockets Motus doesn't have yet read from FMCSA's older licensing records).
const REPORT_VERSION = 3;
const docketSafe = (s) => /^(MC|MX|FF)\d{1,8}$/.test(String(s)) ? String(s) : null;
// The older licensing datasets write USDOT numbers with 8 digits ("04382996")
const pad8 = (d) => String(d).padStart(8, '0');

// An MC/MX/FF number → its USDOT number: the authority records, else the census. FMCSA's data
// can take several seconds a request, so both are asked at once; an authority match doesn't
// wait for the census, and "not found" needs both lists to have answered.
async function resolveDot(q, opt = {}) {
  if (q.dot) return digits(q.dot);
  const docket = docketSafe(q.docket);
  if (!docket) return null;
  const prefix = docket.slice(0, 2), num = docket.slice(2);
  const authority = soql(DS.authority, { $select: 'usdot_number', $where: `docket_number='${docket}'`, $limit: 5 }, opt);
  const census = soql(DS.census, { $select: 'dot_number',
    $where: `(docket1prefix='${prefix}' AND docket1='${num}') OR (docket2prefix='${prefix}' AND docket2='${num}')`, $limit: 2 }, opt);
  census.catch(() => {});   // not needed after an authority match; its failure is handled below
  let rows = null, authorityError = null;
  try { rows = await authority; } catch (e) { authorityError = e; }
  const hit = rows && rows.find((r) => digits(r.usdot_number));
  if (hit) return digits(hit.usdot_number);
  let c;
  try { c = await census; } catch (e) { throw authorityError || e; }
  const hit2 = c.find((r) => digits(r.dot_number));
  if (hit2) return digits(hit2.dot_number);
  if (authorityError) throw authorityError;
  return null;
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
    // The older licensing records, for the dockets Motus doesn't have (most carriers'): see the top
    legacyCarrier: [DS.legacyCarrier, { $where: `dot_number='${pad8(d)}'`, $limit: 20 }],
    legacyAuthHist: [DS.legacyAuthHist, { $where: `dot_number='${pad8(d)}'`, $limit: 300 }],
  };
  const deadline = opt.deadline || Date.now() + 8000;
  const run = (k, timeoutMs) => soql(queries[k][0], queries[k][1], Object.assign({}, opt, { deadline, timeoutMs }));
  const raw = { dot: d };
  // FMCSA's website, asked alongside: the authority status it shows today (null if it didn't say)
  const live = saferStatus(d, Object.assign({}, opt, { deadline })).catch(() => null);
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
  // Insurance is filed by docket: the older filings for the dockets only the older records have,
  // and those filings' cancellations (one that took effect since May 2026 isn't on file anymore)
  const dockets = legacyOnlyDockets(raw);
  raw.legacyInsurance = [];
  raw.legacyInsHist = [];
  if (dockets.length) {
    const inList = dockets.map((k) => `'${k}'`).join(',');
    const more = {
      legacyInsurance: [DS.legacyInsurance, { $where: `prefix_docket_number in (${inList})`, $limit: 100 }],
      legacyInsHist: [DS.legacyInsHist, { $select: 'docket_number, policy_no, effective_date, cancl_effective_date, cancl_method, mod_col_3, name_company',
        $where: `docket_number in (${inList}) AND cancl_method in ('CANCEL','TERM/CANCL','CANC/CANCL','REVOKED')`, $limit: 1000 }],
    };
    let left = Object.keys(more);
    for (let attempt = 0; attempt < 2 && left.length; attempt++) {
      if (attempt && deadline - Date.now() < 1500) break;
      const got = await Promise.allSettled(left.map((k) => soql(more[k][0], more[k][1], Object.assign({}, opt, { deadline, timeoutMs: opt.timeoutMs || 5000 }))));
      const failed = [];
      got.forEach((r, i) => { if (r.status === 'fulfilled') raw[left[i]] = r.value; else { raw[left[i]] = null; failed.push(left[i]); } });
      left = failed;
    }
  }
  raw.safer = await live;
  return raw;
}

// ── FMCSA's older licensing records → rows shaped like Motus's ─────────────
// The dockets only the older records have: in their Carrier list, not in Motus's. Unknown
// (none) while either list failed to load.
function legacyOnlyDockets(raw) {
  if (!Array.isArray(raw.authority) || !Array.isArray(raw.legacyCarrier)) return [];
  const inMotus = new Set(raw.authority.map((r) => r.docket_number).filter(Boolean));
  return [...new Set(raw.legacyCarrier.map((r) => docketSafe(r.docket_number)).filter((k) => k && !inMotus.has(k)))];
}
// Amounts are in thousands of dollars there ("01000" = $1,000,000)
const thousands = (s) => { const n = Number(s); return s != null && s !== '' && Number.isFinite(n) ? n * 1000 : null; };
const PROPERTY_AUTH = 'Motor Carrier of Property (Except Household Goods)';
// One Carrier row per docket, with a status for each kind of authority: common or contract
// carrier, broker ('A' active, 'I' inactive, 'N' none, and whether an application is pending)
function legacyAuthorityRows(r) {
  const status = (stat, pend) => (stat === 'A' ? 'Active' : pend === 'Y' ? 'Pending' : stat === 'I' ? 'Inactive' : null);
  const base = { docket_number: r.docket_number, usdot_number: String(Number(r.dot_number) || ''), legal_name: r.legal_name, bus_telno: r.bus_telno };
  const out = [];
  const both = [status(r.common_stat, r.common_app_pend), status(r.contract_stat, r.contract_app_pend)];
  const carrier = both.includes('Active') ? 'Active' : both.includes('Pending') ? 'Pending' : both.includes('Inactive') ? 'Inactive' : null;
  if (carrier) {
    const types = [];
    if (r.property_chk === 'Y') types.push(r.enterprise_chk === 'Y' ? 'Enterprise Motor Carrier of Property' : PROPERTY_AUTH);
    if (r.hhg_chk === 'Y') types.push('Motor Carrier of Household Goods');
    if (r.passenger_chk === 'Y') types.push('Motor Carrier of Passengers');
    if (!types.length) types.push(PROPERTY_AUTH);
    for (const t of types) {
      out.push(Object.assign({}, base, { op_auth_type: t, op_auth_status: carrier, min_cov_amount: thousands(r.min_cov_amount), bipd_file: thousands(r.bipd_file),
        cargo_req: r.cargo_req, cargo_file: r.cargo_file, bond_req: 'N', bond_file: 'N' }));
    }
  }
  const broker = status(r.broker_stat, r.broker_app_pend);
  if (broker) {
    out.push(Object.assign({}, base, { op_auth_type: r.hhg_chk === 'Y' && r.property_chk !== 'Y' ? 'Broker of Household Goods' : 'Broker of Property (Except Household Goods)',
      op_auth_status: broker, min_cov_amount: 0, bipd_file: 0, cargo_req: 'N', cargo_file: 'N', bond_req: r.bond_req, bond_file: r.bond_file }));
  }
  return out;
}
// The older history's authority names → Motus's
const LEGACY_TYPES = [
  [/HOUSEHOLD GOODS BROKER/, 'Broker of Household Goods'],
  [/BROKER/, 'Broker of Property (Except Household Goods)'],
  [/FREIGHT FORWARDER/, 'Freight Forwarder'],
  [/HOUSEHOLD GOODS/, 'Motor Carrier of Household Goods'],
  [/PASSENGER/, 'Motor Carrier of Passengers'],
  [/^ENTERPRISE$/, 'Enterprise Motor Carrier of Property'],
  [/PROPERTY|^COMMON$|^CONTRACT$|TEMPORARY AUTHORITY/, PROPERTY_AUTH],
];
// How an authority's period ended, when that took it out of service (not a transfer, a renumbering
// or a revocation FMCSA started and then discontinued)
const LEGACY_ENDED = /^(REVOKED|OUT OF SERVICE|SAFETY SUSPENSION|SAFETY REVOCATION|FAILURE TO REAPPLY|EXPIRED ETA OR TA|TERM EXPIRED|ADMINISTRATIVE INACTIVATION)$/;
// Each older history row is one period of an authority: how it began (granted, reinstated, a
// revocation notice…) and how it ended. → Motus-style events: granted / reinstated (active), and
// the end when it was revoked or otherwise taken out of service (inactive).
function legacyHistoryRows(r) {
  const name = String(r.mod_col_1 || '').toUpperCase();
  const type = (LEGACY_TYPES.find(([re]) => re.test(name)) || [null, titleCase(name)])[1];
  const began = String(r.original_action_desc || '').toUpperCase().trim();
  const ended = String(r.disp_action_desc || '').toUpperCase().trim();
  const base = { docket_number: r.docket_number, op_auth_type: type };
  const sentence = (s) => s.charAt(0) + s.slice(1).toLowerCase();   // "REVOKED" → "Revoked"
  const out = [];
  if (began === 'GRANTED' || began === 'REINSTATED') out.push(Object.assign({}, base, { op_auth_status: 'Active', reason: sentence(began), status_change_date: r.orig_served_date }));
  if (LEGACY_ENDED.test(ended)) out.push(Object.assign({}, base, { op_auth_status: 'Inactive', reason: sentence(ended), status_change_date: r.disp_decided_date || r.disp_served_date }));
  return out;
}
// FMCSA's website (parseSafer) over the published data, for carrier and broker authority: what it
// lists as authorized is active, what it doesn't list isn't (a pending application stays pending).
// Matched by name, or by kind when the names differ; authority it lists that the data hasn't got
// at all is added. Returns whether anything changed.
function applyLive(authorities, live, docket) {
  const listed = live.status === 'authorized' ? live.authorized || [] : [];
  const norm = (t) => String(t).toLowerCase().replace(/[^a-z]/g, '');
  let changed = false;
  for (const kind of [CARRIER_AUTH, BROKER_AUTH]) {
    const ours = authorities.filter((a) => kind.test(a.type));
    const theirs = listed.filter((t) => kind.test(t));
    const named = (a) => theirs.some((t) => norm(t) === norm(a.type));
    const byName = ours.some(named);
    for (const a of ours) {
      const on = theirs.length > 0 && (byName ? named(a) : true);
      if (on && a.status !== 'Active') { a.status = 'Active'; changed = true; }
      else if (!on && a.status === 'Active') { a.status = 'Inactive'; changed = true; }
    }
    if (!ours.length) {
      for (const t of theirs) {
        authorities.push({ key: 'live|' + t, docket, type: t, status: 'Active', minCoverage: null, bipdOnFile: null,
          cargoRequired: false, cargoOnFile: false, bondRequired: false, bondOnFile: false });
        changed = true;
      }
    }
  }
  return changed;
}
function legacyInsuranceRow(r) {
  return { docket_number: r.prefix_docket_number, ins_type_code: r.ins_type_code, ins_class_code: r.ins_class_code, ins_form_code: r.ins_form_code,
    insurance_company_name: r.name_company, policy_no: r.policy_no, max_cov_amount: thousands(r.max_cov_amount), underl_lim_amount: thousands(r.underl_lim_amount),
    effective_date: r.effective_date };
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
// FMCSA sends names in capitals. Title-case them, but:
//  • no capital after an apostrophe ("Hickman's"), except after a one-letter prefix ("O'Neil");
//  • company suffixes and Roman numerals stay in capitals (LLC, USA, DBA, III);
//  • in carrier names (names = true), initials that aren't words stay in capitals: letters
//    with no vowel (JB, CRST) or one letter repeated (YY, AAA), but not words like ST or HWY.
const UPPER_WORDS = /^(llc|lp|llp|usa|us|po|dba|ii|iii|iv|vi|vii|viii)$/;
const NOT_INITIALS = /^(st|mt|ft|dr|jr|sr|mr|mrs|ms|rd|hwy|ln|blvd|pkwy|ct|pl|frt|trk|trkg|svc|svcs|mgmt|whse|bldg)$/;
const titleCase = (s, names) => {
  const str = String(s || '').toLowerCase();
  return str.replace(/[a-z0-9]+/g, (w, at) => {
    const before = str.slice(0, at);
    if (/['’]$/.test(before) && !/(^|[^a-z0-9])[a-z]['’]$/.test(before)) return w;
    if (UPPER_WORDS.test(w)) return w.toUpperCase();
    if (names && /^[a-z]{2,4}$/.test(w) && !NOT_INITIALS.test(w) && (!/[aeiouy]/.test(w) || /^([a-z])\1+$/.test(w))) return w.toUpperCase();
    return w.charAt(0).toUpperCase() + w.slice(1);
  });
};
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

// The parts that couldn't be read. A docket only the older records have is read from them: if
// they didn't load, its history or insurance is unknown; and when Motus has nothing for the
// carrier and the older records didn't answer, so is its authority (never "no authority").
function missingParts(raw, legacyDockets) {
  const missing = Object.keys(PARTS).filter((k) => raw[k] == null);
  const add = (k) => { if (!missing.includes(k)) missing.push(k); };
  if (Array.isArray(raw.authority) && !raw.authority.length && raw.legacyCarrier == null) add('authority');
  if (legacyDockets.length && raw.legacyAuthHist == null) add('authHistory');
  if (legacyDockets.length && raw.legacyInsurance == null) add('insurance');
  return missing;
}

// The raw rows → what the page shows.
function buildReport(raw, { national = null, now = Date.now() } = {}) {
  const c = raw.census && raw.census[0] ? raw.census[0] : null;
  const todayIso = new Date(now).toISOString().slice(0, 10);
  // Each docket from Motus when Motus has it, else from FMCSA's older licensing records
  const legacyDockets = legacyOnlyDockets(raw);
  const fromLegacy = (rows, key) => (rows || []).filter((r) => legacyDockets.includes(r[key]));
  // The older insurance filings: one whose cancellation has taken effect since isn't on file
  // anymore (and its liability no longer counts); one still to take effect is ending. A
  // cancellation (only real ones are read, not replacements) belongs to a filing with the same
  // docket and policy number that was in effect when it was cancelled: a policy re-filed under its
  // number keeps it, and an old cancellation doesn't touch a newer filing of the same policy.
  const legacyIns = [], legacyEnding = [], droppedBipd = {}, bipdLeft = {}, cancelledSince = {};
  for (const r of fromLegacy(raw.legacyInsurance, 'prefix_docket_number')) {
    const row = legacyInsuranceRow(r);
    const k = r.prefix_docket_number, from = isoDate(r.effective_date) || '';
    const when = (raw.legacyInsHist || []).filter((x) => x.docket_number === k && (x.policy_no || '') === (r.policy_no || ''))
      .map((x) => isoDate(x.cancl_effective_date)).filter((d) => d && d >= from).sort().pop() || null;
    const liability = String(r.ins_type_code) === '1';
    if (when && when <= todayIso) {
      if (liability) {
        droppedBipd[k] = (droppedBipd[k] || 0) + (row.max_cov_amount || 0);
        if (!cancelledSince[k] || when > cancelledSince[k].date) cancelledSince[k] = { date: when, insurer: r.name_company || '' };
      }
      continue;
    }
    if (liability) bipdLeft[k] = (bipdLeft[k] || 0) + 1;
    if (when) legacyEnding.push({ ins_type_code: r.ins_type_code, insurance_company_name: r.name_company, policy_no: r.policy_no, cancl_effective_date: when.replace(/-/g, ''), filing_status_reason: 'CANCEL' });
    legacyIns.push(row);
  }
  // Liability on file for a docket, less what was cancelled since (none left: none on file)
  const bipdNow = (k, amount) => (!(k in droppedBipd) ? amount : !bipdLeft[k] ? 0 : Math.max(0, (amount || 0) - droppedBipd[k]));
  const auth = (raw.authority || []).concat(...fromLegacy(raw.legacyCarrier, 'docket_number').map((r) => legacyAuthorityRows(r).map((a) => (
    CARRIER_AUTH.test(a.op_auth_type) ? Object.assign(a, { bipd_file: bipdNow(r.docket_number, a.bipd_file) }) : a))));
  // Nothing newer than the cancelled liability is published for a docket that has none left
  for (const k of Object.keys(cancelledSince)) if (bipdLeft[k]) delete cancelledSince[k];
  const authHistory = (raw.authHistory || []).concat(...fromLegacy(raw.legacyAuthHist, 'docket_number').map(legacyHistoryRows));
  const insuranceRows = (raw.insurance || []).concat(legacyIns);
  const authorities = [];
  for (const r of auth) {
    const key = `${r.docket_number}|${r.op_auth_type}`;
    if (authorities.some((a) => a.key === key)) continue;
    authorities.push({ key, docket: r.docket_number || null, type: r.op_auth_type || '', status: r.op_auth_status || '',
      minCoverage: money(r.min_cov_amount), bipdOnFile: money(r.bipd_file),
      cargoRequired: r.cargo_req === 'Y', cargoOnFile: r.cargo_file === 'Y', bondRequired: r.bond_req === 'Y', bondOnFile: r.bond_file === 'Y' });
  }
  const dockets = [...new Set(authorities.map((a) => a.docket).filter(Boolean))];
  if (!dockets.length && c && c.docket1prefix && c.docket1) dockets.push(c.docket1prefix + String(Number(c.docket1)));
  // FMCSA's website today wins over the published data (see the top)
  const live = raw.safer && raw.safer.status ? raw.safer : null;
  const liveChanged = live ? applyLive(authorities, live, dockets[0] || null) : false;
  const carrierAuth = authorities.filter((a) => CARRIER_AUTH.test(a.type));
  const brokerAuth = authorities.filter((a) => BROKER_AUTH.test(a.type));

  // Authority history (newest first): when the carrier authority was first granted, and
  // the suspensions / reinstatements of the last year.
  const hist = authHistory.map((h) => ({ docket: h.docket_number, type: h.op_auth_type || '', status: h.op_auth_status || '',
    reason: h.reason || '', date: isoDate(h.status_change_date) })).filter((h) => h.date);
  hist.sort((a, b) => b.date.localeCompare(a.date));
  const carrierHist = hist.filter((h) => CARRIER_AUTH.test(h.type));
  const granted = carrierHist.filter((h) => /^(granted|reinstated)/i.test(h.reason) && h.status === 'Active').map((h) => h.date).sort();
  const firstGranted = carrierHist.filter((h) => /^granted/i.test(h.reason)).map((h) => h.date).sort()[0] || granted[0] || null;
  // Not the carrier's doing: the first record, publication, and FMCSA's own bookkeeping (on Jun 9,
  // 2026 it marked thousands of authorities "Inactive: Administrative status adjustment"; the
  // older records call it "Administrative inactivation").
  const recentChanges = carrierHist.filter((h) => daysSince(h.date, now) <= 365
    && !/^(initial status|published|administrative status adjustment|administrative inactivation)/i.test(h.reason)).slice(0, 8);

  // Insurance on file (each filing appears once per authority type: show it once).
  const policies = [];
  for (const r of insuranceRows) {
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
  for (const r of (raw.insHistory || []).concat(legacyEnding)) {
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
  const openOos = oosOrders.filter((o) => !o.rescinded);
  // FMCSA's suspension orders: a notice served on one date that takes effect on another
  // (usually 30 days on), either involuntary (FMCSA's, e.g. insurance that lapsed) or asked
  // for by the carrier. Newest first.
  const suspensionOrders = (raw.orders || []).map((o) => {
    const type = o.order1_type_desc || '';
    return { date: isoDate(o.order1_serve_date), effective: isoDate(o.order1_effective_date), type, docket: o.docket_number || null,
      voluntary: /voluntary/i.test(type) && !/involuntary/i.test(type) };
  }).filter((o) => o.date).sort((a, b) => b.date.localeCompare(a.date));

  const inspections = inspectionTotals(raw.inspections);
  if (inspections && national) {
    inspections.vehicle.national = national.vehicle;
    inspections.driver.national = national.driver;
  }
  const legalName = (c && c.legal_name) || (auth[0] && auth[0].legal_name) || null;
  const report = {
    v: REPORT_VERSION,
    dot: raw.dot,
    dockets,
    found: !!(c || authorities.length),
    name: legalName ? titleCase(legalName, true) : null,
    dba: c && c.dba_name ? titleCase(c.dba_name, true) : null,
    address: c ? [titleCase(c.phy_street), [titleCase(c.phy_city), c.phy_state].filter(Boolean).join(', '), c.phy_zip].filter(Boolean).join(' · ') : null,
    phone: phone((c && c.phone) || (auth[0] && auth[0].bus_telno)),
    email: c && c.email_address ? String(c.email_address).toLowerCase() : null,
    // As FMCSA's SAFER shows it: "Out of service" while an out-of-service order is in effect,
    // whatever the registration says.
    usdotStatus: c ? ((openOos.length || (live && live.status === 'out-of-service')) && c.status_code === 'A' ? 'Out of service'
      : ({ A: 'Active', I: 'Inactive', P: 'Pending' }[c.status_code] || c.status_code || null)) : null,
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
      // What FMCSA's website showed ('authorized', 'not-authorized', 'out-of-service'), or null if
      // it didn't answer; and whether that changed what the published data said
      live: live ? live.status : null,
      liveChanged,
      firstGranted,
      recentChanges,
    },
    // cancelledSince: the liability filing the older records had on file was cancelled since May
    // 2026, and nothing newer is published ({ date, insurer } of the latest such cancellation)
    insurance: { required: required || null, onFile, policies, ending,
      cancelledSince: Object.values(cancelledSince).sort((a, b) => b.date.localeCompare(a.date))[0] || null },
    oosOrders,
    suspensionOrders,
    inspections,
    crashes: crashTotals(raw.crashes),
    missing: missingParts(raw, legacyDockets),
    // Dockets whose authority, history and insurance came from FMCSA's older licensing records
    // (nothing about them has changed since FMCSA's May 2026 switch to Motus)
    legacyDockets,
    // Neither the registration nor any authority could be read: FMCSA's data isn't
    // answering, which isn't the same as "no such carrier".
    unavailable: raw.census == null && !auth.length,
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
  // FMCSA's website changed what the published data said: say so, it's the reason
  const liveWord = { 'not-authorized': 'not authorized', 'out-of-service': 'out of service' }[A.live];
  if (!A.activeCarrier && !gone('authority')) {
    const last = A.recentChanges.find((h) => h.status === 'Inactive');
    // A broker isn't a reason not to book in itself: say so, and only something severe below says "don't book"
    if (A.activeBroker) add('warn', 'broker_only', 'Licensed as a broker, not a carrier: they arrange freight but have no active carrier authority, so they can’t haul the load on their own trucks.');
    else if (A.pendingCarrier) add('stop', 'authority_pending', 'Their operating authority isn’t active yet (still pending with FMCSA).');
    else if (A.liveChanged && liveWord) add('stop', 'authority_inactive', `No active operating authority: FMCSA’s website shows them as ${liveWord}.`);
    else if (A.carrier.length || last) add('stop', 'authority_inactive', `No active operating authority${last ? `: ${last.reason.replace(/\s*\(.*?\)\s*$/, '')} (${fmtDate(last.date)})` : ''}.`);
    else add('stop', 'no_authority', 'No for-hire operating authority on file: they can’t haul for hire across state lines.');
  }
  // FMCSA's website didn't answer, and their authority comes from records that haven't changed
  // since May 2026: it can't be confirmed for today
  if (A.activeCarrier && !A.live && (r.legacyDockets || []).length) {
    add('warn', 'authority_unconfirmed', 'Their authority couldn’t be confirmed on FMCSA’s website just now, and FMCSA’s published records for them haven’t changed since May 2026. Check their FMCSA record before booking.');
  }
  // (Out of service: the out-of-service order below says so, with its reason.)
  if (r.usdotStatus && r.usdotStatus !== 'Active' && r.usdotStatus !== 'Out of service') add('stop', 'usdot_inactive', `Their USDOT number is ${r.usdotStatus.toLowerCase()}.`);
  const openOos = r.oosOrders.filter((o) => !o.rescinded);
  for (const o of openOos.slice(0, 2)) add('stop', 'oos_order', `Out-of-service order since ${fmtDate(o.date)}: ${o.reason}.`);
  if (A.live === 'out-of-service' && !openOos.length) add('stop', 'oos_live', 'FMCSA’s website shows them as out of service.');
  if (r.safetyRating === 'Unsatisfactory') add('stop', 'safety_unsatisfactory', `Unsatisfactory safety rating (${fmtDate(r.safetyRatingDate)}).`);
  // Insurance
  const since = r.insurance.cancelledSince;
  if (A.activeCarrier && !gone('authority') && since && !(r.insurance.required && r.insurance.onFile >= r.insurance.required)) {
    // The liability on file in the older records was cancelled since May 2026 and nothing newer is
    // published, but their authority is still active: newer coverage isn't in the data yet
    add('warn', 'insurance_unpublished', `FMCSA’s published records don’t show their current liability insurance: the last policy on file${since.insurer ? ` (${titleCase(since.insurer)})` : ''} was cancelled on ${fmtDate(since.date)}.`
      + `${A.live === 'authorized' ? ' Their authority is still active on FMCSA’s website, so they likely have newer coverage.' : ''} Get their certificate of insurance before booking.`);
  } else if (A.activeCarrier && !gone('authority') && r.insurance.required && r.insurance.onFile < r.insurance.required) {
    add('stop', 'insurance_short', r.insurance.onFile
      ? `Liability insurance on file is ${usd(r.insurance.onFile)}, below the ${usd(r.insurance.required)} required.`
      : `No liability insurance on file (${usd(r.insurance.required)} required).`);
  }
  // Active, but no liability insurance on file and no minimum listed for the authority (some
  // Mexico-domiciled authorities): nothing on file to rely on.
  const liabilityFiled = (r.insurance.policies || []).some((p) => /^Liability/.test(p.kind));
  if (A.activeCarrier && !gone('authority') && !gone('insurance') && !since && !r.insurance.required && !(r.insurance.onFile > 0) && !liabilityFiled) {
    add('warn', 'insurance_none', 'No liability insurance on file with FMCSA, and no minimum is listed for their authority. Get their certificate of insurance before booking.');
  }
  // A suspension notice that hasn't taken effect yet
  const today = new Date(now).toISOString().slice(0, 10);
  for (const o of (r.suspensionOrders || []).filter((x) => x.effective && x.effective >= today).slice(0, 2)) {
    add('warn', 'suspension_notice', o.voluntary
      ? `They’ve asked FMCSA to suspend their operating authority on ${fmtDate(o.effective)}.`
      : `FMCSA served notice on ${fmtDate(o.date)} that their operating authority will be suspended on ${fmtDate(o.effective)} unless they resolve it.`);
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
    const why = s.reason.replace(/\s*\(.*?\)\s*$/, '').trim();
    // Say what happened: "revoked" for a revocation, otherwise "suspended"
    const what = /revo[ck]/i.test(why) ? 'revoked' : 'suspended';
    const detail = why && why.toLowerCase() !== what ? `: ${why}` : '';
    add('warn', 'recent_suspension', `Authority was ${what} in the last year (${fmtDate(s.date)}${detail}) and is active again.`);
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
  if (i && i.total === 0 && (authAge == null || authAge > 365) && !(A.activeBroker && !A.activeCarrier)) add('info', 'no_inspections', 'No roadside inspections in the last two years.');
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
  for (const d of list) out[d] = { carrierStatus: [], brokerStatus: [], onFile: 0, required: 0, cancels: [], oos: [], suspensions: [], usdotStatus: null, safetyRating: null };
  const today = ymd(new Date(Date.now()));
  for (let i = 0; i < list.length; i += 100) {
    const batch = list.slice(i, i + 100);
    const inList = batch.map((d) => `'${d}'`).join(',');
    let auth, ins, oos, census, orders, legacy;
    try {
      [auth, ins, oos, census, orders, legacy] = await Promise.all([
        twice(DS.authority, { $select: 'usdot_number, docket_number, op_auth_type, op_auth_status, min_cov_amount, bipd_file', $where: `usdot_number in (${inList})`, $limit: 5000 }, opt),
        twice(DS.insHistory, { $select: 'usdot_number, ins_type_code, ins_type_desc, insurance_company_name, policy_no, cancl_effective_date, filing_status_reason',
          $where: `usdot_number in (${inList}) AND cancl_effective_date >= '${today}'`, $limit: 5000 }, opt),
        twice(DS.oos, { $select: 'dot_number, oos_date, oos_reason, rescind_date', $where: `dot_number in (${inList}) AND rescind_date IS NULL`, $limit: 5000 }, opt),
        twice(DS.census, { $select: 'dot_number, status_code, safety_rating', $where: `dot_number in (${inList})`, $limit: 5000 }, opt),
        twice(DS.orders, { $select: 'usdot_number, order1_serve_date, order1_type_desc, order1_effective_date',
          $where: `usdot_number in (${inList}) AND order1_effective_date >= '${today}'`, $limit: 5000 }, opt),
        // The older licensing records, for the dockets Motus doesn't have (see the top)
        twice(DS.legacyCarrier, { $select: 'dot_number, docket_number, common_stat, contract_stat, broker_stat, common_app_pend, contract_app_pend, broker_app_pend, '
          + 'property_chk, hhg_chk, passenger_chk, enterprise_chk, min_cov_amount, bipd_file, bond_req, bond_file',
          $where: `dot_number in (${batch.map((d) => `'${pad8(d)}'`).join(',')})`, $limit: 5000 }, opt),
      ]);
    } catch (e) {
      console.warn(`[fmcsa] monitor batch of ${batch.length} not checked: ${e.message}`);
      for (const d of batch) delete out[d];
      continue;
    }
    // Each docket from Motus when Motus has it, else from the older records
    const inMotus = new Set(auth.map((r) => `${digits(r.usdot_number)}|${r.docket_number}`));
    for (const r of legacy) {
      const d = digits(String(Number(r.dot_number)));
      if (d && out[d] && docketSafe(r.docket_number) && !inMotus.has(`${d}|${r.docket_number}`)) auth.push(...legacyAuthorityRows(r).map((x) => Object.assign(x, { usdot_number: d })));
    }
    for (const r of auth) {
      const f = out[digits(r.usdot_number)];
      if (f && BROKER_AUTH.test(r.op_auth_type || '')) { f.brokerStatus.push(r.op_auth_status); continue; }
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
    for (const r of orders) {
      const f = out[digits(r.usdot_number)];
      const type = r.order1_type_desc || '';
      const s = { served: isoDate(r.order1_serve_date), effective: isoDate(r.order1_effective_date), voluntary: /voluntary/i.test(type) && !/involuntary/i.test(type) };
      if (f && s.effective && !f.suspensions.some((x) => x.served === s.served && x.effective === s.effective)) f.suspensions.push(s);
    }
  }
  // FMCSA's website for each carrier, four at a time while there's time: the authority status it
  // shows today wins over the published data (see the top). One it couldn't ask keeps the data's.
  const asked = Object.keys(out);
  const deadline = opt.deadline || Date.now() + 20000;
  let next = 0;
  const worker = async () => {
    while (next < asked.length && deadline - Date.now() > 1500) {
      const d = asked[next++];
      try { const s = await saferStatus(d, Object.assign({}, opt, { deadline })); if (s) out[d].live = s; } catch (e) { /* not asked: keeps the data's */ }
    }
  };
  await Promise.all(Array.from({ length: Math.min(4, asked.length) }, worker));
  for (const d of Object.keys(out)) {
    const f = out[d];
    if (f.live) {
      const listed = f.live.status === 'authorized' ? f.live.authorized || [] : [];
      const lose = (list) => list.map((s) => (s === 'Active' ? 'Inactive' : s));
      f.carrierStatus = listed.some((t) => CARRIER_AUTH.test(t)) ? ['Active'] : lose(f.carrierStatus);
      f.brokerStatus = listed.some((t) => BROKER_AUTH.test(t)) ? ['Active'] : lose(f.brokerStatus);
      delete f.live;
    }
    f.authority = f.carrierStatus.includes('Active') ? 'Active' : f.carrierStatus.includes('Pending') ? 'Pending' : f.carrierStatus.length ? 'Inactive' : 'None';
    f.insuranceShort = f.authority === 'Active' && f.required > 0 && f.onFile < f.required;
    f.noInsurance = f.authority === 'Active' && !(f.required > 0) && !(f.onFile > 0);
    f.suspensions.sort((a, b) => String(a.effective).localeCompare(String(b.effective)) || String(a.served).localeCompare(String(b.served)));
    f.cancels.sort((a, b) => a.cancels.localeCompare(b.cancels) || a.policy.localeCompare(b.policy));
    f.oos.sort((a, b) => String(a.date).localeCompare(String(b.date)) || a.reason.localeCompare(b.reason));
    // A broker's authority, recorded only while it's active (carriers' saved facts keep their shape)
    if (f.brokerStatus.includes('Active')) f.broker = 'Active';
    delete f.carrierStatus;
    delete f.brokerStatus;
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
  if (prev.broker === 'Active' && prev.authority !== 'Active' && cur.broker !== 'Active' && cur.authority !== 'Active') {
    alerts.push({ kind: 'authority', text: `${who}: broker authority is no longer active. Don’t book with them until it’s active again.` });
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
  if (prev.onFile > 0 && cur.noInsurance) alerts.push({ kind: 'insurance', text: `${who}: no liability insurance on file anymore.` });
  for (const s of cur.suspensions || []) {
    if (!(prev.suspensions || []).some((p) => p.served === s.served && p.effective === s.effective)) {
      alerts.push({ kind: 'authority', text: s.voluntary
        ? `${who}: asked FMCSA to suspend their operating authority on ${fmtDate(s.effective)}.`
        : `${who}: FMCSA served notice that their operating authority will be suspended on ${fmtDate(s.effective)} unless they resolve it.` });
    }
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
  // A broker (active broker authority, no active carrier authority): "check before booking" for that alone
  const brokerOnly = f.authority !== 'Active' && f.broker === 'Active';
  if ((f.authority !== 'Active' && !brokerOnly) || f.insuranceShort || (f.oos && f.oos.length) || (f.usdotStatus && f.usdotStatus !== 'Active') || f.safetyRating === 'Unsatisfactory') return 'stop';
  const age = (iso) => (iso ? Math.floor((now - Date.parse(iso + 'T00:00:00Z')) / DAY) : null);
  const authAge = age(f.granted), dotAge = age(f.usdotAdded);
  const isNew = (authAge != null && authAge < NEW_AUTHORITY_DAYS) || (dotAge != null && dotAge < NEW_USDOT_DAYS);
  const pendingSuspension = (f.suspensions || []).some((s) => s.effective && s.effective >= new Date(now).toISOString().slice(0, 10));
  if (brokerOnly || (f.cancels && f.cancels.length) || f.safetyRating === 'Conditional' || isNew || f.noInsurance || pendingSuspension) return 'warn';
  return 'ok';
}

module.exports = { REPORT_VERSION, DS, PARTS, parseQuery, soql, resolveDot, fetchCarrier, nationalAverages, buildReport, assess, monitorFacts, diffFacts, factsVerdict, isoDate, saferStatus, parseSafer,
  _internal: { inspectionTotals, crashTotals, titleCase, legacyAuthorityRows, legacyHistoryRows, legacyOnlyDockets, applyLive, resetToken: () => { tokenRefused = false; said.clear(); } } };
