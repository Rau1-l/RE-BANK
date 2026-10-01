import uuid
from decimal import Decimal
from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import select
from sqlalchemy.orm import Session
from ..auth import get_current_user
from ..database import get_db
from ..models import Card, Transaction, User
from ..schemas import TransferBody
from ..utils import normalize_card_number, valid_usd_amount

router = APIRouter(prefix='/api/transfers', tags=['transfers'])

@router.post('')
def transfer(body: TransferBody, user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    try:
        sender_id = uuid.UUID(body.sender_card_id)
    except ValueError:
        raise HTTPException(400, 'Valid sender_card_id is required')
    receiver_number = normalize_card_number(body.receiver_card_number)
    if len(receiver_number) != 16 or not receiver_number.isdigit():
        raise HTTPException(400, 'Receiver card number must contain 16 digits')
    if not valid_usd_amount(body.amount):
        raise HTTPException(400, 'Amount must be a positive number with up to 2 decimals')
    amount = Decimal(body.amount)
    with db.begin():
        sender = db.scalar(select(Card).where(Card.id == sender_id, Card.user_id == user.id).with_for_update())
        if not sender:
            raise HTTPException(404, 'Sender card not found')
        receiver = db.scalar(select(Card).where(Card.card_number == receiver_number).with_for_update())
        if not receiver:
            raise HTTPException(404, 'Receiver card not found')
        if sender.id == receiver.id:
            raise HTTPException(400, 'Sender and receiver cards must be different')
        if Decimal(sender.balance) < amount:
            raise HTTPException(400, 'Insufficient funds')
        sender.balance = Decimal(sender.balance) - amount
        receiver.balance = Decimal(receiver.balance) + amount
        db.add(Transaction(sender_card_id=sender.id, receiver_card_id=receiver.id, amount=amount, type='transfer'))
        db.flush()
        sender_balance = sender.balance
        receiver_balance = receiver.balance
    return {'success': True, 'amount': str(amount), 'sender_card_id': str(sender.id), 'receiver_card_id': str(receiver.id), 'sender_new_balance': str(sender_balance), 'receiver_new_balance': str(receiver_balance)}
