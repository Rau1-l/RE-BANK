import express from 'express';
import { pool } from '../db.js';
import { clickRateLimit } from '../rate_limit.js';

const router = express.Router();

router.post('/', clickRateLimit, async (req, res, next) => {
  const cardId = String(req.body?.card_id || '');
  if (!/^[0-9a-fA-F-]{36}$/.test(cardId)) return res.status(400).json({ error: 'Valid card_id is required' });
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await client.query(
      `UPDATE cards SET balance = balance + 1.00
       WHERE id = $1 AND user_id = $2
       RETURNING id, balance`,
      [cardId, req.user.id]
    );
    if (!result.rows[0]) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Card not found' });
    }
    await client.query(
      `INSERT INTO transactions (sender_card_id, receiver_card_id, amount, type)
       VALUES (NULL, $1, 1.00, 'click')`,
      [cardId]
    );
    await client.query('COMMIT');
    return res.json({ success: true, card_id: cardId, new_balance: result.rows[0].balance });
  } catch (error) {
    await client.query('ROLLBACK');
    return next(error);
  } finally {
    client.release();
  }
});

export default router;
