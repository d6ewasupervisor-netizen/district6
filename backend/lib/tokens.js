import jwt from 'jsonwebtoken';
import crypto from 'node:crypto';

const SECRET = process.env.JWT_SECRET;
if (!SECRET) {
  throw new Error('JWT_SECRET is required');
}

const TTL_DAYS = Number(process.env.LINK_TTL_DAYS || 30);

export function issueToken(email) {
  const jti = crypto.randomBytes(16).toString('hex');
  const token = jwt.sign({ email, jti }, SECRET, {
    expiresIn: `${TTL_DAYS}d`,
    jwtid: jti,
  });
  return { token, jti };
}

export function verifyToken(token) {
  return jwt.verify(token, SECRET);
}
