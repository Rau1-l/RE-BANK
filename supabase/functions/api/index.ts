import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS'
};
const LUCKY_SLOT = 77;

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
}

function randomInt(min: number, maxInclusive: number) {
  const range = maxInclusive - min + 1;
  const limit = Math.floor(0xffffffff / range) * range;
  const bytes = new Uint32Array(1);
  let value = 0;
  do {
    crypto.getRandomValues(bytes);
    value = bytes[0];
  } while (value >= limit);
  return min + (value % range);
}

function luhnValid(number: string) {
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

function generateCardNumber() {
  const bytes = new Uint32Array(3);
  crypto.getRandomValues(bytes);
  const tail = `${bytes[0]}${bytes[1]}${bytes[2]}`.replace(/\D/g, '').slice(0, 9).padEnd(9, '0');
  const base = `400012${tail}`;
  for (let digit = 0; digit <= 9; digit += 1) {
    const candidate = `${base}${digit}`;
    if (luhnValid(candidate)) return candidate;
  }
  throw new Error('Card number generation failed');
}

function generateCvv() {
  const bytes = new Uint32Array(1);
  crypto.getRandomValues(bytes);
  return String(100 + (bytes[0] % 900)).padStart(3, '0');
}

function generateExpDate() {
  const date = new Date();
  date.setUTCFullYear(date.getUTCFullYear() + 5);
  return `${String(date.getUTCMonth() + 1).padStart(2, '0')}/${String(date.getUTCFullYear()).slice(-2)}`;
}

function cryptoUsdRate() {
  const slot = Math.floor(Date.now() / 10000);
  const text = new TextEncoder().encode(String(slot));
  const promise = crypto.subtle.digest('SHA-256', text);
  return promise.then((buffer) => {
    const view = new DataView(buffer);
    return 40000 + (view.getUint32(0) % 20001);
  });
}

async function currentUser(req: Request, admin: ReturnType<typeof createClient>) {
  const header = req.headers.get('Authorization') || '';
  const match = header.match(/^Bearer\s+(.+)$/i);
  if (!match) throw new Error('Authorization Bearer token is required');
  const auth = await admin.auth.getUser(match[1]);
  if (auth.error || !auth.data.user) throw new Error('Invalid or expired token');
  return auth.data.user;
}

function cleanUuid(value: unknown) {
  const s = String(value ?? '');
  if (!/^[0-9a-fA-F-]{36}$/.test(s)) throw new Error('Valid UUID is required');
  return s;
}

function cleanUsd(value: unknown) {
  const s = String(value ?? '');
  if (!/^(?:0|[1-9]\d*)(?:\.\d{1,2})?$/.test(s) || Number(s) <= 0) throw new Error('Amount must be a positive number with up to 2 decimals');
  return s;
}

function cleanCrypto(value: unknown) {
  const s = String(value ?? '');
  if (!/^(?:0|[1-9]\d*)(?:\.\d{1,8})?$/.test(s) || Number(s) <= 0) throw new Error('Crypto amount must be positive with up to 8 decimals');
  return s;
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405);
  const admin = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);
  try {
    const user = await currentUser(req, admin);
    const body = await req.json();
    const action = String(body.action || '');

    if (action === 'cards:list') {
      const [cardsRes, userRes] = await Promise.all([
        admin.from('cards').select('id,user_id,card_number,card_holder,balance,exp_date,cvv,created_at').eq('user_id', user.id).order('created_at', { ascending: true }),
        admin.from('users').select('active_rating_card_id').eq('id', user.id).single()
      ]);
      if (cardsRes.error) throw new Error(cardsRes.error.message);
      if (userRes.error) throw new Error(userRes.error.message);
      return json({ cards: cardsRes.data || [], active_rating_card_id: userRes.data.active_rating_card_id });
    }

    if (action === 'cards:create') {
      const holder = String(user.user_metadata?.username || user.email?.split('@')[0] || 'RE BANK').slice(0, 30).toUpperCase();
      for (let attempt = 0; attempt < 30; attempt += 1) {
        const { data, error } = await admin.rpc('re_create_card', { p_user_id: user.id, p_card_number: generateCardNumber(), p_card_holder: holder, p_exp_date: generateExpDate(), p_cvv: generateCvv() });
        if (!error) return json(data, 201);
        if (!error.message.toLowerCase().includes('duplicate')) return json({ error: error.message }, error.message.includes('Maximum') ? 400 : 500);
      }
      return json({ error: 'Unable to generate a unique card' }, 500);
    }

    if (action === 'dashboard:stats') {
      const { data, error } = await admin.rpc('re_dashboard', { p_user_id: user.id });
      if (error) throw new Error(error.message);
      return json(data);
    }

    if (action === 'click') {
      const cardId = cleanUuid(body.card_id);
      const { data, error } = await admin.rpc('re_click', { p_user_id: user.id, p_card_id: cardId });
      if (error) return json({ error: error.message }, error.message.includes('Too many') ? 429 : 400);
      return json(data);
    }

    if (action === 'transfer') {
      const senderCardId = cleanUuid(body.sender_card_id);
      const receiver = String(body.receiver_card_number ?? '').replace(/\s/g, '');
      if (!/^\d{16}$/.test(receiver)) return json({ error: 'Receiver card number must contain 16 digits' }, 400);
      const amount = cleanUsd(body.amount);
      const { data, error } = await admin.rpc('re_transfer', { p_user_id: user.id, p_sender_card_id: senderCardId, p_receiver_card_number: receiver, p_amount: amount });
      if (error) return json({ error: error.message }, error.message.includes('not found') ? 404 : 400);
      return json(data);
    }

    if (action === 'crypto:rate') {
      return json({ symbol: 'BTC/USD', rate: await cryptoUsdRate(), updated_every_seconds: 10 });
    }

    if (action === 'crypto:earn') {
      const { data, error } = await admin.rpc('re_crypto_earn', { p_user_id: user.id });
      if (error) return json({ error: error.message }, error.message.includes('once per minute') ? 429 : 400);
      return json({ ...data, rate: await cryptoUsdRate() });
    }

    if (action === 'crypto:sell') {
      const cardId = cleanUuid(body.card_id);
      const amountCrypto = cleanCrypto(body.amount_crypto);
      const rate = await cryptoUsdRate();
      const { data, error } = await admin.rpc('re_crypto_sell', { p_user_id: user.id, p_card_id: cardId, p_amount_crypto: amountCrypto, p_rate: rate });
      if (error) return json({ error: error.message }, 400);
      return json(data);
    }

    if (action === 'rating:select') {
      const cardId = cleanUuid(body.card_id);
      const { data, error } = await admin.rpc('re_select_rating_card', { p_user_id: user.id, p_card_id: cardId });
      if (error) return json({ error: error.message }, 404);
      return json(data);
    }

    if (action === 'rating:list') {
      const { data, error } = await admin.rpc('re_rating');
      if (error) throw new Error(error.message);
      return json(data || []);
    }

    if (action === 'roulette:spin') {
      const cardId = cleanUuid(body.card_id);
      const winningSlot = randomInt(1, 100);
      const { data, error } = await admin.rpc('re_roulette', { p_user_id: user.id, p_card_id: cardId, p_winning_slot: winningSlot });
      if (error) return json({ error: error.message }, 400);
      return json(data);
    }

    return json({ error: 'Unknown action' }, 404);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Internal error';
    const status = message.includes('Invalid or expired') ? 401 : 400;
    return json({ error: message }, status);
  }
});
