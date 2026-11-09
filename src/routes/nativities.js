import { db } from '../lib/db.js';
import { nextSubmissionNumber } from '../lib/auth.js';
import { json, error, requireUser } from '../lib/util.js';
import { getSiteSettings, submissionsAreOpen } from '../lib/siteSettings.js';
import { readImageUpload } from '../lib/images.js';
import { resetWaiver } from './waivers.js';

// Photos a participant attaches must be ones they uploaded themselves. Without
// this check a user could point a nativity at any storage key (including other
// people's files or internal data), which admin "delete" would later remove.
function ownPhotoKey(session, key) {
  if (key === undefined || key === null || key === '') return null;
  const pattern = new RegExp(`^${session.userId}/[0-9a-f-]{36}\\.(jpg|png|webp|gif)$`);
  if (typeof key !== 'string' || !pattern.test(key)) throw error('Invalid photo reference.', 400);
  return key;
}

const MAX_STORY = 5000;
const MAX_PIECES = 100;
const MAX_PIECE_TEXT = 2000;

function currentEventYear() {
  return new Date().getFullYear();
}

async function requireSubmissionsOpen(env) {
  const settings = await getSiteSettings(env);
  if (!submissionsAreOpen(settings)) {
    throw error('Nativity submissions are currently closed.', 403);
  }
}

export async function listMine(request, env, session) {
  requireUser(session);
  const sql = db(env);
  const nativities = await sql`
    SELECT id, submission_number, event_year, status, piece_count, photo_key, description, story, include_in_tour, waiver_signed, waiver_method, created_at
    FROM nativities WHERE owner_user_id = ${session.userId}
    ORDER BY event_year DESC, created_at DESC
  `;
  return json({ nativities });
}

export async function getOne(request, env, session, id) {
  requireUser(session);
  const sql = db(env);
  const rows = await sql`SELECT * FROM nativities WHERE id = ${id} AND owner_user_id = ${session.userId}`;
  if (rows.length === 0) return error('Nativity not found.', 404);
  const pieces = await sql`SELECT * FROM nativity_pieces WHERE nativity_id = ${id} ORDER BY piece_number`;
  return json({ nativity: rows[0], pieces });
}

// Step 1 of "Lend a Nativity" — photo + optional story. Returns a draft id
// that the pieces step below will fill in and finalize.
export async function create(request, env, session) {
  requireUser(session);
  await requireSubmissionsOpen(env);

  const body = await request.json();
  const photoKey = ownPhotoKey(session, body?.photoKey);
  const story = typeof body?.story === 'string' ? body.story.slice(0, MAX_STORY) : null;
  const description = typeof body?.description === 'string' ? body.description.trim().slice(0, MAX_STORY) : '';
  const sql = db(env);
  const eventYear = currentEventYear();
  const rows = await sql`
    INSERT INTO nativities (submission_number, owner_user_id, event_year, photo_key, description, story, status, include_in_tour)
    VALUES (${'DRAFT-' + crypto.randomUUID()}, ${session.userId}, ${eventYear}, ${photoKey}, ${description || null}, ${story || null}, 'pending', ${true})
    RETURNING id
  `;
  return json({ id: rows[0].id });
}

// Lets an owner change their mind about tour visibility any time, without
// touching the rest of the submission.
export async function setTourVisibility(request, env, session, id) {
  requireUser(session);
  const { includeInTour } = await request.json();
  const sql = db(env);
  const owned = await sql`SELECT id FROM nativities WHERE id = ${id} AND owner_user_id = ${session.userId}`;
  if (owned.length === 0) return error('Nativity not found.', 404);
  await sql`UPDATE nativities SET include_in_tour = ${!!includeInTour}, updated_at = now() WHERE id = ${id}`;
  return json({ ok: true });
}

