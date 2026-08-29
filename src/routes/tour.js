import { db } from '../lib/db.js';
import { json } from '../lib/util.js';

const CACHE_TTL_SECONDS = 300; // 5 minutes — plenty fresh, keeps Neon load flat regardless of visitor count

// Public: no session required. Only submitted (checked-in, verified)
// nativities are shown, and only where the owner hasn't opted out.
export async function getTour(request, env) {
  const cache = caches.default;
  const cacheKey = new Request(new URL('/api/tour', request.url).toString(), request);
  const cached = await cache.match(cacheKey);
  if (cached) return cached;

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

  const response = json({ tour }, { headers: { 'Cache-Control': `public, max-age=${CACHE_TTL_SECONDS}` } });
  await cache.put(cacheKey, response.clone());
  return response;
}
