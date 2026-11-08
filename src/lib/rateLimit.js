// Database-backed attempt limiter. Workers are stateless, so counters live in
// Neon (table auth_attempts). The table is created on first use, so no manual
// migration is required, but it is also declared in schema.sql.
let ensured = null;

function ensureTable(sql) {
  if (!ensured) {
    ensured = (async () => {
      await sql`CREATE TABLE IF NOT EXISTS auth_attempts (
        id BIGSERIAL PRIMARY KEY,
        key TEXT NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )`;
      await sql`CREATE INDEX IF NOT EXISTS idx_auth_attempts_key ON auth_attempts (key, created_at)`;
    })().catch((err) => { ensured = null; throw err; });
  }
  return ensured;
}

async function maybeCleanup(sql) {
  if (Math.random() < 0.02) {
    await sql`DELETE FROM auth_attempts WHERE created_at < now() - interval '1 day'`;
  }
}

export function clientIp(request) {
  return request.headers.get('CF-Connecting-IP') || 'unknown';
}

// Counts this call against `key` and returns true if it is within the limit.
// Calls over the limit are not recorded, so a blocked client does not extend
// its own lockout.
export async function consume(sql, key, limit, windowSec) {
  await ensureTable(sql);
  const rows = await sql`
    WITH c AS (
      SELECT count(*)::int AS n FROM auth_attempts
      WHERE key = ${key}::text AND created_at > now() - make_interval(secs => ${windowSec}::int)
    )
    INSERT INTO auth_attempts (key)
    SELECT ${key}::text WHERE (SELECT n FROM c) < ${limit}::int
    RETURNING id
  `;
  await maybeCleanup(sql);
  return rows.length > 0;
}

// Failure-counting variant: check first, record only on a failed attempt.
export async function isBlocked(sql, key, limit, windowSec) {
  await ensureTable(sql);
  const rows = await sql`
    SELECT count(*)::int AS n FROM auth_attempts
    WHERE key = ${key}::text AND created_at > now() - make_interval(secs => ${windowSec}::int)
  `;
  return rows[0].n >= limit;
}

export async function recordFailure(sql, key) {
  await ensureTable(sql);
  await sql`INSERT INTO auth_attempts (key) VALUES (${key}::text)`;
}

export async function clearFailures(sql, key) {
  await ensureTable(sql);
  await sql`DELETE FROM auth_attempts WHERE key = ${key}::text`;
}
