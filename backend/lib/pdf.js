import PDFDocument from 'pdfkit';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const LOGO_CANDIDATES = [
  path.resolve(__dirname, '..', 'assets', 'logo.png'),
  path.resolve(__dirname, '..', '..', 'frontend', 'assets', 'logo.png'),
];

function findLogo() {
  for (const p of LOGO_CANDIDATES) {
    if (fs.existsSync(p)) return p;
  }
  return null;
}

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
  signatureDataUrl,
}) {
  return new Promise((resolve, reject) => {
    try {
      const doc = new PDFDocument({ size: 'LETTER', margin: 54 });
      const chunks = [];
      doc.on('data', (c) => chunks.push(c));
      doc.on('end', () => resolve(Buffer.concat(chunks)));
      doc.on('error', reject);

      const logoPath = findLogo();
      if (logoPath) {
        try { doc.image(logoPath, 54, 48, { width: 100 }); } catch { /* ignore */ }
      }

      doc
        .fontSize(14)
        .font('Helvetica-Bold')
        .text('District 6 — Policy Acknowledgement Receipt', 0, 56, {
          align: 'right',
        });

      doc.moveDown(3);
      doc.font('Helvetica').fontSize(11).fillColor('#222');

      const labelValue = (label, value) => {
        doc.font('Helvetica-Bold').text(`${label}: `, { continued: true });
        doc.font('Helvetica').text(value);
      };

      doc.moveDown(0.5);
      labelValue('Signer Name', fullName);
      labelValue('Signer Email', email);
      labelValue('Document Version', docVersion);

      doc.moveDown(0.5);
      doc.font('Helvetica-Bold').text('Documents Acknowledged:');
      doc.font('Helvetica');
      doc.text(`  • Attendance & Timekeeping Policy — viewed ${formatPacific(attendanceViewedAt)}`);
      doc.text(`  • Dress Code Policy — viewed ${formatPacific(dressCodeViewedAt)}`);
      doc.text(`  • Standard Operating Procedures — viewed ${formatPacific(sopViewedAt)}`);

      doc.moveDown(0.5);
      labelValue('Agreement Timestamp', formatPacific(agreedAt));

      doc.moveDown(1);
      doc.font('Helvetica-Bold').text('Signature:');
      doc.moveDown(0.25);

      if (signatureDataUrl && signatureDataUrl.startsWith('data:image/')) {
        const base64 = signatureDataUrl.split(',')[1];
        if (base64) {
          const imgBuf = Buffer.from(base64, 'base64');
          try {
            doc.image(imgBuf, { width: 216 }); // ~3 inches
          } catch (e) {
            doc.font('Helvetica-Oblique').text('[signature image could not be embedded]');
          }
        }
      }

      const footerText = `Signed at ${formatPacific(signedAt)} from IP ${ip || 'unknown'} | This is a system-generated acknowledgement.`;
      const bottomY = doc.page.height - 60;
      doc.font('Helvetica').fontSize(9).fillColor('#666')
        .text(footerText, 54, bottomY, {
          width: doc.page.width - 108,
          align: 'center',
        });

      doc.end();
    } catch (err) {
      reject(err);
    }
  });
}
