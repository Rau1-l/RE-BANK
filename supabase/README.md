# RE Банк на Supabase

Этот вариант использует Supabase Auth для логина и JWT, Postgres для данных и атомарные SQL-функции для денежных операций.

## 1. Создание проекта

Создайте проект в Supabase и откройте SQL Editor. Целиком выполните `schema.sql`.

## 2. Ключи фронтенда

В `frontend/config.js` установите:

```js
window.RE_BANK_CONFIG = {
  mode: 'supabase',
  apiUrl: '',
  supabaseUrl: 'https://dflqgngwxpmdvxfusgnd.supabase.co',
  supabaseAnonKey: 'sb_publishable_7ceSp3Z1gPpbThqkiuVBgA_Oir5--CZ'
};
```

Не помещайте `SUPABASE_SERVICE_ROLE_KEY` во фронтенд. Он используется только внутри Edge Functions.

## 3. Edge Functions

Функции уже лежат в стандартной для Supabase CLI папке:

```text
supabase/functions/register/index.ts
supabase/functions/api/index.ts
```

После этого разверните `register` и `api` через Supabase CLI:

```bash
supabase functions deploy register
supabase functions deploy api
```

Задайте секрет сервисного ключа перед деплоем:

```bash
supabase secrets set SUPABASE_SERVICE_ROLE_KEY=YOUR_SERVICE_ROLE_KEY
```

Для этих функций отключена автоматическая JWT-проверка CLI: `register` должен быть доступен
до входа пользователя, а `api` проверяет Bearer-токен внутри функции.

## 4. Как работает регистрация

UI принимает только username/password. Edge Function `register` превращает username в технический адрес вида `username@rebank.local`, создаёт Supabase Auth user с `email_confirm: true`, записывает профиль в `public.users` и выпускает первую карту. Реальный пароль хранит Supabase Auth; `public.users.password_hash` оставлен пустым как совместимое поле исходной архитектуры.

## 5. RLS

Клиент имеет доступ на чтение только своих `users` и `cards`, а транзакции доступны только если одна из связанных карт принадлежит текущему `auth.uid()`. Прямые INSERT/UPDATE/DELETE для `anon` и `authenticated` закрыты. Денежные операции проходят через `api` Edge Function с service-role клиентом и PostgreSQL functions.

## 6. Критичные операции

`re_click`, `re_transfer`, `re_crypto_earn`, `re_crypto_sell`, `re_select_rating_card`, `re_roulette` выполняют проверки и изменения в одной БД-транзакции. Для кликера и крипто-дохода есть вспомогательные таблицы, чтобы ограничения работали не только в памяти Edge Function.

## 7. Курс BTC

Курс детерминированно меняется каждые 10 секунд в диапазоне $40,000–$60,000. Одинаковый временной слот даёт одинаковое значение для всех клиентов.

## 8. Рулетка

Edge Function генерирует слот 1–100 через Web Crypto, затем передаёт его атомарной PostgreSQL-функции. Победный слот — 77, выигрыш — $100,000.
