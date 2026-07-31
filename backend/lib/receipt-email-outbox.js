/**
 * Durably delivers signed receipt PDF emails to EMAIL_TO via Resend.
 * Rows are inserted in the same DB transaction as the signature; this module
 * processes pending rows with exponential backoff retries.
 */

import {
  scheduleInterval,
  backoffSecondsForAttempt,
  maxSendAttempts,
} from './receipt-email-outbox-config.js';
import { sendSignedReceipt } from './email.js';
import { formatPacific } from './pdf.js';

/**
 * One outbound drain runs at a time per Node process. The DB transaction releases
 * before Resend returns; serialization prevents overlapping drains from emailing twice.
 */

let receiptDrainTail = Promise.resolve();

function runReceiptOutboxDrainSerialized(fn) {
  const started = receiptDrainTail.then(() => fn());
  receiptDrainTail = started.catch(() => {});
  return started;
}

/**
 * Claims up to `limit` pending rows, increments attempts (claim counter), commits, then sends.
 */
export async function processReceiptEmailOutbox(pool, opts) {
  return runReceiptOutboxDrainSerialized(() => processReceiptEmailOutboxImpl(pool, opts));
}

async function processReceiptEmailOutboxImpl(pool, { limit = 10 } = {}) {
  const maxAttempts = maxSendAttempts();
  const claimClient = await pool.connect();
  let rows;
  try {
    await claimClient.query('BEGIN');
    const { rows: claimed } = await claimClient.query(
      `
      WITH picked AS (
        SELECT id
        FROM receipt_email_outbox
        WHERE sent_at IS NULL
          AND next_attempt_at <= NOW()
          AND ($2 <= 0 OR attempts < $2)
        ORDER BY next_attempt_at ASC, id ASC
        FOR UPDATE SKIP LOCKED
        LIMIT $1
      )
      UPDATE receipt_email_outbox o
      SET attempts = o.attempts + 1
      FROM picked
      WHERE o.id = picked.id
      RETURNING o.id, o.signature_id, o.attempts AS attempt_no
      `,
      [limit, maxAttempts],
    );
    rows = claimed;
    await claimClient.query('COMMIT');
  } catch (err) {
    await claimClient.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    claimClient.release();
  }

  if (!rows.length) return { processed: 0, succeeded: 0, failed: 0 };

  let succeeded = 0;
  let failed = 0;

  for (const row of rows) {
    const ok = await sendOneQueuedReceipt(pool, row);
    if (ok) succeeded += 1;
    else failed += 1;
  }

  return { processed: rows.length, succeeded, failed };
}

async function sendOneQueuedReceipt(pool, { id: outboxId, signature_id: signatureId, attempt_no: attemptNo }) {
  try {
    const { rows } = await pool.query(
      `SELECT id, email, full_name, signed_at, pdf_bytes
       FROM signatures
       WHERE id = $1`,
      [signatureId],
    );
    if (!rows.length) {
      console.error(`[receipt-outbox] missing signature row id=${signatureId} outbox=${outboxId}`);
      await pool.query(
        `UPDATE receipt_email_outbox
         SET last_error = $2,
             next_attempt_at = NOW() + $3::INTERVAL
         WHERE id = $1`,
        [
          outboxId,
          'signature row missing (cannot send)',
          `${backoffSecondsForAttempt(attemptNo)} seconds`,
        ],
      );
      return false;
    }

    const sig = rows[0];
    if (!sig.pdf_bytes || !sig.pdf_bytes.length) {
      await pool.query(
        `UPDATE receipt_email_outbox
         SET last_error = $2,
             next_attempt_at = NOW() + $3::INTERVAL
         WHERE id = $1`,
        [
          outboxId,
          'pdf_bytes missing on signature row',
          `${backoffSecondsForAttempt(attemptNo)} seconds`,
        ],
      );
      console.error(`[receipt-outbox] empty pdf_bytes signature_id=${signatureId}`);
      return false;
    }

    let resendEmailId = null;
    try {
      const sendResult = await sendSignedReceipt({
        signerEmail: sig.email,
        fullName: sig.full_name,
        signedAtPacific: formatPacific(sig.signed_at),
        pdfBuffer: Buffer.isBuffer(sig.pdf_bytes) ? sig.pdf_bytes : Buffer.from(sig.pdf_bytes),
      });
      resendEmailId = sendResult?.id || null;
    } catch (err) {
      const msg = err?.message || String(err);
      const delay = backoffSecondsForAttempt(attemptNo);
      await pool.query(
        `UPDATE receipt_email_outbox
         SET last_error = $2,
             next_attempt_at = NOW() + $3::INTERVAL
         WHERE id = $1 AND sent_at IS NULL`,
        [outboxId, msg.slice(0, 8000), `${delay} seconds`],
      );
      console.error(
        `[receipt-outbox] Resend failed outbox=${outboxId} signature=${signatureId} attempt=${attemptNo} backoffSec=${delay}:`,
        err,
      );
      return false;
    }

    const { rowCount } = await pool.query(
      `UPDATE receipt_email_outbox
       SET sent_at = NOW(),
           last_error = NULL,
           resend_email_id = COALESCE(resend_email_id, $2)
       WHERE id = $1 AND sent_at IS NULL`,
      [outboxId, resendEmailId],
    );
    if (rowCount === 0) return true;

    console.log(
      `[receipt-outbox] delivered receipt email outbox=${outboxId} signature=${signatureId} resend=${resendEmailId || 'n/a'}`,
    );
    return true;
  } catch (unexpected) {
    console.error('[receipt-outbox] unexpected pipeline error', unexpected);
    return false;
  }
}

/** Run all pending deliveries once (cheap — used right after enqueue + on wake). */
export async function flushReceiptEmailOutboxOnce(pool, { batches = 3, batchLimit = 5 } = {}) {
  let total = { processed: 0, succeeded: 0, failed: 0 };
  for (let i = 0; i < batches; i += 1) {
    const r = await processReceiptEmailOutbox(pool, { limit: batchLimit });
    total = {
      processed: total.processed + r.processed,
      succeeded: total.succeeded + r.succeeded,
      failed: total.failed + r.failed,
    };
    if (r.processed === 0) break;
  }
  return total;
}

export function startReceiptEmailOutboxWorker(pool) {
  const ms = scheduleInterval();

  async function tick() {
    try {
      const r = await processReceiptEmailOutbox(pool, { limit: 25 });
      if (r.failed > 0 && r.processed > 0) {
        console.warn(`[receipt-outbox-worker] cycle: processed=${r.processed} succeeded=${r.succeeded} failed=${r.failed}`);
      }
    } catch (err) {
      console.error('[receipt-outbox-worker] tick failed', err);
    }
  }

  console.log(`[receipt-outbox-worker] polling every ${ms}ms`);

  tick();
  return setInterval(tick, ms);
}
