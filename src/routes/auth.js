import { db } from '../lib/db.js';
import {
  hashPassword, verifyPassword, nextUsername, generateShortPassword,
  createSessionToken, verifySessionToken, sessionCookieHeader,
} from '../lib/auth.js';
import { sendCredentialsEmail, sendForgotLoginEmail } from '../lib/email.js';
import { json, error } from '../lib/util.js';
import { getSiteSettings } from '../lib/siteSettings.js';
import { resetWaiversForUser } from './waivers.js';
import { clientIp, consume, isBlocked, recordFailure, clearFailures } from '../lib/rateLimit.js';

const EMAIL_RE = /^[^\s@<>"]+@[^\s@<>"]+\.[^\s@<>"]{2,}$/;
const TOO_MANY = 'Too many attempts. Please wait a while and try again.';

export async function register(request, env) {
  const body = await request.json();
  const name = String(body?.name ?? '').trim();
  const phone = String(body?.phone ?? '').trim();
  const email = String(body?.email ?? '').trim();
  if (!name || !phone || !email) {
    return error('Name, phone, and email are all required.');
  }
  if (name.length > 100 || phone.length > 40 || email.length > 254) {
    return error('One of the fields is too long.');
  }
  if (!EMAIL_RE.test(email)) return error('Enter a valid email address.');

  const sql = db(env);
  // One account per email: the email address is the login.
  const existing = await sql`SELECT 1 FROM users WHERE lower(email) = lower(${email}) LIMIT 1`;
  if (existing.length) {
    return error('An account with this email already exists. Log in with your email and password, or use "Forgot your login?" to get a login link.', 409);
  }
  // Registration sends an email, so cap it per address and per client.
  const okEmail = await consume(sql, `register:email:${email.toLowerCase()}`, 3, 3600);
  const okIp = await consume(sql, `register:ip:${clientIp(request)}`, 20, 3600);
  if (!okEmail || !okIp) return error(TOO_MANY, 429);

  const lastName = name.split(/\s+/).pop();
  const username = await nextUsername(sql, lastName);
  const password = generateShortPassword(5);
  const passwordHash = await hashPassword(password);

  // Internal username is still generated (the column is required), but people
  // log in with their email. NOT EXISTS closes the race between two requests.
  const rows = await sql`
    INSERT INTO users (username, name, phone, email, password_hash)
    SELECT ${username}, ${name}, ${phone}, ${email}, ${passwordHash}
    WHERE NOT EXISTS (SELECT 1 FROM users WHERE lower(email) = lower(${email}))
    RETURNING id
  `;
  if (!rows.length) {
    return error('An account with this email already exists. Log in with your email and password.', 409);
  }

  const settings = await getSiteSettings(env);
  try {
    await sendCredentialsEmail(env, { to: email, name, username, password, settings });
  } catch (err) {
    // Without the email the person has no way to learn their password, so do
    // not leave an unreachable account behind.
    console.error('Credentials email failed:', err);
    await sql`DELETE FROM users WHERE id = ${rows[0].id}`;
    return error('We could not send your login email. Check the address and try again.', 502);
  }

  const token = await createSessionToken(env, { kind: 'user', userId: rows[0].id });
  return json({ ok: true }, { headers: { 'Set-Cookie': sessionCookieHeader(token) } });
}

export async function login(request, env) {
  const body = await request.json();
  // Email is the login. Older usernames are still accepted for anyone who
  // kept their original registration email.
  const login = String(body?.email ?? body?.username ?? '').trim().toLowerCase().slice(0, 254);
  const password = String(body?.password ?? '').trim();
  if (!login || !password) return error('Email and password are required.');

  const sql = db(env);
  // Passwords are short by design, so online guessing must be throttled.
  const userKey = `login-fail:user:${login}`;
  const ipKey = `login-fail:ip:${clientIp(request)}`;
  if (await isBlocked(sql, userKey, 8, 900) || await isBlocked(sql, ipKey, 30, 900)) {
    return error('Too many failed attempts. Wait 15 minutes, or use "forgot login" to get back in.', 429);
  }

  // Accounts created before emails were unique may share an address, so the
  // password decides which one is being logged into.
  const candidates = login.includes('@')
    ? await sql`SELECT id, password_hash FROM users WHERE lower(email) = ${login} ORDER BY id DESC LIMIT 20`
    : await sql`SELECT id, password_hash FROM users WHERE username = ${login}`;
  let matched = null;
  for (const row of candidates) {
    if (await verifyPassword(password, row.password_hash)) { matched = row; break; }
  }
  if (!matched) {
    await recordFailure(sql, userKey);
    await recordFailure(sql, ipKey);
    return error('Email or password is incorrect.', 401);
  }
  await clearFailures(sql, userKey);

  const token = await createSessionToken(env, { kind: 'user', userId: matched.id });
  return json({ ok: true }, { headers: { 'Set-Cookie': sessionCookieHeader(token) } });
}

export async function logout() {
  const response=json({ok:true});
  response.headers.append('Set-Cookie',sessionCookieHeader(null,{clear:true,kind:'user'}));
  response.headers.append('Set-Cookie',sessionCookieHeader(null,{clear:true,kind:'admin'}));
  response.headers.append('Set-Cookie','session=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0');
  return response;
}

export async function forgotLogin(request, env) {
  const body = await request.json();
  const email = String(body?.email ?? '').trim();
  if (!email) return error('Enter the email you registered with.');

  const sql = db(env);
  const rows = await sql`
    SELECT id, name, username
    FROM users
    WHERE lower(email) = lower(${email})
    ORDER BY id
    LIMIT 1
  `;

  // Always return ok, whether or not we found an account (or were throttled),
  // so nothing leaks about which emails are registered.
  const allowed = (await consume(sql, `forgot:email:${email.toLowerCase().slice(0, 254)}`, 3, 3600))
    && (await consume(sql, `forgot:ip:${clientIp(request)}`, 10, 3600));
  if (rows.length > 0 && allowed) {
    const recoveryToken = await createSessionToken(
      env,
      { kind: 'recovery', userId: rows[0].id },
      30 * 60 * 1000
    );
    const recoveryUrl = `${new URL(request.url).origin}/recover.html?token=${encodeURIComponent(recoveryToken)}`;
    const settings = await getSiteSettings(env);
    await sendForgotLoginEmail(env, {
      to: email,
      name: rows[0].name,
      username: rows[0].username,
      recoveryUrl,
      settings,
    });
  }
  return json({ ok: true });
}

export async function recoverLogin(request, env) {
  const { token } = await request.json();
  if (!token) return error('This recovery link is invalid or has expired.', 401);

  let payload;
  try {
    payload = await verifySessionToken(env, token);
  } catch {
    payload = null;
  }

  if (!payload || payload.kind !== 'recovery' || !payload.userId) {
    return error('This recovery link is invalid or has expired.', 401);
  }

  const sql = db(env);
  const rows = await sql`SELECT id FROM users WHERE id = ${payload.userId}`;
  if (rows.length === 0) return error('This recovery link is invalid or has expired.', 401);

  // recoveredAt lets the donor set a new password without the old one for a
  // short time after following the emailed link.
  const sessionToken = await createSessionToken(env, { kind: 'user', userId: rows[0].id, recoveredAt: Date.now() });
  return json(
    { ok: true },
    { headers: { 'Set-Cookie': sessionCookieHeader(sessionToken) } }
  );
}

export async function sessionStatus(request,env,session) {
  if(session?.kind==='user') return json({authenticated:true,role:'user'});
  return json({authenticated:false});
}

const RECOVERY_WINDOW_MS = 30 * 60 * 1000;

export async function getAccount(request, env, session) {
  if (session?.kind !== 'user') return error('Please log in.', 401);
  const rows = await db(env)`SELECT name, phone, email, donor_code AS "donorCode" FROM users WHERE id = ${session.userId}`;
  if (!rows.length) return error('Please log in.', 401);
  const canResetWithoutCurrent = !!session.recoveredAt && Date.now() - session.recoveredAt < RECOVERY_WINDOW_MS;
  return json({ ...rows[0], canResetWithoutCurrent }, { headers: { 'Cache-Control': 'no-store' } });
}

// Donor edits their name, phone or email. Any change clears the waivers of
// submissions that are not checked in yet, because the waiver shows them.
export async function updateAccount(request, env, session) {
  if (session?.kind !== 'user') return error('Please log in.', 401);
  const body = await request.json();
  const name = String(body?.name ?? '').trim();
  const phone = String(body?.phone ?? '').trim();
  const email = String(body?.email ?? '').trim();
  if (!name || !phone || !email) return error('Name, phone, and email are all required.');
  if (name.length > 100 || phone.length > 40 || email.length > 254) return error('One of the fields is too long.');
  if (!EMAIL_RE.test(email)) return error('Enter a valid email address.');
  const sql = db(env);
  const rows = await sql`SELECT name, phone, email FROM users WHERE id = ${session.userId}`;
  if (!rows.length) return error('Please log in.', 401);
  const cur = rows[0];
  if (cur.name === name && cur.phone === phone && cur.email.toLowerCase() === email.toLowerCase() && cur.email === email) {
    return json({ ok: true, changed: false, waiversCleared: 0 });
  }
  const taken = await sql`SELECT 1 FROM users WHERE lower(email) = lower(${email}) AND id <> ${session.userId} LIMIT 1`;
  if (taken.length) return error('Another account already uses that email address.', 409);
  await sql`UPDATE users SET name = ${name}, phone = ${phone}, email = ${email} WHERE id = ${session.userId}`;
  const waiversCleared = await resetWaiversForUser(env, session.userId);
  return json({ ok: true, changed: true, waiversCleared });
}

export async function changePassword(request, env, session) {
  if (session?.kind !== 'user') return error('Please log in.', 401);
  const body = await request.json();
  const next = String(body?.newPassword ?? '');
  if (next.trim().length < 6) return error('Choose a password of at least 6 characters.');
  if (next.length > 100) return error('That password is too long.');
  const sql = db(env);
  const rows = await sql`SELECT password_hash, email FROM users WHERE id = ${session.userId}`;
  if (!rows.length) return error('Please log in.', 401);
  const recovered = !!session.recoveredAt && Date.now() - session.recoveredAt < RECOVERY_WINDOW_MS;
  if (!recovered) {
    const failKey = `pwchange-fail:user:${session.userId}`;
    if (await isBlocked(sql, failKey, 8, 900)) return error('Too many attempts. Wait 15 minutes and try again.', 429);
    if (!(await verifyPassword(String(body?.currentPassword ?? '').trim(), rows[0].password_hash))) {
      await recordFailure(sql, failKey);
      return error('Your current password is incorrect. If you do not know it, use "Forgot your login?" to get a link.', 401);
    }
  }
  await sql`UPDATE users SET password_hash = ${await hashPassword(next.trim())} WHERE id = ${session.userId}`;
  await clearFailures(sql, `login-fail:user:${rows[0].email.toLowerCase()}`);
  // Replace the recovery session with a normal one.
  const token = await createSessionToken(env, { kind: 'user', userId: session.userId });
  return json({ ok: true }, { headers: { 'Set-Cookie': sessionCookieHeader(token) } });
}
