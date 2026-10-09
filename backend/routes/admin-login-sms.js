/*
 * Admin SMS PIN login: POST /api/admin/session/sms/send | /verify.
 *
 * Same gate as admin-session POST /login (site_admins row with password_hash).
 * Verify returns the same admin session token as the password form.
 */
import express from 'express';
import rateLimit from 'express-rate-limit';
import { EMAIL_RE, sendAdminLoginCode, verifyAdminSmsCode } from '../lib/sms-login.js';

const router = express.Router();

const sendLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, // 1 hour
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  message: { ok: false, error: 'Too many requests. Try again later.' },
});

const verifyLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 15,
  standardHeaders: true,
  legacyHeaders: false,
  message: { ok: false, error: 'Too many attempts. Try again later.' },
});

function readEmail(body) {
  const raw = body && body.email ? String(body.email) : '';
  return raw.trim().toLowerCase();
}

router.post('/send', sendLimiter, async (req, res) => {
  const email = readEmail(req.body);
  if (!email || !EMAIL_RE.test(email)) {
    return res.status(400).json({ ok: false, error: 'Enter a valid email address.' });
  }
  try {
    const result = await sendAdminLoginCode({ email });
    if (!result.ok) {
      return res.status(result.status || 400).json({ ok: false, error: result.error });
    }
    return res.json({ ok: true, phoneMask: result.phoneMask });
  } catch (err) {
    console.error('[admin-login-sms] send', err);
    return res.status(500).json({ ok: false, error: 'Could not send a code. Try again or use email.' });
  }
});

router.post('/verify', verifyLimiter, async (req, res) => {
  const email = readEmail(req.body);
  const code = req.body && req.body.code != null ? String(req.body.code).trim() : '';
  if (!email || !EMAIL_RE.test(email)) {
    return res.status(400).json({ ok: false, error: 'Enter a valid email address.' });
  }
  if (!/^\d{6}$/.test(code)) {
    return res.status(400).json({ ok: false, error: 'Enter the 6-digit code from your text.' });
  }
  try {
    const result = await verifyAdminSmsCode({ email, code });
    if (!result.ok) {
      return res.status(result.status || 400).json({ ok: false, error: result.error });
    }
    return res.json({ ok: true, token: result.token, email: result.email });
  } catch (err) {
    console.error('[admin-login-sms] verify', err);
    return res.status(500).json({ ok: false, error: 'Could not verify the code. Try again or use email.' });
  }
});

export default router;