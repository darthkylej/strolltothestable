// Get Involved page: people leave their contact details and what they'd like
// to help with, so admins can reach out when planning next year's event.
import { db } from '../lib/db.js';
import { json, error, requireAdmin } from '../lib/util.js';
import { consume, clientIp } from '../lib/rateLimit.js';

// Keys are stored; labels are what admins see.
export const HELP_AREAS = {
  build: 'Build and set up',
  checkin: 'Nativity check-in and check-out',
  event_host: 'Hosting during the event',
  nativities: 'Lending nativities',
};

const EMAIL_PATTERN = /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/;

let ensured = null;
export function ensureVolunteerSchema(env) {
  if (!ensured) {
    const sql = db(env);
    ensured = (async () => {
      await sql`
        CREATE TABLE IF NOT EXISTS volunteer_interest (
          id BIGSERIAL PRIMARY KEY,
          name TEXT NOT NULL,
          email TEXT NOT NULL DEFAULT '',
          phone TEXT NOT NULL DEFAULT '',
          help_areas TEXT[] NOT NULL DEFAULT '{}',
          note TEXT NOT NULL DEFAULT '',
          created_at TIMESTAMPTZ NOT NULL DEFAULT now()
        )
      `;
      await sql`CREATE INDEX IF NOT EXISTS idx_volunteer_interest_created ON volunteer_interest (created_at DESC)`;
    })().catch((err) => { ensured = null; throw err; });
  }
  return ensured;
}

export async function submitInterest(request, env) {
  const body = await request.json();
  // Honeypot: a hidden field people never fill in. Pretend it worked.
  if (String(body.website || '').trim()) return json({ ok: true });

  const name = String(body.name || '').trim().replace(/\s+/g, ' ');
  const email = String(body.email || '').trim().toLowerCase();
  const phone = String(body.phone || '').trim().replace(/\s+/g, ' ');
  const note = String(body.note || '').trim();
  // 'hosting' was an earlier, duplicate option; count it as hosting during the event.
  const areas = [...new Set((Array.isArray(body.helpAreas) ? body.helpAreas : []).map(String).map((k) => (k === 'hosting' ? 'event_host' : k)))]
    .filter((key) => Object.hasOwn(HELP_AREAS, key));

  if (!name) return error('Please enter your name.');
  if (name.length > 100) return error('Please keep your name under 100 characters.');
  if (!email && !phone) return error('Please enter an email address or a phone number so we can reach you.');
  if (email && (email.length > 200 || !EMAIL_PATTERN.test(email))) return error('Please check your email address.');
  if (phone && (phone.length > 40 || (phone.match(/\d/g) || []).length < 7)) return error('Please check your phone number.');
  if (note.length > 2000) return error('Please keep your note under 2,000 characters.');
  if (!areas.length && !note) return error('Please pick at least one way you would like to help, or leave a note.');

  const sql = db(env);
  if (!(await consume(sql, `get-involved:${clientIp(request)}`, 5, 3600))) {
    return error('Thanks! We have received several sign-ups from you recently. Please try again later.', 429);
  }

  await ensureVolunteerSchema(env);
  await sql`
    INSERT INTO volunteer_interest (name, email, phone, help_areas, note)
    VALUES (${name}, ${email}, ${phone}, ${areas}, ${note})
  `;
  return json({ ok: true });
}

export async function listInterest(request, env, session) {
  requireAdmin(session);
  await ensureVolunteerSchema(env);
  const sql = db(env);
  const rows = await sql`
    SELECT id, name, email, phone, help_areas, note, created_at
    FROM volunteer_interest
    ORDER BY created_at DESC, id DESC
  `;
  return json({ entries: rows, areas: HELP_AREAS });
}

function csvCell(value) {
  let text = String(value ?? '');
  // Keep spreadsheet apps from treating a typed value as a formula.
  if (/^[=+\-@\t\r]/.test(text)) text = "'" + text;
  return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

export async function exportInterestCsv(request, env, session) {
  requireAdmin(session);
  await ensureVolunteerSchema(env);
  const sql = db(env);
  const rows = await sql`
    SELECT name, email, phone, help_areas, note,
           to_char(created_at AT TIME ZONE 'America/Chicago', 'YYYY-MM-DD HH24:MI') AS signed_up
    FROM volunteer_interest
    ORDER BY created_at, id
  `;
  const header = ['Signed up', 'Name', 'Email', 'Phone', ...Object.values(HELP_AREAS), 'Note'];
  const lines = [header.map(csvCell).join(',')];
  for (const r of rows) {
    const areas = new Set(r.help_areas || []);
    lines.push([
      r.signed_up, r.name, r.email, r.phone,
      ...Object.keys(HELP_AREAS).map((key) => (areas.has(key) ? 'Yes' : '')),
      r.note,
    ].map(csvCell).join(','));
  }
  return new Response('﻿' + lines.join('\r\n') + '\r\n', {
    headers: {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': 'attachment; filename="stroll-volunteer-interest.csv"',
      'Cache-Control': 'no-store',
    },
  });
}

export async function deleteInterest(request, env, session, id) {
  requireAdmin(session);
  await ensureVolunteerSchema(env);
  const sql = db(env);
  const rows = await sql`DELETE FROM volunteer_interest WHERE id = ${id} RETURNING id`;
  if (!rows.length) return error('Entry not found.', 404);
  return json({ ok: true });
}
