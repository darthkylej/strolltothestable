const DEFAULT_FROM = {
  email: 'submissions@strolltothestable.com',
  name: 'Stroll to the Stable',
};

async function send(env, { to, cc, from = DEFAULT_FROM, replyTo = DEFAULT_FROM.email, subject, html, text }) {
  if (!env.EMAIL) throw new Error('Cloudflare Email Sending is not configured.');

  await env.EMAIL.send({
    from,
    to,
    ...(cc ? { cc } : {}),
    replyTo,
    subject,
    html,
    ...(text ? { text } : {}),
  });
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
  const registration = settings.submissionEnd
    ? `<p>Complete your online preregistration by <b>${escapeHtml(formatScheduleDate(settings.submissionEnd))}</b>.</p>`
    : '<p>The preregistration deadline will be announced soon.</p>';

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

export async function sendForgotLoginEmail(env, { to, name, username, recoveryUrl, settings }) {
  await send(env, {
    to,
    subject: 'Your Stroll to the Stable login link',
    html: `
      <p>Hi ${escapeHtml(name)},</p>
      <p>You asked for help getting back into your Stroll to the Stable account.</p>
      <p><b>Username:</b> ${escapeHtml(username)}</p>
      <p>Your existing password has not been changed.</p>
      <p><a href="${escapeHtml(recoveryUrl)}" style="display:inline-block;padding:12px 18px;background:#203a5f;color:#ffffff;text-decoration:none;border-radius:8px;font-weight:700">Log In to My Account</a></p>
      <p style="font-size:13px;color:#666">This secure link expires in 30 minutes. If you did not request it, you can ignore this email.</p>
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

function photoUrl(baseUrl, key) {
  if (!baseUrl || !key) return '';
  const safeKey = String(key).split('/').map(encodeURIComponent).join('/');
  return `${String(baseUrl).replace(/\/$/, '')}/photos/${safeKey}`;
}

function emailShell({ eyebrow, title, intro, body }) {
  return `
    <div style="margin:0;padding:28px 14px;background:#f4f1e8;font-family:Arial,Helvetica,sans-serif;color:#243142">
      <div style="max-width:680px;margin:0 auto;background:#ffffff;border:1px solid #ded8ca;border-radius:16px;overflow:hidden">
        <div style="padding:28px 30px;background:#12233d;color:#ffffff">
          <div style="font-size:12px;letter-spacing:.12em;text-transform:uppercase;color:#e8c878;font-weight:700">${eyebrow}</div>
          <h1 style="margin:8px 0 0;font-size:27px;line-height:1.2;color:#ffffff">${title}</h1>
        </div>
        <div style="padding:28px 30px">
          ${intro}
          ${body}
          <div style="margin-top:28px;padding-top:18px;border-top:1px solid #e7e1d5;color:#6b7280;font-size:13px;line-height:1.5">
            Questions or special arrangements? Email
            <a href="mailto:submissions@strolltothestable.com" style="color:#203a5f;font-weight:700">submissions@strolltothestable.com</a>.
          </div>
        </div>
      </div>
    </div>`;
}

function schedulePanel(title, days, legacyStart, legacyEnd) {
  const available = (Array.isArray(days) ? days : []).filter((d) => d.available !== false);
  let rows = '';
  if (available.length) {
    rows = available.map((d) => `
      <tr>
        <td style="padding:8px 10px;border-bottom:1px solid #ece7dd;font-weight:700;color:#243142">${escapeHtml(formatLocalScheduleDate(d.date))}</td>
        <td style="padding:8px 10px;border-bottom:1px solid #ece7dd;color:#4b5563">${escapeHtml(formatLocalTime(d.start))} – ${escapeHtml(formatLocalTime(d.end))}</td>
      </tr>`).join('');
  } else if (legacyStart && legacyEnd) {
    rows = `<tr><td colspan="2" style="padding:8px 10px;color:#4b5563">${escapeHtml(formatScheduleDate(legacyStart))} – ${escapeHtml(formatScheduleDate(legacyEnd))}</td></tr>`;
  } else {
    rows = '<tr><td colspan="2" style="padding:8px 10px;color:#4b5563">Dates and times will be announced soon.</td></tr>';
  }

  return `
    <div style="margin-top:22px;border:1px solid #ded8ca;border-radius:12px;overflow:hidden">
      <div style="padding:12px 14px;background:#f7f3e8;font-weight:800;color:#243142">${escapeHtml(title)}</div>
      <table role="presentation" style="width:100%;border-collapse:collapse">${rows}</table>
      <div style="padding:11px 14px;background:#fbfaf7;color:#4b5563;font-size:14px">
        <b>Location:</b> 101 E Nolte St, Seguin, TX 78155
      </div>
    </div>`;
}

function photoGalleryHtml(baseUrl, nativity, pieces) {
  const photos = [];
  if (nativity.photo_key) photos.push({ key: nativity.photo_key, label: 'Nativity photo' });
  for (const p of pieces || []) {
    if (p.photo_key) photos.push({ key: p.photo_key, label: `Piece ${p.piece_number}: ${p.description || 'Photo'}` });
  }
  if (nativity.display_photo_key && nativity.display_photo_key !== nativity.photo_key) {
    photos.push({ key: nativity.display_photo_key, label: 'Display photo' });
  }
  if (!photos.length) return '';

  return `
    <div style="margin-top:24px">
      <h2 style="margin:0 0 12px;font-size:18px;color:#243142">Photos on file</h2>
      <div>
        ${photos.map((p) => `
          <div style="margin:0 0 16px">
            <img src="${escapeHtml(photoUrl(baseUrl, p.key))}" alt="${escapeHtml(p.label)}" style="display:block;width:100%;max-width:560px;height:auto;border-radius:10px;border:1px solid #ded8ca">
            <div style="margin-top:5px;color:#6b7280;font-size:12px">${escapeHtml(p.label)}</div>
          </div>`).join('')}
      </div>
    </div>`;
}

export async function sendPreregistrationEmail(env, { to, name, nativity, pieces, settings }) {
  const intro = `
    <p style="margin:0 0 14px;font-size:16px;line-height:1.6">Hi ${escapeHtml(name)},</p>
    <p style="margin:0 0 14px;font-size:16px;line-height:1.6">Thank you for preregistering your nativity for <b>Stroll to the Stable</b>. We are grateful that you are willing to share it with our community.</p>
    <div style="margin:18px 0;padding:14px 16px;border-radius:10px;background:#f7f3e8;border:1px solid #e5ddca">
      <div style="font-size:12px;text-transform:uppercase;letter-spacing:.08em;color:#806c3d;font-weight:700">Submission number</div>
      <div style="margin-top:4px;font-size:22px;font-weight:800;color:#243142">${escapeHtml(nativity.submission_number)}</div>
    </div>`;

  const body = `
    <p style="margin:0;font-size:16px;line-height:1.6">Your online preregistration is complete. The next step is to bring your nativity to us during one of the drop-off times below.</p>
    ${schedulePanel('Drop-off times', settings?.dropoffDays, settings?.dropoffStart, settings?.dropoffEnd)}
    <p style="margin:20px 0 0;color:#4b5563;font-size:14px;line-height:1.6">Please keep your submission number handy when you arrive. If your plans change or you need a special drop-off arrangement, contact us and we will do our best to help.</p>`;

  await send(env, {
    to,
    subject: `Nativity preregistration received — ${nativity.submission_number}`,
    html: emailShell({
      eyebrow: 'Stroll to the Stable',
      title: 'Thank you for preregistering',
      intro,
      body,
    }),
  });
}

export async function sendClaimTicketEmail(env, { to, name, nativity, pieces, settings, baseUrl }) {
  const pieceRows = pieces.map((p) => `
    <tr>
      <td style="padding:8px 10px;border-bottom:1px solid #ece7dd;color:#4b5563">${p.piece_number}</td>
      <td style="padding:8px 10px;border-bottom:1px solid #ece7dd;color:#243142">${escapeHtml(p.description)}</td>
      <td style="padding:8px 10px;border-bottom:1px solid #ece7dd;color:#4b5563">${escapeHtml(p.condition_notes)}</td>
    </tr>`).join('');

  const intro = `
    <p style="margin:0 0 14px;font-size:16px;line-height:1.6">Hi ${escapeHtml(name)},</p>
    <p style="margin:0 0 14px;font-size:16px;line-height:1.6">Thank you for lending your nativity to <b>Stroll to the Stable</b>. Your nativity has been checked in, documented, and is now in our care. We truly appreciate your contribution to this event.</p>
    <div style="margin:18px 0;padding:16px;border-radius:10px;background:#f7f3e8;border:1px solid #e5ddca">
      <div style="font-size:12px;text-transform:uppercase;letter-spacing:.08em;color:#806c3d;font-weight:700">Claim number</div>
      <div style="margin-top:4px;font-size:25px;font-weight:800;color:#243142">${escapeHtml(nativity.submission_number)}</div>
      <div style="margin-top:7px;color:#4b5563;font-size:14px">Keep this email. Please have this number available when you pick up your nativity.</div>
    </div>`;

  const body = `
    ${schedulePanel('Pickup times', settings?.pickupDays, settings?.pickupStart, settings?.pickupEnd)}
    ${nativity.story ? `<div style="margin-top:22px;padding:14px 16px;border-left:4px solid #d7b35e;background:#fbfaf7;color:#4b5563;font-style:italic;line-height:1.6">${escapeHtml(nativity.story)}</div>` : ''}
    <div style="margin-top:24px">
      <h2 style="margin:0 0 10px;font-size:18px;color:#243142">Items recorded at check-in</h2>
      <table role="presentation" style="width:100%;border-collapse:collapse;border:1px solid #ded8ca">
        <tr style="background:#f7f3e8">
          <th style="padding:8px 10px;text-align:left;color:#243142">#</th>
          <th style="padding:8px 10px;text-align:left;color:#243142">Piece</th>
          <th style="padding:8px 10px;text-align:left;color:#243142">Condition noted</th>
        </tr>
        ${pieceRows}
      </table>
    </div>
    ${photoGalleryHtml(baseUrl, nativity, pieces)}
    <p style="margin:22px 0 0;font-size:15px;line-height:1.6;color:#4b5563">We look forward to sharing your nativity with visitors. Thank you again for helping make Stroll to the Stable possible.</p>`;

  await send(env, {
    to,
    cc: 'submissions@strolltothestable.com',
    subject: `Nativity checked in — claim number ${nativity.submission_number}`,
    html: emailShell({
      eyebrow: 'Stroll to the Stable',
      title: 'Your nativity is checked in',
      intro,
      body,
    }),
  });
}

export async function sendMessageNotification(env, {
  to,
  contactEmail,
  sourceAddress,
  subject,
  bodyText,
  threadId,
  threadCode,
}) {
  if (!Array.isArray(to) || to.length === 0) return;

  const messageCenterUrl = `https://strolltothestable.com/admin-messages.html?id=${encodeURIComponent(threadId)}`;
  const safeBody = escapeHtml(bodyText || '').replace(/\n/g, '<br>');

  await send(env, {
    to,
    from: { email: sourceAddress, name: 'Stroll to the Stable' },
    replyTo: sourceAddress,
    subject: `New message: ${subject || 'Stroll to the Stable question'} [${threadCode}]`,
    text: `${contactEmail} sent the following message to ${sourceAddress}:\n\n${bodyText || ''}\n\nOpen the Message Center to reply: ${messageCenterUrl}`,
    html: `
      <div style="margin:0;padding:26px 14px;background:#f4f1e8;font-family:Arial,Helvetica,sans-serif;color:#243142">
        <div style="max-width:680px;margin:0 auto;background:#fff;border:1px solid #ded8ca;border-radius:16px;overflow:hidden">
          <div style="padding:24px 28px;background:#12233d;color:#fff">
            <div style="font-size:12px;letter-spacing:.12em;text-transform:uppercase;color:#e8c878;font-weight:700">Stroll to the Stable</div>
            <h1 style="margin:7px 0 0;font-size:24px">New message received</h1>
          </div>
          <div style="padding:26px 28px">
            <p style="margin:0 0 16px;line-height:1.6"><b>${escapeHtml(contactEmail)}</b> sent the following message to <b>${escapeHtml(sourceAddress)}</b>:</p>
            <div style="padding:16px 18px;background:#f8f5ed;border:1px solid #e5ddca;border-radius:10px;line-height:1.65">${safeBody}</div>
            <p style="margin:18px 0;color:#6b7280;font-size:13px">Conversation code: ${escapeHtml(threadCode)}</p>
            <a href="${messageCenterUrl}" style="display:inline-block;padding:12px 18px;background:#203a5f;color:#fff;text-decoration:none;border-radius:8px;font-weight:700">Open Message Center</a>
            <p style="margin:18px 0 0;color:#6b7280;font-size:13px;line-height:1.5">Reply from the Message Center so the response is sent from the Stroll to the Stable address and the conversation stays visible to the whole admin team.</p>
          </div>
        </div>
      </div>`,
  });
}

export async function sendMessageAnsweredNotification(env, {
  to,
  adminEmail,
  contactEmail,
  sourceAddress,
  bodyText,
  threadId,
  threadCode,
}) {
  if (!Array.isArray(to) || to.length === 0) return;

  const messageCenterUrl = `https://strolltothestable.com/admin-messages.html?id=${encodeURIComponent(threadId)}`;
  const safeBody = escapeHtml(bodyText || '').replace(/\n/g, '<br>');

  await send(env, {
    to,
    from: { email: sourceAddress, name: 'Stroll to the Stable' },
    replyTo: sourceAddress,
    subject: `Message answered [${threadCode}]`,
    text: `${adminEmail} replied to ${contactEmail}:\n\n${bodyText || ''}\n\nView the conversation: ${messageCenterUrl}`,
    html: `
      <div style="margin:0;padding:26px 14px;background:#f4f1e8;font-family:Arial,Helvetica,sans-serif;color:#243142">
        <div style="max-width:680px;margin:0 auto;background:#fff;border:1px solid #ded8ca;border-radius:16px;overflow:hidden">
          <div style="padding:22px 28px;background:#12233d;color:#fff">
            <div style="font-size:12px;letter-spacing:.12em;text-transform:uppercase;color:#e8c878;font-weight:700">Stroll to the Stable</div>
            <h1 style="margin:7px 0 0;font-size:22px">A message was answered</h1>
          </div>
          <div style="padding:26px 28px">
            <p style="margin:0 0 15px;line-height:1.6"><b>${escapeHtml(adminEmail)}</b> replied to <b>${escapeHtml(contactEmail)}</b> from ${escapeHtml(sourceAddress)}:</p>
            <div style="padding:16px 18px;background:#f8f5ed;border:1px solid #e5ddca;border-radius:10px;line-height:1.65">${safeBody}</div>
            <p style="margin:18px 0;color:#6b7280;font-size:13px">Conversation code: ${escapeHtml(threadCode)}</p>
            <a href="${messageCenterUrl}" style="display:inline-block;padding:12px 18px;background:#203a5f;color:#fff;text-decoration:none;border-radius:8px;font-weight:700">View Conversation</a>
          </div>
        </div>
      </div>`,
  });
}

export async function sendMessageCenterReply(env, {
  to,
  fromAddress,
  subject,
  bodyText,
  threadCode,
}) {
  const cleanSubject = String(subject || 'Your Stroll to the Stable message')
    .replace(/\s*\[STTS-[A-Z0-9]+\]\s*$/i, '')
    .trim();

  const htmlBody = escapeHtml(bodyText || '').replace(/\n/g, '<br>');
  await send(env, {
    to,
    from: { email: fromAddress, name: 'Stroll to the Stable' },
    replyTo: fromAddress,
    subject: `Re: ${cleanSubject} [${threadCode}]`,
    text: bodyText || '',
    html: `
      <div style="margin:0;padding:26px 14px;background:#f4f1e8;font-family:Arial,Helvetica,sans-serif;color:#243142">
        <div style="max-width:680px;margin:0 auto;background:#fff;border:1px solid #ded8ca;border-radius:16px;overflow:hidden">
          <div style="padding:22px 28px;background:#12233d;color:#fff">
            <div style="font-size:12px;letter-spacing:.12em;text-transform:uppercase;color:#e8c878;font-weight:700">Stroll to the Stable</div>
          </div>
          <div style="padding:26px 28px;font-size:16px;line-height:1.65">
            ${htmlBody}
            <div style="margin-top:26px;padding-top:16px;border-top:1px solid #e7e1d5;color:#6b7280;font-size:13px">Stroll to the Stable · Seguin, Texas</div>
          </div>
        </div>
      </div>`,
  });
}

function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[c]);
}
