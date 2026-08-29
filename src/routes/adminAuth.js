import { db } from '../lib/db.js';
import { generateOtp, hashOtp, createSessionToken, sessionCookieHeader } from '../lib/auth.js';
import { sendAdminOtpEmail } from '../lib/email.js';
import { json, error } from '../lib/util.js';

const OTP_TTL_MS = 10 * 60 * 1000;

export async function requestOtp(request, env) {
  const { email } = await request.json();
  if (!email?.trim()) return error('Enter your admin email.');
  const normalized = email.trim().toLowerCase();

  const sql = db(env);
  const admins = await sql`SELECT email FROM admins WHERE lower(email) = ${normalized}`;
  // Same non-leaking pattern as forgot-login: always say ok.
  if (admins.length > 0) {
    const code = generateOtp();
    const codeHash = await hashOtp(code);
    await sql`
      INSERT INTO admin_otp_codes (email, code_hash, expires_at)
      VALUES (${normalized}, ${codeHash}, ${new Date(Date.now() + OTP_TTL_MS).toISOString()})
    `;
    await sendAdminOtpEmail(env, { to: normalized, code });
  }
  return json({ ok: true });
}

export async function verifyOtp(request, env) {
  const { email, code } = await request.json();
  if (!email?.trim() || !code?.trim()) return error('Enter the code from your email.');
  const normalized = email.trim().toLowerCase();

  const sql = db(env);
  const codeHash = await hashOtp(code.trim());
  const rows = await sql`
    SELECT id FROM admin_otp_codes
    WHERE email = ${normalized} AND code_hash = ${codeHash} AND expires_at > now()
    ORDER BY id DESC LIMIT 1
  `;
  if (rows.length === 0) return error('That code is invalid or expired.', 401);

  // Consume it so it can't be reused.
  await sql`DELETE FROM admin_otp_codes WHERE id = ${rows[0].id}`;

  const token = await createSessionToken(env, { kind: 'admin', email: normalized });
  return json({ ok: true }, { headers: { 'Set-Cookie': sessionCookieHeader(token) } });
}
