import { db } from '../lib/db.js';
import { json } from '../lib/util.js';
import { listTourMediaObjects, serializeTourMedia } from '../lib/tourMedia.js';
import { getSiteSettings } from '../lib/siteSettings.js';

// Public: no session required. The collection includes all nativities that
// have been checked in at least once and are still marked for the public tour,
// plus standalone artwork, photos, and videos uploaded by admins.
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
      SELECT id, submission_number, event_year, COALESCE(display_photo_key, photo_key) AS photo_key, story
      FROM nativities
      WHERE status IN ('submitted', 'returned') AND include_in_tour = TRUE
      ORDER BY event_year DESC, id
    `,
    listTourMediaObjects(env),
  ]);

  const nativityItems = nativities.map((n) => ({
    type: 'nativity',
    id: n.id,
    submissionNumber: n.submission_number,
    eventYear: n.event_year,
    photoKey: n.photo_key,
    story: n.story,
  }));

  const mediaItems = mediaObjects.map(serializeTourMedia);
  const tour = [...nativityItems, ...mediaItems];

  return json(
    { tour, closed: !tourOpen },
    {
      headers: {
        'Cache-Control': 'no-store, max-age=0',
        Pragma: 'no-cache',
      },
    }
  );
}
