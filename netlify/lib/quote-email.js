// quote-email.js — the email a broker's customer receives with an emailed quote:
// the broker's message, a short summary of the quote (lane, equipment, rate,
// how long it's good for) and the broker's signature. The quote itself is the
// attached PDF. White-label senders get no QuickFreightCalc footer.
//
// Everything that came from the user is escaped; the HTML is plain tables and
// inline styles so it renders the same in Gmail, Outlook and phone mail apps.

const esc = (s) => String(s == null ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

// "Nov 19, 2026, 5:00 PM ET"-style text for the validity line. The browser
// sends the user's own wording (it knows their time zone); this is the
// fallback when it doesn't.
function validText(validUntil, label) {
  if (label) return String(label);
  if (!validUntil) return '';
  const d = new Date(validUntil);
  if (isNaN(d)) return '';
  return d.toLocaleString('en-US', { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit', timeZone: 'America/New_York', timeZoneName: 'short' });
}

// summary: { quoteNumber, origin, destination, equipment, miles, rate, pickup, delivery }
// sender:  { company, contactName, phone, email }
// logoUrl: the logo mark as a PNG (email apps don't show SVG) for the "Sent with QuickFreightCalc" line
function buildQuoteEmail({ message, summary = {}, sender = {}, validUntil, validLabel, whiteLabel, siteUrl, logoUrl }) {
  const s = summary;
  const lane = [s.origin, s.destination].filter(Boolean).join(' → ');
  const valid = validText(validUntil, validLabel);
  const rows = [
    ['Lane', lane],
    ['Equipment', [s.equipment, s.miles ? `${s.miles} mi` : ''].filter(Boolean).join(' · ')],
    ['Pickup', s.pickup],
    ['Delivery', s.delivery],
    ['Rate', s.rate],
    ['Valid until', valid],
  ].filter(([, v]) => v);
  const sigLines = [sender.contactName, sender.company, sender.phone, sender.email].filter(Boolean);
  const paragraphs = String(message || '').trim().split(/\n{2,}/).filter(Boolean);

  const msgHtml = paragraphs.map((p) =>
    `<p style="margin:0 0 14px;font-size:15px;line-height:1.55;color:#1f2937">${esc(p).replace(/\n/g, '<br>')}</p>`).join('');
  const rowsHtml = rows.map(([k, v], i) => `
          <tr>
            <td style="padding:9px 0;${i ? 'border-top:1px solid #e5e7eb;' : ''}font-size:13px;color:#6b7280;width:110px;vertical-align:top">${esc(k)}</td>
            <td style="padding:9px 0;${i ? 'border-top:1px solid #e5e7eb;' : ''}font-size:14px;color:#111827;font-weight:${k === 'Rate' ? '700' : '500'}">${esc(v)}</td>
          </tr>`).join('');
  const title = s.quoteNumber ? `Quote ${esc(s.quoteNumber)}` : 'Rate quote';
  // The logo and the wordmark (amber "Freight", as on the site), then who replies reach. The image is
  // decorative (empty alt): with images off, the wordmark still reads.
  const site = esc(siteUrl || 'https://quickfreightcalc.com');
  const logo = logoUrl ? `<td style="padding-right:9px;vertical-align:middle"><a href="${site}" style="text-decoration:none">` +
    `<img src="${esc(logoUrl)}" width="28" height="32" alt="" style="display:block;width:28px;height:32px;border:0;outline:none;text-decoration:none"></a></td>` : '';
  const footer = whiteLabel ? '' : `
      <tr><td align="center" style="padding:20px 8px 0">
        <table role="presentation" cellpadding="0" cellspacing="0" style="margin:0 auto"><tr>
          ${logo}<td style="vertical-align:middle;font-size:13px;line-height:1.3;color:#9ca3af">Sent with <a href="${site}" style="color:#4b5563;font-weight:700;text-decoration:none">Quick<span style="color:#d48200">Freight</span>Calc</a></td>
        </tr></table>
        <div style="font-size:12px;line-height:1.5;color:#9ca3af;margin-top:6px">Reply to this email to reach ${esc(sender.contactName || sender.company || 'the sender')}.</div>
      </td></tr>`;

  const html = `<!doctype html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title></head>
<body style="margin:0;padding:0;background:#f3f4f6;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f3f4f6;padding:24px 12px">
    <tr><td align="center">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px">
        <tr><td style="background:#ffffff;border-radius:12px;padding:28px 28px 22px">
          ${msgHtml}
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:6px 0 16px;border:1px solid #e5e7eb;border-radius:10px">
            <tr><td style="padding:14px 18px 6px;font-size:12px;font-weight:700;letter-spacing:.06em;text-transform:uppercase;color:#6b7280">${title}</td></tr>
            <tr><td style="padding:0 18px 8px">
              <table role="presentation" width="100%" cellpadding="0" cellspacing="0">${rowsHtml}
              </table>
            </td></tr>
          </table>
          <p style="margin:0 0 18px;font-size:13px;color:#6b7280">The full quote is attached as a PDF.</p>
          ${sigLines.length ? `<p style="margin:0;font-size:14px;line-height:1.5;color:#374151">${sigLines.map(esc).join('<br>')}</p>` : ''}
        </td></tr>${footer}
      </table>
    </td></tr>
  </table>
</body></html>`;

  const text = [
    String(message || '').trim(),
    '',
    `${s.quoteNumber ? `Quote ${s.quoteNumber}` : 'Rate quote'}`,
    ...rows.map(([k, v]) => `${k}: ${v}`),
    '',
    'The full quote is attached as a PDF.',
    sigLines.length ? `\n${sigLines.join('\n')}` : '',
    whiteLabel ? '' : '\n—\nSent with QuickFreightCalc. Reply to this email to reach the sender.',
  ].join('\n').replace(/\n{3,}/g, '\n\n').trim() + '\n';

  return { html, text };
}

// A display name that is safe inside a From header: no quotes, angle brackets,
// commas, semicolons or line breaks, and not too long.
function headerName(s, max = 60) {
  return String(s || '').replace(/[\r\n"<>,;\\]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max).trim();
}

module.exports = { buildQuoteEmail, headerName, validText, esc };
