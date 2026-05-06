// backend/lib/allowed-emails.js
//
// Access control for requesting compliance links:
//   - Any email ending in @retailodyssey.com is allowed, OR
//   - Email exists in Postgres table `allowed_emails` (managed via admin UI).
//
// Maintain the list through /admin.html on the frontend (ADMIN_API_KEY on the API).

import { query } from './db.js';

export const CORPORATE_DOMAIN = 'retailodyssey.com';

/**
 * @param {string} email — Trimmed/lowercased upstream is typical but not required.
 * @returns {Promise<boolean>}
 */
export async function isEmailAllowed(email) {
  if (typeof email !== 'string' || !email) return false;
  const normalized = email.trim().toLowerCase();
  if (!normalized.includes('@')) return false;
  if (normalized.endsWith('@' + CORPORATE_DOMAIN)) return true;

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
