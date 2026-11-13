// Team members: the team function (invite, accept, remove, leave, status) and the invite email,
// against a fake Supabase (team_members, pro_users, team_invite_sends, effective_account) and a
// fake Resend.
//   node tests/team_test.js
const path = require('path');
const crypto = require('crypto');
const ROOT = path.resolve(__dirname, '..');

let failures = 0;
const check = (label, cond, detail) => { console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}${detail && !cond ? '  — ' + detail : ''}`); if (!cond) failures++; };

process.env.RESEND_API_KEY = 're_test_key';
process.env.SUPABASE_SERVICE_KEY = 'service-key';
process.env.SUPABASE_URL = 'https://sb.example';
const { handler, _internal } = require(path.join(ROOT, 'netlify/functions/team.js'));
const { buildInviteEmail } = require(path.join(ROOT, 'netlify/lib/team-email.js'));
const { teamSize } = require(path.join(ROOT, 'netlify/lib/plans.js'));
const sha = (t) => crypto.createHash('sha256').update(t).digest('hex');

// ── Fake services ──────────────────────────────────────────────────────────
let db, calls, resendStatus;
function reset() {
  calls = [];
  resendStatus = 200;
  db = {
    users: {
      'tok-sam': { id: 'u-sam', email: 'sam@keystone.example' },
      'tok-jo': { id: 'u-jo', email: 'jo@keystone.example' },
      'tok-max': { id: 'u-max', email: 'max@keystone.example' },
      'tok-ann': { id: 'u-ann', email: 'ann@keystone.example' },
      'tok-pat': { id: 'u-pat', email: 'pat@elsewhere.example' },
    },
    pro: {
      'u-sam': { id: 'u-sam', email: 'sam@keystone.example', is_active: true, plan: 'max', comp: false, stripe_subscription_id: 'sub_sam', company_name: 'Keystone Produce Logistics', contact_name: 'Sam Rivera' },
    },
    team: [],      // team_members rows
    sends: [],     // team_invite_sends rows
    nextId: 1,
  };
}
// As the database: seats go in join order, up to teamSize(owner) - 1 members.
function seatedOwner(uid) {
  const m = db.team.find((r) => r.member_id === uid && r.status === 'active');
  if (!m) return null;
  const before = db.team.filter((o) => o.owner_id === m.owner_id && o.status === 'active'
    && (Date.parse(o.joined_at) < Date.parse(m.joined_at) || (o.joined_at === m.joined_at && o.id < m.id))).length;
  return before < teamSize(db.pro[m.owner_id]) - 1 ? m.owner_id : null;
}
function filterRows(rows, params) {
  let out = rows;
  for (const [k, v] of params) {
    if (['select', 'order', 'limit'].includes(k)) continue;
    const [op, ...rest] = v.split('.');
    const val = rest.join('.');
    out = out.filter((r) => {
      const x = r[k] === null || r[k] === undefined ? null : String(r[k]);
      if (op === 'eq') return x === val;
      if (op === 'gte') return x !== null && Date.parse(x) >= Date.parse(val);
      return true;
    });
  }
  return out;
}
global.fetch = async (url, init = {}) => {
  const u = new URL(url);
  const method = init.method || 'GET';
  const headers = init.headers || {};
  const body = init.body ? JSON.parse(init.body) : undefined;
  calls.push({ url, method, headers, body });
  const reply = (status, data) => ({ ok: status >= 200 && status < 300, status, json: async () => data, text: async () => (data === undefined ? '' : JSON.stringify(data)) });
  if (u.host === 'api.resend.com') return reply(resendStatus, resendStatus === 200 ? { id: 'em_' + calls.length } : { message: 'nope' });
  if (u.pathname === '/auth/v1/user') {
    const tok = (headers.Authorization || '').replace('Bearer ', '');
    return db.users[tok] ? reply(200, db.users[tok]) : reply(401, { msg: 'bad jwt' });
  }
  if (u.pathname === '/rest/v1/rpc/effective_account') {
    const uid = body.p_uid;
    const owner = seatedOwner(uid);
    const m = db.team.find((r) => r.member_id === uid && r.status === 'active');
    return reply(200, {
      account_id: owner || uid,
      role: m ? 'member' : db.team.some((t) => t.owner_id === uid) ? 'owner' : null,
      seated: !!owner, owner_id: m ? m.owner_id : null, member_name: m ? m.name : null, member_phone: m ? m.phone : null,
      team_size: teamSize(db.pro[m ? m.owner_id : uid]), row: db.pro[owner || uid] || null,
    });
  }
  if (u.pathname === '/rest/v1/pro_users') {
    return reply(200, filterRows(Object.values(db.pro), u.searchParams));
  }
  if (u.pathname === '/rest/v1/team_invite_sends') {
    if (method === 'POST') { db.sends.push({ ...body, sent_at: new Date().toISOString() }); return reply(201); }
    return reply(200, filterRows(db.sends, u.searchParams));
  }
  if (u.pathname === '/rest/v1/team_members') {
    const want = (headers.Prefer || '').includes('return=representation');
    if (method === 'GET') {
      const rows = filterRows(db.team, u.searchParams).slice()
        .sort((a, b) => (a.joined_at ? Date.parse(a.joined_at) : Infinity) - (b.joined_at ? Date.parse(b.joined_at) : Infinity) || a.id - b.id);
      return reply(200, rows.map((r) => ({ ...r })));
    }
    if (method === 'POST') {
      if (db.team.some((r) => r.owner_id === body.owner_id && r.email === body.email)) return reply(409, { code: '23505' });
      const row = { id: db.nextId++, member_id: null, phone: null, tag: null, joined_at: null, ...body };
      db.team.push(row);
      return reply(201, want ? [{ ...row }] : undefined);
    }
    const hits = filterRows(db.team, u.searchParams);
    if (method === 'PATCH') {
      if (body.status === 'active' && db.beforeJoin) { const f = db.beforeJoin; db.beforeJoin = null; f(); }
      if (body.member_id && db.team.some((r) => r.member_id === body.member_id && !hits.includes(r))) return reply(409, { code: '23505' });
      hits.forEach((r) => Object.assign(r, body));
      return reply(200, want ? hits.map((r) => ({ ...r })) : undefined);
    }
    if (method === 'DELETE') {
      db.team = db.team.filter((r) => !hits.includes(r));
      return reply(200, want ? hits.map((r) => ({ ...r })) : undefined);
    }
  }
  return reply(404, { message: 'unexpected ' + url });
};

const call = (action, extra = {}, { token = 'tok-sam', host } = {}) => handler({
  httpMethod: 'POST',
  headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(host ? { host } : {}) },
  body: JSON.stringify({ action, ...extra }),
});
const out = (r) => { try { return JSON.parse(r.body); } catch (e) { return {}; } };
const resendCalls = () => calls.filter((c) => c.url.startsWith('https://api.resend.com'));
const lastLink = () => { const c = resendCalls().pop(); const m = c && c.body.text.match(/team_invite=([A-Za-z0-9_-]+)/); return m ? m[1] : null; };
// Joins someone straight into a team (as accepting would), joined `daysAgo` days ago
function seat(owner, uid, email, name, daysAgo) {
  db.team.push({ id: db.nextId++, owner_id: owner, email, member_id: uid, status: 'active', name, phone: null, tag: null,
    invited_at: new Date().toISOString(), invite_sent_at: null, joined_at: new Date(Date.now() - daysAgo * 86400000).toISOString() });
}

(async () => {
  console.log('=== Status ===');
  reset();
  let r = await call('status');
  let s = out(r);
  check('a Pro Max owner with no team: 1 of 3 people, can invite', r.statusCode === 200 && s.role === null && s.size === 3 && s.used === 1 && s.canInvite === true && s.plan === 'max', r.body);
  db.pro['u-sam'].plan = 'plus';
  s = out(await call('status'));
  check('Pro Plus: no team (size 1), can’t invite', s.size === 1 && s.canInvite === false);
  db.pro['u-sam'].plan = 'api';
  check('API: a team of 6', out(await call('status')).size === 6);
  Object.assign(db.pro['u-sam'], { plan: 'pro', stripe_subscription_id: null });
  check('comp accounts: a team of 3 (6 on the API plan)', out(await call('status')).size === 3
    && (db.pro['u-sam'].plan = 'api', out(await call('status')).size === 6));
  check('no sign-in: 401', (await call('status', {}, { token: '' })).statusCode === 401);
  check('GET is refused', (await handler({ httpMethod: 'GET', headers: {} })).statusCode === 405);

  console.log('\n=== Inviting ===');
  reset();
  r = await call('invite', { email: '  Jo@Keystone.Example ', name: 'Jo Lee' });
  const inv = db.team[0];
  check('invite: 200, an invited row for the lower-cased email', r.statusCode === 200 && inv && inv.email === 'jo@keystone.example' && inv.status === 'invited' && inv.name === 'Jo Lee', r.body);
  const mail = resendCalls()[0] && resendCalls()[0].body;
  const token = lastLink();
  check('the email: from QuickFreightCalc, to them, replies to the owner', mail && mail.from === '"QuickFreightCalc" <team@quickfreightcalc.com>'
    && JSON.stringify(mail.to) === '["jo@keystone.example"]' && mail.reply_to === 'sam@keystone.example', mail && mail.from);
  check('…names who invited them and the company', mail.subject === 'Sam Rivera invited you to Keystone Produce Logistics on QuickFreightCalc'
    && mail.html.includes('Join Keystone Produce Logistics on QuickFreightCalc') && mail.html.includes('Pro Max'), mail.subject);
  check('…with a join link on the live site, good for 14 days', !!token && mail.html.includes(`https://quickfreightcalc.com/signup.html?team_invite=${token}`) && /14 days/.test(mail.text));
  check('only the token’s hash is stored', inv.invite_token_hash === sha(token) && !JSON.stringify(db.team).includes(token));
  check('the send is counted for the daily cap', db.sends.length === 1 && db.sends[0].owner_id === 'u-sam');
  r = await call('invite', { email: 'max@keystone.example' });
  check('a second invite fills the Pro Max team (3 people)', r.statusCode === 200 && out(await call('status')).used === 3);
  r = await call('invite', { email: 'ann@keystone.example' });
  check('a third is refused: the team is full (409)', r.statusCode === 409 && out(r).error === 'full' && /3 people on Pro Max/.test(out(r).message), r.body);
  r = await call('invite', { email: 'jo@keystone.example' });
  check('inviting the same address again within minutes: 429', r.statusCode === 429 && out(r).error === 'limit', r.body);
  for (const [label, body, field] of [['a bad address', { email: 'jo-at-keystone' }, 'email'], ['your own address', { email: 'SAM@keystone.example' }, 'email']]) {
    r = await call('invite', body);
    check(`${label}: 400`, r.statusCode === 400 && out(r).field === field, r.body);
  }
  reset(); db.pro['u-sam'].plan = 'plus';
  r = await call('invite', { email: 'jo@keystone.example' });
  check('Pro Plus can’t invite (403, nothing sent)', r.statusCode === 403 && out(r).error === 'plan' && !resendCalls().length, r.body);
  reset(); db.pro['u-sam'].is_active = false;
  check('an inactive account can’t invite', (await call('invite', { email: 'jo@keystone.example' })).statusCode === 403);
  reset(); resendStatus = 500;
  r = await call('invite', { email: 'jo@keystone.example' });
  check('if the email fails: 502 and no invite left behind', r.statusCode === 502 && db.team.length === 0, r.body);
  reset();
  await call('invite', { email: 'jo@keystone.example' }, { host: 'deploy-preview-30--quickfreightcalculator.netlify.app' });
  check('an invite from a deploy preview links to that preview', resendCalls()[0].body.html.includes('https://deploy-preview-30--quickfreightcalculator.netlify.app/signup.html?team_invite='));
  reset(); db.pro['u-sam'].plan = 'api';
  for (let i = 0; i < 20; i++) db.sends.push({ owner_id: 'u-sam', email: `x${i}@y.example`, sent_at: new Date().toISOString() });
  r = await call('invite', { email: 'jo@keystone.example' });
  check('20 invite emails a day at most (429)', r.statusCode === 429 && /20 invites/.test(out(r).message), r.body);

  console.log('\n=== Resending and canceling ===');
  reset();
  await call('invite', { email: 'jo@keystone.example' });
  const first = lastLink();
  db.team[0].invite_sent_at = new Date(Date.now() - 10 * 60000).toISOString();
  r = await call('resend', { id: db.team[0].id });
  const second = lastLink();
  check('resend: a new link; the old one stops working', r.statusCode === 200 && second && second !== first && db.team[0].invite_token_hash === sha(second), r.body);
  check('…the old link no longer previews', (await call('preview', { token: first }, { token: '' })).statusCode === 404);
  check('resend of something that isn’t an invite: 404', (await call('resend', { id: 999 })).statusCode === 404);
  r = await call('remove', { id: db.team[0].id }, { token: 'tok-max' });
  check('only the owner can cancel it (someone else: 404)', r.statusCode === 404 && db.team.length === 1);
  r = await call('remove', { id: db.team[0].id });
  check('the owner cancels the invite', r.statusCode === 200 && db.team.length === 0);

  console.log('\n=== The invite link ===');
  reset();
  await call('invite', { email: 'jo@keystone.example', name: 'Jo Lee' });
  const tok = lastLink();
  r = await call('preview', { token: tok }, { token: '' });
  s = out(r);
  check('preview (no sign-in needed): who invited them, the company and the email', r.statusCode === 200 && s.email === 'jo@keystone.example'
    && s.company === 'Keystone Produce Logistics' && s.ownerName === 'Sam Rivera' && s.plan === 'max' && s.expired === false, r.body);
  check('a made-up token: 404', (await call('preview', { token: 'x'.repeat(43) }, { token: '' })).statusCode === 404
    && (await call('preview', { token: '../etc' }, { token: '' })).statusCode === 404);
  r = await call('accept', { token: tok }, { token: 'tok-pat' });
  check('accepting while signed in with another email: 403, naming the invited email', r.statusCode === 403 && out(r).error === 'email' && /jo@keystone\.example/.test(out(r).message), r.body);
  check('accepting needs a sign-in', (await call('accept', { token: tok }, { token: '' })).statusCode === 401);
  r = await call('accept', { token: tok }, { token: 'tok-jo' });
  s = out(r);
  const jo = db.team[0];
  check('accept: joined (200), with the team’s name', r.statusCode === 200 && s.status === 'joined' && s.team.company === 'Keystone Produce Logistics' && s.ownPlan === null, r.body);
  check('…the row is active, linked to their login, tagged JL, token gone', jo.status === 'active' && jo.member_id === 'u-jo' && !!jo.joined_at && jo.tag === 'JL' && jo.invite_token_hash === null);
  check('…the link can’t be used again', (await call('accept', { token: tok }, { token: 'tok-jo' })).statusCode === 404);

  r = await call('status', {}, { token: 'tok-jo' });
  s = out(r);
  check('a member’s status: the team, its owner, the people on it', r.statusCode === 200 && s.role === 'member' && s.seated === true
    && s.team.company === 'Keystone Produce Logistics' && s.team.ownerName === 'Sam Rivera' && s.team.size === 3
    && s.people.length === 2 && s.people[0].owner && s.people[1].you && s.me.tag === 'JL', r.body);
  s = out(await call('status'));
  check('the owner’s status: Jo listed as a member with a seat', s.role === 'owner' && s.used === 2 && s.members.length === 1
    && s.members[0].status === 'active' && s.members[0].seated === true && s.members[0].name === 'Jo Lee', JSON.stringify(s));

  r = await call('me', { name: '  Jo   Lee ', phone: '555-0177' }, { token: 'tok-jo' });
  check('a member sets the name and phone on their quotes', r.statusCode === 200 && jo.name === 'Jo Lee' && jo.phone === '555-0177', r.body);
  check('…within limits', (await call('me', { name: 'x'.repeat(130) }, { token: 'tok-jo' })).statusCode === 400);
  check('someone not on a team can’t (404)', (await call('me', { name: 'Pat' }, { token: 'tok-pat' })).statusCode === 404);
  r = await call('invite', { email: 'pat@elsewhere.example' }, { token: 'tok-jo' });
  check('a member can’t invite people to their own team', r.statusCode === 403 || r.statusCode === 409, r.body);

  console.log('\n=== Who can join ===');
  reset();
  seat('u-sam', 'u-jo', 'jo@keystone.example', 'Jo Lee', 3);
  await call('invite', { email: 'max@keystone.example' });
  const maxTok = lastLink();
  db.pro['u-ann'] = { id: 'u-ann', email: 'ann@keystone.example', is_active: true, plan: 'max', stripe_subscription_id: 'sub_ann', company_name: 'Ann Co', contact_name: 'Ann' };
  db.team.push({ id: db.nextId++, owner_id: 'u-ann', email: 'max@keystone.example', member_id: null, status: 'invited', name: null, invite_token_hash: sha('t'.repeat(43)), invite_sent_at: new Date().toISOString() });
  seat('u-ann', 'u-max', 'max@keystone.example', 'Max Ray', 1);
  db.team = db.team.filter((x) => !(x.owner_id === 'u-ann' && x.status === 'invited'));
  r = await call('accept', { token: maxTok }, { token: 'tok-max' });
  check('someone already on another team can’t join (409)', r.statusCode === 409 && out(r).error === 'other_team', r.body);
  db.team = db.team.filter((x) => x.member_id !== 'u-max');
  db.team.push({ id: db.nextId++, owner_id: 'u-max', email: 'zed@x.example', member_id: null, status: 'invited', name: null, invite_token_hash: null, invite_sent_at: new Date().toISOString() });
  db.pro['u-max'] = { id: 'u-max', email: 'max@keystone.example', is_active: true, plan: 'max', stripe_subscription_id: 'sub_max' };
  r = await call('accept', { token: maxTok }, { token: 'tok-max' });
  check('an owner with their own team can’t join another (409)', r.statusCode === 409 && out(r).error === 'own_team', r.body);
  db.team = db.team.filter((x) => x.owner_id !== 'u-max');
  db.pro['u-sam'].plan = 'plus';
  r = await call('accept', { token: maxTok }, { token: 'tok-max' });
  check('a team whose plan dropped to Pro Plus: 409', r.statusCode === 409 && out(r).error === 'plan_changed', r.body);
  db.pro['u-sam'].plan = 'max';
  seat('u-sam', 'u-ann', 'ann@keystone.example', 'Ann', 2);
  r = await call('accept', { token: maxTok }, { token: 'tok-max' });
  check('a full team: 409', r.statusCode === 409 && out(r).error === 'full', r.body);
  db.team = db.team.filter((x) => x.member_id !== 'u-ann');
  db.team.find((x) => x.email === 'max@keystone.example').invite_sent_at = new Date(Date.now() - 15 * 86400000).toISOString();
  r = await call('accept', { token: maxTok }, { token: 'tok-max' });
  check('an invite older than 14 days: 410', r.statusCode === 410 && out(r).error === 'expired', r.body);
  check('…and the preview says so', out(await call('preview', { token: maxTok }, { token: '' })).expired === true);
  db.team.find((x) => x.email === 'max@keystone.example').invite_sent_at = new Date().toISOString();
  r = await call('accept', { token: maxTok }, { token: 'tok-max' });
  check('someone who still pays for their own plan can join, and is told', r.statusCode === 200 && out(r).ownPlan === 'max', r.body);
  check('…their own status shows the plan they still pay for', out(await call('status', {}, { token: 'tok-max' })).ownPlan === 'max');

  console.log('\n=== Seats when the plan changes ===');
  reset();
  db.pro['u-sam'].plan = 'api';
  seat('u-sam', 'u-jo', 'jo@keystone.example', 'Jo Lee', 5);
  seat('u-sam', 'u-max', 'max@keystone.example', 'Max Ray', 4);
  seat('u-sam', 'u-ann', 'ann@keystone.example', 'Ann', 3);
  check('API: all three have seats', ['u-jo', 'u-max', 'u-ann'].every((u) => seatedOwner(u) === 'u-sam'));
  db.pro['u-sam'].plan = 'max';
  s = out(await call('status'));
  const seats = s.members.map((m) => `${m.name}:${m.seated}`).join(',');
  check('down to Pro Max: the first two to join keep their seats', seats === 'Jo Lee:true,Max Ray:true,Ann:false', seats);
  s = out(await call('status', {}, { token: 'tok-ann' }));
  check('…the third is told they’re waiting for a seat', s.role === 'member' && s.seated === false, JSON.stringify(s));

  console.log('\n=== Leaving and removing ===');
  r = await call('leave', {}, { token: 'tok-ann' });
  check('a member leaves', r.statusCode === 200 && !db.team.some((x) => x.member_id === 'u-ann'));
  check('leaving when not on a team: 404', (await call('leave', {}, { token: 'tok-ann' })).statusCode === 404);
  const maxRow = db.team.find((x) => x.member_id === 'u-max');
  r = await call('remove', { id: maxRow.id });
  check('the owner removes a member', r.statusCode === 200 && !db.team.some((x) => x.member_id === 'u-max'));
  check('remove needs an id', (await call('remove', { id: 'abc' })).statusCode === 400);

  console.log('\n=== Accepting at the same time ===');
  reset();
  seat('u-sam', 'u-ann', 'ann@keystone.example', 'Ann', 2);
  await call('invite', { email: 'jo@keystone.example' });
  const raceTok = lastLink();
  // Someone else takes the last seat just as Jo joins
  db.beforeJoin = () => seat('u-sam', 'u-max', 'max@keystone.example', 'Max Ray', 0.01);
  r = await call('accept', { token: raceTok }, { token: 'tok-jo' });
  const joRow = db.team.find((x) => x.email === 'jo@keystone.example');
  check('two people taking the last seat: the later one gets 409 (full)', r.statusCode === 409 && out(r).error === 'full', r.body);
  check('…and their invite stays open with the same link', joRow.status === 'invited' && joRow.member_id === null && joRow.invite_token_hash === sha(raceTok));

  console.log('\n=== Decline ===');
  reset();
  await call('invite', { email: 'jo@keystone.example' });
  const decTok = lastLink();
  r = await call('decline', { token: decTok }, { token: '' });
  check('declining removes the invite (no sign-in needed)', r.statusCode === 200 && db.team.length === 0);

  console.log('\n=== Tags and the email ===');
  const T = _internal.makeTag;
  check('tags: initials, unique on the team', T('Jo Lee', 'jo@x', new Set()) === 'JL' && T('Cher', 'c@x', new Set()) === 'CH'
    && T('', 'x9@x', new Set()) === 'X' && T('Jo Lee', 'jo@x', new Set(['JL'])) === 'JL2' && T('Mary Ann de la Cruz', 'm@x', new Set()) === 'MC'
    && /^[A-Z]{1,3}[0-9]{0,2}$/.test(T('Ünïcode Ñame', 'u@x', new Set())), [T('Jo Lee', 'jo@x', new Set()), T('', 'x9@x', new Set()), T('Ünïcode Ñame', 'u@x', new Set())].join());
  const e = buildInviteEmail({ owner: { name: 'Sam <b>Rivera</b>', company: 'Keystone & Sons' }, email: 'jo@x.example', link: 'https://quickfreightcalc.com/signup.html?team_invite=abc', plan: 'api', siteUrl: 'https://quickfreightcalc.com', logoUrl: 'https://quickfreightcalc.com/email-logo.png' });
  check('the invite email escapes what the owner typed', e.html.includes('Sam &lt;b&gt;Rivera&lt;/b&gt;') && !e.html.includes('<b>Rivera') && e.html.includes('Keystone &amp; Sons'));
  check('…and names the plan, the link and the address', e.html.includes('API plan') && e.html.includes('team_invite=abc') && e.text.includes('jo@x.example'));
  const noCo = buildInviteEmail({ owner: { name: 'Sam Rivera' }, email: 'jo@x.example', link: 'L', plan: 'max' });
  check('without a company name it says “their team”', noCo.subject === 'Sam Rivera invited you to their team on QuickFreightCalc' && noCo.html.includes('Sam Rivera’s team'), noCo.subject);

  console.log(failures ? `\n${failures} TEAM CHECK(S) FAILED` : '\nALL TEAM CHECKS PASSED');
  process.exit(failures ? 1 : 0);
})();
