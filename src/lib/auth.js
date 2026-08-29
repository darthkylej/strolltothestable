// All crypto here uses the platform Web Crypto API — no npm crypto deps,
// so it runs the same in `wrangler dev` and in production.

const PASSWORD_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no 0/O/1/I to avoid confusion
const enc = new TextEncoder();

// ── Password hashing (PBKDF2, salted) ──────────────────────────────────
export async function hashPassword(password) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const hash = await pbkdf2(password, salt);
  return `${bufToHex(salt)}:${bufToHex(hash)}`;
}

export async function verifyPassword(password, stored) {
  const [saltHex, hashHex] = stored.split(':');
  const salt = hexToBuf(saltHex);
  const hash = await pbkdf2(password, salt);
  return bufToHex(hash) === hashHex;
}

async function pbkdf2(password, salt) {
  const key = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt, iterations: 100000, hash: 'SHA-256' },
    key,
    256
  );
  return new Uint8Array(bits);
}

// ── Signed session cookies ──────────────────────────────────────────────
// Payload is a small JSON blob (e.g. { kind: 'user', userId: 7 } or
// { kind: 'admin', email: '...' }) plus an expiry, HMAC-signed so it can't
// be forged or edited client-side. No session table needed.
const TWO_WEEKS_MS = 14 * 24 * 60 * 60 * 1000;

export async function createSessionToken(env, payload, ttlMs = TWO_WEEKS_MS) {
  const body = { ...payload, exp: Date.now() + ttlMs };
  const bodyB64 = base64url(JSON.stringify(body));
  const sig = await hmacSign(env, bodyB64);
  return `${bodyB64}.${sig}`;
}

export async function verifySessionToken(env, token) {
  if (!token) return null;
  const [bodyB64, sig] = token.split('.');
  if (!bodyB64 || !sig) return null;
  const expectedSig = await hmacSign(env, bodyB64);
  if (sig !== expectedSig) return null;
  const body = JSON.parse(atob(bodyB64.replace(/-/g, '+').replace(/_/g, '/')));
  if (Date.now() > body.exp) return null;
  return body;
}

async function hmacSign(env, data) {
  const key = await crypto.subtle.importKey(
    'raw', enc.encode(env.SESSION_SECRET), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']
  );
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(data));
  return bufToHex(new Uint8Array(sig));
}

function base64url(str) {
  return btoa(str).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

// Reads the session cookie from a request and verifies it.
// Returns { kind: 'user', userId } | { kind: 'admin', email } | null
export async function getSession(request, env) {
  const cookie = request.headers.get('Cookie') || '';
  const match = cookie.match(/session=([^;]+)/);
  if (!match) return null;
  return verifySessionToken(env, decodeURIComponent(match[1]));
}

export function sessionCookieHeader(token, { clear = false } = {}) {
  const maxAge = clear ? 0 : TWO_WEEKS_MS / 1000;
  const value = clear ? '' : token;
  return `session=${value}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=${maxAge}`;
}

// ── One-time passwords (admin login) ────────────────────────────────────
export function generateOtp() {
  // 6-digit numeric code, easy to type from an email on a phone.
  return String(crypto.getRandomValues(new Uint32Array(1))[0] % 1000000).padStart(6, '0');
}

export async function hashOtp(code) {
  const digest = await crypto.subtle.digest('SHA-256', enc.encode(code));
  return bufToHex(new Uint8Array(digest));
}

// ── Random short password for new users ─────────────────────────────────
export function generateShortPassword(length = 5) {
  const bytes = crypto.getRandomValues(new Uint8Array(length));
  return Array.from(bytes, (b) => PASSWORD_CHARS[b % PASSWORD_CHARS.length]).join('');
}

// ── Username generation: lastname + incrementing digit ───────────────────
// Uses an UPDATE ... RETURNING against username_sequences so two people
// registering with the same last name at the same instant still get
// distinct, gapless-enough numbers (Postgres serializes the row lock).
export async function nextUsername(sql, lastName) {
  const key = normalizeLastName(lastName);
  const rows = await sql`
    INSERT INTO username_sequences (last_name_key, next_seq)
    VALUES (${key}, 2)
    ON CONFLICT (last_name_key)
    DO UPDATE SET next_seq = username_sequences.next_seq + 1
    RETURNING next_seq - 1 AS seq
  `;
  const seq = rows[0].seq;
  return `${key}${seq}`;
}

function normalizeLastName(lastName) {
  // Strips anything but letters so "O'Brien" -> "obrien", "García" stays readable.
  return lastName
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '') // strip accents
    .toLowerCase()
    .replace(/[^a-z]/g, '') || 'user';
}

// ── Human-readable submission numbers, per event year ────────────────────
export async function nextSubmissionNumber(sql, eventYear) {
  const rows = await sql`
    INSERT INTO submission_number_sequences (event_year, next_seq)
    VALUES (${eventYear}, 2)
    ON CONFLICT (event_year)
    DO UPDATE SET next_seq = submission_number_sequences.next_seq + 1
    RETURNING next_seq - 1 AS seq
  `;
  const seq = String(rows[0].seq).padStart(4, '0');
  return `STS-${eventYear}-${seq}`;
}

// ── helpers ───────────────────────────────────────────────────────────
function bufToHex(buf) {
  return Array.from(buf, (b) => b.toString(16).padStart(2, '0')).join('');
}
function hexToBuf(hex) {
  const buf = new Uint8Array(hex.length / 2);
  for (let i = 0; i < buf.length; i++) buf[i] = parseInt(hex.substr(i * 2, 2), 16);
  return buf;
}
