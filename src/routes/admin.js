import { db } from '../lib/db.js';
import { json, error, requireAdmin } from '../lib/util.js';
import { sendClaimTicketEmail } from '../lib/email.js';

export async function listNativities(request, env, session) {
  requireAdmin(session);
  const url = new URL(request.url);
  const status = url.searchParams.get('status') || null;
  const search = url.searchParams.get('search')?.trim() || null;
  const like = search ? `%${search}%` : null;

  const sql = db(env);
  // A single parameterized query handles all four combinations (no filter,
  // status only, search only, both) — the NULL checks make each clause a
  // no-op when that filter isn't in use, so no nested SQL-fragment
  // composition is needed.
  const rows = await sql`
    SELECT id, submission_number, status, event_year, owner_name, owner_phone, owner_email
    FROM nativity_search
    WHERE (${status}::text IS NULL OR status = ${status})
      AND (
        ${like}::text IS NULL
        OR owner_name ILIKE ${like} OR owner_phone ILIKE ${like} OR owner_email ILIKE ${like}
        OR piece_text ILIKE ${like} OR submission_number ILIKE ${like}
      )
    ORDER BY id DESC
  `;
  return json({ nativities: rows });
}

export async function getNativity(request, env, session, id) {
  requireAdmin(session);
  const sql = db(env);
  const rows = await sql`
    SELECT n.*, u.name AS owner_name, u.phone AS owner_phone, u.email AS owner_email
    FROM nativities n JOIN users u ON u.id = n.owner_user_id
    WHERE n.id = ${id}
  `;
  if (rows.length === 0) return error('Not found.', 404);
  const pieces = await sql`SELECT * FROM nativity_pieces WHERE nativity_id = ${id} ORDER BY piece_number`;
  return json({ nativity: rows[0], pieces });
}

export async function toggleWaiver(request, env, session, id) {
  requireAdmin(session);
  const { signed } = await request.json();
  const sql = db(env);
  await sql`
    UPDATE nativities
    SET waiver_signed = ${!!signed},
        waiver_signed_by = ${signed ? session.email : null},
        waiver_signed_at = ${signed ? new Date().toISOString() : null},
        updated_at = now()
    WHERE id = ${id}
  `;
  return json({ ok: true });
}

export async function finalize(request, env, session, id) {
  requireAdmin(session);
  const sql = db(env);
  const rows = await sql`
    SELECT n.*, u.name AS owner_name, u.email AS owner_email
    FROM nativities n JOIN users u ON u.id = n.owner_user_id WHERE n.id = ${id}
  `;
  if (rows.length === 0) return error('Not found.', 404);
  const nativity = rows[0];
  if (!nativity.waiver_signed) return error('Waiver must be signed before finalizing.');
  if (nativity.status !== 'pending') return error('Already finalized.');

  await sql`
    UPDATE nativities SET status = 'submitted', finalized_by = ${session.email}, finalized_at = now(), updated_at = now()
    WHERE id = ${id}
  `;

  const pieces = await sql`SELECT * FROM nativity_pieces WHERE nativity_id = ${id} ORDER BY piece_number`;
  await sendClaimTicketEmail(env, { to: nativity.owner_email, name: nativity.owner_name, nativity, pieces });

  return json({ ok: true });
}

export async function markReturned(request, env, session, id) {
  requireAdmin(session);
  const sql = db(env);
  const rows = await sql`SELECT status FROM nativities WHERE id = ${id}`;
  if (rows.length === 0) return error('Not found.', 404);
  if (rows[0].status !== 'submitted') return error('Only a submitted (checked-in) nativity can be marked returned.');
  await sql`UPDATE nativities SET status = 'returned', returned_at = now(), updated_at = now() WHERE id = ${id}`;
  return json({ ok: true });
}

// ── Worker "glamour shot" — the nativity photographed in its final display
// spot. When present, this is what the public tour shows instead of the
// donor's own submitted photo. Workers can upload, replace, or clear it
// at any time regardless of submission status.
export async function uploadDisplayPhoto(request, env, session, id) {
  requireAdmin(session);
  const sql = db(env);
  const existing = await sql`SELECT id FROM nativities WHERE id = ${id}`;
  if (existing.length === 0) return error('Not found.', 404);

  const contentType = request.headers.get('Content-Type') || 'image/jpeg';
  const key = `display/${id}/${crypto.randomUUID()}.jpg`;
  const bytes = await request.arrayBuffer();
  await env.PHOTOS.put(key, bytes, { httpMetadata: { contentType } });

  await sql`UPDATE nativities SET display_photo_key = ${key}, updated_at = now() WHERE id = ${id}`;
  return json({ ok: true, key });
}

export async function clearDisplayPhoto(request, env, session, id) {
  requireAdmin(session);
  const sql = db(env);
  await sql`UPDATE nativities SET display_photo_key = NULL, updated_at = now() WHERE id = ${id}`;
  return json({ ok: true });
}

// ── Admin list management ────────────────────────────────────────────────
export async function listAdmins(request, env, session) {
  requireAdmin(session);
  const sql = db(env);
  const admins = await sql`SELECT email, is_permanent, added_by, created_at FROM admins ORDER BY created_at`;
  return json({ admins });
}

export async function addAdmin(request, env, session) {
  requireAdmin(session);
  const { email } = await request.json();
  if (!email?.trim()) return error('Enter an email address.');
  const sql = db(env);
  await sql`
    INSERT INTO admins (email, is_permanent, added_by) VALUES (${email.trim().toLowerCase()}, FALSE, ${session.email})
    ON CONFLICT (email) DO NOTHING
  `;
  return json({ ok: true });
}

export async function removeAdmin(request, env, session, email) {
  requireAdmin(session);
  const sql = db(env);
  const rows = await sql`SELECT is_permanent FROM admins WHERE email = ${email.toLowerCase()}`;
  if (rows.length === 0) return error('Admin not found.', 404);
  if (rows[0].is_permanent) {
    return error('This admin is permanent and can only be removed directly in Neon.', 403);
  }
  await sql`DELETE FROM admins WHERE email = ${email.toLowerCase()}`;
  return json({ ok: true });
}
