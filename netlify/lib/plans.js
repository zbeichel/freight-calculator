// netlify/lib/plans.js
// The paid plans and the rules shared by routes.js, create-checkout.js,
// change-plan.js, stripe-webhook.js and verify-pro.js. Lives outside
// netlify/functions so Netlify doesn't publish it as an endpoint; the
// functions bundle it through require().
//
//   pro       Pro            $9.99/mo   automatic miles on 100 quotes per day
//   plus      Pro Plus       $19.99/mo  automatic miles on 250 quotes per day
//   unlimited Pro Unlimited  $49.99/mo  automatic miles on every quote
//
// A "quote" is a distinct origin→destination pair priced with automatic miles
// in a UTC day; re-pricing the same pair that day or typing miles is free.

const PLANS = ['pro', 'plus', 'unlimited'];
const PLAN_DAILY_LIMIT = { pro: 100, plus: 250, unlimited: null };
const PLAN_RANK = { pro: 1, plus: 2, unlimited: 3 };

function normalizePlan(plan) {
  return PLANS.includes(plan) ? plan : 'pro';
}

// Stripe price for each plan (Netlify env vars). STRIPE_PRICE_ID is Pro.
function priceIdFor(plan) {
  return {
    pro: process.env.STRIPE_PRICE_ID,
    plus: process.env.STRIPE_PRICE_ID_PLUS,
    unlimited: process.env.STRIPE_PRICE_ID_UNLIMITED,
  }[plan];
}

// Plan for a subscription's price ids. Anything that isn't the Plus or
// Unlimited price (including the old $4.99 price) is Pro.
function planForPriceIds(priceIds) {
  const ids = (priceIds || []).filter(Boolean);
  if (process.env.STRIPE_PRICE_ID_UNLIMITED && ids.includes(process.env.STRIPE_PRICE_ID_UNLIMITED)) return 'unlimited';
  if (process.env.STRIPE_PRICE_ID_PLUS && ids.includes(process.env.STRIPE_PRICE_ID_PLUS)) return 'plus';
  return 'pro';
}

// ── Subscribers from before the plan changes ─────────────────────────────────
// They keep unlimited quotes until their subscription renews. The Stripe webhook
// records the start of each billing period in pro_users.billing_period_start;
// once a period that started on or after NEW_PLANS_FROM_RENEWAL is recorded,
// their chosen plan's limit applies. LEGACY_BACKSTOP ends it for anyone whose
// renewal wasn't recorded (monthly plans renew within a month).
//   LEGACY_BEFORE           accounts created before this are current subscribers
//   NEW_PLANS_FROM_RENEWAL  the first renewal on/after this starts the new plans
// Set both to the day the change goes live. To give 30 days' notice of the new
// prices (see the Terms), move NEW_PLANS_FROM_RENEWAL 30 days later.
const LEGACY_BEFORE = Date.parse('2026-11-12T00:00:00Z');
const NEW_PLANS_FROM_RENEWAL = Date.parse('2026-11-12T00:00:00Z');
const LEGACY_BACKSTOP = NEW_PLANS_FROM_RENEWAL + 33 * 24 * 60 * 60 * 1000;

function legacyUnlimited(createdAt, billingPeriodStart, now = Date.now()) {
  const created = Date.parse(createdAt || '');
  if (!Number.isFinite(created) || created >= LEGACY_BEFORE) return false;
  if (now >= LEGACY_BACKSTOP) return false;
  const periodStart = Date.parse(billingPeriodStart || '');
  return !(Number.isFinite(periodStart) && periodStart >= NEW_PLANS_FROM_RENEWAL);
}

// Current billing period of a Stripe subscription as ISO strings. Older API
// versions put the period on the subscription, newer ones on each item.
function subscriptionPeriod(subscription) {
  const item = (subscription && subscription.items && subscription.items.data && subscription.items.data[0]) || {};
  const start = subscription && subscription.current_period_start != null ? subscription.current_period_start : item.current_period_start;
  const end = subscription && subscription.current_period_end != null ? subscription.current_period_end : item.current_period_end;
  const iso = s => (Number.isFinite(s) ? new Date(s * 1000).toISOString() : null);
  return { start: iso(start), end: iso(end) };
}

module.exports = {
  PLANS,
  PLAN_DAILY_LIMIT,
  PLAN_RANK,
  normalizePlan,
  priceIdFor,
  planForPriceIds,
  legacyUnlimited,
  subscriptionPeriod,
  LEGACY_BEFORE,
  NEW_PLANS_FROM_RENEWAL,
  LEGACY_BACKSTOP,
};
