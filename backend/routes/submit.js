import express from 'express';
import { verifyToken } from '../lib/tokens.js';
import { query, pool } from '../lib/db.js';
import { buildSignedReceiptPDF, formatPacific } from '../lib/pdf.js';
import { sendSignedReceipt } from '../lib/email.js';

const router = express.Router();

function isIsoDate(s) {
  if (typeof s !== 'string') return false;
  const d = new Date(s);
  return !isNaN(d.getTime());
}

router.post('/', async (req, res) => {
  const body = req.body || {};
  const { token, fullName, signatureDataUrl, agreedAt, viewTimestamps } = body;

  if (!token || typeof token !== 'string') {
    return res.status(400).json({ ok: false, error: 'Missing token.' });
  }
  if (!fullName || typeof fullName !== 'string' || fullName.trim().length < 2) {
    return res.status(400).json({ ok: false, error: 'Full name is required.' });
  }
  if (!signatureDataUrl || typeof signatureDataUrl !== 'string' || !signatureDataUrl.startsWith('data:image/')) {
    return res.status(400).json({ ok: false, error: 'Signature is required.' });
  }
  if (!isIsoDate(agreedAt)) {
    return res.status(400).json({ ok: false, error: 'Invalid agreement timestamp.' });
  }
  if (!viewTimestamps || typeof viewTimestamps !== 'object') {
    return res.status(400).json({ ok: false, error: 'Missing view timestamps.' });
  }
  const { attendance, dressCode, sop } = viewTimestamps;
  if (!isIsoDate(attendance) || !isIsoDate(dressCode) || !isIsoDate(sop)) {
    return res.status(400).json({ ok: false, error: 'Invalid view timestamps.' });
  }

  let payload;
  try {
    payload = verifyToken(token);
  } catch (err) {
    return res.status(400).json({ ok: false, error: 'This link is invalid or expired.' });
  }

  const { jti, email } = payload;
  const ip = req.ip;
  const ua = req.get('user-agent') || null;
  const trimmedName = fullName.trim();

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const { rows: lockRows } = await client.query(
      `SELECT used_at FROM link_requests WHERE jti = $1 FOR UPDATE`,
      [jti],
    );
    if (lockRows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(400).json({ ok: false, error: 'Link not recognized.' });
    }
    if (lockRows[0].used_at) {
      await client.query('ROLLBACK');
      return res.status(400).json({ ok: false, error: 'This link has already been used.' });
    }

    const signedAt = new Date();

    const pdfBuffer = await buildSignedReceiptPDF({
      fullName: trimmedName,
      email,
      docVersion: 'Spring 2026 Edition',
      attendanceViewedAt: attendance,
      dressCodeViewedAt: dressCode,
      sopViewedAt: sop,
      agreedAt,
      signedAt,
      ip,
      signatureDataUrl,
    });

    await client.query(
      `INSERT INTO signatures (
         email, full_name, signature_data_url, doc_version,
         attendance_viewed_at, dress_code_viewed_at, sop_viewed_at,
         agreed_at, signed_at, ip, user_agent, jti, pdf_bytes
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
      [
        email,
        trimmedName,
        signatureDataUrl,
        'Spring 2026 Edition',
        attendance,
        dressCode,
        sop,
        agreedAt,
        signedAt,
        ip,
        ua,
        jti,
        pdfBuffer,
      ],
    );

    await client.query(
      `UPDATE link_requests SET used_at = NOW() WHERE jti = $1`,
      [jti],
    );

    await client.query('COMMIT');

    try {
      await sendSignedReceipt({
        signerEmail: email,
        fullName: trimmedName,
        signedAtPacific: formatPacific(signedAt),
        pdfBuffer,
      });
    } catch (mailErr) {
      console.error('[submit] email send failed (signature stored)', mailErr);
      // Signature is recorded; surface a soft warning so frontend can still redirect.
      return res.json({ ok: true, emailWarning: 'Receipt saved but email delivery failed.' });
    }

    console.log(`[submit] signed jti=${jti.slice(0, 6)}… by ${email}`);
    return res.json({ ok: true });
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch {}
    console.error('[submit] error', err);
    return res.status(500).json({ ok: false, error: 'Could not record signature.' });
  } finally {
    client.release();
  }
});

export default router;
