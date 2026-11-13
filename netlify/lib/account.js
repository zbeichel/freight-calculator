// account.js — which subscription a signed-in person's quoting runs on.
//
// Someone with a seat on a team (team.js) quotes on the team owner's plan, in the owner's
// workspace: the owner's daily limits, quote log, customers and company settings. Everyone
// else uses their own account. The database decides (public.effective_account, callable
// only with the service key), so the functions and the access rules can't disagree.
//
// effectiveAccount(uid) resolves to:
//   { accountId,             whose plan, limits, quotes and customers apply
//     role,                  'owner' (has members or invites), 'member', or null
//     seated,                true while a member has a seat on the owner's plan
//     ownerId,               the team owner, for a member
//     memberName, memberPhone,  a member's own details for the quotes they send
//     teamSize,              people allowed on the team (1 = no team)
//     row }                  the plan row (is_active, plan, comp, stripe_subscription_id,
//                            grandfathered, billing_period_start, renews_at, next_plan,
//                            email, company_name, contact_name, phone, pdf_white_label) or null
// or null if the database couldn't be reached.

const SUPABASE_URL = process.env.SUPABASE_URL || 'https://xgrmbhmgcsbnazupfybd.supabase.co';

function serviceKey() {
  return process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY || '';
}

async function effectiveAccount(uid, key = serviceKey()) {
  if (!uid || !key) return null;
  try {
    const resp = await fetch(`${SUPABASE_URL}/rest/v1/rpc/effective_account`, {
      method: 'POST',
      headers: { apikey: key, Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ p_uid: uid }),
    });
    if (!resp.ok) return null;
    const a = await resp.json();
    if (!a || typeof a !== 'object' || !a.account_id) return null;
    return {
      accountId: a.account_id,
      role: a.role || null,
      seated: a.seated === true,
      ownerId: a.owner_id || null,
      memberName: a.member_name || null,
      memberPhone: a.member_phone || null,
      teamSize: Number(a.team_size) || 1,
      row: a.row && typeof a.row === 'object' ? a.row : null,
    };
  } catch (e) {
    return null;
  }
}

// True when this person quotes on someone else's (their team owner's) plan.
function onTeamSeat(acct) {
  return !!acct && acct.role === 'member' && acct.seated === true;
}

module.exports = { effectiveAccount, onTeamSeat, SUPABASE_URL };
