// Display photo bank: an admin walks the finished display taking a photo of
// each nativity, without needing to know which one it is. Photos go into an
// unmatched bank, and are matched later to a nativity's display photo slot
// (nativities.display_photo_key). The donor's own photo (photo_key) is never
// changed here.
//
// Whether a bank photo is matched is worked out from nativities itself
// (display_photo_key = photo_bank.photo_key), so a display photo cleared or
// replaced anywhere else in the app is reflected here without extra state.
import { db } from '../lib/db.js';
import { json, error, requireAdmin } from '../lib/util.js';
import { readImageUpload } from '../lib/images.js';

export const PHOTO_BANK_PREFIX = 'photo-bank/';
// Fingerprints are small base64 strings made in the browser (see
// public/js/photo-bank.js). Anything longer is refused.
const MAX_FINGERPRINT = 400;
const FINGERPRINT_PATTERN = /^[A-Za-z0-9+/=]+$/;

let ensured = null;
export function ensurePhotoBankSchema(env) {
  if (!ensured) {
    const sql = db(env);
    ensured = (async () => {
      await sql`
        CREATE TABLE IF NOT EXISTS photo_bank (
          id BIGSERIAL PRIMARY KEY,
          photo_key TEXT UNIQUE NOT NULL,
          fingerprint TEXT,
          taken_at TIMESTAMPTZ,
          original_name TEXT NOT NULL DEFAULT '',
          uploaded_by TEXT NOT NULL DEFAULT '',
          uploaded_at TIMESTAMPTZ NOT NULL DEFAULT now(),
          matched_by TEXT,
          matched_at TIMESTAMPTZ
        )
      `;
      await sql`CREATE INDEX IF NOT EXISTS idx_photo_bank_taken ON photo_bank (taken_at, id)`;
      await sql`
        CREATE TABLE IF NOT EXISTS photo_fingerprints (
          photo_key TEXT PRIMARY KEY,
          fingerprint TEXT NOT NULL,
          updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
        )
      `;
      // Picks made by looking at each bank photo against the donor photos.
      // Suggestions only: an admin still chooses the match on the page.
      await sql`
        CREATE TABLE IF NOT EXISTS photo_bank_suggestions (
          bank_id BIGINT NOT NULL REFERENCES photo_bank(id) ON DELETE CASCADE,
          nativity_id BIGINT NOT NULL REFERENCES nativities(id) ON DELETE CASCADE,
          rank INT NOT NULL DEFAULT 1,
          note TEXT NOT NULL DEFAULT '',
          created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
          PRIMARY KEY (bank_id, nativity_id)
        )
      `;
      await sql`ALTER TABLE photo_bank ADD COLUMN IF NOT EXISTS suggest_note TEXT`;
      await sql`ALTER TABLE photo_bank ADD COLUMN IF NOT EXISTS suggested_at TIMESTAMPTZ`;
      // Proposed matches for nativities taken off the Scroll: how sure the pick
      // is, how far the bank photo needs turning (degrees clockwise), and who
      // approved it, keeping the old display photo so an approval can be undone.
      await sql`ALTER TABLE photo_bank_suggestions ADD COLUMN IF NOT EXISTS confidence TEXT NOT NULL DEFAULT ''`;
      await sql`ALTER TABLE photo_bank_suggestions ADD COLUMN IF NOT EXISTS rotate INT NOT NULL DEFAULT 0`;
      await sql`ALTER TABLE photo_bank_suggestions ADD COLUMN IF NOT EXISTS approved_by TEXT`;
      await sql`ALTER TABLE photo_bank_suggestions ADD COLUMN IF NOT EXISTS approved_at TIMESTAMPTZ`;
      await sql`ALTER TABLE photo_bank_suggestions ADD COLUMN IF NOT EXISTS previous_display_key TEXT`;
      await sql`ALTER TABLE photo_bank_suggestions ADD COLUMN IF NOT EXISTS dismissed_at TIMESTAMPTZ`;
    })().catch((err) => { ensured = null; throw err; });
  }
  return ensured;
}

function cleanFingerprint(value) {
  const fp = String(value || '').trim();
  if (!fp || fp.length > MAX_FINGERPRINT || !FINGERPRINT_PATTERN.test(fp)) return null;
  return fp;
}

