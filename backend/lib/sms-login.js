/*
 * SMS PIN login flows (rep + admin).
 *
 * A code is sent only when the email is already allowed to sign in on that
 * surface and a mobile number is stored in login_phones:
 *   - Rep  (sign.html token):  isEmailAllowed — work domains or allowed_emails.
 *   - Admin (session JWT):     site_admins row with password_hash set,
 *                              same gate as admin-session POST /login.
 *
 * The gateway (lib/sms-outbox.js) owns the 6-digit code. This module never
 * stores the PIN, and logs only the masked number (+1***1234) and the email.
 *
 * Every function accepts an optional `deps` bag so tests can mock the gateway
 * and the database without a live connection.
 */
import { query } from './db.js';
import { isEmailAllowed } from './allowed-emails.js';
import { getAdminRow } from './site-admin.js';
import { issueToken } from './tokens.js';
import { issueAdminSessionToken } from './admin-jwt.js';
import {
  sendOtp,
  verifyOtp,
  userFacingSmsError,
  userFacingVerifyError,
} from './sms-outbox.js';

export const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
export const NO_PHONE_MESSAGE =
  'No mobile number is on file for this email. Use the email sign-in instead.';

/** Normalize to E.164 (+1 plus 10 digits). Returns null for anything else. */
export function normalizeE164(raw) {
  const s = String(raw || '').trim();
  if (!s || /[^0-9()+\-.\s]/.test(s)) return null;
  const digits = s.replace(/\D/g, '');
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits[0] === '1') return `+1${digits.slice(1)}`;
  return null;
}

/** Public-facing mask, e.g. +15095727660 → +1***7660. */
export function maskPhone(e164) {
  const s = String(e164 || '');
  if (s.length < 6) return '***';
  return `+1***${s.slice(-4)}`;
}

// ── login_phones ─────────────────────────────────────────────────────────────

export async function getLoginPhone(email) {
  const { rows } = await query(
    `SELECT email, phone_e164, updated_at FROM login_phones WHERE email = $1`,
    [email],
  );
  return rows[0] || null;
}

export async function saveLoginPhone(email, phoneE164) {
  const { rows } = await query(
    `INSERT INTO login_phones (email, phone_e164, updated_at)
     VALUES ($1, $2, NOW())
     ON CONFLICT (email) DO UPDATE SET
       phone_e164 = EXCLUDED.phone_e164,
       updated_at = NOW()
     RETURNING email, phone_e164, updated_at`,
    [email, phoneE164],
  );
  return rows[0];
}

export async function removeLoginPhone(email) {
  const { rowCount } = await query(`DELETE FROM login_phones WHERE email = $1`, [email]);
  return rowCount > 0;
}

export async function listLoginPhones() {
  const { rows } = await query(
    `SELECT email, phone_e164, updated_at FROM login_phones ORDER BY email ASC`,
  );
  return rows;
}

// ── Eligibility gates ────────────────────────────────────────────────────────

/** Rep surface: allowed to request a compliance link. */
export async function canRepSmsLogin(email, deps = {}) {
  const check = deps.isEmailAllowed || isEmailAllowed;
  return Boolean(await check(email));
}

/** Admin surface: same gate as admin-session POST /login. */
export async function canAdminSmsLogin(email, deps = {}) {
  const lookup = deps.getAdminRow || getAdminRow;
  const row = await lookup(email);
  return Boolean(row && row.password_hash);
}

/** Phone-list save gate: allowed rep OR any site_admins row (both flows share the list). */
export async function canSaveLoginPhone(email, deps = {}) {
  const allowed = deps.isEmailAllowed || isEmailAllowed;
  const lookup = deps.getAdminRow || getAdminRow;
  if (await allowed(email)) return true;
  const row = await lookup(email);
  return Boolean(row);
}

// ── Flows ────────────────────────────────────────────────────────────────────

const REP_REFUSAL = 'This email is not on the access list. Contact your supervisor if you believe this is in error.';
const ADMIN_REFUSAL = 'This email is not registered as an administrator.';
const WRONG_CODE_MESSAGE = 'That code is not correct or has expired. Request a new code or use email.';

