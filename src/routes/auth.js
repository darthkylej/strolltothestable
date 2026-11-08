import { db } from '../lib/db.js';
import {
  hashPassword, verifyPassword, nextUsername, generateShortPassword,
  createSessionToken, verifySessionToken, sessionCookieHeader,
} from '../lib/auth.js';
import { sendCredentialsEmail, sendForgotLoginEmail } from '../lib/email.js';
import { json, error } from '../lib/util.js';
import { getSiteSettings } from '../lib/siteSettings.js';
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
  // Registration sends an email, so cap it per address and per client.
  const okEmail = await consume(sql, `register:email:${email.toLowerCase()}`, 3, 3600);
  const okIp = await consume(sql, `register:ip:${clientIp(request)}`, 20, 3600);
  if (!okEmail || !okIp) return error(TOO_MANY, 429);

  const lastName = name.split(/\s+/).pop();
  const username = await nextUsername(sql, lastName);
  const password = generateShortPassword(5);
  const passwordHash = await hashPassword(password);

  const rows = await sql`
    INSERT INTO users (username, name, phone, email, password_hash)
    VALUES (${username}, ${name}, ${phone}, ${email}, ${passwordHash})
    RETURNING id
  `;

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
  return json({ ok: true, username }, { headers: { 'Set-Cookie': sessionCookieHeader(token) } });
}

export async function login(request, env) {
  const body = await request.json();
  const username = String(body?.username ?? '').trim().toLowerCase().slice(0, 64);
  const password = String(body?.password ?? '').trim();
  if (!username || !password) return error('Username and password are required.');

  const sql = db(env);
  // Passwords are short by design, so online guessing must be throttled.
  const userKey = `login-fail:user:${username}`;
  const ipKey = `login-fail:ip:${clientIp(request)}`;
  if (await isBlocked(sql, userKey, 8, 900) || await isBlocked(sql, ipKey, 30, 900)) {
    return error('Too many failed attempts. Wait 15 minutes, or use "forgot login" to get back in.', 429);
  }

  const rows = await sql`SELECT id, password_hash FROM users WHERE username = ${username}`;
  const ok = rows.length > 0 && await verifyPassword(password, rows[0].password_hash);
  if (!ok) {
    await recordFailure(sql, userKey);
    await recordFailure(sql, ipKey);
    return error('Username or password is incorrect.', 401);
  }
  await clearFailures(sql, userKey);

  const token = await createSessionToken(env, { kind: 'user', userId: rows[0].id });
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

  const sessionToken = await createSessionToken(env, { kind: 'user', userId: rows[0].id });
  return json(
    { ok: true },
    { headers: { 'Set-Cookie': sessionCookieHeader(sessionToken) } }
  );
}

export async function sessionStatus(request,env,session) {
  if(session?.kind==='user') return json({authenticated:true,role:'user'});
  return json({authenticated:false});
}
