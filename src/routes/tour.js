import { db } from '../lib/db.js';
import { json } from '../lib/util.js';
import { listTourMediaObjects, serializeTourMedia } from '../lib/tourMedia.js';

// Public: no session required. The collection includes submitted nativities
// plus standalone artwork, photos, and videos uploaded by admins.
export async function getTour(request, env) {
  const sql = db(env);
  const [nativities, mediaObjects] = await Promise.all([
    sql`
      SELECT id, submission_number, event_year, COALESCE(display_photo_key, photo_key) AS photo_key, story
      FROM nativities
      WHERE status = 'submitted' AND include_in_tour = TRUE
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
    { tour },
    {
      headers: {
        'Cache-Control': 'no-store, max-age=0',
        Pragma: 'no-cache',
      },
    }
  );
}
