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
import {
  getSiteSettings,
  setSubmissionsOpen,
  updateSiteSettings,
  getAdminNote,
  setAdminNote,
  deleteAdminNote,
} from '../lib/siteSettings.js';

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

export async function getAdminSettings(request, env, session) {
  requireAdmin(session);
  const settings = await getSiteSettings(env);
  return json(settings);
}

export async function updateAdminSettings(request, env, session) {
  requireAdmin(session);
  const body = await request.json();
  const current = await getSiteSettings(env);
  const allowedStrings = ['submissionStart', 'submissionEnd', 'dropoffStart', 'dropoffEnd', 'pickupStart', 'pickupEnd'];
  const updates = {};

  if (body.submissionsOpen !== undefined) {
    if (typeof body.submissionsOpen !== 'boolean') return error('Invalid submission setting.');
    updates.submissionsOpen = body.submissionsOpen;
  }

  for (const key of allowedStrings) {
    if (body[key] !== undefined) {
      if (typeof body[key] !== 'string') return error('Invalid schedule setting.');
      updates[key] = body[key];
    }
  }

  const validDate = /^\d{4}-\d{2}-\d{2}$/;
  const validTime = /^([01]\d|2[0-3]):[0-5]\d$/;
  for (const key of ['dropoffDays', 'pickupDays']) {
    if (body[key] === undefined) continue;
    if (!Array.isArray(body[key])) return error('Invalid daily schedule.');
    const normalized = [];
    for (const item of body[key]) {
      if (!item || typeof item !== 'object' || !validDate.test(item.date || '')) return error('Invalid schedule date.');
      const available = item.available !== false;
      if (available && (!validTime.test(item.start || '') || !validTime.test(item.end || '') || item.start >= item.end)) {
        return error('Each available day needs a valid start and end time.');
      }
      normalized.push({
        date: item.date,
        available,
        start: available ? item.start : '',
        end: available ? item.end : '',
      });
    }
    normalized.sort((a, b) => a.date.localeCompare(b.date));
    updates[key] = normalized;
  }

  const submissionStart = updates.submissionStart ?? current.submissionStart;
  const submissionEnd = updates.submissionEnd ?? current.submissionEnd;
  if (submissionStart && submissionEnd && new Date(submissionStart) > new Date(submissionEnd)) {
    return error('The submission opening time cannot be after the closing time.');
  }

  const settings = await updateSiteSettings(env, updates, session.email);
  return json({ ok: true, ...settings });
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
  const adminNote = await getAdminNote(env, id);
  return json({ nativity: rows[0], pieces, adminNote });
}

