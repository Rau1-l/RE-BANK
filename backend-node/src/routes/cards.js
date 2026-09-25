import express from 'express';
import { pool } from '../db.js';
import { formatCardHolder, generateCardNumber, generateCvv, generateExpDate } from '../utils.js';

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

router.get('/', async (req, res, next) => {
  try {
    const [cards, user] = await Promise.all([
      pool.query(
        `SELECT id, user_id, card_number, card_holder, balance, exp_date, cvv, created_at
         FROM cards WHERE user_id = $1 ORDER BY created_at ASC`,
        [req.user.id]
      ),
      pool.query(`SELECT active_rating_card_id FROM users WHERE id = $1`, [req.user.id])
    ]);
    return res.json({ active_rating_card_id: user.rows[0]?.active_rating_card_id || null, cards: cards.rows });
  } catch (error) {
    return next(error);
  }
});

router.post('/create', async (req, res, next) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const userResult = await client.query(`SELECT username FROM users WHERE id = $1 FOR UPDATE`, [req.user.id]);
    if (!userResult.rows[0]) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'User not found' });
    }
    const count = await client.query(`SELECT COUNT(*)::int AS count FROM cards WHERE user_id = $1`, [req.user.id]);
    if (count.rows[0].count >= 5) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'Maximum of 5 cards per user' });
    }
    const card = await createUniqueCard(client, req.user.id, userResult.rows[0].username);
    await client.query('COMMIT');
    return res.status(201).json(card);
  } catch (error) {
    await client.query('ROLLBACK');
    return next(error);
  } finally {
    client.release();
  }
});

export default router;
