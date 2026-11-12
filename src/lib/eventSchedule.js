// Public event dates and hours, set by admins on the scheduling page
// (settings.eventDays: [{ date: 'YYYY-MM-DD', available, start: 'HH:MM', end }]).

const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

export function openEventDays(settings) {
  return (Array.isArray(settings?.eventDays) ? settings.eventDays : [])
    .filter((d) => d && d.available !== false && /^\d{4}-\d{2}-\d{2}$/.test(d.date) && d.start && d.end)
    .sort((a, b) => a.date.localeCompare(b.date));
}

const parts = (key) => key.split('-').map(Number);
const weekday = (key) => { const [y, m, d] = parts(key); return new Date(Date.UTC(y, m - 1, d)).getUTCDay(); };

export function formatTime(hhmm) {
  const [h, m] = String(hhmm).split(':').map(Number);
  return `${h % 12 || 12}:${String(m).padStart(2, '0')} ${h < 12 ? 'AM' : 'PM'}`;
}

// "November 27 – December 6, 2026"
export function dateRangeText(days) {
  if (!days.length) return '';
  const [y1, m1, d1] = parts(days[0].date);
  const [y2, m2, d2] = parts(days[days.length - 1].date);
  if (days.length === 1) return `${MONTHS[m1 - 1]} ${d1}, ${y1}`;
  const start = `${MONTHS[m1 - 1]} ${d1}${y1 !== y2 ? `, ${y1}` : ''}`;
  const end = m1 === m2 && y1 === y2 ? `${d2}, ${y2}` : `${MONTHS[m2 - 1]} ${d2}, ${y2}`;
  return `${start} – ${end}`;
}

// Hours grouped by weekday, Monday first, merging neighbouring days with the
// same hours: [{ label: 'Monday – Friday', hours: '12:00 PM – 9:00 PM' }, ...]
export function hoursByWeekday(days) {
  const byDay = new Map();
  for (const d of days) {
    const wd = weekday(d.date);
    const k = `${d.start}|${d.end}`;
    const counts = byDay.get(wd) || new Map();
    counts.set(k, (counts.get(k) || 0) + 1);
    byDay.set(wd, counts);
  }
  const order = [1, 2, 3, 4, 5, 6, 0];
  const groups = [];
  for (const wd of order) {
    const counts = byDay.get(wd);
    if (!counts) { groups.push(null); continue; }
    const hours = [...counts.entries()].sort((a, b) => b[1] - a[1])[0][0];
    const last = groups[groups.length - 1];
    if (last && last.hours === hours) last.days.push(wd);
    else groups.push({ hours, days: [wd] });
  }
  return groups.filter(Boolean).map((g) => {
    const [s, e] = g.hours.split('|');
    const first = WEEKDAYS[g.days[0]], lastDay = WEEKDAYS[g.days[g.days.length - 1]];
    const label = g.days.length === 1 ? first : g.days.length === 2 ? `${first} & ${lastDay}` : `${first} – ${lastDay}`;
    return { label, hours: `${formatTime(s)} – ${formatTime(e)}` };
  });
}

const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;' })[c]);

export function hoursCardsHtml(days) {
  const groups = hoursByWeekday(days);
  if (!groups.length) return '<p class="special-access">Hours will be announced soon.</p>';
  return groups.map((g) => `<div class="hours-card"><strong>${esc(g.label)}</strong><span>${esc(g.hours)}</span></div>`).join('');
}

export function hoursSentence(days) {
  const groups = hoursByWeekday(days);
  return groups.map((g) => `${g.label} ${g.hours}`).join('; ');
}
