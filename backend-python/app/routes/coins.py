import re
import uuid
from decimal import Decimal, ROUND_HALF_UP
from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import select
from sqlalchemy.orm import Session
from ..auth import get_current_user
from ..database import get_db
from ..models import Card, Coin, CoinHolding, Transaction, User
from ..schemas import CoinBuyBody, CoinCreateBody

router = APIRouter(prefix='/api/coins', tags=['coins'])

def clean_usd(value, minimum):
    s = str(value if value is not None else '')
    if not re.fullmatch(r'(?:0|[1-9]\d*)(?:\.\d{1,2})?', s):
        return None
    amount = Decimal(s)
    if amount < minimum or amount > Decimal('9999999999'):
        return None
    return amount

def clean_amount(value):
    s = str(value if value is not None else '')
    if not re.fullmatch(r'(?:0|[1-9]\d*)(?:\.\d{1,8})?', s) or Decimal(s) <= 0:
        return None
    return Decimal(s)

@router.get('')
def list_coins(user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    rows = db.execute(select(Coin, User.username).join(User, User.id == Coin.owner_id).order_by(Coin.created_at.desc())).all()
    result = []
    for coin, owner in rows:
        holding = db.scalar(select(CoinHolding.amount).where(CoinHolding.coin_id == coin.id, CoinHolding.user_id == user.id))
        result.append({
            'id': str(coin.id),
            'name': coin.name,
            'symbol': coin.symbol,
            'price_usd': str(coin.price_usd),
            'supply': str(coin.supply),
            'owner': owner,
            'is_owner': coin.owner_id == user.id,
            'my_amount': str(holding or Decimal('0')),
            'created_at': coin.created_at.isoformat(),
        })
    return result

@router.post('/create')
def create_coin(body: CoinCreateBody, user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    try:
        card_id = uuid.UUID(body.card_id)
    except ValueError:
        raise HTTPException(400, 'Valid card_id is required')
    name = body.name.strip()
    symbol = body.symbol.strip().upper()
    invest = clean_usd(body.invest, Decimal('100'))
    if not (2 <= len(name) <= 40):
        raise HTTPException(400, 'Coin name must be 2-40 characters')
    if not re.fullmatch(r'[A-Z0-9]{2,10}', symbol):
        raise HTTPException(400, 'Symbol must be 2-10 letters or digits')
    if invest is None:
        raise HTTPException(400, 'Minimum investment to create a coin is $100')
    with db.begin():
        if db.scalar(select(Coin).where(Coin.symbol == symbol)):
            raise HTTPException(409, 'This coin symbol already exists')
        card = db.scalar(select(Card).where(Card.id == card_id, Card.user_id == user.id).with_for_update())
        if not card:
            raise HTTPException(404, 'Card not found')
        if Decimal(card.balance) < invest:
            raise HTTPException(400, 'Insufficient funds')
        card.balance = Decimal(card.balance) - invest
        db.add(Transaction(sender_card_id=card.id, amount=invest, type='crypto_exchange'))
        coin = Coin(owner_id=user.id, name=name, symbol=symbol, price_usd=Decimal('1.00'), supply=invest)
        db.add(coin)
        db.flush()
        db.add(CoinHolding(coin_id=coin.id, user_id=user.id, amount=invest))
        db.flush()
        payload = {
            'success': True,
            'coin': {'id': str(coin.id), 'name': coin.name, 'symbol': coin.symbol, 'price_usd': str(coin.price_usd), 'supply': str(coin.supply)},
            'units': str(invest),
            'card_balance': str(card.balance),
        }
    return payload

@router.post('/buy')
def buy_coin(body: CoinBuyBody, user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    try:
        card_id = uuid.UUID(body.card_id)
        coin_id = uuid.UUID(body.coin_id)
    except ValueError:
        raise HTTPException(400, 'Valid ids are required')
    amount = clean_amount(body.amount)
    if amount is None:
        raise HTTPException(400, 'Amount must be positive with up to 8 decimals')
    with db.begin():
        coin = db.scalar(select(Coin).where(Coin.id == coin_id).with_for_update())
        if not coin:
            raise HTTPException(404, 'Coin not found')
        cost = (amount * Decimal(coin.price_usd)).quantize(Decimal('0.01'), rounding=ROUND_HALF_UP)
        if cost <= 0:
            raise HTTPException(400, 'Amount is too small')
        card = db.scalar(select(Card).where(Card.id == card_id, Card.user_id == user.id).with_for_update())
        if not card:
            raise HTTPException(404, 'Card not found')
        if Decimal(card.balance) < cost:
            raise HTTPException(400, 'Insufficient funds')
        card.balance = Decimal(card.balance) - cost
        db.add(Transaction(sender_card_id=card.id, amount=cost, type='crypto_exchange'))
        if coin.owner_id != user.id:
            owner_card = db.scalar(select(Card).where(Card.user_id == coin.owner_id).order_by(Card.created_at.asc()).with_for_update())
            if owner_card:
                owner_card.balance = Decimal(owner_card.balance) + cost
                db.add(Transaction(receiver_card_id=owner_card.id, amount=cost, type='crypto_exchange'))
        holding = db.scalar(select(CoinHolding).where(CoinHolding.coin_id == coin_id, CoinHolding.user_id == user.id).with_for_update())
        if holding:
            holding.amount = Decimal(holding.amount) + amount
        else:
            holding = CoinHolding(coin_id=coin_id, user_id=user.id, amount=amount)
            db.add(holding)
        coin.supply = Decimal(coin.supply) + amount
        db.flush()
        payload = {
            'success': True,
            'coin': {'id': str(coin.id), 'name': coin.name, 'symbol': coin.symbol, 'price_usd': str(coin.price_usd), 'supply': str(coin.supply)},
            'bought': str(amount),
            'cost': str(cost),
            'my_amount': str(holding.amount),
            'card_balance': str(card.balance),
        }
    return payload
