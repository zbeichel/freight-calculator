// netlify/functions/stripe-webhook.js
// Handles Stripe events — activates/deactivates Pro based on subscription status.
// On first activation (checkout.session.completed), also sends a welcome email
// via Resend. Email send is best-effort — failures don't break the webhook.

const https = require('https');
const crypto = require('crypto');

const SUPABASE_URL = 'https://xgrmbhmgcsbnazupfybd.supabase.co';

function supabaseRequest(path, method, data, serviceKey, preferExtra){
  const body = data ? JSON.stringify(data) : null;
  const preferHeader = preferExtra ? `return=minimal,${preferExtra}` : 'return=minimal';
  return new Promise((resolve, reject) => {
    const url = new URL(SUPABASE_URL + path);
    const req = https.request({
      hostname: url.hostname,
      path: url.pathname + url.search,
      method,
      headers: {
        'apikey': serviceKey,
        'Authorization': `Bearer ${serviceKey}`,
        'Content-Type': 'application/json',
        'Prefer': preferHeader,
        ...(body ? { 'Content-Length': Buffer.byteLength(body) } : {})
      }
    }, res => {
      let d = '';
      res.on('data', chunk => d += chunk);
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: d ? JSON.parse(d) : {} }); }
        catch(e){ resolve({ status: res.statusCode, body: d }); }
      });
    });
    req.on('error', reject);
    if(body) req.write(body);
    req.end();
  });
}

// Verify Stripe webhook signature. Events signed more than five minutes ago
// are rejected (Stripe's recommended tolerance), so a captured event can't be
// replayed later; Stripe signs every retry afresh. Accepts any of the v1
// signatures Stripe sends while a signing secret is being rolled.
const SIGNATURE_TOLERANCE_SECONDS = 300;
function verifySignature(payload, signature, secret, now = Date.now()){
  let timestamp = null;
  const sigs = [];
  for(const part of String(signature).split(',')){
    const i = part.indexOf('=');
    if(i < 0) continue;
    const key = part.slice(0, i).trim();
    const val = part.slice(i + 1).trim();
    if(key === 't') timestamp = val;
    else if(key === 'v1') sigs.push(val);
  }
  const t = Number(timestamp);
  if(!timestamp || !Number.isFinite(t) || !sigs.length) return false;
  if(Math.abs(now / 1000 - t) > SIGNATURE_TOLERANCE_SECONDS) return false;
  const expected = Buffer.from(crypto.createHmac('sha256', secret).update(`${timestamp}.${payload}`).digest('hex'), 'hex');
  return sigs.some(s => {
    const got = Buffer.from(s, 'hex');
    return got.length === expected.length && crypto.timingSafeEqual(got, expected);
  });
}

const { PLANS, PLAN_NAME, normalizePlan, planForPriceIds, isOriginalPlanPrice, subscriptionPeriod } = require('../lib/plans.js');

// Which plan a subscription is on, from its price (Pro, Pro Plus, Pro Max or
// API — see netlify/lib/plans.js). Falls back to the metadata checkout
// set when the items aren't in the event.
function planFromSubscription(subscription){
  const priceIds = (subscription.items?.data || []).map(i => i.price?.id).filter(Boolean);
  if(priceIds.length) return planForPriceIds(priceIds);
  return normalizePlan(subscription.metadata?.plan);
}

// Checkout sets metadata.plan from the price it charged (see create-checkout).
function planFromCheckout(session){
  return normalizePlan(session.metadata?.plan);
}

// A new subscription, read from Stripe at checkout: its billing period (so
// limits that run by billing month, like the API plan's 5,000 quotes, count
// from the right day) and its price. Best effort: null if Stripe can't be
// reached; the next renewal records the period anyway.
async function fetchSubscription(subscriptionId){
  if(!subscriptionId || !process.env.STRIPE_SECRET_KEY) return null;
  try {
    const resp = await fetch(`https://api.stripe.com/v1/subscriptions/${encodeURIComponent(subscriptionId)}`, {
      headers: { 'Authorization': `Bearer ${process.env.STRIPE_SECRET_KEY}` },
      signal: AbortSignal.timeout(5000),
    });
    if(!resp.ok) return null;
    return await resp.json();
  } catch(e){
    console.warn('Could not read the new subscription:', e.message);
    return null;
  }
}

function priceOf(subscription){
  return subscription?.items?.data?.[0]?.price?.id || null;
}

