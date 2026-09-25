import fs from 'node:fs/promises';
import { pool } from './db.js';

const sql = await fs.readFile(new URL('../db/schema.sql', import.meta.url), 'utf8');
await pool.query(sql);
await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS email VARCHAR(320);`);
await pool.query(`UPDATE users SET email = LOWER(username) || '@rebank.local' WHERE email IS NULL OR BTRIM(email) = '';`);
await pool.query(`CREATE UNIQUE INDEX IF NOT EXISTS idx_users_email ON users(email);`);
await pool.query(`ALTER TABLE users ALTER COLUMN email SET NOT NULL;`);
await pool.end();
console.log('Database schema initialized');
