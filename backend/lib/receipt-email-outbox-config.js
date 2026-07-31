function readIntEnv(name, defaultValue, { min } = {}) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return defaultValue;
  const n = parseInt(raw, 10);
  if (Number.isNaN(n)) return defaultValue;
  if (min !== undefined && n < min) return min;
  return n;
}

/**
 * 0 means unlimited retries (recommended for receipts).
 */
export function maxSendAttempts() {
  return Math.max(0, readIntEnv('MAIL_RECEIPT_OUTBOX_MAX_ATTEMPTS', 0, { min: 0 }));
}

export function scheduleInterval() {
  return readIntEnv('MAIL_RECEIPT_OUTBOX_POLL_MS', 45_000, { min: 5_000 });
}

export function backoffBaseSeconds() {
  return readIntEnv('MAIL_RECEIPT_OUTBOX_BACKOFF_BASE_SEC', 60, { min: 5 });
}

export function backoffMaxSeconds() {
  return readIntEnv('MAIL_RECEIPT_OUTBOX_BACKOFF_MAX_SEC', 1800, { min: 60 });
}

/**
 * Delay after attempt_no (1-based attempts counter after claiming).
 */
export function backoffSecondsForAttempt(attemptNo) {
  const base = backoffBaseSeconds();
  const max = backoffMaxSeconds();
  const exponent = Math.max(0, attemptNo - 1);
  const raw = Math.min(max, base * 2 ** Math.min(exponent, 12));
  return Math.round(raw);
}
