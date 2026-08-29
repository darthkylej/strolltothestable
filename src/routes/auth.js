import { db } from '../lib/db.js';
import {
  hashPassword, verifyPassword, nextUsername, generateShortPassword,
  createSessionToken, sessionCookieHeader,
} from '../lib/auth.js';
import { sendCredentialsEmail, sendForgotLoginEmail } from '../lib/email.js';
import { json, error } from '../lib/util.js';

export async function register(request, env) {
  const { name, phone, email } = await request.json();
  if (!name?.trim() || !phone?.trim() || !email?.trim()) {
    return error('Name, phone, and email are all required.');
  }

  const sql = db(env);
  const lastName = name.trim().split(/\s+/).pop();
  const username = await nextUsername(sql, lastName);
  const password = generateShortPassword(5);
  const passwordHash = await hashPassword(password);

  const rows = await sql`
    INSERT INTO users (username, name, phone, email, password_hash)
    VALUES (${username}, ${name.trim()}, ${phone.trim()}, ${email.trim()}, ${passwordHash})
    RETURNING id
  `;

  await sendCredentialsEmail(env, { to: email.trim(), name: name.trim(), username, password });

  const token = await createSessionToken(env, { kind: 'user', userId: rows[0].id });
  return json({ ok: true, username }, { headers: { 'Set-Cookie': sessionCookieHeader(token) } });
}

export async function login(request, env) {
  const { username, password } = await request.json();
  if (!username?.trim() || !password?.trim()) return error('Username and password are required.');

  const sql = db(env);
  const rows = await sql`SELECT id, password_hash FROM users WHERE username = ${username.trim().toLowerCase()}`;
  if (rows.length === 0) return error('Username or password is incorrect.', 401);

  const ok = await verifyPassword(password.trim(), rows[0].password_hash);
  if (!ok) return error('Username or password is incorrect.', 401);

  const token = await createSessionToken(env, { kind: 'user', userId: rows[0].id });
  return json({ ok: true }, { headers: { 'Set-Cookie': sessionCookieHeader(token) } });
}

export async function logout() {
  return json({ ok: true }, { headers: { 'Set-Cookie': sessionCookieHeader(null, { clear: true }) } });
}

export async function forgotLogin(request, env) {
  const { email } = await request.json();
  if (!email?.trim()) return error('Enter the email you registered with.');

  const sql = db(env);
  const rows = await sql`SELECT id, name, username FROM users WHERE email = ${email.trim()}`;
  // Always return ok, whether or not we found an account — don't leak
  // which emails are registered.
  if (rows.length > 0) {
    const password = generateShortPassword(5);
    const passwordHash = await hashPassword(password);
    await sql`UPDATE users SET password_hash = ${passwordHash} WHERE id = ${rows[0].id}`;
    await sendForgotLoginEmail(env, {
      to: email.trim(), name: rows[0].name, username: rows[0].username, password,
    });
  }
  return json({ ok: true });
}
