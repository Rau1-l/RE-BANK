import express from 'express';
import { pool } from '../db.js';
import { hashPassword, signToken, verifyPassword } from '../auth.js';
import { generateCardNumber, generateCvv, generateExpDate, formatCardHolder, normalizeEmail, normalizeUsername, validateEmail, validatePassword, validateUsername } from '../utils.js';

const router = express.Router();

async function createUniqueCard(client, userId, username) {
  for (let attempt = 0; attempt < 30; attempt += 1) {
    try {
      const result = await client.query(
        `INSERT INTO cards (user_id, card_number, card_holder, balance, exp_date, cvv)
         VALUES ($1, $2, $3, 0, $4, $5)
         RETURNING id, user_id, card_number, card_holder, balance, exp_date, cvv, created_at`,
        [userId, generateCardNumber(), formatCardHolder(username), generateExpDate(), generateCvv()]
      );
      return result.rows[0];
    } catch (error) {
      if (error.code !== '23505') throw error;
    }
  }
  throw new Error('Unable to generate a unique card number');
}

router.post('/register', async (req, res, next) => {
  const username = normalizeUsername(req.body?.username);
  const password = req.body?.password;
  const suppliedEmail = normalizeEmail(req.body?.email);
  const email = suppliedEmail || `${username.toLowerCase()}@rebank.local`;
  if (!validateUsername(username)) return res.status(400).json({ error: 'Username must be 3-50 characters and contain only letters, numbers, _, -, or .' });
  if (!validatePassword(password)) return res.status(400).json({ error: 'Password must be 8-72 characters' });
  if (suppliedEmail && !validateEmail(suppliedEmail)) return res.status(400).json({ error: 'Invalid email address' });

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const passwordHash = await hashPassword(password);
    const userResult = await client.query(
      `INSERT INTO users (username, email, password_hash) VALUES ($1, $2, $3)
       RETURNING id, username, email, crypto_balance, active_rating_card_id, created_at`,
      [username, email, passwordHash]
    );
    const user = userResult.rows[0];
    const card = await createUniqueCard(client, user.id, user.username);
    await client.query('COMMIT');
    return res.status(201).json({ token: signToken(user), user, first_card: card });
  } catch (error) {
    await client.query('ROLLBACK');
    if (error.code === '23505' && error.constraint === 'users_username_key') {
      return res.status(409).json({ error: 'Username already exists' });
    }
    return next(error);
  } finally {
    client.release();
  }
});

router.post('/login', async (req, res, next) => {
  const username = normalizeUsername(req.body?.username);
  const password = req.body?.password;
  if (!username || typeof password !== 'string') return res.status(400).json({ error: 'Username and password are required' });
  try {
    const result = await pool.query(
      `SELECT id, username, email, password_hash, crypto_balance, active_rating_card_id, created_at
       FROM users WHERE username = $1`,
      [username]
    );
    if (!result.rows[0]) return res.status(401).json({ error: 'Invalid username or password' });
    const user = result.rows[0];
    const valid = await verifyPassword(password, user.password_hash);
    if (!valid) return res.status(401).json({ error: 'Invalid username or password' });
    delete user.password_hash;
    return res.json({ token: signToken(user), user });
  } catch (error) {
    return next(error);
  }
});

export async function createUniqueCardForUser(client, userId, username) {
  return createUniqueCard(client, userId, username);
}

export default router;
