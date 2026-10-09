/*
 * Text sign-in numbers (admin only): GET/POST/DELETE /api/admin/login-phones.
 *
 * One number per email, shared by the rep and admin PIN flows. Save is allowed
 * when isEmailAllowed is true or the email is a site_admins row — this is how
 * the first numbers get on file. This list is the one place API responses show
 * the full number; everywhere else numbers are masked (+1***1234).
 */
import express from 'express';
import rateLimit from 'express-rate-limit';
import { requireAdmin } from '../lib/admin-auth.js';
import {
  EMAIL_RE,
  NO_PHONE_MESSAGE,
  normalizeE164,
  canSaveLoginPhone,
  saveLoginPhone,
  removeLoginPhone,
  listLoginPhones,
} from '../lib/sms-login.js';

const router = express.Router();
router.use(requireAdmin);

const limiter = rateLimit({
  windowMs: 60 * 1000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
  message: { ok: false, error: 'Too many requests. Try again shortly.' },
});
router.use(limiter);

router.get('/', async (_req, res) => {
  try {
    const phones = await listLoginPhones();
    return res.json({ ok: true, phones });
  } catch (err) {
    console.error('[admin login-phones] list', err);
    return res.status(500).json({ ok: false, error: 'Could not load numbers.' });
  }
});

router.post('/', async (req, res) => {
  const rawEmail = req.body && req.body.email ? String(req.body.email) : '';
  const email = rawEmail.trim().toLowerCase();
  const rawPhone = req.body && req.body.phone != null ? String(req.body.phone) : '';
  if (!email || !EMAIL_RE.test(email)) {
    return res.status(400).json({ ok: false, error: 'Enter a valid email address.' });
  }
  const phoneE164 = normalizeE164(rawPhone);
  if (!phoneE164) {
    return res.status(400).json({ ok: false, error: 'Enter a US mobile number, like (509) 555-1234.' });
  }
  try {
    if (!(await canSaveLoginPhone(email))) {
      return res.status(400).json({
        ok: false,
        error: 'This email is not allowed to sign in. Add it to the access list first.',
      });
    }
    await saveLoginPhone(email, phoneE164);
    console.log(`[admin login-phones] saved number for ${email}`);
    return res.json({ ok: true, email });
  } catch (err) {
    console.error('[admin login-phones] save', err);
    return res.status(500).json({ ok: false, error: 'Could not save the number.' });
  }
});

router.delete('/', async (req, res) => {
  const rawEmail = req.body && req.body.email ? String(req.body.email) : '';
  const email = rawEmail.trim().toLowerCase();
  if (!email || !EMAIL_RE.test(email)) {
    return res.status(400).json({ ok: false, error: 'Enter a valid email address.' });
  }
  try {
    const removed = await removeLoginPhone(email);
    if (!removed) {
      return res.status(400).json({ ok: false, error: NO_PHONE_MESSAGE });
    }
    console.log(`[admin login-phones] removed number for ${email}`);
    return res.json({ ok: true, email });
  } catch (err) {
    console.error('[admin login-phones] remove', err);
    return res.status(500).json({ ok: false, error: 'Could not remove the number.' });
  }
});

export default router;