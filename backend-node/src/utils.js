import crypto from 'node:crypto';

export function normalizeUsername(value) {
  return String(value ?? '').trim();
}

export function validateUsername(value) {
  return /^[\p{L}\p{N}_.-]{3,50}$/u.test(value);
}

export function normalizeEmail(value) {
  return String(value ?? '').trim().toLowerCase();
}

export function validateEmail(value) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/i.test(value) && value.length <= 320;
}

export function validatePassword(value) {
  return typeof value === 'string' && value.length >= 8 && value.length <= 72;
}

export function normalizeCardNumber(value) {
  return String(value ?? '').replace(/\s+/g, '');
}

export function validateCardNumber(value) {
  return /^\d{16}$/.test(value) && luhnValid(value);
}

export function luhnValid(number) {
  let sum = 0;
  let doubleDigit = false;
  for (let i = number.length - 1; i >= 0; i -= 1) {
    let digit = Number(number[i]);
    if (doubleDigit) {
      digit *= 2;
      if (digit > 9) digit -= 9;
    }
    sum += digit;
    doubleDigit = !doubleDigit;
  }
  return sum % 10 === 0;
}

function luhnChecksum(base15) {
  for (let digit = 0; digit <= 9; digit += 1) {
    const candidate = `${base15}${digit}`;
    if (luhnValid(candidate)) return digit;
  }
  throw new Error('Unable to generate Luhn checksum');
}

export function generateCardNumber() {
  const randomTail = crypto.randomInt(0, 1_000_000_000).toString().padStart(9, '0');
  const base15 = `400012${randomTail}`;
  return `${base15}${luhnChecksum(base15)}`;
}

export function generateCvv() {
  return crypto.randomInt(100, 1000).toString();
}

export function generateExpDate() {
  const now = new Date();
  now.setUTCFullYear(now.getUTCFullYear() + 5);
  return `${String(now.getUTCMonth() + 1).padStart(2, '0')}/${String(now.getUTCFullYear()).slice(-2)}`;
}

export function formatCardHolder(username) {
  return username.slice(0, 30).toUpperCase();
}

export function validUsdAmount(value) {
  return /^(?:0|[1-9]\d*)(?:\.\d{1,2})?$/.test(String(value)) && Number(value) > 0;
}

export function validCryptoAmount(value) {
  return /^(?:0|[1-9]\d*)(?:\.\d{1,8})?$/.test(String(value)) && Number(value) > 0;
}

export function cryptoUsdRate() {
  const slot = Math.floor(Date.now() / 10000);
  const hash = crypto.createHash('sha256').update(String(slot)).digest('hex');
  const value = parseInt(hash.slice(0, 8), 16) % 20001;
  return 40000 + value;
}

export function startOfUtcDay(date) {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
}

export function daysAgoUtc(days) {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - days);
  return startOfUtcDay(d);
}

export function todayUtcKey() {
  return new Date().toISOString().slice(0, 10);
}

export function errorMessage(error) {
  return error instanceof Error ? error.message : 'Unexpected error';
}
