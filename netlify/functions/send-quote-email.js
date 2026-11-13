// send-quote-email.js — emails a quote PDF to a broker's customer (Pro Plus and up).
//
// POST /.netlify/functions/send-quote-email
//   Authorization: Bearer <Supabase access token>
//   { to, subject, message, ccMe, quoteId, validUntil, validLabel, filename, pdf, summary, sendKey }
//     pdf      the quote as a PDF, base64 — made in the user's browser from their own quote document
//     summary  { quoteNumber, origin, destination, equipment, miles, rate, pickup, delivery } for the email body
//     sendKey  a random key per click, so a retried request can't send twice
//
// Checks who is sending (signed in; Pro Plus, Pro Max, API or comp), what (one recipient, a real PDF
// under 3 MB, sensible text) and how many (a rolling 24-hour cap per plan, so a misused account can't
// send in bulk). Sends through Resend from quotes@quickfreightcalc.com as "<Company> via QuickFreightCalc"
// (just the company for white-label accounts) with Reply-To the user, then records the send in
// quote_emails (the quote log shows it).
//
// Responses: 200 { status: 'sent', id, sentAt }
//            400 { error: 'invalid', field, message }    401 { error: 'auth', message }
//            403 { error: 'plan', message }               413 { error: 'too_large', message }
//            429 { error: 'limit', limit, message }       502 { error: 'send', message }
//            503 { error: 'not_configured', message }
const { buildQuoteEmail, headerName } = require('../lib/quote-email');
const { normalizePlan, PLAN_NAME: PLANS_NAME } = require('../lib/plans');

const SUPABASE_URL = process.env.SUPABASE_URL || 'https://xgrmbhmgcsbnazupfybd.supabase.co';
const FROM_ADDRESS = 'quotes@quickfreightcalc.com';
const PLAN_NAME = { ...PLANS_NAME, comp: 'your plan' };
// Emails per rolling 24 hours
const DAILY_CAP = { plus: 100, max: 300, api: 300, comp: 300 };
const MAX_PDF_BYTES = 3 * 1024 * 1024;
const MAX_BODY_CHARS = 5 * 1024 * 1024;
const EMAIL_RE = /^[^\s@,;<>]+@[^\s@,;<>]+\.[^\s@,;<>]{2,}$/;

