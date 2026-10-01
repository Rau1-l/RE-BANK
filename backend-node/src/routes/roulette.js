import express from 'express';
import crypto from 'node:crypto';
import { pool } from '../db.js';

const router = express.Router();
// Landing on slot 66 pays the most; slot 77 is the classic lucky slot.
const WIN_66 = '150000.00';
const WIN_77 = '100000.00';

function cleanBet(value) {
  const s = String(value ?? '1');
  if (!/^(?:0|[1-9]\d*)(?:\.\d{1,2})?$/.test(s)) return null;
  const n = Number(s);
  if (n < 1 || n > 1000000) return null;
  return s;
}

router.post('/spin', async (req, res, next) => {
  const cardId = String(req.body?.card_id || '');
  if (!/^[0-9a-fA-F-]{36}$/.test(cardId)) return res.status(400).json({ error: 'Valid card_id is required' });
  const bet = cleanBet(req.body?.bet ?? '1');
  if (bet === null) return res.status(400).json({ error: 'Bet must be between $1 and $1,000,000' });
  // More money bet => more chances to win (one extra draw per whole dollar, max 50).
  const chances = Math.min(50, Math.max(1, Math.floor(Number(bet))));
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
    const enough = await client.query(`SELECT ($1::numeric >= $2::numeric) AS enough`, [cardResult.rows[0].balance, bet]);
    if (!enough.rows[0].enough) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'Insufficient funds for roulette spin' });
    }
    await client.query(`UPDATE cards SET balance = balance - $1::numeric WHERE id = $2`, [bet, cardId]);
    await client.query(
      `INSERT INTO transactions (sender_card_id, receiver_card_id, amount, type)
       VALUES ($1, NULL, $2::numeric, 'roulette_spin')`,
      [cardId, bet]
    );

    let displaySlot = crypto.randomInt(1, 101);
    let bestSlot = 0;
    for (let i = 0; i < chances; i += 1) {
      const slot = crypto.randomInt(1, 101);
      if (slot === 66) { bestSlot = 66; displaySlot = 66; }
      else if (slot === 77 && bestSlot !== 66) { bestSlot = 77; displaySlot = 77; }
    }

    let winAmount = '0.00';
    if (bestSlot === 66) winAmount = WIN_66;
    else if (bestSlot === 77) winAmount = WIN_77;

    if (bestSlot !== 0) {
      await client.query(`UPDATE cards SET balance = balance + $1::numeric WHERE id = $2`, [winAmount, cardId]);
      await client.query(
        `INSERT INTO transactions (sender_card_id, receiver_card_id, amount, type)
         VALUES (NULL, $1, $2::numeric, 'roulette_win')`,
        [cardId, winAmount]
      );
    }
    const newBalance = await client.query(`SELECT balance FROM cards WHERE id = $1`, [cardId]);
    await client.query('COMMIT');
    return res.json({
      success: bestSlot !== 0,
      winning_slot: displaySlot,
      lucky_slots: [66, 77],
      lucky_slot: 77,
      bet,
      chances,
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
