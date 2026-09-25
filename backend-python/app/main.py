from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from .config import CORS_ORIGIN
from .database import Base, engine
from .routes import auth, cards, dashboard, click, transfers, crypto, rating, roulette

Base.metadata.create_all(bind=engine)

app = FastAPI(title='RE Bank API', version='1.0.0')
app.add_middleware(
    CORSMiddleware,
    allow_origins=['*'] if CORS_ORIGIN == '*' else [CORS_ORIGIN],
    allow_credentials=CORS_ORIGIN != '*',
    allow_methods=['*'],
    allow_headers=['*'],
)
app.include_router(auth.router)
app.include_router(cards.router)
app.include_router(dashboard.router)
app.include_router(click.router)
app.include_router(transfers.router)
app.include_router(crypto.router)
app.include_router(rating.router)
app.include_router(roulette.router)

@app.get('/health')
def health():
    return {'ok': True, 'service': 'RE Bank API'}
