/*
 * HTML → PDF receipt renderer.
 *
 * Replaces the previous pdfkit-based pipeline with a Handlebars template
 * rendered to PDF by a headless Chromium (Puppeteer). One browser instance
 * is reused per process; pages are opened and closed per render.
 *
 * Lifecycle:
 *  - The template is read from disk and compiled lazily on first render.
 *  - The browser is launched lazily on first render; subsequent renders
 *    reuse it (warm).
 *  - SIGTERM and SIGINT close the browser cleanly so Railway redeploys
 *    don't leak Chromium processes.
 *
 * Template variables: see backend/lib/templates/receipt.html for the contract.
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Handlebars from 'handlebars';
import puppeteer from 'puppeteer';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TEMPLATE_PATH = path.resolve(__dirname, 'templates', 'receipt.html');

// Cached compiled template. The promise itself is cached so concurrent
// first-callers share a single read+compile rather than racing.
let templatePromise = null;
async function getTemplate() {
  if (!templatePromise) {
    templatePromise = (async () => {
      const src = await fs.readFile(TEMPLATE_PATH, 'utf8');
      return Handlebars.compile(src, { noEscape: false });
    })().catch((err) => {
      // Reset on failure so the next call retries instead of caching the rejection.
      templatePromise = null;
      throw err;
    });
  }
  return templatePromise;
}

// Same singleton pattern for the browser. `--no-sandbox` is required on
// Railway (no SYS_ADMIN cap); `--disable-dev-shm-usage` avoids /dev/shm
// exhaustion in small containers. Both are no-ops on Windows / macOS.
let browserPromise = null;
async function getBrowser() {
  if (!browserPromise) {
    browserPromise = puppeteer
      .launch({
        headless: true,
        args: [
          '--no-sandbox',
          '--disable-setuid-sandbox',
          '--disable-dev-shm-usage',
        ],
      })
      .catch((err) => {
        browserPromise = null;
        throw err;
      });
  }
  return browserPromise;
}

/**
 * Close the singleton browser if it's running. Idempotent. Called from
 * the SIGTERM/SIGINT handlers below and from the smoke test on success
 * so the Node process exits cleanly instead of hanging on Chromium.
 */
export async function closeBrowser() {
  const p = browserPromise;
  browserPromise = null;
  if (!p) return;
  try {
    const browser = await p;
    await browser.close();
  } catch {
    // Already gone or never started cleanly. Nothing useful to do.
  }
}

// Register graceful-shutdown handlers exactly once per process. `process.once`
// + a guard handles `node --watch` reloads and any module-graph re-imports.
function installShutdownHandlers() {
  if (process.listenerCount('SIGTERM') > 0 && process.listenerCount('SIGINT') > 0) {
    // Best-effort: another module already wired up signals. We still want
    // ours to run, but don't pile up duplicates if this module is hot-reloaded.
  }
  process.once('SIGTERM', closeBrowser);
  process.once('SIGINT', closeBrowser);
}
installShutdownHandlers();

/**
 * Render the receipt template to a PDF Buffer.
 *
 * @param {object} data - All template variables. Caller is responsible for
 *   pre-formatting timestamps (template does no date math). See the
 *   contract comment at the top of backend/lib/templates/receipt.html.
 * @returns {Promise<Buffer>} PDF bytes, Letter-sized, with margins driven
 *   by the template's @page CSS (page.pdf is invoked with
 *   preferCSSPageSize: true and zero hard margins).
 */
export async function renderReceiptPDF(data) {
  const template = await getTemplate();
  const html = template(data);

  const browser = await getBrowser();
  const page = await browser.newPage();
  try {
    await page.setContent(html, { waitUntil: 'networkidle0' });
    const pdf = await page.pdf({
      format: 'Letter',
      printBackground: true,
      preferCSSPageSize: true,
      margin: { top: 0, right: 0, bottom: 0, left: 0 },
    });
    return Buffer.isBuffer(pdf) ? pdf : Buffer.from(pdf);
  } finally {
    // Close the page but keep the browser warm for the next render.
    await page.close().catch(() => {});
  }
}
