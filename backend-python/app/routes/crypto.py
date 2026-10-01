import uuid
import time
from decimal import Decimal
from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import select
from sqlalchemy.orm import Session
from ..auth import get_current_user
from ..database import get_db
from ..models import Card, Transaction, User
from ..schemas import CryptoSellBody
from ..utils import crypto_usd_rate, valid_crypto_amount

router = APIRouter(prefix='/api/crypto', tags=['crypto'])
last_earn = {}

@router.get('/rate')
def rate(user: User = Depends(get_current_user)):
    return {'symbol': 'BTC/USD', 'rate': crypto_usd_rate(), 'updated_every_seconds': 10}

@router.post('/earn')
def earn(user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    now = time.monotonic()
    last = last_earn.get(user.id, 0)
    remaining = 60 - (now - last)
    if remaining > 0:
        raise HTTPException(429, detail={'message': 'Passive income can be collected once per minute', 'retry_after_seconds': int(remaining) + 1})
    with db.begin():
        current = db.scalar(select(User).where(User.id == user.id).with_for_update())
        if not current:
            raise HTTPException(404, 'User not found')
        current.crypto_balance = Decimal(current.crypto_balance) + Decimal('0.000010')
        db.flush()
        balance = current.crypto_balance
    last_earn[user.id] = now
    return {'success': True, 'earned_crypto': '0.00001000', 'crypto_balance': str(balance), 'rate': crypto_usd_rate()}

@router.post('/sell')
def sell(body: CryptoSellBody, user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    try:
        card_id = uuid.UUID(body.card_id)
    except ValueError:
        raise HTTPException(400, 'Valid card_id is required')
    if not valid_crypto_amount(body.amount_crypto):
        raise HTTPException(400, 'Crypto amount must be positive with up to 8 decimals')
    amount_crypto = Decimal(body.amount_crypto)
    rate_now = Decimal(str(crypto_usd_rate()))
    with db.begin():
        current = db.scalar(select(User).where(User.id == user.id).with_for_update())
        if not current:
            raise HTTPException(404, 'User not found')
        if Decimal(current.crypto_balance) < amount_crypto:
            raise HTTPException(400, 'Insufficient crypto balance')
        card = db.scalar(select(Card).where(Card.id == card_id, Card.user_id == user.id).with_for_update())
        if not card:
            raise HTTPException(404, 'Destination card not found')
        usd_amount = amount_crypto * rate_now
        current.crypto_balance = Decimal(current.crypto_balance) - amount_crypto
        card.balance = Decimal(card.balance) + usd_amount
        db.add(Transaction(receiver_card_id=card.id, amount=usd_amount, type='crypto_exchange'))
        db.flush()
        crypto_balance = current.crypto_balance
        card_balance = card.balance
    return {'success': True, 'rate': int(rate_now), 'usd_amount': str(usd_amount), 'crypto_balance': str(crypto_balance), 'card_balance': str(card_balance)}