export async function updateNativity(request, env, session, id) {
  requireAdmin(session);
  const body = await request.json();
  const owner = body.owner || {};
  const pieces = body.pieces;

  if (!owner.name?.trim() || !owner.phone?.trim() || !owner.email?.trim()) {
    return error('Donor name, phone, and email are required.');
  }
  if (!Array.isArray(pieces) || pieces.length === 0) {
    return error('A submission must have at least one piece.');
  }
  for (const piece of pieces) {
    if (!piece.description?.trim() || !piece.condition_notes?.trim()) {
      return error('Every piece needs a description and condition note.');
    }
  }

  const sql = db(env);
  const rows = await sql`SELECT id, owner_user_id FROM nativities WHERE id = ${id}`;
  if (rows.length === 0) return error('Not found.', 404);
  const ownerUserId = rows[0].owner_user_id;

  await sql`
    UPDATE users
    SET name = ${owner.name.trim()}, phone = ${owner.phone.trim()}, email = ${owner.email.trim()}
    WHERE id = ${ownerUserId}
  `;

  await sql`
    UPDATE nativities
    SET story = ${body.story?.trim() || null},
        include_in_tour = ${body.includeInTour !== false},
        updated_at = now()
    WHERE id = ${id}
  `;

  const existingPieces = await sql`SELECT id FROM nativity_pieces WHERE nativity_id = ${id}`;
  const existingIds = new Set(existingPieces.map((p) => String(p.id)));
  const requestedExistingIds = new Set(
    pieces
      .map((piece) => piece.id ? String(piece.id) : '')
      .filter((pieceId) => existingIds.has(pieceId))
  );

  // Delete removed pieces first so the unique nativity_id + piece_number
  // constraint cannot collide while the remaining pieces are renumbered.
  for (const existing of existingPieces) {
    if (!requestedExistingIds.has(String(existing.id))) {
      await sql`DELETE FROM nativity_pieces WHERE id = ${existing.id} AND nativity_id = ${id}`;
    }
  }

  for (let i = 0; i < pieces.length; i++) {
    const piece = pieces[i];
    const requestedId = piece.id ? String(piece.id) : '';

    if (requestedId && existingIds.has(requestedId)) {
      await sql`
        UPDATE nativity_pieces
        SET piece_number = ${i + 1},
            description = ${piece.description.trim()},
            condition_notes = ${piece.condition_notes.trim()}
        WHERE id = ${requestedId} AND nativity_id = ${id}
      `;
    } else {
      await sql`
        INSERT INTO nativity_pieces (nativity_id, piece_number, description, condition_notes, photo_key)
        VALUES (${id}, ${i + 1}, ${piece.description.trim()}, ${piece.condition_notes.trim()}, NULL)
      `;
    }
  }

  await sql`UPDATE nativities SET piece_count = ${pieces.length}, updated_at = now() WHERE id = ${id}`;
  await setAdminNote(env, id, body.adminNote || '', session.email);

  return json({ ok: true });
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
  try {
    await Promise.all([
      ...keys.map((key) => env.PHOTOS.delete(key)),
      deleteAdminNote(env, id),
    ]);
  } catch (err) {
    console.error('Submission deleted but one or more R2 objects could not be removed:', err);
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
  const settings = await getSiteSettings(env);
  await sendClaimTicketEmail(env, {
    to: nativity.owner_email,
    name: nativity.owner_name,
    nativity,
    pieces,
    settings,
    baseUrl: new URL(request.url).origin,
  });

  return json({ ok: true });
}

export async function markReturned(request, env, session, id) {
  requireAdmin(session);
  const sql = db(env);
  const rows = await sql`SELECT status FROM nativities WHERE id = ${id}`;
  if (rows.length === 0) return error('Not found.', 404);
  if (rows[0].status !== 'submitted') return error('Only a submitted nativity can be marked returned.');
  await sql`UPDATE nativities SET status = 'returned', returned_at = now(), updated_at = now() WHERE id = ${id}`;
  return json({ ok: true });
}

async function putAdminPhoto(request, env, keyPrefix) {
  const contentType = request.headers.get('Content-Type') || 'image/jpeg';
  if (!contentType.startsWith('image/')) return error('Choose an image file.', 415);
  const key = `${keyPrefix}/${crypto.randomUUID()}.jpg`;
  const bytes = await request.arrayBuffer();
  await env.PHOTOS.put(key, bytes, { httpMetadata: { contentType } });
  return key;
}

export async function uploadMainPhoto(request, env, session, id) {
  requireAdmin(session);
  const sql = db(env);
  const rows = await sql`SELECT id FROM nativities WHERE id = ${id}`;
  if (rows.length === 0) return error('Not found.', 404);
  const key = await putAdminPhoto(request, env, `admin-edits/${id}/main`);
  if (key instanceof Response) return key;
  await sql`UPDATE nativities SET photo_key = ${key}, updated_at = now() WHERE id = ${id}`;
  return json({ ok: true, key });
}

export async function clearMainPhoto(request, env, session, id) {
  requireAdmin(session);
  const sql = db(env);
  await sql`UPDATE nativities SET photo_key = NULL, updated_at = now() WHERE id = ${id}`;
  return json({ ok: true });
}

export async function uploadPiecePhoto(request, env, session, id, pieceId) {
  requireAdmin(session);
  const sql = db(env);
  const rows = await sql`SELECT id FROM nativity_pieces WHERE id = ${pieceId} AND nativity_id = ${id}`;
  if (rows.length === 0) return error('Piece not found.', 404);
  const key = await putAdminPhoto(request, env, `admin-edits/${id}/pieces/${pieceId}`);
  if (key instanceof Response) return key;
  await sql`UPDATE nativity_pieces SET photo_key = ${key} WHERE id = ${pieceId} AND nativity_id = ${id}`;
  return json({ ok: true, key });
}

export async function clearPiecePhoto(request, env, session, id, pieceId) {
  requireAdmin(session);
  const sql = db(env);
  await sql`UPDATE nativity_pieces SET photo_key = NULL WHERE id = ${pieceId} AND nativity_id = ${id}`;
  return json({ ok: true });
}

export async function uploadDisplayPhoto(request, env, session, id) {
  requireAdmin(session);
  const sql = db(env);
  const existing = await sql`SELECT id FROM nativities WHERE id = ${id}`;
  if (existing.length === 0) return error('Not found.', 404);

  const key = await putAdminPhoto(request, env, `display/${id}`);
  if (key instanceof Response) return key;
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

const LANDING_BACKGROUND_KEY = 'site-assets/landing-background';

export async function uploadLandingBackground(request, env, session) {
  requireAdmin(session);
  const contentType = request.headers.get('Content-Type') || '';
  if (!contentType.startsWith('image/')) return error('Choose an image file.', 415);

  const contentLength = Number(request.headers.get('Content-Length') || 0);
  if (contentLength > 20 * 1024 * 1024) {
    return error('The background image must be 20 MB or smaller.', 413);
  }

  const bytes = await request.arrayBuffer();
  if (!bytes.byteLength) return error('Choose an image file.');
  if (bytes.byteLength > 20 * 1024 * 1024) {
    return error('The background image must be 20 MB or smaller.', 413);
  }

  await env.PHOTOS.put(LANDING_BACKGROUND_KEY, bytes, {
    httpMetadata: {
      contentType,
      cacheControl: 'public, max-age=3600',
    },
    customMetadata: {
      uploadedBy: session.email,
      uploadedAt: new Date().toISOString(),
    },
  });

  const settings = await updateSiteSettings(
    env,
    { landingBackgroundKey: LANDING_BACKGROUND_KEY },
    session.email
  );

  return json({
    ok: true,
    landingBackgroundUrl: `/site-background?v=${encodeURIComponent(settings.updatedAt || Date.now())}`,
  });
}

export async function deleteLandingBackground(request, env, session) {
  requireAdmin(session);
  const settings = await getSiteSettings(env);
  const key = settings.landingBackgroundKey || LANDING_BACKGROUND_KEY;

  try {
    await env.PHOTOS.delete(key);
  } catch (err) {
    console.error('Could not delete landing background object:', err);
  }

  await updateSiteSettings(env, { landingBackgroundKey: '' }, session.email);
  return json({ ok: true });
}

export async function listTourMedia(request, env, session) {
  requireAdmin(session);
  const objects = await listTourMediaObjects(env);
  return json({ media: objects.map(serializeTourMedia) });
}

export async function uploadTourMedia(request, env, session) {
  requireAdmin(session);

  const spec = getTourMediaSpec(request.headers.get('Content-Type'));
  if (!spec) return error('Use a JPG, PNG, WebP, GIF, MP4, WebM, or MOV file.', 415);

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
  if (!key || !String(key).startsWith(TOUR_MEDIA_PREFIX)) return error('Invalid tour media item.');
  await env.PHOTOS.delete(String(key));
  return json({ ok: true });
}

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
