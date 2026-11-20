// TEMPORARY one-off admin tool: copy each donor's address from the waivers they
// filled in (signed, draft or paper-choice files in the photo bucket) onto their
// account, because the account itself never stored one. Remove once it has run.
//
// GET  /api/admin/backfill-addresses?after=0&limit=3  — preview, changes nothing
// POST /api/admin/backfill-addresses?after=0&limit=3  — fill empty address columns
//
// Both walk the donors in id order, a few at a time (each waiver is a storage
// lookup, and a Worker request can only make so many). `next` is the cursor for
// the following batch; `done` is true when there are no more donors.
import { db } from '../lib/db.js';
import { json, requireAdmin } from '../lib/util.js';

const blank = (v) => !String(v ?? '').trim();
const clean = (v) => String(v ?? '').trim().slice(0, 200);
const norm = (c) => `${c.address}|${c.cityStateZip}`.toLowerCase().replace(/[^a-z0-9|]+/g, ' ').replace(/\s+/g, ' ').trim();

async function readJson(env, key) {
  const object = await env.PHOTOS.get(key);
  if (!object) return null;
  try { return JSON.parse(await object.text()); } catch { return null; }
}

// Signed waiver first, then an unsigned draft, then a paper choice.
async function waiverCandidate(env, n) {
  const signed = await readJson(env, `_waivers/${n.id}.json`);
  if (signed?.fields) {
    return { source: 'signed waiver', at: signed.completedAt || signed.audit?.signedAt || '', fields: signed.fields };
  }
  const draft = await readJson(env, `_waivers/${n.id}-draft.json`);
  if (draft?.fields) return { source: 'waiver draft', at: draft.updatedAt || '', fields: draft.fields };
  const paper = await readJson(env, `_waivers/${n.id}-paper.json`);
  if (paper?.fields) return { source: 'paper choice', at: paper.requestedAt || '', fields: paper.fields };
  return null;
}

export async function run(request, env, session, apply) {
  requireAdmin(session);
  const params = new URL(request.url).searchParams;
  const after = Math.max(0, parseInt(params.get('after') || '0', 10) || 0);
  const limit = Math.min(8, Math.max(1, parseInt(params.get('limit') || '3', 10) || 3));
  const sql = db(env);

  // Only accounts missing an address or city/state/ZIP are looked at.
  const users = await sql`
    SELECT id, name, address, city_state_zip FROM users
    WHERE id > ${after}
      AND (COALESCE(btrim(address), '') = '' OR COALESCE(btrim(city_state_zip), '') = '')
    ORDER BY id LIMIT ${limit}
  `;
  const out = [];
  if (users.length) {
    const ids = `{${users.map((u) => parseInt(u.id, 10)).join(',')}}`;
    const nativities = await sql`
      SELECT id, owner_user_id, submission_number FROM nativities
      WHERE owner_user_id = ANY(${ids}::bigint[]) ORDER BY id
    `;
    for (const u of users) {
      const found = [];
      for (const n of nativities.filter((x) => String(x.owner_user_id) === String(u.id))) {
        const c = await waiverCandidate(env, n);
        if (!c) continue;
        const address = clean(c.fields.address);
        const cityStateZip = clean(c.fields.cityStateZip);
        if (!address && !cityStateZip) continue;
        found.push({ address, cityStateZip, source: c.source, submission: n.submission_number, at: c.at });
      }
      // Newest first; a waiver with both parts beats one with only one.
      found.sort((a, b) => String(b.at).localeCompare(String(a.at)));
      const chosen = found.find((c) => c.address && c.cityStateZip) || found[0] || null;
      const distinct = new Set(found.map(norm)).size;

      const fill = {
        address: chosen && blank(u.address) && chosen.address ? chosen.address : null,
        cityStateZip: chosen && blank(u.city_state_zip) && chosen.cityStateZip ? chosen.cityStateZip : null,
      };
      let applied = false;
      if (apply && (fill.address || fill.cityStateZip)) {
        // Fills only columns that are still empty at the moment of the update.
        const rows = await sql`
          UPDATE users SET
            address = CASE WHEN COALESCE(btrim(address), '') = '' THEN COALESCE(${fill.address}::text, address) ELSE address END,
            city_state_zip = CASE WHEN COALESCE(btrim(city_state_zip), '') = '' THEN COALESCE(${fill.cityStateZip}::text, city_state_zip) ELSE city_state_zip END
          WHERE id = ${u.id} RETURNING id
        `;
        applied = rows.length > 0;
      }
      out.push({
        id: u.id, name: u.name,
        hadAddress: !blank(u.address), hadCityStateZip: !blank(u.city_state_zip),
        candidates: found.length, conflict: distinct > 1,
        chosen: chosen && { address: chosen.address, cityStateZip: chosen.cityStateZip, source: chosen.source, submission: chosen.submission },
        others: distinct > 1 ? found.filter((c) => norm(c) !== norm(chosen)).slice(0, 4).map(({ address, cityStateZip, source, submission }) => ({ address, cityStateZip, source, submission })) : [],
        fill, applied,
      });
    }
  }
  const next = users.length ? users[users.length - 1].id : after;
  return json({ ok: true, apply, users: out, next, done: users.length < limit });
}
