// netlify/functions/verify-pro.js
// Server-side Pro status verification — cannot be faked by client-side JS
// Called from Pro pages on load to verify the user has an active subscription

const https = require('https');
const { normalizePlan, legacyUnlimited, NEW_PLANS_START } = require('../lib/plans.js');

const SUPABASE_URL = 'https://xgrmbhmgcsbnazupfybd.supabase.co';

function supabaseRequest(path, serviceKey){
  return new Promise((resolve, reject) => {
    const url = new URL(SUPABASE_URL + path);
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
        try { resolve({ status: res.statusCode, body: JSON.parse(d) }); }
        catch(e){ resolve({ status: res.statusCode, body: d }); }
      });
    }).on('error', reject);
  });
}

exports.handler = async function(event){
  if(event.httpMethod !== 'POST'){
    return { statusCode: 405, body: 'Method not allowed' };
  }

  const serviceKey = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;
  if(!serviceKey){
    return { statusCode: 500, body: JSON.stringify({ error: 'Server configuration error' }) };
  }

  let userId, accessToken;
  try {
    const body = JSON.parse(event.body || '{}');
    userId      = body.userId;
    accessToken = body.accessToken;
  } catch(e){
    return { statusCode: 400, body: JSON.stringify({ error: 'Invalid request' }) };
  }

  if(!userId || !accessToken){
    return { statusCode: 400, body: JSON.stringify({ active: false, reason: 'Missing credentials' }) };
  }

  try {
    // First verify the access token is valid by checking Supabase auth
    const authResp = await new Promise((resolve, reject) => {
      const url = new URL(`${SUPABASE_URL}/auth/v1/user`);
      https.get({
        hostname: url.hostname,
        path: url.pathname,
        headers: {
          'apikey': process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY,
          'Authorization': `Bearer ${accessToken}`,
        }
      }, res => {
        let d = '';
        res.on('data', chunk => d += chunk);
        res.on('end', () => {
          try { resolve({ status: res.statusCode, body: JSON.parse(d) }); }
          catch(e){ resolve({ status: res.statusCode, body: {} }); }
        });
      }).on('error', reject);
    });

    // Token must be valid and match the claimed userId
    if(authResp.status !== 200 || authResp.body?.id !== userId){
      return {
        statusCode: 200,
        body: JSON.stringify({ active: false, reason: 'Invalid session' })
      };
    }

    // Now check pro_users with service key — bypasses RLS, authoritative
    const resp = await supabaseRequest(
      `/rest/v1/pro_users?id=eq.${userId}&select=is_active,plan,next_plan,grandfathered,billing_period_start,renews_at,stripe_subscription_id`,
      serviceKey
    );

    const row = resp.body?.[0] || {};
    const isActive = row.is_active === true;
    const plan = normalizePlan(row.plan);
    // Subscribers on the original Pro plan keep unlimited quotes until their
    // first bill on or after January 1, 2027; the pages use this to show the
    // change notice. nextPlan is the plan they move to then (Pro by default).
    // Someone who has already moved to the API plan has nothing left to choose.
    const unlimitedUntilRenewal = isActive && plan !== 'api' && legacyUnlimited(row);

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        active: isActive,
        plan,
        unlimitedUntilRenewal,
        nextPlan: unlimitedUntilRenewal ? normalizePlan(row.next_plan) : null,
        newPlansStart: new Date(NEW_PLANS_START).toISOString(),
        paid: !!row.stripe_subscription_id,
        renewsAt: row.renews_at || null,
      })
    };

  } catch(err){
    console.error('verify-pro error:', err);
    return {
      statusCode: 200,
      body: JSON.stringify({ active: false, reason: 'Verification failed' })
    };
  }
};