function decodeHeader(value, max) {
  if (!value) return '';
  try { return decodeURIComponent(value).trim().slice(0, max); } catch { return String(value).trim().slice(0, max); }
}

// Upload one photo into the bank. Body is the image itself (already resized
// in the browser); X-Fingerprint, X-Taken-At and X-File-Name are optional.
export async function upload(request, env, session) {
  const admin = requireAdmin(session);
  await ensurePhotoBankSchema(env);
  const { bytes, type, ext } = await readImageUpload(request);
  const fingerprint = cleanFingerprint(request.headers.get('X-Fingerprint'));
  const takenRaw = request.headers.get('X-Taken-At');
  const takenMs = takenRaw ? Date.parse(takenRaw) : NaN;
  // Ignore clearly wrong clocks (before 2020 or more than a day ahead).
  const takenAt = Number.isFinite(takenMs) && takenMs > Date.UTC(2020, 0, 1) && takenMs < Date.now() + 86400000
    ? new Date(takenMs).toISOString() : null;
  const name = decodeHeader(request.headers.get('X-File-Name'), 200);

  const key = `${PHOTO_BANK_PREFIX}${crypto.randomUUID()}.${ext}`;
  await env.PHOTOS.put(key, bytes, { httpMetadata: { contentType: type } });
  const sql = db(env);
  const rows = await sql`
    INSERT INTO photo_bank (photo_key, fingerprint, taken_at, original_name, uploaded_by)
    VALUES (${key}, ${fingerprint}, ${takenAt}, ${name}, ${admin.email || ''})
    RETURNING id, photo_key, taken_at, uploaded_at`;
  return json({ ok: true, photo: rows[0] });
}

// Every bank photo, in the order taken, with the nativity it is the display
// photo of (if any).
export async function list(request, env, session) {
  requireAdmin(session);
  await ensurePhotoBankSchema(env);
  const sql = db(env);
  const photos = await sql`
    SELECT b.id, b.photo_key, b.fingerprint, b.taken_at, b.uploaded_at, b.original_name, b.uploaded_by,
           b.matched_by, b.matched_at, b.suggest_note, b.suggested_at,
           n.id AS nativity_id, n.submission_number
    FROM photo_bank b
    LEFT JOIN LATERAL (
      SELECT id, submission_number FROM nativities
      WHERE display_photo_key = b.photo_key ORDER BY submission_number LIMIT 1
    ) n ON TRUE
    ORDER BY COALESCE(b.taken_at, b.uploaded_at), b.id`;
  const picks = await sql`
    SELECT bank_id, nativity_id, rank, note FROM photo_bank_suggestions
    WHERE dismissed_at IS NULL ORDER BY bank_id, rank, nativity_id`;
  const byBank = new Map();
  for (const r of picks) {
    const k = String(r.bank_id);
    if (!byBank.has(k)) byBank.set(k, []);
    byBank.get(k).push({ nativity_id: String(r.nativity_id), rank: Number(r.rank), note: r.note || '' });
  }
  for (const p of photos) p.suggestions = byBank.get(String(p.id)) || [];
  return json({ photos });
}

// Candidates for matching: every nativity with its donor photo, current
// display photo and (when built) the donor photo's fingerprint.
export async function candidates(request, env, session) {
  requireAdmin(session);
  await ensurePhotoBankSchema(env);
  const sql = db(env);
  const rows = await sql`
    SELECT n.id, n.submission_number, n.status, n.piece_count, n.photo_key, n.display_photo_key, n.needs_better_photo,
           left(n.description, 300) AS description, u.name AS owner_name, u.donor_code AS owner_donor_code,
           f.fingerprint
    FROM nativities n
    JOIN users u ON u.id = n.owner_user_id
    LEFT JOIN photo_fingerprints f ON f.photo_key = n.photo_key
    WHERE n.submission_number NOT LIKE 'DRAFT-%'
    ORDER BY n.submission_number`;
  return json({ nativities: rows });
}

