/*
 * Public content API — no auth.
 *
 *   GET /api/content/:pageKey        → published { html, css } (30s cache)
 *   GET /api/content/assets/:id      → uploaded asset bytes (until the publish
 *                                      commit moves them into frontend/)
 */
import express from 'express';
import { getPublishedPage, getAssetById, isPageKey } from '../lib/component-store.js';

const router = express.Router();

router.get('/assets/:id', async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) {
    return res.status(400).json({ ok: false, error: 'Invalid asset id.' });
  }
  try {
    const asset = await getAssetById(id);
    if (!asset) return res.status(404).json({ ok: false, error: 'Asset not found.' });
    res.set('Content-Type', asset.mime || 'application/octet-stream');
    res.set('Cache-Control', 'public, max-age=300');
    return res.send(Buffer.isBuffer(asset.bytes) ? asset.bytes : Buffer.from(asset.bytes));
  } catch (err) {
    console.error('[public content] asset', err);
    return res.status(500).json({ ok: false, error: 'Could not load asset.' });
  }
});

router.get('/:pageKey', async (req, res) => {
  const { pageKey } = req.params;
  if (!isPageKey(pageKey)) {
    return res.status(404).json({ ok: false, error: 'Unknown page.' });
  }
  try {
    const page = await getPublishedPage(pageKey);
    if (!page) {
      return res.status(404).json({ ok: false, error: 'No published content for this page yet.' });
    }
    res.set('Cache-Control', 'public, max-age=30');
    return res.json({
      ok: true,
      pageKey,
      html: page.html,
      css: page.css,
      publishedAt: page.published_at,
    });
  } catch (err) {
    console.error('[public content] page', err);
    return res.status(500).json({ ok: false, error: 'Could not load content.' });
  }
});

export default router;