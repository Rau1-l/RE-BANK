CREATE EXTENSION IF NOT EXISTS pgcrypto;

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'transaction_type') THEN
        CREATE TYPE transaction_type AS ENUM (
            'click',
            'transfer',
            'crypto_exchange',
            'roulette_spin',
            'roulette_win'
        );
    END IF;
END $$;

CREATE TABLE IF NOT EXISTS users (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    username VARCHAR(50) NOT NULL UNIQUE,
    email VARCHAR(320) NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    crypto_balance NUMERIC(20,8) NOT NULL DEFAULT 0,
    active_rating_card_id UUID NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS cards (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    card_number VARCHAR(16) NOT NULL UNIQUE,
    card_holder VARCHAR(100) NOT NULL,
    balance NUMERIC(20,8) NOT NULL DEFAULT 0,
    exp_date VARCHAR(5) NOT NULL,
    cvv VARCHAR(3) NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT cards_number_format CHECK (card_number ~ '^[0-9]{16}$'),
    CONSTRAINT cards_exp_format CHECK (exp_date ~ '^(0[1-9]|1[0-2])/[0-9]{2}$'),
    CONSTRAINT cards_cvv_format CHECK (cvv ~ '^[0-9]{3}$'),
    CONSTRAINT cards_balance_nonnegative CHECK (balance >= 0)
);

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'users_active_rating_card_fk'
    ) THEN
        ALTER TABLE users
            ADD CONSTRAINT users_active_rating_card_fk
            FOREIGN KEY (active_rating_card_id)
            REFERENCES cards(id)
            ON DELETE SET NULL;
    END IF;
END $$;

CREATE TABLE IF NOT EXISTS transactions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    sender_card_id UUID NULL REFERENCES cards(id) ON DELETE SET NULL,
    receiver_card_id UUID NULL REFERENCES cards(id) ON DELETE SET NULL,
    amount NUMERIC(20,8) NOT NULL CHECK (amount > 0),
    type transaction_type NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_cards_user_id ON cards(user_id);
CREATE INDEX IF NOT EXISTS idx_cards_number ON cards(card_number);
CREATE INDEX IF NOT EXISTS idx_cards_created_at ON cards(user_id, created_at);
CREATE INDEX IF NOT EXISTS idx_transactions_sender ON transactions(sender_card_id, created_at);
CREATE INDEX IF NOT EXISTS idx_transactions_receiver ON transactions(receiver_card_id, created_at);
CREATE INDEX IF NOT EXISTS idx_transactions_created_at ON transactions(created_at);
CREATE INDEX IF NOT EXISTS idx_users_rating_card ON users(active_rating_card_id);
