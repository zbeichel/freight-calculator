// netlify/functions/create-checkout.js
// Creates a Stripe checkout session for Pro subscription

const https = require('https');

const SUPABASE_URL = 'https://xgrmbhmgcsbnazupfybd.supabase.co';

// Verify the Supabase access token and return the authenticated user id, or null.
function verifyUser(accessToken){
  return new Promise((resolve) => {
    if(!accessToken){ resolve(null); return; }
    const serviceKey = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;
    const url = new URL(`${SUPABASE_URL}/auth/v1/user`);
    https.get({
      hostname: url.hostname,
      path: url.pathname,
      headers: { 'apikey': serviceKey, 'Authorization': `Bearer ${accessToken}` }
    }, res => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => {
        try { const b = JSON.parse(d); resolve(res.statusCode === 200 && b && b.id ? b.id : null); }
        catch(e){ resolve(null); }
      });
    }).on('error', () => resolve(null));
  });
}

function stripeRequest(path, method, data){
  const secretKey = process.env.STRIPE_SECRET_KEY;
  const body = new URLSearchParams(data).toString();
  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: 'api.stripe.com',
      path,
      method,
      headers: {
        'Authorization': `Bearer ${secretKey}`,
        'Content-Type': 'application/x-www-form-urlencoded',
        'Content-Length': Buffer.byteLength(body),
      }
    }, res => {
      let d = '';
      res.on('data', chunk => d += chunk);
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(d) }); }
        catch(e){ resolve({ status: res.statusCode, body: d }); }
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

exports.handler = async function(event){
  if(event.httpMethod !== 'POST'){
    return { statusCode: 405, body: 'Method not allowed' };
  }

  const { userId, email, accessToken } = JSON.parse(event.body || '{}');
  if(!userId || !email || !accessToken){
    return { statusCode: 400, body: JSON.stringify({ error: 'Missing credentials' }) };
  }

  // A user may only start checkout for their own account.
  const verifiedId = await verifyUser(accessToken);
  if(!verifiedId || verifiedId !== userId){
    return { statusCode: 401, body: JSON.stringify({ error: 'Unauthorized' }) };
  }

  const priceId = process.env.STRIPE_PRICE_ID;
  const siteUrl = process.env.DEPLOY_URL && process.env.DEPLOY_URL.includes('dev--')
    ? process.env.DEPLOY_URL
    : 'https://quickfreightcalc.com';

  try {
    const resp = await stripeRequest('/v1/checkout/sessions', 'POST', {
      'mode': 'subscription',
      'allow_promotion_codes': 'true',
      'line_items[0][price]': priceId,
      'line_items[0][quantity]': '1',
      'customer_email': email,
      'client_reference_id': userId,
      'success_url': `${siteUrl}/?checkout=success`,
      'cancel_url': `${siteUrl}/signup.html?checkout=cancelled`,
      'subscription_data[metadata][userId]': userId,
      'metadata[userId]': userId,
    });

    if(resp.body.error){
      return { statusCode: 400, body: JSON.stringify({ error: resp.body.error.message }) };
    }

    return {
      statusCode: 200,
      body: JSON.stringify({ url: resp.body.url })
    };
  } catch(err){
    console.error('create-checkout error:', err);
    return { statusCode: 500, body: JSON.stringify({ error: err.message }) };
  }
};