// Step 2 — the per-piece form. Existing drafts may still be completed after
// new submissions have been closed.
export async function submitPieces(request, env, session, id) {
  requireUser(session);
  const { pieces } = await request.json();
  if (!Array.isArray(pieces) || pieces.length === 0) return error('Add at least one piece.');
  if (pieces.length > MAX_PIECES) return error(`A submission can have at most ${MAX_PIECES} pieces.`);
  for (const p of pieces) {
    if (!p || typeof p.description !== 'string' || typeof p.condition_notes !== 'string'
        || !p.description.trim() || !p.condition_notes.trim()) {
      return error('Every piece needs a description and a condition note.');
    }
    if (p.description.length > MAX_PIECE_TEXT || p.condition_notes.length > MAX_PIECE_TEXT) {
      return error('A piece description or condition note is too long.');
    }
    p.photoKey = ownPhotoKey(session, p.photoKey);
  }

  const sql = db(env);
  const owned = await sql`
    SELECT n.id, n.photo_key, n.story, n.display_photo_key, n.submission_number, n.status, n.waiver_signed, n.waiver_method,
           u.name AS owner_name, u.email AS owner_email
    FROM nativities n
    JOIN users u ON u.id = n.owner_user_id
    WHERE n.id = ${id} AND n.owner_user_id = ${session.userId}
  `;
  if (owned.length === 0) return error('Nativity not found.', 404);

  // After check-in the inventory can only be changed by an admin. Before
  // check-in the donor may edit, which clears any waiver so it is re-signed.
  if (owned[0].status !== 'pending') {
    return error('This nativity has been checked in. Please contact us to make changes.', 409);
  }
  if (owned[0].waiver_signed || owned[0].waiver_method) await resetWaiver(env, owned[0]);

  // Keep the number if one was already issued; only drafts get a new one.
  const submissionNumber = String(owned[0].submission_number).startsWith('DRAFT-')
    ? await nextSubmissionNumber(sql, currentEventYear())
    : owned[0].submission_number;

  await sql`DELETE FROM nativity_pieces WHERE nativity_id = ${id}`;
  for (let i = 0; i < pieces.length; i++) {
    const p = pieces[i];
    await sql`
      INSERT INTO nativity_pieces (nativity_id, piece_number, description, condition_notes, photo_key)
      VALUES (${id}, ${i + 1}, ${p.description.trim()}, ${p.condition_notes.trim()}, ${p.photoKey || null})
    `;
  }
  await sql`
    UPDATE nativities SET submission_number = ${submissionNumber}, piece_count = ${pieces.length}, updated_at = now()
    WHERE id = ${id}
  `;

  // No email here: the single confirmation email is sent when the waiver is
  // signed online or the donor chooses to sign a paper copy at drop-off.
  return json({ ok: true, submissionNumber });
}

// One-click resubmit creates a new current-year submission, so it is disabled
// when admins have closed new nativity submissions.
export async function resubmit(request, env, session, sourceId) {
  requireUser(session);
  await requireSubmissionsOpen(env);

  const sql = db(env);
  const source = await sql`
    SELECT * FROM nativities WHERE id = ${sourceId} AND owner_user_id = ${session.userId}
  `;
  if (source.length === 0) return error('Nativity not found.', 404);
  const src = source[0];
  const eventYear = currentEventYear();

  if (src.status !== 'returned' || Number(src.event_year) >= eventYear) {
    return error('Only returned nativities from a previous year can be submitted again.');
  }

  const submissionNumber = await nextSubmissionNumber(sql, eventYear);
  const inserted = await sql`
    INSERT INTO nativities (submission_number, owner_user_id, event_year, photo_key, description, story, piece_count, status, include_in_tour, cloned_from_id)
    VALUES (${submissionNumber}, ${session.userId}, ${eventYear}, ${src.photo_key}, ${src.description}, ${src.story}, ${src.piece_count}, 'pending', ${src.include_in_tour}, ${src.id})
    RETURNING id
  `;
  const newId = inserted[0].id;

  const pieces = await sql`SELECT * FROM nativity_pieces WHERE nativity_id = ${src.id} ORDER BY piece_number`;
  for (const p of pieces) {
    await sql`
      INSERT INTO nativity_pieces (nativity_id, piece_number, description, condition_notes, photo_key)
      VALUES (${newId}, ${p.piece_number}, ${p.description}, ${p.condition_notes}, ${p.photo_key})
    `;
  }

  return json({ ok: true, id: newId, submissionNumber });
}

