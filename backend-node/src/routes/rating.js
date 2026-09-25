import express from 'express';
import { pool } from '../db.js';

const router = express.Router();

router.post('/user/select-rating-card', async (req, res, next) => {
  const cardId = String(req.body?.card_id || '');
  if (!/^[0-9a-fA-F-]{36}$/.test(cardId)) return res.status(400).json({ error: 'Valid card_id is required' });
  try {
    const result = await pool.query(
      `UPDATE users u SET active_rating_card_id = c.id
       FROM cards c
       WHERE u.id = $1 AND c.id = $2 AND c.user_id = u.id
       RETURNING u.active_rating_card_id`,
      [req.user.id, cardId]
    );
    if (!result.rows[0]) return res.status(404).json({ error: 'Card not found or does not belong to user' });
    return res.json({ success: true, active_rating_card_id: result.rows[0].active_rating_card_id });
  } catch (error) {
    return next(error);
  }
});

router.get('/rating', async (_req, res, next) => {
  try {
    const result = await pool.query(
      `SELECT u.username, rc.balance
       FROM users u
       LEFT JOIN LATERAL (
         SELECT c.balance
         FROM cards c
         WHERE c.user_id = u.id
         ORDER BY CASE WHEN c.id = u.active_rating_card_id THEN 0 ELSE 1 END, c.created_at ASC
         LIMIT 1
       ) rc ON TRUE
       ORDER BY COALESCE(rc.balance, 0) DESC, u.username ASC
       LIMIT 50`
    );
    return res.json(result.rows.map((row, index) => ({ place: index + 1, username: row.username, balance: row.balance || '0' })));
  } catch (error) {
    return next(error);
  }
});

export default router;
