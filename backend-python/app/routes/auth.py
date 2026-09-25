from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy import select
from sqlalchemy.orm import Session
from ..auth import create_token, hash_password, verify_password
from ..database import get_db
from ..models import User
from ..schemas import AuthBody
from ..services import create_unique_card
from ..utils import normalize_username, validate_password, validate_username

router = APIRouter(prefix='/api/auth', tags=['auth'])

@router.post('/register', status_code=201)
def register(body: AuthBody, db: Session = Depends(get_db)):
    username = normalize_username(body.username)
    if not validate_username(username):
        raise HTTPException(400, 'Invalid username')
    if not validate_password(body.password):
        raise HTTPException(400, 'Password must be 8-72 characters')
    try:
        with db.begin():
            if db.scalar(select(User).where(User.username == username)):
                raise HTTPException(409, 'Username already exists')
            user = User(username=username, password_hash=hash_password(body.password))
            db.add(user)
            db.flush()
            card = create_unique_card(db, user.id, username)
    except Exception:
        db.rollback()
        raise
    return {
        'token': create_token(user),
        'user': {'id': str(user.id), 'username': user.username, 'crypto_balance': str(user.crypto_balance), 'active_rating_card_id': None},
        'first_card': {'id': str(card.id), 'user_id': str(card.user_id), 'card_number': card.card_number, 'card_holder': card.card_holder, 'balance': str(card.balance), 'exp_date': card.exp_date, 'cvv': card.cvv, 'created_at': card.created_at.isoformat()}
    }

@router.post('/login')
def login(body: AuthBody, db: Session = Depends(get_db)):
    username = normalize_username(body.username)
    user = db.scalar(select(User).where(User.username == username))
    if not user or not verify_password(body.password, user.password_hash):
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, 'Invalid username or password')
    return {
        'token': create_token(user),
        'user': {'id': str(user.id), 'username': user.username, 'crypto_balance': str(user.crypto_balance), 'active_rating_card_id': str(user.active_rating_card_id) if user.active_rating_card_id else None}
    }
