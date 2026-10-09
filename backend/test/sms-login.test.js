import test from 'node:test';
import assert from 'node:assert/strict';

// sms-login imports the shared db helper (lazy Pool) and the token signers,
// which read their env at import time.
process.env.DATABASE_URL =
  process.env.DATABASE_URL || 'postgresql://test:test@127.0.0.1:5432/district6_test';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-for-sms-login-tests-0123456789';
process.env.SMS_OUTBOX_KEY = process.env.SMS_OUTBOX_KEY || 'test-district6-key';

const { normalizeE164, maskPhone, sendRepLoginCode, verifyRepSmsCode, verifyAdminSmsCode } =
  await import('../lib/sms-login.js');
const { sendOtp, SMS_JOIN_OPT_IN_MESSAGE, SMS_STOP_OPT_OUT_MESSAGE } = await import(
  '../lib/sms-outbox.js'
);
const { verifyToken } = await import('../lib/tokens.js');
const { verifyAdminSessionToken } = await import('../lib/admin-jwt.js');

const NEVER_CALL = async () => {
  throw new Error('must not be called');
};

test('normalizeE164 accepts US 10-digit and 1+10 forms only', () => {
  assert.equal(normalizeE164('509-572-7660'), '+15095727660');
  assert.equal(normalizeE164('(509) 572.7660'), '+15095727660');
  assert.equal(normalizeE164('1 509 572 7660'), '+15095727660');
  assert.equal(normalizeE164('+15095727660'), '+15095727660');
  assert.equal(normalizeE164('509572766'), null);
  assert.equal(normalizeE164('50957276601'), null);
  assert.equal(normalizeE164('44 20 7946 0958'), null);
  assert.equal(normalizeE164('50abc'), null);
  assert.equal(normalizeE164(''), null);
});

test('maskPhone shows only the last four digits', () => {
  assert.equal(maskPhone('+15095727660'), '+1***7660');
});

test('send refuses an email that is not allowed', async () => {
  const result = await sendRepLoginCode({
    email: 'someone@nowhere.com',
    deps: {
      isEmailAllowed: async () => false,
      getAdminRow: async () => null,
      getLoginPhone: NEVER_CALL,
      sendOtp: NEVER_CALL,
    },
  });
  assert.equal(result.ok, false);
  assert.ok(result.error);
  assert.equal(result.token, undefined);
});

test('send refuses an allowed email with no phone on file', async () => {
  const result = await sendRepLoginCode({
    email: 'jane@example.com',
    deps: {
      isEmailAllowed: async () => true,
      getLoginPhone: async () => null,
      sendOtp: NEVER_CALL,
    },
  });
  assert.equal(result.ok, false);
  assert.equal(result.error, 'No mobile number is on file for this email. Use the email sign-in instead.');
});

test('send calls /otp/send with E.164 and the app key header', async () => {
  const calls = [];
  const fetchImpl = async (url, opts) => {
    calls.push({ url, opts });
    return { ok: true, status: 200, json: async () => ({ ok: true, expires_in_min: 10 }) };
  };
  const result = await sendRepLoginCode({
    email: 'jane@example.com',
    deps: {
      isEmailAllowed: async () => true,
      getLoginPhone: async () => ({ email: 'jane@example.com', phone_e164: '509-572-7660' }),
      sendOtp: (to) => sendOtp(to, { fetchImpl }),
    },
  });
  assert.equal(result.ok, true);
  assert.equal(result.phoneMask, '+1***7660');
  assert.equal(calls.length, 1);
  assert.ok(calls[0].url.endsWith('/otp/send'));
  const body = JSON.parse(calls[0].opts.body);
  assert.equal(body.to, '+15095727660');
  assert.equal(calls[0].opts.headers['x-api-key'], process.env.SMS_OUTBOX_KEY);
  assert.equal(calls[0].opts.headers['content-type'], 'application/json');
});

test('a 403 with rule OPT_IN_REQUIRED is returned as that rule, not as STOP', async () => {
  const fetchImpl = async () => ({
    ok: false,
    status: 403,
    json: async () => ({ error: 'not opted in', rule: 'OPT_IN_REQUIRED' }),
  });
  const result = await sendRepLoginCode({
    email: 'jane@example.com',
    deps: {
      isEmailAllowed: async () => true,
      getLoginPhone: async () => ({ phone_e164: '+15095727660' }),
      sendOtp: (to) => sendOtp(to, { fetchImpl }),
    },
  });
  assert.equal(result.ok, false);
  assert.equal(result.rule, 'OPT_IN_REQUIRED');
  assert.equal(result.error, SMS_JOIN_OPT_IN_MESSAGE);
  assert.ok(result.error.includes('JOIN'));
  assert.ok(!result.error.includes('STOP'));
  assert.ok(!result.error.includes('START'));
});

