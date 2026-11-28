import { db } from '../lib/db.js';
import { json, error, requireAdmin } from '../lib/util.js';
import { listTourMediaObjects, serializeTourMedia } from '../lib/tourMedia.js';
import { getSiteSettings } from '../lib/siteSettings.js';

// Public: no session required. Every nativity that has been checked in is
// shown, except ones an admin took off the Scroll because they need a better
// photo (needs_better_photo). Admins see those too, marked, so they can put
// them back. Plus standalone artwork, photos, and videos uploaded by admins.
export async function getTour(request, env, session) {
  // When an admin switches the tour off, visitors get nothing. Admins still
  // see the full tour (flagged as closed) so they can check it before opening.
  const noStore = { 'Cache-Control': 'no-store, max-age=0', Pragma: 'no-cache' };
  const { tourOpen } = await getSiteSettings(env);
  const isAdmin = session?.kind === 'admin';
  if (!tourOpen && !isAdmin) return json({ tour: [], closed: true }, { headers: noStore });

  const sql = db(env);
  const [nativities, mediaObjects] = await Promise.all([
    sql`
      SELECT id, submission_number, event_year, COALESCE(display_photo_key, photo_key) AS photo_key, story,
             needs_better_photo
      FROM nativities
      WHERE status IN ('submitted', 'returned')
        AND (${isAdmin}::boolean OR needs_better_photo = FALSE)
      ORDER BY event_year DESC, id
    `,
    listTourMediaObjects(env),
  ]);

  const nativityItems = nativities.map((n) => {
    const item = {
      type: 'nativity',
      id: n.id,
      submissionNumber: n.submission_number,
      eventYear: n.event_year,
      photoKey: n.photo_key,
      story: n.story,
    };
    if (isAdmin) item.needsBetterPhoto = !!n.needs_better_photo;
    return item;
  });

  const mediaItems = mediaObjects.map(serializeTourMedia);
  const tour = [...nativityItems, ...mediaItems];

  const body = { tour, closed: !tourOpen };
  if (isAdmin) body.isAdmin = true;
  return json(body, { headers: noStore });
}

// Admin: take a nativity off the Scroll and mark it as needing a better
// photo, or put it back. Status is not touched.
export async function setNeedsBetterPhoto(request, env, session, id) {
  const admin = requireAdmin(session);
  const body = await request.json().catch(() => ({}));
  if (typeof body?.needsBetterPhoto !== 'boolean') return error('Invalid setting.');
  const flag = body.needsBetterPhoto;
  const sql = db(env);
  const rows = await sql`
    UPDATE nativities
    SET needs_better_photo = ${flag}::boolean,
        needs_better_photo_by = ${flag ? admin.email || '' : null}::text,
        needs_better_photo_at = CASE WHEN ${flag}::boolean THEN now() ELSE NULL END,
        updated_at = now()
    WHERE id = ${id}
    RETURNING id, submission_number, needs_better_photo`;
  if (!rows.length) return error('Nativity not found.', 404);
  return json({ ok: true, id: rows[0].id, submissionNumber: rows[0].submission_number, needsBetterPhoto: rows[0].needs_better_photo });
}