// `period` ({ start, end } ISO strings from subscriptionPeriod) records the
// current billing period: billing_period_start tells routes.js when a
// subscriber on the original Pro plan has renewed into the new plans, and
// renews_at is shown to them. `extra`: other server-only columns to set
// (grandfathered, next_plan).
async function setProActive(userId, isActive, stripeCustomerId, stripeSubscriptionId, serviceKey, plan, period, extra){
  const updateData = {
    is_active: isActive,
    updated_at: new Date().toISOString(),
  };
  if(stripeCustomerId) updateData.stripe_customer_id = stripeCustomerId;
  if(stripeSubscriptionId) updateData.stripe_subscription_id = stripeSubscriptionId;
  if(PLANS.includes(plan)) updateData.plan = plan;
  if(period?.start) updateData.billing_period_start = period.start;
  if(period?.end) updateData.renews_at = period.end;
  if(extra) Object.assign(updateData, extra);

  // Try PATCH first
  const patchResp = await supabaseRequest(
    `/rest/v1/pro_users?id=eq.${userId}`,
    'PATCH',
    updateData,
    serviceKey
  );
  console.log(`PATCH response status: ${patchResp.status}`);
  console.log(`PATCH response body: ${JSON.stringify(patchResp.body)}`);

  // If no row found, upsert it
  if(patchResp.status === 404 || patchResp.status === 204){
    console.log(`Upserting pro_users row for ${userId}`);
    const upsertData = { id: userId, ...updateData };
    if(stripeCustomerId) upsertData.stripe_customer_id = stripeCustomerId;
    if(stripeSubscriptionId) upsertData.stripe_subscription_id = stripeSubscriptionId;
    const upsertResp = await supabaseRequest(
      `/rest/v1/pro_users`,
      'POST',
      upsertData,
      serviceKey,
      'resolution=merge-duplicates'
    );
    console.log(`UPSERT response status: ${upsertResp.status}`);
    console.log(`UPSERT response body: ${JSON.stringify(upsertResp.body)}`);
    return upsertResp;
  }
  return patchResp;
}

// ──────────────────────────────────────────────────────────────────────────
// Welcome email — sent once when a user first activates Pro via checkout.
// Uses Resend's REST API. Best-effort: any failure is logged but doesn't
// break the webhook. Errors here would otherwise cause Stripe to retry,
// triggering more failed emails — bad cycle.
// ──────────────────────────────────────────────────────────────────────────
function sendResendEmail({ apiKey, from, to, subject, html, text }){
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ from, to: [to], subject, html, text });
    const req = https.request({
      hostname: 'api.resend.com',
      path: '/emails',
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
      }
    }, res => {
      let d = '';
      res.on('data', chunk => d += chunk);
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: d ? JSON.parse(d) : {} }); }
        catch(e){ resolve({ status: res.statusCode, body: d }); }
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

