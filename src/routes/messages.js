import PostalMime from 'postal-mime';
import { db } from '../lib/db.js';
import { json, error, requireAdmin } from '../lib/util.js';
import { getSiteSettings } from '../lib/siteSettings.js';
import { createSessionToken } from '../lib/auth.js';
import {
  sendMessageNotification,
  sendMessageCenterReply,
} from '../lib/email.js';

const ADMIN_EMAIL_LINK_TTL_MS = 24 * 60 * 60 * 1000;

async function adminMessageLink(env, adminEmail, threadId) {
  const next = `/admin-messages.html?id=${encodeURIComponent(threadId)}`;
  const token = await createSessionToken(
    env,
    { kind: 'admin-email-link', email: adminEmail },
    ADMIN_EMAIL_LINK_TTL_MS
  );
  return `https://strolltothestable.com/admin-email-login?token=${encodeURIComponent(token)}&next=${encodeURIComponent(next)}`;
}

const VALID_ADDRESSES = new Set([
  'info@strolltothestable.com',
  'appointments@strolltothestable.com',
  'submissions@strolltothestable.com',
]);

export async function ensureMessageSchema(env) {
  const sql = db(env);
  await sql`
    CREATE TABLE IF NOT EXISTS message_threads (
      id BIGSERIAL PRIMARY KEY,
      thread_code TEXT UNIQUE NOT NULL,
      contact_email TEXT NOT NULL,
      source_address TEXT NOT NULL,
      subject TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'pending'
        CHECK (status IN ('pending', 'answered', 'closed')),
      last_message_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `;
  await sql`
    CREATE TABLE IF NOT EXISTS message_items (
      id BIGSERIAL PRIMARY KEY,
      thread_id BIGINT NOT NULL REFERENCES message_threads(id) ON DELETE CASCADE,
      direction TEXT NOT NULL CHECK (direction IN ('inbound', 'outbound')),
      sender_email TEXT NOT NULL,
      admin_email TEXT,
      body_text TEXT NOT NULL,
      message_id TEXT,
      references_header TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `;
  await sql`ALTER TABLE message_items ADD COLUMN IF NOT EXISTS message_id TEXT`;
  await sql`ALTER TABLE message_items ADD COLUMN IF NOT EXISTS references_header TEXT`;
  await sql`CREATE INDEX IF NOT EXISTS idx_message_threads_status ON message_threads (status)`;
  await sql`CREATE INDEX IF NOT EXISTS idx_message_threads_contact ON message_threads (lower(contact_email))`;
  await sql`CREATE INDEX IF NOT EXISTS idx_message_threads_last_message ON message_threads (last_message_at DESC)`;
  await sql`CREATE INDEX IF NOT EXISTS idx_message_items_thread ON message_items (thread_id, created_at)`;
  await sql`UPDATE message_threads SET status = 'answered' WHERE status = 'closed'`;
}

function makeThreadCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const bytes = crypto.getRandomValues(new Uint8Array(7));
  return 'STTS-' + Array.from(bytes, b => chars[b % chars.length]).join('');
}

function getThreadCode(subject) {
  const match = String(subject || '').match(/\[(STTS-[A-Z0-9]+)\]/i);
  return match ? match[1].toUpperCase() : '';
}

function stripHtml(html) {
  return String(html || '')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<br\s*\/?\s*>/gi, '\n')
    .replace(/<\/p\s*>/gi, '\n\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function cleanReplyText(text) {
  const value = String(text || '').replace(/\r\n/g, '\n').trim();
  if (!value) return '';

  const lines = value.split('\n');

  // Find the first obvious quoted-history boundary. Gmail commonly emits
  // "On <date> ... wrote:" and can wrap that header across several lines.
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();

    if (/^\s*>/.test(lines[i])) {
      return lines.slice(0, i).join('\n').trim();
    }

    if (/^-{2,}\s*Original Message\s*-{2,}$/i.test(line)) {
      return lines.slice(0, i).join('\n').trim();
    }

    if (/^From:\s/i.test(line)) {
      const lookahead = lines.slice(i, Math.min(i + 8, lines.length)).join('\n');
      if (/\nSent:\s/i.test(lookahead) && /\nTo:\s/i.test(lookahead) && /\nSubject:\s/i.test(lookahead)) {
        return lines.slice(0, i).join('\n').trim();
      }
    }

    if (/^On\s.+/i.test(line)) {
      const lookahead = lines.slice(i, Math.min(i + 6, lines.length)).join(' ');
      if (/\bwrote:\s*$/i.test(lookahead.trim()) || /\bwrote:/i.test(lookahead)) {
        return lines.slice(0, i).join('\n').trim();
      }
    }

    if (/^Sent with Proton Mail\b/i.test(line) || /^_{5,}$/.test(line)) {
      return lines.slice(0, i).join('\n').trim();
    }
  }

  return value;
}

