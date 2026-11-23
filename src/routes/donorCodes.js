// Admin fix for mislabeled donor codes. Nativities are labeled with their
// donor's code so they can be grouped and returned per donor, and a label
// put on the wrong pile means a donor's code has to change.
//
// Codes must stay unique, so a change to a code another donor already holds
// can only go through together with a new code for that donor, and so on
// down the chain ("A takes B's code, B takes C's code, C takes A's old one").
// The page builds that chain one step at a time with /check and then saves
// the whole chain at once with /apply, in one transaction.
import { db } from '../lib/db.js';
import { json, error, requireAdmin } from '../lib/util.js';
import { normalizeDonorCode } from './admin.js';
import { getAdminNote, setAdminNote } from '../lib/siteSettings.js';

const MAX_CHANGES = 20;
const MIN_CODE = 1001;
const MAX_CODE = 9999;

// Codes are always "D-" and four digits (D-1001 ... D-9999).
export function cleanDonorCode(value) {
  const code = normalizeDonorCode(value);
  if (!code || !/^D-\d{4}$/.test(code)) return null;
  const n = Number(code.slice(2));
  return n >= MIN_CODE && n <= MAX_CODE ? code : null;
}

const codeArray = (codes) => `{${codes.map((c) => (c == null ? 'NULL' : `"${c}"`)).join(',')}}`;
const idArray = (ids) => `{${ids.join(',')}}`;

// Reads { changes: [{ donorId, from, to }] } and checks it against the
// database. Returns { changes, conflicts } or { problem, status }.
// conflicts lists every donor outside the chain who already holds one of the
// new codes; an empty list means the chain can be saved.
async function readChanges(sql, body) {
  const raw = Array.isArray(body?.changes) ? body.changes : [];
  if (!raw.length) return { problem: 'Nothing to change.' };
  if (raw.length > MAX_CHANGES) return { problem: `Change at most ${MAX_CHANGES} donor IDs at once.` };

  const changes = [];
  for (const c of raw) {
    const donorId = String(c?.donorId ?? '');
    if (!/^\d{1,12}$/.test(donorId)) return { problem: 'One of the donors was not recognized.' };
    const to = cleanDonorCode(c?.to);
    if (!to) return { problem: `"${String(c?.to ?? '').slice(0, 20)}" is not a donor ID. Use D- and four digits, like D-1012.` };
    const from = c?.from == null || c.from === '' ? null : String(c.from);
    changes.push({ donorId, from, to });
  }
  if (new Set(changes.map((c) => c.donorId)).size !== changes.length) return { problem: 'The same donor is listed twice.' };
  if (new Set(changes.map((c) => c.to)).size !== changes.length) return { problem: 'Two donors would get the same ID.' };

  const ids = changes.map((c) => c.donorId);
  const rows = await sql`SELECT id, name, donor_code FROM users WHERE id = ANY(${idArray(ids)}::bigint[])`;
  const byId = new Map(rows.map((r) => [String(r.id), r]));
  for (const c of changes) {
    const cur = byId.get(c.donorId);
    if (!cur) return { problem: 'One of the donors was not found.', status: 404 };
    // The page sends the code it showed; if it differs, someone else changed it.
    if ((cur.donor_code ?? null) !== c.from) {
      return { problem: `${cur.name}'s ID is now ${cur.donor_code || 'blank'}. Reload the page and start again.`, status: 409 };
    }
    if (c.to === c.from) return { problem: `${c.to} is already ${cur.name}'s ID.` };
    c.name = cur.name;
  }

  // Codes held by donors outside the chain. Codes held by donors in the chain
  // are being given up, so they are free to reuse (a swap).
  const holders = await sql`
    SELECT id, name, donor_code FROM users
    WHERE donor_code = ANY(${codeArray(changes.map((c) => c.to))}::text[])
      AND NOT (id = ANY(${idArray(ids)}::bigint[]))
    ORDER BY id
  `;
  const conflicts = holders.map((u) => ({ code: u.donor_code, donor: { id: String(u.id), name: u.name, donorCode: u.donor_code } }));
  return { changes, conflicts };
}

