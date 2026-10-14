import test from 'node:test';
import assert from 'node:assert/strict';
import { dataUrlForAssetSrc, inlinePageAssetUrls } from '../lib/inline-page-assets.js';

test('a palette graphic becomes a png data url for the letter pdf', () => {
  const src = 'assets/Page%20Assets/retailer_asset_pen.png';
  const dataUrl = dataUrlForAssetSrc(src);
  assert.match(dataUrl, /^data:image\/png;base64,/);
  const html = `<img src="${src}" alt="Pen">`;
  const out = inlinePageAssetUrls(html);
  assert.ok(out.startsWith('<img src="data:image/png;base64,'));
  assert.ok(out.endsWith('" alt="Pen">'));
});

test('the policy logo is inlined the same way', () => {
  const dataUrl = dataUrlForAssetSrc('assets/logo.png');
  assert.match(dataUrl, /^data:image\/png;base64,/);
});

test('remote and token image sources are left alone', () => {
  const html = '<img src="https://example.com/a.png"><img src="{{{signatureDataUrl}}}">';
  assert.equal(inlinePageAssetUrls(html), html);
});

test('a path that climbs out of assets is left alone', () => {
  assert.equal(dataUrlForAssetSrc('assets/../../.env'), '');
  assert.equal(
    inlinePageAssetUrls('<img src="assets/../../.env" alt="no">'),
    '<img src="assets/../../.env" alt="no">',
  );
});
