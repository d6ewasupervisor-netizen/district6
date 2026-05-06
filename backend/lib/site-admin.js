import { query } from './db.js';

const SINGLETON_ID = 1;

/**
 * @returns {Promise<{ admin_email: string, password_hash: string | null } | null>}
 */
export async function getSiteAdmin() {
  const { rows } = await query(
    'SELECT admin_email, password_hash FROM site_admin WHERE id = $1 LIMIT 1',
    [SINGLETON_ID],
  );
  return rows[0] || null;
}

/**
 * @returns {Promise<boolean>}
 */
export async function setAdminPasswordHash(passwordHash) {
  const { rowCount } = await query(
    `UPDATE site_admin
     SET password_hash = $1, password_set_at = NOW()
     WHERE id = $2 AND password_hash IS NULL`,
    [passwordHash, SINGLETON_ID],
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
