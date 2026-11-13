// team.js — team members for Pro Max (3 people), the API plan (6) and comp accounts.
//
// POST /.netlify/functions/team
//   Authorization: Bearer <Supabase access token>   (every action but 'preview' and 'decline')
//   { action: 'status' }                 what the Profile page shows, as owner or member
//   { action: 'invite', email, name }    owner: invite someone (sends them a join link)
//   { action: 'resend', id }             owner: send a pending invite again, with a new link
//   { action: 'remove', id }             owner: remove a member, or cancel an invite
//   { action: 'leave' }                  member: leave the team
//   { action: 'me', name, phone }        member: the name and phone on the quotes they send
//   { action: 'preview', token }         whoever has the link: who invited them, and which email
//   { action: 'accept', token }          join the team the link is for (signed in with that email)
//   { action: 'decline', token }         turn the invite down
//
// A member signs in with their own login and works in the owner's account: the owner's plan
// and daily limits, quote log, customers and company settings (the database's access rules
// and effective_account do this; see netlify/lib/account.js). The owner pays; members don't.
// Seats go in the order people joined, so if the owner moves to a smaller plan the latest
// joiners wait until someone leaves.
//
// The join link is the only way in: accounts aren't email-verified at sign-up, so being signed
// in with the invited address isn't proof of owning it. The link's token is stored hashed and
// works once, for INVITE_DAYS, for the address it was sent to.
//
// Responses: 200 { ... }   400 { error: 'invalid', field, message }   401 { error: 'auth' }
//            403 { error: 'plan' | 'email' | 'not_owner' }   404 { error: 'not_found' }
//            409 { error: 'full' | 'already' | 'other_team' | 'own_team' | 'plan_changed' }
//            410 { error: 'expired' }   429 { error: 'limit' }   502/503 { error: 'send' | 'not_configured' }
const crypto = require('crypto');
const { teamSize, PLAN_NAME } = require('../lib/plans');
const { effectiveAccount, onTeamSeat } = require('../lib/account');
const { buildInviteEmail, INVITE_DAYS } = require('../lib/team-email');
const { headerName } = require('../lib/quote-email');
const { siteBase } = require('../lib/site-url');

const SUPABASE_URL = process.env.SUPABASE_URL || 'https://xgrmbhmgcsbnazupfybd.supabase.co';
const FROM = '"QuickFreightCalc" <team@quickfreightcalc.com>';
const INVITES_PER_DAY = 20;
const RESEND_WAIT_MS = 5 * 60 * 1000;
const EMAIL_RE = /^[^\s@,;<>]+@[^\s@,;<>]+\.[^\s@,;<>]{2,}$/;
const TOKEN_RE = /^[A-Za-z0-9_-]{40,64}$/;

