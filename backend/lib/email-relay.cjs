'use strict';

/**
 * TT-RELAY — outbound email relay contract.
 *
 * When EMAIL_RELAY_MODE=on, outbound mail that has at least one recipient
 * outside the bypass set is redirected to a single ingest inbox with the real
 * To/Cc/Bcc/Subject/Reply-To base64-encoded in a hidden envelope div. A
 * Power Automate flow on that inbox strips the envelope and resends the
 * message from the verified work mailbox.
 *
 * Markers, subject prefix, and envelope JSON shape are a contract with the
 * flow. Do not change them here without changing the flow.
 *
 * This file is byte-identical across every repo that sends mail.
 */

const { randomUUID } = require('crypto');

const ENVELOPE_OPEN = '[[TT-ENVELOPE]]';
const ENVELOPE_CLOSE = '[[/TT-ENVELOPE]]';
const SUBJECT_PREFIX = '[TT-RELAY] ';

const DEFAULT_INBOX = 'tyson.gauthier@retailodyssey.com';
const DEFAULT_BYPASS = [
  'tyson.gauthier@retailodyssey.com',
  'd6ewa.supervisor@gmail.com',
  '@metrofax.com',
];
const DEFAULT_DROP_REPLYTO_DOMAINS = [
  '@retail-odyssey.com', // relay: lookalike kept for identity matching only
  '@the-dump-bin.com',
];

function envList(name) {
  return String(process.env[name] || '')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
}

function relayEnabled() {
  const v = String(process.env.EMAIL_RELAY_MODE || 'off').trim().toLowerCase();
  return v === 'on' || v === 'true' || v === '1';
}

function relayInbox() {
  return String(process.env.EMAIL_RELAY_INBOX || DEFAULT_INBOX).trim();
}

function bypassSet() {
  const extra = envList('EMAIL_RELAY_BYPASS');
  const print = String(process.env.PRINT_RECIPIENT || '').trim().toLowerCase();
  return new Set([...DEFAULT_BYPASS, ...extra, ...(print ? [print] : [])]);
}

function dropReplyToSet() {
  return new Set([...DEFAULT_DROP_REPLYTO_DOMAINS, ...envList('EMAIL_RELAY_DROP_REPLYTO_DOMAINS')]);
}

function bareAddress(value) {
  const s = String(value || '').trim();
  const m = s.match(/<([^>]+)>/);
  return (m ? m[1] : s).trim().toLowerCase();
}

function toList(value) {
  if (value == null || value === '') return [];
  const arr = Array.isArray(value) ? value : String(value).split(/[;,]/);
  return arr.map(bareAddress).filter(Boolean);
}

function isBypassed(address, set) {
  if (set.has(address)) return true;
  const at = address.indexOf('@');
  return at >= 0 && set.has(address.slice(at));
}

/**
 * Returns one of: 'off' | 'no-recipients' | 'fax' | 'self-only' | 'relayed'.
 * 'self-only' covers mail addressed only to the inbox owner or machine inboxes.
 */
function shouldRelayReason({ to, cc, bcc } = {}) {
  if (!relayEnabled()) return 'off';
  const all = [...toList(to), ...toList(cc), ...toList(bcc)];
  if (!all.length) return 'no-recipients';
  if (all.some((a) => a.endsWith('@metrofax.com'))) return 'fax';
  const set = bypassSet();
  return all.some((a) => !isBypassed(a, set)) ? 'relayed' : 'self-only';
}

function shouldRelay(payload) {
  return shouldRelayReason(payload) === 'relayed';
}

function firstReplyTo(value, ownAddress) {
  const list = toList(value);
  const inbox = bareAddress(ownAddress || relayInbox());
  const drop = dropReplyToSet();
  return list.find((a) => a !== inbox && !isBypassed(a, drop)) || '';
}

/** Work address to send as, if the acting user runs through a shared connection. */
function sendAsFor(senderEmail) {
  const sender = bareAddress(senderEmail);
  return sender && envList('EMAIL_RELAY_SENDERS').includes(sender) ? sender : '';
}

function rewriteCidImages(html, attachments, inlineImageUrls) {
  if (!html || !Array.isArray(attachments) || !attachments.length) {
    return { html, attachments };
  }
  const map = inlineImageUrls || {};
  let out = html;
  const kept = [];
  for (const att of attachments) {
    const cid = att && (att.content_id || att.contentId || att.cid);
    if (cid && map[cid]) {
      out = out.split(`cid:${cid}`).join(map[cid]);
      continue;
    }
    if (cid) {
      const copy = { ...att };
      delete copy.content_id;
      delete copy.contentId;
      delete copy.cid;
      kept.push(copy);
      continue;
    }
    kept.push(att);
  }
  return { html: out, attachments: kept };
}

function buildEnvelope({ to, cc, bcc, subject, replyTo, tool, fromLabel, sendAsEmail }) {
  const sendAs = sendAsFor(sendAsEmail);
  return {
    to: toList(to),
    cc: toList(cc),
    bcc: toList(bcc),
    subject: String(subject || ''),
    replyTo: firstReplyTo(replyTo, sendAs || relayInbox()),
    tool: String(tool || process.env.EMAIL_RELAY_TOOL || 'unknown'),
    fromLabel: String(fromLabel || ''),
    sendAs,
    id: randomUUID(),
  };
}

function envelopeBlock(envelope) {
  const b64 = Buffer.from(JSON.stringify(envelope), 'utf8').toString('base64');
  return `<div style="display:none;font-size:0;line-height:0">${ENVELOPE_OPEN}${b64}${ENVELOPE_CLOSE}</div>`;
}

/**
 * Rewrites a Resend-shaped payload
 *   { from, to, cc, bcc, reply_to|replyTo, subject, html, text, attachments }
 * into the relay-ingest shape.
 * Returns { payload, relayed, reason, envelope }.
 */
function toRelayPayload(payload, { tool, inlineImageUrls, sendAs, senderEmail } = {}) {
  const reason = payload ? shouldRelayReason(payload) : 'no-recipients';
  if (reason !== 'relayed') {
    return { payload, relayed: false, reason, envelope: null };
  }
  const envelope = buildEnvelope({
    to: payload.to,
    cc: payload.cc,
    bcc: payload.bcc,
    subject: payload.subject,
    replyTo: payload.reply_to || payload.replyTo,
    tool,
    fromLabel: payload.from,
    sendAsEmail: sendAs || senderEmail,
  });
  const { html, attachments } = rewriteCidImages(
    payload.html || '',
    payload.attachments,
    inlineImageUrls,
  );
  const out = {
    ...payload,
    to: [relayInbox()],
    subject: `${SUBJECT_PREFIX}${envelope.subject}`,
    html: `${html || `<pre>${payload.text || ''}</pre>`}${envelopeBlock(envelope)}`,
  };
  delete out.cc;
  delete out.bcc;
  delete out.reply_to;
  delete out.replyTo;
  delete out.text;
  if (Array.isArray(attachments) && attachments.length) {
    out.attachments = attachments;
  } else {
    delete out.attachments;
  }
  return { payload: out, relayed: true, reason, envelope };
}

module.exports = {
  ENVELOPE_OPEN,
  ENVELOPE_CLOSE,
  SUBJECT_PREFIX,
  relayEnabled,
  relayInbox,
  shouldRelay,
  shouldRelayReason,
  firstReplyTo,
  sendAsFor,
  toRelayPayload,
  buildEnvelope,
  envelopeBlock,
  rewriteCidImages,
};
