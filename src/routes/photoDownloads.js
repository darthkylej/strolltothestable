import { db } from '../lib/db.js';
import { error, requireUser, requireAdmin } from '../lib/util.js';

// Photo downloads.
// Donors may download only the photos on nativities they own. Admins may
// download any nativity's photos. Each photo is sent as a file attachment
// with a readable name, and "all" bundles every photo into one zip.

const EXT_BY_TYPE = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/gif': 'gif' };

function safeName(value) {
  return String(value || '').replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'nativity';
}

function baseLabel(n) {
  return String(n.submission_number || '').startsWith('DRAFT') ? `nativity-${n.id}` : safeName(n.submission_number);
}

function extFor(key, contentType) {
  const fromType = EXT_BY_TYPE[String(contentType || '').toLowerCase()];
  if (fromType) return fromType;
  const m = /\.(jpg|jpeg|png|webp|gif)$/i.exec(key || '');
  return m ? m[1].toLowerCase().replace('jpeg', 'jpg') : 'jpg';
}

function pad(num) {
  return String(num).padStart(2, '0');
}

// The list of photos a nativity has, each with the base of its download name.
function photoList(n, pieces, { includeDisplay }) {
  const label = baseLabel(n);
  const list = [];
  if (n.photo_key) list.push({ which: 'main', key: n.photo_key, name: `${label}-photo` });
  if (includeDisplay && n.display_photo_key) list.push({ which: 'display', key: n.display_photo_key, name: `${label}-tour-photo` });
  for (const p of pieces) {
    if (p.photo_key) list.push({ which: `piece-${p.id}`, key: p.photo_key, name: `${label}-piece-${pad(p.piece_number)}` });
  }
  return list;
}

function contentDisposition(filename) {
  return `attachment; filename="${filename}"; filename*=UTF-8''${encodeURIComponent(filename)}`;
}

async function sendOne(env, photo) {
  // Keys beginning with an underscore are internal app data, never photos.
  if (!photo || !photo.key || photo.key.startsWith('_')) return error('Photo not found.', 404);
  const obj = await env.PHOTOS.get(photo.key);
  if (!obj) return error('Photo not found.', 404);
  const type = String(obj.httpMetadata?.contentType || '').toLowerCase();
  const filename = `${photo.name}.${extFor(photo.key, type)}`;
  return new Response(obj.body, {
    headers: {
      'Content-Type': EXT_BY_TYPE[type] ? type : 'application/octet-stream',
      'Content-Disposition': contentDisposition(filename),
      'Content-Length': String(obj.size),
      'X-Content-Type-Options': 'nosniff',
      'Content-Security-Policy': "default-src 'none'; sandbox",
      'Cache-Control': 'private, no-store',
    },
  });
}

// ---- Minimal zip writer (stored, no compression: photos are already compressed).

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[i] = c >>> 0;
  }
  return t;
})();

function crc32(bytes) {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function dosTimeDate(d) {
  const time = (d.getHours() << 11) | (d.getMinutes() << 5) | Math.floor(d.getSeconds() / 2);
  const date = ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
  return { time, date };
}

export function buildZip(files, now = new Date()) {
  const enc = new TextEncoder();
  const { time, date } = dosTimeDate(now);
  const parts = [];
  const central = [];
  let offset = 0;
  for (const f of files) {
    const name = enc.encode(f.name);
    const crc = crc32(f.bytes);
    const size = f.bytes.length;
    const local = new DataView(new ArrayBuffer(30));
    local.setUint32(0, 0x04034b50, true);
    local.setUint16(4, 20, true);
    local.setUint16(6, 0x0800, true); // UTF-8 names
    local.setUint16(8, 0, true); // stored
    local.setUint16(10, time, true);
    local.setUint16(12, date, true);
    local.setUint32(14, crc, true);
    local.setUint32(18, size, true);
    local.setUint32(22, size, true);
    local.setUint16(26, name.length, true);
    local.setUint16(28, 0, true);
    parts.push(new Uint8Array(local.buffer), name, f.bytes);

    const cd = new DataView(new ArrayBuffer(46));
    cd.setUint32(0, 0x02014b50, true);
    cd.setUint16(4, 20, true);
    cd.setUint16(6, 20, true);
    cd.setUint16(8, 0x0800, true);
    cd.setUint16(10, 0, true);
    cd.setUint16(12, time, true);
    cd.setUint16(14, date, true);
    cd.setUint32(16, crc, true);
    cd.setUint32(20, size, true);
    cd.setUint32(24, size, true);
    cd.setUint16(28, name.length, true);
    cd.setUint32(42, offset, true);
    central.push(new Uint8Array(cd.buffer), name);
    offset += 30 + name.length + size;
  }
  const cdSize = central.reduce((s, p) => s + p.length, 0);
  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true);
  end.setUint16(8, files.length, true);
  end.setUint16(10, files.length, true);
  end.setUint32(12, cdSize, true);
  end.setUint32(16, offset, true);
  const all = [...parts, ...central, new Uint8Array(end.buffer)];
  const out = new Uint8Array(all.reduce((s, p) => s + p.length, 0));
  let at = 0;
  for (const p of all) { out.set(p, at); at += p.length; }
  return out;
}

async function sendAll(env, n, photos) {
  const seen = new Set();
  const files = [];
  for (const photo of photos) {
    if (!photo.key || photo.key.startsWith('_') || seen.has(photo.key)) continue;
    seen.add(photo.key);
    const obj = await env.PHOTOS.get(photo.key);
    if (!obj) continue;
    const bytes = new Uint8Array(await obj.arrayBuffer());
    files.push({ name: `${photo.name}.${extFor(photo.key, obj.httpMetadata?.contentType)}`, bytes });
  }
  if (!files.length) return error('There are no photos to download.', 404);
  const zip = buildZip(files);
  return new Response(zip, {
    headers: {
      'Content-Type': 'application/zip',
      'Content-Disposition': contentDisposition(`${baseLabel(n)}-photos.zip`),
      'Content-Length': String(zip.length),
      'Cache-Control': 'private, no-store',
    },
  });
}

async function respond(env, n, pieces, which, opts) {
  const photos = photoList(n, pieces, opts);
  if (which === 'all') return sendAll(env, n, photos);
  return sendOne(env, photos.find((p) => p.which === which));
}

// GET /api/nativities/:id/photo-download/:which  (which = main | piece-<pieceId> | all)
export async function donorDownload(request, env, session, id, which) {
  requireUser(session);
  const sql = db(env);
  const rows = await sql`SELECT id, submission_number, photo_key FROM nativities WHERE id = ${id} AND owner_user_id = ${session.userId}`;
  if (!rows.length) return error('Nativity not found.', 404);
  const pieces = await sql`SELECT id, piece_number, photo_key FROM nativity_pieces WHERE nativity_id = ${id} ORDER BY piece_number`;
  return respond(env, rows[0], pieces, which, { includeDisplay: false });
}

// GET /api/admin/nativities/:id/photo-download/:which  (which = main | display | piece-<pieceId> | all)
export async function adminDownload(request, env, session, id, which) {
  requireAdmin(session);
  const sql = db(env);
  const rows = await sql`SELECT id, submission_number, photo_key, display_photo_key FROM nativities WHERE id = ${id}`;
  if (!rows.length) return error('Not found.', 404);
  const pieces = await sql`SELECT id, piece_number, photo_key FROM nativity_pieces WHERE nativity_id = ${id} ORDER BY piece_number`;
  return respond(env, rows[0], pieces, which, { includeDisplay: true });
}
