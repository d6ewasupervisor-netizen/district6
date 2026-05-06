import { verifyAdminSessionToken } from './admin-jwt.js';
import { getSiteAdmin } from './site-admin.js';

function readBearer(req) {
  const auth = req.get('authorization') || '';
  if (!auth.toLowerCase().startsWith('bearer ')) return '';
  return auth.slice(7).trim();
}

/**
 * Requires a valid admin session JWT (Bearer). Sets req.adminEmail.
 * Express 4–safe wrapper (async work inside, no rejected floating promise).
 */
export function requireAdmin(req, res, next) {
  void (async () => {
    try {
      const token = readBearer(req);
      if (!token) {
        res.status(401).json({ ok: false, error: 'Sign in required.' });
        return;
      }
      const payload = verifyAdminSessionToken(token);
      const row = await getSiteAdmin();
      if (!row?.password_hash) {
        res.status(503).json({ ok: false, error: 'Admin login is not available yet.' });
        return;
      }
      const expected = row.admin_email.trim().toLowerCase();
      if ((payload.email || '').trim().toLowerCase() !== expected) {
        res.status(401).json({ ok: false, error: 'Session expired. Sign in again.' });
        return;
      }
      req.adminEmail = expected;
      next();
    } catch (err) {
      if (err && (err.name === 'TokenExpiredError' || err.name === 'JsonWebTokenError')) {
        res.status(401).json({ ok: false, error: 'Session expired. Sign in again.' });
        return;
      }
      console.error('[admin-auth]', err);
      res.status(500).json({ ok: false, error: 'Could not authorize request.' });
    }
  })();
}
