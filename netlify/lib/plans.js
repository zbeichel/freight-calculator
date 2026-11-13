// netlify/lib/plans.js
// The paid plans and the rules shared by routes.js, create-checkout.js,
// change-plan.js, stripe-webhook.js, verify-pro.js, apply-plan-changes.js and
// the API functions. Lives outside netlify/functions so Netlify doesn't
// publish it as an endpoint; the functions bundle it through require().
//
//   pro   Pro       $9.99/mo    automatic miles on 100 quotes per day
//   plus  Pro Plus  $19.99/mo   automatic miles on 250 quotes per day, plus
//                               win/loss tracking (index.html), the customer
//                               list (customers.js), emailing quotes
//                               (email-quote.js, send-quote-email.js) and your
//                               own rate sheet (rate-sheet.js); comp accounts too
//   max   Pro Max   $49.99/mo   everything in Pro Plus, automatic miles on 1,000
//                               quotes per day, white-label PDFs (pdf-quote.js)
//                               and a team of 3 people (team.js)
//   api   API       $199.99/mo  Pro Max on the site with a team of 6 people + API
//                               access with API_MONTHLY_QUOTES automatic-miles
//                               quotes per billing month (see api-quote.js)
//
// Saved quotes in the quote log: Pro 100, Pro Plus 1,000, Pro Max / API /
// comp 5,000. Saved customers: Pro Plus 1,000, Pro Max / API / comp 5,000.
// The database enforces these and who can record win/loss results or save
// customers (quote_log_enforce_plan, customers_enforce_plan); the pages show
// the same limits.
//
// Teams (team.js): the owner of a Pro Max, API or comp account can add people, up to
// teamSize() including the owner. Members sign in with their own logins and share the
// owner's plan, daily limits, quote log, customers and company settings; the database
// decides who has a seat (private.team_size / team_owner_of, effective_account).
//
// Comp accounts (free, every feature): active with no Stripe subscription.
// pro_users.comp (set by an admin) keeps them that way: the database ignores
// Stripe events for an old subscription that would switch them off or change
// their plan (pro_users_keep_comp). A comp account on the 'api' plan also has
// API access.
//
// A "quote" is a distinct origin→destination pair priced with automatic miles
// in a UTC day; re-pricing the same pair that day or typing miles is free.

const PLANS = ['pro', 'plus', 'max', 'api'];
const PLAN_NAME = { pro: 'Pro', plus: 'Pro Plus', max: 'Pro Max', api: 'API' };
const PLAN_DAILY_LIMIT = { pro: 100, plus: 250, max: 1000, api: 1000 };
const PLAN_RANK = { pro: 1, plus: 2, max: 3, api: 4 };

// People on a team, owner included. Comp accounts get Pro Max's team (the API plan's
// on the API plan). Keep in step with private.team_size() in the database.
const TEAM_SIZE = { max: 3, api: 6 };
function teamSize(row) {
  if (!row || row.is_active !== true) return 1;
  const plan = normalizePlan(row.plan);
  if (row.comp === true || !row.stripe_subscription_id) return plan === 'api' ? TEAM_SIZE.api : TEAM_SIZE.max;
  return TEAM_SIZE[plan] || 1;
}

// API plan: automatic-miles quotes per billing month, and requests per minute per key.
const API_MONTHLY_QUOTES = 5000;
const API_PER_MINUTE = 60;

function normalizePlan(plan) {
  return PLANS.includes(plan) ? plan : 'pro';
}

// Stripe prices (Netlify env vars) for the new plans:
//   STRIPE_PRICE_ID_PRO ($9.99), _PLUS ($19.99), _MAX ($49.99), _API ($199.99).
// Each holds the monthly price's ID (price_…), not the product's ID (prod_…).
// STRIPE_PRICE_ID stays the original $4.99 Pro price that current subscribers
// pay; any subscription on a price that isn't one of these new ones is on the
// original plan (see "Subscribers on the original Pro plan" below).
function newPriceIdFor(plan) {
  return {
    pro: process.env.STRIPE_PRICE_ID_PRO,
    plus: process.env.STRIPE_PRICE_ID_PLUS,
    max: process.env.STRIPE_PRICE_ID_MAX,
    api: process.env.STRIPE_PRICE_ID_API,
  }[plan];
}

