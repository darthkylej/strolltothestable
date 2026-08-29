import { db } from '../lib/db.js';
import { nextSubmissionNumber } from '../lib/auth.js';
import { json, error, requireUser } from '../lib/util.js';

const CURRENT_EVENT_YEAR = new Date().getFullYear();

export async function listMine(request, env, session) {
  requireUser(session);
  const sql = db(env);
  const nativities = await sql`
    SELECT id, submission_number, event_year, status, piece_count, photo_key, story, include_in_tour, created_at
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
// that the pieces step (below) will fill in and finalize.
export async function create(request, env, session) {
  requireUser(session);
  const { photoKey, story, includeInTour } = await request.json();
  const sql = db(env);
  const rows = await sql`
    INSERT INTO nativities (submission_number, owner_user_id, event_year, photo_key, story, status, include_in_tour)
    VALUES (${'DRAFT-' + crypto.randomUUID()}, ${session.userId}, ${CURRENT_EVENT_YEAR}, ${photoKey || null}, ${story || null}, 'pending', ${includeInTour !== false})
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

// Step 2 — the per-piece form. Replaces any existing draft submission_number
// with a real one, since the online form is now complete.
export async function submitPieces(request, env, session, id) {
  requireUser(session);
  const { pieces } = await request.json();
  if (!Array.isArray(pieces) || pieces.length === 0) return error('Add at least one piece.');
  for (const p of pieces) {
    if (!p.description?.trim() || !p.condition_notes?.trim()) {
      return error('Every piece needs a description and a condition note.');
    }
  }

  const sql = db(env);
  const owned = await sql`SELECT id FROM nativities WHERE id = ${id} AND owner_user_id = ${session.userId}`;
  if (owned.length === 0) return error('Nativity not found.', 404);

  const submissionNumber = await nextSubmissionNumber(sql, CURRENT_EVENT_YEAR);

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

  return json({ ok: true, submissionNumber });
}

// One-click resubmit: clone last year's nativity (photo, story, pieces) into
// a brand-new pending row for this year. The donor can edit before their
// in-person check-in; a worker re-verifies condition regardless.
export async function resubmit(request, env, session, sourceId) {
  requireUser(session);
  const sql = db(env);
  const source = await sql`
    SELECT * FROM nativities WHERE id = ${sourceId} AND owner_user_id = ${session.userId}
  `;
  if (source.length === 0) return error('Nativity not found.', 404);
  const src = source[0];

  if (src.event_year === CURRENT_EVENT_YEAR) {
    return error('This nativity is already registered for this year.');
  }

  const submissionNumber = await nextSubmissionNumber(sql, CURRENT_EVENT_YEAR);
  const inserted = await sql`
    INSERT INTO nativities (submission_number, owner_user_id, event_year, photo_key, story, piece_count, status, include_in_tour, cloned_from_id)
    VALUES (${submissionNumber}, ${session.userId}, ${CURRENT_EVENT_YEAR}, ${src.photo_key}, ${src.story}, ${src.piece_count}, 'pending', ${src.include_in_tour}, ${src.id})
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
// piece's optional photo. Expects raw image bytes with a Content-Type
// header; resizing happens client-side before this is called (see
// public/js/upload.js) to keep R2 usage small.
export async function uploadPhoto(request, env, session) {
  requireUser(session);
  const contentType = request.headers.get('Content-Type') || 'image/jpeg';
  const key = `${session.userId}/${crypto.randomUUID()}.jpg`;
  const bytes = await request.arrayBuffer();
  await env.PHOTOS.put(key, bytes, { httpMetadata: { contentType } });
  return json({ key });
}
