/*
 * Smoke test for the HTML → PDF receipt pipeline.
 *
 * Run with:
 *   node backend/test/receipt-renderer.smoke.js
 *   # or via npm:  npm run smoke:receipt   (from backend/)
 *
 * Verifies:
 *   1. Template loads and compiles.
 *   2. Puppeteer launches and renders the page.
 *   3. The resulting PDF is non-trivial (> 10 KB).
 *
 * Writes the artifact to os.tmpdir() — works on Windows (%TEMP%\...) and
 * Linux/macOS (/tmp/...). The resolved path is printed on success so you
 * can open it.
 */

import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { buildSignedReceiptPDF } from '../lib/pdf.js';
import { closeBrowser } from '../lib/receipt-renderer.js';

const OUT = path.join(os.tmpdir(), 'receipt-smoke.pdf');
const MIN_BYTES = 10 * 1024;

// 1×1 transparent PNG. Smallest valid signatureDataUrl we can pass without
// having to round-trip through a real canvas.
const TRANSPARENT_PNG_DATA_URL =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkAAIAAAUAAeImBZsAAAAASUVORK5CYII=';

function fail(msg) {
  console.error(`[smoke:receipt] FAIL — ${msg}`);
  process.exitCode = 1;
}

async function main() {
  const now = new Date();
  const oneHourAgo = new Date(now.getTime() - 60 * 60 * 1000);
  const twoHoursAgo = new Date(now.getTime() - 2 * 60 * 60 * 1000);
  const threeHoursAgo = new Date(now.getTime() - 3 * 60 * 60 * 1000);

  console.log('[smoke:receipt] launching renderer…');
  const buf = await buildSignedReceiptPDF({
    fullName: 'Tyson Gauthier',
    email: 'tyson.gauthier@retailodyssey.com',
    docVersion: 'Spring 2026 Edition',
    attendanceViewedAt: threeHoursAgo,
    dressCodeViewedAt: twoHoursAgo,
    sopViewedAt: oneHourAgo,
    agreedAt: oneHourAgo,
    signedAt: now,
    ip: '203.0.113.42',
    location: 'Los Angeles, CA, US',
    signatureDataUrl: TRANSPARENT_PNG_DATA_URL,
  });

  if (!Buffer.isBuffer(buf)) fail(`expected Buffer, got ${typeof buf}`);
  if (buf.length <= MIN_BYTES) {
    fail(`PDF too small (${buf.length} bytes ≤ ${MIN_BYTES} byte threshold)`);
  }
  // PDFs always start with the magic bytes "%PDF-".
  const head = buf.slice(0, 5).toString('utf8');
  if (head !== '%PDF-') fail(`bad PDF header: ${JSON.stringify(head)}`);

  await fs.writeFile(OUT, buf);
  console.log(`[smoke:receipt] wrote ${buf.length.toLocaleString()} bytes → ${OUT}`);
}

main()
  .catch((err) => {
    console.error('[smoke:receipt] threw:', err);
    process.exitCode = 1;
  })
  .finally(async () => {
    // Without this, Node hangs on the warm Chromium until something kills it.
    await closeBrowser();
    if (process.exitCode === 1) {
      console.error('[smoke:receipt] one or more checks failed');
    } else {
      console.log('[smoke:receipt] OK');
    }
  });
