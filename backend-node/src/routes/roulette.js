import express from 'express';
import crypto from 'node:crypto';
import { pool } from '../db.js';

const router = express.Router();
const LUCKY_SLOT = 77;
const WIN_AMOUNT = '100000.00';

router.post('/spin', async (req, res, next) => {
  const cardId = String(req.body?.card_id || '');
  if (!/^[0-9a-fA-F-]{36}$/.test(cardId)) return res.status(400).json({ error: 'Valid card_id is required' });
  const winningSlot = crypto.randomInt(1, 101);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const cardResult = await client.query(
      `SELECT id, balance FROM cards WHERE id = $1 AND user_id = $2 FOR UPDATE`,
      [cardId, req.user.id]
    );
    if (!cardResult.rows[0]) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Card not found' });
    }
    const currentBalance = cardResult.rows[0].balance;
    const enough = await client.query(`SELECT ($1::numeric >= 1.00) AS enough`, [currentBalance]);
    if (!enough.rows[0].enough) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'Insufficient funds for roulette spin' });
    }
    await client.query(`UPDATE cards SET balance = balance - 1.00 WHERE id = $1`, [cardId]);
    await client.query(
      `INSERT INTO transactions (sender_card_id, receiver_card_id, amount, type)
       VALUES ($1, NULL, 1.00, 'roulette_spin')`,
      [cardId]
    );
    let winAmount = '0.00';
    if (winningSlot === LUCKY_SLOT) {
      winAmount = WIN_AMOUNT;
      await client.query(`UPDATE cards SET balance = balance + $1::numeric WHERE id = $2`, [WIN_AMOUNT, cardId]);
      await client.query(
        `INSERT INTO transactions (sender_card_id, receiver_card_id, amount, type)
         VALUES (NULL, $1, $2::numeric, 'roulette_win')`,
        [cardId, WIN_AMOUNT]
      );
    }
    const newBalance = await client.query(`SELECT balance FROM cards WHERE id = $1`, [cardId]);
    await client.query('COMMIT');
    return res.json({
      success: winningSlot === LUCKY_SLOT,
      winning_slot: winningSlot,
      lucky_slot: LUCKY_SLOT,
      new_balance: newBalance.rows[0].balance,
      win_amount: winAmount
    });
  } catch (error) {
    await client.query('ROLLBACK');
    return next(error);
  } finally {
    client.release();
  }
});

export default router;
