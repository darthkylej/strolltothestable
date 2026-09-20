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

function formatScheduleDate(value) {
  if (!value) return '';
  return new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Chicago',
    month: 'long', day: 'numeric', year: 'numeric',
    hour: 'numeric', minute: '2-digit', timeZoneName: 'short',
  }).format(new Date(value));
}

function formatLocalScheduleDate(key) {
  const [year, month, day] = String(key || '').split('-').map(Number);
  if (!year || !month || !day) return '';
  return new Intl.DateTimeFormat('en-US', {
    weekday: 'long', month: 'long', day: 'numeric',
  }).format(new Date(year, month - 1, day));
}

function formatLocalTime(value) {
  if (!value) return '';
  const [hour, minute] = String(value).split(':').map(Number);
  return new Intl.DateTimeFormat('en-US', {
    hour: 'numeric', minute: '2-digit',
  }).format(new Date(2000, 0, 1, hour, minute));
}

function dailyScheduleEmail(days, legacyStart, legacyEnd) {
  const available = (Array.isArray(days) ? days : []).filter((d) => d.available !== false);
  if (available.length) {
    return `<ul style="margin-top:6px">${available.map((d) =>
      `<li><b>${escapeHtml(formatLocalScheduleDate(d.date))}:</b> ${escapeHtml(formatLocalTime(d.start))} – ${escapeHtml(formatLocalTime(d.end))}</li>`
    ).join('')}</ul>`;
  }
  if (legacyStart && legacyEnd) {
    return `<p>${escapeHtml(formatScheduleDate(legacyStart))} – ${escapeHtml(formatScheduleDate(legacyEnd))}</p>`;
  }
  return '<p>Dates and times will be announced soon.</p>';
}

function scheduleHtml(settings) {
  if (!settings) return '';
  const registration = settings.submissionStart && settings.submissionEnd
    ? `<p>Complete your online preregistration between <b>${escapeHtml(formatScheduleDate(settings.submissionStart))}</b> and <b>${escapeHtml(formatScheduleDate(settings.submissionEnd))}</b>.</p>`
    : '<p>Preregistration dates will be announced soon.</p>';

  return `
    <div style="margin-top:22px">
      <h3>How lending your nativity works</h3>
      <p><b>Step 1: Online Preregistration</b></p>
      ${registration}
      <p><b>Step 2: Drop Off Your Nativity</b></p>
      ${dailyScheduleEmail(settings.dropoffDays, settings.dropoffStart, settings.dropoffEnd)}
      <p style="margin-top:4px">101 E Nolte St, Seguin, TX 78155</p>
      <p><b>Step 3: Pick Up Your Nativity</b></p>
      ${dailyScheduleEmail(settings.pickupDays, settings.pickupStart, settings.pickupEnd)}
      <p style="margin-top:4px">101 E Nolte St, Seguin, TX 78155</p>
    </div>`;
}

export async function sendCredentialsEmail(env, { to, name, username, password, settings }) {
  await send(env, {
    to,
    subject: 'Your Stroll to the Stable login',
    html: `
      <p>Hi ${escapeHtml(name)},</p>
      <p>You're registered for Stroll to the Stable nativity check-in. Here's your login:</p>
      <p style="font-size:18px"><b>Username:</b> ${escapeHtml(username)}<br>
      <b>Password:</b> ${escapeHtml(password)}</p>
      <p>Keep this email — you'll use these to log back in and see your nativities each year.</p>
      ${scheduleHtml(settings)}
    `,
  });
}

export async function sendForgotLoginEmail(env, { to, name, username, password, settings }) {
  await send(env, {
    to,
    subject: 'Your Stroll to the Stable login (reset)',
    html: `
      <p>Hi ${escapeHtml(name)},</p>
      <p>Here's your login — we generated a new password since you asked to have it resent:</p>
      <p style="font-size:18px"><b>Username:</b> ${escapeHtml(username)}<br>
      <b>Password:</b> ${escapeHtml(password)}</p>
      ${scheduleHtml(settings)}
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

export async function sendClaimTicketEmail(env, { to, name, nativity, pieces, settings }) {
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
      ${scheduleHtml(settings)}
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
