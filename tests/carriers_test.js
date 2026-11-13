// tests/carriers_test.js — Carrier check: reading FMCSA's open data into a report with the
// warning signs (netlify/lib/fmcsa.js), the carrier-check function (plans, daily limits,
// cache, saved carriers) and the carrier-monitor job (alerts and emails). FMCSA's data,
// Supabase and Resend are fakes: nothing leaves this machine.
// Run from the repository root:  node tests/carriers_test.js
const path = require('path');
const fn = (name) => path.join(__dirname, '..', 'netlify/functions', name);
let passed = 0, failed = 0;
const ok = (cond, label, detail) => {
  if (cond) { passed++; console.log(`PASS  ${label}`); }
  else { failed++; console.log(`FAIL  ${label}${detail ? '  — ' + detail : ''}`); }
};
process.env.SUPABASE_SERVICE_KEY = 'svc';
process.env.RESEND_API_KEY = 're_test';
delete process.env.SOCRATA_APP_TOKEN;

const NOW = Date.parse('2026-11-13T15:00:00Z');
const realNow = Date.now;
Date.now = () => NOW;
const ymdFrom = (days) => { const d = new Date(NOW + days * 86400000); return d.toISOString().slice(0, 10).replace(/-/g, ''); };

// ── FMCSA open-data fixtures (as data.transportation.gov answers) ──────────
const PROPERTY = 'Motor Carrier of Property (Except Household Goods)';
function carrier(dot, o = {}) {
  const d = String(dot), mc = o.mc || 'MC' + d.slice(0, 6);
  return {
    census: o.census === null ? [] : [Object.assign({ dot_number: d, legal_name: 'CLEAN HAUL LLC', dba_name: '', phy_street: '10 MAIN ST', phy_city: 'LANCASTER', phy_state: 'PA', phy_zip: '17601',
      phone: '7175551234', email_address: 'OPS@CLEANHAUL.COM', status_code: 'A', add_date: '20180105', mcs150_date: '20260301', power_units: '12', total_drivers: '14',
      carrier_operation: 'A', classdef: 'AUTHORIZED FOR HIRE', safety_rating: 'S', safety_rating_date: '20200110', docket1prefix: 'MC', docket1: mc.slice(2) }, o.censusRow || {})],
    authority: o.authority || [{ docket_number: mc, usdot_number: d, op_auth_type: PROPERTY, op_auth_status: 'Active', min_cov_amount: '750000.00', bipd_file: '1000000.00',
      cargo_req: 'N', cargo_file: 'N', bond_req: 'N', bond_file: 'N', legal_name: 'CLEAN HAUL LLC', bus_telno: '7175551234' }],
    authHistory: o.authHistory || [{ docket_number: mc, usdot_number: d, op_auth_type: PROPERTY, op_auth_status: 'Active', reason: 'Granted', status_change_date: '20180301' }],
    insurance: o.insurance || [
      { ins_form_code: 'BMC-91X', ins_type_code: '1', ins_class_code: 'P', max_cov_amount: '1000000.00', underl_lim_amount: '0.00', effective_date: '20250101', insurance_company_name: 'Good Mutual', policy_no: 'P-1' },
      { ins_form_code: 'BMC-91X', ins_type_code: '1', ins_class_code: 'P', max_cov_amount: '1000000.00', underl_lim_amount: '0.00', effective_date: '20250101', insurance_company_name: 'Good Mutual', policy_no: 'P-1' }],
    insHistory: o.insHistory || [{ ins_type_code: '1', ins_type_desc: 'BIPD', filing_status_reason: 'TERM/REPL', cancl_effective_date: ymdFrom(20), policy_no: 'OLD-1', insurance_company_name: 'Old Mutual' }],
    orders: o.orders || [],
    oos: o.oos || [],
    inspections: o.inspections || [
      { insp_level_id: '1', v_oos: false, d_oos: false, n: '20' }, { insp_level_id: '1', v_oos: true, d_oos: false, n: '4' },
      { insp_level_id: '3', v_oos: false, d_oos: true, n: '1' }, { insp_level_id: '3', v_oos: false, d_oos: false, n: '10' }],
    crashes: o.crashes || [{ fatal: false, inj: false, tow_away: 'true', n: '2' }],
  };
}
const NATIONAL = { vehicle: 0.226, driver: 0.061 };
const raw = (dot, o) => Object.assign({ dot: String(dot) }, carrier(dot, o));

