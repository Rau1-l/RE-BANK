import uuid
from datetime import datetime, timezone
from decimal import Decimal
from sqlalchemy import DateTime, ForeignKey, Numeric, String
from sqlalchemy.orm import Mapped, mapped_column, relationship
from sqlalchemy.types import Uuid
from .database import Base

class User(Base):
    __tablename__ = 'users'
    id: Mapped[uuid.UUID] = mapped_column(Uuid, primary_key=True, default=uuid.uuid4)
    username: Mapped[str] = mapped_column(String(50), unique=True, nullable=False)
    password_hash: Mapped[str] = mapped_column(String, nullable=False)
    crypto_balance: Mapped[Decimal] = mapped_column(Numeric(20, 8), default=Decimal('0'), nullable=False)
    active_rating_card_id: Mapped[uuid.UUID | None] = mapped_column(Uuid, ForeignKey('cards.id', ondelete='SET NULL'), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=lambda: datetime.now(timezone.utc), nullable=False)
    cards: Mapped[list['Card']] = relationship('Card', back_populates='user', foreign_keys='Card.user_id', cascade='all, delete-orphan')
    active_rating_card: Mapped['Card | None'] = relationship('Card', foreign_keys=[active_rating_card_id], post_update=True)

class Card(Base):
    __tablename__ = 'cards'
    id: Mapped[uuid.UUID] = mapped_column(Uuid, primary_key=True, default=uuid.uuid4)
    user_id: Mapped[uuid.UUID] = mapped_column(Uuid, ForeignKey('users.id', ondelete='CASCADE'), nullable=False)
    card_number: Mapped[str] = mapped_column(String(16), unique=True, nullable=False)
    card_holder: Mapped[str] = mapped_column(String(100), nullable=False)
    balance: Mapped[Decimal] = mapped_column(Numeric(20, 8), default=Decimal('0'), nullable=False)
    exp_date: Mapped[str] = mapped_column(String(5), nullable=False)
    cvv: Mapped[str] = mapped_column(String(3), nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=lambda: datetime.now(timezone.utc), nullable=False)
    user: Mapped[User] = relationship('User', back_populates='cards', foreign_keys=[user_id])

class Transaction(Base):
    __tablename__ = 'transactions'
    id: Mapped[uuid.UUID] = mapped_column(Uuid, primary_key=True, default=uuid.uuid4)
    sender_card_id: Mapped[uuid.UUID | None] = mapped_column(Uuid, ForeignKey('cards.id', ondelete='SET NULL'), nullable=True)
    receiver_card_id: Mapped[uuid.UUID | None] = mapped_column(Uuid, ForeignKey('cards.id', ondelete='SET NULL'), nullable=True)
    amount: Mapped[Decimal] = mapped_column(Numeric(20, 8), nullable=False)
    type: Mapped[str] = mapped_column(String(32), nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=lambda: datetime.now(timezone.utc), nullable=False)
