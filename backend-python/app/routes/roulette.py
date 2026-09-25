import secrets
import uuid
from decimal import Decimal
from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import select
from sqlalchemy.orm import Session
from ..auth import get_current_user
from ..database import get_db
from ..models import Card, Transaction, User
from ..schemas import RouletteBody

router = APIRouter(prefix='/api/roulette', tags=['roulette'])
LUCKY_SLOT = 77
WIN_AMOUNT = Decimal('100000.00')

@router.post('/spin')
def spin(body: RouletteBody, user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    try:
        card_id = uuid.UUID(body.card_id)
    except ValueError:
        raise HTTPException(400, 'Valid card_id is required')
    winning_slot = secrets.randbelow(100) + 1
    with db.begin():
        card = db.scalar(select(Card).where(Card.id == card_id, Card.user_id == user.id).with_for_update())
        if not card:
            raise HTTPException(404, 'Card not found')
        if Decimal(card.balance) < Decimal('1.00'):
            raise HTTPException(400, 'Insufficient funds for roulette spin')
        card.balance = Decimal(card.balance) - Decimal('1.00')
        db.add(Transaction(sender_card_id=card.id, amount=Decimal('1.00'), type='roulette_spin'))
        win_amount = Decimal('0')
        if winning_slot == LUCKY_SLOT:
            win_amount = WIN_AMOUNT
            card.balance = Decimal(card.balance) + WIN_AMOUNT
            db.add(Transaction(receiver_card_id=card.id, amount=WIN_AMOUNT, type='roulette_win'))
        db.flush()
        new_balance = card.balance
    return {'success': winning_slot == LUCKY_SLOT, 'winning_slot': winning_slot, 'lucky_slot': LUCKY_SLOT, 'new_balance': str(new_balance), 'win_amount': str(win_amount.quantize(Decimal('0.01')))}
