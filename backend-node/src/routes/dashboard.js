import express from 'express';
import { pool } from '../db.js';
import { daysAgoUtc, startOfUtcDay } from '../utils.js';

const router = express.Router();

router.get('/stats', async (req, res, next) => {
  try {
    const cardResult = await pool.query(`SELECT id, balance FROM cards WHERE user_id = $1 ORDER BY created_at ASC`, [req.user.id]);
    const cards = cardResult.rows;
    const totalBalance = cards.reduce((sum, card) => sum + Number(card.balance), 0);
    const userResult = await pool.query(`SELECT crypto_balance FROM users WHERE id = $1`, [req.user.id]);
    const cryptoBalance = userResult.rows[0]?.crypto_balance || '0';
    const start = daysAgoUtc(6);
    const txResult = await pool.query(
      `SELECT t.created_at, t.amount, t.sender_card_id, t.receiver_card_id
       FROM transactions t
       WHERE t.created_at >= $1
         AND (t.sender_card_id = ANY($2::uuid[]) OR t.receiver_card_id = ANY($2::uuid[]))
       ORDER BY t.created_at ASC`,
      [start, cards.map((card) => card.id)]
    );
    const cardIds = new Set(cards.map((card) => card.id));
    const dailyDelta = new Map();
    for (const tx of txResult.rows) {
      const key = new Date(tx.created_at).toISOString().slice(0, 10);
      let delta = Number(dailyDelta.get(key) || 0);
      if (tx.sender_card_id && cardIds.has(tx.sender_card_id)) delta -= Number(tx.amount);
      if (tx.receiver_card_id && cardIds.has(tx.receiver_card_id)) delta += Number(tx.amount);
      dailyDelta.set(key, delta);
    }
    const today = startOfUtcDay(new Date());
    const dates = [];
    for (let i = 6; i >= 0; i -= 1) {
      const d = new Date(today);
      d.setUTCDate(d.getUTCDate() - i);
      dates.push(d.toISOString().slice(0, 10));
    }
    const balances = new Map();
    balances.set(dates[dates.length - 1], totalBalance);
    for (let i = dates.length - 2; i >= 0; i -= 1) {
      const followingDate = dates[i + 1];
      const dayChange = Number(dailyDelta.get(followingDate) || 0);
      const followingBalance = balances.get(followingDate);
      balances.set(dates[i], followingBalance - dayChange);
    }
    return res.json({
      total_balance: totalBalance.toFixed(2),
      crypto_balance: cryptoBalance,
      chart: dates.map((date) => ({ date, total_balance: Number((balances.get(date) || 0).toFixed(2)) }))
    });
  } catch (error) {
    return next(error);
  }
});

export default router;
