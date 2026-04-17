// netlify/functions/create-checkout.js
// Creates a Stripe checkout session for Pro subscription

const https = require('https');

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

  const { userId, email } = JSON.parse(event.body || '{}');
  if(!userId || !email){
    return { statusCode: 400, body: JSON.stringify({ error: 'Missing userId or email' }) };
  }

  const priceId = process.env.STRIPE_PRICE_ID;
  // Use DEPLOY_URL for branch deploys, URL for production
  const siteUrl = process.env.DEPLOY_URL || process.env.URL || 'https://quickfreightcalc.com';

  try {
    const resp = await stripeRequest('/v1/checkout/sessions', 'POST', {
      'mode': 'subscription',
      'line_items[0][price]': priceId,
      'line_items[0][quantity]': '1',
      'customer_email': email,
      'client_reference_id': userId,
      'success_url': `${siteUrl}/profile.html?checkout=success`,
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
