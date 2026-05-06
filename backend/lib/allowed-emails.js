// backend/lib/allowed-emails.js
//
// Access control for requesting compliance links:
//   - Any email whose domain is in CORPORATE_EMAIL_DOMAINS is allowed, OR
//   - Email exists in Postgres table `allowed_emails` (managed via admin UI).

import { query } from './db.js';

/** Lowercase hostnames (no @) that never need to be on the extra allowlist. */
export const CORPORATE_EMAIL_DOMAINS = [
  'advantagesolutions.net',
  'retailodyssey.com',
  'sasretailservices.com',
  'youradv.com',
];

const domainSet = new Set(CORPORATE_EMAIL_DOMAINS);

/**
 * @param {string} normalizedEmail — lowercased, trimmed
 */
export function isCorporateWorkDomainEmail(normalizedEmail) {
  if (typeof normalizedEmail !== 'string' || !normalizedEmail) return false;
  const at = normalizedEmail.lastIndexOf('@');
  if (at < 1) return false;
  const host = normalizedEmail.slice(at + 1);
  return domainSet.has(host);
}

/**
 * Human-readable list for UI/errors, e.g. "@retailodyssey.com, @youradv.com, …"
 */
export function corporateDomainListForMessage() {
  return CORPORATE_EMAIL_DOMAINS.map((d) => `@${d}`).join(', ');
}

/**
 * @param {string} email — Trimmed/lowercased upstream is typical but not required.
 * @returns {Promise<boolean>}
 */
export async function isEmailAllowed(email) {
  if (typeof email !== 'string' || !email) return false;
  const normalized = email.trim().toLowerCase();
  if (!normalized.includes('@')) return false;
  if (isCorporateWorkDomainEmail(normalized)) return true;

  try {
    const { rows } = await query(
      'SELECT 1 FROM allowed_emails WHERE email = $1 LIMIT 1',
      [normalized],
    );
    return rows.length > 0;
  } catch (err) {
    console.error('[allowed-emails] db lookup failed', err);
    return false;
  }
}
