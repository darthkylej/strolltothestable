import { db } from '../lib/db.js';
import { json, error, requireAdmin } from '../lib/util.js';
import { sendClaimTicketEmail } from '../lib/email.js';
import {
  TOUR_MEDIA_PREFIX,
  MAX_TOUR_MEDIA_BYTES,
  getTourMediaSpec,
  listTourMediaObjects,
  serializeTourMedia,
} from '../lib/tourMedia.js';

export async function listNativities(request, env, session) {
  requireAdmin(session);
  const url = new URL(request.url);
  const status = url.searchParams.get('status') || null;
  const search = url.searchParams.get('search')?.trim() || null;
  const like = search ? `%${search}%` : null;

  const sql = db(env);
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

  const countRows = await sql`
    SELECT
      COUNT(*)::int AS total,
      COUNT(*) FILTER (WHERE status = 'pending')::int AS pending,
      COUNT(*) FILTER (WHERE status = 'submitted')::int AS submitted,
      COUNT(*) FILTER (WHERE status = 'returned')::int AS returned
    FROM nativities
  `;

  return json({ nativities: rows, counts: countRows[0] });
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

export async function deleteNativity(request, env, session, id) {
  requireAdmin(session);
  const sql = db(env);

  const rows = await sql`
    SELECT id, submission_number, photo_key, display_photo_key
    FROM nativities
    WHERE id = ${id}
  `;
  if (rows.length === 0) return error('Not found.', 404);

  const pieceRows = await sql`
    SELECT photo_key
    FROM nativity_pieces
    WHERE nativity_id = ${id} AND photo_key IS NOT NULL
  `;

  await sql`UPDATE nativities SET cloned_from_id = NULL WHERE cloned_from_id = ${id}`;
  await sql`DELETE FROM nativities WHERE id = ${id}`;

  const keys = [rows[0].photo_key, rows[0].display_photo_key, ...pieceRows.map((p) => p.photo_key)].filter(Boolean);
  if (keys.length) {
    try {
      await Promise.all(keys.map((key) => env.PHOTOS.delete(key)));
    } catch (err) {
      console.error('Submission deleted but one or more R2 photos could not be removed:', err);
    }
  }

  return json({ ok: true, submission_number: rows[0].submission_number });
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

function decodeMetadataHeader(value, maxLength) {
  if (!value) return '';
  try {
    return decodeURIComponent(value).trim().slice(0, maxLength);
  } catch {
    return String(value).trim().slice(0, maxLength);
  }
}

// ── Standalone Scroll to the Stable media ──────────────────────────────
// These files live directly in R2 and are not attached to a donor or a
// nativity submission. This makes the public collection suitable for art,
// photographs, and videos as well as checked-in nativities.
export async function listTourMedia(request, env, session) {
  requireAdmin(session);
  const objects = await listTourMediaObjects(env);
  return json({ media: objects.map(serializeTourMedia) });
}

export async function uploadTourMedia(request, env, session) {
  requireAdmin(session);

  const spec = getTourMediaSpec(request.headers.get('Content-Type'));
  if (!spec) {
    return error('Use a JPG, PNG, WebP, GIF, MP4, WebM, or MOV file.', 415);
  }

  const contentLength = Number(request.headers.get('Content-Length') || 0);
  if (contentLength > MAX_TOUR_MEDIA_BYTES) {
    return error('This file is too large. The maximum upload size is 95 MB.', 413);
  }
  if (!request.body) return error('Choose a file to upload.');

  const title = decodeMetadataHeader(request.headers.get('X-Media-Title'), 120);
  const caption = decodeMetadataHeader(request.headers.get('X-Media-Caption'), 600);
  const key = `${TOUR_MEDIA_PREFIX}${crypto.randomUUID()}.${spec.ext}`;

  await env.PHOTOS.put(key, request.body, {
    httpMetadata: {
      contentType: spec.contentType,
      cacheControl: 'public, max-age=31536000',
    },
    customMetadata: {
      mediaType: spec.mediaType,
      title,
      caption,
      uploadedBy: session.email,
    },
  });

  return json({ ok: true, key, mediaType: spec.mediaType });
}

export async function deleteTourMedia(request, env, session) {
  requireAdmin(session);
  const { key } = await request.json();
  if (!key || !String(key).startsWith(TOUR_MEDIA_PREFIX)) {
    return error('Invalid tour media item.');
  }
  await env.PHOTOS.delete(String(key));
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
