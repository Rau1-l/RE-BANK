from fastapi import APIRouter, Depends, HTTPException, Request
from sqlalchemy import select
from sqlalchemy.orm import Session
from ..auth import get_current_user
from ..database import get_db
from ..models import Card, Transaction, User
from ..rate_limit import check_click_limit
from ..schemas import ClickBody

router = APIRouter(prefix='/api/click', tags=['click'])

@router.post('')
def click(body: ClickBody, request: Request, user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    check_click_limit(request, user.id)
    try:
        import uuid
        card_id = uuid.UUID(body.card_id)
    except ValueError:
        raise HTTPException(400, 'Valid card_id is required')
    with db.begin():
        card = db.scalar(select(Card).where(Card.id == card_id, Card.user_id == user.id).with_for_update())
        if not card:
            raise HTTPException(404, 'Card not found')
        card.balance += 1
        db.add(Transaction(receiver_card_id=card.id, amount=1, type='click'))
        db.flush()
        new_balance = card.balance
    return {'success': True, 'card_id': str(card_id), 'new_balance': str(new_balance)}