const json = (statusCode, body) => ({
  statusCode,
  headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  body: JSON.stringify(body),
});
const fail = (statusCode, error, message, extra = {}) => json(statusCode, { error, message, ...extra });
const tidy = (s, max) => String(s === null || s === undefined ? '' : s).replace(/[\r\n\t]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
const hash = (token) => crypto.createHash('sha256').update(token).digest('hex');
const localPart = (email) => String(email || '').split('@')[0];

function serviceKey() {
  return process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY || '';
}

async function db(path, { method = 'GET', body, prefer } = {}) {
  const key = serviceKey();
  const resp = await fetch(SUPABASE_URL + path, {
    method,
    headers: {
      apikey: key, Authorization: `Bearer ${key}`,
      ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      ...(prefer ? { Prefer: prefer } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await resp.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch (e) {}
  return { ok: resp.ok, status: resp.status, data };
}
const rows = (r) => (r && r.ok && Array.isArray(r.data) ? r.data : []);

async function authUser(token) {
  if (!token) return null;
  try {
    const resp = await fetch(`${SUPABASE_URL}/auth/v1/user`, { headers: { apikey: serviceKey(), Authorization: `Bearer ${token}` } });
    if (!resp.ok) return null;
    const u = await resp.json();
    return u && u.id ? u : null;
  } catch (e) { return null; }
}

const PRO_COLS = 'id,email,is_active,plan,comp,stripe_subscription_id,company_name,contact_name';
async function proRow(id) {
  return rows(await db(`/rest/v1/pro_users?id=eq.${encodeURIComponent(id)}&select=${PRO_COLS}`))[0] || null;
}
const isComp = (row) => !!row && row.is_active === true && (row.comp === true || !row.stripe_subscription_id);
// What the pages call the plan: 'max', 'api', 'comp', 'plus', 'pro', or null when inactive.
const planKey = (row) => (!row || row.is_active !== true ? null : isComp(row) ? 'comp' : (row.plan || 'pro'));
const ownerName = (row, email) => tidy(row && row.contact_name, 120) || tidy(row && row.company_name, 120) || localPart(email || (row && row.email));
const expired = (r) => r.status === 'invited' && (!r.invite_sent_at || Date.parse(r.invite_sent_at) < Date.now() - INVITE_DAYS * 86400000);

const TEAM_COLS = 'id,owner_id,email,member_id,status,name,phone,tag,invited_at,invite_sent_at,joined_at';
async function teamRows(ownerId) {
  return rows(await db(`/rest/v1/team_members?owner_id=eq.${encodeURIComponent(ownerId)}&select=${TEAM_COLS}&order=joined_at.asc.nullslast,id.asc`));
}
// Active members in seat order with seated flags, given the team size.
function seatOrder(list, size) {
  return list.filter((r) => r.status === 'active')
    .sort((a, b) => (Date.parse(a.joined_at) - Date.parse(b.joined_at)) || (a.id - b.id))
    .map((r, i) => ({ ...r, seated: i < size - 1 }));
}

// A short tag for a member's quote numbers (QFC-JL-20261113-1001), unique on the team.
function makeTag(name, email, taken) {
  const words = String(name || '').replace(/[^A-Za-z\s'-]/g, ' ').split(/[\s'-]+/).filter(Boolean);
  let base = words.length >= 2 ? words[0][0] + words[words.length - 1][0]
    : words.length === 1 ? words[0].slice(0, 2)
    : localPart(email).replace(/[^A-Za-z]/g, '').slice(0, 2);
  base = (base || 'TM').toUpperCase().slice(0, 3);
  if (!taken.has(base)) return base;
  for (let i = 2; i < 100; i++) if (!taken.has(base + i)) return base + i;
  return null;
}

async function sendInvite(event, { to, owner, plan, token, replyTo }) {
  const base = siteBase(event);
  const { subject, html, text } = buildInviteEmail({
    owner, email: to, plan, link: `${base}/signup.html?team_invite=${token}`,
    siteUrl: process.env.SITE_URL || 'https://quickfreightcalc.com', logoUrl: `${base}/email-logo.png`,
  });
  const payload = { from: FROM, to: [to], subject: tidy(subject, 200), html, text, tags: [{ name: 'kind', value: 'team_invite' }] };
  if (replyTo && EMAIL_RE.test(replyTo)) payload.reply_to = replyTo;
  try {
    const resp = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${process.env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    if (!resp.ok) console.error('[team] Resend returned', resp.status);
    return resp.ok;
  } catch (e) {
    console.error('[team] Resend request failed:', e.message);
    return false;
  }
}

// ── Owner ──────────────────────────────────────────────────────────────────
function memberView(r) {
  return {
    id: r.id, email: r.email, name: r.name || null, status: r.status,
    seated: r.status === 'active' ? r.seated !== false : undefined,
    joinedAt: r.joined_at || null, invitedAt: r.invite_sent_at || r.invited_at || null,
    expired: expired(r) || undefined,
  };
}

async function ownerStatus(user, row, acct) {
  const size = teamSize(row);
  const list = await teamRows(user.id);
  const active = seatOrder(list, size);
  const invited = list.filter((r) => r.status === 'invited');
  return {
    role: list.length ? 'owner' : null,
    plan: planKey(row),
    size,
    used: 1 + active.length + invited.length,
    canInvite: size > 1 && acct.role !== 'member',
    onOtherTeam: acct.role === 'member',
    members: [...active, ...invited].map(memberView),
    me: { email: user.email || null, name: (row && row.contact_name) || null },
  };
}

async function invite(event, user, body, existingId) {
  const acct = await effectiveAccount(user.id, serviceKey());
  if (!acct) return fail(502, 'send', 'Couldn’t check your account right now. Try again in a minute.');
  if (acct.role === 'member') return fail(409, 'other_team', 'You’re on someone else’s team. Leave it before adding your own team.');
  const row = await proRow(user.id);
  const size = teamSize(row);
  if (size <= 1) return fail(403, 'plan', 'Team members come with Pro Max (3 people) and the API plan (6 people).');
  if (!process.env.RESEND_API_KEY) return fail(503, 'not_configured', 'Inviting people isn’t available right now.');

  const list = await teamRows(user.id);
  let existing = null, email, name;
  if (existingId) {
    existing = list.find((r) => String(r.id) === String(existingId) && r.status === 'invited');
    if (!existing) return fail(404, 'not_found', 'That invite isn’t there any more.');
    email = existing.email;
    name = existing.name;
  } else {
    email = tidy(body.email, 250).toLowerCase();
    if (!email || email.length > 200 || !EMAIL_RE.test(email)) return fail(400, 'invalid', 'Enter their email address.', { field: 'email' });
    if (email === String(user.email || '').toLowerCase()) return fail(400, 'invalid', 'That’s your own email. Invite someone else.', { field: 'email' });
    name = tidy(body.name, 120) || null;
    existing = list.find((r) => r.email === email) || null;
    if (existing && existing.status === 'active') return fail(409, 'already', `${existing.name || email} is already on your team.`);
  }
  const taken = list.filter((r) => r.status === 'active' || (r.status === 'invited' && r !== existing)).length;
  if (!existing && 1 + taken >= size) {
    return fail(409, 'full', `Your team is full: ${size} people on ${PLAN_NAME[row.plan] && !isComp(row) ? PLAN_NAME[row.plan] : 'your plan'}. Remove someone to invite another person.`);
  }
  if (existing && existing.invite_sent_at && Date.now() - Date.parse(existing.invite_sent_at) < RESEND_WAIT_MS) {
    return fail(429, 'limit', 'The invite was just sent. Give it a few minutes before sending it again.');
  }
  const since = new Date(Date.now() - 24 * 3600000).toISOString();
  const sends = rows(await db(`/rest/v1/team_invite_sends?owner_id=eq.${user.id}&sent_at=gte.${encodeURIComponent(since)}&select=id`));
  if (sends.length >= INVITES_PER_DAY) return fail(429, 'limit', `You’ve sent ${INVITES_PER_DAY} invites in the last 24 hours. Try again tomorrow.`);

  const token = crypto.randomBytes(32).toString('base64url');
  const now = new Date().toISOString();
  let saved;
  if (existing) {
    saved = await db(`/rest/v1/team_members?id=eq.${existing.id}&status=eq.invited`, {
      method: 'PATCH', prefer: 'return=representation',
      body: { invite_token_hash: hash(token), invite_sent_at: now, ...(name && !existing.name ? { name } : {}) },
    });
  } else {
    saved = await db('/rest/v1/team_members', {
      method: 'POST', prefer: 'return=representation',
      body: { owner_id: user.id, email, name, status: 'invited', invite_token_hash: hash(token), invited_at: now, invite_sent_at: now },
    });
  }
  const savedRow = rows(saved)[0];
  if (!savedRow) {
    console.error('[team] saving the invite failed', saved.status, JSON.stringify(saved.data));
    return fail(502, 'send', 'Couldn’t send the invite right now. Try again in a minute.');
  }

  const ok = await sendInvite(event, {
    to: email, plan: planKey(row), token, replyTo: String(user.email || row.email || '').toLowerCase(),
    owner: { name: headerName(row.contact_name, 80) || localPart(user.email), company: headerName(row.company_name, 80) },
  });
  if (!ok) {
    if (!existing) await db(`/rest/v1/team_members?id=eq.${savedRow.id}&status=eq.invited`, { method: 'DELETE' });
    return fail(502, 'send', 'The invite email couldn’t be sent. Check the address and try again.');
  }
  await db('/rest/v1/team_invite_sends', { method: 'POST', prefer: 'return=minimal', body: { owner_id: user.id, email } });
  return json(200, { status: 'invited', member: memberView(savedRow) });
}

async function remove(user, body) {
  const id = String(body.id || '');
  if (!/^\d{1,19}$/.test(id)) return fail(400, 'invalid', 'Pick someone to remove.', { field: 'id' });
  const r = await db(`/rest/v1/team_members?id=eq.${id}&owner_id=eq.${user.id}`, { method: 'DELETE', prefer: 'return=representation' });
  if (!r.ok) return fail(502, 'send', 'Couldn’t remove them right now. Try again in a minute.');
  if (!rows(r).length) return fail(404, 'not_found', 'They’re not on your team any more.');
  return json(200, { status: 'removed', id: Number(id) });
}

// ── Member ─────────────────────────────────────────────────────────────────
async function memberStatus(user, acct) {
  const me = rows(await db(`/rest/v1/team_members?member_id=eq.${user.id}&status=eq.active&select=${TEAM_COLS}`))[0];
  if (!me) return null;
  const owner = await proRow(me.owner_id);
  const size = teamSize(owner);
  const people = seatOrder(await teamRows(me.owner_id), size);
  // Someone still paying for their own plan doesn't need it while on a team
  const own = await proRow(user.id);
  const ownPaid = own && own.is_active === true && !!own.stripe_subscription_id && own.comp !== true;
  return {
    role: 'member',
    seated: acct.seated,
    ownPlan: ownPaid ? own.plan : null,
    team: {
      company: tidy(owner && owner.company_name, 120) || null,
      ownerName: ownerName(owner),
      plan: planKey(owner),
      size,
    },
    me: { name: me.name || null, phone: me.phone || null, email: user.email || null, tag: me.tag || null, joinedAt: me.joined_at },
    people: [{ name: ownerName(owner), owner: true },
      ...people.map((p) => ({ name: p.name || localPart(p.email), you: p.member_id === user.id, seated: p.seated }))],
  };
}

async function leave(user) {
  const r = await db(`/rest/v1/team_members?member_id=eq.${user.id}&status=eq.active`, { method: 'DELETE', prefer: 'return=representation' });
  if (!r.ok) return fail(502, 'send', 'Couldn’t leave the team right now. Try again in a minute.');
  if (!rows(r).length) return fail(404, 'not_found', 'You’re not on a team.');
  return json(200, { status: 'left' });
}

async function updateMe(user, body) {
  const name = tidy(body.name, 200);
  const phone = tidy(body.phone, 60);
  if (name.length > 120) return fail(400, 'invalid', 'Keep your name under 120 characters.', { field: 'name' });
  if (phone.length > 40) return fail(400, 'invalid', 'Keep the phone number under 40 characters.', { field: 'phone' });
  const r = await db(`/rest/v1/team_members?member_id=eq.${user.id}&status=eq.active`, {
    method: 'PATCH', prefer: 'return=representation', body: { name: name || null, phone: phone || null },
  });
  if (!r.ok) return fail(502, 'send', 'Couldn’t save that right now. Try again in a minute.');
  if (!rows(r).length) return fail(404, 'not_found', 'You’re not on a team.');
  return json(200, { status: 'saved', me: { name: name || null, phone: phone || null } });
}

// ── Invite links ───────────────────────────────────────────────────────────
async function inviteByToken(token) {
  if (!TOKEN_RE.test(String(token || ''))) return null;
  return rows(await db(`/rest/v1/team_members?invite_token_hash=eq.${hash(token)}&status=eq.invited&select=${TEAM_COLS}`))[0] || null;
}

async function preview(body) {
  const inv = await inviteByToken(body.token);
  if (!inv) return fail(404, 'not_found', 'This invite link isn’t valid any more. Ask whoever invited you to send a new one.');
  const owner = await proRow(inv.owner_id);
  return json(200, {
    email: inv.email,
    name: inv.name || null,
    company: tidy(owner && owner.company_name, 120) || null,
    ownerName: ownerName(owner),
    plan: planKey(owner),
    expired: expired(inv),
  });
}

async function accept(user, body) {
  const inv = await inviteByToken(body.token);
  if (!inv) return fail(404, 'not_found', 'This invite link isn’t valid any more. Ask whoever invited you to send a new one.');
  if (expired(inv)) return fail(410, 'expired', 'This invite has expired. Ask whoever invited you to send a new one.');
  if (String(user.email || '').toLowerCase() !== inv.email) {
    return fail(403, 'email', `This invite is for ${inv.email}. Sign in with that email to join.`, { email: inv.email });
  }
  if (inv.owner_id === user.id) return fail(409, 'own_team', 'That’s your own team.');

  const acct = await effectiveAccount(user.id, serviceKey());
  if (!acct) return fail(502, 'send', 'Couldn’t check your account right now. Try again in a minute.');
  if (acct.role === 'member') {
    const mine = rows(await db(`/rest/v1/team_members?member_id=eq.${user.id}&status=eq.active&select=owner_id`))[0];
    if (mine && mine.owner_id === inv.owner_id) return json(200, { status: 'joined', already: true });
    return fail(409, 'other_team', 'You’re already on another team. Leave it from your profile first.');
  }
  const ownList = await teamRows(user.id);
  if (ownList.length) return fail(409, 'own_team', 'You have your own team. Remove its members and invites from your profile first.');

  const owner = await proRow(inv.owner_id);
  const size = teamSize(owner);
  if (size <= 1) return fail(409, 'plan_changed', 'This team’s plan doesn’t include team members right now. Ask whoever invited you.');
  const list = await teamRows(inv.owner_id);
  const active = list.filter((r) => r.status === 'active');
  if (1 + active.length >= size) return fail(409, 'full', 'This team is full. Ask whoever invited you to make room.');

  const own = await proRow(user.id);
  const name = inv.name || tidy(own && own.contact_name, 120) || null;
  const tag = makeTag(name, inv.email, new Set(list.map((r) => r.tag).filter(Boolean)));
  const joined = await db(`/rest/v1/team_members?id=eq.${inv.id}&status=eq.invited`, {
    method: 'PATCH', prefer: 'return=representation',
    body: { member_id: user.id, status: 'active', joined_at: new Date().toISOString(), invite_token_hash: null, name, tag },
  });
  if (!rows(joined).length) {
    if (joined.status === 409) return fail(409, 'other_team', 'You’re already on another team. Leave it from your profile first.');
    console.error('[team] accepting failed', joined.status, JSON.stringify(joined.data));
    return fail(502, 'send', 'Couldn’t join the team right now. Try again in a minute.');
  }
  // Two people taking the last seat at once: the later one gives it back.
  const check = await effectiveAccount(user.id, serviceKey());
  if (check && !check.seated) {
    await db(`/rest/v1/team_members?id=eq.${inv.id}`, {
      method: 'PATCH', body: { member_id: null, status: 'invited', joined_at: null, tag: null, invite_token_hash: hash(body.token) },
    });
    return fail(409, 'full', 'This team is full. Ask whoever invited you to make room.');
  }
  const ownPaid = own && own.is_active === true && !!own.stripe_subscription_id && !own.comp;
  return json(200, {
    status: 'joined',
    team: { company: tidy(owner.company_name, 120) || null, ownerName: ownerName(owner), plan: planKey(owner) },
    ownPlan: ownPaid ? own.plan : null,
  });
}

async function decline(body) {
  if (!TOKEN_RE.test(String(body.token || ''))) return fail(404, 'not_found', 'This invite link isn’t valid any more.');
  await db(`/rest/v1/team_members?invite_token_hash=eq.${hash(body.token)}&status=eq.invited`, { method: 'DELETE' });
  return json(200, { status: 'declined' });
}

// ── Handler ────────────────────────────────────────────────────────────────
exports.handler = async function (event) {
  if (event.httpMethod !== 'POST') return fail(405, 'method', 'Use POST.');
  if (!serviceKey()) return fail(503, 'not_configured', 'Teams aren’t available right now.');
  let body;
  try { body = JSON.parse((event.isBase64Encoded ? Buffer.from(event.body || '', 'base64').toString('utf8') : event.body) || '{}'); } catch (e) { body = null; }
  if (!body || typeof body !== 'object') return fail(400, 'invalid', 'The request wasn’t readable. Try again.');
  const action = String(body.action || '');

  if (action === 'preview') return preview(body);
  if (action === 'decline') return decline(body);

  const auth = (event.headers && (event.headers.authorization || event.headers.Authorization)) || '';
  const user = await authUser(auth.startsWith('Bearer ') ? auth.slice(7).trim() : '');
  if (!user) return fail(401, 'auth', 'Sign in again to manage your team.');

  try {
    switch (action) {
      case 'status': {
        const acct = await effectiveAccount(user.id, serviceKey());
        if (!acct) return fail(502, 'send', 'Couldn’t load your team right now. Try again in a minute.');
        if (acct.role === 'member') {
          const m = await memberStatus(user, acct);
          if (m) return json(200, m);
        }
        return json(200, await ownerStatus(user, await proRow(user.id), acct));
      }
      case 'invite': return await invite(event, user, body);
      case 'resend': return await invite(event, user, body, body.id);
      case 'remove': return await remove(user, body);
      case 'leave': return await leave(user);
      case 'me': return await updateMe(user, body);
      case 'accept': return await accept(user, body);
      default: return fail(400, 'invalid', 'Unknown action.', { field: 'action' });
    }
  } catch (e) {
    console.error('[team]', action, e && e.message);
    return fail(502, 'send', 'Something went wrong. Try again in a minute.');
  }
};

// For tests
exports._internal = { makeTag, seatOrder, planKey, expired, hash, TOKEN_RE };