test('a 403 with rule OPT_OUT shows the STOP copy', async () => {
  const fetchImpl = async () => ({
    ok: false,
    status: 403,
    json: async () => ({ error: 'opted out', rule: 'OPT_OUT' }),
  });
  const result = await sendRepLoginCode({
    email: 'jane@example.com',
    deps: {
      isEmailAllowed: async () => true,
      getLoginPhone: async () => ({ phone_e164: '+15095727660' }),
      sendOtp: (to) => sendOtp(to, { fetchImpl }),
    },
  });
  assert.equal(result.ok, false);
  assert.equal(result.error, SMS_STOP_OPT_OUT_MESSAGE);
  assert.ok(result.error.includes('STOP'));
});

test('rep verify success returns a JWT that verifyToken accepts for that email', async () => {
  const inserted = [];
  const result = await verifyRepSmsCode({
    email: 'jane@example.com',
    code: '123456',
    ip: '203.0.113.9',
    userAgent: 'test-agent',
    deps: {
      isEmailAllowed: async () => true,
      getLoginPhone: async () => ({ phone_e164: '+15095727660' }),
      verifyOtp: async () => ({ ok: true, status: 200 }),
      insertLinkRequest: async (row) => {
        inserted.push(row);
      },
    },
  });
  assert.equal(result.ok, true);
  assert.equal(typeof result.token, 'string');
  const payload = verifyToken(result.token);
  assert.equal(payload.email, 'jane@example.com');
  assert.ok(payload.jti);
  assert.equal(inserted.length, 1);
  assert.equal(inserted[0].email, 'jane@example.com');
  assert.equal(inserted[0].jti, payload.jti);
});

test('admin verify success returns a token verifyAdminSessionToken accepts', async () => {
  const result = await verifyAdminSmsCode({
    email: 'april.gauthier@retailodyssey.com',
    code: '123456',
    deps: {
      getAdminRow: async () => ({
        email: 'april.gauthier@retailodyssey.com',
        password_hash: '$2a$12$fakehash',
      }),
      getLoginPhone: async () => ({ phone_e164: '+15095727660' }),
      verifyOtp: async () => ({ ok: true, status: 200 }),
    },
  });
  assert.equal(result.ok, true);
  assert.equal(result.email, 'april.gauthier@retailodyssey.com');
  const payload = verifyAdminSessionToken(result.token);
  assert.equal(payload.email, 'april.gauthier@retailodyssey.com');
  assert.equal(payload.typ, 'admin');
});

test('admin verify refuses an email without a password set', async () => {
  const result = await verifyAdminSmsCode({
    email: 'april.gauthier@retailodyssey.com',
    code: '123456',
    deps: {
      getAdminRow: async () => ({ email: 'april.gauthier@retailodyssey.com', password_hash: null }),
      getLoginPhone: NEVER_CALL,
      verifyOtp: NEVER_CALL,
    },
  });
  assert.equal(result.ok, false);
  assert.equal(result.token, undefined);
});

test('wrong code does not return a token', async () => {
  const rep = await verifyRepSmsCode({
    email: 'jane@example.com',
    code: '000000',
    deps: {
      isEmailAllowed: async () => true,
      getLoginPhone: async () => ({ phone_e164: '+15095727660' }),
      verifyOtp: async () => ({ ok: false, status: 400, error: 'invalid code' }),
    },
  });
  assert.equal(rep.ok, false);
  assert.equal(rep.token, undefined);

  const admin = await verifyAdminSmsCode({
    email: 'april.gauthier@retailodyssey.com',
    code: '000000',
    deps: {
      getAdminRow: async () => ({
        email: 'april.gauthier@retailodyssey.com',
        password_hash: '$2a$12$fakehash',
      }),
      getLoginPhone: async () => ({ phone_e164: '+15095727660' }),
      verifyOtp: async () => ({ ok: false, status: 400, error: 'invalid code' }),
    },
  });
  assert.equal(admin.ok, false);
  assert.equal(admin.token, undefined);
});