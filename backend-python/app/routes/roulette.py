import secrets
import re
import uuid
from decimal import Decimal, ROUND_HALF_UP
from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import select
from sqlalchemy.orm import Session
from ..auth import get_current_user
from ..database import get_db
from ..models import Card, Transaction, User
from ..schemas import RouletteBody

router = APIRouter(prefix='/api/roulette', tags=['roulette'])
# Slot 66 pays the most; slot 77 is the classic lucky slot.
WIN_66 = Decimal('150000.00')
WIN_77 = Decimal('100000.00')

def clean_bet(value):
    s = str(value if value is not None else '1')
    if not re.fullmatch(r'(?:0|[1-9]\d*)(?:\.\d{1,2})?', s):
        return None
    amount = Decimal(s)
    if amount < 1 or amount > 1000000:
        return None
    return amount

@router.post('/spin')
def spin(body: RouletteBody, user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    try:
        card_id = uuid.UUID(body.card_id)
    except ValueError:
        raise HTTPException(400, 'Valid card_id is required')
    bet = clean_bet(body.bet)
    if bet is None:
        raise HTTPException(400, 'Bet must be between $1 and $1,000,000')
    # More money bet => more chances to win (one extra draw per whole dollar, max 50).
    chances = min(50, max(1, int(bet)))
    with db.begin():
        card = db.scalar(select(Card).where(Card.id == card_id, Card.user_id == user.id).with_for_update())
        if not card:
            raise HTTPException(404, 'Card not found')
        if Decimal(card.balance) < bet:
            raise HTTPException(400, 'Insufficient funds for roulette spin')
        card.balance = Decimal(card.balance) - bet
        db.add(Transaction(sender_card_id=card.id, amount=bet, type='roulette_spin'))

        display_slot = secrets.randbelow(100) + 1
        best_slot = 0
        for _ in range(chances):
            slot = secrets.randbelow(100) + 1
            if slot == 66:
                best_slot = 66
                display_slot = 66
            elif slot == 77 and best_slot != 66:
                best_slot = 77
                display_slot = 77

        win_amount = Decimal('0')
        if best_slot == 66:
            win_amount = WIN_66
        elif best_slot == 77:
            win_amount = WIN_77

        if best_slot != 0:
            card.balance = Decimal(card.balance) + win_amount
            db.add(Transaction(receiver_card_id=card.id, amount=win_amount, type='roulette_win'))
        db.flush()
        new_balance = card.balance
    return {
        'success': best_slot != 0,
        'winning_slot': display_slot,
        'lucky_slots': [66, 77],
        'lucky_slot': 77,
        'bet': str(bet.quantize(Decimal('0.01'), rounding=ROUND_HALF_UP)),
        'chances': chances,
        'new_balance': str(new_balance),
        'win_amount': str(win_amount.quantize(Decimal('0.01')))
    }
