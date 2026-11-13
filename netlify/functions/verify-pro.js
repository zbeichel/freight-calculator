// netlify/functions/verify-pro.js
// Server-side Pro status verification — cannot be faked by client-side JS
// Called from Pro pages on load to verify the user has an active subscription:
// their own, or their team owner's while they have a seat on the team (team.js).
// A team member gets the owner's plan but none of the owner's billing details.

const https = require('https');
const { normalizePlan, legacyUnlimited, NEW_PLANS_START } = require('../lib/plans.js');
const { effectiveAccount, onTeamSeat } = require('../lib/account.js');

const SUPABASE_URL = 'https://xgrmbhmgcsbnazupfybd.supabase.co';

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

    // The account this person quotes on (service key, authoritative): their own
    // pro_users row, or their team owner's while they have a team seat.
    const acct = await effectiveAccount(userId, serviceKey);
    if(!acct){
      return { statusCode: 200, body: JSON.stringify({ active: false, reason: 'Verification failed' }) };
    }
    const member = onTeamSeat(acct);
    const row = acct.row || {};
    const isActive = row.is_active === true;
    const plan = normalizePlan(row.plan);
    // Subscribers on the original Pro plan keep unlimited quotes until their
    // first bill on or after January 1, 2027; the pages use this to show the
    // change notice. nextPlan is the plan they move to then (Pro by default).
    // Someone who has already moved to the API plan has nothing left to choose.
    // Billing notices are the owner's business, not their team members'.
    const unlimitedUntilRenewal = !member && isActive && plan !== 'api' && legacyUnlimited(row);

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        active: isActive,
        plan,
        unlimitedUntilRenewal,
        nextPlan: unlimitedUntilRenewal ? normalizePlan(row.next_plan) : null,
        newPlansStart: new Date(NEW_PLANS_START).toISOString(),
        paid: !member && !!row.stripe_subscription_id,
        renewsAt: member ? null : (row.renews_at || null),
        // role 'owner' | 'member'; a member without a seat isn't active on the team's plan
        team: acct.role ? { role: acct.role, seated: acct.role === 'member' ? acct.seated : true, size: acct.teamSize } : null,
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
