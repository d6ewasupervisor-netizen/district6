import test from 'node:test';
import assert from 'node:assert/strict';
import {
  sanitizeHtml,
  findMissingHooks,
  missingHooksSentence,
} from '../lib/component-sanitize.js';

test('sanitize strips script tags and their content', () => {
  const dirty =
    '<h1>Title</h1><script>alert("x")</script><p>Body</p><script src="evil.js"></script>';
  const clean = sanitizeHtml(dirty);
  assert.ok(!/<script/i.test(clean));
  assert.ok(!/alert\(/.test(clean));
  assert.ok(clean.includes('<h1>Title</h1>'));
  assert.ok(clean.includes('<p>Body</p>'));
});

test('sanitize strips iframe, object, and embed elements', () => {
  const dirty =
    '<iframe src="https://evil.example"></iframe><object data="x"></object><embed src="y">';
  const clean = sanitizeHtml(dirty);
  assert.ok(!/<iframe/i.test(clean));
  assert.ok(!/<object/i.test(clean));
  assert.ok(!/<embed/i.test(clean));
});

test('sanitize strips on* handlers and javascript: URLs', () => {
  const dirty =
    '<img src="assets/logo.png" onerror="hack()" onclick=\'hack()\' alt="ok">' +
    '<a href="javascript:hack()">bad</a>' +
    '<a href="docs/attendance.pdf" title="ok">good</a>';
  const clean = sanitizeHtml(dirty);
  assert.ok(!/onerror|onclick/i.test(clean));
  assert.ok(!/javascript:/i.test(clean));
  assert.ok(clean.includes('src="assets/logo.png"'));
  assert.ok(clean.includes('href="docs/attendance.pdf"'));
});

test('publish rejects acknowledgement HTML missing #signature-pad', () => {
  const html =
    '<div id="hub"></div>' +
    '<input id="full-name">' +
    '<button id="clear-sig">Clear</button>' +
    '<input id="agree-check">' +
    '<button id="submit-btn">Submit</button>' +
    '<div class="doc-card" data-doc="attendance"></div>';
  const missing = findMissingHooks('acknowledgement', html);
  assert.ok(missing.includes('#signature-pad'), `expected #signature-pad in ${JSON.stringify(missing)}`);
  const sentence = missingHooksSentence('acknowledgement', html);
  assert.equal(typeof sentence, 'string');
  assert.ok(sentence.includes('#signature-pad'));
});

test('acknowledgement HTML with every hook passes', () => {
  const html =
    '<div id="hub"></div>' +
    '<input id="full-name">' +
    '<canvas id="signature-pad"></canvas>' +
    '<button id="clear-sig">Clear</button>' +
    '<input id="agree-check">' +
    '<button id="submit-btn">Submit</button>' +
    '<div class="doc-card" data-doc="attendance"></div>';
  assert.equal(missingHooksSentence('acknowledgement', html), null);
});

test('home hooks are enforced', () => {
  const ok = '<input id="email"><button id="send-btn">Send</button><div id="access-overlay"></div>';
  assert.equal(missingHooksSentence('home', ok), null);
  const missing = findMissingHooks('home', '<input id="email">');
  assert.deepEqual(missing.sort(), ['#access-overlay', '#send-btn']);
});

test('receipt hooks are the Handlebars tokens', () => {
  const html =
    '<p>{{fullName}}</p><p>{{email}}</p><p>{{docVersion}}</p>' +
    '<img src="{{{signatureDataUrl}}}"><p>{{agreedAtPacific}}</p>' +
    '{{#each documents}}<div>{{name}}</div>{{/each}}';
  assert.equal(missingHooksSentence('receipt', html), null);
  const missing = findMissingHooks('receipt', '<p>{{fullName}}</p>');
  assert.ok(missing.includes('email'));
  assert.ok(missing.includes('documents list'));
});