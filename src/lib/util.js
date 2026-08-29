export function json(data, init = {}) {
  return new Response(JSON.stringify(data), {
    ...init,
    headers: { 'Content-Type': 'application/json', ...(init.headers || {}) },
  });
}

export function error(message, status = 400) {
  return json({ error: message }, { status });
}

// Throws a Response (caught in index.js) if there's no valid user session.
export function requireUser(session) {
  if (!session || session.kind !== 'user') {
    throw error('Not logged in', 401);
  }
  return session;
}

export function requireAdmin(session) {
  if (!session || session.kind !== 'admin') {
    throw error('Admin login required', 401);
  }
  return session;
}
