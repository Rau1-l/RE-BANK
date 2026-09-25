PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    username VARCHAR(50) NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    crypto_balance NUMERIC(20,8) NOT NULL DEFAULT 0,
    active_rating_card_id TEXT NULL,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (active_rating_card_id) REFERENCES cards(id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS cards (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    card_number VARCHAR(16) NOT NULL UNIQUE,
    card_holder VARCHAR(100) NOT NULL,
    balance NUMERIC(20,8) NOT NULL DEFAULT 0 CHECK (balance >= 0),
    exp_date VARCHAR(5) NOT NULL,
    cvv VARCHAR(3) NOT NULL,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
    CHECK (length(card_number) = 16),
    CHECK (length(exp_date) = 5),
    CHECK (length(cvv) = 3)
);

CREATE TABLE IF NOT EXISTS transactions (
    id TEXT PRIMARY KEY,
    sender_card_id TEXT NULL,
    receiver_card_id TEXT NULL,
    amount NUMERIC(20,8) NOT NULL CHECK (amount > 0),
    type VARCHAR(32) NOT NULL CHECK (type IN ('click','transfer','crypto_exchange','roulette_spin','roulette_win')),
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (sender_card_id) REFERENCES cards(id) ON DELETE SET NULL,
    FOREIGN KEY (receiver_card_id) REFERENCES cards(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_cards_user_id ON cards(user_id);
CREATE INDEX IF NOT EXISTS idx_cards_number ON cards(card_number);
CREATE INDEX IF NOT EXISTS idx_cards_created_at ON cards(user_id, created_at);
CREATE INDEX IF NOT EXISTS idx_transactions_sender ON transactions(sender_card_id, created_at);
CREATE INDEX IF NOT EXISTS idx_transactions_receiver ON transactions(receiver_card_id, created_at);
CREATE INDEX IF NOT EXISTS idx_transactions_created_at ON transactions(created_at);
CREATE INDEX IF NOT EXISTS idx_users_rating_card ON users(active_rating_card_id);
