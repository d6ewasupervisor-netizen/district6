import express from 'express';
import rateLimit from 'express-rate-limit';
import { issueToken } from '../lib/tokens.js';
import { query } from '../lib/db.js';
import { sendLinkEmail } from '../lib/email.js';

const router = express.Router();

const limiter = rateLimit({
  windowMs: 60 * 60 * 1000, // 1 hour
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  message: { ok: false, error: 'Too many requests. Try again later.' },
});

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const ALLOWED_DOMAIN = 'retailodyssey.com';

router.post('/', limiter, async (req, res) => {
  try {
    const rawEmail = (req.body && req.body.email) ? String(req.body.email) : '';
    const email = rawEmail.trim().toLowerCase();

    if (!email || !EMAIL_RE.test(email)) {
      return res.status(400).json({ ok: false, error: 'Please enter a valid email address.' });
    }

    if (!email.endsWith(`@${ALLOWED_DOMAIN}`)) {
      return res.status(400).json({
        ok: false,
        error: `Only @${ALLOWED_DOMAIN} emails are accepted.`,
      });
    }

    const { token, jti } = issueToken(email);
    const ip = req.ip;
    const ua = req.get('user-agent') || null;

    await query(
      `INSERT INTO link_requests (email, jti, ip, user_agent) VALUES ($1, $2, $3, $4)`,
      [email, jti, ip, ua],
    );

    const base = (process.env.FRONTEND_BASE_URL || '').replace(/\/+$/, '');
    const link = `${base}/sign.html?token=${encodeURIComponent(token)}`;

    await sendLinkEmail({ to: email, link });

    console.log(`[request-link] issued jti=${jti.slice(0, 6)}… for ${email}`);
    return res.json({ ok: true });
  } catch (err) {
    console.error('[request-link] error', err);
    return res.status(500).json({ ok: false, error: 'Could not send link. Please try again.' });
  }
});

export default router;