// Saves fingerprints the browser computed for donor photos. Only keys that are
// a nativity's photo_key are accepted.
export async function saveFingerprints(request, env, session) {
  requireAdmin(session);
  await ensurePhotoBankSchema(env);
  const body = await request.json();
  const items = (Array.isArray(body?.items) ? body.items : []).slice(0, 100)
    .map((it) => ({ key: String(it?.photo_key || ''), fp: cleanFingerprint(it?.fingerprint) }))
    .filter((it) => it.key && it.fp);
  if (!items.length) return json({ ok: true, saved: 0 });
  const sql = db(env);
  const known = await sql`SELECT photo_key FROM nativities WHERE photo_key = ANY(${items.map((i) => i.key)})`;
  const ok = new Set(known.map((r) => r.photo_key));
  const keep = items.filter((i) => ok.has(i.key));
  if (keep.length) {
    await sql`
      INSERT INTO photo_fingerprints (photo_key, fingerprint)
      SELECT * FROM unnest(${keep.map((i) => i.key)}::text[], ${keep.map((i) => i.fp)}::text[])
      ON CONFLICT (photo_key) DO UPDATE SET fingerprint = EXCLUDED.fingerprint, updated_at = now()`;
  }
  return json({ ok: true, saved: keep.length });
}

// Sets a missing fingerprint on a bank photo (for photos uploaded before the
// browser could make one).
export async function setFingerprint(request, env, session, id) {
  requireAdmin(session);
  await ensurePhotoBankSchema(env);
  const body = await request.json();
  const fp = cleanFingerprint(body?.fingerprint);
  if (!fp) return error('Invalid fingerprint.');
  const sql = db(env);
  await sql`UPDATE photo_bank SET fingerprint = ${fp} WHERE id = ${id}`;
  return json({ ok: true });
}

async function bankPhoto(sql, id) {
  const rows = await sql`SELECT * FROM photo_bank WHERE id = ${id}`;
  if (!rows.length) throw error('That photo is no longer in the bank.', 404);
  return rows[0];
}

// Makes a bank photo the display photo of one nativity. If the nativity
// already has a different display photo, the admin must confirm (replace).
// If the bank photo was the display photo of another nativity, it moves.
export async function match(request, env, session, id) {
  const admin = requireAdmin(session);
  await ensurePhotoBankSchema(env);
  const body = await request.json();
  const nativityId = Number(body?.nativityId);
  if (!Number.isInteger(nativityId) || nativityId <= 0) return error('Choose a nativity.');
  const sql = db(env);
  const photo = await bankPhoto(sql, id);
  const target = await sql`SELECT id, submission_number, display_photo_key FROM nativities WHERE id = ${nativityId}`;
  if (!target.length) return error('Nativity not found.', 404);
  const t = target[0];
  if (t.display_photo_key === photo.photo_key) return json({ ok: true, unchanged: true });
  if (t.display_photo_key && body?.replace !== true) {
    return json({
      error: `${t.submission_number} already has a display photo. Replace it?`,
      needsReplace: true,
      currentKey: t.display_photo_key,
    }, { status: 409 });
  }
  await sql.transaction([
    sql`UPDATE nativities SET display_photo_key = NULL, updated_at = now()
        WHERE display_photo_key = ${photo.photo_key} AND id <> ${nativityId}`,
    // A new display photo clears "needs a better photo", which puts it back on the Scroll.
    sql`UPDATE nativities SET display_photo_key = ${photo.photo_key}, needs_better_photo = FALSE,
        needs_better_photo_by = NULL, needs_better_photo_at = NULL, updated_at = now() WHERE id = ${nativityId}`,
    sql`UPDATE photo_bank SET matched_by = ${admin.email || ''}, matched_at = now() WHERE id = ${photo.id}`,
  ]);
  return json({ ok: true, nativityId, submissionNumber: t.submission_number, replacedKey: t.display_photo_key || null });
}

// Takes a bank photo off whichever nativity it is the display photo of.
export async function unmatch(request, env, session, id) {
  requireAdmin(session);
  await ensurePhotoBankSchema(env);
  const sql = db(env);
  const photo = await bankPhoto(sql, id);
  await sql.transaction([
    sql`UPDATE nativities SET display_photo_key = NULL, updated_at = now() WHERE display_photo_key = ${photo.photo_key}`,
    sql`UPDATE photo_bank SET matched_by = NULL, matched_at = NULL WHERE id = ${photo.id}`,
  ]);
  return json({ ok: true });
}

