// TEMPORARY (2026-11-17): deliver Tim Bird's emailed answer (message 43) to
// Ashley Spahn in conversation 9. He replied to the admin alert before the
// relay existed, so it never reached her. One-time; removed after use.
import { json, error } from '../lib/util.js';
import { db } from '../lib/db.js';
import { adminReplyText, sendReplyToContact } from './messages.js';

const KEY_SHA256 = '828009a685cc2d6f871d84a0fc446601372301d6bdfd691b17c60aa35d480823';

async function sha256Hex(text) {
  const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export async function sendTimReply(request, env) {
  const key = request.headers.get('X-Test-Key') || '';
  if (!key || (await sha256Hex(key)) !== KEY_SHA256) return error('Not found.', 404);
  const sql = db(env);
  const [thread] = await sql`SELECT * FROM message_threads WHERE id = 9`;
  if (!thread || thread.contact_email !== 'aspahn@seguin.k12.tx.us') return error('Unexpected conversation.', 409);
  // Never send twice: stop if anything has already gone out from the info address.
  const already = await sql`SELECT 1 FROM message_items WHERE thread_id = 9 AND sender_email = ${thread.source_address} LIMIT 1`;
  if (already.length) return error('Already sent.', 409);
  const [tim] = await sql`SELECT * FROM message_items WHERE id = 43 AND thread_id = 9 AND sender_email = 'thebirdfamily@gmail.com'`;
  if (!tim) return error("Tim's message not found.", 404);
  const text = adminReplyText(tim.body_text);
  if (!text) return error('Nothing safe to send.', 422);
  await sendReplyToContact(env, thread, 'thebirdfamily@gmail.com', text);
  // The sent copy replaces the raw email copy in the conversation.
  await sql`DELETE FROM message_items WHERE id = 43`;
  const [sent] = await sql`SELECT id, message_id, body_text FROM message_items WHERE thread_id = 9 AND sender_email = ${thread.source_address} ORDER BY id DESC LIMIT 1`;
  return json({ ok: true, to: thread.contact_email, item: sent });
}
