import os
from dotenv import load_dotenv

load_dotenv()

DATABASE_URL = os.getenv('DATABASE_URL', 'sqlite:///./re_bank.db')
JWT_SECRET = os.getenv('JWT_SECRET')
CORS_ORIGIN = os.getenv('CORS_ORIGIN', '*')
PORT = int(os.getenv('PORT', '8000'))

if not JWT_SECRET:
    raise RuntimeError('JWT_SECRET is required')
