import PostalMime from 'postal-mime';
import { db } from '../lib/db.js';
import { json, error, requireAdmin } from '../lib/util.js';
import { sendMessageNotification, sendMessageCenterReply } from '../lib/email.js';

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
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `;
  await sql`CREATE INDEX IF NOT EXISTS idx_message_threads_status ON message_threads (status)`;
  await sql`CREATE INDEX IF NOT EXISTS idx_message_threads_contact ON message_threads (lower(contact_email))`;
  await sql`CREATE INDEX IF NOT EXISTS idx_message_threads_last_message ON message_threads (last_message_at DESC)`;
  await sql`CREATE INDEX IF NOT EXISTS idx_message_items_thread ON message_items (thread_id, created_at)`;
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
  const markers = [
    /\nOn .+wrote:\s*\n/i,
    /\nFrom:\s.+\nSent:\s.+\nTo:\s.+\nSubject:\s.+\n/i,
    /\n-{2,}\s*Original Message\s*-{2,}\n/i,
  ];
  let cut = value.length;
  for (const re of markers) {
    const match = re.exec(value);
    if (match && match.index < cut) cut = match.index;
  }
  value = value.slice(0, cut).trim();
  return value;
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
    INSERT INTO message_items (thread_id, direction, sender_email, body_text)
    VALUES (${thread.id}, 'inbound', ${sender}, ${bodyText})
  `;
  await sql`
    UPDATE message_threads
    SET last_message_at = now(), updated_at = now()
    WHERE id = ${thread.id}
  `;

  const admins = await sql`SELECT email FROM admins ORDER BY created_at`;
  const recipients = admins.map(a => a.email).filter(Boolean).slice(0, 50);
  try {
    await sendMessageNotification(env, {
      to: recipients,
      contactEmail: sender,
      sourceAddress,
      subject: thread.subject || subject,
      bodyText,
      threadId: thread.id,
      threadCode: thread.thread_code,
    });
  } catch (err) {
    console.error('Message stored but admin notification email failed:', err);
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
      COUNT(*) FILTER (WHERE status = 'answered')::int AS answered,
      COUNT(*) FILTER (WHERE status = 'closed')::int AS closed
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
    SELECT id, direction, sender_email, admin_email, body_text, created_at
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

  await sendMessageCenterReply(env, {
    to: thread.contact_email,
    fromAddress: thread.source_address,
    subject: thread.subject,
    bodyText,
    threadCode: thread.thread_code,
  });

  await sql`
    INSERT INTO message_items (thread_id, direction, sender_email, admin_email, body_text)
    VALUES (${id}, 'outbound', ${thread.source_address}, ${session.email}, ${bodyText})
  `;
  await sql`
    UPDATE message_threads
    SET status = 'answered', last_message_at = now(), updated_at = now()
    WHERE id = ${id}
  `;

  return json({ ok: true });
}

export async function updateThreadStatus(request, env, session, id) {
  requireAdmin(session);
  await ensureMessageSchema(env);
  const { status } = await request.json();
  if (!['pending', 'answered', 'closed'].includes(status)) return error('Invalid message status.');

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