// Removes an unmatched photo from the bank (a blurry or duplicate shot).
export async function remove(request, env, session, id) {
  requireAdmin(session);
  await ensurePhotoBankSchema(env);
  const sql = db(env);
  const photo = await bankPhoto(sql, id);
  const used = await sql`
    SELECT submission_number FROM nativities WHERE display_photo_key = ${photo.photo_key} OR photo_key = ${photo.photo_key}
    UNION ALL SELECT 'piece' FROM nativity_pieces WHERE photo_key = ${photo.photo_key} LIMIT 1`;
  if (used.length) return error(`This photo is the display photo of ${used[0].submission_number}. Unmatch it first.`, 409);
  await sql`DELETE FROM photo_bank WHERE id = ${photo.id}`;
  await env.PHOTOS.delete(photo.photo_key).catch((e) => console.error('Could not delete', photo.photo_key, e));
  return json({ ok: true });
}

// ── Proposed matches for nativities taken off the Scroll ─────────────
// Every nativity marked "needs a better photo", plus any whose proposed
// match was approved, with the proposed bank photos side by side.
export async function proposals(request, env, session) {
  requireAdmin(session);
  await ensurePhotoBankSchema(env);
  const sql = db(env);
  const nativities = await sql`
    SELECT n.id, n.submission_number, n.piece_count, n.photo_key, n.display_photo_key, n.needs_better_photo,
           left(n.description, 200) AS description, u.name AS owner_name, u.donor_code AS owner_donor_code
    FROM nativities n
    JOIN users u ON u.id = n.owner_user_id
    WHERE n.submission_number NOT LIKE 'DRAFT-%'
      AND (n.needs_better_photo = TRUE
           OR EXISTS (SELECT 1 FROM photo_bank_suggestions s WHERE s.nativity_id = n.id AND s.approved_at IS NOT NULL))
    ORDER BY n.submission_number`;
  const ids = nativities.map((n) => n.id);
  const picks = ids.length ? await sql`
    SELECT s.nativity_id, s.bank_id, s.rank, s.note, s.confidence, s.rotate, s.approved_by, s.approved_at,
           b.photo_key AS bank_photo_key,
           (SELECT string_agg(o.submission_number, ', ' ORDER BY o.submission_number) FROM nativities o
             WHERE o.display_photo_key = b.photo_key AND o.id <> s.nativity_id) AS used_by
    FROM photo_bank_suggestions s
    JOIN photo_bank b ON b.id = s.bank_id
    WHERE s.nativity_id = ANY(${ids}) AND s.dismissed_at IS NULL
    ORDER BY s.nativity_id, s.rank, s.bank_id` : [];
  const byNativity = new Map();
  for (const p of picks) {
    const k = String(p.nativity_id);
    if (!byNativity.has(k)) byNativity.set(k, []);
    byNativity.get(k).push({
      bank_id: String(p.bank_id), bank_photo_key: p.bank_photo_key, rank: Number(p.rank), note: p.note || '',
      confidence: p.confidence || '', rotate: Number(p.rotate) || 0, approved_by: p.approved_by, approved_at: p.approved_at,
      used_by: p.used_by || '',
    });
  }
  for (const n of nativities) n.picks = byNativity.get(String(n.id)) || [];
  return json({ nativities });
}

async function proposal(sql, nativityId, bankId) {
  const rows = await sql`
    SELECT s.*, b.photo_key AS bank_photo_key FROM photo_bank_suggestions s JOIN photo_bank b ON b.id = s.bank_id
    WHERE s.nativity_id = ${nativityId} AND s.bank_id = ${bankId}`;
  if (!rows.length) throw error('That proposed match is no longer there. Reload the page.', 404);
  return rows[0];
}

function ids(body) {
  const nativityId = Number(body?.nativityId);
  const bankId = Number(body?.bankId);
  if (!Number.isInteger(nativityId) || nativityId <= 0 || !Number.isInteger(bankId) || bankId <= 0) {
    throw error('Choose a nativity and a photo.');
  }
  return { nativityId, bankId };
}

