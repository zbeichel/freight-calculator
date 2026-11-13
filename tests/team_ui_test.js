// tests/team_ui_test.js — team members in the pages, in a real browser (needs Playwright with
// Chromium): the Profile page's Team section (owner and member), a member's read-only company
// settings, the shared quote log (who saved what, who can delete), joining from an invite link
// on the sign-up page, the multi-stop log, the customer editor and the lane tracker. Supabase
// and the Netlify functions are replaced by fakes that answer as the database would.
// Run from the repository root:
//   node tests/team_ui_test.js [folder for screenshots]
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { chromium } = require('playwright');
const ROOT = path.resolve(__dirname, '..');
const SHOTS = process.argv[2] || fs.mkdtempSync(path.join(os.tmpdir(), 'qfc-team-'));
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.json': 'application/json', '.css': 'text/css' };
const DAY = 86400000;
let failures = 0;
const check = (label, cond, detail) => { console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}${detail && !cond ? '  — ' + detail : ''}`); if (!cond) failures++; };

function serve() {
  const server = http.createServer((req, res) => {
    const p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    const file = path.join(ROOT, p === '/' ? 'index.html' : p);
    if (!file.startsWith(ROOT) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404); res.end(); return; }
    res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream' });
    fs.createReadStream(file).pipe(res);
  });
  return new Promise((r) => server.listen(0, '127.0.0.1', () => r(server)));
}

const SAM = { id: 'user-1', email: 'sam@example.com' };
const JO = { id: 'user-2', email: 'jo@example.com' };
const TOKEN = 'T'.repeat(43);

// my_account rows: the owner's own row, and what a member with a seat sees
const OWNER_ROW = (o) => Object.assign({ id: 'user-1', email: 'sam@example.com', company_name: 'Keystone Produce Logistics', contact_name: 'Sam Rivera',
  phone: '555-0100', mc_number: 'MC-1', quote_prefix: 'KPL', quote_counter: 1001, is_active: true, plan: 'max',
  stripe_customer_id: 'cus_1', stripe_subscription_id: 'sub_1', pdf_style: 'modern' }, o);
const MEMBER_ROW = (o) => Object.assign({ id: 'user-2', email: 'jo@example.com', company_name: 'Keystone Produce Logistics', contact_name: 'Jo Lee',
  phone: '555-0177', mc_number: 'MC-1', quote_prefix: 'KPL-JL', quote_counter: 1001, is_active: true, plan: 'max',
  stripe_subscription_id: 'team', pdf_style: 'modern' }, o);
const MEMBER_TEAM = { role: 'member', seated: true, company: 'Keystone Produce Logistics', owner_name: 'Sam Rivera', plan: 'max', size: 3, tag: 'JL' };
const OWNER_TEAM = { role: 'owner', size: 3, members: 1, invites: 0 };

function quote(id, daysAgo, by, name, o = {}) {
  return Object.assign({ id, user_id: 'user-1', date: 'Nov 1, 26', origin: 'Lancaster, PA', destination: 'New York, NY', miles: 166,
    trailer: 'van', weight: '40000', commodity: 'Standard', commodity_key: 'standard', margin: '15%', base_rpm: '2.40', quote: 1850,
    rpm: '11.14', notes: '', created_at: new Date(Date.now() - daysAgo * DAY).toISOString(), tracked: true, customer: null,
    outcome: 'open', outcome_at: null, final_rate: null, lost_reason: null, created_by: by, created_by_name: name }, o);
}

async function setup(browser, base, opts) {
  const { user = SAM, account = null, team = null, quotes = [], msQuotes = [], customers = [], teamStatus = null,
    preview = null, verify = null, ownRow = null, signedIn = true, phone = false } = opts;
  const context = await browser.newContext(phone
    ? { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true }
    : { viewport: { width: 1280, height: 900 }, deviceScaleFactor: 2 });
  const db = { account, team, quotes: quotes.map((q) => ({ ...q })), msQuotes: msQuotes.map((q) => ({ ...q })), customers, teamStatus,
    teamCalls: [], deletes: [], gets: [], posts: [], profilePatches: [], proPosts: [], checkouts: [], dialogs: [], accept: null };
  await context.addInitScript(([u, signed]) => {
    if (localStorage.getItem('__seeded')) return;
    localStorage.setItem('__seeded', '1');
    if (!signed) return;
    localStorage.setItem('sb-xgrmbhmgcsbnazupfybd-auth-token', JSON.stringify({ access_token: 'tok-' + u.id, refresh_token: 'r',
      expires_at: Math.floor(Date.now() / 1000) + 3600, user: u }));
  }, [user, signedIn]);
  await context.route('**/*', async (route) => {
    const req = route.request();
    const url = req.url();
    const method = req.method();
    const json = (b, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(b) });
    if (url.startsWith(base) && !url.includes('/.netlify/functions/')) return route.continue();
    const auth = req.headers().authorization || '';
    const me = auth.replace('Bearer tok-', '');
    const isOwner = () => (db.account && db.account.id === 'user-1' && me === 'user-1') || (!db.team && db.account);
    if (url.includes('/rest/v1/rpc/my_account')) return json({ row: db.account, team: db.team });
    if (url.includes('/rest/v1/quote_log')) {
      const u = new URL(url);
      if (method === 'GET') {
        db.gets.push(u.search);
        let rows = db.quotes.slice().sort((a, b) => b.created_at.localeCompare(a.created_at) || b.id - a.id);
        if (u.searchParams.get('tracked') === 'not.is.false') rows = rows.filter((q) => q.tracked !== false);
        return json(rows);
      }
      if (method === 'DELETE') {
        db.deletes.push(u.search);
        const id = u.searchParams.get('id');
        if (id) {
          const q = db.quotes.find((x) => String(x.id) === id.replace('eq.', ''));
          // As the database: the owner, or whoever saved it
          if (!q || !(isOwner() || q.created_by === me)) return json([]);
          db.quotes = db.quotes.filter((x) => x !== q);
          return json([q]);
        }
        return route.fulfill({ status: 204, body: '' });
      }
      if (method === 'POST') { const b = JSON.parse(req.postData()); db.posts.push(b); const r = quote(9000 + db.posts.length, 0, me, 'x', b); db.quotes.push(r); return json([r], 201); }
      return json([]);
    }
    if (url.includes('/rest/v1/ms_quote_log')) {
      const u = new URL(url);
      if (method === 'GET') { db.gets.push('ms' + u.search); return json(db.msQuotes); }
      if (method === 'DELETE') { db.deletes.push('ms' + u.search); return route.fulfill({ status: 204, body: '' }); }
      return route.fulfill({ status: 201, body: '' });
    }
    if (url.includes('/rest/v1/customers')) {
      if (method === 'GET') { db.gets.push('cust' + new URL(url).search); return json(db.customers); }
      return json([]);
    }
    if (url.includes('/rest/v1/quote_emails')) return json([]);
    if (url.includes('/rest/v1/pro_users')) {
      if (method === 'PATCH') { db.profilePatches.push(JSON.parse(req.postData() || '{}')); return route.fulfill({ status: 204, body: '' }); }
      if (method === 'POST') { db.proPosts.push(JSON.parse(req.postData() || '{}')); return route.fulfill({ status: 201, body: '' }); }
      return json(ownRow ? [ownRow] : []);
    }
    if (url.includes('/auth/v1/signup')) {
      const b = JSON.parse(req.postData());
      return json({ access_token: 'tok-user-2', refresh_token: 'r', expires_in: 3600, user: { id: 'user-2', email: b.email } });
    }
    if (url.includes('/auth/v1/token')) {
      const b = JSON.parse(req.postData() || '{}');
      return json({ access_token: 'tok-user-2', refresh_token: 'r', expires_in: 3600, user: { id: 'user-2', email: b.email } });
    }
    if (url.includes('/auth/v1/user')) return json(user);
    if (url.includes('/.netlify/functions/team')) {
      const b = JSON.parse(req.postData() || '{}');
      db.teamCalls.push({ ...b, auth });
      if (b.action === 'status') return json(typeof db.teamStatus === 'function' ? db.teamStatus() : db.teamStatus || { role: null, size: 1, used: 1, members: [] });
      if (b.action === 'preview') return preview ? json(preview) : json({ error: 'not_found', message: 'This invite link isn’t valid any more. Ask whoever invited you to send a new one.' }, 404);
      if (b.action === 'accept') return db.accept ? json(db.accept.body, db.accept.status) : json({ status: 'joined', team: { company: 'Keystone Produce Logistics', ownerName: 'Sam Rivera', plan: 'max' }, ownPlan: null });
      if (b.action === 'me') return json({ status: 'saved', me: { name: b.name, phone: b.phone } });
      return json({ status: 'ok' });
    }
    if (url.includes('/.netlify/functions/verify-pro')) return json(verify || { active: true, plan: 'max', paid: true, unlimitedUntilRenewal: false, team: null });
    if (url.includes('/.netlify/functions/create-checkout')) { db.checkouts.push(1); return json({ url: base + '/checkout-was-opened' }); }
    if (url.includes('/.netlify/functions/')) return json({});
    if (url.includes('supabase.co')) return json([]);
    if (url.includes('fonts.googleapis.com') || url.includes('fonts.gstatic.com')) return route.continue();
    return route.abort();
  });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('dialog', async (d) => { db.dialogs.push(d.message()); await (db.dismissDialogs ? d.dismiss() : d.accept()); });
  return { context, page, errors, db };
}
const text = (pg, sel) => pg.$eval(sel, (e) => e.innerText.replace(/\s+/g, ' ').trim()).catch(() => '');

(async () => {
  const server = await serve();
  const base = `http://127.0.0.1:${server.address().port}`;
  const browser = await chromium.launch();

  // ── Profile: an owner's Team section ──────────────────────────────────────
  console.log('\n=== Profile: owner on Pro Max ===');
  let invited = false;
  let t = await setup(browser, base, {
    account: OWNER_ROW(), team: null,
    teamStatus: () => ({ role: invited ? 'owner' : null, plan: 'max', size: 3, used: invited ? 2 : 1, canInvite: true,
      members: invited ? [{ id: 41, email: 'jo@example.com', name: 'Jo Lee', status: 'invited', invitedAt: new Date().toISOString() }] : [],
      me: { email: 'sam@example.com', name: 'Sam Rivera' } }),
  });
  await t.page.goto(base + '/profile.html');
  await t.page.waitForSelector('#team-card', { state: 'visible' });
  check('the Team section: 1 of 3 people, the owner listed', (await text(t.page, '#team-sub')) === '1 of 3 people'
    && /Sam Rivera\s*Owner/i.test(await text(t.page, '#team-body')), `${await text(t.page, '#team-sub')} | ${await text(t.page, '#team-body')}`);
  check('it says what a team shares, and an invite form', /quote log, customers, company settings and daily limits/.test(await text(t.page, '#team-body'))
    && await t.page.isVisible('#team-invite-email') && await t.page.isVisible('#team-invite-btn'));
  check('the owner still sees billing and API access', await t.page.isVisible('#subscription-paid') && !(await t.page.evaluate(() => document.body.classList.contains('pf-member'))));
  await t.page.fill('#team-invite-email', 'not-an-email');
  await t.page.click('#team-invite-btn');
  check('a bad address is caught before sending', (await text(t.page, '#team-status')) === 'Enter their email address.' && !t.db.teamCalls.some((c) => c.action === 'invite'));
  await t.page.fill('#team-invite-email', 'jo@example.com');
  await t.page.fill('#team-invite-name', 'Jo Lee');
  invited = true;
  await t.page.click('#team-invite-btn');
  await t.page.waitForFunction(() => /Invite sent/.test(document.getElementById('team-status').innerText));
  const inv = t.db.teamCalls.find((c) => c.action === 'invite');
  check('Send invite calls the team function with their email and name, signed in', inv && inv.email === 'jo@example.com' && inv.name === 'Jo Lee' && inv.auth === 'Bearer tok-user-1');
  check('the invite shows in the list with Resend and Cancel', /Jo Lee\s*jo@example\.com · Invited/.test(await text(t.page, '#team-body'))
    && (await t.page.$$('#team-body button.api-key-revoke')).length === 2 && (await text(t.page, '#team-sub')) === '2 of 3 people');
  await t.page.screenshot({ path: path.join(SHOTS, 'profile-team-owner.png'), fullPage: false, clip: await t.page.$eval('#team-card', (e) => { const r = e.getBoundingClientRect(); return { x: r.x, y: r.y + window.scrollY, width: r.width, height: r.height }; }) }).catch(() => {});
  invited = false;
  await t.page.click('#team-body button.api-key-revoke >> text=Cancel');
  await t.page.waitForFunction(() => /Invite canceled/.test(document.getElementById('team-status').innerText));
  check('Cancel asks first, then removes the invite', /Cancel the invite to Jo Lee\?/.test(t.db.dialogs.join('|')) && t.db.teamCalls.some((c) => c.action === 'remove' && c.id === 41));
  check('no page errors', t.errors.length === 0, t.errors.join(' | '));
  await t.context.close();

  console.log('\n=== Profile: owner on Pro Plus ===');
  t = await setup(browser, base, { account: OWNER_ROW({ plan: 'plus' }), teamStatus: { role: null, plan: 'plus', size: 1, used: 1, canInvite: false, members: [], me: { email: 'sam@example.com' } } });
  await t.page.goto(base + '/profile.html');
  await t.page.waitForSelector('#team-card', { state: 'visible' });
  check('Pro Plus: the Team section explains Pro Max (3) and API (6)', /Pro Max includes a team of 3 people and the API plan 6/.test(await text(t.page, '#team-body'))
    && !(await t.page.isVisible('#team-invite-email')));
  await t.page.click('#team-body >> text=Get Pro Max');
  check('“Get Pro Max” picks Pro Max in the plan switcher', (await t.page.inputValue('#sub-plan-select')) === 'max');
  await t.context.close();

  console.log('\n=== Profile: switching an owner with a team to a smaller plan ===');
  t = await setup(browser, base, { account: OWNER_ROW({ plan: 'max' }), teamStatus: { role: 'owner', plan: 'max', size: 3, used: 3, canInvite: true,
    members: [{ id: 1, email: 'jo@example.com', name: 'Jo Lee', status: 'active', seated: true, joinedAt: new Date().toISOString() },
      { id: 2, email: 'max@example.com', name: 'Max Ray', status: 'active', seated: true, joinedAt: new Date().toISOString() }], me: { email: 'sam@example.com' } } });
  t.db.dismissDialogs = true;
  await t.page.goto(base + '/profile.html');
  await t.page.waitForSelector('#team-card', { state: 'visible' });
  check('a full team says so instead of showing the invite form', /Your team is full/.test(await text(t.page, '#team-body')) && !(await t.page.isVisible('#team-invite-email')));
  await t.page.selectOption('#sub-plan-select', 'plus');
  await t.page.click('#sub-plan-switch');
  await t.page.waitForTimeout(300);
  check('moving to Pro Plus warns that both team members lose access', /doesn’t include team members, so your 2 team members will lose access/.test(t.db.dialogs.join('|')), t.db.dialogs.join('|'));
  await t.context.close();

  // ── Profile: a member ─────────────────────────────────────────────────────
  console.log('\n=== Profile: a team member ===');
  t = await setup(browser, base, { user: JO, account: MEMBER_ROW(), team: MEMBER_TEAM,
    teamStatus: { role: 'member', seated: true, ownPlan: null, team: { company: 'Keystone Produce Logistics', ownerName: 'Sam Rivera', plan: 'max', size: 3 },
      me: { name: 'Jo Lee', phone: '555-0177', email: 'jo@example.com', tag: 'JL' }, people: [{ name: 'Sam Rivera', owner: true }, { name: 'Jo Lee', you: true, seated: true }] } });
  await t.page.goto(base + '/profile.html');
  await t.page.waitForSelector('#team-card', { state: 'visible' });
  check('a banner names the team and who sets the company details', /You’re on Keystone Produce Logistics\. Sam Rivera sets the company details/.test(await text(t.page, '#member-banner')));
  const fields = await t.page.evaluate(() => Object.fromEntries(['company-name', 'contact-name', 'contact-phone', 'contact-email', 'mc-number', 'quote-prefix']
    .map((id) => [id, { value: document.getElementById(id).value, disabled: document.getElementById(id).disabled }])));
  check('company fields show the team’s values, read-only', fields['company-name'].value === 'Keystone Produce Logistics' && fields['company-name'].disabled
    && fields['mc-number'].disabled && fields['contact-email'].disabled, JSON.stringify(fields));
  check('their own name and phone stay editable', fields['contact-name'].value === 'Jo Lee' && !fields['contact-name'].disabled && !fields['contact-phone'].disabled);
  check('quote numbers carry their initials (KPL-JL), set by the team', fields['quote-prefix'].value === 'KPL-JL' && fields['quote-prefix'].disabled);
  check('logo, PDF and numbering cards are locked', (await t.page.$$('.section-card.pf-locked')).length >= 5);
  check('no billing or API sections for a member', !(await t.page.isVisible('#subscription-paid')) && !(await t.page.isVisible('#subscription-comp')) && !(await t.page.isVisible('#api-access')));
  check('the Team section: the team, the owner, their tag, and Leave', /You’re on Keystone Produce Logistics, run by Sam Rivera/.test(await text(t.page, '#team-body'))
    && /JL/.test(await text(t.page, '#team-body')) && await t.page.isVisible('#team-leave-btn'));
  await t.page.fill('#contact-name', 'Jo Lee-Smith');
  await t.page.click('.save-btn');
  await t.page.waitForTimeout(400);
  const meCall = t.db.teamCalls.find((c) => c.action === 'me');
  check('Save my details saves their name and phone to the team, not the company row', meCall && meCall.name === 'Jo Lee-Smith' && meCall.phone === '555-0177' && t.db.profilePatches.length === 0,
    JSON.stringify({ meCall, patches: t.db.profilePatches.length }));
  check('…and the quotes they make pick it up', await t.page.evaluate(() => JSON.parse(localStorage.getItem('qfc_pro_profile') || '{}').contactName) === 'Jo Lee-Smith');
  await t.page.screenshot({ path: path.join(SHOTS, 'profile-team-member.png'), fullPage: true }).catch(() => {});
  await t.page.click('#team-leave-btn');
  await t.page.waitForTimeout(300);
  check('Leave asks first, then leaves the team', /Leave Keystone Produce Logistics\?/.test(t.db.dialogs.join('|')) && t.db.teamCalls.some((c) => c.action === 'leave'));
  check('no page errors', t.errors.length === 0, t.errors.join(' | '));
  await t.context.close();

  console.log('\n=== Profile: a member waiting for a seat ===');
  t = await setup(browser, base, { user: JO, account: null, team: { ...MEMBER_TEAM, seated: false },
    teamStatus: { role: 'member', seated: false, team: { company: 'Keystone Produce Logistics', ownerName: 'Sam Rivera', plan: 'max', size: 3 },
      me: { name: 'Jo Lee', email: 'jo@example.com' }, people: [{ name: 'Sam Rivera', owner: true }, { name: 'Jo Lee', you: true, seated: false }] } });
  await t.page.goto(base + '/profile.html');
  await t.page.waitForSelector('#team-card', { state: 'visible' });
  check('they’re told they’re waiting for a seat, and can still leave', /waiting for a seat/.test(await text(t.page, '#team-body')) && await t.page.isVisible('#team-leave-btn'));
  await t.context.close();

  // ── The calculator's quote log ────────────────────────────────────────────
  const teamQuotes = [quote(101, 1, 'user-2', 'Jo Lee'), quote(102, 2, 'user-1', 'Sam Rivera'), quote(103, 30, null, null)];
  console.log('\n=== Quote log: a member ===');
  t = await setup(browser, base, { user: JO, account: MEMBER_ROW(), team: MEMBER_TEAM, quotes: teamQuotes });
  await t.page.goto(base + '/index.html');
  await t.page.waitForFunction(() => typeof quoteLog !== 'undefined' && quoteLog.length === 3);
  await t.page.waitForTimeout(200);
  const by = await t.page.$$eval('#log-body tr', (rows) => rows.map((r) => (r.querySelector('.ql-by') || {}).innerText));
  check('each quote says who saved it (you / the teammate / the owner for older quotes)', JSON.stringify(by) === JSON.stringify(['by you', 'by Sam Rivera', 'by Sam Rivera']), JSON.stringify(by));
  const dels = await t.page.$$eval('#log-body tr', (rows) => rows.map((r) => !!r.querySelector('.del-btn')));
  check('a member can delete only their own quotes', JSON.stringify(dels) === '[true,false,false]', JSON.stringify(dels));
  check('the count is the team’s', /quotes saved by your team$/.test(await text(t.page, '#profile-count-note')), await text(t.page, '#profile-count-note'));
  check('the log is loaded without an owner filter (the database picks the team’s rows)', t.db.gets.length > 0 && t.db.gets.every((g) => !/user_id/.test(g)), JSON.stringify(t.db.gets));
  const cached = await t.page.evaluate(() => JSON.parse(localStorage.getItem('qfc_pro_profile') || '{}'));
  check('PDFs and emails use the team’s company with their own name and tagged numbers', cached.companyName === 'Keystone Produce Logistics' && cached.contactName === 'Jo Lee'
    && cached.quotePrefix === 'KPL-JL' && cached.team && cached.team.role === 'member' && cached.plan === 'max' && cached.comp === false, JSON.stringify(cached).slice(0, 300));
  await t.page.evaluate(() => deleteQuote(102));
  await t.page.waitForTimeout(200);
  check('deleting a teammate’s quote is refused before asking the database', t.db.deletes.length === 0 && (await t.page.evaluate(() => quoteLog.length)) === 3);
  await t.page.click('button.btn-danger >> text=Clear All');
  await t.page.waitForTimeout(300);
  check('Clear All clears only the quotes they saved', /Clear the 1 quote you saved\? Your teammates’ quotes stay/.test(t.db.dialogs.join('|'))
    && t.db.deletes.some((d) => d === '?created_by=eq.user-2') && (await t.page.evaluate(() => quoteLog.map((q) => q.id).join())) === '102,103', JSON.stringify(t.db.deletes));
  check('no page errors', t.errors.length === 0, t.errors.join(' | '));
  await t.context.close();

  console.log('\n=== Quote log: the owner of a team ===');
  t = await setup(browser, base, { user: SAM, account: OWNER_ROW(), team: OWNER_TEAM, quotes: teamQuotes });
  await t.page.goto(base + '/index.html');
  await t.page.waitForFunction(() => typeof quoteLog !== 'undefined' && quoteLog.length === 3);
  await t.page.waitForTimeout(200);
  const ownerBy = await t.page.$$eval('#log-body tr', (rows) => rows.map((r) => (r.querySelector('.ql-by') || {}).innerText));
  check('the owner sees who saved each quote', JSON.stringify(ownerBy) === JSON.stringify(['by Jo Lee', 'by you', 'by you']), JSON.stringify(ownerBy));
  check('the owner can delete any quote', (await t.page.$$('#log-body .del-btn')).length === 3);
  await t.page.evaluate(() => deleteQuote(101));
  await t.page.waitForTimeout(300);
  check('…including a member’s', t.db.deletes.includes('?id=eq.101') && !t.db.quotes.some((q) => q.id === 101));
  await t.page.click('button.btn-danger >> text=Clear All');
  await t.page.waitForTimeout(300);
  check('Clear All clears the owner’s own quotes (and those from before the team)', /Clear the 2 quotes you saved/.test(t.db.dialogs.join('|'))
    && t.db.deletes.some((d) => decodeURIComponent(d) === '?or=(created_by.eq.user-1,created_by.is.null)'), JSON.stringify(t.db.deletes));
  await t.context.close();

  console.log('\n=== Quote log: no team ===');
  t = await setup(browser, base, { user: SAM, account: OWNER_ROW(), team: null, quotes: [quote(201, 1, 'user-1', 'Sam Rivera'), quote(202, 2, null, null)] });
  await t.page.goto(base + '/index.html');
  await t.page.waitForFunction(() => typeof quoteLog !== 'undefined' && quoteLog.length === 2);
  await t.page.waitForTimeout(200);
  check('no “by” labels without a team', (await t.page.$$('#log-body .ql-by')).length === 0 && /quotes saved$/.test(await text(t.page, '#profile-count-note')));
  await t.page.click('button.btn-danger >> text=Clear All');
  await t.page.waitForTimeout(300);
  check('Clear All clears everything, as before', /Clear all saved quotes\?/.test(t.db.dialogs.join('|')) && t.db.deletes.includes('?user_id=eq.user-1'));
  await t.context.close();

  // ── Customers: a member deletes only what they added ──────────────────────
  console.log('\n=== Customers: a member ===');
  t = await setup(browser, base, { user: JO, account: MEMBER_ROW(), team: MEMBER_TEAM, customers: [
    { id: 7, user_id: 'user-1', name: 'Blue Ridge Foods', created_by: 'user-1' }, { id: 8, user_id: 'user-1', name: 'Acme Produce', created_by: 'user-2' }] });
  await t.page.goto(base + '/index.html');
  await t.page.waitForFunction(() => window.QFCCustomers && QFCCustomers.all().length === 2);
  check('the team’s customers load without an owner filter', t.db.gets.filter((g) => g.startsWith('cust')).every((g) => !/user_id/.test(g)));
  await t.page.evaluate(() => { QFCCustomers.openEditor(QFCCustomers.byId(7)); });
  await t.page.waitForTimeout(200);
  const delOther = await t.page.$eval('.qfcc-del', (b) => !b.hidden && getComputedStyle(b).display !== 'none').catch(() => null);
  await t.page.keyboard.press('Escape');
  await t.page.evaluate(() => { QFCCustomers.openEditor(QFCCustomers.byId(8)); });
  await t.page.waitForTimeout(200);
  const delOwn = await t.page.$eval('.qfcc-del', (b) => !b.hidden && getComputedStyle(b).display !== 'none').catch(() => null);
  check('Delete shows only on customers they added', delOther === false && delOwn === true, JSON.stringify({ delOther, delOwn }));
  await t.context.close();

  // ── Multi-stop log ────────────────────────────────────────────────────────
  console.log('\n=== Multi-stop: a member ===');
  t = await setup(browser, base, { user: JO, account: MEMBER_ROW(), team: MEMBER_TEAM,
    verify: { active: true, plan: 'max', paid: false, unlimitedUntilRenewal: false, team: { role: 'member', seated: true, size: 3 } },
    msQuotes: [
      { id: 501, date: 'Nov 2', route: 'A → B (1 stops)', miles: 400, stops_count: '3', commodity: 'Std', margin: '15%', quote: 2000, rpm: '5.00', created_by: 'user-2', created_by_name: 'Jo Lee', created_at: new Date().toISOString() },
      { id: 502, date: 'Nov 1', route: 'C → D (1 stops)', miles: 300, stops_count: '3', commodity: 'Std', margin: '15%', quote: 1500, rpm: '5.00', created_by: 'user-1', created_by_name: 'Sam Rivera', created_at: new Date().toISOString() }] });
  await t.page.goto(base + '/multistop.html');
  await t.page.waitForFunction(() => document.querySelectorAll('#ms-log-body tr').length === 2 && /by/.test(document.getElementById('ms-log-body').innerText));
  const msBy = await t.page.$$eval('#ms-log-body tr', (rows) => rows.map((r) => [/by you/.test(r.innerText) ? 'you' : /by Sam Rivera/.test(r.innerText) ? 'Sam' : '?', !!r.querySelector('.ms-del-btn')].join(':')));
  check('the multi-stop log shows who saved each quote; delete only on theirs', JSON.stringify(msBy) === JSON.stringify(['you:true', 'Sam:false']), JSON.stringify(msBy));
  check('…loaded without an owner filter', t.db.gets.filter((g) => g.startsWith('ms')).every((g) => !/user_id/.test(g)));
  await t.page.click('button >> text=Clear All');
  await t.page.waitForTimeout(300);
  check('Clear All clears only their own multi-stop quotes', /Clear the 1 multi-stop quote you saved/.test(t.db.dialogs.join('|')) && t.db.deletes.includes('ms?created_by=eq.user-2'), JSON.stringify(t.db.deletes));
  await t.context.close();

  // ── Lane tracker ──────────────────────────────────────────────────────────
  console.log('\n=== Lane tracker ===');
  t = await setup(browser, base, { user: JO, account: MEMBER_ROW(), team: MEMBER_TEAM,
    verify: { active: true, plan: 'max', team: { role: 'member', seated: true, size: 3 } },
    quotes: [quote(301, 1, 'user-2', 'Jo Lee', { origin: 'Fresno, CA', destination: 'Dallas, TX' }), quote(302, 2, 'user-1', 'Sam Rivera'), quote(303, 3, 'user-1', 'Sam Rivera', { tracked: false })] });
  await t.page.goto(base + '/lanes.html');
  await t.page.waitForFunction(() => document.querySelectorAll('#lane-list .lane-name').length === 2);
  const lanes = await t.page.$$eval('#lane-list .lane-name', (els) => els.map((e) => e.innerText));
  check('the lane tracker lists the team’s tracked quotes, newest first', lanes[0] === 'Fresno, CA → Dallas, TX (Nov 1, 26)' && lanes[1] === 'Lancaster, PA → New York, NY (Nov 1, 26)', JSON.stringify(lanes));
  await t.context.close();

  // ── Joining from an invite link ───────────────────────────────────────────
  const PREVIEW = { email: 'jo@example.com', name: 'Jo Lee', company: 'Keystone Produce Logistics', ownerName: 'Sam Rivera', plan: 'max', expired: false };
  console.log('\n=== Invite link: creating a login ===');
  t = await setup(browser, base, { signedIn: false, preview: PREVIEW });
  await t.page.goto(base + '/signup.html?team_invite=' + TOKEN);
  await t.page.waitForSelector('#su-invite:not([hidden])');
  check('the invite: who, which team, which email; no plans or payment', /Sam Rivera invited you to join Keystone Produce Logistics/.test(await text(t.page, '#su-invite'))
    && /jo@example\.com/.test(await text(t.page, '#su-invite')) && /No payment needed/.test(await text(t.page, '#su-invite'))
    && await t.page.isHidden('.su-plans') && await t.page.isHidden('.su-side'));
  check('the email is filled in and the button says what happens', (await t.page.inputValue('#su-email')) === 'jo@example.com'
    && (await text(t.page, '#su-btn')) === 'Create login & join the team →');
  await t.page.screenshot({ path: path.join(SHOTS, 'signup-invite.png') }).catch(() => {});
  await t.page.fill('#su-password', 'Truck!Load9');
  await t.page.check('#su-agree');
  await t.page.click('#su-btn');
  await t.page.waitForURL(/profile\.html\?team=joined/, { timeout: 8000 }).catch(() => {});
  const acc = t.db.teamCalls.find((c) => c.action === 'accept');
  check('creating the login joins the team with the link’s token', acc && acc.token === TOKEN && acc.auth === 'Bearer tok-user-2');
  check('…no paid account row and no checkout', t.db.proPosts.length === 0 && t.db.checkouts.length === 0, JSON.stringify({ posts: t.db.proPosts, checkouts: t.db.checkouts.length }));
  check('…then opens the Profile page', /profile\.html\?team=joined/.test(t.page.url()), t.page.url());
  await t.context.close();

  console.log('\n=== Invite link: signing in ===');
  t = await setup(browser, base, { signedIn: false, preview: PREVIEW, ownRow: { is_active: false, stripe_subscription_id: null } });
  await t.page.goto(base + '/signup.html?team_invite=' + TOKEN);
  await t.page.waitForSelector('#su-invite:not([hidden])');
  await t.page.click('#tab-login');
  check('Sign In keeps the invite (no plans come back)', await t.page.isHidden('.su-plans') && (await t.page.inputValue('#li-email')) === 'jo@example.com');
  await t.page.fill('#li-password', 'Truck!Load9');
  await t.page.click('#li-btn');
  await t.page.waitForURL(/profile\.html\?team=joined/, { timeout: 8000 }).catch(() => {});
  check('signing in joins the team, with no checkout even for an unpaid account', t.db.teamCalls.some((c) => c.action === 'accept') && t.db.checkouts.length === 0
    && /profile\.html\?team=joined/.test(t.page.url()), t.page.url());
  await t.context.close();

  console.log('\n=== Invite link: already signed in ===');
  t = await setup(browser, base, { user: JO, preview: PREVIEW });
  await t.page.goto(base + '/signup.html?team_invite=' + TOKEN);
  await t.page.waitForSelector('#su-join-btn');
  check('signed in with the invited email: a Join button, no forms', /You’re signed in as jo@example\.com/.test(await text(t.page, '#su-invite'))
    && await t.page.isHidden('#form-signup') && await t.page.isHidden('#form-login'));
  await t.page.click('#su-join-btn');
  await t.page.waitForURL(/profile\.html\?team=joined/, { timeout: 8000 }).catch(() => {});
  check('Join joins with the current login', t.db.teamCalls.some((c) => c.action === 'accept' && c.auth === 'Bearer tok-user-2'));
  await t.context.close();

  t = await setup(browser, base, { user: { id: 'user-9', email: 'pat@other.example' }, preview: PREVIEW });
  await t.page.goto(base + '/signup.html?team_invite=' + TOKEN);
  await t.page.waitForSelector('#su-invite:not([hidden])');
  await t.page.waitForTimeout(200);
  check('signed in with another email: asked to sign out, no Join button', /The invite is for jo@example\.com, but you’re signed in as pat@other\.example/.test(await text(t.page, '#su-invite'))
    && !(await t.page.$('#su-join-btn')) && await t.page.isVisible('#su-invite button >> text=Sign out'));
  await t.context.close();

  t = await setup(browser, base, { signedIn: false, preview: null });
  await t.page.goto(base + '/signup.html?team_invite=' + TOKEN);
  await t.page.waitForFunction(() => document.getElementById('error-msg').style.display === 'block');
  check('a dead link says so', /isn’t valid any more/.test(await text(t.page, '#error-msg')) && await t.page.isHidden('#su-invite'));
  await t.context.close();

  t = await setup(browser, base, { signedIn: false, preview: { ...PREVIEW, expired: true } });
  await t.page.goto(base + '/signup.html?team_invite=' + TOKEN);
  await t.page.waitForFunction(() => document.getElementById('error-msg').style.display === 'block');
  check('an expired link says so', /expired/.test(await text(t.page, '#error-msg')));
  await t.context.close();

  t = await setup(browser, base, { signedIn: false, preview: PREVIEW });
  await t.page.goto(base + '/signup.html?team_invite=' + TOKEN);
  await t.page.waitForSelector('#su-invite:not([hidden])');
  t.db.accept = { status: 409, body: { error: 'full', message: 'This team is full. Ask whoever invited you to make room.' } };
  await t.page.click('#tab-login');
  await t.page.fill('#li-password', 'Truck!Load9');
  await t.page.click('#li-btn');
  await t.page.waitForFunction(() => document.getElementById('error-msg').style.display === 'block');
  check('if joining fails, the reason shows and they stay on the page', /This team is full/.test(await text(t.page, '#error-msg')) && /signup\.html/.test(t.page.url()));
  await t.context.close();

  console.log('\n=== A member signing in later ===');
  t = await setup(browser, base, { signedIn: false, ownRow: { is_active: false, stripe_subscription_id: null },
    verify: { active: true, plan: 'max', team: { role: 'member', seated: true, size: 3 } } });
  await t.page.goto(base + '/signup.html?login');
  await t.page.fill('#li-email', 'jo@example.com');
  await t.page.fill('#li-password', 'Truck!Load9');
  await t.page.click('#li-btn');
  await t.page.waitForURL(/profile\.html/, { timeout: 8000 }).catch(() => {});
  check('a team member with an unpaid account of their own isn’t sent to checkout', t.db.checkouts.length === 0 && /profile\.html/.test(t.page.url()), t.page.url());
  await t.context.close();

  await browser.close();
  server.close();
  console.log(`\nScreenshots: ${SHOTS}`);
  console.log(failures ? `\n${failures} FAILED` : '\nALL PASS');
  process.exit(failures ? 1 : 0);
})();