(async () => {
  const F = require('../netlify/lib/fmcsa.js');

  // ═══ Reading what people type ═══════════════════════════════════════════
  const pq = (s, k) => JSON.stringify(F.parseQuery(s, k));
  ok(pq('MC 135797') === '{"docket":"MC135797"}' && pq('mc-0135797') === '{"docket":"MC135797"}' && pq('MC#135797') === '{"docket":"MC135797"}', 'MC numbers in any spelling, leading zeros dropped');
  ok(pq('DOT 80806') === '{"dot":"80806"}' && pq('USDOT#80806') === '{"dot":"80806"}' && pq('usdot: 0080806') === '{"dot":"80806"}', 'USDOT numbers');
  ok(pq('135797') === '{"docket":"MC135797"}' && pq('80806', 'dot') === '{"dot":"80806"}', 'plain digits: MC by default, USDOT when chosen');
  ok(pq('MX 12345') === '{"docket":"MX12345"}' && pq('FF 51075') === '{"docket":"FF51075"}', 'MX and FF dockets');
  ok(F.parseQuery('hello') === null && F.parseQuery('MC 123456789') === null && F.parseQuery('') === null && F.parseQuery('MC 0') === null && F.parseQuery("1'; drop") === null,
     'anything else is refused (nothing odd ever reaches a query)');

  // ═══ The report ══════════════════════════════════════════════════════════
  let r = F.buildReport(raw(1111111), { national: NATIONAL, now: NOW });
  ok(r.found && r.verdict === 'ok' && r.flags.length === 0, 'a clean carrier: no problems found', JSON.stringify(r.flags));
  ok(r.name === 'Clean Haul LLC' && r.dockets.join() === 'MC111111' && r.phone === '(717) 555-1234' && r.email === 'ops@cleanhaul.com' && r.address === '10 Main St · Lancaster, PA · 17601',
     'names, numbers and contact details, tidied up', `${r.name} ${r.phone} ${r.address}`);
  ok(r.usdotStatus === 'Active' && r.usdotAdded === '2018-01-05' && r.mcs150 === '2026-03-01' && r.powerUnits === 12 && r.drivers === 14 && r.safetyRating === 'Satisfactory' && r.operation === 'Interstate',
     'registration: USDOT status and dates, fleet, safety rating');
  ok(r.authority.activeCarrier && r.authority.firstGranted === '2018-03-01' && r.insurance.required === 750000 && r.insurance.onFile === 1000000,
     'authority active since 2018; $1,000,000 liability on file, $750,000 required');
  ok(r.insurance.policies.length === 1 && r.insurance.policies[0].insurer === 'Good Mutual' && r.insurance.ending.length === 0,
     'an insurance filing listed once; a "replaced" filing ending isn’t a cancellation');
  ok(r.inspections.vehicle.n === 24 && r.inspections.vehicle.oos === 4 && r.inspections.driver.n === 35 && r.inspections.driver.oos === 1 && r.inspections.vehicle.national === 0.226,
     'out-of-service rates by FMCSA’s inspection levels (vehicle I/II/V/VI, driver I/II/III/VI), with the U.S. average');
  ok(r.crashes.total === 2 && r.crashes.tow === 2 && r.crashes.fatal === 0, 'crashes counted by severity');

  const flag = (rep, code) => rep.flags.find((f) => f.code === code);
  r = F.buildReport(raw(2222222, { authHistory: [{ op_auth_type: PROPERTY, op_auth_status: 'Active', reason: 'Granted', status_change_date: ymdFrom(-28) }], censusRow: { add_date: ymdFrom(-45), mcs150_date: ymdFrom(-45) } }), { national: NATIONAL, now: NOW });
  ok(r.verdict === 'warn' && flag(r, 'new_authority') && /granted 28 days ago/.test(flag(r, 'new_authority').text) && /fraud risk/.test(flag(r, 'new_authority').text),
     'authority granted 28 days ago: check before booking (new carriers are a fraud risk)', JSON.stringify(r.flags));
  r = F.buildReport(raw(2222223, { authHistory: [{ op_auth_type: PROPERTY, op_auth_status: 'Active', reason: 'Granted', status_change_date: '20180301' }], censusRow: { add_date: ymdFrom(-60) } }), { national: NATIONAL, now: NOW });
  ok(flag(r, 'new_usdot') && /registered 60 days ago/.test(flag(r, 'new_usdot').text), 'a USDOT number registered 60 days ago: flagged too');

  r = F.buildReport(raw(3333333, { authority: [{ docket_number: 'MC333333', usdot_number: '3333333', op_auth_type: 'Broker of Property (Except Household Goods)', op_auth_status: 'Active', min_cov_amount: '0', bipd_file: '0', bond_req: 'Y', bond_file: 'Y' }], authHistory: [] }), { national: NATIONAL, now: NOW });
  ok(r.verdict === 'stop' && flag(r, 'broker_only') && /broker only/i.test(flag(r, 'broker_only').text), 'licensed as a broker only: don’t book (they can’t haul it themselves)');
  r = F.buildReport(raw(3333334, { authority: [], authHistory: [] }), { national: NATIONAL, now: NOW });
  ok(r.verdict === 'stop' && flag(r, 'no_authority'), 'no for-hire authority at all: don’t book');
  r = F.buildReport(raw(3333335, { authority: [{ docket_number: 'MC33', usdot_number: '3333335', op_auth_type: PROPERTY, op_auth_status: 'Inactive', min_cov_amount: '750000', bipd_file: '0' }],
    authHistory: [{ op_auth_type: PROPERTY, op_auth_status: 'Inactive', reason: 'Involuntary Suspension - insurance cancellation effective; no active insurance meeting minimum coverage on file', status_change_date: ymdFrom(-10) },
      { op_auth_type: PROPERTY, op_auth_status: 'Active', reason: 'Granted', status_change_date: '20200101' }] }), { national: NATIONAL, now: NOW });
  ok(r.verdict === 'stop' && /No active operating authority: Involuntary Suspension - insurance cancellation effective/.test(flag(r, 'authority_inactive').text),
     'authority suspended 10 days ago: don’t book, with FMCSA’s reason', flag(r, 'authority_inactive') && flag(r, 'authority_inactive').text);
  ok(r.insurance.required === 750000 && r.insurance.onFile === 0 && !flag(r, 'insurance_short'),
     '…the $750,000 it required still shown beside the $0 on file (one stop reason, not two)', JSON.stringify(r.insurance));
  r = F.buildReport(raw(3333336, { authority: [{ docket_number: 'MC36', usdot_number: '3333336', op_auth_type: PROPERTY, op_auth_status: 'Pending', min_cov_amount: '750000', bipd_file: '0' }], authHistory: [] }), { national: NATIONAL, now: NOW });
  ok(r.verdict === 'stop' && flag(r, 'authority_pending'), 'authority still pending: don’t book');

  r = F.buildReport(raw(4444444, { oos: [{ oos_date: '2026-11-10', oos_reason: 'Unsatisfactory = Unfit', status: 'ACTIVE' }, { oos_date: '2023-01-02', oos_reason: 'Imminent Hazard', rescind_date: '2023-02-01' }] }), { national: NATIONAL, now: NOW });
  ok(r.verdict === 'stop' && r.flags.filter((f) => f.code === 'oos_order').length === 1 && /since Nov 10, 2026: Unsatisfactory = Unfit/.test(flag(r, 'oos_order').text),
     'an out-of-service order in effect: don’t book (a lifted one isn’t flagged)');
  r = F.buildReport(raw(4444445, { authority: [{ docket_number: 'MC45', usdot_number: '4444445', op_auth_type: PROPERTY, op_auth_status: 'Active', min_cov_amount: '750000', bipd_file: '300000' }] }), { national: NATIONAL, now: NOW });
  ok(r.verdict === 'stop' && /\$300,000, below the \$750,000 required/.test(flag(r, 'insurance_short').text), 'liability on file below what’s required: don’t book');
  r = F.buildReport(raw(4444446, { insHistory: [{ ins_type_code: '1', ins_type_desc: 'BIPD', filing_status_reason: 'CANCEL', cancl_effective_date: ymdFrom(20), policy_no: 'P-1', insurance_company_name: 'Good Mutual' }] }), { national: NATIONAL, now: NOW });
  ok(r.verdict === 'warn' && /^Liability insurance with Good Mutual is being cancelled on Dec 3, 2026\. Unless they file new coverage, their authority will be suspended\.$/.test(flag(r, 'insurance_cancelling').text),
     'liability being cancelled in 20 days: check before booking', flag(r, 'insurance_cancelling') && flag(r, 'insurance_cancelling').text);
  r = F.buildReport(raw(4444447, { censusRow: { status_code: 'I' } }), { national: NATIONAL, now: NOW });
  ok(r.verdict === 'stop' && flag(r, 'usdot_inactive'), 'an inactive USDOT number: don’t book');
  r = F.buildReport(raw(4444448, { censusRow: { safety_rating: 'U' } }), { national: NATIONAL, now: NOW });
  ok(r.verdict === 'stop' && flag(r, 'safety_unsatisfactory'), 'an unsatisfactory safety rating: don’t book');
  r = F.buildReport(raw(4444449, { censusRow: { safety_rating: 'C' } }), { national: NATIONAL, now: NOW });
  ok(r.verdict === 'warn' && flag(r, 'safety_conditional'), 'a conditional safety rating: check before booking');
  r = F.buildReport(raw(5555555, { authHistory: [{ op_auth_type: PROPERTY, op_auth_status: 'Active', reason: 'Reinstated - insurance coverage restored', status_change_date: ymdFrom(-40) },
    { op_auth_type: PROPERTY, op_auth_status: 'Inactive', reason: 'Involuntary Suspension', status_change_date: ymdFrom(-60) },
    { op_auth_type: PROPERTY, op_auth_status: 'Active', reason: 'Granted', status_change_date: '20190101' }] }), { national: NATIONAL, now: NOW });
  ok(r.verdict === 'warn' && /suspended in the last year/.test(flag(r, 'recent_suspension').text) && r.authority.recentChanges.length === 2,
     'suspended and reinstated this year: check before booking');
  r = F.buildReport(raw(5555556, { inspections: [{ insp_level_id: '1', v_oos: true, d_oos: true, n: '6' }, { insp_level_id: '1', v_oos: false, d_oos: false, n: '4' }] }), { national: NATIONAL, now: NOW });
  ok(flag(r, 'vehicle_oos_high') && /60% of inspections \(U\.S\. average 23%\)/.test(flag(r, 'vehicle_oos_high').text) && flag(r, 'driver_oos_high'),
     'trucks and drivers put out of service far more than the U.S. average: flagged', JSON.stringify(r.flags.map((f) => f.text)));
  r = F.buildReport(raw(5555557, { inspections: [{ insp_level_id: '1', v_oos: true, d_oos: true, n: '2' }] }), { national: NATIONAL, now: NOW });
  ok(!flag(r, 'vehicle_oos_high'), 'too few inspections to judge: not flagged');
  r = F.buildReport(raw(5555558, { censusRow: { mcs150_date: '20231001' } }), { national: NATIONAL, now: NOW });
  ok(r.verdict === 'warn' && flag(r, 'mcs150_old'), 'registration not updated in over two years: check');
  r = F.buildReport(raw(5555559, { authority: [{ docket_number: 'MC59', usdot_number: '5555559', op_auth_type: PROPERTY, op_auth_status: 'Active', min_cov_amount: '750000', bipd_file: '1000000' },
    { docket_number: 'MC59', usdot_number: '5555559', op_auth_type: 'Broker of Property (Except Household Goods)', op_auth_status: 'Active', min_cov_amount: '0', bipd_file: '1000000' }] }), { national: NATIONAL, now: NOW });
  ok(r.verdict === 'ok' && flag(r, 'also_broker') && flag(r, 'also_broker').level === 'info', 'also a broker: a note, not a warning');
  r = F.buildReport({ dot: '6666666', census: [], authority: [], authHistory: [], insurance: [], insHistory: [], orders: [], oos: [], inspections: [], crashes: [] }, { now: NOW });
  ok(!r.found && r.verdict === 'stop' && flag(r, 'not_found'), 'nothing on file: not found');
  r = F.buildReport(Object.assign(raw(7777777), { inspections: null, crashes: null }), { national: NATIONAL, now: NOW });
  ok(r.missing.join() === 'inspections,crashes' && r.inspections === null && r.found, 'a part that didn’t load is named, the rest still shows');
  ok(r.verdict === 'warn' && flag(r, 'incomplete').text === 'Part of FMCSA’s records didn’t load (inspections and crashes), so this check isn’t complete. Check again before booking.',
     '…and the check is never “No problems found” then', JSON.stringify(r.flags));
  r = F.buildReport(Object.assign(raw(7777778), { oos: null }), { national: NATIONAL, now: NOW });
  ok(r.verdict === 'warn' && r.flags.length === 1 && /didn’t load \(out-of-service orders\)/.test(flag(r, 'incomplete').text),
     'out-of-service orders didn’t load: “check before booking”, even for a clean carrier (an order could be hiding there)');
  r = F.buildReport(Object.assign(raw(7777779), { insurance: null, insHistory: null, authHistory: null }), { national: NATIONAL, now: NOW });
  ok(/\(authority history, insurance filings and insurance cancellations\)/.test(flag(r, 'incomplete').text), 'several parts: listed in plain words', flag(r, 'incomplete').text);
  r = F.buildReport(Object.assign(raw(7777780), { census: null, authority: null }), { national: NATIONAL, now: NOW });
  ok(r.unavailable === true, 'neither the registration nor the authority loaded: FMCSA isn’t answering (not “no such carrier”)');
  r = F.buildReport(Object.assign(raw(7777781), { census: null }), { national: NATIONAL, now: NOW });
  ok(!r.unavailable && r.found && r.verdict === 'warn' && r.name === 'Clean Haul LLC', 'only the registration missing: the report, marked incomplete');
  r = F.buildReport(Object.assign(raw(7777783), { authority: null }), { national: NATIONAL, now: NOW });
  ok(r.verdict === 'warn' && !flag(r, 'no_authority') && !flag(r, 'insurance_short') && flag(r, 'incomplete') && r.found,
     'the authority part didn’t load: unknown isn’t “no authority, don’t book”', JSON.stringify(r.flags.map((f) => f.code)));
  r = F.buildReport(Object.assign(raw(7777784, { oos: [{ oos_date: '2026-11-10', oos_reason: 'Imminent Hazard' }] }), { inspections: null }), { national: NATIONAL, now: NOW });
  ok(r.verdict === 'stop' && flag(r, 'oos_order') && flag(r, 'incomplete'), 'what did load still counts: an out-of-service order is “don’t book” even with inspections missing');
  r = F.buildReport(raw(7777782), { national: NATIONAL, now: NOW });
  ok(r.unavailable === false && r.missing.length === 0 && r.verdict === 'ok', 'everything loaded: complete');

  // ═══ The open-data queries ═══════════════════════════════════════════════
  const calls = [];
  let answer = () => [];
  const fakeFetch = async (url, opts = {}) => {
    calls.push({ url, opts });
    const body = answer(url, opts);
    return { ok: true, status: 200, json: async () => body };
  };
  const ds = (url) => url.match(/resource\/([a-z0-9-]+)\.json/)[1];
  const param = (url, k) => new URL(url).searchParams.get(k);
  answer = (url) => (ds(url) === F.DS.authority ? [{ usdot_number: '80806' }] : []);
  ok((await F.resolveDot({ docket: 'MC135797' }, { fetchImpl: fakeFetch })) === '80806' && param(calls[0].url, '$where') === "docket_number='MC135797'",
     'an MC number is looked up in the authority records');
  calls.length = 0;
  answer = (url) => (ds(url) === F.DS.census ? [{ dot_number: '4587322' }] : []);
  ok((await F.resolveDot({ docket: 'MC87672135' }, { fetchImpl: fakeFetch })) === '4587322' && calls.length === 2 && /docket1='87672135'/.test(param(calls[1].url, '$where')),
     '…then in the census when there’s no authority record');
  calls.length = 0;
  process.env.SOCRATA_APP_TOKEN = 'app-token';
  answer = () => [];
  await F.fetchCarrier('80806', { fetchImpl: fakeFetch });
  ok(calls.length === 9 && calls.every((c) => c.opts.headers['X-App-Token'] === 'app-token') && new Set(calls.map((c) => ds(c.url))).size === 9,
     'a check asks nine datasets at once, with the app token when one is set');
  ok(calls.some((c) => ds(c.url) === F.DS.inspections && /count\(\*\)/.test(param(c.url, '$select')) && param(c.url, '$group')), 'inspections are totalled by FMCSA, not downloaded');
  delete process.env.SOCRATA_APP_TOKEN;
  calls.length = 0;
  answer = (url) => (/vehicle_oos_total/.test(param(url, '$select')) ? [{ oos: false, n: '774' }, { oos: true, n: '226' }] : [{ oos: false, n: '939' }, { oos: true, n: '61' }]);
  const nat = await F.nationalAverages({ fetchImpl: fakeFetch });
  ok(Math.abs(nat.vehicle - 0.226) < 1e-9 && Math.abs(nat.driver - 0.061) < 1e-9, 'national averages from the same inspections');
  let threw = false;
  try { await F.fetchCarrier("1' OR '1'='1", { fetchImpl: fakeFetch }); } catch (e) { threw = true; }
  ok(threw, 'only digits ever go into a query');
  const fail503 = { ok: false, status: 503, json: async () => ({}) };
  let failsLeft = { [F.DS.insurance]: 1 };
  const flaky = async (url, opts) => {
    calls.push({ url, opts });
    const d = ds(url);
    if (failsLeft[d] > 0) { failsLeft[d]--; return fail503; }
    return { ok: true, status: 200, json: async () => (d === F.DS.insurance ? [{ ins_type_code: '1' }] : []) };
  };
  calls.length = 0;
  let rawF = await F.fetchCarrier('80806', { fetchImpl: flaky });
  ok(calls.length === 10 && rawF.insurance && rawF.insurance.length === 1, 'a part that fails is asked again once (FMCSA’s data has slow spells)');
  calls.length = 0;
  failsLeft = { [F.DS.oos]: 5 };
  rawF = await F.fetchCarrier('80806', { fetchImpl: flaky });
  ok(rawF.oos === null && calls.length === 10 && Array.isArray(rawF.census), '…twice at most; then that part is reported missing');
  calls.length = 0;
  threw = false;
  try { await F.soql(F.DS.census, { $limit: 1 }, { fetchImpl: fakeFetch, deadline: NOW + 200 }); } catch (e) { threw = /out of time/.test(e.message); }
  ok(threw && calls.length === 0, 'out of time: no new request (a check has to finish inside the function’s limit)');
  let seenTimeout = null;
  await F.soql(F.DS.census, { $limit: 1 }, { fetchImpl: async (u, o) => { seenTimeout = o.signal; return { ok: true, status: 200, json: async () => [] }; }, deadline: NOW + 3000, timeoutMs: 5000 });
  ok(seenTimeout && !seenTimeout.aborted, 'a request gets what’s left of the budget');

  // ═══ Monitoring: facts, changes, verdicts ════════════════════════════════
  calls.length = 0;
  answer = (url) => {
    const d = ds(url);
    if (d === F.DS.authority) return [
      { usdot_number: '1', op_auth_type: PROPERTY, op_auth_status: 'Active', min_cov_amount: '750000', bipd_file: '1000000' },
      { usdot_number: '2', op_auth_type: PROPERTY, op_auth_status: 'Inactive', min_cov_amount: '750000', bipd_file: '0' },
      { usdot_number: '3', op_auth_type: PROPERTY, op_auth_status: 'Active', min_cov_amount: '750000', bipd_file: '500000' }];
    if (d === F.DS.insHistory) return [
      { usdot_number: '1', ins_type_code: '1', filing_status_reason: 'CANCEL', cancl_effective_date: ymdFrom(10), policy_no: 'P1', insurance_company_name: 'Good Mutual' },
      { usdot_number: '1', ins_type_code: '1', filing_status_reason: 'TERM/REPL', cancl_effective_date: ymdFrom(12), policy_no: 'P0' }];
    if (d === F.DS.oos) return [{ dot_number: '3', oos_date: '2026-11-12', oos_reason: 'Imminent Hazard' }];
    if (d === F.DS.census) return [{ dot_number: '1', status_code: 'A', safety_rating: 'S' }, { dot_number: '2', status_code: 'A' }, { dot_number: '3', status_code: 'A', safety_rating: 'C' }];
    return [];
  };
  const facts = await F.monitorFacts(['1', '2', '3', '3'], { fetchImpl: fakeFetch });
  ok(calls.length === 4 && calls.every((c) => /in \('1','2','3'\)/.test(param(c.url, '$where'))), 'one batch: four queries for all the carriers (each once)');
  ok(facts['1'].authority === 'Active' && facts['1'].cancels.length === 1 && facts['1'].cancels[0].cancels === '2026-11-23' && !facts['1'].insuranceShort,
     'carrier 1: active, a real cancellation in 10 days (the replaced filing is ignored)');
  ok(facts['2'].authority === 'Inactive' && facts['3'].insuranceShort && facts['3'].oos.length === 1 && facts['3'].safetyRating === 'Conditional', 'carriers 2 and 3: inactive; short on insurance with an out-of-service order');
  calls.length = 0;
  let batchFails = 1;
  const flakyBatch = async (url, opts) => {
    if (ds(url) === F.DS.authority && batchFails > 0) { batchFails--; calls.push({ url, failed: true }); return fail503; }
    return fakeFetch(url, opts);
  };
  let facts2 = await F.monitorFacts(['1', '2', '3'], { fetchImpl: flakyBatch, retryDelayMs: 0 });
  ok(calls.length === 5 && facts2['1'] && facts2['1'].authority === 'Active' && facts2['2'].authority === 'Inactive', 'a batch query that fails once is asked again');
  batchFails = 2;
  facts2 = await F.monitorFacts(['1', '2', '3'], { fetchImpl: flakyBatch, retryDelayMs: 0 });
  ok(Object.keys(facts2).length === 0, '…a batch FMCSA can’t answer twice: its carriers are left out, never reported as “authority gone”');
  const many = Array.from({ length: 150 }, (_, k) => String(k + 1));
  facts2 = await F.monitorFacts(many, { retryDelayMs: 0, fetchImpl: async (url, opts) => (ds(url) === F.DS.census && /'150'/.test(param(url, '$where')) ? fail503 : fakeFetch(url, opts)) });
  ok(Object.keys(facts2).length === 100 && facts2['100'] && !facts2['101'] && !facts2['150'], '…only that batch’s carriers: the other batch is checked');
  const isoAgo = (days) => new Date(NOW - days * 86400000).toISOString().slice(0, 10);
  const fine = { authority: 'Active', cancels: [], oos: [], usdotStatus: 'Active', safetyRating: null };
  ok(F.factsVerdict({}) === null && F.factsVerdict(null) === null, 'no facts yet (FMCSA didn’t answer when saved): “not checked yet”, never “don’t book”');
  ok(F.factsVerdict(Object.assign({}, fine, { granted: isoAgo(28) })) === 'warn' && F.factsVerdict(Object.assign({}, fine, { usdotAdded: isoAgo(60), granted: isoAgo(100) })) === 'warn'
     && F.factsVerdict(Object.assign({}, fine, { granted: isoAgo(100), usdotAdded: isoAgo(400) })) === 'ok', 'a new carrier is “check” on the saved list too, until it’s past 90 days (180 for the USDOT number)');
  ok(F.factsVerdict(facts['1']) === 'warn' && F.factsVerdict(facts['2']) === 'stop' && F.factsVerdict(facts['3']) === 'stop' && F.factsVerdict({ authority: 'Active', cancels: [], oos: [], usdotStatus: 'Active' }) === 'ok',
     'saved-list status from the facts');
  const before = { authority: 'Active', insuranceShort: false, cancels: [], oos: [], usdotStatus: 'Active', safetyRating: 'Satisfactory', onFile: 1000000, required: 750000 };
  let alerts = F.diffFacts(before, facts['1'], 'Clean Haul LLC');
  ok(alerts.length === 1 && alerts[0].kind === 'insurance_cancelling' && alerts[0].text === 'Clean Haul LLC: liability insurance with Good Mutual is being cancelled on Nov 23, 2026.',
     'a new cancellation → an alert in plain words', JSON.stringify(alerts));
  ok(F.diffFacts(facts['1'], facts['1'], 'Clean Haul LLC').length === 0, 'nothing new → no alert (each change is reported once)');
  alerts = F.diffFacts(before, facts['2'], 'Two LLC');
  ok(alerts.length === 1 && alerts[0].kind === 'authority' && /operating authority is now inactive\. Don’t tender them loads/.test(alerts[0].text), 'authority no longer active → alert');
  alerts = F.diffFacts(before, facts['3'], 'Three Inc');
  ok(alerts.map((a) => a.kind).join() === 'insurance,oos,safety', 'insurance below required, an out-of-service order and a worse safety rating → three alerts', JSON.stringify(alerts));
  ok(F.diffFacts(before, Object.assign({}, before, { authority: 'None' }), 'Gone LLC')[0].text === 'Gone LLC: no longer has operating authority on file. Don’t tender them loads until it’s active again.',
     'authority gone altogether: said plainly');

  // ═══ carrier-check.js ════════════════════════════════════════════════════
  const db = { lookups: [], cache: {}, meta: {}, saved: [], alerts: [], users: {}, accounts: {}, socrata: 0, nextId: 1 };
  const uuid = () => '00000000-0000-4000-8000-' + String(db.nextId++).padStart(12, '0');
  const FIX = { '80806': carrier(80806, { mc: 'MC135797' }), '4587322': carrier(4587322, { mc: 'MC87672135', authHistory: [{ op_auth_type: PROPERTY, op_auth_status: 'Active', reason: 'Granted', status_change_date: ymdFrom(-28) }] }) };
  const resp = (status, body, headers = {}) => ({ ok: status < 400, status, headers: { get: (k) => headers[k.toLowerCase()] || null },
    text: async () => (body === undefined ? '' : JSON.stringify(body)), json: async () => body });
  const q = (u) => new URL(u).searchParams;
  const eq = (u, k) => { const v = q(u).get(k); return v && v.startsWith('eq.') ? v.slice(3) : null; };
  const todayStart = new Date(new Date(NOW).toISOString().slice(0, 10) + 'T00:00:00Z').toISOString();
  global.fetch = async (url, opts = {}) => {
    url = String(url);
    const method = opts.method || 'GET';
    const body = opts.body ? JSON.parse(opts.body) : undefined;
    if (url.startsWith('https://data.transportation.gov/')) {
      db.socrata++;
      const d = ds(url);
      if (db.down && db.down.has(d)) return resp(503, { message: 'unavailable' });
      const where = q(url).get('$where') || '';
      if (d === F.DS.authority && /docket_number=/.test(where)) {
        const mc = where.match(/docket_number='([A-Z0-9]+)'/)[1];
        const hit = Object.entries(FIX).find(([, f]) => f.authority.some((a) => a.docket_number === mc));
        return resp(200, hit ? [{ usdot_number: hit[0] }] : []);
      }
      if (d === F.DS.census && /docket1/.test(where)) return resp(200, []);
      if (d === F.DS.inspections && !/dot_number/.test(where)) {
        return resp(200, /vehicle_oos_total/.test(q(url).get('$select')) ? [{ oos: false, n: '774' }, { oos: true, n: '226' }] : [{ oos: false, n: '939' }, { oos: true, n: '61' }]);
      }
      const inList = where.match(/in \(([^)]*)\)/);
      const dots = inList ? inList[1].split(',').map((x) => x.replace(/'/g, '')) : [(where.match(/(?:usdot_number|dot_number)='(\d+)'/) || [])[1]];
      const out = [];
      for (const dot of dots) {
        const f = FIX[dot];
        if (!f) continue;
        const key = Object.entries(F.DS).find(([, v]) => v === d)[0];
        for (const row of f[key] || []) out.push(Object.assign({ usdot_number: dot, dot_number: dot }, row));
      }
      return resp(200, out);
    }
    if (url.endsWith('/auth/v1/user')) {
      const tok = (opts.headers.Authorization || '').replace('Bearer ', '');
      return db.users[tok] ? resp(200, { id: db.users[tok] }) : resp(401, { msg: 'bad' });
    }
    if (url.endsWith('/rest/v1/rpc/effective_account')) {
      const a = db.accounts[body.p_uid];
      return resp(200, a);
    }
    if (url.includes('/rest/v1/carrier_lookups')) {
      const acct = eq(url, 'account_id');
      const list = db.lookups.filter((l) => l.account_id === acct && (!q(url).get('created_at') || l.created_at >= todayStart) && (!eq(url, 'dot_number') || l.dot_number === eq(url, 'dot_number')));
      if (method === 'HEAD') return resp(200, undefined, { 'content-range': `*/${list.length}` });
      if (method === 'POST') { db.lookups.push(Object.assign({ created_at: new Date(NOW).toISOString() }, body)); return resp(201); }
      return resp(200, list.slice(0, 1));
    }
    if (url.includes('/rest/v1/carrier_cache')) {
      if (method === 'POST') { db.cache[body.dot_number] = body; return resp(201); }
      const c = db.cache[eq(url, 'dot_number')];
      return resp(200, c ? [{ report: c.report, fetched_at: c.fetched_at }] : []);
    }
    if (url.includes('/rest/v1/carrier_meta')) {
      if (method === 'POST') { db.meta[body.key] = body; return resp(201); }
      const m = db.meta[eq(url, 'key')];
      return resp(200, m ? [{ value: m.value, updated_at: m.updated_at }] : []);
    }
    if (url.includes('/rest/v1/saved_carriers')) {
      const acct = eq(url, 'account_id'), id = eq(url, 'id'), dot = eq(url, 'dot_number');
      const idIn = /^in\.\(/.test(q(url).get('id') || '') ? q(url).get('id').slice(4, -1).split(',') : null;
      const match = (s) => (!acct || s.account_id === acct) && (!id || s.id === id) && (!idIn || idIn.includes(s.id)) && (!dot || s.dot_number === dot);
      if (method === 'PATCH') (db.patches = db.patches || []).push(url);
      if (method === 'HEAD') return resp(200, undefined, { 'content-range': `*/${db.saved.filter(match).length}` });
      if (method === 'POST') { const row = Object.assign({ id: uuid(), created_at: new Date(NOW).toISOString(), note: null }, body); db.saved.push(row); return resp(201, [row]); }
      if (method === 'DELETE') { const gone = db.saved.filter(match); db.saved = db.saved.filter((s) => !match(s)); return resp(200, gone); }
      if (method === 'PATCH') { const hit = db.saved.filter(match); hit.forEach((s) => Object.assign(s, body)); return resp(200, hit); }
      const limit = Number(q(url).get('limit')) || 1000, offset = Number(q(url).get('offset')) || 0;
      return resp(200, db.saved.filter(match).slice(offset, offset + limit));
    }
    if (url.includes('/rest/v1/carrier_alerts')) {
      if (method === 'POST') { const made = body.map((a) => Object.assign({ id: uuid(), created_at: new Date(NOW).toISOString(), seen_at: null, emailed_at: null }, a)); db.alerts.push(...made); return resp(201, made); }
      if (method === 'PATCH') {
        const ids = (q(url).get('id') || '').replace(/^in\.\(|\)$/g, '').split(',').filter(Boolean);
        const acct = eq(url, 'account_id');
        db.alerts.filter((a) => (ids.length ? ids.includes(a.id) : a.account_id === acct && !a.seen_at)).forEach((a) => Object.assign(a, body));
        return resp(204);
      }
      return resp(200, db.alerts.filter((a) => a.account_id === eq(url, 'account_id')));
    }
    if (url.includes('/rest/v1/pro_users')) {
      const ids = (q(url).get('id') || '').replace(/^in\.\(|\)$/g, '').split(',');
      return resp(200, ids.map((i) => db.accounts[i] && Object.assign({ id: i, email: i + '@example.com' }, db.accounts[i].row)).filter(Boolean));
    }
    if (url === 'https://api.resend.com/emails') { db.emails = (db.emails || []).concat([body]); return resp(200, { id: 'em' }); }
    throw new Error('unexpected fetch ' + method + ' ' + url);
  };
  const user = (tok, uid, plan, extra = {}) => {
    db.users[tok] = uid;
    db.accounts[uid] = { account_id: extra.owner || uid, role: extra.owner ? 'member' : null, seated: !!extra.owner,
      row: plan === null ? null : Object.assign({ is_active: plan !== 'none', plan: plan === 'comp' ? 'pro' : plan, comp: plan === 'comp', stripe_subscription_id: plan === 'comp' ? null : 'sub_' + uid }, extra.row || {}) };
  };
  user('t-pro', 'u-pro', 'pro'); user('t-plus', 'u-plus', 'plus'); user('t-max', 'u-max', 'max'); user('t-comp', 'u-comp', 'comp'); user('t-free', 'u-free', 'none');
  user('t-member', 'u-member', 'max', { owner: 'u-max' });
  db.accounts['u-member'].row = db.accounts['u-max'].row;   // a member works on the owner's plan
  const handler = require(fn('carrier-check.js')).handler;
  const callFn = async (tok, body) => {
    const r2 = await handler({ httpMethod: 'POST', headers: tok ? { authorization: 'Bearer ' + tok } : {}, body: JSON.stringify(body) });
    return { status: r2.statusCode, body: JSON.parse(r2.body) };
  };

  let res = await callFn(null, { action: 'list' });
  ok(res.status === 401 && res.body.error === 'auth', 'not signed in: 401');
  res = await callFn('t-pro', { action: 'lookup', query: 'MC 135797' });
  ok(res.status === 403 && res.body.error === 'plan' && db.socrata === 0, 'Pro: carrier checks come with Pro Plus (nothing looked up)');
  res = await callFn('t-free', { action: 'lookup', query: 'MC 135797' });
  ok(res.status === 403, 'no plan: 403 too');
  res = await callFn('t-plus', { action: 'lookup', query: 'nonsense' });
  ok(res.status === 400 && res.body.error === 'invalid', 'unreadable number: 400');

  res = await callFn('t-plus', { action: 'lookup', query: 'MC 135797' });
  ok(res.status === 200 && res.body.report.dot === '80806' && res.body.report.verdict === 'ok' && res.body.usage.used === 1 && res.body.usage.limit === 100 && res.body.canMonitor === false && res.body.saved === null,
     'Pro Plus: MC 135797 checked (1 of 100 today), no saved list', JSON.stringify(res.body).slice(0, 300));
  ok(db.cache['80806'] && db.meta.national_oos && Math.abs(db.meta.national_oos.value.vehicle - 0.226) < 1e-9 && res.body.report.inspections.vehicle.national === db.meta.national_oos.value.vehicle,
     'the report is cached, and the national averages kept for a day');
  const socrataBefore = db.socrata;
  res = await callFn('t-plus', { action: 'lookup', query: '80806', kind: 'dot' });
  ok(res.status === 200 && res.body.usage.used === 1 && db.socrata === socrataBefore && db.lookups.filter((l) => l.account_id === 'u-plus').length === 1,
     'the same carrier again today: from the cache, and it doesn’t count again');
  res = await callFn('t-plus', { action: 'lookup', query: '4587322', kind: 'dot' });
  ok(res.status === 200 && res.body.report.verdict === 'warn' && res.body.usage.used === 2, 'a second carrier: counted (2 of 100), new authority flagged');
  db.cache['80806'].fetched_at = new Date(NOW - 7 * 3600000).toISOString();
  const stale = db.socrata;
  res = await callFn('t-plus', { action: 'lookup', query: 'MC135797' });
  ok(res.status === 200 && db.socrata > stale && db.cache['80806'].fetched_at === new Date(NOW).toISOString(), 'a report over 6 hours old is fetched again');
  for (let i = 0; i < 98; i++) db.lookups.push({ account_id: 'u-plus', user_id: 'u-plus', dot_number: String(9000000 + i), created_at: new Date(NOW).toISOString() });
  res = await callFn('t-plus', { action: 'lookup', query: 'DOT 9999998' });
  ok(res.status === 429 && res.body.error === 'limit' && /100 carriers today/.test(res.body.message), 'the 101st carrier of the day: 429, with when it resets');
  res = await callFn('t-plus', { action: 'lookup', query: 'MC135797' });
  ok(res.status === 200, '…but carriers already checked today still open');
  res = await callFn('t-max', { action: 'lookup', query: 'MC 5550001' });
  ok(res.status === 404 && res.body.error === 'not_found' && /MC 5550001/.test(res.body.message), 'unknown MC: not found, saying which number');

  const maxLookups = () => db.lookups.filter((l) => l.account_id === 'u-max').length;
  const maxBefore = maxLookups();
  delete db.cache['4587322'];
  db.down = new Set([F.DS.census, F.DS.authority]);
  res = await callFn('t-max', { action: 'lookup', query: '4587322', kind: 'dot' });
  ok(res.status === 502 && res.body.error === 'source' && /isn’t answering right now/.test(res.body.message) && maxLookups() === maxBefore && !db.cache['4587322'],
     'FMCSA not answering: “try again in a minute” (not “not found”), and it doesn’t count', JSON.stringify(res.body));
  db.down = new Set([F.DS.oos]);
  res = await callFn('t-max', { action: 'lookup', query: '4587322', kind: 'dot' });
  ok(res.status === 200 && res.body.report.missing.join() === 'oos' && res.body.report.flags.some((f) => f.code === 'incomplete') && res.body.report.verdict === 'warn'
     && !db.cache['4587322'] && maxLookups() === maxBefore + 1, 'out-of-service orders didn’t load: the report, marked incomplete, not cached (counted once)', JSON.stringify(res.body.report && res.body.report.missing));
  db.down = null;
  res = await callFn('t-max', { action: 'lookup', query: '4587322', kind: 'dot' });
  ok(res.status === 200 && res.body.report.missing.length === 0 && !res.body.report.flags.some((f) => f.code === 'incomplete') && db.cache['4587322'] && maxLookups() === maxBefore + 1,
     'checking again: complete, cached, and free');

  res = await callFn('t-plus', { action: 'list' });
  ok(res.status === 200 && res.body.canLookup && !res.body.canMonitor && res.body.saved.length === 0 && res.body.usage.limit === 100, 'Pro Plus list: checks, no saved carriers');
  res = await callFn('t-plus', { action: 'save', dot: '80806' });
  ok(res.status === 403 && /Pro Max/.test(res.body.message), 'Pro Plus can’t save carriers (Pro Max)');

  res = await callFn('t-max', { action: 'save', dot: '80806', docket: 'MC135797', name: 'J B Hunt Transport Inc' });
  const savedId = res.body.saved && res.body.saved.id;
  ok(res.status === 200 && savedId && res.body.saved.verdict === 'ok' && res.body.saved.facts.authority === 'Active' && db.saved.length === 1 && db.saved[0].account_id === 'u-max',
     'Pro Max: carrier saved with today’s facts as the starting point', JSON.stringify(res.body).slice(0, 300));
  res = await callFn('t-max', { action: 'save', dot: '80806' });
  ok(res.status === 200 && res.body.saved.id === savedId && db.saved.length === 1, 'saving it again: the same row');
  res = await callFn('t-member', { action: 'list' });
  ok(res.status === 200 && res.body.canMonitor && res.body.saved.length === 1 && res.body.saved[0].id === savedId && res.body.usage.limit === 500,
     'a team member sees the owner’s saved carriers and limits');
  res = await callFn('t-max', { action: 'lookup', query: 'MC135797' });
  ok(res.status === 200 && res.body.saved && res.body.saved.id === savedId && res.body.canMonitor, 'a saved carrier’s report says it’s saved');
  res = await callFn('t-max', { action: 'note', id: savedId, note: 'Good on reefer to the Northeast' });
  ok(res.status === 200 && db.saved[0].note === 'Good on reefer to the Northeast', 'a note on a saved carrier');
  res = await callFn('t-max', { action: 'note', id: savedId, note: 'x'.repeat(301) });
  ok(res.status === 400, '…not over 300 characters');
  res = await callFn('t-plus', { action: 'remove', id: savedId });
  ok(res.status === 403 && db.saved.length === 1, 'another plan can’t remove it');
  res = await callFn('t-comp', { action: 'remove', id: savedId });
  ok(res.status === 404 && db.saved.length === 1, 'another account can’t remove it');
  for (let i = 0; i < 499; i++) db.saved.push({ id: uuid(), account_id: 'u-comp', dot_number: String(8000000 + i), facts: {} });
  res = await callFn('t-comp', { action: 'save', dot: '80806' });
  ok(res.status === 200, 'comp account: saves (499 + 1)');
  res = await callFn('t-comp', { action: 'save', dot: '4587322' });
  ok(res.status === 409 && res.body.error === 'full', '…the 501st: full');
  db.saved = db.saved.filter((s) => s.account_id !== 'u-comp');
  db.down = new Set([F.DS.authority]);
  res = await callFn('t-comp', { action: 'save', dot: '80806' });
  db.down = null;
  ok(res.status === 200 && res.body.saved.verdict === null && res.body.saved.checked_at === null && Object.keys(res.body.saved.facts).length === 0,
     'saved while FMCSA wasn’t answering: “not checked yet” until the morning check (not “don’t book”)', JSON.stringify(res.body.saved));
  db.saved = db.saved.filter((s) => s.account_id !== 'u-comp');
  res = await callFn('t-max', { action: 'remove', id: savedId });
  ok(res.status === 200 && db.saved.length === 0, 'removed');

  // ═══ carrier-monitor.js ══════════════════════════════════════════════════
  const monitor = require(fn('carrier-monitor.js')).handler;
  db.saved = [];
  db.alerts = [];
  db.emails = [];
  await callFn('t-max', { action: 'save', dot: '80806', name: 'J B Hunt Transport Inc' });
  await callFn('t-max', { action: 'save', dot: '4587322', name: 'Safeway Trucking Company LLC' });
  const newOne = db.saved.find((x) => x.dot_number === '4587322');
  ok(newOne.verdict === 'warn' && newOne.facts.granted === isoAgo(28), 'saving a carrier with 28-day-old authority: “check” on the list, like its report', JSON.stringify(newOne.facts));
  db.saved.push({ id: uuid(), account_id: 'u-plus', dot_number: '80806', name: 'Plus’s carrier', facts: {} });   // saved while on Pro Max; now Pro Plus
  // Overnight: J.B. Hunt's liability is being cancelled; Safeway's authority is suspended.
  FIX['80806'].insHistory = [{ ins_type_code: '1', ins_type_desc: 'BIPD', filing_status_reason: 'CANCEL', cancl_effective_date: ymdFrom(15), policy_no: 'P-9', insurance_company_name: 'Ace Insurance' }];
  FIX['4587322'].authority = FIX['4587322'].authority.map((a) => Object.assign({}, a, { op_auth_status: 'Inactive' }));
  const out = JSON.parse((await monitor()).body);
  ok(out.saved === 3 && out.skipped === 1 && out.checked === 2 && out.alerts === 2 && out.emailed === 1, 'the morning check: 2 carriers checked (the Pro Plus account’s list is skipped), 2 alerts, 1 email', JSON.stringify(out));
  ok(db.alerts.map((a) => a.kind).sort().join() === 'authority,insurance_cancelling' && db.alerts.every((a) => a.account_id === 'u-max' && a.emailed_at),
     'alerts recorded for the account and marked emailed');
  const mail = db.emails[0];
  ok(mail && mail.to[0] === 'u-max@example.com' && mail.subject === 'Carrier alerts: 2 changes in your saved carriers' && /Safeway Trucking Company LLC: operating authority is now inactive/.test(mail.text)
     && /J B Hunt Transport Inc: liability insurance with Ace Insurance is being cancelled on Nov 28, 2026/.test(mail.text) && /carriers\.html/.test(mail.html), 'one email to the owner, both changes in plain words', mail && mail.text);
  ok(db.saved.find((s) => s.dot_number === '4587322' && s.account_id === 'u-max').facts.granted === isoAgo(28), 'the morning check keeps how new the carrier is');
  ok(db.saved.find((s) => s.dot_number === '4587322' && s.account_id === 'u-max').verdict === 'stop' && db.saved.find((s) => s.dot_number === '80806' && s.account_id === 'u-max').verdict === 'warn',
     'the saved list shows the new status');
  db.patches = [];
  const again = JSON.parse((await monitor()).body);
  ok(again.alerts === 0 && again.emailed === 0 && db.emails.length === 1, 'the next morning, nothing new: no alerts, no email');
  ok(again.checked === 2 && db.patches.length === 1 && /saved_carriers\?id=in\.\(/.test(db.patches[0]), 'carriers that didn’t change: today’s date in one update for all of them', JSON.stringify(db.patches));
  const keptFacts = JSON.stringify(db.saved.map((s) => [s.id, s.facts, s.verdict]));
  db.down = new Set([F.DS.authority]);
  const down = JSON.parse((await monitor()).body);
  db.down = null;
  ok(down.unchecked === 2 && down.checked === 0 && down.alerts === 0 && JSON.stringify(db.saved.map((s) => [s.id, s.facts, s.verdict])) === keptFacts && db.alerts.length === 2,
     'FMCSA down in the morning: nothing checked, no alerts, yesterday’s facts kept', JSON.stringify(down));
  const same = require(fn('carrier-monitor.js'))._internal.same;
  ok(same({ a: 1, b: { c: 2, d: [1, 2] } }, { b: { d: [1, 2], c: 2 }, a: 1 }) && !same({ d: [1, 2] }, { d: [2, 1] }), 'facts compared the same whatever order the database keeps the keys in');
  res = await callFn('t-max', { action: 'list' });
  ok(res.body.alerts.length === 2 && res.body.alerts.every((a) => !a.seen_at), 'the page lists the alerts, unread');
  await callFn('t-max', { action: 'seen' });
  res = await callFn('t-max', { action: 'list' });
  ok(res.body.alerts.every((a) => a.seen_at), 'marked read');
  const digest = require(fn('carrier-monitor.js'))._internal.buildDigest([{ name: 'A <b>', message: 'A <b>: authority inactive' }], 'https://quickfreightcalc.com');
  ok(digest.subject === 'Carrier alert: A <b>' && !/<b>:/.test(digest.html) && /&lt;b&gt;/.test(digest.html), 'one alert: a singular subject; names escaped in the email');

  Date.now = realNow;
  console.log(`\n${failed ? failed + ' CARRIER TEST(S) FAILED' : 'ALL ' + passed + ' CARRIER TESTS PASSED'}`);
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error('TEST FAILED:', e); process.exit(1); });
