// Walk-in desk: lets an admin register a donor who just shows up (no login,
// phone and email optional) and quickly record many nativities for them.
import { PDFDocument } from 'pdf-lib';
import { db } from '../lib/db.js';
import { json, error, requireAdmin } from '../lib/util.js';
import { hashPassword, generateShortPassword, nextUsername, nextSubmissionNumber } from '../lib/auth.js';
import { getSiteSettings } from '../lib/siteSettings.js';
import { sendDonorCheckInSummaryEmail } from '../lib/email.js';
import { paperChoice, paperPdf, writeAdminPaperChoice, resetWaiversForUser } from './waivers.js';
import { normalizeDonorCode } from './admin.js';

const EMAIL_RE = /^[^\s@<>"]+@[^\s@<>"]+\.[^\s@<>"]{2,}$/;
const MAX_PIECES = 100;
const MAX_TEXT = 2000;
const DEFAULT_CONDITION = 'No condition notes recorded at drop-off.';
// Each waiver in a combined print job needs a few storage lookups, so the
// combined PDF is built in batches to stay inside Worker request limits.
export const WAIVER_BATCH = 10;

function currentEventYear() {
  return new Date().getFullYear();
}

// Postgres array literal for a list of numeric ids, e.g. {4,9,12}.
const pgIdArray = (ids) => `{${ids.map((v) => String(parseInt(v, 10))).join(',')}}`;

const clip = (value, max) => String(value ?? '').trim().slice(0, max);

// Reads and validates the donor fields an admin can enter. Only the name is
// required. Returns { fields } or { problem }.
function readDonorFields(body) {
  const fields = {
    name: String(body?.name ?? '').trim(),
    phone: String(body?.phone ?? '').trim() || null,
    email: String(body?.email ?? '').trim() || null,
    address: String(body?.address ?? '').trim() || null,
    cityStateZip: String(body?.cityStateZip ?? '').trim() || null,
  };
  if (!fields.name) return { problem: "Enter the donor's name." };
  if (fields.name.length > 100 || (fields.phone || '').length > 40 || (fields.email || '').length > 254
      || (fields.address || '').length > 200 || (fields.cityStateZip || '').length > 200) {
    return { problem: 'One of the fields is too long.' };
  }
  if (fields.email && !EMAIL_RE.test(fields.email)) return { problem: 'Enter a valid email address, or leave it blank.' };
  return { fields };
}

const DONOR_COLUMNS = (u) => ({
  id: u.id,
  donorCode: u.donor_code,
  name: u.name,
  phone: u.phone,
  email: u.email,
  address: u.address,
  cityStateZip: u.city_state_zip,
});

// GET /api/admin/donors?search=  — find a donor by code, name, phone or email.
export async function listDonors(request, env, session) {
  requireAdmin(session);
  const search = new URL(request.url).searchParams.get('search')?.trim() || null;
  const like = search ? `%${search}%` : null;
  const code = normalizeDonorCode(search);
  // "830-555-1234" should match however the phone was typed in.
  const digits = search ? search.replace(/\D/g, '') : '';
  const phoneLike = digits.length >= 4 ? `%${digits}%` : null;
  const year = currentEventYear();

  const rows = await db(env)`
    SELECT u.id, u.donor_code, u.name, u.phone, u.email,
           COUNT(n.id) FILTER (WHERE n.event_year = ${year})::int AS this_year,
           COUNT(n.id)::int AS total
    FROM users u
    LEFT JOIN nativities n ON n.owner_user_id = u.id AND n.submission_number NOT LIKE 'DRAFT-%'
    WHERE ${like}::text IS NULL
       OR u.name ILIKE ${like} OR u.email ILIKE ${like} OR u.phone ILIKE ${like}
       OR u.donor_code ILIKE ${like} OR u.donor_code = ${code}
       OR (${phoneLike}::text IS NOT NULL AND regexp_replace(COALESCE(u.phone, ''), '[^0-9]', '', 'g') LIKE ${phoneLike})
    GROUP BY u.id
    ORDER BY (u.donor_code = ${code}) DESC NULLS LAST, lower(u.name), u.id
    LIMIT 40
  `;
  return json({
    donors: rows.map((u) => ({
      id: u.id, donorCode: u.donor_code, name: u.name, phone: u.phone, email: u.email,
      thisYear: u.this_year, total: u.total,
    })),
  });
}

// POST /api/admin/donors — create an account for someone at the desk.
export async function createDonor(request, env, session) {
  requireAdmin(session);
  const { fields, problem } = readDonorFields(await request.json());
  if (problem) return error(problem);

  const sql = db(env);
  if (fields.email) {
    const existing = await sql`SELECT id, donor_code, name FROM users WHERE lower(email) = lower(${fields.email}) ORDER BY id LIMIT 1`;
    if (existing.length) {
      return json({
        error: `${existing[0].name} (${existing[0].donor_code}) already uses that email address.`,
        existing: { id: existing[0].id, donorCode: existing[0].donor_code, name: existing[0].name },
      }, { status: 409 });
    }
  }

  // The account gets a login it can never guess. A donor with an email can
  // still get in later through "Forgot your login?".
  const username = await nextUsername(sql, fields.name.split(/\s+/).pop());
  const passwordHash = await hashPassword(generateShortPassword(32));
  const rows = await sql`
    INSERT INTO users (username, name, phone, email, address, city_state_zip, password_hash, created_by_admin)
    VALUES (${username}, ${fields.name}, ${fields.phone}, ${fields.email}, ${fields.address}, ${fields.cityStateZip}, ${passwordHash}, ${session.email})
    RETURNING id, donor_code, name, phone, email, address, city_state_zip
  `;
  return json({ ok: true, donor: DONOR_COLUMNS(rows[0]) });
}

async function loadDonor(sql, id) {
  const rows = await sql`SELECT id, donor_code, name, phone, email, address, city_state_zip FROM users WHERE id = ${id}`;
  if (!rows.length) throw error('Donor not found.', 404);
  return rows[0];
}

// GET /api/admin/donors/:id — the donor and everything they have brought.
export async function getDonor(request, env, session, id) {
  requireAdmin(session);
  const sql = db(env);
  const donor = await loadDonor(sql, id);
  const nativities = await sql`
    SELECT id, submission_number, event_year, status, piece_count, description, waiver_signed, waiver_method,
           COALESCE(display_photo_key, photo_key) AS photo_key
    FROM nativities
    WHERE owner_user_id = ${id} AND submission_number NOT LIKE 'DRAFT-%'
    ORDER BY event_year DESC, id
  `;
  return json({ donor: DONOR_COLUMNS(donor), nativities, eventYear: currentEventYear(), waiverBatch: WAIVER_BATCH });
}

// PATCH /api/admin/donors/:id — fix a name or add contact details.
export async function updateDonor(request, env, session, id) {
  requireAdmin(session);
  const { fields, problem } = readDonorFields(await request.json());
  if (problem) return error(problem);

  const sql = db(env);
  const cur = await loadDonor(sql, id);
  if (fields.email) {
    const taken = await sql`SELECT 1 FROM users WHERE lower(email) = lower(${fields.email}) AND id <> ${id} LIMIT 1`;
    if (taken.length) return error('Another account already uses that email address.', 409);
  }
  const same = (a, b) => String(a ?? '').trim() === String(b ?? '').trim();
  // The signed waiver shows name, phone, email and address.
  const waiverInfoChanged = !same(fields.name, cur.name) || !same(fields.phone, cur.phone)
    || String(fields.email ?? '').toLowerCase() !== String(cur.email ?? '').toLowerCase()
    || !same(fields.address, cur.address) || !same(fields.cityStateZip, cur.city_state_zip);

  const rows = await sql`
    UPDATE users
    SET name = ${fields.name}, phone = ${fields.phone}, email = ${fields.email},
        address = ${fields.address}, city_state_zip = ${fields.cityStateZip}
    WHERE id = ${id}
    RETURNING id, donor_code, name, phone, email, address, city_state_zip
  `;
  // Waivers already signed with the old details are cleared, same as when a
  // donor edits their own account. Unsigned desk paper waivers are untouched.
  const waiversCleared = waiverInfoChanged ? await resetWaiversForUser(env, id) : 0;
  return json({ ok: true, donor: DONOR_COLUMNS(rows[0]), waiversCleared });
}

// POST /api/admin/donors/:id/nativities — quick entry: a short description and
// a piece count. The pieces are listed as "<description> (1 of N)" and the waiver is set
// to a paper copy signed at the desk.
export async function addNativity(request, env, session, id) {
  requireAdmin(session);
  const body = await request.json();
  const description = clip(body?.description, 5000);
  const pieceCount = Number(body?.pieceCount);
  const condition = clip(body?.conditionNote, MAX_TEXT) || DEFAULT_CONDITION;
  if (!description) return error('Enter a short description so the nativity can be told apart.');
  if (!Number.isInteger(pieceCount) || pieceCount < 1 || pieceCount > MAX_PIECES) {
    return error(`Enter the number of pieces (1 to ${MAX_PIECES}).`);
  }

  // Pieces are not described one by one at the desk: each is listed under the
  // nativity's own description, e.g. "Olive wood set (2 of 5)".
  const pieceLabel = description.length > 80 ? description.slice(0, 77).trimEnd() + '...' : description;

  const sql = db(env);
  const donor = await loadDonor(sql, id);
  const eventYear = currentEventYear();
  const submissionNumber = await nextSubmissionNumber(sql, eventYear);
  const inserted = await sql`
    INSERT INTO nativities (submission_number, owner_user_id, event_year, description, piece_count, status,
                            include_in_tour, waiver_method, paper_by_admin)
    VALUES (${submissionNumber}, ${id}, ${eventYear}, ${description}, ${pieceCount}, 'pending',
            ${body?.includeInTour !== false}, 'paper', ${session.email})
    RETURNING id
  `;
  const nativityId = inserted[0].id;
  await sql`
    INSERT INTO nativity_pieces (nativity_id, piece_number, description, condition_notes)
    SELECT ${nativityId}::bigint, g, ${pieceLabel}::text || ' (' || g || ' of ' || ${pieceCount}::int || ')', ${condition}::text
    FROM generate_series(1, ${pieceCount}::int) AS g
  `;
  await writeAdminPaperChoice(env, {
    id: nativityId, owner_name: donor.name, owner_phone: donor.phone, owner_email: donor.email,
    owner_address: donor.address, owner_city_state_zip: donor.city_state_zip,
  }, session.email);

  return json({ ok: true, id: nativityId, submissionNumber });
}

// GET /api/admin/donors/:id/waivers-pdf?offset=0 — one print job holding the
// unsigned paper waivers for this donor (WAIVER_BATCH at a time).
export async function waiversPdf(request, env, session, id) {
  requireAdmin(session);
  const offset = Math.max(0, parseInt(new URL(request.url).searchParams.get('offset') || '0', 10) || 0);
  const sql = db(env);
  const rows = await sql`
    SELECT n.*, u.name AS owner_name, u.phone AS owner_phone, u.email AS owner_email,
           u.address AS owner_address, u.city_state_zip AS owner_city_state_zip, u.donor_code AS owner_donor_code
    FROM nativities n JOIN users u ON u.id = n.owner_user_id
    WHERE n.owner_user_id = ${id} AND n.status = 'pending' AND n.waiver_method = 'paper' AND NOT n.waiver_signed
    ORDER BY n.id
    LIMIT ${WAIVER_BATCH} OFFSET ${offset}
  `;
  if (!rows.length) return error('This donor has no paper waivers waiting to be signed.', 404);

  const ids = rows.map((n) => n.id);
  const [settings, pieceRows] = await Promise.all([
    getSiteSettings(env),
    sql`SELECT nativity_id, piece_number, description, condition_notes, photo_key
        FROM nativity_pieces WHERE nativity_id = ANY(${pgIdArray(ids)}::bigint[]) ORDER BY nativity_id, piece_number`,
  ]);

  const merged = await PDFDocument.create();
  for (const n of rows) {
    const paper = await paperChoice(env, n);
    if (!paper) continue;
    const pieces = pieceRows
      .filter((p) => String(p.nativity_id) === String(n.id))
      .map(({ piece_number, description, condition_notes, photo_key }) => ({ piece_number, description, condition_notes, photo_key }));
    const doc = await PDFDocument.load(await paperPdf(env, n, paper, {}, { settings, pieces }));
    for (const page of await merged.copyPages(doc, doc.getPageIndices())) merged.addPage(page);
  }
  if (!merged.getPageCount()) return error('This donor has no paper waivers waiting to be signed.', 404);

  const code = String(rows[0].owner_donor_code || 'donor').replace(/[^a-zA-Z0-9_-]/g, '');
  return new Response(await merged.save(), {
    headers: {
      'Content-Type': 'application/pdf',
      'Content-Disposition': `inline; filename="Stroll-to-the-Stable-Waivers-${code}.pdf"`,
      'Cache-Control': 'private, no-store',
    },
  });
}

// POST /api/admin/donors/:id/checkin-summary { ids } — one email listing what
// was just checked in. Does nothing for a donor with no email address.
export async function sendCheckInSummary(request, env, session, id) {
  requireAdmin(session);
  const body = await request.json().catch(() => ({}));
  const ids = (Array.isArray(body?.ids) ? body.ids : []).map((v) => String(v)).filter((v) => /^\d+$/.test(v)).slice(0, 200);
  if (!ids.length) return error('Nothing was checked in.');

  const sql = db(env);
  const donor = await loadDonor(sql, id);
  if (!donor.email) return json({ ok: true, emailSent: false, hasEmail: false });

  const nativities = await sql`
    SELECT submission_number, description, piece_count
    FROM nativities
    WHERE owner_user_id = ${id} AND status = 'submitted' AND id = ANY(${pgIdArray(ids)}::bigint[])
    ORDER BY id
  `;
  if (!nativities.length) return error('Nothing was checked in.');

  let emailSent = false;
  try {
    await sendDonorCheckInSummaryEmail(env, {
      to: donor.email, name: donor.name, donorCode: donor.donor_code, nativities,
      settings: await getSiteSettings(env),
    });
    emailSent = true;
  } catch (err) {
    console.error('Check-in summary email failed:', err);
  }
  return json({ ok: true, emailSent, hasEmail: true });
}
