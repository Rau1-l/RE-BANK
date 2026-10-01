import express from 'express';
import { pool } from '../db.js';
import { cryptoUsdRate, validCryptoAmount } from '../utils.js';

const router = express.Router();
const lastEarnByUser = new Map();

router.get('/rate', (_req, res) => {
  return res.json({ symbol: 'BTC/USD', rate: cryptoUsdRate(), updated_every_seconds: 10 });
});

router.post('/earn', async (req, res, next) => {
  const now = Date.now();
  const last = lastEarnByUser.get(req.user.id) || 0;
  const remaining = 60000 - (now - last);
  if (remaining > 0) return res.status(429).json({ error: 'Passive income can be collected once per minute', retry_after_seconds: Math.ceil(remaining / 1000) });
  try {
    const result = await pool.query(
      `UPDATE users SET crypto_balance = crypto_balance + 0.000010
       WHERE id = $1
       RETURNING crypto_balance`,
      [req.user.id]
    );
    if (!result.rows[0]) return res.status(404).json({ error: 'User not found' });
    lastEarnByUser.set(req.user.id, now);
    return res.json({ success: true, earned_crypto: '0.00001000', crypto_balance: result.rows[0].crypto_balance, rate: cryptoUsdRate() });
  } catch (error) {
    return next(error);
  }
});

router.post('/sell', async (req, res, next) => {
  const cardId = String(req.body?.card_id || '');
  const amountCrypto = String(req.body?.amount_crypto ?? '');
  if (!/^[0-9a-fA-F-]{36}$/.test(cardId)) return res.status(400).json({ error: 'Valid card_id is required' });
  if (!validCryptoAmount(amountCrypto)) return res.status(400).json({ error: 'Crypto amount must be positive with up to 8 decimals' });
  const rate = cryptoUsdRate();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const userResult = await client.query(
      `SELECT crypto_balance FROM users WHERE id = $1 FOR UPDATE`,
      [req.user.id]
    );
    if (!userResult.rows[0]) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'User not found' });
    }
    const userCrypto = userResult.rows[0].crypto_balance;
    const check = await client.query(`SELECT ($1::numeric >= $2::numeric) AS enough`, [userCrypto, amountCrypto]);
    if (!check.rows[0].enough) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'Insufficient crypto balance' });
    }
    const cardResult = await client.query(
      `SELECT id FROM cards WHERE id = $1 AND user_id = $2 FOR UPDATE`,
      [cardId, req.user.id]
    );
    if (!cardResult.rows[0]) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Destination card not found' });
    }
    const userUpdated = await client.query(
      `UPDATE users SET crypto_balance = crypto_balance - $1::numeric
       WHERE id = $2 RETURNING crypto_balance`,
      [amountCrypto, req.user.id]
    );
    const cardUpdated = await client.query(
      `UPDATE cards SET balance = balance + ($1::numeric * $2::numeric)
       WHERE id = $3 RETURNING balance`,
      [amountCrypto, rate, cardId]
    );
    const usdAmount = await client.query(`SELECT ($1::numeric * $2::numeric)::numeric AS value`, [amountCrypto, rate]);
    await client.query(
      `INSERT INTO transactions (sender_card_id, receiver_card_id, amount, type)
       VALUES (NULL, $1, $2::numeric, 'crypto_exchange')`,
      [cardId, usdAmount.rows[0].value]
    );
    await client.query('COMMIT');
    return res.json({ success: true, rate, usd_amount: usdAmount.rows[0].value, crypto_balance: userUpdated.rows[0].crypto_balance, card_balance: cardUpdated.rows[0].balance });
  } catch (error) {
    await client.query('ROLLBACK');
    return next(error);
  } finally {
    client.release();
  }
});

export default router;
