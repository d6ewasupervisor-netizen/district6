import jwt from 'jsonwebtoken';
import crypto from 'node:crypto';

const SECRET = process.env.JWT_SECRET;
if (!SECRET) {
  throw new Error('JWT_SECRET is required');
}

/** Distinct from unsigned compliance link tokens ({ email } only, no typ). */
const ADMIN_TYP = 'admin';

const ADMIN_SESSION_TTL = process.env.ADMIN_SESSION_DAYS
  ? `${Number(process.env.ADMIN_SESSION_DAYS)}d`
  : '45d';

/**
 * @param {string} adminEmail — normalized lowercase
 */
export function issueAdminSessionToken(adminEmail) {
  const jwtid = crypto.randomBytes(16).toString('hex');
  return jwt.sign(
    { email: adminEmail, typ: ADMIN_TYP },
    SECRET,
    { expiresIn: ADMIN_SESSION_TTL, jwtid },
  );
}

/**
 * @param {string} token
 * @returns {{ email: string, typ: string, jti: string }}
 */
export function verifyAdminSessionToken(token) {
  const payload = jwt.verify(token, SECRET);
  if (payload.typ !== ADMIN_TYP) {
    const err = new Error('Invalid session');
    err.name = 'JsonWebTokenError';
    throw err;
  }
  return payload;
}
