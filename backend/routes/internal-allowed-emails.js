import express from 'express';
import crypto from 'node:crypto';
import { query } from '../lib/db.js';
import { issueToken } from '../lib/tokens.js';
import { sendAccessApprovedEmail } from '../lib/email.js';
import { isCorporateWorkDomainEmail } from '../lib/allowed-emails.js';

const router = express.Router();
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function verifyServiceToken(req) {
  const provided = String(req.headers['x-service-token'] || '');
  const expected = process.env.ACCESS_REQUEST_SERVICE_TOKEN || '';
  if (!expected || !provided) return false;
  try {
    return crypto.timingSafeEqual(Buffer.from(provided), Buffer.from(expected));
  } catch {
    return false;
  }
}

router.post('/', async (req, res) => {
  if (!verifyServiceToken(req)) {
    return res.status(401).json({ ok: false, error: 'Unauthorized' });
  }

  try {
    const rawEmail = req.body?.email ? String(req.body.email) : '';
    const email = rawEmail.trim().toLowerCase();
    const name = req.body?.name ? String(req.body.name).trim().slice(0, 200) : '';
    const note = req.body?.note ? String(req.body.note).trim().slice(0, 500) : null;
    const sendLoginLink = req.body?.sendLoginLink === true;

    if (!email || !EMAIL_RE.test(email)) {
      return res.status(400).json({ ok: false, error: 'Invalid email address.' });
    }
    if (isCorporateWorkDomainEmail(email)) {
      return res.status(400).json({ ok: false, error: 'Corporate domain emails are automatically allowed.' });
    }

    await query(
      `INSERT INTO allowed_emails (email, note)
       VALUES ($1, $2)
       ON CONFLICT (email) DO UPDATE SET
         note = EXCLUDED.note,
         updated_at = NOW()`,
      [email, note],
    );
    console.log(`[internal-allowed-emails] upserted ${email}`);

    if (sendLoginLink) {
      const { token, jti } = issueToken(email);
      const ip = null;
      const ua = 'access-request-auto-link';

      await query(
        `INSERT INTO link_requests (email, jti, ip, user_agent) VALUES ($1, $2, $3, $4)`,
        [email, jti, ip, ua],
      );

      const base = (process.env.FRONTEND_BASE_URL || '').replace(/\/+$/, '');
      const link = `${base}/sign.html?token=${encodeURIComponent(token)}`;

      await sendAccessApprovedEmail({ to: email, name, link });
      console.log(`[internal-allowed-emails] issued magic link jti=${jti.slice(0, 6)}… for ${email}`);
    }

    return res.json({ ok: true });
  } catch (err) {
    console.error('[internal-allowed-emails] error', err);
    return res.status(500).json({ ok: false, error: 'Internal error.' });
  }
});

export default router;
