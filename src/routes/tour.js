import { db } from '../lib/db.js';
import { json } from '../lib/util.js';

// Public: no session required. Only submitted checked-in nativities are shown,
// and only where the owner has not opted out. This endpoint is intentionally
// uncached so admin changes are reflected on the very next tour refresh.
export async function getTour(request, env) {
  const sql = db(env);
  const nativities = await sql`
    SELECT id, submission_number, event_year, COALESCE(display_photo_key, photo_key) AS photo_key, story
    FROM nativities
    WHERE status = 'submitted' AND include_in_tour = TRUE
    ORDER BY event_year DESC, id
  `;

  const tour = nativities.map((n) => ({
    id: n.id,
    submissionNumber: n.submission_number,
    eventYear: n.event_year,
    photoKey: n.photo_key,
    story: n.story,
  }));

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
