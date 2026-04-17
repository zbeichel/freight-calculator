// netlify/functions/stripe-webhook.js
// Handles Stripe events — activates/deactivates Pro based on subscription status

const https = require('https');
const crypto = require('crypto');

const SUPABASE_URL = 'https://xgrmbhmgcsbnazupfybd.supabase.co';

function supabaseRequest(path, method, data, serviceKey){
  const body = JSON.stringify(data);
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
        'Prefer': 'return=minimal',
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

  return supabaseRequest(
    `/rest/v1/pro_users?id=eq.${userId}`,
    'PATCH',
    updateData,
    serviceKey
  );
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

        console.log(`Activating Pro for user ${userId}`);
        await setProActive(userId, true, customerId, subscriptionId, serviceKey);
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
