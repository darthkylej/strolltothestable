import { db } from './db.js';

const PUBLIC_PAGES = new Set(['/', '/index.html', '/about', '/about.html', '/tour', '/tour.html']);
const BOT_PATTERN = /bot|crawler|spider|slurp|headless|lighthouse|preview|facebookexternalhit|whatsapp|telegram|discord|curl|wget|python-requests|uptime|monitor/i;

export function pageCategory(request, path) {
  if (!PUBLIC_PAGES.has(path)) return null;
  if (request.headers.get('Sec-Purpose')?.includes('prefetch') || request.headers.get('Purpose')?.includes('prefetch')) return null;
  if (BOT_PATTERN.test(request.headers.get('User-Agent') || '')) return null;
  return path === '/tour' || path === '/tour.html' ? 'tour' : 'site';
}

export async function recordPageView(env, category) {
  // Only aggregate counters are retained: no cookies, IPs, user agents, or visitor IDs.
  const sql = db(env);
  await sql`
    INSERT INTO page_view_daily (view_date, category, views)
    VALUES ((now() AT TIME ZONE 'America/Chicago')::date, ${category}, 1)
    ON CONFLICT (view_date, category)
    DO UPDATE SET views = page_view_daily.views + 1
  `;
}

export async function getPageViewStats(env) {
  const sql = db(env);
  const rows = await sql`
    SELECT to_char(view_date, 'YYYY-MM-DD') AS day, category, views
    FROM page_view_daily
    ORDER BY view_date DESC
  `;
  return rows;
}