// For showing a message in the Message Center: drops the email signature and
// legal disclaimers, and rejoins lines that plain-text email wrapped at a fixed
// width. The stored text is not changed.
const DISCLAIMER_START = /^\**\s*(confidential(ity)? notice|information notice|this (e-?mail|electronic mail)( message| transmission)? (is|and any)|disclaimer)\b/i;
export function displayText(text, { keepSignature = false } = {}) {
  let value = cleanReplyText(text) || String(text || '').trim();
  const lines = value.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    // "-- " is the standard signature separator; long notices may also start
    // without one.
    if (!keepSignature && (/^--\s*$/.test(lines[i]) || (i > 0 && DISCLAIMER_START.test(line)))) {
      value = lines.slice(0, i).join('\n').trim();
      break;
    }
  }
  // Gmail turns large attachments into Drive links: a bare file name line,
  // then <link>. Keep them as a link on their own line.
  const fileLinks = [];
  value = value.replace(/\s*\n\s*([^\s/\\<>]+\.(?:heic|jpe?g|png|gif|pdf|mov|mp4|docx?))\s*\n\s*<(https?:\/\/[^>\s]+)>\s*/gi, (m, name, url) => {
    fileLinks.push(`${name}: ${url}`);
    return ' ';
  });
  if (fileLinks.length) value = value.trimEnd() + '\n\nAttached files:\n' + fileLinks.join('\n');
  // Rejoin hard-wrapped lines inside a paragraph.
  return value.split(/\n{2,}/).map((para) => {
    const ls = para.split('\n');
    let out = ls[0];
    for (let i = 1; i < ls.length; i++) {
      const prev = ls[i - 1], cur = ls[i];
      const wrapped = prev.trim().length >= 55 && cur.trim() && !/^\s*([-*•]|\d+[.)])\s/.test(cur);
      out += (wrapped ? ' ' : '\n') + (wrapped ? cur.trim() : cur);
    }
    return out;
  }).join('\n\n').replace(/\n{3,}/g, '\n\n').trim() || '(No message text)';
}

