/*
 * Receipt PDF facade.
 *
 * Historically this module rendered the acknowledgement receipt directly
 * with pdfkit. As of the Spring 2026 redesign, generation is handled by
 * backend/lib/receipt-renderer.js (Handlebars template → headless Chromium
 * → PDF). This file remains as a thin adapter so callers (routes/submit.js,
 * lib/email.js) need no changes:
 *   - buildSignedReceiptPDF() keeps the same arguments and Buffer return.
 *   - formatPacific() keeps the same shape (used by routes/submit.js for
 *     the email body).
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { renderReceiptPDF } from './receipt-renderer.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const LOGO_CANDIDATES = [
  path.resolve(__dirname, '..', 'assets', 'logo.png'),
  path.resolve(__dirname, '..', '..', 'frontend', 'assets', 'logo.png'),
];

// Read the logo once at module load and cache as a data URL. Inlining keeps
// the template self-contained — no file:// URLs, no <base href>, no asset
// resolution inside Chromium. If the logo is missing we render without it.
const logoDataUrl = (() => {
  for (const p of LOGO_CANDIDATES) {
    try {
      if (fs.existsSync(p)) {
        const buf = fs.readFileSync(p);
        return `data:image/png;base64,${buf.toString('base64')}`;
      }
    } catch {
      // Try the next candidate.
    }
  }
  return null;
})();

export function formatPacific(iso) {
  const date = iso instanceof Date ? iso : new Date(iso);
  return new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Los_Angeles',
    year: 'numeric',
    month: 'short',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: true,
    timeZoneName: 'short',
  }).format(date);
}

export async function buildSignedReceiptPDF({
  fullName,
  email,
  docVersion,
  attendanceViewedAt,
  dressCodeViewedAt,
  sopViewedAt,
  agreedAt,
  signedAt,
  ip,
  location,
  signatureDataUrl,
}) {
  // Pre-format every timestamp so the template never does date math. Order
  // and labels here are the contract with backend/lib/templates/receipt.html.
  const documents = [
    {
      key: 'attendance',
      name: 'Attendance & Timekeeping Policy',
      viewedAtPacific: formatPacific(attendanceViewedAt),
    },
    {
      key: 'dressCode',
      name: 'Dress Code Policy',
      viewedAtPacific: formatPacific(dressCodeViewedAt),
    },
    {
      key: 'sop',
      name: 'Standard Operating Procedures',
      viewedAtPacific: formatPacific(sopViewedAt),
    },
  ];

  return renderReceiptPDF({
    fullName,
    email,
    docVersion,
    documents,
    agreedAtPacific: formatPacific(agreedAt),
    signedAtPacific: formatPacific(signedAt),
    ip: ip || 'unknown',
    location: location || null,
    // Triple-stash these in the template ({{{signatureDataUrl}}}, {{{logoDataUrl}}}).
    // Base64 contains '+' and '/' which Handlebars' default escaper will
    // mangle into &#x2B; / &#x2F; and break the embedded image.
    signatureDataUrl,
    logoDataUrl,
  });
}
