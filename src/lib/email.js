// Thin wrapper over the Resend REST API — no SDK needed, matches how
// Resend is used in your other Cloudflare apps against the same domain.

async function send(env, { to, subject, html }) {
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${env.RESEND_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ from: env.RESEND_FROM, to, subject, html }),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Resend error ${res.status}: ${body}`);
  }
}

export async function sendCredentialsEmail(env, { to, name, username, password }) {
  await send(env, {
    to,
    subject: 'Your Stroll to the Stable login',
    html: `
      <p>Hi ${escapeHtml(name)},</p>
      <p>You're registered for Stroll to the Stable nativity check-in. Here's your login:</p>
      <p style="font-size:18px"><b>Username:</b> ${escapeHtml(username)}<br>
      <b>Password:</b> ${escapeHtml(password)}</p>
      <p>Keep this email — you'll use these to log back in and see your nativities each year.</p>
    `,
  });
}

export async function sendForgotLoginEmail(env, { to, name, username, password }) {
  await send(env, {
    to,
    subject: 'Your Stroll to the Stable login (reset)',
    html: `
      <p>Hi ${escapeHtml(name)},</p>
      <p>Here's your login — we generated a new password since you asked to have it resent:</p>
      <p style="font-size:18px"><b>Username:</b> ${escapeHtml(username)}<br>
      <b>Password:</b> ${escapeHtml(password)}</p>
    `,
  });
}

export async function sendAdminOtpEmail(env, { to, code }) {
  await send(env, {
    to,
    subject: 'Your admin login code',
    html: `<p>Your one-time code is:</p><p style="font-size:28px;letter-spacing:4px"><b>${code}</b></p><p>It expires in 10 minutes.</p>`,
  });
}

export async function sendClaimTicketEmail(env, { to, name, nativity, pieces }) {
  const pieceRows = pieces
    .map(
      (p) => `<tr>
        <td style="padding:4px 8px;border:1px solid #ddd">${p.piece_number}</td>
        <td style="padding:4px 8px;border:1px solid #ddd">${escapeHtml(p.description)}</td>
        <td style="padding:4px 8px;border:1px solid #ddd">${escapeHtml(p.condition_notes)}</td>
      </tr>`
    )
    .join('');
  await send(env, {
    to,
    subject: `Nativity checked in — claim ticket ${nativity.submission_number}`,
    html: `
      <p>Hi ${escapeHtml(name)},</p>
      <p>Thank you for lending your nativity for Stroll to the Stable! It's been checked in and verified.</p>
      <p><b>Claim ticket number: ${nativity.submission_number}</b><br>
      Keep this email — you'll need this number to pick up your nativity after the event.</p>
      ${nativity.story ? `<p><i>${escapeHtml(nativity.story)}</i></p>` : ''}
      <table style="border-collapse:collapse;margin-top:12px">
        <tr><th style="padding:4px 8px;border:1px solid #ddd">#</th>
            <th style="padding:4px 8px;border:1px solid #ddd">Piece</th>
            <th style="padding:4px 8px;border:1px solid #ddd">Condition noted</th></tr>
        ${pieceRows}
      </table>
    `,
  });
}

function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[c]);
}
