// team-email.js — the email someone gets when a Pro Max / API account owner adds them to
// their team (netlify/functions/team.js). One button: the join link, which works for
// INVITE_DAYS and only for the address it was sent to. Plain tables and inline styles,
// like quote-email.js, so it looks the same in every mail app.
const { esc } = require('./quote-email');

const INVITE_DAYS = 14;
const PLAN_LABEL = { max: 'Pro Max', api: 'API', comp: 'Pro' };

// owner: { name, company }   email: the invited address   link: the join link
// plan: 'max' | 'api' | 'comp'   siteUrl, logoUrl: as in quote-email.js
function buildInviteEmail({ owner = {}, email, link, plan, siteUrl, logoUrl }) {
  const who = owner.name || owner.company || 'Someone';
  const team = owner.company || (owner.name ? `${owner.name}’s team` : 'their team');
  const planName = PLAN_LABEL[plan] || 'Pro';
  const site = esc(siteUrl || 'https://quickfreightcalc.com');
  const subject = owner.company
    ? `${who} invited you to ${owner.company} on QuickFreightCalc`
    : `${who} invited you to their team on QuickFreightCalc`;

  const logo = logoUrl ? `<td style="padding-right:9px;vertical-align:middle"><a href="${site}" style="text-decoration:none">` +
    `<img src="${esc(logoUrl)}" width="28" height="32" alt="" style="display:block;width:28px;height:32px;border:0;outline:none;text-decoration:none"></a></td>` : '';

  const html = `<!doctype html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(subject)}</title></head>
<body style="margin:0;padding:0;background:#f3f4f6;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f3f4f6;padding:24px 12px">
    <tr><td align="center">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px">
        <tr><td style="background:#ffffff;border-radius:12px;padding:30px 28px 26px">
          <p style="margin:0 0 6px;font-size:12px;font-weight:700;letter-spacing:.06em;text-transform:uppercase;color:#6b7280">Team invite</p>
          <h1 style="margin:0 0 14px;font-size:21px;line-height:1.3;color:#111827">Join ${esc(team)} on QuickFreightCalc</h1>
          <p style="margin:0 0 14px;font-size:15px;line-height:1.55;color:#1f2937">${esc(who)} added you to their team. You’ll quote on the team’s ${esc(planName)} plan, share its quote log and customer list, and send quotes with its logo and details, signed with your own name.</p>
          <table role="presentation" cellpadding="0" cellspacing="0" style="margin:22px 0 20px"><tr>
            <td style="border-radius:8px;background:#d48200"><a href="${esc(link)}" style="display:inline-block;padding:12px 22px;font-size:15px;font-weight:700;color:#ffffff;text-decoration:none;border-radius:8px">Join the team</a></td>
          </tr></table>
          <p style="margin:0 0 10px;font-size:13px;line-height:1.55;color:#4b5563">Sign in, or create your free login, with <strong>${esc(email)}</strong>. The link works for ${INVITE_DAYS} days.</p>
          <p style="margin:0;font-size:12px;line-height:1.55;color:#9ca3af">Not expecting this? You can ignore it, and nothing happens. Questions about the team? Reply to reach ${esc(who)}.</p>
        </td></tr>
        <tr><td align="center" style="padding:20px 8px 0">
          <table role="presentation" cellpadding="0" cellspacing="0" style="margin:0 auto"><tr>
            ${logo}<td style="vertical-align:middle;font-size:13px;line-height:1.3;color:#9ca3af">Sent with <a href="${site}" style="color:#4b5563;font-weight:700;text-decoration:none">Quick<span style="color:#d48200">Freight</span>Calc</a></td>
          </tr></table>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body></html>`;

  const text = [
    `Join ${team} on QuickFreightCalc`,
    '',
    `${who} added you to their team. You’ll quote on the team’s ${planName} plan, share its quote log and customer list, and send quotes with its logo and details, signed with your own name.`,
    '',
    `Join the team: ${link}`,
    '',
    `Sign in, or create your free login, with ${email}. The link works for ${INVITE_DAYS} days.`,
    `Not expecting this? You can ignore it, and nothing happens. Questions about the team? Reply to reach ${who}.`,
    '',
    '—',
    'Sent with QuickFreightCalc',
  ].join('\n');

  return { subject, html, text };
}

module.exports = { buildInviteEmail, INVITE_DAYS };
