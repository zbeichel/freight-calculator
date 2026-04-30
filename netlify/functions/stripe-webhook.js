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

// Verify Stripe webhook signature
function verifySignature(payload, signature, secret){
  const parts = signature.split(',').reduce((acc, part) => {
    const [key, val] = part.split('=');
    acc[key] = val;
    return acc;
  }, {});
  const timestamp = parts.t;
  const sig = parts.v1;
  const signed = `${timestamp}.${payload}`;
  const expected = crypto.createHmac('sha256', secret).update(signed).digest('hex');
  return crypto.timingSafeEqual(Buffer.from(sig, 'hex'), Buffer.from(expected, 'hex'));
}

async function setProActive(userId, isActive, stripeCustomerId, stripeSubscriptionId, serviceKey){
  const updateData = {
    is_active: isActive,
    updated_at: new Date().toISOString(),
  };
  if(stripeCustomerId) updateData.stripe_customer_id = stripeCustomerId;
  if(stripeSubscriptionId) updateData.stripe_subscription_id = stripeSubscriptionId;

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

function buildWelcomeEmail(siteUrl){
  const subject = "Welcome to QuickFreightCalc Pro — you're all set";

  // Plain-text version (fallback for clients that don't render HTML)
  const text = `Thanks for signing up — your Pro account is active.

Here's what you unlocked:

• Multi-Stop Load Builder — quote multi-stop loads with per-leg mileage and PDF exports
• Bulk Load Calculator — per-cwt rate calculator with EIA fuel surcharge logic
• Lane Rate Tracker — track how your regular lanes compare to DAT regional rates
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
      <p>Thanks for signing up — your Pro account is active and ready to go. Here's what you just unlocked:</p>
      <ul>
        <li><strong>🚛 Multi-Stop Load Builder</strong> — quote multi-stop loads with per-leg mileage and PDF exports</li>
        <li><strong>🥔 Bulk Load Calculator</strong> — per-cwt rate calculator with EIA fuel surcharge logic for bulk hauling</li>
        <li><strong>📈 Lane Rate Tracker</strong> — track how your regular lanes compare to DAT regional rates over time</li>
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

async function trySendWelcomeEmail({ toEmail, serviceKey }){
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
  const { subject, html, text } = buildWelcomeEmail(siteUrl);

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

        console.log(`Activating Pro for user ${userId}`);
        await setProActive(userId, true, customerId, subscriptionId, serviceKey);

        // Send welcome email only on FIRST activation
        if(!wasAlreadyActive){
          // Stripe Checkout puts the email at session.customer_details.email
          // (most reliable) with session.customer_email as a fallback.
          const recipientEmail = session.customer_details?.email || session.customer_email;
          await trySendWelcomeEmail({ toEmail: recipientEmail, serviceKey });
        } else {
          console.log(`[welcome-email] Skipping — user ${userId} was already active`);
        }
        break;
      }

      case 'customer.subscription.deleted': {
        const subscription = stripeEvent.data.object;
        const userId = subscription.metadata?.userId;

        if(userId){
          console.log(`Deactivating Pro for user ${userId}`);
          await setProActive(userId, false, null, null, serviceKey);
        } else {
          // Look up user by stripe_subscription_id
          const resp = await supabaseRequest(
            `/rest/v1/pro_users?stripe_subscription_id=eq.${subscription.id}&select=id`,
            'GET', null, serviceKey
          );
          if(resp.body?.[0]?.id){
            await setProActive(resp.body[0].id, false, null, null, serviceKey);
          }
        }
        break;
      }

      case 'customer.subscription.updated': {
        const subscription = stripeEvent.data.object;
        const isActive = subscription.status === 'active' || subscription.status === 'trialing';
        const userId = subscription.metadata?.userId;

        if(userId){
          console.log(`Updating Pro status for user ${userId}: ${isActive}`);
          await setProActive(userId, isActive, null, null, serviceKey);
        } else {
          const resp = await supabaseRequest(
            `/rest/v1/pro_users?stripe_subscription_id=eq.${subscription.id}&select=id`,
            'GET', null, serviceKey
          );
          if(resp.body?.[0]?.id){
            await setProActive(resp.body[0].id, isActive, null, null, serviceKey);
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