function buildWelcomeEmail(siteUrl, plan){
  const planName = PLAN_NAME[normalizePlan(plan)];
  const subject = `Welcome to QuickFreightCalc ${planName} — you're all set`;
  const lookupsText = {
    pro: 'Automatic miles on 100 quotes per day',
    plus: 'Automatic miles on 250 quotes per day (Pro Plus)',
    max: 'Automatic miles on 1,000 quotes per day (Pro Max)',
    api: 'API access with 5,000 quotes a month, plus automatic miles on 1,000 quotes per day on the site — create your API key on your Profile page',
  }[normalizePlan(plan)];

  // Plain-text version (fallback for clients that don't render HTML)
  const text = `Thanks for signing up — your ${planName} account is active.

Here's what you unlocked:

• ${lookupsText}
• Multi-Stop Load Builder — quote multi-stop loads with per-leg mileage and PDF exports
• Bulk Load Calculator — per-cwt rate calculator with EIA fuel surcharge logic
• Lane Rate Tracker — track how your regular lanes compare to regional market rates
• Detention Tracker — see crowdsourced reports on shipper and receiver detention pay
• PDF quote exports with your branding (set up on your profile page)
• Quote logging for your records

Open the calculator: ${siteUrl}/

Manage your subscription anytime from your Profile: ${siteUrl}/profile.html

— The QuickFreightCalc team
`;

  // HTML version — light styling, single CTA, no marketing fluff
  const html = `<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8">
<style>
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; background:#f4f6f9; margin:0; padding:32px 16px; color:#1a2540; line-height:1.5; }
  .wrap { max-width:560px; margin:0 auto; background:#ffffff; border-radius:10px; overflow:hidden; box-shadow:0 2px 12px rgba(0,0,0,.05); }
  .header { background:#1a1f2e; padding:24px 32px; }
  .brand { font-size:18px; font-weight:700; color:#ffffff; letter-spacing:-.02em; margin:0; }
  .brand span { color:#f0a500; }
  .accent-bar { height:4px; background:linear-gradient(to right,#f0a500,#f0c040,#f0a500); }
  .body { padding:32px; }
  h1 { font-size:20px; font-weight:700; margin:0 0 16px; color:#1a2540; }
  p { margin:0 0 16px; font-size:14px; color:#4a5e7a; }
  ul { margin:0 0 24px; padding:0; list-style:none; }
  li { margin:0 0 10px; padding:0 0 0 22px; font-size:14px; color:#1a2540; position:relative; }
  li::before { content:"✓"; position:absolute; left:0; top:0; color:#f0a500; font-weight:700; }
  li strong { color:#1a2540; }
  .cta { text-align:center; margin:24px 0; }
  .cta a { display:inline-block; padding:12px 28px; background:#f0a500; color:#000000; text-decoration:none; font-weight:700; font-size:14px; border-radius:8px; }
  .footer { padding:20px 32px; font-size:12px; color:#8896a8; border-top:1px solid #e4e8ef; text-align:center; }
  .footer a { color:#4a5e7a; text-decoration:none; }
</style>
</head>
<body>
  <div class="wrap">
    <div class="header">
      <p class="brand">Quick<span>Freight</span>Calc</p>
    </div>
    <div class="accent-bar"></div>
    <div class="body">
      <h1>You're all set</h1>
      <p>Thanks for signing up — your ${planName} account is active and ready to go. Here's what you just unlocked:</p>
      <ul>
        <li><strong>♾️ ${lookupsText}</strong></li>
        <li><strong>🚛 Multi-Stop Load Builder</strong> — quote multi-stop loads with per-leg mileage and PDF exports</li>
        <li><strong>🥔 Bulk Load Calculator</strong> — per-cwt rate calculator with EIA fuel surcharge logic for bulk hauling</li>
        <li><strong>📈 Lane Rate Tracker</strong> — track how your regular lanes compare to regional market rates over time</li>
        <li><strong>🕐 Detention Tracker</strong> — see crowdsourced reports on shipper and receiver detention pay</li>
        <li><strong>PDF quote exports</strong> with your branding (set this up on your profile page)</li>
        <li><strong>Quote logging</strong> for your records</li>
      </ul>
      <div class="cta">
        <a href="${siteUrl}/">Open the Calculator</a>
      </div>
      <p style="font-size:12px; color:#8896a8; margin-top:24px;">Manage your subscription anytime from your <a href="${siteUrl}/profile.html" style="color:#4a5e7a;">Profile</a>.</p>
    </div>
    <div class="footer">
      QuickFreightCalc — quickfreightcalc.com
    </div>
  </div>
</body>
</html>`;

  return { subject, html, text };
}

async function trySendWelcomeEmail({ toEmail, serviceKey, plan }){
  const apiKey = process.env.RESEND_API_KEY;
  if(!apiKey){
    console.warn('[welcome-email] RESEND_API_KEY not set — skipping');
    return;
  }
  if(!toEmail){
    console.warn('[welcome-email] No recipient email provided — skipping');
    return;
  }

  const siteUrl = process.env.SITE_URL || 'https://quickfreightcalc.com';
  const { subject, html, text } = buildWelcomeEmail(siteUrl, plan);

  try {
    const resp = await sendResendEmail({
      apiKey,
      from: 'QuickFreightCalc <donotreply@quickfreightcalc.com>',
      to: toEmail,
      subject,
      html,
      text,
    });
    if(resp.status >= 200 && resp.status < 300){
      console.log(`[welcome-email] sent to ${toEmail} (id: ${resp.body?.id || 'n/a'})`);
    } else {
      console.warn(`[welcome-email] Resend returned ${resp.status}:`, JSON.stringify(resp.body));
    }
  } catch(err){
    console.warn(`[welcome-email] send threw:`, err.message);
  }
}

