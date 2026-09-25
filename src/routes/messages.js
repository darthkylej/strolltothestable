import PostalMime from 'postal-mime';
import { db } from '../lib/db.js';
import { json, error, requireAdmin } from '../lib/util.js';
import { getSiteSettings } from '../lib/siteSettings.js';
import { createSessionToken } from '../lib/auth.js';
import {
  sendMessageNotification,
  sendMessageCenterReply,
  sendMessageAnsweredNotification,
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
  let value = String(text || '').replace(/\r\n/g, '\n').trim();
  if (!value) return '';

  const markers = [
    /(?:^|\n)On .+?wrote:\s*(?:\n|$)/i,
    /(?:^|\n)From:\s.+(?:\n|$)[\s\S]*?Subject:\s.+(?:\n|$)/i,
    /(?:^|\n)-{2,}\s*Original Message\s*-{2,}(?:\n|$)/i,
    /(?:^|\n)_{5,}(?:\n|$)/,
    /(?:^|\n)Sent with Proton Mail(?:\n|$)/i,
  ];

  let cut = value.length;
  for (const re of markers) {
    const match = re.exec(value);
    if (match && match.index < cut) cut = match.index;
  }

  value = value.slice(0, cut).trim();

  // Gmail, Proton Mail, Outlook and many mobile clients prefix quoted
  // history lines with ">". Once a quoted block begins, keep only the
  // newly typed reply above it.
  const lines = value.split('\n');
  const cleaned = [];
  for (const line of lines) {
    if (/^\s*>/.test(line)) break;
    cleaned.push(line);
  }

  return cleaned.join('\n').trim();
}

export async function handleIncomingEmail(message, env) {
  const sourceAddress = String(message.to || '').toLowerCase();
  if (!VALID_ADDRESSES.has(sourceAddress)) {
    message.setReject('Unknown Stroll to the Stable address');
    return;
  }

  const sender = String(message.from || '').toLowerCase();
  if (VALID_ADDRESSES.has(sender)) {
    // Prevent internally generated Stroll mail from creating message-center loops.
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
    await sql`
      UPDATE message_threads
      SET status = 'pending',
          contact_email = ${sender || thread.contact_email},
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
        bodyText,
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

  return json({ threads: rows, counts: counts[0] });
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

  return json({ thread: rows[0], messages: items });
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
  const thread = rows[0];

  const history = await sql`
    SELECT direction, sender_email, admin_email, body_text, message_id, references_header, created_at
    FROM message_items
    WHERE thread_id = ${id}
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
    history,
  });

  await sql`
    INSERT INTO message_items (
      thread_id,
      direction,
      sender_email,
      admin_email,
      body_text,
      message_id
    )
    VALUES (
      ${id},
      'outbound',
      ${thread.source_address},
      ${session.email},
      ${bodyText},
      ${sendResult?.messageId || null}
    )
  `;
  await sql`
    UPDATE message_threads
    SET status = 'answered', last_message_at = now(), updated_at = now()
    WHERE id = ${id}
  `;

  const allAdmins = await sql`SELECT email FROM admins ORDER BY created_at`;
  const adminEmails = allAdmins.map(a => a.email).filter(Boolean);
  const settings = await getSiteSettings(env);
  const configured = settings.messageNotifications;
  const selected = configured && Array.isArray(configured[thread.source_address])
    ? configured[thread.source_address]
    : adminEmails;
  const recipients = selected
    .filter(email => email.toLowerCase() !== session.email.toLowerCase())
    .filter(email => adminEmails.includes(email))
    .slice(0, 50);
  for (const recipient of recipients) {
    try {
      const messageCenterUrl = await adminMessageLink(env, recipient, thread.id);
      await sendMessageAnsweredNotification(env, {
        to: [recipient],
        adminEmail: session.email,
        contactEmail: thread.contact_email,
        sourceAddress: thread.source_address,
        bodyText,
        threadId: thread.id,
        threadCode: thread.thread_code,
        messageCenterUrl,
      });
    } catch (err) {
      console.error(`Reply sent but answer notification failed for ${recipient}:`, err);
    }
  }

  return json({ ok: true });
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
