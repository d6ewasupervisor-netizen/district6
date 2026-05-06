import express from 'express';
import bcrypt from 'bcryptjs';
import rateLimit from 'express-rate-limit';
import {
  PRIMARY_ADMIN_EMAIL,
  getAdminRow,
  getPrimaryBootstrapAdmin,
  maskAdminEmail,
  setPasswordHashIfUnset,
} from '../lib/site-admin.js';
import { issueAdminSessionToken } from '../lib/admin-jwt.js';
import { requireAdmin } from '../lib/admin-auth.js';

const router = express.Router();

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const MIN_PASSWORD_LENGTH = Number(process.env.ADMIN_PASSWORD_MIN_LENGTH || 10);
const MIN_SETUP_TOKEN_LENGTH = 16;

const bcryptCost = Number(process.env.ADMIN_BCRYPT_COST || 12);

function setupTokenConfigured() {
  const t = (process.env.ADMIN_SETUP_TOKEN || '').trim();
  return t.length >= MIN_SETUP_TOKEN_LENGTH;
}

function readSetupToken(body) {
  const raw =
    (body && (body.setupToken ?? body.bootstrapToken ?? body.oneTimeCode)) != null
      ? String(body.setupToken ?? body.bootstrapToken ?? body.oneTimeCode)
      : '';
  return raw.trim();
}

function normalizePassword(pw) {
  const s = typeof pw === 'string' ? pw : '';
  const trimmed = s.trim();
  const needsTrimWarn = trimmed !== s;
  return { trimmed, needsTrimWarn };
}

function validateTrimmedPassword(trimmedPw, trimmedConfirm) {
  if (trimmedPw.length < MIN_PASSWORD_LENGTH) {
    return {
      error: `Use at least ${MIN_PASSWORD_LENGTH} characters for your password.`,
    };
  }
  if (trimmedPw !== trimmedConfirm) {
    return { error: 'Passwords do not match.' };
  }
  return { ok: true };
}

const statusLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 40,
  standardHeaders: true,
  legacyHeaders: false,
  message: { ok: false, error: 'Too many requests. Try again shortly.' },
});

const setupLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 15,
  standardHeaders: true,
  legacyHeaders: false,
  message: { ok: false, error: 'Too many setup attempts. Try again later.' },
});

const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 40,
  standardHeaders: true,
  legacyHeaders: false,
  message: { ok: false, error: 'Too many sign-in attempts. Try again later.' },
});

router.get('/status', statusLimiter, async (_req, res) => {
  try {
    const row = await getPrimaryBootstrapAdmin();
    if (!row) {
      return res.status(503).json({ ok: false, error: 'Admin profile is not ready.' });
    }
    const email = row.email;
    const needsPasswordSetup = !row.password_hash;
    return res.json({
      ok: true,
      needsPasswordSetup,
      primaryAdminEmail: email,
      adminEmail: email,
      maskedEmail: maskAdminEmail(email),
      setupTokenConfigured: needsPasswordSetup ? setupTokenConfigured() : true,
    });
  } catch (err) {
    console.error('[admin-session] status', err);
    return res.status(500).json({ ok: false, error: 'Could not load status.' });
  }
});

router.post('/setup', setupLimiter, async (req, res) => {
  try {
    const bootstrap = await getPrimaryBootstrapAdmin();
    if (!bootstrap) {
      return res.status(503).json({ ok: false, error: 'Admin profile is not ready.' });
    }
    if (bootstrap.password_hash) {
      return res.status(400).json({
        ok: false,
        error:
          `A password is already set for ${PRIMARY_ADMIN_EMAIL}. Sign in with your email and password.`,
      });
    }
    if (!setupTokenConfigured()) {
      return res.status(503).json({
        ok: false,
        error:
          'First-time setup is not enabled on the server (missing ADMIN_SETUP_TOKEN).',
      });
    }
    const token = readSetupToken(req.body);
    if (token !== (process.env.ADMIN_SETUP_TOKEN || '').trim()) {
      return res.status(401).json({ ok: false, error: 'Invalid one-time setup code.' });
    }

    const rawPw = req.body && req.body.password != null ? String(req.body.password) : '';
    const rawConfirm =
      req.body && req.body.passwordConfirm != null
        ? String(req.body.passwordConfirm)
        : '';
    const a = normalizePassword(rawPw);
    const b = normalizePassword(rawConfirm);
    if (a.needsTrimWarn || b.needsTrimWarn) {
      return res.status(400).json({
        ok: false,
        error: 'Password cannot start or end with spaces.',
      });
    }
    const v = validateTrimmedPassword(a.trimmed, b.trimmed);
    if (v.error) {
      return res.status(400).json({ ok: false, error: v.error });
    }

    const hash = bcrypt.hashSync(a.trimmed, bcrypt.genSaltSync(bcryptCost));
    const saved = await setPasswordHashIfUnset(PRIMARY_ADMIN_EMAIL, hash);
    if (!saved) {
      return res.status(409).json({
        ok: false,
        error: 'Password was set by another request. Sign in instead.',
      });
    }

    const adminEmail = PRIMARY_ADMIN_EMAIL;
    const sessionToken = issueAdminSessionToken(adminEmail);
    console.log(`[admin-session] initial password configured for ${adminEmail}`);
    return res.json({ ok: true, token: sessionToken, email: adminEmail });
  } catch (err) {
    console.error('[admin-session] setup', err);
    return res.status(500).json({ ok: false, error: 'Could not save password.' });
  }
});

router.post('/login', loginLimiter, async (req, res) => {
  try {
    const rawEmail = req.body && req.body.email ? String(req.body.email) : '';
    const email = rawEmail.trim().toLowerCase();
    if (!email || !EMAIL_RE.test(email)) {
      return res.status(400).json({ ok: false, error: 'Enter a valid email address.' });
    }

    const row = await getAdminRow(email);
    if (!row?.password_hash) {
      return res.status(401).json({
        ok: false,
        error:
          email === PRIMARY_ADMIN_EMAIL
            ? 'Password is not set yet. Complete first-time setup first.'
            : 'Incorrect email or password.',
      });
    }

    const rawPw = req.body && req.body.password != null ? String(req.body.password) : '';
    const match = bcrypt.compareSync(rawPw, row.password_hash);
    if (!match) {
      return res.status(401).json({ ok: false, error: 'Incorrect email or password.' });
    }

    const sessionToken = issueAdminSessionToken(row.email);
    return res.json({ ok: true, token: sessionToken, email: row.email });
  } catch (err) {
    console.error('[admin-session] login', err);
    return res.status(500).json({ ok: false, error: 'Could not sign in.' });
  }
});

router.get('/me', requireAdmin, (req, res) => {
  res.json({ ok: true, email: req.adminEmail });
});

export default router;