exports.handler = async function(event){
  if(event.httpMethod !== 'POST'){
    return { statusCode: 405, body: 'Method not allowed' };
  }

  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;
  const serviceKey = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;

  if(!webhookSecret || !serviceKey){
    console.error('Missing env vars');
    return { statusCode: 500, body: 'Missing environment variables' };
  }

  // Verify webhook signature
  const signature = event.headers['stripe-signature'];
  if(!signature){
    return { statusCode: 400, body: 'Missing stripe-signature header' };
  }

  try {
    if(!verifySignature(event.body, signature, webhookSecret)){
      return { statusCode: 400, body: 'Invalid signature' };
    }
  } catch(err){
    console.error('Signature verification failed:', err);
    return { statusCode: 400, body: 'Signature verification failed' };
  }

  const stripeEvent = JSON.parse(event.body);
  console.log('Stripe event:', stripeEvent.type);

  try {
    switch(stripeEvent.type){

      case 'checkout.session.completed': {
        const session = stripeEvent.data.object;
        const userId = session.client_reference_id || session.metadata?.userId;
        const customerId = session.customer;
        const subscriptionId = session.subscription;

        if(!userId){
          console.error('No userId in checkout session');
          break;
        }

        // ── Idempotency check — was this user already active before?
        // If yes, skip the welcome email (Stripe is just retrying the webhook).
        // If no, this is genuinely a first-time activation.
        let wasAlreadyActive = false;
        try {
          const checkResp = await supabaseRequest(
            `/rest/v1/pro_users?id=eq.${userId}&select=is_active`,
            'GET', null, serviceKey
          );
          wasAlreadyActive = checkResp.body?.[0]?.is_active === true;
          console.log(`Pre-activation check for ${userId}: was already active = ${wasAlreadyActive}`);
        } catch(e){
          console.warn('Pre-activation check failed (will still send welcome):', e.message);
        }

        const plan = planFromCheckout(session);
        const newSub = await fetchSubscription(subscriptionId);
        const period = newSub ? subscriptionPeriod(newSub) : null;
        // A new subscription is on the new plans unless it was sold at the
        // original price (only while STRIPE_PRICE_ID_PRO isn't set yet).
        const price = priceOf(newSub);
        const extra = price ? { grandfathered: isOriginalPlanPrice(price), next_plan: plan } : { next_plan: plan };
        console.log(`Activating Pro (${plan}) for user ${userId}`);
        await setProActive(userId, true, customerId, subscriptionId, serviceKey, plan, period, extra);

        // Send welcome email only on FIRST activation
        if(!wasAlreadyActive){
          // Stripe Checkout puts the email at session.customer_details.email
          // (most reliable) with session.customer_email as a fallback.
          const recipientEmail = session.customer_details?.email || session.customer_email;
          await trySendWelcomeEmail({ toEmail: recipientEmail, serviceKey, plan });
        } else {
          console.log(`[welcome-email] Skipping — user ${userId} was already active`);
        }
        break;
      }

      case 'customer.subscription.deleted': {
        const subscription = stripeEvent.data.object;
        const userId = subscription.metadata?.userId;

        // Back to the default plan, so a later comp or re-subscription starts clean.
        // A later subscription starts on the new plans.
        const reset = { grandfathered: false, next_plan: null };
        if(userId){
          console.log(`Deactivating Pro for user ${userId}`);
          await setProActive(userId, false, null, null, serviceKey, 'pro', null, reset);
        } else {
          // Look up user by stripe_subscription_id
          const resp = await supabaseRequest(
            `/rest/v1/pro_users?stripe_subscription_id=eq.${subscription.id}&select=id`,
            'GET', null, serviceKey
          );
          if(resp.body?.[0]?.id){
            await setProActive(resp.body[0].id, false, null, null, serviceKey, 'pro', null, reset);
          }
        }
        break;
      }

      case 'customer.subscription.updated': {
        const subscription = stripeEvent.data.object;
        const isActive = subscription.status === 'active' || subscription.status === 'trialing';
        const userId = subscription.metadata?.userId;
        // Plan switches (change-plan or the billing portal) and renewals land here.
        const plan = planFromSubscription(subscription);
        const period = subscriptionPeriod(subscription);
        // Still on the original Pro plan: keep it marked for the January 1 move.
        const extra = isOriginalPlanPrice(priceOf(subscription)) ? { grandfathered: true } : null;

        if(userId){
          console.log(`Updating Pro status for user ${userId}: ${isActive} (${plan})`);
          await setProActive(userId, isActive, null, null, serviceKey, plan, period, extra);
        } else {
          const resp = await supabaseRequest(
            `/rest/v1/pro_users?stripe_subscription_id=eq.${subscription.id}&select=id`,
            'GET', null, serviceKey
          );
          if(resp.body?.[0]?.id){
            await setProActive(resp.body[0].id, isActive, null, null, serviceKey, plan, period, extra);
          }
        }
        break;
      }

      default:
        console.log(`Unhandled event type: ${stripeEvent.type}`);
    }

    return { statusCode: 200, body: JSON.stringify({ received: true }) };
  } catch(err){
    console.error('Webhook handler error:', err);
    return { statusCode: 500, body: JSON.stringify({ error: err.message }) };
  }
};
