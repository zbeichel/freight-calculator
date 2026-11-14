// carrier-check.js — the Carrier check page (carriers.html).
//
// POST /.netlify/functions/carrier-check
//   Authorization: Bearer <Supabase access token>
//   { action: 'lookup', query, kind? }   a carrier by MC/MX/FF or USDOT number (kind 'mc' | 'dot'
//                                        for plain digits): FMCSA authority, insurance, safety and
//                                        the warning signs (netlify/lib/fmcsa.js). Pro Plus and up.
//   { action: 'list' }                   what the page needs: plan, today's checks, saved carriers
//                                        and alerts (saved carriers on Pro Max, API and comp)
//   { action: 'save', dot, docket?, name? }   watch a carrier (Pro Max, API, comp)
//   { action: 'remove', id }             stop watching one
//   { action: 'note', id, note }         a short note on a saved carrier
//   { action: 'seen' }                   mark the alerts as read
//
// Plans: Pro Plus checks LOOKUP_LIMIT.plus carriers a day; Pro Max, API and comp accounts
// LOOKUP_LIMIT.max and can save up to SAVED_LIMIT carriers, which carrier-monitor.js
// re-checks every morning. A team shares its owner's plan, limits and saved carriers.
// Checking the same carrier again the same day doesn't count again. Reports are cached
// for CACHE_HOURS (FMCSA's open data changes daily).
//
// Responses: 200 { ... }   400 { error: 'invalid' }   401 { error: 'auth' }   403 { error: 'plan' }
//            404 { error: 'not_found' }   409 { error: 'full' }   429 { error: 'limit' }   502 { error: 'source' }
const { normalizePlan } = require('../lib/plans');
const { effectiveAccount } = require('../lib/account');
const F = require('../lib/fmcsa');

const SUPABASE_URL = process.env.SUPABASE_URL || 'https://xgrmbhmgcsbnazupfybd.supabase.co';
const LOOKUP_LIMIT = { plus: 100, max: 250, api: 500, comp: 500 };   // carrier checks a day
const MONITOR_PLANS = ['max', 'api', 'comp'];
const SAVED_LIMIT = 500;
const CACHE_HOURS = 6;
const NATIONAL_HOURS = 24;

function serviceKey() {
  return process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY || '';
}
function json(statusCode, body) {
  return { statusCode, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }, body: JSON.stringify(body) };
}
const fail = (status, error, message, extra) => json(status, { error, message, ...(extra || {}) });

