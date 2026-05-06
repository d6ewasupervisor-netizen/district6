import { query } from './db.js';

/** Email whose first-time PASSWORD slot is unlocked by ADMIN_SETUP_TOKEN (when password_hash IS NULL). */
export const PRIMARY_ADMIN_EMAIL = (
  process.env.PRIMARY_ADMIN_EMAIL || 'april.gauthier@retailodyssey.com'
).trim().toLowerCase();

/**
 * @param {string} emailNorm — lowercase trimmed
 */
export async function getAdminRow(emailNorm) {
  const { rows } = await query(
    'SELECT email, password_hash FROM site_admins WHERE lower(trim(email)) = $1 LIMIT 1',
    [emailNorm],
  );
  const row = rows[0];
  if (!row) return null;
  return {
    email: row.email.trim().toLowerCase(),
    password_hash: row.password_hash,
  };
}

/** Row used for PUBLIC /status and POST /setup (bootstrap token unlocks THIS email only when hash is NULL). */
export async function getPrimaryBootstrapAdmin() {
  return getAdminRow(PRIMARY_ADMIN_EMAIL);
}

/**
 * Set password_hash only while still NULL (first-time setup completion).
 */
export async function setPasswordHashIfUnset(emailNorm, passwordHash) {
  const { rowCount } = await query(
    `UPDATE site_admins SET password_hash = $1, password_set_at = NOW()
     WHERE lower(trim(email)) = $2 AND password_hash IS NULL`,
    [passwordHash, emailNorm],
  );
  return rowCount > 0;
}

/**
 * @returns {string|null}
 */
export function maskAdminEmail(email) {
  if (!email || typeof email !== 'string') return null;
  const at = email.indexOf('@');
  if (at < 1) return null;
  const local = email.slice(0, at);
  const domain = email.slice(at + 1);
  const visible = Math.min(2, local.length);
  const prefix = local.slice(0, visible);
  return `${prefix}•••@${domain}`;
}
