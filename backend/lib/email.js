import { Resend } from 'resend';

if (!process.env.RESEND_API_KEY) {
  throw new Error('RESEND_API_KEY is required');
}

const resend = new Resend(process.env.RESEND_API_KEY);

const FROM = process.env.EMAIL_FROM || 'District 6 Compliance <noreply@retail-odyssey.com>';
const SUPERVISOR = process.env.EMAIL_TO || 'april.gauthier@retailodyssey.com';

function trimAddr(value) {
  if (value == null || value === '') return undefined;
  const t = String(value).trim();
  return t || undefined;
}

function resolveReplyToDistrict({ explicit, userEmail } = {}) {
  return (
    trimAddr(explicit) ||
    trimAddr(userEmail) ||
    trimAddr(process.env.RESEND_REPLY_TO) ||
    undefined
  );
}

function stampReplyTo(payload, opts) {
  const rt = resolveReplyToDistrict(opts);
  if (rt) payload.reply_to = rt;
}

export async function sendLinkEmail({ to, link }) {
  const subject = 'Your District 6 Policy Acknowledgement Link';
  const text = [
    'Hello,',
    '',
    'Use the link below to review and acknowledge the District 6 Spring 2026 policy set.',
    'This link is unique to you and expires in 30 days.',
    '',
    link,
    '',
    '— District 6 Compliance Hub',
  ].join('\n');
  const html = `
    <p>Hello,</p>
    <p>Use the link below to review and acknowledge the District 6 Spring 2026 policy set.
       This link is unique to you and expires in 30 days.</p>
    <p><a href="${link}">${link}</a></p>
    <p>— District 6 Compliance Hub</p>
  `;
  const payload = { from: FROM, to, subject, text, html };
  stampReplyTo(payload, {});
  return resend.emails.send(payload);
}

export async function sendAdminPasswordResetEmail({ to, resetUrl }) {
  const subject = 'Reset your District 6 admin password';
  const text = [
    'Hello,',
    '',
    'Someone requested a password reset for your District 6 Compliance Hub administrator account.',
    'Open the secure link below. It expires in one hour.',
    '',
    resetUrl,
    '',
    'If you did not request this, you can safely ignore this message.',
    '',
    '— District 6 Compliance Hub',
  ].join('\n');
  const safeUrl = escapeHtml(resetUrl);
  const html = `
    <p>Hello,</p>
    <p>Someone requested a password reset for your District 6 Compliance Hub administrator account.
       Open the secure link below. It expires in <strong>one hour</strong>.</p>
    <p><a href="${safeUrl}">${safeUrl}</a></p>
    <p>If you did not request this, you can safely ignore this message.</p>
    <p>— District 6 Compliance Hub</p>
  `;
  const payload = { from: FROM, to, subject, text, html };
  stampReplyTo(payload, {});
  return resend.emails.send(payload);
}

export async function sendSignedReceipt({ signerEmail, fullName, signedAtPacific, pdfBuffer }) {
  const subject = `Policy Acknowledgement — ${fullName} — Spring 2026 Edition`;
  const text = [
    `${fullName} has acknowledged the District 6 Spring 2026 policy set on ${signedAtPacific}.`,
    '',
    'Documents acknowledged:',
    '• Attendance & Timekeeping Policy',
    '• Dress Code Policy',
    '• Standard Operating Procedures',
    '',
    'The signed acknowledgement is attached to this email as a PDF.',
    '',
    '— District 6 Compliance Hub',
  ].join('\n');
  const html = `
    <p>${escapeHtml(fullName)} has acknowledged the District 6 Spring 2026 policy set on ${escapeHtml(signedAtPacific)}.</p>
    <p>Documents acknowledged:</p>
    <ul>
      <li>Attendance &amp; Timekeeping Policy</li>
      <li>Dress Code Policy</li>
      <li>Standard Operating Procedures</li>
    </ul>
    <p>The signed acknowledgement is attached to this email as a PDF.</p>
    <p>— District 6 Compliance Hub</p>
  `;
  const filename = `acknowledgement-${fullName.replace(/[^a-z0-9]+/gi, '-')}-spring-2026.pdf`;
  const payload = {
    from: FROM,
    to: SUPERVISOR,
    cc: signerEmail,
    subject,
    text,
    html,
    attachments: [
      {
        filename,
        content: pdfBuffer.toString('base64'),
      },
    ],
  };
  stampReplyTo(payload, { userEmail: signerEmail });
  return resend.emails.send(payload);
}

