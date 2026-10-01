from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import func, select
from sqlalchemy.orm import Session
from ..auth import get_current_user
from ..database import get_db
from ..models import Card, User
from ..services import create_unique_card

router = APIRouter(prefix='/api/cards', tags=['cards'], dependencies=[Depends(get_current_user)])

@router.get('')
def get_cards(user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    cards = list(db.scalars(select(Card).where(Card.user_id == user.id).order_by(Card.created_at.asc())))
    return {
        'active_rating_card_id': str(user.active_rating_card_id) if user.active_rating_card_id else None,
        'cards': [
            {'id': str(c.id), 'user_id': str(c.user_id), 'card_number': c.card_number, 'card_holder': c.card_holder, 'balance': str(c.balance), 'exp_date': c.exp_date, 'cvv': c.cvv, 'created_at': c.created_at.isoformat()}
            for c in cards
        ]
    }

@router.post('/create', status_code=201)
def create_card(user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    with db.begin():
        count = db.scalar(select(func.count(Card.id)).where(Card.user_id == user.id)) or 0
        if count >= 5:
            raise HTTPException(400, 'Maximum of 5 cards per user')
        db.refresh(user)
        card = create_unique_card(db, user.id, user.username)
    return {'id': str(card.id), 'user_id': str(card.user_id), 'card_number': card.card_number, 'card_holder': card.card_holder, 'balance': str(card.balance), 'exp_date': card.exp_date, 'cvv': card.cvv, 'created_at': card.created_at.isoformat()}
