import express from 'express';
import { pool } from '../db.js';
import { normalizeCardNumber, validUsdAmount } from '../utils.js';

const router = express.Router();

router.post('/', async (req, res, next) => {
  const senderCardId = String(req.body?.sender_card_id || '');
  const receiverCardNumber = normalizeCardNumber(req.body?.receiver_card_number);
  const amount = String(req.body?.amount ?? '');
  if (!/^[0-9a-fA-F-]{36}$/.test(senderCardId)) return res.status(400).json({ error: 'Valid sender_card_id is required' });
  if (!/^\d{16}$/.test(receiverCardNumber)) return res.status(400).json({ error: 'Receiver card number must contain 16 digits' });
  if (!validUsdAmount(amount)) return res.status(400).json({ error: 'Amount must be a positive number with up to 2 decimals' });

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const senderResult = await client.query(
      `SELECT id, balance FROM cards WHERE id = $1 AND user_id = $2 FOR UPDATE`,
      [senderCardId, req.user.id]
    );
    if (!senderResult.rows[0]) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Sender card not found' });
    }
    const sender = senderResult.rows[0];
    const receiverResult = await client.query(
      `SELECT id, user_id, card_number, balance FROM cards WHERE card_number = $1 FOR UPDATE`,
      [receiverCardNumber]
    );
    if (!receiverResult.rows[0]) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Receiver card not found' });
    }
    const receiver = receiverResult.rows[0];
    if (receiver.id === sender.id) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'Sender and receiver cards must be different' });
    }
    const balanceCheck = await client.query(`SELECT ($1::numeric >= $2::numeric) AS enough`, [sender.balance, amount]);
    if (!balanceCheck.rows[0].enough) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'Insufficient funds' });
    }
    const updatedSender = await client.query(
      `UPDATE cards SET balance = balance - $1::numeric WHERE id = $2 RETURNING balance`,
      [amount, sender.id]
    );
    const updatedReceiver = await client.query(
      `UPDATE cards SET balance = balance + $1::numeric WHERE id = $2 RETURNING balance`,
      [amount, receiver.id]
    );
    await client.query(
      `INSERT INTO transactions (sender_card_id, receiver_card_id, amount, type)
       VALUES ($1, $2, $3::numeric, 'transfer')`,
      [sender.id, receiver.id, amount]
    );
    await client.query('COMMIT');
    return res.json({
      success: true,
      amount,
      sender_card_id: sender.id,
      receiver_card_id: receiver.id,
      sender_new_balance: updatedSender.rows[0].balance,
      receiver_new_balance: updatedReceiver.rows[0].balance
    });
  } catch (error) {
    await client.query('ROLLBACK');
    return next(error);
  } finally {
    client.release();
  }
});

export default router;