/** Sent to the requester when their access is approved and the magic link is ready. */
export async function sendAccessApprovedEmail({ to, name, link }) {
  const subject = 'You\'re approved — District 6 Compliance Hub';
  const greeting = name ? `Hi ${escapeHtml(name)},` : 'Hello,';
  const safeLink = escapeHtml(link);
  const html = `
    <div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;max-width:520px;margin:0 auto;padding:32px 16px;color:#1f2937;">
      <h2 style="color:#1a3a6e;margin:0 0 16px;">${greeting}</h2>
      <p style="margin:0 0 12px;">Great news — your access to the District 6 Compliance Hub has been approved.</p>
      <p style="margin:0 0 24px;">Click the button below to sign in. This link is unique to you and expires in 30 days.</p>
      <p style="margin:0 0 24px;">
        <a href="${safeLink}" style="display:inline-block;background:#1a3a6e;color:#fff;padding:14px 28px;border-radius:8px;text-decoration:none;font-weight:600;font-size:15px;">Sign in to District 6 Compliance Hub</a>
      </p>
      <p style="color:#6b7280;font-size:13px;margin:0;">Can't click the button? Copy and paste this link:<br>${safeLink}</p>
      <p style="margin-top:24px;color:#9ca3af;font-size:12px;">— District 6 Compliance Hub</p>
    </div>
  `;
  const text = [
    greeting,
    '',
    'Great news — your access to the District 6 Compliance Hub has been approved.',
    'Use the link below to sign in. It is unique to you and expires in 30 days.',
    '',
    link,
    '',
    '— District 6 Compliance Hub',
  ].join('\n');
  const payload = { from: FROM, to, subject, text, html };
  stampReplyTo(payload, {});
  return resend.emails.send(payload);
}

/** Sent to each approver with Approve / Deny buttons pointing to the Railway backend. */
export async function sendAccessRequestApprovalEmail({ record, approverEmail, approveUrl, denyUrl }) {
  const reasonRow = record.reason
    ? `<tr><td style="padding:6px 0;color:#6b7280;font-size:13px;vertical-align:top;">Reason / supervisor</td>
           <td style="padding:6px 0 6px 16px;font-size:14px;">${escapeHtml(record.reason)}</td></tr>`
    : '';
  const html = `
    <div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:#f4f6fa;padding:32px 16px;">
    <div style="background:#fff;border-radius:12px;box-shadow:0 4px 12px rgba(0,0,0,.08);padding:32px;max-width:520px;margin:0 auto;border:1px solid #e5e7eb;">
      <h2 style="margin:0 0 4px;color:#1a3a6e;font-size:18px;">Access request — District 6 Compliance Hub</h2>
      <p style="margin:0 0 20px;color:#6b7280;font-size:14px;">Someone needs access. You and the other manager both received this — first click wins.</p>
      <table style="width:100%;border-collapse:collapse;margin-bottom:24px;">
        <tr>
          <td style="padding:6px 0;color:#6b7280;font-size:13px;vertical-align:top;">Name</td>
          <td style="padding:6px 0 6px 16px;font-size:14px;font-weight:600;">${escapeHtml(record.name || '—')}</td>
        </tr>
        <tr>
          <td style="padding:6px 0;color:#6b7280;font-size:13px;vertical-align:top;">Email</td>
          <td style="padding:6px 0 6px 16px;font-size:14px;">${escapeHtml(record.email)}</td>
        </tr>
        ${reasonRow}
      </table>
      <table style="width:100%;border-collapse:collapse;">
        <tr>
          <td style="padding-right:8px;">
            <a href="${escapeHtml(approveUrl)}"
               style="display:block;background:#15803d;color:#fff;text-align:center;padding:14px;border-radius:8px;text-decoration:none;font-weight:600;font-size:15px;">
              ✓ Approve
            </a>
          </td>
          <td style="padding-left:8px;">
            <a href="${escapeHtml(denyUrl)}"
               style="display:block;background:#b91c1c;color:#fff;text-align:center;padding:14px;border-radius:8px;text-decoration:none;font-weight:600;font-size:15px;">
              ✗ Deny
            </a>
          </td>
        </tr>
      </table>
      <p style="margin-top:16px;color:#9ca3af;font-size:12px;">
        Approve adds this person to the access list and sends them a sign-in link immediately.
      </p>
    </div></div>
  `;
  const text = [
    `Access request — District 6 Compliance Hub`,
    '',
    `Name: ${record.name || '—'}`,
    `Email: ${record.email}`,
    record.reason ? `Reason: ${record.reason}` : '',
    '',
    `Approve: ${approveUrl}`,
    `Deny: ${denyUrl}`,
  ].filter((l) => l !== null).join('\n');
  const payload = {
    from: FROM,
    to: approverEmail,
    subject: `Access request: ${record.name || record.email} (${record.email})`,
    text,
    html,
  };
  stampReplyTo(payload, { explicit: record.email });
  return resend.emails.send(payload);
}

