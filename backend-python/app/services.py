from collections import defaultdict
from datetime import datetime, timezone, timedelta
from decimal import Decimal
from sqlalchemy import select
from sqlalchemy.orm import Session
from .models import Card, Transaction
from .utils import generate_card_number, generate_cvv, generate_exp_date, format_card_holder


def create_unique_card(db: Session, user_id, username):
    for _ in range(30):
        number = generate_card_number()
        exists = db.scalar(select(Card.id).where(Card.card_number == number))
        if exists:
            continue
        card = Card(
            user_id=user_id,
            card_number=number,
            card_holder=format_card_holder(username),
            balance=Decimal('0'),
            exp_date=generate_exp_date(),
            cvv=generate_cvv()
        )
        db.add(card)
        db.flush()
        return card
    raise RuntimeError('Unable to generate a unique card number')


def user_cards(db: Session, user_id):
    return list(db.scalars(select(Card).where(Card.user_id == user_id).order_by(Card.created_at.asc())))


def dashboard_stats(db: Session, user_id):
    cards = user_cards(db, user_id)
    total = sum((Decimal(c.balance) for c in cards), Decimal('0'))
    card_ids = {c.id for c in cards}
    now = datetime.now(timezone.utc)
    today = datetime(now.year, now.month, now.day, tzinfo=timezone.utc)
    start = today - timedelta(days=6)
    txs = []
    if card_ids:
        txs = list(db.scalars(
            select(Transaction).where(
                Transaction.created_at >= start,
                (Transaction.sender_card_id.in_(card_ids) | Transaction.receiver_card_id.in_(card_ids))
            ).order_by(Transaction.created_at.asc())
        ))
    daily = defaultdict(Decimal)
    for tx in txs:
        created = tx.created_at
        if created.tzinfo is None:
            created = created.replace(tzinfo=timezone.utc)
        key = created.date().isoformat()
        delta = Decimal('0')
        if tx.sender_card_id in card_ids:
            delta -= Decimal(tx.amount)
        if tx.receiver_card_id in card_ids:
            delta += Decimal(tx.amount)
        daily[key] += delta
    dates = [(today - timedelta(days=i)).date().isoformat() for i in range(6, -1, -1)]
    balances = {dates[-1]: total}
    for idx in range(len(dates) - 2, -1, -1):
        next_day = dates[idx + 1]
        balances[dates[idx]] = balances[next_day] - daily[next_day]
    return total, [
        {'date': date, 'total_balance': float(balances[date].quantize(Decimal('0.01')))}
        for date in dates
    ]
