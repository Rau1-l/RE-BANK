import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { config } from './config.js';

export async function hashPassword(password) {
  return bcrypt.hash(password, 12);
}

export async function verifyPassword(password, passwordHash) {
  return bcrypt.compare(password, passwordHash);
}

export function signToken(user) {
  return jwt.sign(
    { sub: user.id, username: user.username },
    config.jwtSecret,
    { expiresIn: '7d' }
  );
}

export function authRequired(req, res, next) {
  const header = req.get('authorization') || '';
  const match = header.match(/^Bearer\s+(.+)$/i);
  if (!match) return res.status(401).json({ error: 'Authorization Bearer token is required' });
  try {
    const payload = jwt.verify(match[1], config.jwtSecret);
    if (!payload.sub) throw new Error('Invalid token');
    req.user = { id: payload.sub, username: payload.username || '' };
    return next();
  } catch {
    return res.status(401).json({ error: 'Invalid or expired token' });
  }
}
