// netlify/functions/api-keys.js
//
// The Profile page's API section: list, create and revoke API keys, and show
// how much of this billing month's allowance is used.
//
// POST { accessToken, action: 'list' | 'create' | 'revoke', name?, keyId? }
//   list   → { access, keys, usage }
//   create → { key, item, access, keys, usage }  (the full key is returned this
//            once; only its SHA-256 hash is stored)
//   revoke → { access, keys, usage }
// `access`: 'active' (API plan, can create keys) | 'starts_at_renewal' (chose the
// API plan, starts when the current subscription renews) | 'plan_required'.
// Keys can be listed and revoked on any plan; they only work on the API plan.

const crypto = require('crypto');
const { API_MONTHLY_QUOTES, API_PER_MINUTE, normalizePlan, legacyUnlimited } = require('../lib/plans.js');

const SUPABASE_URL = 'https://xgrmbhmgcsbnazupfybd.supabase.co';
const MAX_KEYS = 5;
const DAY_MS = 24 * 60 * 60 * 1000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function reply(statusCode, payload) {
  return { statusCode, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }, body: JSON.stringify(payload) };
}

function headers(serviceKey, extra) {
  return Object.assign({ apikey: serviceKey, Authorization: `Bearer ${serviceKey}`, 'Content-Type': 'application/json' }, extra || {});
}

async function rest(serviceKey, path, method = 'GET', body, prefer) {
  const resp = await fetch(`${SUPABASE_URL}${path}`, {
    method,
    headers: headers(serviceKey, prefer ? { Prefer: prefer } : null),
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(5000),
  });
  const text = await resp.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  return { ok: resp.ok, status: resp.status, data };
}

async function verifyUser(accessToken, serviceKey) {
  if (!accessToken) return null;
  try {
    const resp = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
      headers: { apikey: serviceKey, Authorization: `Bearer ${accessToken}` },
      signal: AbortSignal.timeout(5000),
    });
    if (!resp.ok) return null;
    const user = await resp.json();
    return user && user.id ? user.id : null;
  } catch {
    return null;
  }
}

function accessFor(sub) {
  if (!sub || sub.is_active !== true || normalizePlan(sub.plan) !== 'api') return 'plan_required';
  if (legacyUnlimited(sub.created_at, sub.billing_period_start)) return 'starts_at_renewal';
  return 'active';
}

// Same billing-month window as api-quote.js.
function usageWindow(sub, now = Date.now()) {
  const start = Date.parse((sub && sub.billing_period_start) || '');
  const end = Date.parse((sub && sub.renews_at) || '');
  if (Number.isFinite(start) && start <= now && now - start < 32 * DAY_MS) {
    return { since: new Date(start).toISOString(), resetsAt: Number.isFinite(end) && end > now ? new Date(end).toISOString() : null };
  }
  return { since: new Date(now - 31 * DAY_MS).toISOString(), resetsAt: null };
}

async function snapshot(serviceKey, userId, sub) {
  const keysResp = await rest(serviceKey,
    `/rest/v1/api_keys?user_id=eq.${userId}&revoked_at=is.null&select=id,name,prefix,created_at,last_used_at&order=created_at.asc`);
  const keys = Array.isArray(keysResp.data) ? keysResp.data.map((k) => ({
    id: k.id, name: k.name, prefix: k.prefix, createdAt: k.created_at, lastUsedAt: k.last_used_at,
  })) : [];
  const period = usageWindow(sub);
  let used = null;
  const usageResp = await rest(serviceKey, '/rest/v1/rpc/api_quota_status', 'POST',
    { p_user: userId, p_key: null, p_since: period.since });
  if (usageResp.ok && usageResp.data && typeof usageResp.data === 'object') used = usageResp.data.auto_miles_used;
  return {
    access: accessFor(sub),
    renewsAt: (sub && sub.renews_at) || null,
    keys,
    maxKeys: MAX_KEYS,
    usage: { used, limit: API_MONTHLY_QUOTES, perMinute: API_PER_MINUTE, resetsAt: period.resetsAt },
  };
}

function cleanName(name) {
  const s = String(name == null ? '' : name).replace(/[\u0000-\u001f\u007f<>]/g, '').trim().slice(0, 40);
  return s || 'API key';
}

exports.handler = async function (event) {
  if (event.httpMethod !== 'POST') return reply(405, { error: 'Method not allowed' });
  const serviceKey = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!serviceKey) {
    console.error('[api-keys] SUPABASE_SERVICE_KEY not configured');
    return reply(500, { error: 'API keys are unavailable right now.' });
  }

  let body;
  try { body = JSON.parse(event.body || '{}'); } catch { return reply(400, { error: 'Invalid request' }); }
  const { accessToken, action } = body || {};
  if (!['list', 'create', 'revoke'].includes(action)) return reply(400, { error: 'Invalid request' });

  const userId = await verifyUser(accessToken, serviceKey);
  if (!userId) return reply(401, { error: 'Please sign in again.' });

  try {
    const subResp = await rest(serviceKey,
      `/rest/v1/pro_users?id=eq.${userId}&select=is_active,plan,created_at,billing_period_start,renews_at`);
    const sub = Array.isArray(subResp.data) ? subResp.data[0] || null : null;

    if (action === 'create') {
      if (accessFor(sub) !== 'active') {
        return reply(403, { error: accessFor(sub) === 'starts_at_renewal'
          ? 'Your API plan starts when your subscription renews. You can create keys then.'
          : 'API keys need the API plan ($199/month). Switch plans above.' });
      }
      const countResp = await rest(serviceKey, `/rest/v1/api_keys?user_id=eq.${userId}&revoked_at=is.null&select=id`);
      if (Array.isArray(countResp.data) && countResp.data.length >= MAX_KEYS) {
        return reply(400, { error: `You can have up to ${MAX_KEYS} keys. Revoke one you don't use first.` });
      }
      const key = 'qfc_live_' + crypto.randomBytes(24).toString('base64url');
      const row = {
        user_id: userId,
        name: cleanName(body.name),
        prefix: key.slice(0, 13),
        key_hash: crypto.createHash('sha256').update(key).digest('hex'),
      };
      const ins = await rest(serviceKey, '/rest/v1/api_keys?select=id,name,prefix,created_at,last_used_at', 'POST', row, 'return=representation');
      if (!ins.ok || !Array.isArray(ins.data) || !ins.data[0]) {
        console.error('[api-keys] insert failed:', ins.status, JSON.stringify(ins.data));
        return reply(500, { error: 'Could not create a key. Please try again.' });
      }
      const k = ins.data[0];
      return reply(200, Object.assign({ key, item: { id: k.id, name: k.name, prefix: k.prefix, createdAt: k.created_at, lastUsedAt: null } },
        await snapshot(serviceKey, userId, sub)));
    }

    if (action === 'revoke') {
      if (!UUID.test(String(body.keyId || ''))) return reply(400, { error: 'Invalid request' });
      const upd = await rest(serviceKey,
        `/rest/v1/api_keys?id=eq.${body.keyId}&user_id=eq.${userId}&revoked_at=is.null`,
        'PATCH', { revoked_at: new Date().toISOString() }, 'return=minimal');
      if (!upd.ok) {
        console.error('[api-keys] revoke failed:', upd.status, JSON.stringify(upd.data));
        return reply(500, { error: 'Could not revoke the key. Please try again.' });
      }
    }

    return reply(200, await snapshot(serviceKey, userId, sub));
  } catch (e) {
    console.error('[api-keys] error:', e && e.message);
    return reply(500, { error: 'Something went wrong. Please try again.' });
  }
};