// POST /api/admin/donor-codes/check { changes } — what still needs a new ID.
export async function check(request, env, session) {
  requireAdmin(session);
  const sql = db(env);
  const r = await readChanges(sql, await request.json());
  if (r.problem) return error(r.problem, r.status || 400);
  return json({ ok: true, conflicts: r.conflicts });
}

// POST /api/admin/donor-codes/apply { changes } — saves the whole chain.
export async function apply(request, env, session) {
  requireAdmin(session);
  const sql = db(env);
  const r = await readChanges(sql, await request.json());
  if (r.problem) return error(r.problem, r.status || 400);
  if (r.conflicts.length) {
    const c = r.conflicts[0];
    return json({ error: `${c.code} already belongs to ${c.donor.name}. Give ${c.donor.name} a new ID too.`, conflicts: r.conflicts }, { status: 409 });
  }

  const { changes } = r;
  const ids = idArray(changes.map((c) => c.donorId));
  const olds = codeArray(changes.map((c) => c.from));
  const news = codeArray(changes.map((c) => c.to));
  let results;
  try {
    results = await sql.transaction([
      // Stops the whole save (division by zero) if any donor's code changed
      // since it was checked. Locks the rows until the save finishes.
      sql`SELECT 1 / (CASE WHEN count(*) = ${changes.length}::int THEN 1 ELSE 0 END) AS ok
          FROM (SELECT u.id FROM users u
                JOIN unnest(${ids}::bigint[], ${olds}::text[]) AS v(id, old)
                  ON u.id = v.id AND u.donor_code IS NOT DISTINCT FROM v.old
                FOR UPDATE OF u) s`,
      // Clear first, then set, so a swap never holds the same code twice.
      sql`UPDATE users SET donor_code = NULL WHERE id = ANY(${ids}::bigint[])`,
      sql`UPDATE users u SET donor_code = v.code
          FROM unnest(${ids}::bigint[], ${news}::text[]) AS v(id, code)
          WHERE u.id = v.id
          RETURNING u.id, u.name, u.donor_code`,
    ]);
  } catch (err) {
    if (err?.code === '22012') return error('A donor ID changed while you were working. Reload the page and start again.', 409);
    if (err?.code === '23505') return error('One of the new IDs was just taken. Reload the page and start again.', 409);
    throw err;
  }
  const saved = results[2];
  console.log('Donor codes changed by', session.email, JSON.stringify(changes.map((c) => ({ id: c.donorId, from: c.from, to: c.to }))));
  const notesFailed = await noteOldCodes(env, sql, changes, session.email);
  return json({
    ok: true,
    notesFailed,
    changed: changes.map((c) => ({ donorId: c.donorId, name: c.name, from: c.from, to: c.to })),
    saved: saved.map((u) => ({ id: String(u.id), name: u.name, donorCode: u.donor_code })),
  });
}

// The new code is used everywhere, but the old one is kept as a line added to
// the private admin note of each of the donor's nativities, so the old code
// can still be traced. Existing notes are kept; later changes add
// more lines, so the note holds the whole history. Returns how many notes
// could not be written (the code change itself is already saved).
async function noteOldCodes(env, sql, changes, adminEmail) {
  const day = new Date().toLocaleDateString('en-US', { timeZone: 'America/Chicago', month: 'short', day: 'numeric', year: 'numeric' });
  const rows = await sql`
    SELECT id, owner_user_id FROM nativities
    WHERE owner_user_id = ANY(${idArray(changes.map((c) => c.donorId))}::bigint[])
      AND submission_number NOT LIKE 'DRAFT-%'
  `;
  let failed = 0;
  for (const n of rows) {
    const c = changes.find((x) => x.donorId === String(n.owner_user_id));
    const line = `Donor ID changed from ${c.from || 'no ID'} to ${c.to} on ${day} by ${adminEmail}.`;
    try {
      const cur = (await getAdminNote(env, n.id)).trim();
      await setAdminNote(env, n.id, cur ? `${cur}\n${line}` : line, adminEmail);
    } catch (err) {
      failed++;
      console.error('Could not add donor ID note to nativity', n.id, err);
    }
  }
  return failed;
}
