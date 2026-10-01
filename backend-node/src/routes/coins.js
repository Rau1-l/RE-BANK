import express from 'express';
import { pool } from '../db.js';

const router = express.Router();

function cleanUsd(value, min) {
  const s = String(value ?? '');
  if (!/^(?:0|[1-9]\d*)(?:\.\d{1,2})?$/.test(s)) return null;
  const n = Number(s);
  if (n < min || n > 9999999999) return null;
  return s;
}

function cleanAmount(value) {
  const s = String(value ?? '');
  if (!/^(?:0|[1-9]\d*)(?:\.\d{1,8})?$/.test(s) || Number(s) <= 0) return null;
  return s;
}

// List every coin on the marketplace with the caller's own holding.
router.get('/', async (req, res, next) => {
  try {
    const result = await pool.query(
      `SELECT c.id, c.name, c.symbol, c.price_usd, c.supply, u.username AS owner,
              (c.owner_id = $1) AS is_owner,
              COALESCE((SELECT h.amount FROM coin_holdings h WHERE h.coin_id = c.id AND h.user_id = $1), 0) AS my_amount,
              c.created_at
       FROM coins c JOIN users u ON u.id = c.owner_id
       ORDER BY c.created_at DESC`,
      [req.user.id]
    );
    return res.json(result.rows);
  } catch (error) {
    return next(error);
  }
});

// Create your own coin: costs at least $100, you get 1 unit per $1 invested.
router.post('/create', async (req, res, next) => {
  const cardId = String(req.body?.card_id || '');
  const name = String(req.body?.name ?? '').trim();
  const symbol = String(req.body?.symbol ?? '').trim().toUpperCase();
  const invest = cleanUsd(req.body?.invest, 100);
  if (!/^[0-9a-fA-F-]{36}$/.test(cardId)) return res.status(400).json({ error: 'Valid card_id is required' });
  if (name.length < 2 || name.length > 40) return res.status(400).json({ error: 'Coin name must be 2-40 characters' });
  if (!/^[A-Z0-9]{2,10}$/.test(symbol)) return res.status(400).json({ error: 'Symbol must be 2-10 letters or digits' });
  if (invest === null) return res.status(400).json({ error: 'Minimum investment to create a coin is $100' });
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const dup = await client.query(`SELECT 1 FROM coins WHERE symbol = $1`, [symbol]);
    if (dup.rows[0]) {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: 'This coin symbol already exists' });
    }
    const card = await client.query(`SELECT id, balance FROM cards WHERE id = $1 AND user_id = $2 FOR UPDATE`, [cardId, req.user.id]);
    if (!card.rows[0]) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Card not found' });
    }
    const enough = await client.query(`SELECT ($1::numeric >= $2::numeric) AS enough`, [card.rows[0].balance, invest]);
    if (!enough.rows[0].enough) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'Insufficient funds' });
    }
    await client.query(`UPDATE cards SET balance = balance - $1::numeric WHERE id = $2`, [invest, cardId]);
    await client.query(`INSERT INTO transactions (sender_card_id, amount, type) VALUES ($1, $2::numeric, 'crypto_exchange')`, [cardId, invest]);
    const coin = await client.query(
      `INSERT INTO coins (owner_id, name, symbol, price_usd, supply) VALUES ($1, $2, $3, 1.00, $4::numeric) RETURNING *`,
      [req.user.id, name, symbol, invest]
    );
    await client.query(`INSERT INTO coin_holdings (coin_id, user_id, amount) VALUES ($1, $2, $3::numeric)`, [coin.rows[0].id, req.user.id, invest]);
    const newBalance = await client.query(`SELECT balance FROM cards WHERE id = $1`, [cardId]);
    await client.query('COMMIT');
    return res.status(201).json({ success: true, coin: coin.rows[0], units: invest, card_balance: newBalance.rows[0].balance });
  } catch (error) {
    await client.query('ROLLBACK');
    return next(error);
  } finally {
    client.release();
  }
});

// Buy units of any coin; the USD cost is paid to the coin creator's oldest card.
router.post('/buy', async (req, res, next) => {
  const cardId = String(req.body?.card_id || '');
  const coinId = String(req.body?.coin_id || '');
  const amount = cleanAmount(req.body?.amount);
  if (!/^[0-9a-fA-F-]{36}$/.test(cardId)) return res.status(400).json({ error: 'Valid card_id is required' });
  if (!/^[0-9a-fA-F-]{36}$/.test(coinId)) return res.status(400).json({ error: 'Valid coin_id is required' });
  if (amount === null) return res.status(400).json({ error: 'Amount must be positive with up to 8 decimals' });
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const coin = await client.query(`SELECT * FROM coins WHERE id = $1 FOR UPDATE`, [coinId]);
    if (!coin.rows[0]) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Coin not found' });
    }
    const costRow = await client.query(`SELECT ROUND($1::numeric * $2::numeric, 2) AS cost`, [amount, coin.rows[0].price_usd]);
    const cost = costRow.rows[0].cost;
    if (Number(cost) <= 0) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'Amount is too small' });
    }
    const card = await client.query(`SELECT id, balance FROM cards WHERE id = $1 AND user_id = $2 FOR UPDATE`, [cardId, req.user.id]);
    if (!card.rows[0]) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Card not found' });
    }
    const enough = await client.query(`SELECT ($1::numeric >= $2::numeric) AS enough`, [card.rows[0].balance, cost]);
    if (!enough.rows[0].enough) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'Insufficient funds' });
    }
    await client.query(`UPDATE cards SET balance = balance - $1::numeric WHERE id = $2`, [cost, cardId]);
    await client.query(`INSERT INTO transactions (sender_card_id, amount, type) VALUES ($1, $2::numeric, 'crypto_exchange')`, [cardId, cost]);
    if (coin.rows[0].owner_id !== req.user.id) {
      const ownerCard = await client.query(`SELECT id FROM cards WHERE user_id = $1 ORDER BY created_at ASC LIMIT 1 FOR UPDATE`, [coin.rows[0].owner_id]);
      if (ownerCard.rows[0]) {
        await client.query(`UPDATE cards SET balance = balance + $1::numeric WHERE id = $2`, [cost, ownerCard.rows[0].id]);
        await client.query(`INSERT INTO transactions (receiver_card_id, amount, type) VALUES ($1, $2::numeric, 'crypto_exchange')`, [ownerCard.rows[0].id, cost]);
      }
    }
    const holding = await client.query(
      `INSERT INTO coin_holdings (coin_id, user_id, amount) VALUES ($1, $2, $3::numeric)
       ON CONFLICT (coin_id, user_id) DO UPDATE SET amount = coin_holdings.amount + EXCLUDED.amount
       RETURNING amount`,
      [coinId, req.user.id, amount]
    );
    const updatedCoin = await client.query(`UPDATE coins SET supply = supply + $1::numeric WHERE id = $2 RETURNING *`, [amount, coinId]);
    const newBalance = await client.query(`SELECT balance FROM cards WHERE id = $1`, [cardId]);
    await client.query('COMMIT');
    return res.json({ success: true, coin: updatedCoin.rows[0], bought: amount, cost, my_amount: holding.rows[0].amount, card_balance: newBalance.rows[0].balance });
  } catch (error) {
    await client.query('ROLLBACK');
    return next(error);
  } finally {
    client.release();
  }
});

export default router;
