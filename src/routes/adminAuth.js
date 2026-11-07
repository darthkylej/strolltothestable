import { db } from '../lib/db.js';
import {
  generateOtp,
  hashOtp,
  createSessionToken,
  verifySessionToken,
  sessionCookieHeader,
  nextUsername, generateShortPassword, hashPassword,
} from '../lib/auth.js';
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
  return json({ ok: true }, { headers: { 'Set-Cookie': sessionCookieHeader(token,{kind:'admin'}) } });
}


export async function emailLogin(request, env) {
  const url = new URL(request.url);
  const token = url.searchParams.get('token') || '';
  const requestedNext = url.searchParams.get('next') || '/admin-messages.html';
  const safeNext = requestedNext.startsWith('/') && !requestedNext.startsWith('//')
    ? requestedNext
    : '/admin-messages.html';
  const fallback = '/admin-login.html?next=' + encodeURIComponent(safeNext);

  let payload = null;
  try {
    payload = await verifySessionToken(env, token);
  } catch {
    payload = null;
  }

  if (!payload || payload.kind !== 'admin-email-link' || !payload.email) {
    return new Response(null, {
      status: 302,
      headers: { Location: fallback },
    });
  }

  const normalized = String(payload.email).trim().toLowerCase();
  const sql = db(env);
  const admins = await sql`
    SELECT email
    FROM admins
    WHERE lower(email) = ${normalized}
    LIMIT 1
  `;

  if (admins.length === 0) {
    return new Response(null, {
      status: 302,
      headers: { Location: fallback },
    });
  }

  const sessionToken = await createSessionToken(env, {
    kind: 'admin',
    email: normalized,
  });

  return new Response(null, {
    status: 302,
    headers: {
      Location: safeNext,
      'Set-Cookie': sessionCookieHeader(sessionToken,{kind:'admin'}),
      'Cache-Control': 'no-store',
    },
  });
}

export async function participantProfile(request, env, session) {
  if (session?.kind !== 'admin' || !session.email) return error('Admin login required',401);
  const sql=db(env);
  const admins=await sql`SELECT email FROM admins WHERE lower(email)=lower(${session.email}) LIMIT 1`;
  if (!admins.length) return error('Admin access no longer active.',403);
  const existing=await sql`SELECT id,name,phone FROM users WHERE lower(email)=lower(${session.email}) ORDER BY id LIMIT 1`;
  if (request.method==='GET') {
    const headers=existing.length?{'Set-Cookie':sessionCookieHeader(await createSessionToken(env,{kind:'user',userId:existing[0].id}))}:{};
    return json({exists:!!existing.length,email:session.email,name:existing[0]?.name||'',phone:existing[0]?.phone||''},{headers});
  }
  if (request.method!=='POST') return error('Method not allowed',405);
  if (existing.length) return json({ok:true,existing:true},{headers:{'Set-Cookie':sessionCookieHeader(await createSessionToken(env,{kind:'user',userId:existing[0].id}))}});
  const {name,phone}=await request.json();
  if (!name?.trim() || !phone?.trim()) return error('Enter your name and phone number.');
  const lastName=name.trim().split(/\s+/).pop();
  const username=await nextUsername(sql,lastName);
  const passwordHash=await hashPassword(generateShortPassword(32));
  const created=await sql`INSERT INTO users (username,name,phone,email,password_hash)
    VALUES (${username},${name.trim()},${phone.trim()},${session.email},${passwordHash}) RETURNING id`;
  return json({ok:true,created:true},{headers:{'Set-Cookie':sessionCookieHeader(await createSessionToken(env,{kind:'user',userId:created[0].id}))}});
}
