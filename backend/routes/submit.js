import express from 'express';
import { verifyToken } from '../lib/tokens.js';
import { pool } from '../lib/db.js';
import { buildSignedReceiptPDF } from '../lib/pdf.js';
import { flushReceiptEmailOutboxOnce } from '../lib/receipt-email-outbox.js';
import { lookupIpLocation, formatLocation } from '../lib/geo.js';
import {
  listActiveRequiredPolicyDocs,
  findMissingRequiredDocViews,
} from '../lib/component-store.js';

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

  // Every active required row in policy_documents needs a valid viewed
  // timestamp — the set is driven by the published Acknowledgement page, not
  // a fixed key list.
  let requiredDocs;
  try {
    requiredDocs = await listActiveRequiredPolicyDocs();
  } catch (err) {
    console.error('[submit] policy docs lookup failed', err);
    return res.status(500).json({ ok: false, error: 'Could not load the policy list.' });
  }
  const missingDocs = findMissingRequiredDocViews(requiredDocs, viewTimestamps);
  if (missingDocs.length > 0) {
    return res.status(400).json({
      ok: false,
      error: `A viewed timestamp is required for: ${missingDocs.map((d) => d.title).join(', ')}.`,
    });
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
  const signedAt = new Date();

  // Best-effort IP geolocation. Cached + tightly timeboxed inside lookupIpLocation
  // so a slow geo provider can't stall the submission. Result may be null.
  const ipLocation = await lookupIpLocation(ip);
  const locationStr = formatLocation(ipLocation);

  // Build the receipt document list from the required policy rows (order and
  // titles as published) and the signer's view timestamps.
  const documents = requiredDocs.map((doc) => ({
    key: doc.doc_key,
    name: doc.title,
    viewedAt: viewTimestamps[doc.doc_key],
  }));

  // Build the PDF outside the DB transaction. Inputs are all from the request body, so
  // the row lock on link_requests doesn't need to cover ~200–800ms of headless Chromium
  // rendering. Worst case on a concurrent double-submit: we waste one PDF render before
  // the FOR UPDATE check rejects the second one. That's cheaper than holding the lock.
  let pdfBuffer;
  try {
    pdfBuffer = await buildSignedReceiptPDF({
      fullName: trimmedName,
      email,
      docVersion: 'Spring 2026 Edition',
      documents,
      agreedAt,
      signedAt,
      ip,
      location: locationStr,
      signatureDataUrl,
    });
  } catch (err) {
    console.error('[submit] pdf build failed', err);
    return res.status(500).json({ ok: false, error: 'Could not build receipt.' });
  }

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

    const { rows: inserted } = await client.query(
      `INSERT INTO signatures (
         email, full_name, signature_data_url, doc_version,
         attendance_viewed_at, dress_code_viewed_at, sop_viewed_at, doc_views,
         agreed_at, signed_at, ip, user_agent, jti, pdf_bytes, location
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
       RETURNING id`,
      [
        email,
        trimmedName,
        signatureDataUrl,
        'Spring 2026 Edition',
        // Legacy columns kept for rows already stored; nullable for new doc sets.
        viewTimestamps.attendance || null,
        viewTimestamps.dressCode || null,
        viewTimestamps.sop || null,
        JSON.stringify(viewTimestamps),
        agreedAt,
        signedAt,
        ip,
        ua,
        jti,
        pdfBuffer,
        locationStr,
      ],
    );

    await client.query(
      `INSERT INTO receipt_email_outbox (signature_id) VALUES ($1)`,
      [inserted[0].id],
    );

    await client.query(
      `UPDATE link_requests SET used_at = NOW() WHERE jti = $1`,
      [jti],
    );

    await client.query('COMMIT');

    // Supervisor receipt emails are drained by `receipt-email-outbox` (immediate burst + cron).
    flushReceiptEmailOutboxOnce(pool).catch((err) =>
      console.error('[submit] receipt outbox flush failed', err),
    );

    console.log(`[submit] signed jti=${jti.slice(0, 6)}… by ${email}`);
    return res.json({ ok: true, receiptEmailQueued: true });
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch {}
    console.error('[submit] error', err);
    return res.status(500).json({ ok: false, error: 'Could not record signature.' });
  } finally {
    client.release();
  }
});

export default router;
