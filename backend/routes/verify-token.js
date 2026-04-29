import express from 'express';
import { verifyToken } from '../lib/tokens.js';
import { query } from '../lib/db.js';

const router = express.Router();

router.get('/', async (req, res) => {
  const token = String(req.query.token || '');
  if (!token) {
    return res.status(400).json({ ok: false, error: 'Missing token.' });
  }

  try {
    const payload = verifyToken(token);
    const jti = payload.jti;
    const email = payload.email;

    const { rows } = await query(
      `SELECT used_at FROM link_requests WHERE jti = $1 LIMIT 1`,
      [jti],
    );
    if (rows.length === 0) {
      return res.status(400).json({ ok: false, error: 'Link not recognized. Request a new one.' });
    }
    if (rows[0].used_at) {
      return res.status(400).json({ ok: false, error: 'This link has already been used.' });
    }

    return res.json({ ok: true, email });
  } catch (err) {
    if (err && (err.name === 'TokenExpiredError' || err.name === 'JsonWebTokenError')) {
      return res.status(400).json({ ok: false, error: 'This link is invalid or expired.' });
    }
    console.error('[verify-token] error', err);
    return res.status(500).json({ ok: false, error: 'Could not verify link.' });
  }
});

export default router;
