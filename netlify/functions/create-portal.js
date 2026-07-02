// netlify/functions/create-portal.js
// Creates a Stripe billing portal session so users can manage/cancel their subscription

const https = require('https');

const SUPABASE_URL = 'https://xgrmbhmgcsbnazupfybd.supabase.co';

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

// Verify the Supabase access token and return the authenticated user id, or
// null. This is what stops one user from opening another user's billing portal.
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

async function getStripeCustomerId(userId){
  const serviceKey = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;
  return new Promise((resolve, reject) => {
    const url = new URL(`${SUPABASE_URL}/rest/v1/pro_users?id=eq.${userId}&select=stripe_customer_id`);
    https.get({
      hostname: url.hostname,
      path: url.pathname + url.search,
      headers: {
        'apikey': serviceKey,
        'Authorization': `Bearer ${serviceKey}`,
      }
    }, res => {
      let d = '';
      res.on('data', chunk => d += chunk);
      res.on('end', () => {
        try {
          const rows = JSON.parse(d);
          resolve(rows?.[0]?.stripe_customer_id || null);
        } catch(e){ resolve(null); }
      });
    }).on('error', reject);
  });
}

exports.handler = async function(event){
  if(event.httpMethod !== 'POST'){
    return { statusCode: 405, body: 'Method not allowed' };
  }

  const { userId, accessToken } = JSON.parse(event.body || '{}');
  if(!userId || !accessToken){
    return { statusCode: 400, body: JSON.stringify({ error: 'Missing credentials' }) };
  }

  // Only the authenticated owner of this userId may open the billing portal.
  const verifiedId = await verifyUser(accessToken);
  if(!verifiedId || verifiedId !== userId){
    return { statusCode: 401, body: JSON.stringify({ error: 'Unauthorized' }) };
  }

  // Set SITE_URL in Netlify env vars. Swap to https://quickfreightcalc.com before going live.
  const siteUrl = process.env.SITE_URL || 'https://dev--quickfreightcalculator.netlify.app';

  try {
    const customerId = await getStripeCustomerId(userId);
    if(!customerId){
      return { statusCode: 400, body: JSON.stringify({ error: 'No Stripe customer found for this user' }) };
    }

    const resp = await stripeRequest('/v1/billing_portal/sessions', 'POST', {
      'customer': customerId,
      'return_url': `${siteUrl}/profile.html`,
    });

    if(resp.body.error){
      return { statusCode: 400, body: JSON.stringify({ error: resp.body.error.message }) };
    }

    return {
      statusCode: 200,
      body: JSON.stringify({ url: resp.body.url })
    };
  } catch(err){
    console.error('create-portal error:', err);
    return { statusCode: 500, body: JSON.stringify({ error: err.message }) };
  }
};