async function db(path, { method = 'GET', body, prefer } = {}) {
  const key = serviceKey();
  const resp = await fetch(SUPABASE_URL + path, {
    method,
    headers: {
      apikey: key, Authorization: `Bearer ${key}`,
      ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      ...(prefer ? { Prefer: prefer } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await resp.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch (e) {}
  return { ok: resp.ok, status: resp.status, data, headers: resp.headers };
}
const rows = (r) => (r && r.ok && Array.isArray(r.data) ? r.data : []);
async function count(path) {
  const r = await db(path, { method: 'HEAD', prefer: 'count=exact' });
  const range = r.headers && r.headers.get ? r.headers.get('content-range') : null;
  const n = range ? Number(String(range).split('/')[1]) : NaN;
  return Number.isFinite(n) ? n : 0;
}

async function authUser(token) {
  if (!token) return null;
  try {
    const resp = await fetch(`${SUPABASE_URL}/auth/v1/user`, { headers: { apikey: serviceKey(), Authorization: `Bearer ${token}` } });
    if (!resp.ok) return null;
    const u = await resp.json();
    return u && u.id ? u : null;
  } catch (e) { return null; }
}

// 'plus' | 'max' | 'api' | 'comp' | 'pro' | null (no active plan)
function planKey(row) {
  if (!row || row.is_active !== true) return null;
  if (row.comp === true || !row.stripe_subscription_id) return 'comp';
  return normalizePlan(row.plan);
}
const startOfDay = (now = Date.now()) => new Date(new Date(now).toISOString().slice(0, 10) + 'T00:00:00Z').toISOString();

async function usage(accountId, plan) {
  const used = await count(`/rest/v1/carrier_lookups?account_id=eq.${accountId}&created_at=gte.${encodeURIComponent(startOfDay())}&select=id`);
  return { used, limit: LOOKUP_LIMIT[plan] || 0 };
}

// National out-of-service averages: kept for a day in carrier_meta (the morning monitor
// refreshes them too).
async function national(opt) {
  const kept = rows(await db('/rest/v1/carrier_meta?key=eq.national_oos&select=value,updated_at'))[0];
  if (kept && Date.parse(kept.updated_at) > Date.now() - NATIONAL_HOURS * 3600000) return kept.value;
  try {
    const value = await F.nationalAverages(opt);
    if (value && value.vehicle) {
      await db('/rest/v1/carrier_meta?on_conflict=key', { method: 'POST', body: { key: 'national_oos', value, updated_at: new Date(Date.now()).toISOString() }, prefer: 'resolution=merge-duplicates,return=minimal' });
      return value;
    }
  } catch (e) {
    console.warn('[carrier-check] national averages:', e.message);
  }
  return kept ? kept.value : null;
}

// The report for a USDOT number: from the cache if it's fresh, otherwise from FMCSA's data
// (by `deadline`). Only complete reports are cached.
async function reportFor(dot, deadline) {
  const cached = rows(await db(`/rest/v1/carrier_cache?dot_number=eq.${dot}&select=report,fetched_at`))[0];
  if (cached && Date.parse(cached.fetched_at) > Date.now() - CACHE_HOURS * 3600000 && cached.report) {
    const report = cached.report;
    const a = F.assess(report, Date.now());   // ages ("granted 12 days ago") move on
    report.verdict = a.verdict;
    report.flags = a.flags;
    return report;
  }
  const [raw, nat] = await Promise.all([F.fetchCarrier(dot, { deadline }), national({ deadline })]);
  const report = F.buildReport(raw, { national: nat });
  if (report.found && !report.missing.length) {
    await db('/rest/v1/carrier_cache?on_conflict=dot_number', { method: 'POST', body: { dot_number: dot, report, fetched_at: new Date(Date.now()).toISOString() }, prefer: 'resolution=merge-duplicates,return=minimal' });
  }
  return report;
}

async function lookup(user, acct, plan, body) {
  if (!LOOKUP_LIMIT[plan]) return fail(403, 'plan', 'Carrier checks come with Pro Plus and up.', { plan });
  const q = F.parseQuery(body.query, body.kind === 'dot' ? 'dot' : 'mc');
  if (!q) return fail(400, 'invalid', 'Enter an MC number (e.g. MC 135797) or a USDOT number (e.g. DOT 80806).', { field: 'query' });

  // FMCSA's data is usually quick but has slow spells: the whole check has to finish
  // inside the function's time limit (about 10 seconds), with a little room to spare.
  const deadline = Date.now() + 8500;
  let dot;
  try { dot = await F.resolveDot(q, { deadline, timeoutMs: 4000 }); } catch (e) {
    console.error('[carrier-check] resolve', e.message);
    return fail(502, 'source', 'FMCSA’s data isn’t answering right now. Try again in a minute.');
  }
  if (!dot) return fail(404, 'not_found', q.docket ? `No carrier with ${q.docket.replace(/^(MC|MX|FF)/, '$1 ')} in FMCSA’s records.` : `No carrier with USDOT ${q.dot} in FMCSA’s records.`);

  // The same carrier again today is free; a new one counts toward the day's checks.
  const already = rows(await db(`/rest/v1/carrier_lookups?account_id=eq.${acct.accountId}&dot_number=eq.${dot}&created_at=gte.${encodeURIComponent(startOfDay())}&select=id&limit=1`)).length > 0;
  let use = await usage(acct.accountId, plan);
  if (!already && use.used >= use.limit) {
    return fail(429, 'limit', `You’ve checked ${use.limit.toLocaleString('en-US')} carriers today. Checks reset at midnight UTC (7 p.m. Eastern).`, { usage: use });
  }

  let report;
  try { report = await reportFor(dot, deadline); } catch (e) {
    console.error('[carrier-check] report', dot, e.message);
    return fail(502, 'source', 'FMCSA’s data isn’t answering right now. Try again in a minute.');
  }
  if (report.unavailable) {
    console.warn('[carrier-check] FMCSA unavailable for', dot, report.missing.join(','));
    return fail(502, 'source', 'FMCSA’s data isn’t answering right now. Try again in a minute.');
  }
  if (!report.found) return fail(404, 'not_found', `No carrier with USDOT ${dot} in FMCSA’s records.`);
  if (!already) {
    await db('/rest/v1/carrier_lookups', { method: 'POST', body: { account_id: acct.accountId, user_id: user.id, dot_number: dot }, prefer: 'return=minimal' });
    use = { used: use.used + 1, limit: use.limit };
  }
  const canMonitor = MONITOR_PLANS.includes(plan);
  const saved = canMonitor ? rows(await db(`/rest/v1/saved_carriers?account_id=eq.${acct.accountId}&dot_number=eq.${dot}&select=id`))[0] || null : null;
  return json(200, { report, usage: use, plan, canMonitor, saved });
}

const SAVED_COLS = 'id,dot_number,docket,name,note,verdict,facts,checked_at,created_at';
async function list(acct, plan) {
  const canLookup = !!LOOKUP_LIMIT[plan];
  const canMonitor = MONITOR_PLANS.includes(plan);
  const out = { plan, canLookup, canMonitor, usage: canLookup ? await usage(acct.accountId, plan) : null, saved: [], alerts: [], savedLimit: canMonitor ? SAVED_LIMIT : 0 };
  if (canMonitor) {
    out.saved = rows(await db(`/rest/v1/saved_carriers?account_id=eq.${acct.accountId}&select=${SAVED_COLS}&order=created_at.desc&limit=${SAVED_LIMIT}`));
    out.alerts = rows(await db(`/rest/v1/carrier_alerts?account_id=eq.${acct.accountId}&select=id,dot_number,name,kind,message,created_at,seen_at&order=created_at.desc&limit=50`));
  }
  return json(200, out);
}

async function save(user, acct, plan, body) {
  if (!MONITOR_PLANS.includes(plan)) return fail(403, 'plan', 'Saving carriers and alerts come with Pro Max.', { plan });
  const dot = /^\d{1,8}$/.test(String(body.dot || '')) ? String(Number(body.dot)) : null;
  if (!dot || dot === '0') return fail(400, 'invalid', 'That isn’t a USDOT number.', { field: 'dot' });
  const docket = /^(MC|MX|FF)\d{1,8}$/.test(String(body.docket || '')) ? String(body.docket) : null;
  const name = String(body.name || '').replace(/\s+/g, ' ').trim().slice(0, 200) || null;
  const existing = rows(await db(`/rest/v1/saved_carriers?account_id=eq.${acct.accountId}&dot_number=eq.${dot}&select=${SAVED_COLS}`))[0];
  if (existing) return json(200, { saved: existing });
  const n = await count(`/rest/v1/saved_carriers?account_id=eq.${acct.accountId}&select=id`);
  if (n >= SAVED_LIMIT) return fail(409, 'full', `You’re watching ${SAVED_LIMIT} carriers, the most a plan can. Remove one to add another.`);
  // Today's facts are the starting point the daily check compares against.
  let facts = {};
  try { facts = (await F.monitorFacts([dot], { deadline: Date.now() + 6000, timeoutMs: 4000, retryDelayMs: 200 }))[dot] || {}; } catch (e) { console.warn('[carrier-check] baseline', dot, e.message); }
  // How new the carrier is, from the report just checked (the daily facts don't include it).
  const cached = Object.keys(facts).length ? rows(await db(`/rest/v1/carrier_cache?dot_number=eq.${dot}&select=report`))[0] : null;
  if (cached && cached.report) {
    if (cached.report.authority && cached.report.authority.firstGranted) facts.granted = cached.report.authority.firstGranted;
    if (cached.report.usdotAdded) facts.usdotAdded = cached.report.usdotAdded;
  }
  const row = { account_id: acct.accountId, dot_number: dot, docket, name, facts, verdict: F.factsVerdict(facts) || null,
    checked_at: Object.keys(facts).length ? new Date(Date.now()).toISOString() : null, added_by: user.id };
  const ins = await db('/rest/v1/saved_carriers', { method: 'POST', body: row, prefer: 'return=representation' });
  const savedRow = rows(ins)[0];
  if (!savedRow) {
    const again = rows(await db(`/rest/v1/saved_carriers?account_id=eq.${acct.accountId}&dot_number=eq.${dot}&select=${SAVED_COLS}`))[0];
    if (again) return json(200, { saved: again });
    return fail(502, 'source', 'Couldn’t save the carrier. Try again.');
  }
  return json(200, { saved: savedRow });
}

const ID_RE = /^[0-9a-f-]{36}$/i;
async function remove(acct, plan, body) {
  if (!MONITOR_PLANS.includes(plan)) return fail(403, 'plan', 'Saving carriers and alerts come with Pro Max.', { plan });
  if (!ID_RE.test(String(body.id || ''))) return fail(400, 'invalid', 'Unknown carrier.', { field: 'id' });
  const r = await db(`/rest/v1/saved_carriers?id=eq.${body.id}&account_id=eq.${acct.accountId}`, { method: 'DELETE', prefer: 'return=representation' });
  if (!rows(r).length) return fail(404, 'not_found', 'That carrier isn’t on your list.');
  return json(200, { removed: body.id });
}

async function note(acct, plan, body) {
  if (!MONITOR_PLANS.includes(plan)) return fail(403, 'plan', 'Saving carriers and alerts come with Pro Max.', { plan });
  if (!ID_RE.test(String(body.id || ''))) return fail(400, 'invalid', 'Unknown carrier.', { field: 'id' });
  const text = String(body.note || '').replace(/\s+/g, ' ').trim();
  if (text.length > 300) return fail(400, 'invalid', 'Keep the note under 300 characters.', { field: 'note' });
  const r = await db(`/rest/v1/saved_carriers?id=eq.${body.id}&account_id=eq.${acct.accountId}`, { method: 'PATCH', body: { note: text || null }, prefer: 'return=representation' });
  if (!rows(r).length) return fail(404, 'not_found', 'That carrier isn’t on your list.');
  return json(200, { saved: rows(r)[0] });
}

async function seen(acct) {
  await db(`/rest/v1/carrier_alerts?account_id=eq.${acct.accountId}&seen_at=is.null`, { method: 'PATCH', body: { seen_at: new Date(Date.now()).toISOString() }, prefer: 'return=minimal' });
  return json(200, { ok: true });
}

exports.handler = async function (event) {
  if (event.httpMethod !== 'POST') return fail(405, 'invalid', 'Method not allowed');
  if (!serviceKey()) return fail(500, 'source', 'Carrier checks aren’t set up yet.');
  let body = null;
  try { body = JSON.parse(event.body || '{}'); } catch (e) {}
  if (!body || typeof body !== 'object') return fail(400, 'invalid', 'The request wasn’t readable. Try again.');
  const auth = (event.headers && (event.headers.authorization || event.headers.Authorization)) || '';
  const user = await authUser(auth.startsWith('Bearer ') ? auth.slice(7).trim() : '');
  if (!user) return fail(401, 'auth', 'Sign in to check carriers.');
  const acct = await effectiveAccount(user.id, serviceKey());
  if (!acct) return fail(502, 'source', 'Couldn’t load your account. Try again in a minute.');
  const plan = planKey(acct.row);
  try {
    switch (String(body.action || '')) {
      case 'lookup': return await lookup(user, acct, plan, body);
      case 'list': return await list(acct, plan);
      case 'save': return await save(user, acct, plan, body);
      case 'remove': return await remove(acct, plan, body);
      case 'note': return await note(acct, plan, body);
      case 'seen': return await seen(acct);
      default: return fail(400, 'invalid', 'Unknown action.', { field: 'action' });
    }
  } catch (e) {
    console.error('[carrier-check]', body.action, e && e.message);
    return fail(502, 'source', 'Something went wrong. Try again in a minute.');
  }
};

exports._internal = { planKey, LOOKUP_LIMIT, MONITOR_PLANS, SAVED_LIMIT };
