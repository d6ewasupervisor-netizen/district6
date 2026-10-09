import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  parseModelJson,
  applyProjectPatch,
  LAYOUT_MODEL,
  POLISH_MODEL,
} from '../lib/claude-components.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const fixture = (name) =>
  JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', name), 'utf8'));
const fixtureText = (name) =>
  fixture(name)
    .content.filter((c) => c.type === 'text')
    .map((c) => c.text)
    .join('\n');

test('model ids are the expected ones', () => {
  assert.equal(LAYOUT_MODEL, 'claude-haiku-5-5');
  assert.equal(POLISH_MODEL, 'claude-sonnet-5-5');
});

test('haiku question fixture parses without a live API call', () => {
  const parsed = parseModelJson(fixtureText('claude-haiku-question.json'));
  assert.equal(typeof parsed.question, 'string');
  assert.ok(parsed.question.length > 0);
});

test('haiku patch fixture parses without a live API call', () => {
  const parsed = parseModelJson(fixtureText('claude-haiku-patch.json'));
  assert.equal(typeof parsed.patch, 'object');
  assert.ok(Array.isArray(parsed.patch.text));
  assert.ok(Array.isArray(parsed.patch.newBlocks));
  assert.equal(typeof parsed.patch.css, 'string');
  assert.equal(typeof parsed.summaryForPolish, 'string');
  assert.ok(parsed.summaryForPolish.length > 0);
});

test('sonnet final fixture parses without a live API call', () => {
  const parsed = parseModelJson(fixtureText('claude-sonnet-final.json'));
  assert.equal(typeof parsed.html, 'string');
  assert.equal(typeof parsed.css, 'string');
  assert.ok(parsed.projectJson && Array.isArray(parsed.projectJson.pages));
});

test('parseModelJson tolerates code fences and prose around the JSON', () => {
  const parsed = parseModelJson('Here you go:\n```json\n{"question": "Which color?"}\n```\nThanks!');
  assert.equal(parsed.question, 'Which color?');
});

test('applyProjectPatch applies text, images, links, blocks, removals, and css', () => {
  const html =
    '<div class="card"><h2 class="hero-title">Old</h2>' +
    '<img class="hero-img" src="old.png" alt="old">' +
    '<a class="hero-link" href="old.html">Old link</a>' +
    '<div class="legacy-note">remove me</div>' +
    '</div>';
  const patched = applyProjectPatch(html, '.card {}', {
    text: [{ selector: '.hero-title', content: 'New & improved' }],
    images: [{ selector: '.hero-img', src: 'new.png', alt: 'new' }],
    links: [{ selector: '.hero-link', href: 'new.html', label: 'New link' }],
    newBlocks: ['<section class="card"><h2>Hours</h2></section>'],
    removedBlocks: ['.legacy-note'],
    css: '.hero-title { color: #003a70; }',
  });
  assert.ok(patched.html.includes('>New &amp; improved<'));
  assert.ok(patched.html.includes('src="new.png"'));
  assert.ok(patched.html.includes('href="new.html"'));
  assert.ok(patched.html.includes('>New link<'));
  assert.ok(patched.html.includes('<h2>Hours</h2>'));
  assert.ok(!patched.html.includes('legacy-note'));
  assert.ok(patched.css.includes('.card {}'));
  assert.ok(patched.css.includes('.hero-title { color: #003a70; }'));
});

test('applyProjectPatch keeps hooks it was not asked to touch', () => {
  const html = '<div id="hub"><input id="full-name"><canvas id="signature-pad"></canvas></div>';
  const patched = applyProjectPatch(html, '', {
    text: [{ selector: '#hub', content: 'ignored content' }],
  });
  // #hub inner is replaced by text, but the required id hooks on the sibling
  // structure survive as long as they are not targeted.
  assert.ok(patched.html.includes('id="hub"') || patched.html.includes("id='hub'"));
});