// What an admin typed when replying to an alert: everything above the
// alert's marker line (or the mail app's "On ... wrote:" quote). Returns ''
// if what's left could still contain alert content, such as the admin's
// automatic sign-in link, so it is never forwarded to the public.
export function adminReplyText(rawText) {
  let text = String(rawText || '').replace(/\r\n/g, '\n');
  const markerAt = text.search(/#+-\s*Reply above this line\s*-#+/i);
  if (markerAt >= 0) {
    text = text.slice(0, markerAt);
    // Drop the "On <date> ... wrote:" line and quote marks that precede it.
    text = text.replace(/\n[^\n]*\n?[^\n]*wrote:\s*[>\s]*$/i, '').replace(/[>\s]+$/, '');
  }
  text = displayText(text, { keepSignature: true });
  if (!text || text === '(No message text)') return '';
  if (/admin-email-login|[?&]token=|Reply above this line|Open Message Center|View Conversation|sent the following message to/i.test(text)) return '';
  return text;
}

const OWN_DOMAIN = 'strolltothestable.com';

export function isAutomatedOrInternal(sender, headers) {
  const address = String(sender || '').toLowerCase();
  const domain = address.split('@').pop();
  if (VALID_ADDRESSES.has(address)) return true;
  if (domain === OWN_DOMAIN || domain.endsWith('.' + OWN_DOMAIN)) return true;
  if (/^(mailer-daemon|postmaster)@/.test(address)) return true;
  const get = (name) => String(headers?.get?.(name) || '').trim().toLowerCase();
  const autoSubmitted = get('auto-submitted');
  if (autoSubmitted && autoSubmitted !== 'no') return true;
  if (['auto_reply', 'bulk', 'junk'].includes(get('precedence'))) return true;
  return false;
}

export async function handleIncomingEmail(message, env) {
  const sourceAddress = String(message.to || '').toLowerCase();
  if (!VALID_ADDRESSES.has(sourceAddress)) {
    message.setReject('Unknown Stroll to the Stable address');
    return;
  }

  const sender = String(message.from || '').toLowerCase();
  if (isAutomatedOrInternal(sender, message.headers)) {
    // The message center is for people's questions. Our own mail (including
    // its bounce addresses), delivery failures and auto-replies never create
    // threads or notify admins.
    return;
  }

  await ensureMessageSchema(env);
  const parsed = await new PostalMime().parse(message.raw);
  const subject = String(parsed.subject || message.headers?.get?.('subject') || '').trim() || 'No subject';
  const messageId = String(
    message.headers?.get?.('Message-ID')
      || message.headers?.get?.('message-id')
      || ''
  ).trim();
  const inReplyTo = String(
    message.headers?.get?.('In-Reply-To')
      || message.headers?.get?.('in-reply-to')
      || ''
  ).trim();
  const referencesHeader = String(
    message.headers?.get?.('References')
      || message.headers?.get?.('references')
      || ''
  ).trim();
  const rawText = parsed.text || stripHtml(parsed.html);
  const bodyText = cleanReplyText(rawText) || String(rawText || '').trim() || '(No message text)';
  const existingCode = getThreadCode(subject);
  const sql = db(env);

  let thread;
  if (existingCode) {
    const rows = await sql`
      SELECT * FROM message_threads
      WHERE thread_code = ${existingCode}
      LIMIT 1
    `;
    if (rows.length) thread = rows[0];
  }

  if (!thread && (inReplyTo || referencesHeader)) {
    const headerIds = [inReplyTo, ...referencesHeader.split(/\s+/)]
      .map(v => String(v || '').trim().replace(/[<>]/g, ''))
      .filter(Boolean);

    for (const headerId of headerIds) {
      const rows = await sql`
        SELECT DISTINCT t.*
        FROM message_threads t
        JOIN message_items m ON m.thread_id = t.id
        WHERE regexp_replace(coalesce(m.message_id, ''), '[<>]', '', 'g') = ${headerId}
        ORDER BY t.updated_at DESC
        LIMIT 1
      `;
      if (rows.length) {
        thread = rows[0];
        break;
      }
    }
  }

  if (!thread) {
    const normalizedSubject = subject.replace(/^Re:\s*/i, '').trim();
    const rows = await sql`
      SELECT *
      FROM message_threads
      WHERE lower(contact_email) = lower(${sender})
        AND lower(regexp_replace(subject, '^Re:\\s*', '', 'i')) = lower(${normalizedSubject})
      ORDER BY updated_at DESC
      LIMIT 1
    `;
    if (rows.length) thread = rows[0];
  }

  if (!thread) {
    let code = makeThreadCode();
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const rows = await sql`
          INSERT INTO message_threads (thread_code, contact_email, source_address, subject, status)
          VALUES (${code}, ${sender}, ${sourceAddress}, ${subject}, 'pending')
          RETURNING *
        `;
        thread = rows[0];
        break;
      } catch (err) {
        code = makeThreadCode();
        if (attempt === 2) throw err;
      }
    }
  } else {
    // An admin answering from their own mailbox with this address copied:
    // record it as our reply. It keeps the original contact, marks the
    // conversation answered and does not alert the other admins.
    const fromAdmin = await sql`SELECT 1 FROM admins WHERE lower(email) = ${sender} LIMIT 1`;
    if (fromAdmin.length) {
      // Did the person already get this email directly (they were in To/Cc)?
      const recipients = [...(parsed.to || []), ...(parsed.cc || [])]
        .flatMap((r) => (r.group ? r.group : [r]))
        .map((r) => String(r.address || '').toLowerCase());
      const contactGotIt = recipients.includes(String(thread.contact_email || '').toLowerCase());
      if (contactGotIt) {
        await sql`
          INSERT INTO message_items (thread_id, direction, sender_email, admin_email, body_text, message_id, references_header)
          VALUES (${thread.id}, 'outbound', ${sender}, ${sender}, ${bodyText}, ${messageId || null}, ${referencesHeader || null})
        `;
        await sql`
          UPDATE message_threads SET status = 'answered', last_message_at = now(), updated_at = now()
          WHERE id = ${thread.id}
        `;
        return;
      }
      // Usually a reply to the admin alert email: send it on to the person as
      // a clean Stroll to the Stable email, with any attached files.
      const replyText = adminReplyText(rawText);
      if (!replyText) {
        // Nothing safe to send (empty, or it still contained alert content):
        // keep it in the Message Center for an admin to deal with.
        await sql`
          INSERT INTO message_items (thread_id, direction, sender_email, admin_email, body_text, message_id, references_header)
          VALUES (${thread.id}, 'inbound', ${sender}, null, ${'[Not sent to ' + thread.contact_email + ' — please reply from the Message Center]\n\n' + bodyText}, ${messageId || null}, ${referencesHeader || null})
        `;
        return;
      }
      const files = (parsed.attachments || [])
        .filter((f) => f.content && (f.disposition !== 'inline' || (f.mimeType || '').startsWith('image/')))
        .slice(0, 10);
      const total = files.reduce((n, f) => n + (f.content?.byteLength || 0), 0);
      await sendReplyToContact(env, thread, sender, replyText, {
        attachments: total <= 15 * 1024 * 1024 && files.length
          ? files.map((f) => ({ filename: f.filename || 'attachment', type: f.mimeType, content: f.content }))
          : undefined,
      });
      return;
    }
    // Anyone else (the contact, or someone copied in) reopens the
    // conversation. The contact stays the person who started it, so replies
    // from the Message Center keep going to them.
    await sql`
      UPDATE message_threads
      SET status = 'pending',
          last_message_at = now(),
          updated_at = now()
      WHERE id = ${thread.id}
    `;
  }

  await sql`
    INSERT INTO message_items (
      thread_id,
      direction,
      sender_email,
      body_text,
      message_id,
      references_header
    )
    VALUES (
      ${thread.id},
      'inbound',
      ${sender},
      ${bodyText},
      ${messageId || null},
      ${referencesHeader || null}
    )
  `;
  await sql`
    UPDATE message_threads
    SET last_message_at = now(), updated_at = now()
    WHERE id = ${thread.id}
  `;

  const admins = await sql`SELECT email FROM admins ORDER BY created_at`;
  const adminEmails = admins.map(a => a.email).filter(Boolean);
  const settings = await getSiteSettings(env);
  const configured = settings.messageNotifications;
  const selected = configured && Array.isArray(configured[sourceAddress])
    ? configured[sourceAddress]
    : adminEmails;
  const recipients = selected
    .filter(email => adminEmails.includes(email))
    .slice(0, 50);
  for (const recipient of recipients) {
    try {
      const messageCenterUrl = await adminMessageLink(env, recipient, thread.id);
      await sendMessageNotification(env, {
        to: [recipient],
        contactEmail: sender,
        sourceAddress,
        subject: thread.subject || subject,
        bodyText: displayText(bodyText),
        threadId: thread.id,
        threadCode: thread.thread_code,
        messageCenterUrl,
      });
    } catch (err) {
      console.error(`Message stored but notification email failed for ${recipient}:`, err);
    }
  }
}

