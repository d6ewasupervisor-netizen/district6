import test from 'node:test';
import assert from 'node:assert/strict';

// component-store imports the shared db helper (lazy Pool), which requires a
// connection string at import time only.
process.env.DATABASE_URL =
  process.env.DATABASE_URL || 'postgresql://test:test@127.0.0.1:5432/district6_test';

const { findMissingRequiredDocViews, parsePolicyCards, lightweightProjectJson } = await import(
  '../lib/component-store.js'
);

test('submit accepts a new required doc key from policy_documents', () => {
  const requiredRows = [
    { doc_key: 'attendance', title: 'Attendance & Timekeeping Policy' },
    { doc_key: 'safetyManual', title: 'Safety Manual' },
  ];
  const viewTimestamps = {
    attendance: '2026-10-08T16:00:00.000Z',
    safetyManual: '2026-10-08T16:03:00.000Z',
  };
  assert.deepEqual(findMissingRequiredDocViews(requiredRows, viewTimestamps), []);
});

test('submit rejects a missing viewed timestamp for a required doc', () => {
  const requiredRows = [
    { doc_key: 'attendance', title: 'Attendance & Timekeeping Policy' },
    { doc_key: 'safetyManual', title: 'Safety Manual' },
  ];
  const viewTimestamps = { attendance: '2026-10-08T16:00:00.000Z' };
  const missing = findMissingRequiredDocViews(requiredRows, viewTimestamps);
  assert.equal(missing.length, 1);
  assert.equal(missing[0].doc_key, 'safetyManual');
});

test('submit rejects invalid timestamps, not just absent ones', () => {
  const requiredRows = [{ doc_key: 'dressCode', title: 'Dress Code Policy' }];
  assert.equal(findMissingRequiredDocViews(requiredRows, { dressCode: 'not-a-date' }).length, 1);
  assert.equal(findMissingRequiredDocViews(requiredRows, { dressCode: 12345 }).length, 1);
  assert.equal(findMissingRequiredDocViews(requiredRows, {}).length, 1);
});

test('parsePolicyCards reads required and reference cards from acknowledgement HTML', () => {
  const html =
    '<div class="doc-list">' +
    '<div class="doc-card" data-doc="attendance" data-doc-title="Attendance &amp; Timekeeping Policy">' +
    '<h3 class="doc-card-title">Attendance &amp; Timekeeping</h3>' +
    '<button class="doc-open" data-pdf-src="docs/attendance.pdf">Open</button>' +
    '</div>' +
    '<div class="doc-card" data-doc="safetyManual">' +
    '<h3 class="doc-card-title">Safety Manual</h3>' +
    '<button class="doc-open" data-pdf-src="docs/safety.pdf">Open</button>' +
    '</div>' +
    '</div>' +
    '<a class="ref-card" href="docs/handbook.pdf" data-ref-pdf data-pdf-src="docs/handbook.pdf" ' +
    'data-pdf-title="Teammate Handbook"><h3 class="ref-card-title">Teammate Handbook</h3></a>';
  const cards = parsePolicyCards(html);
  assert.equal(cards.length, 3);

  const required = cards.filter((c) => c.kind === 'required');
  assert.deepEqual(required.map((c) => c.docKey), ['attendance', 'safetyManual']);
  assert.equal(required[0].title, 'Attendance & Timekeeping Policy');
  assert.equal(required[1].title, 'Safety Manual');
  assert.equal(required[1].filePath, 'docs/safety.pdf');

  const refs = cards.filter((c) => c.kind === 'reference');
  assert.equal(refs.length, 1);
  assert.equal(refs[0].docKey, 'teammate-handbook');
  assert.equal(refs[0].filePath, 'docs/handbook.pdf');
});

test('lightweightProjectJson is loadable Studio project data', () => {
  const project = lightweightProjectJson('home', '<h1>Hi</h1>', '.h1 {}');
  assert.equal(project.pages.length, 1);
  assert.equal(project.pages[0].component, '<h1>Hi</h1>');
  assert.equal(project.pages[0].styles, '.h1 {}');
});