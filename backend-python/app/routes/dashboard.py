from fastapi import APIRouter, Depends
from sqlalchemy import select
from sqlalchemy.orm import Session
from ..auth import get_current_user
from ..database import get_db
from ..models import User
from ..services import dashboard_stats

router = APIRouter(prefix='/api/dashboard', tags=['dashboard'])

@router.get('/stats')
def stats(user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    total, chart = dashboard_stats(db, user.id)
    current_user = db.scalar(select(User).where(User.id == user.id))
    return {'total_balance': f'{total:.2f}', 'crypto_balance': str(current_user.crypto_balance), 'chart': chart}
