import { neon } from '@neondatabase/serverless';

// Returns a tagged-template SQL function bound to this request's env.
// Usage: const sql = db(env); const rows = await sql`SELECT 1`;
export function db(env) {
  return neon(env.DATABASE_URL);
}