/** Sent to the requester when their request is denied. */
export async function sendAccessRequestDenialEmail({ to, name }) {
  const greeting = name ? `Hi ${escapeHtml(name)},` : 'Hello,';
  const html = `
    <div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;max-width:520px;margin:0 auto;padding:32px 16px;color:#1f2937;">
      <h2 style="color:#1a3a6e;margin:0 0 16px;">${greeting}</h2>
      <p style="margin:0 0 12px;">Your request to access the District 6 Compliance Hub has been reviewed and was not approved at this time.</p>
      <p style="margin:0 0 0;color:#6b7280;font-size:14px;">If you believe this is an error, please contact your District 6 supervisor directly.</p>
      <p style="margin-top:24px;color:#9ca3af;font-size:12px;">— District 6 Compliance Hub</p>
    </div>
  `;
  const text = [
    greeting,
    '',
    'Your request to access the District 6 Compliance Hub has been reviewed and was not approved at this time.',
    '',
    'If you believe this is an error, please contact your District 6 supervisor directly.',
    '',
    '— District 6 Compliance Hub',
  ].join('\n');
  const payload = { from: FROM, to, subject: 'District 6 Compliance Hub — Access request update', text, html };
  stampReplyTo(payload, {});
  return resend.emails.send(payload);
}

/** Sent to the other approver to inform them a decision was already made. */
export async function sendAccessRequestOtherApproverEmail({ to, decidedBy, action, record }) {
  const label = action === 'approve' ? 'approved' : 'denied';
  const outcomeColor = action === 'approve' ? '#15803d' : '#b91c1c';
  const outcomeBg    = action === 'approve' ? '#ecfdf5' : '#fef2f2';
  const outcomeBorder = action === 'approve' ? '#bbf7d0' : '#fecaca';
  const detail = action === 'approve'
    ? `A sign-in link was sent automatically to <strong>${escapeHtml(record.email)}</strong>.`
    : `<strong>${escapeHtml(record.name || record.email)}</strong> was notified that their request was not approved.`;
  const reasonRow = record.reason
    ? `<tr><td style="color:#6b7280;padding:4px 12px 4px 0;font-size:13px;vertical-align:top;">Reason</td><td style="font-size:14px;padding:4px 0;">${escapeHtml(record.reason)}</td></tr>`
    : '';
  const html = `
    <div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:#f4f6fa;padding:32px 16px;">
    <div style="background:#fff;border-radius:12px;box-shadow:0 4px 12px rgba(0,0,0,.08);padding:32px;max-width:520px;margin:0 auto;border:1px solid #e5e7eb;">
      <h2 style="margin:0 0 4px;color:#1a3a6e;font-size:18px;">Access request — District 6 Compliance Hub</h2>
      <p style="margin:0 0 20px;color:#6b7280;font-size:14px;">You received a copy of this request. No action needed — it's already been handled.</p>

      <div style="background:${outcomeBg};border:1px solid ${outcomeBorder};border-radius:8px;padding:12px 16px;margin-bottom:20px;font-size:14px;color:${outcomeColor};">
        <strong>${escapeHtml(decidedBy)}</strong> already <strong>${label}</strong> this request. ${detail}
      </div>

      <table style="width:100%;border-collapse:collapse;font-size:14px;">
        <tr><td style="color:#6b7280;padding:4px 12px 4px 0;vertical-align:top;">Name</td><td style="padding:4px 0;font-weight:600;">${escapeHtml(record.name || '—')}</td></tr>
        <tr><td style="color:#6b7280;padding:4px 12px 4px 0;vertical-align:top;">Email</td><td style="padding:4px 0;">${escapeHtml(record.email)}</td></tr>
        ${reasonRow}
      </table>
      <p style="margin-top:20px;color:#9ca3af;font-size:12px;">— District 6 Compliance Hub</p>
    </div></div>
  `;
  const text = [
    `[FYI] Access request ${label} — District 6 Compliance Hub`,
    '',
    `${decidedBy} already ${label} this request. No action needed.`,
    '',
    `Name:  ${record.name || '—'}`,
    `Email: ${record.email}`,
    record.reason ? `Reason: ${record.reason}` : '',
    '',
    action === 'approve'
      ? `A sign-in link was sent automatically to ${record.email}.`
      : `${record.name || record.email} was notified that their request was not approved.`,
  ].filter((l) => l !== null).join('\n');
  const payload = {
    from: FROM,
    to,
    subject: `[FYI] Access request ${label}: ${record.name || record.email} (${record.email})`,
    text,
    html,
  };
  stampReplyTo(payload, { explicit: decidedBy });
  return resend.emails.send(payload);
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}
