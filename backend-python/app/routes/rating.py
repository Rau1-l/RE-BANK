import uuid
from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import case, func, select
from sqlalchemy.orm import Session
from ..auth import get_current_user
from ..database import get_db
from ..models import Card, User
from ..schemas import RatingBody

router = APIRouter(prefix='/api', tags=['rating'])

@router.post('/user/select-rating-card')
def select_rating_card(body: RatingBody, user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    try:
        card_id = uuid.UUID(body.card_id)
    except ValueError:
        raise HTTPException(400, 'Valid card_id is required')
    with db.begin():
        card = db.scalar(select(Card).where(Card.id == card_id, Card.user_id == user.id).with_for_update())
        if not card:
            raise HTTPException(404, 'Card not found or does not belong to user')
        current = db.scalar(select(User).where(User.id == user.id).with_for_update())
        current.active_rating_card_id = card.id
        db.flush()
    return {'success': True, 'active_rating_card_id': str(card_id)}

@router.get('/rating')
def rating(user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    active_balance = select(Card.balance).where(Card.id == User.active_rating_card_id).scalar_subquery()
    first_balance = select(Card.balance).where(Card.user_id == User.id).order_by(Card.created_at.asc()).limit(1).scalar_subquery()
    balance_expr = func.coalesce(active_balance, first_balance)
    stmt = select(User.username, balance_expr.label('balance')).order_by(balance_expr.desc(), User.username.asc()).limit(50)
    rows = db.execute(stmt).all()
    return [{'place': idx + 1, 'username': row.username, 'balance': str(row.balance or 0)} for idx, row in enumerate(rows)]
