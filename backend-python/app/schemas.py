from pydantic import BaseModel, Field, field_validator
import re

class AuthBody(BaseModel):
    username: str = Field(min_length=3, max_length=50)
    password: str = Field(min_length=8, max_length=72)

    @field_validator('username')
    @classmethod
    def username_chars(cls, value):
        value = value.strip()
        if not re.fullmatch(r'[\w.\-]+', value, re.UNICODE):
            raise ValueError('Invalid username')
        return value

class ClickBody(BaseModel):
    card_id: str

class TransferBody(BaseModel):
    sender_card_id: str
    receiver_card_number: str
    amount: str

class CryptoSellBody(BaseModel):
    card_id: str
    amount_crypto: str

class RatingBody(BaseModel):
    card_id: str

class RouletteBody(BaseModel):
    card_id: str
