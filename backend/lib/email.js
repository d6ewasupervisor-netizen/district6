import { Resend } from 'resend';

if (!process.env.RESEND_API_KEY) {
  throw new Error('RESEND_API_KEY is required');
}

const resend = new Resend(process.env.RESEND_API_KEY);

const FROM = process.env.EMAIL_FROM || 'District 6 Compliance <noreply@retail-odyssey.com>';
const SUPERVISOR = process.env.EMAIL_TO || 'april.gauthier@retailodyssey.com';

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
  return resend.emails.send({ from: FROM, to, subject, text, html });
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
  return resend.emails.send({ from: FROM, to, subject, text, html });
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
  return resend.emails.send({
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
  });
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}
