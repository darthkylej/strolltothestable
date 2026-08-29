import { getSession } from './lib/auth.js';
import * as auth from './routes/auth.js';
import * as adminAuth from './routes/adminAuth.js';
import * as nativities from './routes/nativities.js';
import * as admin from './routes/admin.js';
import { getTour } from './routes/tour.js';
import { error } from './lib/util.js';

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;
    const method = request.method;

    try {
      // ── Photos (public read, served through the Worker so no separate
      // R2 public-domain setup is needed) ──────────────────────────────
      if (method === 'GET' && path.startsWith('/photos/')) {
        const key = path.replace('/photos/', '');
        const obj = await env.PHOTOS.get(key);
        if (!obj) return new Response('Not found', { status: 404 });
        return new Response(obj.body, {
          headers: { 'Content-Type': obj.httpMetadata?.contentType || 'image/jpeg', 'Cache-Control': 'public, max-age=31536000' },
        });
      }

      if (!path.startsWith('/api/')) {
        // Not an API route — let the static assets binding serve public/*.html
        return env.ASSETS.fetch(request);
      }

      const session = await getSession(request, env);

      // ── Public auth endpoints ──────────────────────────────────────
      if (path === '/api/register' && method === 'POST') return await auth.register(request, env);
      if (path === '/api/login' && method === 'POST') return await auth.login(request, env);
      if (path === '/api/logout' && method === 'POST') return await auth.logout();
      if (path === '/api/forgot-login' && method === 'POST') return await auth.forgotLogin(request, env);

      if (path === '/api/admin/request-otp' && method === 'POST') return await adminAuth.requestOtp(request, env);
      if (path === '/api/admin/verify-otp' && method === 'POST') return await adminAuth.verifyOtp(request, env);

      // ── Public virtual tour (no login) ──────────────────────────────
      if (path === '/api/tour' && method === 'GET') return await getTour(request, env);

      // ── User endpoints (require a user session) ─────────────────────
      if (path === '/api/nativities' && method === 'GET') return await nativities.listMine(request, env, session);
      if (path === '/api/nativities' && method === 'POST') return await nativities.create(request, env, session);
      if (path === '/api/upload-photo' && method === 'POST') return await nativities.uploadPhoto(request, env, session);

      let m;
      if ((m = path.match(/^\/api\/nativities\/(\d+)$/)) && method === 'GET') {
        return await nativities.getOne(request, env, session, m[1]);
      }
      if ((m = path.match(/^\/api\/nativities\/(\d+)\/pieces$/)) && method === 'POST') {
        return await nativities.submitPieces(request, env, session, m[1]);
      }
      if ((m = path.match(/^\/api\/nativities\/(\d+)\/resubmit$/)) && method === 'POST') {
        return await nativities.resubmit(request, env, session, m[1]);
      }
      if ((m = path.match(/^\/api\/nativities\/(\d+)\/tour-visibility$/)) && method === 'POST') {
        return await nativities.setTourVisibility(request, env, session, m[1]);
      }

      // ── Admin endpoints (require an admin session) ───────────────────
      if (path === '/api/admin/nativities' && method === 'GET') return await admin.listNativities(request, env, session);
      if (path === '/api/admin/admins' && method === 'GET') return await admin.listAdmins(request, env, session);
      if (path === '/api/admin/admins' && method === 'POST') return await admin.addAdmin(request, env, session);

      if ((m = path.match(/^\/api\/admin\/admins\/([^/]+)$/)) && method === 'DELETE') {
        return await admin.removeAdmin(request, env, session, decodeURIComponent(m[1]));
      }
      if ((m = path.match(/^\/api\/admin\/nativities\/(\d+)$/)) && method === 'GET') {
        return await admin.getNativity(request, env, session, m[1]);
      }
      if ((m = path.match(/^\/api\/admin\/nativities\/(\d+)\/waiver$/)) && method === 'POST') {
        return await admin.toggleWaiver(request, env, session, m[1]);
      }
      if ((m = path.match(/^\/api\/admin\/nativities\/(\d+)\/finalize$/)) && method === 'POST') {
        return await admin.finalize(request, env, session, m[1]);
      }
      if ((m = path.match(/^\/api\/admin\/nativities\/(\d+)\/returned$/)) && method === 'POST') {
        return await admin.markReturned(request, env, session, m[1]);
      }
      if ((m = path.match(/^\/api\/admin\/nativities\/(\d+)\/display-photo$/)) && method === 'POST') {
        return await admin.uploadDisplayPhoto(request, env, session, m[1]);
      }
      if ((m = path.match(/^\/api\/admin\/nativities\/(\d+)\/display-photo\/clear$/)) && method === 'POST') {
        return await admin.clearDisplayPhoto(request, env, session, m[1]);
      }

      return error('Not found', 404);
    } catch (err) {
      if (err instanceof Response) return err; // thrown by requireUser/requireAdmin
      console.error(err);
      return error('Something went wrong. Please try again.', 500);
    }
  },
};