// Approves a proposed match: the bank photo becomes the nativity's display
// photo, which puts it back on the Scroll. Unlike match(), the same bank photo
// may be the display photo of more than one nativity (one photo of a set that
// was entered in parts).
export async function approveProposal(request, env, session) {
  const admin = requireAdmin(session);
  await ensurePhotoBankSchema(env);
  const body = await request.json();
  const { nativityId, bankId } = ids(body);
  const sql = db(env);
  const p = await proposal(sql, nativityId, bankId);
  const target = await sql`SELECT id, submission_number, display_photo_key FROM nativities WHERE id = ${nativityId}`;
  if (!target.length) return error('Nativity not found.', 404);
  const t = target[0];
  if (t.display_photo_key === p.bank_photo_key) return json({ ok: true, unchanged: true });
  if (t.display_photo_key && body?.replace !== true) {
    return json({ error: `${t.submission_number} already has a display photo. Replace it?`, needsReplace: true }, { status: 409 });
  }
  await sql.transaction([
    sql`UPDATE nativities SET display_photo_key = ${p.bank_photo_key}, needs_better_photo = FALSE,
        needs_better_photo_by = NULL, needs_better_photo_at = NULL, updated_at = now() WHERE id = ${nativityId}`,
    sql`UPDATE photo_bank_suggestions SET approved_by = ${admin.email || ''}, approved_at = now(),
        previous_display_key = ${t.display_photo_key || null}
        WHERE nativity_id = ${nativityId} AND bank_id = ${bankId}`,
    sql`UPDATE photo_bank SET matched_by = ${admin.email || ''}, matched_at = now() WHERE id = ${bankId}`,
  ]);
  return json({ ok: true, submissionNumber: t.submission_number });
}

// Undoes an approval: the old display photo comes back and the nativity is
// marked as needing a better photo again (off the Scroll).
export async function undoProposal(request, env, session) {
  const admin = requireAdmin(session);
  await ensurePhotoBankSchema(env);
  const { nativityId, bankId } = ids(await request.json());
  const sql = db(env);
  const p = await proposal(sql, nativityId, bankId);
  if (!p.approved_at) return json({ ok: true, unchanged: true });
  await sql.transaction([
    sql`UPDATE nativities SET display_photo_key = ${p.previous_display_key || null}, needs_better_photo = TRUE,
        needs_better_photo_by = ${admin.email || ''}, needs_better_photo_at = now(), updated_at = now()
        WHERE id = ${nativityId} AND display_photo_key = ${p.bank_photo_key}`,
    sql`UPDATE photo_bank_suggestions SET approved_by = NULL, approved_at = NULL, previous_display_key = NULL
        WHERE nativity_id = ${nativityId} AND bank_id = ${bankId}`,
  ]);
  return json({ ok: true });
}

// "Not this one": hides a proposed match. It stays in the table, marked.
export async function dismissProposal(request, env, session) {
  requireAdmin(session);
  await ensurePhotoBankSchema(env);
  const { nativityId, bankId } = ids(await request.json());
  const sql = db(env);
  const p = await proposal(sql, nativityId, bankId);
  if (p.approved_at) return error('Undo the approval first.', 409);
  await sql`UPDATE photo_bank_suggestions SET dismissed_at = now() WHERE nativity_id = ${nativityId} AND bank_id = ${bankId}`;
  return json({ ok: true });
}

// Replaces a bank photo with a turned copy made in the browser. The new image
// gets a new key (so no one sees a cached sideways copy) and every nativity
// using the photo follows it. The old file is kept in R2.
export async function rotated(request, env, session, id) {
  requireAdmin(session);
  await ensurePhotoBankSchema(env);
  const { bytes, type, ext } = await readImageUpload(request);
  const sql = db(env);
  const photo = await bankPhoto(sql, id);
  const key = `${PHOTO_BANK_PREFIX}${crypto.randomUUID()}.${ext}`;
  await env.PHOTOS.put(key, bytes, { httpMetadata: { contentType: type } });
  await sql.transaction([
    sql`UPDATE photo_bank SET photo_key = ${key}, fingerprint = NULL WHERE id = ${photo.id}`,
    sql`UPDATE nativities SET display_photo_key = ${key}, updated_at = now() WHERE display_photo_key = ${photo.photo_key}`,
    sql`UPDATE photo_bank_suggestions SET rotate = 0 WHERE bank_id = ${photo.id}`,
    sql`UPDATE photo_bank_suggestions SET previous_display_key = ${key} WHERE previous_display_key = ${photo.photo_key}`,
  ]);
  return json({ ok: true, photo_key: key, previous_key: photo.photo_key });
}