async function sendCodeFor({ email, gate, refusal, deps }) {
  const lookupPhone = deps.getLoginPhone || getLoginPhone;
  const send = deps.sendOtp || sendOtp;

  if (!(await gate())) {
    return { ok: false, error: refusal, status: 400 };
  }
  const row = await lookupPhone(email);
  const phone = row ? normalizeE164(row.phone_e164) : null;
  if (!phone) {
    return { ok: false, error: NO_PHONE_MESSAGE, status: 400 };
  }
  const masked = maskPhone(phone);
  try {
    await send(phone);
    console.log(`[sms-login] code sent to ${email} (${masked})`);
    return { ok: true, phoneMask: masked };
  } catch (err) {
    console.log(`[sms-login] send blocked for ${email} (${masked}): ${err && err.code}`);
    return {
      ok: false,
      error: userFacingSmsError(err),
      status: (err && err.status) || 500,
      code: err && err.code,
      rule: err && err.rule,
    };
  }
}

/** Rep: text a code for the sign.html flow. */
export function sendRepLoginCode({ email, deps = {} }) {
  return sendCodeFor({
    email,
    gate: () => canRepSmsLogin(email, deps),
    refusal: REP_REFUSAL,
    deps,
  });
}

/** Admin: text a code for the admin session flow. */
export function sendAdminLoginCode({ email, deps = {} }) {
  return sendCodeFor({
    email,
    gate: () => canAdminSmsLogin(email, deps),
    refusal: ADMIN_REFUSAL,
    deps,
  });
}

async function verifyCodeFor({ email, code, deps }) {
  const lookupPhone = deps.getLoginPhone || getLoginPhone;
  const verify = deps.verifyOtp || verifyOtp;

  const row = await lookupPhone(email);
  const phone = row ? normalizeE164(row.phone_e164) : null;
  if (!phone) {
    return { ok: false, error: NO_PHONE_MESSAGE, status: 400 };
  }
  const masked = maskPhone(phone);

  let result;
  try {
    result = await verify(phone, code);
  } catch (err) {
    console.log(`[sms-login] verify failed for ${email} (${masked}): ${err && err.code}`);
    return {
      ok: false,
      error: userFacingSmsError(err),
      status: (err && err.status) || 500,
      code: err && err.code,
    };
  }
  if (!result.ok) {
    console.log(`[sms-login] verify rejected for ${email} (${masked}) status=${result.status}`);
    const status = result.status;
    const blocked = status === 403 || status === 429 || status === 503;
    return {
      ok: false,
      error: blocked ? userFacingVerifyError(result) : WRONG_CODE_MESSAGE,
      status: status || 400,
      code: result.code,
      rule: result.rule,
    };
  }
  return { ok: true, masked };
}

/**
 * Rep verify: same issueToken as request-link, inserts link_requests,
 * returns { ok: true, token } for sign.html?token=… (no link email).
 */
export async function verifyRepSmsCode({ email, code, ip = null, userAgent = null, deps = {} }) {
  const gate = deps.isEmailAllowed || isEmailAllowed;
  if (!(await gate(email))) {
    return { ok: false, error: REP_REFUSAL, status: 400 };
  }
  const verified = await verifyCodeFor({ email, code, deps });
  if (!verified.ok) return verified;

  const issue = deps.issueToken || issueToken;
  const insertLink = deps.insertLinkRequest || defaultInsertLinkRequest;
  const { token, jti } = issue(email);
  await insertLink({ email, jti, ip, userAgent });
  console.log(`[sms-login] rep verify ok jti=${jti.slice(0, 6)}… for ${email} (${verified.masked})`);
  return { ok: true, token };
}

async function defaultInsertLinkRequest({ email, jti, ip, userAgent }) {
  await query(
    `INSERT INTO link_requests (email, jti, ip, user_agent) VALUES ($1, $2, $3, $4)`,
    [email, jti, ip, userAgent],
  );
}

/** Admin verify: same session token as password login. */
export async function verifyAdminSmsCode({ email, code, deps = {} }) {
  const lookup = deps.getAdminRow || getAdminRow;
  const row = await lookup(email);
  if (!row || !row.password_hash) {
    return { ok: false, error: ADMIN_REFUSAL, status: 401 };
  }
  const verified = await verifyCodeFor({ email, code, deps });
  if (!verified.ok) return verified;

  const issueAdmin = deps.issueAdminSessionToken || issueAdminSessionToken;
  const token = issueAdmin(row.email);
  console.log(`[sms-login] admin verify ok for ${email} (${verified.masked})`);
  return { ok: true, token, email: row.email };
}