import express from 'express';
import rateLimit from 'express-rate-limit';
import { isEmailAllowed, isCorporateWorkDomainEmail, corporateDomainListForMessage } from '../lib/allowed-emails.js';

const router = express.Router();

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const limiter = rateLimit({
  windowMs: 60 * 60 * 1000, // 1 hour
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  message: { ok: false, error: 'Too many requests. Try again later.' },
});

router.post('/', limiter, async (req, res) => {
  try {
    const rawEmail = req.body?.email ? String(req.body.email) : '';
    const email = rawEmail.trim().toLowerCase();
    const rawName = req.body?.name ? String(req.body.name) : '';
    const name = rawName.trim().slice(0, 200);
    const rawReason = req.body?.reason ? String(req.body.reason) : '';
    const reason = rawReason.trim().slice(0, 1000);

    if (!email || !EMAIL_RE.test(email)) {
      return res.status(400).json({ ok: false, error: 'Please enter a valid email address.' });
    }
    if (!name) {
      return res.status(400).json({ ok: false, error: 'Please enter your full name.' });
    }

    if (isCorporateWorkDomainEmail(email)) {
      return res.status(400).json({
        ok: false,
        error: `Work addresses (${corporateDomainListForMessage()}) are automatically allowed. Try requesting your link directly on the main page.`,
      });
    }

    const alreadyAllowed = await isEmailAllowed(email);
    if (alreadyAllowed) {
      return res.status(400).json({
        ok: false,
        error: 'This email is already on the access list. Go back and request your link directly.',
      });
    }

    const flowAutomationUrl = (process.env.FLOW_AUTOMATION_URL || '').replace(/\/+$/, '');
    if (!flowAutomationUrl) {
      console.error('[access-request] FLOW_AUTOMATION_URL is not set');
      return res.status(500).json({ ok: false, error: 'Service misconfiguration. Please contact your supervisor.' });
    }

    const serviceToken = process.env.ACCESS_REQUEST_SERVICE_TOKEN || '';
    if (!serviceToken) {
      console.error('[access-request] ACCESS_REQUEST_SERVICE_TOKEN is not set');
      return res.status(500).json({ ok: false, error: 'Service misconfiguration. Please contact your supervisor.' });
    }

    const faRes = await fetch(`${flowAutomationUrl}/access-requests`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Service-Token': serviceToken,
      },
      body: JSON.stringify({ name, email, reason }),
    });

    if (!faRes.ok) {
      const faBody = await faRes.json().catch(() => ({}));
      console.error('[access-request] flow-automation error', faRes.status, faBody);
      return res.status(500).json({ ok: false, error: 'Could not submit your request. Please try again.' });
    }

    console.log(`[access-request] request submitted for ${email}`);
    return res.json({ ok: true });
  } catch (err) {
    console.error('[access-request] error', err);
    return res.status(500).json({ ok: false, error: 'Could not submit your request. Please try again.' });
  }
});

export default router;