export async function listThreads(request, env, session) {
  requireAdmin(session);
  await ensureMessageSchema(env);
  const url = new URL(request.url);
  const status = url.searchParams.get('status') || 'pending';
  const search = url.searchParams.get('search')?.trim() || '';
  const like = search ? `%${search}%` : null;
  const sql = db(env);

  const rows = await sql`
    SELECT
      t.*,
      (
        SELECT m.body_text
        FROM message_items m
        WHERE m.thread_id = t.id
        ORDER BY m.created_at DESC, m.id DESC
        LIMIT 1
      ) AS preview,
      (
        SELECT m.direction
        FROM message_items m
        WHERE m.thread_id = t.id
        ORDER BY m.created_at DESC, m.id DESC
        LIMIT 1
      ) AS last_direction,
      (
        SELECT COUNT(*)::int
        FROM message_items m
        WHERE m.thread_id = t.id
      ) AS message_count
    FROM message_threads t
    WHERE
      (${status} = 'all' OR t.status = ${status})
      AND (
        ${like}::text IS NULL
        OR t.contact_email ILIKE ${like}
        OR t.source_address ILIKE ${like}
        OR t.subject ILIKE ${like}
        OR EXISTS (
          SELECT 1 FROM message_items m
          WHERE m.thread_id = t.id AND m.body_text ILIKE ${like}
        )
      )
    ORDER BY
      CASE WHEN t.status = 'pending' THEN 0 ELSE 1 END,
      t.last_message_at DESC
    LIMIT 250
  `;

  const counts = await sql`
    SELECT
      COUNT(*)::int AS total,
      COUNT(*) FILTER (WHERE status = 'pending')::int AS pending,
      COUNT(*) FILTER (WHERE status = 'answered')::int AS answered
    FROM message_threads
  `;

  return json({ threads: rows.map((t) => ({ ...t, preview: displayText(t.preview) })), counts: counts[0] });
}

