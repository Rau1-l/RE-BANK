import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS'
};

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
}

function validUsername(value: unknown) {
  return typeof value === 'string' && /^[\p{L}\p{N}_.-]{3,50}$/u.test(value.trim());
}

function validPassword(value: unknown) {
  return typeof value === 'string' && value.length >= 8 && value.length <= 72;
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
  const source = `${bytes[0]}${bytes[1]}${bytes[2]}`.replace(/\D/g, '');
  const tail = source.slice(0, 9).padEnd(9, '0');
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

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405);
  const admin = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);
  try {
    const body = await req.json();
    const username = String(body.username ?? '').trim();
    const password = body.password;
    if (!validUsername(username)) return json({ error: 'Username must be 3-50 characters and use letters, numbers, _, -, or .' }, 400);
    if (!validPassword(password)) return json({ error: 'Password must be 8-72 characters' }, 400);
    const email = `${username.toLowerCase()}@rebank.local`;

    const existingProfile = await admin.from('users').select('id').eq('username', username).maybeSingle();
    if (existingProfile.error) return json({ error: existingProfile.error.message }, 500);
    if (existingProfile.data) return json({ error: 'Username already exists' }, 409);

    const created = await admin.auth.admin.createUser({ email, password, email_confirm: true, user_metadata: { username } });
    if (created.error) {
      const message = created.error.message.toLowerCase().includes('database error')
        ? 'Database setup is incomplete. Re-run supabase/schema.sql, then deploy this function again.'
        : created.error.message;
      return json({ error: message }, created.error.status || 400);
    }
    const user = created.data.user;
    if (!user) return json({ error: 'User creation failed' }, 500);
    const { error: userInsertError } = await admin.from('users').upsert({ id: user.id, username, password_hash: '' }, { onConflict: 'id' });
    if (userInsertError) {
      await admin.auth.admin.deleteUser(user.id);
      return json({ error: userInsertError.message }, 500);
    }
    let card = null;
    for (let attempt = 0; attempt < 30; attempt += 1) {
      const candidate = { user_id: user.id, card_number: generateCardNumber(), card_holder: username.slice(0, 30).toUpperCase(), balance: 0, exp_date: generateExpDate(), cvv: generateCvv() };
      const inserted = await admin.from('cards').insert(candidate).select().single();
      if (!inserted.error) {
        card = inserted.data;
        break;
      }
      if (!inserted.error.message.toLowerCase().includes('duplicate')) {
        await admin.auth.admin.deleteUser(user.id);
        return json({ error: inserted.error.message }, 500);
      }
    }
    if (!card) {
      await admin.auth.admin.deleteUser(user.id);
      return json({ error: 'Unable to generate a unique card' }, 500);
    }
    return json({ success: true, user_id: user.id, username, email, first_card: card }, 201);
  } catch (error) {
    return json({ error: error instanceof Error ? error.message : 'Internal error' }, 500);
  }
});
