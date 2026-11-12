// netlify/functions/apply-plan-changes.js
//
// Scheduled (hourly, see netlify.toml). Moves subscribers on the original Pro
// plan to the new plans for January 1, 2027 (netlify/lib/plans.js). For each
// active subscriber billed through Stripe:
//   - Still on a price that isn't one of the new plans → mark grandfathered
//     (unlimited quotes until their first bill on or after January 1).
//   - Once the subscription's current period ends on or after January 1 (its
//     next bill is in the new plans), switch it to the plan they chose
//     (pro_users.next_plan, Pro if none) with no proration: nothing is charged
//     at the switch and the next bill is at the new price.
// Subscriptions set to cancel at the end of the period are left alone. Safe to
// run any number of times: a subscription already on a new price is skipped.

const { normalizePlan, newPriceIdFor, isOriginalPlanPrice, dueForNewPlan, subscriptionPeriod } = require('../lib/plans.js');

const SUPABASE_URL = 'https://xgrmbhmgcsbnazupfybd.supabase.co';
const LIVE_STATUSES = ['active', 'trialing', 'past_due'];

function supaHeaders(serviceKey) {
  return { apikey: serviceKey, Authorization: `Bearer ${serviceKey}`, 'Content-Type': 'application/json' };
}

async function stripe(path, method = 'GET', params) {
  const resp = await fetch(`https://api.stripe.com${path}`, {
    method,
    headers: Object.assign({ Authorization: `Bearer ${process.env.STRIPE_SECRET_KEY}` },
      params ? { 'Content-Type': 'application/x-www-form-urlencoded' } : {}),
    body: params ? new URLSearchParams(params).toString() : undefined,
    signal: AbortSignal.timeout(8000),
  });
  let body = null;
  try { body = await resp.json(); } catch { body = null; }
  return { ok: resp.ok, status: resp.status, body };
}

async function patchUser(serviceKey, userId, record) {
  const resp = await fetch(`${SUPABASE_URL}/rest/v1/pro_users?id=eq.${encodeURIComponent(userId)}`, {
    method: 'PATCH',
    headers: Object.assign(supaHeaders(serviceKey), { Prefer: 'return=minimal' }),
    body: JSON.stringify(Object.assign({ updated_at: new Date().toISOString() }, record)),
    signal: AbortSignal.timeout(5000),
  });
  if (!resp.ok) throw new Error(`pro_users update HTTP ${resp.status}`);
}

// One subscriber. Returns what happened, for the run summary.
async function applyOne(row, serviceKey) {
  const subResp = await stripe(`/v1/subscriptions/${encodeURIComponent(row.stripe_subscription_id)}`);
  const sub = subResp.body;
  if (!subResp.ok || !sub || sub.error) return 'stripe_error';
  if (!LIVE_STATUSES.includes(sub.status)) return 'not_live';
  const item = sub.items && sub.items.data && sub.items.data[0];
  const price = item && item.price && item.price.id;
  if (!isOriginalPlanPrice(price)) return 'on_new_plan';

  if (row.grandfathered !== true) await patchUser(serviceKey, row.id, { grandfathered: true });
  const period = subscriptionPeriod(sub);
  if (sub.cancel_at_period_end) return 'cancelling';
  if (!dueForNewPlan(period.end)) return 'waiting';

  const plan = normalizePlan(row.next_plan);
  const newPrice = newPriceIdFor(plan);
  if (!newPrice) {
    console.error(`[apply-plan-changes] no Stripe price set for ${plan}; can't move ${row.id.slice(0, 8)} yet`);
    return 'price_missing';
  }
  const upd = await stripe(`/v1/subscriptions/${encodeURIComponent(row.stripe_subscription_id)}`, 'POST', {
    'items[0][id]': item.id,
    'items[0][price]': newPrice,
    'proration_behavior': 'none',
  });
  if (!upd.ok || !upd.body || upd.body.error) {
    console.error('[apply-plan-changes] switch failed:', row.id.slice(0, 8), upd.status, upd.body && upd.body.error && upd.body.error.message);
    return 'switch_failed';
  }
  await patchUser(serviceKey, row.id, { plan, next_plan: plan, grandfathered: true });
  console.log(`[apply-plan-changes] ${row.id.slice(0, 8)} moved to ${plan} from the next bill (${period.end})`);
  return 'switched';
}

exports.handler = async function () {
  const serviceKey = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!serviceKey || !process.env.STRIPE_SECRET_KEY) {
    console.error('[apply-plan-changes] missing SUPABASE_SERVICE_KEY or STRIPE_SECRET_KEY');
    return { statusCode: 500, body: 'not configured' };
  }
  const resp = await fetch(
    `${SUPABASE_URL}/rest/v1/pro_users?is_active=eq.true&stripe_subscription_id=not.is.null` +
      '&select=id,plan,next_plan,grandfathered,stripe_subscription_id',
    { headers: supaHeaders(serviceKey), signal: AbortSignal.timeout(5000) }
  );
  if (!resp.ok) {
    console.error('[apply-plan-changes] could not list subscribers:', resp.status);
    return { statusCode: 502, body: 'could not list subscribers' };
  }
  const rows = await resp.json();
  const summary = {};
  // A few at a time keeps well inside Stripe's rate limits and the function's time limit.
  for (let i = 0; i < rows.length; i += 5) {
    const results = await Promise.all(rows.slice(i, i + 5).map((row) =>
      applyOne(row, serviceKey).catch((e) => {
        console.error('[apply-plan-changes] error:', row.id.slice(0, 8), e && e.message);
        return 'error';
      })));
    results.forEach((r) => { summary[r] = (summary[r] || 0) + 1; });
  }
  console.log('[apply-plan-changes]', JSON.stringify(summary));
  return { statusCode: 200, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(summary) };
};
