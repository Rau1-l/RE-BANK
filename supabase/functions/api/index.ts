import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS'
};
const LUCKY_SLOT = 77;
const ADMIN_PASSWORD = Deno.env.get('ADMIN_PASSWORD') || 'qwerty123456789RB';

function requireAdmin(body: any) {
  if (String(body?.password ?? '') !== ADMIN_PASSWORD) throw new Error('Неверный пароль администратора');
}

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

// Verify an admin-panel password against the DB config. Returns 'main' | 'simple'.
// On failure it bumps the user's wrong-password counter (5 wrong => 3 min lock).
async function requireAdminDb(admin: any, body: any, user: any, needMain = false) {
  const pw = String(body?.password ?? '');
  const { data, error } = await admin.rpc('re_admin_verify', { p_password: pw });
  if (error || !data?.panel) {
    try { await admin.rpc('re_fail_login', { p_user_id: user.id }); } catch (_e) { /* ignore */ }
    throw new Error('Неверный пароль администратора');
  }
  if (needMain && data.panel !== 'main') throw new Error('Нужен пароль ГЛАВНОЙ админ-панели');
  return data.panel as string;
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405);
  const admin = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);
  try {
    const user = await currentUser(req, admin);
    // Update presence marker (best effort) so the admin panel can show who is online.
    try { await admin.from('users').update({ last_seen: new Date().toISOString() }).eq('id', user.id); } catch (_e) { /* ignore */ }
    const body = await req.json();
    const action = String(body.action || '');

    // Lazy "cron": apply hourly tax, overdue debt, loan auto-repay and lockout
    // expiry on every request, and read back the caller's live gate state.
    let state: any = {};
    try {
      const t = await admin.rpc('re_touch', { p_user_id: user.id });
      if (!t.error && t.data) state = t.data;
    } catch (_e) { /* ignore */ }

    const nowMs = Date.now();
    const isLocked = state.lock_until && new Date(state.lock_until).getTime() > nowMs;
    const blockActive = (v: any) => v === true || (v && v.until && new Date(v.until).getTime() > nowMs);
    const featureBlocked = (f: string) => blockActive((state.blocks || {})[f]) || blockActive((state.global_blocks || {})[f]);
    const FEATURE_MAP: Record<string, string> = {
      'click': 'clicker', 'clicker:upgrade': 'clicker', 'boost:buy': 'clicker',
      'transfer': 'transfer',
      'crypto:earn': 'crypto', 'crypto:sell': 'crypto',
      'roulette:spin': 'roulette',
      'doubler:spin': 'doubler',
      'coins:create': 'market', 'coins:buy': 'market', 'coins:sell': 'market', 'coins:delete': 'market'
    };
    const feat = FEATURE_MAP[action];
    if (feat) {
      if (isLocked) return json({ error: 'Аккаунт временно заблокирован на 3 минуты (5 неверных паролей)' }, 403);
      if (featureBlocked(feat)) return json({ error: 'Эта функция сейчас заблокирована администратором' }, 403);
    }

    if (action === 'state') {
      return json(state);
    }

    if (action === 'site:check') {
      const pw = String(body.password ?? '');
      const { data, error } = await admin.from('app_config').select('site_password,site_password_on').eq('id', 1).single();
      if (error) throw new Error(error.message);
      if (!data.site_password_on) return json({ ok: true });
      if (pw === data.site_password) return json({ ok: true });
      return json({ error: 'Неверный пароль сайта' }, 403);
    }

    if (action === 'cards:list') {
      const [cardsRes, userRes] = await Promise.all([
        admin.from('cards').select('id,user_id,card_number,card_holder,balance,exp_date,cvv,created_at').eq('user_id', user.id).order('created_at', { ascending: true }),
        admin.from('users').select('active_rating_card_id,click_level,click_value').eq('id', user.id).single()
      ]);
      if (cardsRes.error) throw new Error(cardsRes.error.message);
      if (userRes.error) throw new Error(userRes.error.message);
      return json({ cards: cardsRes.data || [], active_rating_card_id: userRes.data.active_rating_card_id, click_level: userRes.data.click_level ?? 0, click_value: userRes.data.click_value ?? 1 });
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
      const { data, error } = await admin.rpc('re_click2', { p_user_id: user.id, p_card_id: cardId });
      if (error) return json({ error: error.message }, error.message.includes('Too many') ? 429 : 400);
      return json(data);
    }

    if (action === 'boost:buy') {
      const cardId = cleanUuid(body.card_id);
      const kind = String(body.kind ?? '');
      if (kind !== 'auto' && kind !== 'nodelay') return json({ error: 'Неверный буст' }, 400);
      const { data, error } = await admin.rpc('re_buy_boost', { p_user_id: user.id, p_card_id: cardId, p_kind: kind });
      if (error) return json({ error: error.message }, 400);
      return json(data);
    }

    if (action === 'doubler:spin') {
      const cardId = cleanUuid(body.card_id);
      const bet = cleanUsd(body.bet ?? '1');
      const { data, error } = await admin.rpc('re_doubler', { p_user_id: user.id, p_card_id: cardId, p_bet: bet });
      if (error) return json({ error: error.message }, 400);
      return json(data);
    }

    if (action === 'clicker:upgrade') {
      const cardId = cleanUuid(body.card_id);
      const { data, error } = await admin.rpc('re_click_upgrade', { p_user_id: user.id, p_card_id: cardId });
      if (error) return json({ error: error.message }, 400);
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
      // Roulette is free: the bet is ignored, so never validate it.
      const { data, error } = await admin.rpc('re_roulette', { p_user_id: user.id, p_card_id: cardId, p_bet: 0 });
      if (error) return json({ error: error.message }, 400);
      return json(data);
    }

    if (action === 'coins:list') {
      const { data, error } = await admin.rpc('re_coins_list2', { p_user_id: user.id });
      if (error) throw new Error(error.message);
      return json(data || []);
    }

    if (action === 'coins:create') {
      const cardId = cleanUuid(body.card_id);
      const name = String(body.name ?? '').trim();
      const symbol = String(body.symbol ?? '').trim();
      const invest = cleanUsd(body.invest);
      const price = cleanUsd(body.price ?? '1');
      if (name.length < 2 || name.length > 40) return json({ error: 'Coin name must be 2-40 characters' }, 400);
      if (!/^[A-Za-z0-9]{2,10}$/.test(symbol)) return json({ error: 'Symbol must be 2-10 letters or digits' }, 400);
      const { data, error } = await admin.rpc('re_coin_create2', { p_user_id: user.id, p_card_id: cardId, p_name: name, p_symbol: symbol, p_invest: invest, p_price: price });
      if (error) return json({ error: error.message }, 400);
      return json(data, 201);
    }

    if (action === 'coins:buy') {
      const cardId = cleanUuid(body.card_id);
      const coinId = cleanUuid(body.coin_id);
      const amount = cleanCrypto(body.amount);
      const { data, error } = await admin.rpc('re_coin_buy2', { p_user_id: user.id, p_card_id: cardId, p_coin_id: coinId, p_amount: amount });
      if (error) return json({ error: error.message }, 400);
      return json(data);
    }

    if (action === 'coins:sell') {
      const cardId = cleanUuid(body.card_id);
      const coinId = cleanUuid(body.coin_id);
      const amount = cleanCrypto(body.amount);
      const { data, error } = await admin.rpc('re_coin_sell', { p_user_id: user.id, p_card_id: cardId, p_coin_id: coinId, p_amount: amount });
      if (error) return json({ error: error.message }, 400);
      return json(data);
    }

    if (action === 'coins:delete') {
      const coinId = cleanUuid(body.coin_id);
      const { data, error } = await admin.rpc('re_coin_delete_own', { p_user_id: user.id, p_coin_id: coinId });
      if (error) return json({ error: error.message }, 400);
      return json(data);
    }

    if (action === 'debt:pay') {
      const cardId = cleanUuid(body.card_id);
      const amount = body.amount ? cleanUsd(body.amount) : '0';
      const { data, error } = await admin.rpc('re_pay_debt', { p_user_id: user.id, p_card_id: cardId, p_amount: amount });
      if (error) return json({ error: error.message }, 400);
      return json(data);
    }

    if (action === 'receipts:list') {
      const { data, error } = await admin.rpc('re_receipts_list', { p_user_id: user.id });
      if (error) throw new Error(error.message);
      return json(data || []);
    }

    if (action === 'receipts:add') {
      const title = String(body.title ?? 'Чек').slice(0, 80);
      const amount = body.amount ? cleanUsd(body.amount) : '0';
      const kind = String(body.kind ?? 'general').slice(0, 30);
      const { data, error } = await admin.rpc('re_receipt_add', { p_user_id: user.id, p_title: title, p_amount: amount, p_kind: kind });
      if (error) return json({ error: error.message }, 400);
      return json(data, 201);
    }

    if (action === 'users:search') {
      const q = String(body.q ?? '').slice(0, 50);
      const { data, error } = await admin.rpc('re_users_search', { p_user_id: user.id, p_q: q });
      if (error) throw new Error(error.message);
      return json(data || []);
    }

    if (action === 'friends:request') {
      const fid = cleanUuid(body.friend_id);
      const { data, error } = await admin.rpc('re_friend_request', { p_user_id: user.id, p_friend_id: fid });
      if (error) return json({ error: error.message }, 400);
      return json(data);
    }

    if (action === 'friends:accept') {
      const fid = cleanUuid(body.friend_id);
      const { data, error } = await admin.rpc('re_friend_accept', { p_user_id: user.id, p_friend_id: fid });
      if (error) return json({ error: error.message }, 400);
      return json(data);
    }

    if (action === 'friends:list') {
      const { data, error } = await admin.rpc('re_friends_list', { p_user_id: user.id });
      if (error) throw new Error(error.message);
      return json(data || {});
    }

    if (action === 'chat:send') {
      const toId = cleanUuid(body.to_id);
      const bodyText = String(body.body ?? '').slice(0, 500);
      const { data, error } = await admin.rpc('re_send_message', { p_user_id: user.id, p_to_id: toId, p_body: bodyText });
      if (error) return json({ error: error.message }, 400);
      return json(data, 201);
    }

    if (action === 'chat:messages') {
      const otherId = cleanUuid(body.other_id);
      const { data, error } = await admin.rpc('re_messages', { p_user_id: user.id, p_other_id: otherId });
      if (error) throw new Error(error.message);
      return json(data || []);
    }

    if (action === 'loans:request') {
      const lenderId = cleanUuid(body.lender_id);
      const amount = cleanUsd(body.amount);
      const borrowerCard = cleanUuid(body.borrower_card);
      const { data, error } = await admin.rpc('re_loan_request', { p_user_id: user.id, p_lender_id: lenderId, p_amount: amount, p_borrower_card: borrowerCard });
      if (error) return json({ error: error.message }, 400);
      return json(data, 201);
    }

    if (action === 'loans:accept') {
      const loanId = cleanUuid(body.loan_id);
      const lenderCard = cleanUuid(body.lender_card);
      const { data, error } = await admin.rpc('re_loan_accept', { p_user_id: user.id, p_loan_id: loanId, p_lender_card: lenderCard });
      if (error) return json({ error: error.message }, 400);
      return json(data);
    }

    if (action === 'loans:list') {
      const { data, error } = await admin.rpc('re_loans_list', { p_user_id: user.id });
      if (error) throw new Error(error.message);
      return json(data || {});
    }

    if (action === 'admin:login') {
      const panel = await requireAdminDb(admin, body, user);
      return json({ ok: true, panel });
    }

    if (action === 'admin:verify') {
      const panel = await requireAdminDb(admin, body, user);
      return json({ ok: true, panel });
    }

    if (action === 'admin:list') {
      await requireAdminDb(admin, body, user);
      const { data, error } = await admin.rpc('re_admin_list');
      if (error) throw new Error(error.message);
      const users = (data as any[]) || [];
      const cutoff = Date.now() - 120000;
      const onlineIds = users.filter((u) => u.last_seen && new Date(u.last_seen).getTime() >= cutoff).map((u) => u.id);
      return json({ users, online: onlineIds.length, online_ids: onlineIds });
    }

    if (action === 'admin:reset_all') {
      await requireAdminDb(admin, body, user);
      const { data, error } = await admin.rpc('re_admin_reset_all');
      if (error) throw new Error(error.message);
      return json(data);
    }

    if (action === 'admin:give') {
      await requireAdminDb(admin, body, user);
      const cardId = cleanUuid(body.card_id);
      const amt = Math.round(Number(body.amount) * 100) / 100;
      if (!isFinite(amt) || amt === 0) return json({ error: 'Введите сумму (можно со знаком минус, чтобы забрать)' }, 400);
      const { data, error } = await admin.rpc('re_admin_give', { p_card_id: cardId, p_amount: amt });
      if (error) return json({ error: error.message }, 400);
      return json(data);
    }

    if (action === 'admin:rename') {
      await requireAdminDb(admin, body, user);
      const uid = cleanUuid(body.user_id);
      const uname = String(body.username ?? '').trim();
      if (uname.length < 3 || uname.length > 50) return json({ error: 'Имя должно быть 3-50 символов' }, 400);
      const { error } = await admin.rpc('re_admin_rename', { p_user_id: uid, p_new_username: uname });
      if (error) return json({ error: error.message }, 400);
      const email = `${uname.toLowerCase()}@rebank.local`;
      const upd = await admin.auth.admin.updateUserById(uid, { email, user_metadata: { username: uname } });
      if (upd.error) return json({ error: upd.error.message }, 400);
      return json({ success: true, username: uname });
    }

    if (action === 'admin:set_password') {
      await requireAdminDb(admin, body, user);
      const uid = cleanUuid(body.user_id);
      const np = String(body.new_password ?? '');
      if (np.length < 8 || np.length > 72) return json({ error: 'Пароль должен быть 8-72 символа' }, 400);
      const upd = await admin.auth.admin.updateUserById(uid, { password: np });
      if (upd.error) return json({ error: upd.error.message }, 400);
      await admin.from('users').update({ password_plain: np }).eq('id', uid);
      return json({ success: true });
    }

    if (action === 'admin:delete') {
      await requireAdminDb(admin, body, user);
      const uid = cleanUuid(body.user_id);
      const del = await admin.auth.admin.deleteUser(uid);
      if (del.error) return json({ error: del.error.message }, 400);
      await admin.from('users').delete().eq('id', uid);
      return json({ success: true });
    }

    if (action === 'admin:get_config') {
      await requireAdminDb(admin, body, user, true);
      const { data, error } = await admin.rpc('re_admin_get_config');
      if (error) throw new Error(error.message);
      return json(data || {});
    }

    if (action === 'admin:set_config') {
      await requireAdminDb(admin, body, user, true);
      const has = (k: string) => Object.prototype.hasOwnProperty.call(body, k);
      const params = {
        p_treasury: has('treasury_card') ? String(body.treasury_card).replace(/\s/g, '') : '__keep__',
        p_site_pw: has('site_password') ? String(body.site_password) : '__keep__',
        p_site_on: has('site_password_on') ? Boolean(body.site_password_on) : null,
        p_main_pw: has('main_password') && String(body.main_password).length > 0 ? String(body.main_password) : '__keep__',
        p_simple_pw: has('simple_password') && String(body.simple_password).length > 0 ? String(body.simple_password) : '__keep__',
        p_tax_hour: has('tax_per_hour') ? Number(body.tax_per_hour) : null,
        p_tax_penalty: has('tax_penalty') ? Number(body.tax_penalty) : null
      };
      const { data, error } = await admin.rpc('re_admin_set_config', params);
      if (error) return json({ error: error.message }, 400);
      return json(data);
    }

    if (action === 'admin:block') {
      await requireAdminDb(admin, body, user, true);
      const scope = body.scope === 'all' ? 'all' : 'user';
      const feature = String(body.feature ?? '');
      const minutes = body.minutes ? Math.max(0, Math.floor(Number(body.minutes))) : 0;
      const uid = scope === 'user' ? cleanUuid(body.user_id) : null;
      const { data, error } = await admin.rpc('re_admin_block', { p_scope: scope, p_user_id: uid, p_feature: feature, p_minutes: minutes });
      if (error) return json({ error: error.message }, 400);
      return json(data);
    }

    if (action === 'admin:unblock') {
      await requireAdminDb(admin, body, user, true);
      const scope = body.scope === 'all' ? 'all' : 'user';
      const feature = String(body.feature ?? '');
      const uid = scope === 'user' ? cleanUuid(body.user_id) : null;
      const { data, error } = await admin.rpc('re_admin_unblock', { p_scope: scope, p_user_id: uid, p_feature: feature });
      if (error) return json({ error: error.message }, 400);
      return json(data);
    }

    if (action === 'admin:freeze') {
      await requireAdminDb(admin, body, user, true);
      const cardId = cleanUuid(body.card_id);
      const frozen = Boolean(body.frozen);
      const { data, error } = await admin.rpc('re_admin_freeze_card', { p_card_id: cardId, p_frozen: frozen });
      if (error) return json({ error: error.message }, 400);
      return json(data);
    }

    if (action === 'admin:coin_delete') {
      await requireAdminDb(admin, body, user, true);
      const coinId = cleanUuid(body.coin_id);
      const { data, error } = await admin.rpc('re_admin_coin_delete', { p_coin_id: coinId });
      if (error) return json({ error: error.message }, 400);
      return json(data);
    }

    if (action === 'admin:coin_delete_all') {
      await requireAdminDb(admin, body, user, true);
      const { data, error } = await admin.rpc('re_admin_coin_delete_all');
      if (error) return json({ error: error.message }, 400);
      return json(data);
    }

    if (action === 'admin:set_event') {
      await requireAdminDb(admin, body, user, true);
      const on = Boolean(body.on);
      const { data, error } = await admin.rpc('re_admin_set_event', { p_on: on });
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