const json = (statusCode, body) => ({
  statusCode,
  headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  body: JSON.stringify(body),
});
const tidy = (s, max) => String(s === null || s === undefined ? '' : s).replace(/[\r\n\t]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
const bad = (field, message) => json(400, { error: 'invalid', field, message });

function serviceKey() {
  return process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY || '';
}

async function supabase(path, { method = 'GET', body, headers = {} } = {}) {
  const key = serviceKey();
  const resp = await fetch(SUPABASE_URL + path, {
    method,
    headers: { apikey: key, Authorization: `Bearer ${key}`, ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await resp.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch (e) {}
  return { ok: resp.ok, status: resp.status, data, headers: resp.headers };
}

// The signed-in user behind the access token, or null.
async function authUser(token) {
  if (!token) return null;
  try {
    const resp = await fetch(`${SUPABASE_URL}/auth/v1/user`, { headers: { apikey: serviceKey(), Authorization: `Bearer ${token}` } });
    if (!resp.ok) return null;
    const u = await resp.json();
    return u && u.id ? u : null;
  } catch (e) { return null; }
}

// Which emailing tier an account is on, or null if it can't email quotes. Comp accounts are active with
// no Stripe subscription (the rule the rest of the site uses), or flagged comp.
function tierOf(row) {
  if (!row || row.is_active !== true) return null;
  if (row.comp === true || !row.stripe_subscription_id) return 'comp';
  const plan = normalizePlan(row.plan);
  return ['plus', 'max', 'api'].includes(plan) ? plan : null;
}

// What the request asks for, checked. Returns { error } (a response) or { value }.
function parseRequest(body) {
  const to = tidy(body.to, 250).toLowerCase();
  if (!to || to.length > 200 || !EMAIL_RE.test(to)) return { error: bad('to', 'Enter one valid email address for the customer.') };
  const subject = tidy(body.subject, 400);
  if (!subject) return { error: bad('subject', 'Add a subject.') };
  if (subject.length > 150) return { error: bad('subject', 'Keep the subject under 150 characters.') };
  const message = String(body.message === null || body.message === undefined ? '' : body.message).replace(/\r\n?/g, '\n').trim();
  if (message.length > 2000) return { error: bad('message', 'Keep the message under 2,000 characters.') };

  let validUntil = null;
  if (body.validUntil) {
    const d = new Date(body.validUntil);
    const now = Date.now();
    if (isNaN(d) || d.getTime() < now - 5 * 60000 || d.getTime() > now + 366 * 86400000) {
      return { error: bad('validUntil', '“Valid until” has to be a date in the next year.') };
    }
    validUntil = d.toISOString();
  }
  const validLabel = tidy(body.validLabel, 60);

  const pdf = typeof body.pdf === 'string' ? body.pdf.replace(/\s+/g, '') : '';
  if (!pdf || !/^[A-Za-z0-9+/]+={0,2}$/.test(pdf)) return { error: bad('pdf', 'The quote PDF is missing. Try again.') };
  const bytes = Buffer.from(pdf, 'base64');
  if (bytes.length > MAX_PDF_BYTES) return { error: json(413, { error: 'too_large', message: 'The quote PDF is too large to email (over 3 MB). Try a smaller logo.' }) };
  if (bytes.length < 500 || bytes.subarray(0, 5).toString('latin1') !== '%PDF-') return { error: bad('pdf', 'The quote PDF didn’t come through. Try again.') };

  let filename = tidy(body.filename, 120).replace(/\.pdf$/i, '').replace(/[^A-Za-z0-9 ._-]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 70);
  filename = (filename || 'Quote') + '.pdf';

  const s = body.summary && typeof body.summary === 'object' ? body.summary : {};
  const summary = {};
  for (const k of ['quoteNumber', 'origin', 'destination', 'equipment', 'miles', 'rate', 'pickup', 'delivery']) {
    const v = tidy(s[k], k === 'rate' || k === 'miles' || k === 'quoteNumber' ? 40 : 120);
    if (v) summary[k] = v;
  }

  const qid = body.quoteId === null || body.quoteId === undefined || body.quoteId === '' ? null : String(body.quoteId);
  const quoteId = qid && /^\d{1,19}$/.test(qid) ? qid : null;
  const sendKey = typeof body.sendKey === 'string' && /^[A-Za-z0-9-]{8,64}$/.test(body.sendKey) ? body.sendKey : null;

  return { value: { to, subject, message, ccMe: body.ccMe === true, validUntil, validLabel, pdf, filename, summary, quoteId, sendKey } };
}

// Where the email's logo image loads from: the live site, or the Netlify deploy the quote was sent
// from (so a test email from a preview shows that deploy's copy). Only the site's own hosts count.
function assetBase(event) {
  const h = (event && event.headers) || {};
  const host = String(h['x-forwarded-host'] || h.host || h.Host || '').toLowerCase().split(':')[0].trim();
  if (/^(www\.)?quickfreightcalc\.com$/.test(host)) return 'https://quickfreightcalc.com';
  if (/^([a-z0-9-]+--)?quickfreightcalculator\.netlify\.app$/.test(host)) return `https://${host}`;
  return process.env.SITE_URL || 'https://quickfreightcalc.com';
}

// Emails sent in the last 24 hours (null if the count couldn't be read).
async function sentToday(userId) {
  const since = new Date(Date.now() - 24 * 3600000).toISOString();
  const r = await supabase(`/rest/v1/quote_emails?user_id=eq.${userId}&created_at=gte.${encodeURIComponent(since)}&select=id`,
    { headers: { Prefer: 'count=exact', 'Range-Unit': 'items', Range: '0-0' } });
  if (!r.ok && r.status !== 416) return null;
  const range = (r.headers && r.headers.get('content-range')) || '';
  const total = Number(range.split('/')[1]);
  return Number.isFinite(total) ? total : null;
}

async function sendWithResend(apiKey, payload, idempotencyKey) {
  const resp = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json', ...(idempotencyKey ? { 'Idempotency-Key': idempotencyKey } : {}) },
    body: JSON.stringify(payload),
  });
  let data = null;
  try { data = await resp.json(); } catch (e) {}
  return { ok: resp.ok, status: resp.status, data };
}

exports.handler = async function (event) {
  if (event.httpMethod !== 'POST') return json(405, { error: 'method', message: 'Use POST.' });

  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey || !serviceKey()) {
    console.error('[send-quote-email] RESEND_API_KEY or the Supabase service key is not set');
    return json(503, { error: 'not_configured', message: 'Emailing quotes isn’t available right now.' });
  }

  const raw = event.isBase64Encoded ? Buffer.from(event.body || '', 'base64').toString('utf8') : (event.body || '');
  if (raw.length > MAX_BODY_CHARS) return json(413, { error: 'too_large', message: 'The quote PDF is too large to email (over 3 MB). Try a smaller logo.' });
  let body;
  try { body = JSON.parse(raw || '{}'); } catch (e) { return bad('body', 'The request wasn’t readable. Try again.'); }
  if (!body || typeof body !== 'object') return bad('body', 'The request wasn’t readable. Try again.');

  // Who's sending
  const auth = (event.headers && (event.headers.authorization || event.headers.Authorization)) || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7).trim() : '';
  const user = await authUser(token);
  if (!user) return json(401, { error: 'auth', message: 'Sign in again to send quotes.' });

  const pr = await supabase(`/rest/v1/pro_users?id=eq.${user.id}&select=id,email,company_name,contact_name,phone,plan,is_active,comp,stripe_subscription_id,pdf_white_label`);
  if (!pr.ok) {
    console.error('[send-quote-email] pro_users lookup failed', pr.status);
    return json(502, { error: 'send', message: 'Couldn’t check your account right now. Try again in a minute.' });
  }
  const row = Array.isArray(pr.data) ? pr.data[0] : null;
  const tier = tierOf(row);
  if (!tier) return json(403, { error: 'plan', message: 'Emailing quotes comes with Pro Plus, Pro Max and the API plan.' });

  // What they're sending
  const parsed = parseRequest(body);
  if (parsed.error) return parsed.error;
  const req = parsed.value;

  // How many today
  const cap = DAILY_CAP[tier];
  const count = await sentToday(user.id);
  if (count === null) {
    console.error('[send-quote-email] could not count today’s emails');
    return json(502, { error: 'send', message: 'Couldn’t send the quote right now. Try again in a minute.' });
  }
  if (count >= cap) {
    const more = tier === 'plus' ? ' Pro Max sends up to 300 a day.' : '';
    return json(429, { error: 'limit', limit: cap, message: `You’ve emailed ${cap} quotes in the last 24 hours, the most ${PLAN_NAME[tier]} allows. Try again later.${more}` });
  }

  // A quote id only counts if it's this user's logged quote
  let quoteId = null;
  if (req.quoteId) {
    const q = await supabase(`/rest/v1/quote_log?id=eq.${req.quoteId}&user_id=eq.${user.id}&select=id`);
    if (q.ok && Array.isArray(q.data) && q.data.length) quoteId = req.quoteId;
  }

  const userEmail = tidy(user.email || row.email, 200).toLowerCase();
  const whiteLabel = row.pdf_white_label === true && ['max', 'api', 'comp'].includes(tier);
  const company = headerName(row.company_name) || headerName(row.contact_name);
  const fromName = company ? (whiteLabel ? company : `${company} via QuickFreightCalc`) : 'QuickFreightCalc Quotes';
  const siteUrl = process.env.SITE_URL || 'https://quickfreightcalc.com';
  const { html, text } = buildQuoteEmail({
    message: req.message,
    summary: req.summary,
    sender: { company: tidy(row.company_name, 120), contactName: tidy(row.contact_name, 120), phone: tidy(row.phone, 40), email: userEmail },
    validUntil: req.validUntil,
    validLabel: req.validLabel,
    whiteLabel,
    siteUrl,
    logoUrl: `${assetBase(event)}/email-logo.png`,
  });

  const payload = {
    from: `"${fromName}" <${FROM_ADDRESS}>`,
    to: [req.to],
    subject: req.subject,
    html,
    text,
    attachments: [{ filename: req.filename, content: req.pdf }],
    tags: [{ name: 'kind', value: 'quote' }],
  };
  if (EMAIL_RE.test(userEmail)) {
    payload.reply_to = userEmail;
    if (req.ccMe && userEmail !== req.to) payload.cc = [userEmail];
  }

  let sent;
  try {
    sent = await sendWithResend(apiKey, payload, req.sendKey ? `quote-${user.id}-${req.sendKey}` : null);
  } catch (e) {
    console.error('[send-quote-email] Resend request failed:', e.message);
    return json(502, { error: 'send', message: 'Couldn’t send the quote right now. Try again in a minute.' });
  }
  if (!sent.ok) {
    console.error('[send-quote-email] Resend returned', sent.status, JSON.stringify(sent.data));
    const busy = sent.status === 429;
    return json(502, { error: 'send', message: busy ? 'The email service is busy. Try again in a minute.' : 'The email couldn’t be sent. Check the address and try again.' });
  }

  const sentAt = new Date().toISOString();
  const resendId = sent.data && typeof sent.data.id === 'string' ? sent.data.id.slice(0, 100) : null;
  const log = await supabase('/rest/v1/quote_emails', {
    method: 'POST',
    headers: { Prefer: 'return=minimal' },
    body: { user_id: user.id, quote_id: quoteId, to_email: req.to, cc_me: !!payload.cc, subject: req.subject, valid_until: req.validUntil, resend_id: resendId },
  });
  if (!log.ok) console.error('[send-quote-email] sent, but logging failed', log.status, JSON.stringify(log.data));

  console.log(`[send-quote-email] sent ${resendId || '(no id)'} for ${user.id} (${tier}, ${count + 1}/${cap} today)`);
  return json(200, { status: 'sent', id: resendId, sentAt, quoteId });
};

// For tests
exports._internal = { parseRequest, tierOf, assetBase, DAILY_CAP };
