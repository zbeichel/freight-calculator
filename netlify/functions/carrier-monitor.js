// carrier-monitor.js — scheduled (every morning, netlify.toml). Re-checks every carrier that a
// Pro Max, API or comp account has saved on the Carrier check page (carriers.html) against
// FMCSA's open data (netlify/lib/fmcsa.js monitorFacts), and records what changed for the
// worse since the last check: authority no longer active, liability insurance below what's
// required or being cancelled, an out-of-service order, an inactive USDOT number, a worse
// safety rating. Each account's owner gets one email listing that morning's alerts.
// Accounts that no longer have a plan with monitoring keep their list, unchecked.
const { normalizePlan } = require('../lib/plans');
const F = require('../lib/fmcsa');

const SUPABASE_URL = process.env.SUPABASE_URL || 'https://xgrmbhmgcsbnazupfybd.supabase.co';
const MONITOR_PLANS = ['max', 'api', 'comp'];
const FROM = 'QuickFreightCalc <alerts@quickfreightcalc.com>';
const PAGE = 1000;

function serviceKey() {
  return process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY || '';
}
async function db(path, { method = 'GET', body, prefer } = {}) {
  const key = serviceKey();
  const resp = await fetch(SUPABASE_URL + path, {
    method,
    headers: { apikey: key, Authorization: `Bearer ${key}`, ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...(prefer ? { Prefer: prefer } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await resp.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch (e) {}
  return { ok: resp.ok, status: resp.status, data };
}
const rows = (r) => (r && r.ok && Array.isArray(r.data) ? r.data : []);
function planKey(row) {
  if (!row || row.is_active !== true) return null;
  if (row.comp === true || !row.stripe_subscription_id) return 'comp';
  return normalizePlan(row.plan);
}
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// One email per account: that morning's alerts.
function buildDigest(alerts, siteUrl) {
  const n = alerts.length;
  const subject = n === 1 ? `Carrier alert: ${alerts[0].name || 'a saved carrier'}` : `Carrier alerts: ${n} changes in your saved carriers`;
  const link = `${siteUrl}/carriers.html`;
  const text = `${n === 1 ? 'One of your saved carriers changed' : `${n} changes in your saved carriers`} in FMCSA's records:\n\n` +
    alerts.map((a) => `- ${a.message}`).join('\n') +
    `\n\nCheck them before you tender loads: ${link}\n\n— QuickFreightCalc\nYou get this because you watch these carriers on the Carrier check page.`;
  const html = `<!DOCTYPE html><html><head><meta charset="UTF-8"></head>
<body style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Arial,sans-serif;background:#f4f6f9;margin:0;padding:32px 16px;color:#1a2540;line-height:1.5">
  <div style="max-width:560px;margin:0 auto;background:#ffffff;border-radius:10px;overflow:hidden">
    <div style="background:#1a1f2e;padding:22px 30px"><p style="font-size:18px;font-weight:700;color:#ffffff;margin:0">Quick<span style="color:#f0a500">Freight</span>Calc</p></div>
    <div style="height:4px;background:#f0a500"></div>
    <div style="padding:26px 30px">
      <h1 style="font-size:19px;margin:0 0 12px">${n === 1 ? 'One of your saved carriers changed' : `${n} changes in your saved carriers`}</h1>
      <ul style="margin:0 0 18px;padding-left:20px;font-size:14px;color:#1a2540">${alerts.map((a) => `<li style="margin-bottom:8px">${esc(a.message)}</li>`).join('')}</ul>
      <p style="margin:0 0 18px;font-size:14px;color:#4a5e7a">Check them before you tender loads.</p>
      <p style="text-align:center;margin:0"><a href="${esc(link)}" style="display:inline-block;padding:12px 26px;background:#f0a500;color:#000000;text-decoration:none;font-weight:700;font-size:14px;border-radius:8px">Open Carrier check</a></p>
    </div>
    <div style="padding:16px 30px;font-size:12px;color:#8896a8;border-top:1px solid #e4e8ef;text-align:center">You get this because you watch these carriers on QuickFreightCalc's Carrier check page.</div>
  </div>
</body></html>`;
  return { subject, text, html };
}

// The same facts as yesterday? (jsonb doesn't keep key order, so compare with keys sorted.)
const canon = (v) => JSON.stringify(v, (k, x) => (x && typeof x === 'object' && !Array.isArray(x)
  ? Object.keys(x).sort().reduce((o, key) => { o[key] = x[key]; return o; }, {}) : x));
const same = (a, b) => canon(a) === canon(b);

exports.handler = async function () {
  if (!serviceKey()) {
    console.error('[carrier-monitor] missing SUPABASE_SERVICE_KEY');
    return { statusCode: 200, body: 'not configured' };
  }
  // Scheduled functions get about 30 seconds: FMCSA's data has to be read well inside that.
  const started = Date.now();
  const summary = { saved: 0, accounts: 0, checked: 0, alerts: 0, emailed: 0, skipped: 0, unchecked: 0, errors: 0 };

  // Housekeeping, so the tables don't grow without end: a cached report is only served for
  // 6 hours (keep 2 days), and the check log only counts today's checks (keep 90 days).
  const before = (days) => encodeURIComponent(new Date(Date.now() - days * 86400000).toISOString());
  const c1 = await db(`/rest/v1/carrier_cache?fetched_at=lt.${before(2)}`, { method: 'DELETE', prefer: 'return=minimal' });
  const c2 = await db(`/rest/v1/carrier_lookups?created_at=lt.${before(90)}`, { method: 'DELETE', prefer: 'return=minimal' });
  if (!c1.ok || !c2.ok) console.warn('[carrier-monitor] cleanup failed', c1.status, c2.status);

  // Every saved carrier, page by page; the ones checked longest ago first, so a carrier
  // missed on a slow morning is first in line the next day.
  const saved = [];
  for (let offset = 0; ; offset += PAGE) {
    const page = rows(await db(`/rest/v1/saved_carriers?select=id,account_id,dot_number,name,facts,verdict&order=checked_at.asc.nullsfirst,id.asc&limit=${PAGE}&offset=${offset}`));
    saved.push(...page);
    if (page.length < PAGE) break;
  }
  summary.saved = saved.length;
  if (!saved.length) return { statusCode: 200, body: JSON.stringify(summary) };

  // Only accounts whose plan includes monitoring.
  const accountIds = [...new Set(saved.map((s) => s.account_id))];
  const owners = {};
  for (let i = 0; i < accountIds.length; i += 100) {
    const ids = accountIds.slice(i, i + 100).join(',');
    for (const r of rows(await db(`/rest/v1/pro_users?id=in.(${ids})&select=id,email,is_active,plan,comp,stripe_subscription_id`))) owners[r.id] = r;
  }
  const watching = saved.filter((s) => MONITOR_PLANS.includes(planKey(owners[s.account_id])));
  summary.skipped = saved.length - watching.length;
  summary.accounts = new Set(watching.map((s) => s.account_id)).size;
  if (!watching.length) return { statusCode: 200, body: JSON.stringify(summary) };

  // Today's facts for every carrier (each USDOT number once, in batches). A batch FMCSA
  // couldn't answer leaves its carriers out: they keep yesterday's facts and raise nothing.
  let facts;
  try {
    facts = await F.monitorFacts(watching.map((s) => s.dot_number), { deadline: started + 20000, timeoutMs: 8000 });
  } catch (e) {
    console.error('[carrier-monitor] FMCSA data unavailable:', e.message);
    return { statusCode: 200, body: JSON.stringify({ ...summary, unchecked: watching.length, errors: 1 }) };
  }
  const now = new Date(Date.now()).toISOString();
  const newAlerts = {};
  const unchanged = [];
  for (const s of watching) {
    if (!facts[s.dot_number]) { summary.unchecked++; continue; }
    const prev = s.facts && Object.keys(s.facts).length ? s.facts : null;
    // How new the carrier is was recorded when it was saved: carry it forward.
    const cur = Object.assign({}, facts[s.dot_number], prev && prev.granted ? { granted: prev.granted } : {}, prev && prev.usdotAdded ? { usdotAdded: prev.usdotAdded } : {});
    const verdict = F.factsVerdict(cur);
    // Most carriers are the same as yesterday: those only get today's date, all at once below.
    if (prev && same(prev, cur) && s.verdict === verdict) { unchanged.push(s.id); continue; }
    const found = prev ? F.diffFacts(prev, cur, s.name || `USDOT ${s.dot_number}`) : [];
    const upd = await db(`/rest/v1/saved_carriers?id=eq.${s.id}`, { method: 'PATCH', body: { facts: cur, verdict, checked_at: now }, prefer: 'return=minimal' });
    if (!upd.ok) { summary.errors++; continue; }
    summary.checked++;
    if (!found.length) continue;
    const ins = await db('/rest/v1/carrier_alerts', { method: 'POST', prefer: 'return=representation',
      body: found.map((a) => ({ account_id: s.account_id, saved_carrier_id: s.id, dot_number: s.dot_number, name: s.name, kind: a.kind, message: a.text.slice(0, 500) })) });
    const made = rows(ins);
    summary.alerts += made.length;
    (newAlerts[s.account_id] = newAlerts[s.account_id] || []).push(...made);
  }

  for (let i = 0; i < unchanged.length; i += 100) {
    const ids = unchanged.slice(i, i + 100);
    const upd = await db(`/rest/v1/saved_carriers?id=in.(${ids.join(',')})`, { method: 'PATCH', body: { checked_at: now }, prefer: 'return=minimal' });
    if (upd.ok) summary.checked += ids.length; else summary.errors++;
  }

  // One email per account, to the plan owner.
  const apiKey = process.env.RESEND_API_KEY;
  const siteUrl = process.env.SITE_URL || 'https://quickfreightcalc.com';
  for (const [accountId, list] of Object.entries(newAlerts)) {
    const to = owners[accountId] && owners[accountId].email;
    if (!apiKey || !to || !list.length) continue;
    const { subject, text, html } = buildDigest(list, siteUrl);
    try {
      const resp = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ from: FROM, to: [to], subject, text, html }),
      });
      if (!resp.ok) throw new Error(`Resend ${resp.status}`);
      await db(`/rest/v1/carrier_alerts?id=in.(${list.map((a) => a.id).join(',')})`, { method: 'PATCH', body: { emailed_at: new Date(Date.now()).toISOString() }, prefer: 'return=minimal' });
      summary.emailed++;
    } catch (e) {
      summary.errors++;
      console.error(`[carrier-monitor] email for ${accountId.slice(0, 8)}: ${e.message}`);
    }
  }

  // Keep the national out-of-service averages fresh for the reports.
  try {
    const value = await F.nationalAverages({ deadline: started + 27000, timeoutMs: 6000 });
    if (value && value.vehicle) await db('/rest/v1/carrier_meta?on_conflict=key', { method: 'POST', body: { key: 'national_oos', value, updated_at: new Date(Date.now()).toISOString() }, prefer: 'resolution=merge-duplicates,return=minimal' });
  } catch (e) { /* the page refreshes them on demand */ }

  console.log('[carrier-monitor]', JSON.stringify(summary));
  return { statusCode: 200, body: JSON.stringify(summary) };
};

exports._internal = { buildDigest, planKey, same };
