// netlify/functions/trial-reminders.js
// Scheduled (hourly, netlify.toml). Three days before a free trial ends, emails the
// subscriber the date it ends and what their card will be charged then, so the first
// bill is never a surprise. Once per trial: pro_users.trial_reminder_sent_at is set
// (claimed before sending, released again if the email fails, so the next run retries).
// Nobody is emailed whose subscription is already set to end (cancel_at).
const { PLAN_NAME, PLAN_PRICE, normalizePlan } = require('../lib/plans.js');

const SUPABASE_URL = 'https://xgrmbhmgcsbnazupfybd.supabase.co';
const REMIND_BEFORE_MS = 3 * 24 * 60 * 60 * 1000;
const FROM = 'QuickFreightCalc <donotreply@quickfreightcalc.com>';

function headers(serviceKey, extra){
  return Object.assign({ apikey: serviceKey, Authorization: `Bearer ${serviceKey}`, 'Content-Type': 'application/json' }, extra || {});
}

const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// The email for one subscriber: { subject, text, html }.
function buildReminder(row, siteUrl){
  const plan = normalizePlan(row.plan);
  const name = PLAN_NAME[plan];
  const prices = PLAN_PRICE[plan] || PLAN_PRICE.pro;
  const price = row.billing_interval === 'year' && prices.year ? `${prices.year}/year` : `${prices.month}/month`;
  const day = new Date(row.trial_ends_at).toLocaleDateString('en-US', { timeZone: 'America/New_York', month: 'long', day: 'numeric' });
  const when = new Date(row.trial_ends_at).toLocaleDateString('en-US', { timeZone: 'America/New_York', weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' });
  const profile = `${siteUrl}/profile.html#subscription-paid`;
  const subject = `Your QuickFreightCalc ${name} free trial ends on ${day}`;
  const text = `Your free trial of QuickFreightCalc ${name} ends on ${when}.

Unless you cancel before then, your card will be charged ${price} for ${name} that day, and every ${row.billing_interval === 'year' ? 'year' : 'month'} after until you cancel.

To keep ${name}, you don't need to do anything.
To switch plans or cancel, go to Profile, then Subscription: ${profile}

— The QuickFreightCalc team
`;
  const html = `<!DOCTYPE html><html><head><meta charset="UTF-8"></head>
<body style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Arial,sans-serif;background:#f4f6f9;margin:0;padding:32px 16px;color:#1a2540;line-height:1.5">
  <div style="max-width:560px;margin:0 auto;background:#ffffff;border-radius:10px;overflow:hidden">
    <div style="background:#1a1f2e;padding:22px 30px"><p style="font-size:18px;font-weight:700;color:#ffffff;margin:0">Quick<span style="color:#f0a500">Freight</span>Calc</p></div>
    <div style="height:4px;background:#f0a500"></div>
    <div style="padding:28px 30px">
      <h1 style="font-size:20px;margin:0 0 14px">Your free trial ends on ${esc(when)}</h1>
      <p style="margin:0 0 14px;font-size:14px;color:#4a5e7a">Unless you cancel before then, your card will be charged <strong style="color:#1a2540">${esc(price)}</strong> for ${esc(name)} that day, and every ${row.billing_interval === 'year' ? 'year' : 'month'} after until you cancel.</p>
      <p style="margin:0 0 20px;font-size:14px;color:#4a5e7a">To keep ${esc(name)}, you don't need to do anything. To switch plans or cancel, go to your Profile.</p>
      <p style="text-align:center;margin:0 0 8px"><a href="${esc(profile)}" style="display:inline-block;padding:12px 26px;background:#f0a500;color:#000000;text-decoration:none;font-weight:700;font-size:14px;border-radius:8px">Manage my plan</a></p>
    </div>
    <div style="padding:18px 30px;font-size:12px;color:#8896a8;border-top:1px solid #e4e8ef;text-align:center">QuickFreightCalc · quickfreightcalc.com</div>
  </div>
</body></html>`;
  return { subject, text, html };
}

async function patchRow(serviceKey, id, filter, data){
  const resp = await fetch(`${SUPABASE_URL}/rest/v1/pro_users?id=eq.${encodeURIComponent(id)}${filter}`, {
    method: 'PATCH',
    headers: headers(serviceKey, { Prefer: 'return=representation' }),
    body: JSON.stringify(data),
  });
  const rows = resp.ok ? await resp.json().catch(() => []) : [];
  return Array.isArray(rows) && rows.length > 0;
}

exports.handler = async function(){
  const serviceKey = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;
  const apiKey = process.env.RESEND_API_KEY;
  if(!serviceKey || !apiKey){
    console.error('[trial-reminders] missing SUPABASE_SERVICE_KEY or RESEND_API_KEY');
    return { statusCode: 200, body: 'not configured' };
  }
  const siteUrl = process.env.SITE_URL || 'https://quickfreightcalc.com';
  const now = new Date(Date.now());
  const until = new Date(now.getTime() + REMIND_BEFORE_MS);
  const query = '/rest/v1/pro_users?is_active=eq.true&trial_reminder_sent_at=is.null' +
    `&trial_ends_at=gt.${encodeURIComponent(now.toISOString())}&trial_ends_at=lte.${encodeURIComponent(until.toISOString())}` +
    '&select=id,email,plan,billing_interval,trial_ends_at,cancel_at';
  let rows = [];
  try {
    const resp = await fetch(SUPABASE_URL + query, { headers: headers(serviceKey) });
    rows = resp.ok ? await resp.json() : [];
  } catch(e){
    console.error('[trial-reminders] could not read trials:', e.message);
    return { statusCode: 200, body: 'read failed' };
  }

  const summary = { due: rows.length, sent: 0, skipped: 0, failed: 0 };
  for(const row of rows){
    // Claim it first, so two runs can't both send it.
    const claimed = await patchRow(serviceKey, row.id, '&trial_reminder_sent_at=is.null', { trial_reminder_sent_at: now.toISOString() });
    if(!claimed) continue;
    if(row.cancel_at || !row.email){ summary.skipped++; continue; }   // cancelled: nothing will be charged
    const { subject, text, html } = buildReminder(row, siteUrl);
    try {
      const resp = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ from: FROM, to: [row.email], subject, text, html }),
      });
      if(!resp.ok) throw new Error(`Resend ${resp.status}`);
      summary.sent++;
    } catch(e){
      summary.failed++;
      console.error(`[trial-reminders] ${row.id.slice(0, 8)}: ${e.message}`);
      await patchRow(serviceKey, row.id, '', { trial_reminder_sent_at: null });   // try again next run
    }
  }
  console.log('[trial-reminders]', JSON.stringify(summary));
  return { statusCode: 200, body: JSON.stringify(summary) };
};

exports._internal = { buildReminder };
