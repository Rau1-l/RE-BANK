# RE Банк — Full-stack игровой neo-banking проект

В проекте три независимых backend-варианта и один адаптивный фронтенд.

```text
re-bank/
├── backend-node/        Node.js + Express + pg Pool + PostgreSQL
├── backend-python/      Python + FastAPI + SQLAlchemy + SQLite
├── frontend/            HTML + Tailwind CDN + CSS + vanilla JS + Chart.js
├── supabase/            Supabase SQL/RLS + Edge Functions + serverless JS adapter
├── docker-compose.yml   локальный Node/PostgreSQL/frontend стек
└── README.md
```

## Вариант А: Node.js + Express + PostgreSQL

Требуется Node.js 22+ и PostgreSQL 15+.

1. Создайте базу `re_bank`.
2. Скопируйте `backend-node/.env.example` в `backend-node/.env` и задайте `DATABASE_URL`, `JWT_SECRET`, `CORS_ORIGIN`.
3. Выполните:

```bash
cd backend-node
npm install
npm run db:init
npm start
```

API: `http://localhost:3000`.

## Вариант Б: FastAPI + SQLAlchemy + SQLite

```bash
cd backend-python
python -m venv .venv
.venv\Scripts\activate
pip install -r requirements.txt
```

Скопируйте `.env.example` в `.env`, задайте `JWT_SECRET`, затем:

```bash
uvicorn app.main:app --reload --port 8000
```

API: `http://localhost:8000`.

## Frontend

Архив уже настроен на Supabase-проект из `frontend/config.js`:

```js
window.RE_BANK_CONFIG = {
  mode: 'supabase',
  apiUrl: '',
  supabaseUrl: 'https://dflqgngwxpmdvxfusgnd.supabase.co',
  supabaseAnonKey: 'sb_publishable_7ceSp3Z1gPpbThqkiuVBgA_Oir5--CZ'
};
```

Для REST-режима замените конфигурацию на:

```js
window.RE_BANK_CONFIG = {
  mode: 'rest',
  apiUrl: 'http://localhost:3000/api',
  supabaseUrl: '',
  supabaseAnonKey: ''
};
```

Затем откройте `frontend/index.html` через локальный static server. Для простого варианта:

```bash
cd frontend
python -m http.server 8080
```

Для FastAPI поменяйте `apiUrl` на `http://localhost:8000/api`.

## Docker

Для Node/PostgreSQL/frontend:

```bash
docker compose up --build
```

После запуска:
- Frontend: `http://localhost:8080`
- Node API: `http://localhost:3000`
- PostgreSQL: `localhost:5432`

## API

Public:

```text
POST /api/auth/register
POST /api/auth/login
GET  /health
```

Protected with `Authorization: Bearer <JWT>`:

```text
GET  /api/cards
POST /api/cards/create
GET  /api/dashboard/stats
POST /api/click
POST /api/transfers
GET  /api/crypto/rate
POST /api/crypto/earn
POST /api/crypto/sell
POST /api/user/select-rating-card
GET  /api/rating
POST /api/roulette/spin
```

## Денежная модель

Баланс карт и сумма транзакций хранятся в `NUMERIC`, а не в JavaScript float. Передаваемые деньги валидируются как положительные суммы до 2 знаков, крипта — до 8 знаков.

## Курс BTC

Курс рассчитывается детерминированно по серверному временному слоту длительностью 10 секунд в диапазоне $40,000–$60,000. Поэтому при одинаковом серверном времени значение одинаковое для всех пользователей.

## Ограничения

Кликер: 5 запросов в секунду на комбинацию IP + user token. Пассивная крипта: 1 выдача в минуту. Карты: максимум 5 на пользователя.

Для нескольких Node/FastAPI инстансов in-memory rate-limit и cooldown лучше вынести в Redis или Postgres. В Supabase-версии эти два ограничения уже вынесены в отдельные таблицы, поэтому они не зависят от памяти конкретного Edge Function instance.

## Supabase быстрый запуск

1. Выполните `supabase/schema.sql` в SQL Editor.
2. Установите Supabase CLI и из корня проекта выполните `supabase functions deploy register` и `supabase functions deploy api`.
3. Перед деплоем задайте `SUPABASE_SERVICE_ROLE_KEY` через `supabase secrets set`.
4. Запустите frontend через static server:

```bash
cd frontend
python -m http.server 8080
```

## Важно

Это игровая симуляция, не настоящий банковский процессинг. Для реального финансового продукта нельзя использовать эту модель как готовую платёжную систему, а CVV не следует хранить или постоянно возвращать клиенту.
