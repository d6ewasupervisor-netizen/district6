/*
 * Letter PDFs are rendered from an HTML string with no site origin, so a
 * relative src such as assets/Page Assets/… never loads in Chromium.
 * This swaps those src values for data URLs read off disk.
 *
 * Railway's image only contains backend/, so the same files also live under
 * backend/assets/. A local checkout can use frontend/assets/ as well.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const ASSET_ROOTS = [
  path.resolve(__dirname, '..', 'assets'),
  path.resolve(__dirname, '..', '..', 'frontend', 'assets'),
];

const MIME_BY_EXT = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
};

const cache = new Map();

function isInside(root, file) {
  const rel = path.relative(path.resolve(root), path.resolve(file));
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
}

export function dataUrlForAssetSrc(src) {
  if (typeof src !== 'string' || !src) return '';
  if (src.startsWith('data:') || /^https?:/i.test(src) || src.startsWith('blob:')) return '';
  let decoded = src;
  try {
    decoded = decodeURIComponent(src);
  } catch {
    decoded = src;
  }
  decoded = decoded.replace(/\\/g, '/').replace(/^\.\//, '').replace(/^\//, '');
  if (!decoded.startsWith('assets/') || decoded.includes('..')) return '';
  const rel = decoded.slice('assets/'.length);
  if (!rel || rel.includes('..')) return '';

  for (const root of ASSET_ROOTS) {
    const file = path.resolve(root, rel);
    if (!isInside(root, file)) continue;
    if (cache.has(file)) return cache.get(file);
    let dataUrl = '';
    try {
      if (fs.existsSync(file) && fs.statSync(file).isFile()) {
        const mime = MIME_BY_EXT[path.extname(file).toLowerCase()];
        if (mime) {
          dataUrl = `data:${mime};base64,${fs.readFileSync(file).toString('base64')}`;
        }
      }
    } catch {
      dataUrl = '';
    }
    if (dataUrl) {
      cache.set(file, dataUrl);
      return dataUrl;
    }
  }
  return '';
}

/** Replace local assets/… image sources with data URLs. Other src values stay. */
export function inlinePageAssetUrls(html) {
  if (typeof html !== 'string' || !html) return html || '';
  return html.replace(
    /(<img\b[^>]*\bsrc\s*=\s*)(["'])([^"']+)\2/gi,
    (full, prefix, quote, src) => {
      const dataUrl = dataUrlForAssetSrc(src);
      if (!dataUrl) return full;
      return `${prefix}${quote}${dataUrl}${quote}`;
    },
  );
}