function newPlanPriceIds() {
  return PLANS.map(newPriceIdFor).filter(Boolean);
}

// The price to sell a plan at. Until STRIPE_PRICE_ID_PRO is set, Pro is still
// sold at the original price, so checkout keeps working; those subscribers
// are treated as being on the original plan and move in January like the rest.
function priceIdFor(plan) {
  return newPriceIdFor(plan) || (plan === 'pro' ? process.env.STRIPE_PRICE_ID : undefined);
}

// True for a price that isn't one of the new plans (the original $4.99 Pro).
function isOriginalPlanPrice(priceId) {
  return !!priceId && !newPlanPriceIds().includes(priceId);
}

// Plan for a subscription's price ids. Anything that isn't the Plus, Max or
// API price (including the original $4.99 price) is Pro.
function planForPriceIds(priceIds) {
  const ids = (priceIds || []).filter(Boolean);
  for (const plan of ['api', 'max', 'plus']) {
    const price = newPriceIdFor(plan);
    if (price && ids.includes(price)) return plan;
  }
  return 'pro';
}

// ── Subscribers on the original Pro plan ($4.99) ────────────────────────────
// New signups get the new plans straight away. Subscribers on the original
// plan keep unlimited quotes at their current price until their first bill on
// or after NEW_PLANS_START (January 1, 2027), then move to the plan they chose
// (pro_users.next_plan; Pro if they didn't choose).
//   - pro_users.grandfathered marks them. It was set for every active
//     subscriber when the new plans launched, and the webhook and
//     apply-plan-changes set it for any subscription still on the original price.
//   - apply-plan-changes (scheduled, hourly) switches each one's Stripe price,
//     with no proration, once the subscription's current period ends on or
//     after NEW_PLANS_START, so their first bill on or after that day is at the
//     new price and nothing is charged at the switch.
//   - The webhook records billing_period_start at each renewal. Once a period
//     starting on or after NEW_PLANS_START is recorded, the plan's daily limit
//     applies. LEGACY_BACKSTOP ends it for anyone whose renewal wasn't recorded.
// Comp accounts (Pro granted without a Stripe subscription, e.g. coworkers)
// are outside all of this: no daily limit (routes.js) and every plan feature.
const DAY_MS = 24 * 60 * 60 * 1000;
const NEW_PLANS_START = Date.parse('2027-01-01T05:00:00Z'); // midnight Eastern, Jan 1 2027
const LEGACY_BACKSTOP = NEW_PLANS_START + 33 * DAY_MS;

// `row`: a pro_users row with grandfathered and billing_period_start.
function legacyUnlimited(row, now = Date.now()) {
  if (!row || row.grandfathered !== true) return false;
  if (now >= LEGACY_BACKSTOP) return false;
  const periodStart = Date.parse(row.billing_period_start || '');
  return !(Number.isFinite(periodStart) && periodStart >= NEW_PLANS_START);
}

// True once a subscription's current period ends on or after NEW_PLANS_START,
// i.e. its next bill is in the new plans: time to switch its price.
function dueForNewPlan(periodEndIso) {
  const end = Date.parse(periodEndIso || '');
  return Number.isFinite(end) && end >= NEW_PLANS_START;
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
  PLAN_NAME,
  PLAN_DAILY_LIMIT,
  PLAN_RANK,
  TEAM_SIZE,
  teamSize,
  API_MONTHLY_QUOTES,
  API_PER_MINUTE,
  normalizePlan,
  newPriceIdFor,
  newPlanPriceIds,
  priceIdFor,
  isOriginalPlanPrice,
  planForPriceIds,
  legacyUnlimited,
  dueForNewPlan,
  subscriptionPeriod,
  NEW_PLANS_START,
  LEGACY_BACKSTOP,
};