export async function getThread(request, env, session, id) {
  requireAdmin(session);
  await ensureMessageSchema(env);
  const sql = db(env);
  const rows = await sql`SELECT * FROM message_threads WHERE id = ${id}`;
  if (!rows.length) return error('Message conversation not found.', 404);

  const items = await sql`
    SELECT id, direction, sender_email, admin_email, body_text, message_id, references_header, created_at
    FROM message_items
    WHERE thread_id = ${id}
    ORDER BY created_at, id
  `;

  return json({
    thread: rows[0],
    messages: items.map(item => ({
      ...item,
      body_text: displayText(item.body_text),
      by_email: item.direction === 'outbound' && String(item.sender_email || '').toLowerCase() !== String(rows[0].source_address || '').toLowerCase(),
    })),
  });
}

export async function replyToThread(request, env, session, id) {
  requireAdmin(session);
  await ensureMessageSchema(env);
  const { message } = await request.json();
  const bodyText = String(message || '').trim();
  if (!bodyText) return error('Enter a reply.');

  const sql = db(env);
  const rows = await sql`SELECT * FROM message_threads WHERE id = ${id}`;
  if (!rows.length) return error('Message conversation not found.', 404);
  await sendReplyToContact(env, rows[0], session.email, bodyText);
  return json({ ok: true });
}

// Sends an admin's answer to the person in the conversation as a Stroll to
// the Stable email, records it and marks the conversation answered. Used by the Message Center and by admins replying to an
// alert email from their own mailbox.
export async function sendReplyToContact(env, thread, adminEmail, bodyText, { attachments } = {}) {
  const sql = db(env);
  const history = await sql`
    SELECT direction, sender_email, admin_email, body_text, message_id, references_header, created_at
    FROM message_items
    WHERE thread_id = ${thread.id}
    ORDER BY created_at, id
  `;
  const latestInbound = [...history].reverse().find(item => item.direction === 'inbound');

  const sendResult = await sendMessageCenterReply(env, {
    to: thread.contact_email,
    fromAddress: thread.source_address,
    subject: thread.subject,
    bodyText,
    threadCode: thread.thread_code,
    inReplyTo: latestInbound?.message_id || '',
    references: latestInbound?.references_header || '',
    attachments,
  });

  await sql`
    INSERT INTO message_items (thread_id, direction, sender_email, admin_email, body_text, message_id)
    VALUES (${thread.id}, 'outbound', ${thread.source_address}, ${adminEmail},
            ${bodyText},
            ${sendResult?.messageId || null})
  `;
  await sql`
    UPDATE message_threads
    SET status = 'answered', last_message_at = now(), updated_at = now()
    WHERE id = ${thread.id}
  `;
  // Admins are only emailed about incoming messages, not about replies.
}

export async function deleteThread(request, env, session, id) {
  requireAdmin(session);
  await ensureMessageSchema(env);
  const sql = db(env);

  const rows = await sql`
    DELETE FROM message_threads
    WHERE id = ${id}
    RETURNING id
  `;

  if (!rows.length) return error('Message conversation not found.', 404);
  return json({ ok: true });
}

export async function updateThreadStatus(request, env, session, id) {
  requireAdmin(session);
  await ensureMessageSchema(env);
  const { status } = await request.json();
  if (!['pending', 'answered'].includes(status)) return error('Invalid message status.');

  const sql = db(env);
  const rows = await sql`
    UPDATE message_threads
    SET status = ${status}, updated_at = now()
    WHERE id = ${id}
    RETURNING id
  `;
  if (!rows.length) return error('Message conversation not found.', 404);
  return json({ ok: true });
}
