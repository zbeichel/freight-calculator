// Emailing quotes: the send-quote-email function, against a fake Supabase and a fake Resend.
//   node tests/email_test.js
const path = require('path');
const ROOT = path.resolve(__dirname, '..');

let failures = 0;
const check = (label, cond, detail) => { console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}${detail && !cond ? '  — ' + detail : ''}`); if (!cond) failures++; };

process.env.RESEND_API_KEY = 're_test_key';
process.env.SUPABASE_SERVICE_KEY = 'service-key';
process.env.SUPABASE_URL = 'https://sb.example';
const { handler, _internal } = require(path.join(ROOT, 'netlify/functions/send-quote-email.js'));

// A small real PDF (what the browser sends)
const PDF = Buffer.from('%PDF-1.3\n' + '%'.repeat(600) + '\n%%EOF\n', 'latin1').toString('base64');

// ── Fake services ──────────────────────────────────────────────────────────
let world;
function reset(over = {}) {
  world = {
    users: { 'tok-sam': { id: 'u-sam', email: 'sam@keystone.example' } },
    pro: { 'u-sam': { id: 'u-sam', email: 'sam@keystone.example', company_name: 'Keystone Produce Logistics', contact_name: 'Sam Rivera', phone: '555-0100', plan: 'plus', is_active: true, comp: false, stripe_subscription_id: 'sub_123', pdf_white_label: false } },
    quotes: { 1700000000001: 'u-sam', 1700000000002: 'u-other' },
    sent24h: 0,
    resend: { status: 200, body: { id: 'em_123' } },
    logStatus: 201,
    calls: [],
    ...over,
  };
}
global.fetch = async (url, init = {}) => {
  const u = new URL(url);
  const call = { url, method: init.method || 'GET', headers: init.headers || {}, body: init.body ? JSON.parse(init.body) : undefined };
  world.calls.push(call);
  const reply = (status, data, headers = {}) => ({
    ok: status >= 200 && status < 300, status,
    headers: { get: (k) => headers[k.toLowerCase()] || null },
    text: async () => (data === undefined ? '' : JSON.stringify(data)),
    json: async () => data,
  });
  if (u.host === 'api.resend.com') return reply(world.resend.status, world.resend.body);
  if (u.pathname === '/auth/v1/user') {
    const tok = (call.headers.Authorization || '').replace('Bearer ', '');
    return world.users[tok] ? reply(200, world.users[tok]) : reply(401, { msg: 'bad jwt' });
  }
  if (u.pathname === '/rest/v1/pro_users') {
    const id = u.searchParams.get('id').replace('eq.', '');
    return reply(200, world.pro[id] ? [world.pro[id]] : []);
  }
  if (u.pathname === '/rest/v1/quote_emails' && call.method === 'GET') return reply(world.sent24h ? 206 : 200, [], { 'content-range': world.sent24h ? `0-0/${world.sent24h}` : '*/0' });
  if (u.pathname === '/rest/v1/quote_emails' && call.method === 'POST') return reply(world.logStatus, world.logStatus < 300 ? undefined : { message: 'nope' });
  if (u.pathname === '/rest/v1/quote_log') {
    const id = u.searchParams.get('id').replace('eq.', ''), uid = u.searchParams.get('user_id').replace('eq.', '');
    return reply(200, world.quotes[id] === uid ? [{ id: Number(id) }] : []);
  }
  return reply(404, { message: 'unexpected ' + url });
};

const goodBody = (over = {}) => ({
  to: 'Pat@BlueRidge.example', subject: 'Quote QFC-1042: Lancaster, PA to Atlanta, GA',
  message: 'Hi Pat,\n\nHere’s our quote <b>today</b>.\n\nThanks!', ccMe: false, quoteId: 1700000000001,
  validUntil: new Date(Date.now() + 24 * 3600000).toISOString(), validLabel: 'Nov 13, 2026, 5:00 PM EST',
  filename: 'Quote QFC-1042.pdf', pdf: PDF, sendKey: 'k-12345678',
  summary: { quoteNumber: 'QFC-1042', origin: 'Lancaster, PA', destination: 'Atlanta, GA', equipment: 'Dry Van', miles: '690', rate: '$2,150.00' },
  ...over,
});
const call = (body, { token = 'tok-sam', method = 'POST', host } = {}) => handler({
  httpMethod: method, headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(host ? { host } : {}) },
  body: typeof body === 'string' ? body : JSON.stringify(body),
});
const out = (r) => { try { return JSON.parse(r.body); } catch (e) { return {}; } };
const resendCall = () => world.calls.find((c) => c.url.startsWith('https://api.resend.com'));
const logCall = () => world.calls.find((c) => c.url.includes('/rest/v1/quote_emails') && c.method === 'POST');

(async () => {
  console.log('=== Who can send ===');
  reset();
  check('only POST', (await call(goodBody(), { method: 'GET' })).statusCode === 405);
  check('no sign-in: 401', (await call(goodBody(), { token: '' })).statusCode === 401);
  check('a bad token: 401', (await call(goodBody(), { token: 'tok-nobody' })).statusCode === 401);
  for (const [label, row] of [['Pro', { plan: 'pro' }], ['a cancelled Pro Plus', { is_active: false }]]) {
    reset(); Object.assign(world.pro['u-sam'], row);
    const r = await call(goodBody());
    check(`${label} can't email quotes (403, nothing sent)`, r.statusCode === 403 && out(r).error === 'plan' && !resendCall(), r.body);
  }
  reset(); world.pro = {};
  check('no account row: 403', (await call(goodBody())).statusCode === 403);
  for (const plan of ['plus', 'max', 'api']) {
    reset(); world.pro['u-sam'].plan = plan;
    check(`${plan} can`, (await call(goodBody())).statusCode === 200);
  }
  reset(); Object.assign(world.pro['u-sam'], { plan: 'pro', comp: true });
  check('comp accounts (flagged) can', (await call(goodBody())).statusCode === 200);
  reset(); Object.assign(world.pro['u-sam'], { plan: 'pro', stripe_subscription_id: null });
  check('comp accounts (active, no Stripe subscription, as the site treats them) can', (await call(goodBody())).statusCode === 200);
  reset(); Object.assign(world.pro['u-sam'], { plan: 'pro', stripe_subscription_id: null, is_active: false });
  check('but not when inactive', (await call(goodBody())).statusCode === 403);
  const saved = process.env.RESEND_API_KEY; delete process.env.RESEND_API_KEY;
  reset();
  check('without the Resend key: 503, nothing sent', (await call(goodBody())).statusCode === 503 && !resendCall());
  process.env.RESEND_API_KEY = saved;

  console.log('\n=== What can be sent ===');
  const cases = [
    ['a bad address', { to: 'pat-at-blueridge' }, 'to'],
    ['two addresses', { to: 'a@x.example, b@y.example' }, 'to'],
    ['no subject', { subject: '   ' }, 'subject'],
    ['a long message', { message: 'x'.repeat(2001) }, 'message'],
    ['valid-until in the past', { validUntil: new Date(Date.now() - 3600000).toISOString() }, 'validUntil'],
    ['valid-until years out', { validUntil: new Date(Date.now() + 800 * 86400000).toISOString() }, 'validUntil'],
    ['no PDF', { pdf: '' }, 'pdf'],
    ['something that isn’t a PDF', { pdf: Buffer.from('<html>' + 'x'.repeat(900)).toString('base64') }, 'pdf'],
  ];
  for (const [label, over, field] of cases) {
    reset();
    const r = await call(goodBody(over));
    check(`${label}: 400 on "${field}", nothing sent`, r.statusCode === 400 && out(r).field === field && !resendCall(), r.body);
  }
  reset();
  const big = Buffer.concat([Buffer.from('%PDF-1.3\n'), Buffer.alloc(3 * 1024 * 1024 + 10, 65)]).toString('base64');
  const rBig = await call(goodBody({ pdf: big }));
  check('a PDF over 3 MB: 413, nothing sent', rBig.statusCode === 413 && !resendCall(), rBig.body);
  reset();
  check('unreadable body: 400', (await call('{not json')).statusCode === 400);

  console.log('\n=== Daily limit ===');
  reset({ sent24h: 99 });
  check('Pro Plus: the 100th email in 24 hours goes out', (await call(goodBody())).statusCode === 200);
  reset({ sent24h: 100 });
  const rCap = await call(goodBody());
  check('Pro Plus: the 101st is refused (429) with the limit, nothing sent', rCap.statusCode === 429 && out(rCap).limit === 100 && /Pro Max sends up to 300/.test(out(rCap).message) && !resendCall(), rCap.body);
  reset({ sent24h: 299 }); world.pro['u-sam'].plan = 'max';
  check('Pro Max: up to 300', (await call(goodBody())).statusCode === 200);
  reset({ sent24h: 300 }); world.pro['u-sam'].plan = 'max';
  check('Pro Max: not 301', (await call(goodBody())).statusCode === 429);

  console.log('\n=== The email ===');
  reset();
  const r1 = await call(goodBody({ ccMe: true }));
  const sent = resendCall();
  const p = sent && sent.body;
  check('sent (200) with Resend’s id', r1.statusCode === 200 && out(r1).status === 'sent' && out(r1).id === 'em_123', r1.body);
  check('from "Company via QuickFreightCalc" at quotes@quickfreightcalc.com', p.from === '"Keystone Produce Logistics via QuickFreightCalc" <quotes@quickfreightcalc.com>', p.from);
  check('to the customer (lower-cased), replies to the user, a copy to the user', JSON.stringify(p.to) === '["pat@blueridge.example"]' && p.reply_to === 'sam@keystone.example' && JSON.stringify(p.cc) === '["sam@keystone.example"]');
  check('the PDF attached under its name', p.attachments.length === 1 && p.attachments[0].filename === 'Quote QFC-1042.pdf' && p.attachments[0].content === PDF);
  check('the subject as written', p.subject === 'Quote QFC-1042: Lancaster, PA to Atlanta, GA');
  check('the message escaped, the lane, rate and valid-until in the body', p.html.includes('&lt;b&gt;today&lt;/b&gt;') && !p.html.includes('<b>today') && p.html.includes('Lancaster, PA → Atlanta, GA') && p.html.includes('$2,150.00') && p.html.includes('Nov 13, 2026, 5:00 PM EST'));
  check('the user’s signature and the QuickFreightCalc footer', p.html.includes('Sam Rivera') && p.html.includes('555-0100') && p.html.includes('Sent with') && p.text.includes('Valid until: Nov 13, 2026, 5:00 PM EST'));
  check('the footer shows the logo (a PNG from the live site) beside the wordmark, amber "Freight"',
    p.html.includes('<img src="https://quickfreightcalc.com/email-logo.png" width="28" height="32" alt=""')
    && p.html.includes('Sent with <a href="https://quickfreightcalc.com" style="color:#4b5563;font-weight:700;text-decoration:none">Quick<span style="color:#d48200">Freight</span>Calc</a>'));
  check('a retry can’t send twice (idempotency key)', sent.headers['Idempotency-Key'] === 'quote-u-sam-k-12345678', JSON.stringify(sent.headers));
  const log = logCall();
  check('recorded with the logged quote', log && log.body.user_id === 'u-sam' && log.body.quote_id === '1700000000001' && log.body.to_email === 'pat@blueridge.example' && log.body.cc_me === true && log.body.resend_id === 'em_123' && !!log.body.valid_until, JSON.stringify(log && log.body));

  reset();
  await call(goodBody({ quoteId: 1700000000002 }));
  check('someone else’s quote id is not recorded', logCall().body.quote_id === null);
  reset();
  await call(goodBody({ ccMe: false }));
  check('no copy unless asked', resendCall().body.cc === undefined);

  reset(); Object.assign(world.pro['u-sam'], { plan: 'max', pdf_white_label: true });
  await call(goodBody());
  const wl = resendCall().body;
  check('white-label (Pro Max): from just the company, no QuickFreightCalc footer or logo', wl.from === '"Keystone Produce Logistics" <quotes@quickfreightcalc.com>' && !wl.html.includes('Sent with') && !wl.html.includes('email-logo') && !wl.text.includes('QuickFreightCalc'), wl.from);
  reset(); Object.assign(world.pro['u-sam'], { plan: 'plus', pdf_white_label: true });
  await call(goodBody());
  check('white-label is a Pro Max feature: Pro Plus still sends "via QuickFreightCalc"', /via QuickFreightCalc/.test(resendCall().body.from));
  reset(); world.pro['u-sam'].company_name = 'Acme "Freight", Inc.\r\nBcc: victim@example.com <x>';
  await call(goodBody());
  const fromInj = resendCall().body.from;
  check('a company name can’t break the From line', !/[\r\n]/.test(fromInj) && (fromInj.match(/"/g) || []).length === 2 && (fromInj.match(/</g) || []).length === 1, fromInj);

  reset();
  await call(goodBody(), { host: 'deploy-preview-27--quickfreightcalculator.netlify.app' });
  check('a test email from a preview deploy loads that deploy’s logo', resendCall().body.html.includes('src="https://deploy-preview-27--quickfreightcalculator.netlify.app/email-logo.png"'));
  const hosts = {
    'quickfreightcalc.com': 'https://quickfreightcalc.com', 'www.quickfreightcalc.com': 'https://quickfreightcalc.com',
    'quickfreightcalc.com:443': 'https://quickfreightcalc.com', 'dev--quickfreightcalculator.netlify.app': 'https://dev--quickfreightcalculator.netlify.app',
    'evil.example': 'https://quickfreightcalc.com', 'quickfreightcalc.com.evil.example': 'https://quickfreightcalc.com',
    'xquickfreightcalc.com': 'https://quickfreightcalc.com', 'evil--quickfreightcalculator.netlify.app.evil.example': 'https://quickfreightcalc.com', '': 'https://quickfreightcalc.com',
  };
  const wrong = Object.entries(hosts).filter(([h, want]) => _internal.assetBase({ headers: { host: h } }) !== want);
  check('only the site’s own hosts serve the logo; anything else gets the live site', wrong.length === 0, JSON.stringify(wrong));
  const png = require('fs').readFileSync(path.join(ROOT, 'email-logo.png'));
  check('the logo file ships: a 112 x 128 PNG (4x for 28 x 32), still small', png.subarray(1, 4).toString() === 'PNG' && png.readUInt32BE(16) === 112 && png.readUInt32BE(20) === 128 && png.length < 15000, png.length + ' bytes');

  console.log('\n=== When things go wrong ===');
  reset({ resend: { status: 422, body: { message: 'Invalid `to` field' } } });
  const rFail = await call(goodBody());
  check('Resend refuses: 502, nothing recorded', rFail.statusCode === 502 && !logCall(), rFail.body);
  reset({ logStatus: 500 });
  check('sent but not recorded: still reported as sent', (await call(goodBody())).statusCode === 200);

  console.log('\n=== Helpers ===');
  const sub = { stripe_subscription_id: 'sub_1' };
  check('tiers', _internal.tierOf({ is_active: true, plan: 'plus', ...sub }) === 'plus' && _internal.tierOf({ is_active: true, plan: 'pro', ...sub }) === null
    && _internal.tierOf({ is_active: true, plan: 'pro', comp: true, ...sub }) === 'comp' && _internal.tierOf({ is_active: true, plan: 'pro' }) === 'comp'
    && _internal.tierOf({ is_active: true, plan: 'weird', ...sub }) === null && _internal.tierOf(null) === null);
  check('caps', _internal.DAILY_CAP.plus === 100 && _internal.DAILY_CAP.max === 300 && _internal.DAILY_CAP.comp === 300);

  console.log(failures ? `\n${failures} EMAIL CHECK(S) FAILED` : '\nALL EMAIL CHECKS PASSED');
  process.exit(failures ? 1 : 0);
})();