// Shared photo upload used by both the overall-nativity photo and each
// piece's optional photo. Expects raw image bytes with a Content-Type header.
export async function uploadPhoto(request, env, session) {
  requireUser(session);
  const { bytes, type, ext } = await readImageUpload(request);
  const key = `${session.userId}/${crypto.randomUUID()}.${ext}`;
  await env.PHOTOS.put(key, bytes, { httpMetadata: { contentType: type } });
  return json({ key });
}

// Deletes storage objects that no remaining nativity or piece still uses
// (resubmitted nativities share photos with the original).
export async function removeUnreferencedPhotos(sql, env, keys) {
  const unique = [...new Set(keys.filter(Boolean))];
  for (const k of unique) {
    const used = await sql`
      SELECT 1 FROM nativities WHERE photo_key = ${k} OR display_photo_key = ${k}
      UNION ALL SELECT 1 FROM nativity_pieces WHERE photo_key = ${k} LIMIT 1`;
    if (!used.length) await env.PHOTOS.delete(k).catch((e) => console.error('Could not delete', k, e));
  }
}

async function ownedPending(sql, session, id) {
  const rows = await sql`SELECT * FROM nativities WHERE id = ${id} AND owner_user_id = ${session.userId}`;
  if (!rows.length) throw error('Nativity not found.', 404);
  if (rows[0].status !== 'pending') throw error('This nativity has been checked in. Please contact us to make changes.', 409);
  return rows[0];
}

// Donor edits description, story or main photo before check-in. Any change
// clears the waiver so a fresh one is generated and signed.
export async function updateDetails(request, env, session, id) {
  requireUser(session);
  const sql = db(env);
  const n = await ownedPending(sql, session, id);
  const body = await request.json();
  const description = typeof body?.description === 'string' ? body.description.trim().slice(0, MAX_STORY) : n.description;
  const story = typeof body?.story === 'string' ? body.story.trim().slice(0, MAX_STORY) : n.story;
  const photoKey = body?.photoKey === undefined ? n.photo_key : ownPhotoKey(session, body.photoKey);
  if (!photoKey) return error('A photo of the nativity is required.');
  const changed = (description || null) !== (n.description || null) || (story || null) !== (n.story || null) || photoKey !== n.photo_key;
  if (!changed) return json({ ok: true, changed: false });
  await sql`UPDATE nativities SET description = ${description || null}, story = ${story || null}, photo_key = ${photoKey}, updated_at = now() WHERE id = ${n.id}`;
  const waiverCleared = !!(n.waiver_signed || n.waiver_method);
  if (waiverCleared) await resetWaiver(env, n);
  if (photoKey !== n.photo_key) await removeUnreferencedPhotos(sql, env, [n.photo_key]);
  return json({ ok: true, changed: true, waiverCleared });
}

// Donor deletes a submission before check-in. A signed waiver is archived.
export async function deleteMine(request, env, session, id) {
  requireUser(session);
  const sql = db(env);
  const n = await ownedPending(sql, session, id);
  const pieces = await sql`SELECT photo_key FROM nativity_pieces WHERE nativity_id = ${n.id} AND photo_key IS NOT NULL`;
  if (n.waiver_signed || n.waiver_method) await resetWaiver(env, n);
  await env.PHOTOS.delete(`_waivers/${n.id}-draft.json`).catch(() => {});
  await sql`UPDATE nativities SET cloned_from_id = NULL WHERE cloned_from_id = ${n.id}`;
  await sql`DELETE FROM nativities WHERE id = ${n.id}`;
  await removeUnreferencedPhotos(sql, env, [n.photo_key, n.display_photo_key, ...pieces.map((p) => p.photo_key)]);
  return json({ ok: true });
}
