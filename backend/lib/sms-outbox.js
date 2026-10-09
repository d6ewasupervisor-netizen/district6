/*
 * TACTAG sms-outbox gateway client (ESM port of eod-api/src/lib/sms-outbox.js).
 *
 * District 6 never holds Twilio credentials. PIN sends and verifies go through
 * the shared gateway: POST /otp/send and POST /otp/verify, header x-api-key.
 * The gateway owns the 6-digit code (10-minute TTL, hashed, 3 sends per phone
 * per 10 minutes, 5 verify attempts, single-use). On verify success District 6
 * issues its own session — the gateway does not.
 *
 * OTP-only module on purpose: there is no /sms/send wrapper here, so a PIN can
 * never be routed as a generic text (OTP also never gets the owner copy).
 *
 * Env: SMS_OUTBOX_KEY (this app's key only), SMS_OUTBOX_URL (default below).
 */

const DEFAULT_URL = 'https://sms-outbox-production.up.railway.app';

export function smsOutboxConfigured() {
  return Boolean(String(process.env.SMS_OUTBOX_KEY || '').trim());
}

export function baseUrl() {
  return String(process.env.SMS_OUTBOX_URL || DEFAULT_URL).replace(/\/+$/, '');
}

function apiKey() {
  return String(process.env.SMS_OUTBOX_KEY || '').trim();
}

async function outboxFetch(path, body, fetchImpl = fetch) {
  if (!smsOutboxConfigured()) {
    const err = new Error('SMS outbox is not configured (missing SMS_OUTBOX_KEY).');
    err.code = 'SMS_OUTBOX_NOT_CONFIGURED';
    throw err;
  }
  const res = await fetchImpl(`${baseUrl()}${path}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': apiKey(),
    },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  return { res, data };
}

export async function sendOtp(to, { fetchImpl = fetch } = {}) {
  const { res, data } = await outboxFetch('/otp/send', { to }, fetchImpl);
  if (!res.ok) throw outboxError('otp/send', res, data);
  return data; // { ok: true, expires_in_min: 10 }
}

export async function verifyOtp(to, code, { fetchImpl = fetch } = {}) {
  const { res, data } = await outboxFetch(
    '/otp/verify',
    { to, code: String(code || '').trim() },
    fetchImpl,
  );
  return {
    ok: res.ok && data.ok === true,
    status: res.status,
    ...data,
  };
}

/**
 * A 403 from the gateway is a compliance block, not necessarily an opt-out.
 * Keep which rule fired so callers can tell "texted STOP" apart from never
 * opted in, flood, daily cap, and content blocks.
 */
export const BLOCK_RULE_CODES = {
  OPT_OUT: 'SMS_OUTBOX_OPTED_OUT',
  OPT_IN_REQUIRED: 'SMS_OUTBOX_OPT_IN_REQUIRED',
  DAILY_CAP: 'SMS_OUTBOX_DAILY_CAP',
  CONTENT: 'SMS_OUTBOX_CONTENT_BLOCKED',
  INVITE_ONCE: 'SMS_OUTBOX_INVITE_ONCE',
  PER_RECIPIENT_FLOOD: 'SMS_OUTBOX_RECIPIENT_FLOOD',
};

export function mapOutboxStatus(status, rule = null) {
  if (status === 400) return 'SMS_OUTBOX_BAD_REQUEST';
  if (status === 401) return 'SMS_OUTBOX_UNAUTHORIZED';
  if (status === 403) return BLOCK_RULE_CODES[rule] || 'SMS_OUTBOX_BLOCKED';
  if (status === 429) return 'SMS_OUTBOX_RATE_LIMITED';
  if (status === 502) return 'SMS_OUTBOX_TWILIO_FAILED';
  if (status === 503) return 'SMS_OUTBOX_UNAVAILABLE';
  return 'SMS_OUTBOX_FAILED';
}

export function outboxError(path, res, data) {
  const rule = (data && data.rule) || null;
  const err = new Error((data && data.error) || `${path} ${res.status}`);
  err.code = mapOutboxStatus(res.status, rule);
  err.status = res.status;
  err.rule = rule;
  err.outbox = data || {};
  return err;
}

// ── User-facing copy ─────────────────────────────────────────────────────────
// Distinct wording per block — a 403 is never collapsed into "opted out".

export const SMS_JOIN_OPT_IN_MESSAGE =
  'That number has not opted in to texts. Text JOIN to (509) 572-9212 from that phone, then try again. Email sign-in still works.';

export const SMS_STOP_OPT_OUT_MESSAGE =
  'That number texted STOP and is opted out of texts. Only START to (509) 572-9212 turns texts back on. Use email until then.';

export const SMS_RATE_LIMITED_MESSAGE =
  'Too many attempts. Request a new code or use email.';

export const SMS_NOT_CONFIGURED_MESSAGE =
  'Text sign-in is not set up. Use email.';

/** Map a thrown gateway error (or plain Error) to the copy shown to the user. */
export function userFacingSmsError(err) {
  const code = err && err.code;
  if (code === 'SMS_OUTBOX_OPT_IN_REQUIRED') return SMS_JOIN_OPT_IN_MESSAGE;
  if (code === 'SMS_OUTBOX_OPTED_OUT') return SMS_STOP_OPT_OUT_MESSAGE;
  if (code === 'SMS_OUTBOX_RECIPIENT_FLOOD') return SMS_RATE_LIMITED_MESSAGE;
  if (code === 'SMS_OUTBOX_DAILY_CAP') {
    return 'The daily text limit has been reached. Texts resume tomorrow — use email until then.';
  }
  if (code === 'SMS_OUTBOX_CONTENT_BLOCKED') {
    return `The text was blocked by the message content rules (${err && err.message}). Use email instead.`;
  }
  if (code === 'SMS_OUTBOX_BLOCKED') {
    return `The text was blocked by the messaging gateway (${err && err.message}). Use email instead.`;
  }
  if (code === 'SMS_OUTBOX_RATE_LIMITED') return SMS_RATE_LIMITED_MESSAGE;
  if (code === 'SMS_OUTBOX_NOT_CONFIGURED' || code === 'SMS_OUTBOX_UNAVAILABLE') {
    return SMS_NOT_CONFIGURED_MESSAGE;
  }
  return (err && err.message) || 'Could not send the code. Try again or use email.';
}

/** Same mapping for verifyOtp() results, which report status/rule without throwing. */
export function userFacingVerifyError(result) {
  const rule = (result && result.rule) || null;
  const code = mapOutboxStatus(result && result.status, rule);
  return userFacingSmsError({ code, message: result && result.error, rule });
}