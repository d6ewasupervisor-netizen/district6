// backend/routes/access-request-decision.js
//
// Handles approve/deny clicks from the approval email.
// These are regular browser GET requests (the user clicks a link in email),
// so they return full HTML pages, not JSON.
// Hosted on Railway so no tunnel/ngrok required.

import express from 'express';
import crypto from 'node:crypto';
import { query } from '../lib/db.js';
import { issueToken } from '../lib/tokens.js';
import { getAccessRequest, markAccessRequestDecided } from '../lib/access-requests-db.js';
import { computeDecisionToken, getApprovers } from './access-request.js';
import {
  sendAccessApprovedEmail,
  sendAccessRequestDenialEmail,
  sendAccessRequestOtherApproverEmail,
} from '../lib/email.js';

const router = express.Router();

// ── HTML helpers ─────────────────────────────────────────────────────────────

function esc(s) {
  return String(s || '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

function formatDatetime(iso) {
  if (!iso) return 'unknown time';
  return new Date(iso).toLocaleString('en-US', {
    timeZone: 'America/Los_Angeles',
    month: 'short', day: 'numeric', year: 'numeric',
    hour: 'numeric', minute: '2-digit', timeZoneName: 'short',
  });
}

const PAGE_CSS = `
  <meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
  <style>
    body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;background:#f4f6fa;margin:0;padding:40px 16px;color:#1f2937}
    .card{background:#fff;border-radius:12px;box-shadow:0 4px 12px rgba(0,0,0,.08);padding:32px;max-width:500px;margin:0 auto;border:1px solid #e5e7eb}
    h1{font-size:20px;color:#1a3a6e;margin:0 0 16px}
    p{margin:0 0 10px;font-size:15px;line-height:1.55}
    .detail{background:#f8fafc;border:1px solid #e5e7eb;border-radius:8px;padding:14px 16px;margin:16px 0;font-size:14px}
    .detail .row{margin-bottom:6px}
    .detail dt{font-weight:600;color:#1a3a6e;display:inline}
    .detail dd{display:inline;margin:0}
    .ok{display:inline-block;background:#ecfdf5;color:#15803d;border:1px solid #bbf7d0;border-radius:6px;padding:2px 10px;font-size:13px}
    .deny{display:inline-block;background:#fef2f2;color:#b91c1c;border:1px solid #fecaca;border-radius:6px;padding:2px 10px;font-size:13px}
    .muted{color:#6b7280;font-size:13px}
    .warn{background:#fffbeb;border:1px solid #fde68a;color:#92400e;border-radius:8px;padding:12px 14px;font-size:14px;margin-top:16px}
  </style>`;

function detailHtml(record) {
  return `<div class="detail">
    <div class="row"><dt>Name: </dt><dd>${esc(record.name || '—')}</dd></div>
    <div class="row"><dt>Email: </dt><dd>${esc(record.email)}</dd></div>
    ${record.reason ? `<div class="row"><dt>Reason: </dt><dd>${esc(record.reason)}</dd></div>` : ''}
  </div>`;
}

function renderConfirmation(action, record, warning) {
  const label = action === 'approve' ? 'approved' : 'denied';
  const badge = action === 'approve' ? '<span class="ok">Approved</span>' : '<span class="deny">Denied</span>';
  const note = action === 'approve'
    ? `<p>A sign-in link has been sent to <strong>${esc(record.email)}</strong>.</p>`
    : `<p>${esc(record.name || record.email)} has been notified that their request was not approved.</p>`;
  const warnHtml = warning ? `<div class="warn"><strong>Note:</strong> ${esc(warning)}</div>` : '';
  return `<!DOCTYPE html><html><head>${PAGE_CSS}<title>Request ${label}</title></head>
<body><div class="card">
  <h1>Request ${label} ${badge}</h1>
  ${detailHtml(record)}
  ${note}
  <p class="muted">The other approver has been notified.</p>
  ${warnHtml}
</div></body></html>`;
}

function renderAlreadyDecided(record) {
  const label = record.decided_action === 'approve' ? 'approved' : 'denied';
  const badge = record.decided_action === 'approve' ? '<span class="ok">Approved</span>' : '<span class="deny">Denied</span>';
  return `<!DOCTYPE html><html><head>${PAGE_CSS}<title>Already decided</title></head>
<body><div class="card">
  <h1>Already ${label} ${badge}</h1>
  <p>This request was already <strong>${label}</strong> by
     <strong>${esc(record.decided_by || 'someone')}</strong>
     at ${esc(formatDatetime(record.decided_at))}.</p>
  <p class="muted">No action needed.</p>
  ${detailHtml(record)}
</div></body></html>`;
}

function renderError(title, msg) {
  return `<!DOCTYPE html><html><head>${PAGE_CSS}<title>${esc(title)}</title></head>
<body><div class="card"><h1>${esc(title)}</h1><p>${esc(msg)}</p></div></body></html>`;
}

// ── Decision handler ──────────────────────────────────────────────────────────

async function handleDecision(req, res, action) {
  const { id } = req.params;
  const { token, by: approverEmail } = req.query;

  if (!id || !token || !approverEmail) {
    return res.status(400).send(renderError('Invalid link', 'This link is missing required parameters.'));
  }

  // HMAC verification
  let expectedToken;
  try {
    expectedToken = computeDecisionToken(id, action, approverEmail);
  } catch {
    return res.status(500).send(renderError('Configuration error', 'The server is missing its signing key. Please contact your supervisor.'));
  }

  const tokBuf = Buffer.from(token, 'hex');
  const expBuf = Buffer.from(expectedToken, 'hex');
  const valid = tokBuf.length === expBuf.length && crypto.timingSafeEqual(tokBuf, expBuf);
  if (!valid) {
    return res.status(403).send(renderError('Invalid link', 'This link is invalid or has been tampered with.'));
  }

  // Look up the request
  const existing = await getAccessRequest(id);
  if (!existing) {
    return res.status(404).send(renderError('Request not found', 'This access request could not be found. It may have expired.'));
  }

  // First-click-wins atomic update
  const decided = await markAccessRequestDecided(id, action, approverEmail);
  if (!decided) {
    // Someone else already acted — re-fetch for the "already decided" page
    const current = await getAccessRequest(id);
    return res.send(renderAlreadyDecidedPage(current));
  }

  console.log(`[access-request-decision] ${action} by ${approverEmail} for request ${id} (${decided.email})`);

  // Notify the other approver(s)
  const approvers = getApprovers();
  for (const other of approvers) {
    if (other.toLowerCase() !== approverEmail.toLowerCase()) {
      try {
        await sendAccessRequestOtherApproverEmail({ to: other, decidedBy: approverEmail, action, record: decided });
      } catch (err) {
        console.error(`[access-request-decision] failed to notify other approver ${other}:`, err);
      }
    }
  }

  let warning = null;

  if (action === 'approve') {
    // Add to allowed_emails
    try {
      await query(
        `INSERT INTO allowed_emails (email, note)
         VALUES ($1, $2)
         ON CONFLICT (email) DO UPDATE SET note = EXCLUDED.note, updated_at = NOW()`,
        [decided.email, `Approved via access request by ${approverEmail} on ${formatDatetime(decided.decided_at)}`],
      );
    } catch (err) {
      console.error('[access-request-decision] failed to insert allowed_email:', err);
      warning = 'The approval was recorded but the email could not be added to the allowlist automatically. Please add it manually via the admin page.';
    }

    if (!warning) {
      // Issue magic link and send approved email
      try {
        const { token: jwt, jti } = issueToken(decided.email);
        await query(
          `INSERT INTO link_requests (email, jti, ip, user_agent) VALUES ($1, $2, $3, $4)`,
          [decided.email, jti, null, 'access-request-auto-link'],
        );
        const base = (process.env.FRONTEND_BASE_URL || '').replace(/\/+$/, '');
        const link = `${base}/sign.html?token=${encodeURIComponent(jwt)}`;
        await sendAccessApprovedEmail({ to: decided.email, name: decided.name, link });
        console.log(`[access-request-decision] magic link sent to ${decided.email}`);
      } catch (err) {
        console.error('[access-request-decision] failed to send magic link:', err);
        warning = 'The approval was recorded but the sign-in link email failed to send. Please send them a link manually from the admin page.';
      }
    }
  } else {
    // Send denial notice to requester
    try {
      await sendAccessRequestDenialEmail({ to: decided.email, name: decided.name });
    } catch (err) {
      console.error('[access-request-decision] failed to send denial email:', err);
    }
  }

  return res.send(renderConfirmation(action, decided, warning));
}

function renderAlreadyDecidedPage(record) {
  if (!record) return renderError('Not found', 'This access request could not be found.');
  return renderAlreadyDecided(record);
}

router.get('/:id/approve', (req, res) => handleDecision(req, res, 'approve'));
router.get('/:id/deny', (req, res) => handleDecision(req, res, 'deny'));

export default router;
