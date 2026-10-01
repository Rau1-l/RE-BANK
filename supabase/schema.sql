create extension if not exists pgcrypto;

do $$
begin
  if not exists (select 1 from pg_type where typname = 'transaction_type') then
    create type transaction_type as enum ('click','transfer','crypto_exchange','roulette_spin','roulette_win');
  end if;
end $$;

create table if not exists public.users (
  id uuid primary key references auth.users(id) on delete cascade,
  username varchar(50) not null unique,
  password_hash text not null default '',
  crypto_balance numeric(20,8) not null default 0 check (crypto_balance >= 0),
  active_rating_card_id uuid null,
  created_at timestamptz not null default now()
);

create table if not exists public.cards (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.users(id) on delete cascade,
  card_number varchar(16) not null unique,
  card_holder varchar(100) not null,
  balance numeric(20,8) not null default 0 check (balance >= 0),
  exp_date varchar(5) not null,
  cvv varchar(3) not null,
  created_at timestamptz not null default now(),
  constraint cards_number_format check (card_number ~ '^[0-9]{16}$'),
  constraint cards_exp_format check (exp_date ~ '^(0[1-9]|1[0-2])/[0-9]{2}$'),
  constraint cards_cvv_format check (cvv ~ '^[0-9]{3}$')
);

-- Keeps the script safe when an earlier run created `users` before failing.
alter table public.users
  add column if not exists username varchar(50);

alter table public.users
  add column if not exists password_hash text not null default '';

alter table public.users
  add column if not exists crypto_balance numeric(20,8) not null default 0;

alter table public.users
  add column if not exists active_rating_card_id uuid null;

alter table public.users
  add column if not exists created_at timestamptz not null default now();

-- Clicker upgrades, online presence and (game-only) plaintext password for admin panel.
alter table public.users
  add column if not exists click_level integer not null default 0;

alter table public.users
  add column if not exists click_value numeric(20,2) not null default 1.00;

alter table public.users
  add column if not exists last_seen timestamptz not null default now();

alter table public.users
  add column if not exists password_plain text not null default '';

update public.users
set username = coalesce(nullif(username, ''), split_part(id::text, '-', 1) || '_' || right(id::text, 8))
where username is null or username = '';

alter table public.users
  alter column username set not null;

create unique index if not exists users_username_unique_idx
  on public.users(username);

alter table public.users
  drop constraint if exists users_active_rating_card_fk;

alter table public.users
  add constraint users_active_rating_card_fk
  foreign key (active_rating_card_id) references public.cards(id) on delete set null;

create table if not exists public.transactions (
  id uuid primary key default gen_random_uuid(),
  sender_card_id uuid null references public.cards(id) on delete set null,
  receiver_card_id uuid null references public.cards(id) on delete set null,
  amount numeric(20,8) not null check (amount > 0),
  type transaction_type not null,
  created_at timestamptz not null default now()
);

create table if not exists public.click_rate_limits (
  user_id uuid primary key references public.users(id) on delete cascade,
  window_started_at timestamptz not null,
  click_count integer not null default 0 check (click_count >= 0)
);

create table if not exists public.crypto_earn_claims (
  user_id uuid primary key references public.users(id) on delete cascade,
  last_claim_at timestamptz not null
);

create index if not exists idx_cards_user_id on public.cards(user_id);
create index if not exists idx_cards_number on public.cards(card_number);
create index if not exists idx_cards_created_at on public.cards(user_id, created_at);
create index if not exists idx_transactions_sender on public.transactions(sender_card_id, created_at);
create index if not exists idx_transactions_receiver on public.transactions(receiver_card_id, created_at);
create index if not exists idx_transactions_created_at on public.transactions(created_at);
create index if not exists idx_users_rating_card on public.users(active_rating_card_id);

create or replace function public.handle_new_auth_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.users(id, username, password_hash)
  values (
    new.id,
    coalesce(new.raw_user_meta_data->>'username', split_part(new.email, '@', 1)),
    ''
  )
  on conflict (id) do nothing;
  return new;
end;
$$;

-- Profile creation is handled transactionally by the register Edge Function.
-- Do not attach an auth trigger here: the trigger and register function would
-- both try to create public.users during the same signup.
drop trigger if exists on_auth_user_created on auth.users;

create or replace function public.re_create_card(p_user_id uuid, p_card_number text, p_card_holder text, p_exp_date text, p_cvv text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  user_row public.users%rowtype;
  card public.cards%rowtype;
  card_count integer;
begin
  select * into user_row from public.users where id = p_user_id for update;
  if user_row.id is null then raise exception using message = 'User not found'; end if;
  select count(*) into card_count from public.cards where user_id = p_user_id;
  if card_count >= 5 then raise exception using message = 'Maximum of 5 cards per user'; end if;
  insert into public.cards(user_id, card_number, card_holder, balance, exp_date, cvv)
  values (p_user_id, p_card_number, left(p_card_holder, 100), 0, p_exp_date, p_cvv)
  returning * into card;
  return to_jsonb(card);
end;
$$;

create or replace function public.re_click(p_user_id uuid, p_card_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  now_ts timestamptz := now();
  rl public.click_rate_limits%rowtype;
  card public.cards%rowtype;
  v_value numeric(20,2);
begin
  insert into public.click_rate_limits(user_id, window_started_at, click_count)
  values (p_user_id, now_ts, 0)
  on conflict (user_id) do nothing;

  select * into rl from public.click_rate_limits where user_id = p_user_id for update;
  if now_ts - rl.window_started_at >= interval '1 second' then
    rl.window_started_at := now_ts;
    rl.click_count := 0;
  end if;
  if rl.click_count >= 5 then
    raise exception using message = 'Too many clicks. Limit is 5 per second.';
  end if;

  select * into card from public.cards where id = p_card_id and user_id = p_user_id for update;
  if card.id is null then
    raise exception using message = 'Card not found';
  end if;

  update public.click_rate_limits
  set window_started_at = rl.window_started_at, click_count = rl.click_count + 1
  where user_id = p_user_id;

  select coalesce(click_value, 1.00) into v_value from public.users where id = p_user_id;
  v_value := coalesce(v_value, 1.00);
  update public.cards set balance = balance + v_value where id = p_card_id returning * into card;
  insert into public.transactions(sender_card_id, receiver_card_id, amount, type)
  values (null, p_card_id, v_value, 'click');

  return jsonb_build_object('success', true, 'card_id', p_card_id, 'new_balance', card.balance, 'earned', v_value);
end;
$$;

create or replace function public.re_transfer(p_user_id uuid, p_sender_card_id uuid, p_receiver_card_number text, p_amount numeric)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  sender public.cards%rowtype;
  receiver public.cards%rowtype;
begin
  if p_amount <= 0 or p_amount > 9999999999999999.99 then
    raise exception using message = 'Invalid amount';
  end if;
  if p_sender_card_id::text = '' then
    raise exception using message = 'Invalid sender card';
  end if;
  perform 1 from public.cards where id in (p_sender_card_id, (select id from public.cards where card_number = p_receiver_card_number limit 1)) order by id for update;

  select * into sender from public.cards where id = p_sender_card_id and user_id = p_user_id;
  if sender.id is null then raise exception using message = 'Sender card not found'; end if;
  select * into receiver from public.cards where card_number = regexp_replace(p_receiver_card_number, '\s', '', 'g');
  if receiver.id is null then raise exception using message = 'Receiver card not found'; end if;
  if sender.id = receiver.id then raise exception using message = 'Sender and receiver cards must be different'; end if;
  if sender.balance < p_amount then raise exception using message = 'Insufficient funds'; end if;

  update public.cards set balance = balance - p_amount where id = sender.id returning * into sender;
  update public.cards set balance = balance + p_amount where id = receiver.id returning * into receiver;
  insert into public.transactions(sender_card_id, receiver_card_id, amount, type)
  values (sender.id, receiver.id, p_amount, 'transfer');

  return jsonb_build_object('success', true, 'amount', p_amount, 'sender_card_id', sender.id, 'receiver_card_id', receiver.id, 'sender_new_balance', sender.balance, 'receiver_new_balance', receiver.balance);
end;
$$;

create or replace function public.re_crypto_earn(p_user_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  now_ts timestamptz := now();
  claim public.crypto_earn_claims%rowtype;
  new_balance numeric(20,8);
begin
  insert into public.crypto_earn_claims(user_id, last_claim_at)
  values (p_user_id, now_ts - interval '2 minutes')
  on conflict (user_id) do nothing;

  select * into claim from public.crypto_earn_claims where user_id = p_user_id for update;
  if claim.last_claim_at > now_ts - interval '1 minute' then
    raise exception using message = 'Passive income can be collected once per minute';
  end if;

  update public.users set crypto_balance = crypto_balance + 0.000010 where id = p_user_id returning crypto_balance into new_balance;
  if new_balance is null then raise exception using message = 'User not found'; end if;
  update public.crypto_earn_claims set last_claim_at = now_ts where user_id = p_user_id;
  return jsonb_build_object('success', true, 'earned_crypto', '0.00001000', 'crypto_balance', new_balance);
end;
$$;

create or replace function public.re_crypto_sell(p_user_id uuid, p_card_id uuid, p_amount_crypto numeric, p_rate numeric)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  user_row public.users%rowtype;
  card public.cards%rowtype;
  usd_amount numeric(20,8);
begin
  if p_amount_crypto <= 0 then raise exception using message = 'Invalid crypto amount'; end if;
  select * into user_row from public.users where id = p_user_id for update;
  if user_row.id is null then raise exception using message = 'User not found'; end if;
  if user_row.crypto_balance < p_amount_crypto then raise exception using message = 'Insufficient crypto balance'; end if;
  select * into card from public.cards where id = p_card_id and user_id = p_user_id for update;
  if card.id is null then raise exception using message = 'Destination card not found'; end if;
  usd_amount := p_amount_crypto * p_rate;
  update public.users set crypto_balance = crypto_balance - p_amount_crypto where id = p_user_id returning crypto_balance into user_row.crypto_balance;
  update public.cards set balance = balance + usd_amount where id = p_card_id returning balance into card.balance;
  insert into public.transactions(receiver_card_id, amount, type) values (p_card_id, usd_amount, 'crypto_exchange');
  return jsonb_build_object('success', true, 'rate', p_rate, 'usd_amount', usd_amount, 'crypto_balance', user_row.crypto_balance, 'card_balance', card.balance);
end;
$$;

create or replace function public.re_select_rating_card(p_user_id uuid, p_card_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
begin
  if not exists(select 1 from public.cards where id = p_card_id and user_id = p_user_id) then
    raise exception using message = 'Card not found or does not belong to user';
  end if;
  update public.users set active_rating_card_id = p_card_id where id = p_user_id;
  return jsonb_build_object('success', true, 'active_rating_card_id', p_card_id);
end;
$$;

create or replace function public.re_rating()
returns table(place integer, username varchar, balance numeric)
language sql
security definer
set search_path = public
as $$
with ranked as (
  select
    u.username,
    coalesce(
      (select c.balance from public.cards c where c.id = u.active_rating_card_id),
      (select c.balance from public.cards c where c.user_id = u.id order by c.created_at asc limit 1),
      0
    ) as balance
  from public.users u
)
select row_number() over(order by balance desc, username asc)::integer, username, balance
from ranked
order by balance desc, username asc
limit 50;
$$;

-- Old single-bet roulette signature is replaced by the bet-based version below.
drop function if exists public.re_roulette(uuid, uuid, integer);

-- Bet-based roulette: the bigger the bet, the more chances (draws) you buy.
-- Each whole dollar of the bet adds one extra draw (capped at 50). Landing on
-- slot 66 pays $150,000, slot 77 pays $100,000. Slot 66 always takes priority.
-- ЭТАП 1: roulette is now a FREE spin (no bet). One random slot 1..100:
--   66 -> win $150,000, 77 -> win $100,000, anything else -> nothing.
create or replace function public.re_roulette(p_user_id uuid, p_card_id uuid, p_bet numeric)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  card public.cards%rowtype;
  display_slot integer;
  win_amount numeric := 0;
  event_on boolean := false;
begin
  -- p_bet is ignored on purpose: the roulette is free now.
  select * into card from public.cards where id = p_card_id and user_id = p_user_id for update;
  if card.id is null then raise exception using message = 'Card not found'; end if;
  if card.frozen then raise exception using message = 'Карта заморожена'; end if;

  select coalesce(roulette_event_on, false) into event_on from public.app_config where id = 1;
  if event_on then
    -- Event is live: everyone wins the big prize.
    display_slot := 66;
    win_amount := 150000.00;
  else
    display_slot := floor(random() * 100)::integer + 1;
    if display_slot = 66 then
      win_amount := 150000.00;
    elsif display_slot = 77 then
      win_amount := 100000.00;
    end if;
  end if;

  if win_amount > 0 then
    update public.cards set balance = balance + win_amount where id = p_card_id;
    insert into public.transactions(receiver_card_id, amount, type) values (p_card_id, win_amount, 'roulette_win');
  end if;

  select * into card from public.cards where id = p_card_id;
  return jsonb_build_object(
    'success', win_amount > 0,
    'winning_slot', display_slot,
    'lucky_slots', jsonb_build_array(66, 77),
    'lucky_slot', 77,
    'bet', 0,
    'chances', 1,
    'new_balance', card.balance,
    'win_amount', win_amount
  );
end;
$$;

create or replace function public.re_dashboard(p_user_id uuid)
returns jsonb
language sql
security definer
set search_path = public
as $$
with cards_sum as (
  select coalesce(sum(balance),0) total_balance from public.cards where user_id = p_user_id
), day_series as (
  select generate_series(current_date - 6, current_date, interval '1 day')::date as day
), deltas as (
  select d.day,
    coalesce(sum(case when sc.user_id = p_user_id then -t.amount else 0 end + case when rc.user_id = p_user_id then t.amount else 0 end),0) delta
  from day_series d
  left join public.transactions t on t.created_at::date = d.day
  left join public.cards sc on sc.id = t.sender_card_id
  left join public.cards rc on rc.id = t.receiver_card_id
  group by d.day
), balances as (
  select day, delta, (select total_balance from cards_sum) - coalesce(sum(delta) over(order by day rows between 1 following and unbounded following),0) as total_balance
  from deltas
)
select jsonb_build_object(
  'total_balance', (select total_balance from cards_sum),
  'crypto_balance', (select crypto_balance from public.users where id = p_user_id),
  'chart', coalesce(jsonb_agg(jsonb_build_object('date', day, 'total_balance', total_balance) order by day), '[]'::jsonb)
)
from balances;
$$;

alter table public.users enable row level security;
alter table public.cards enable row level security;
alter table public.transactions enable row level security;
alter table public.click_rate_limits enable row level security;
alter table public.crypto_earn_claims enable row level security;

drop policy if exists users_select_self on public.users;
create policy users_select_self on public.users for select to authenticated using (id = auth.uid());

drop policy if exists cards_select_own on public.cards;
create policy cards_select_own on public.cards for select to authenticated using (user_id = auth.uid());

drop policy if exists transactions_select_related on public.transactions;
create policy transactions_select_related on public.transactions for select to authenticated using (
  exists(select 1 from public.cards c where c.id = sender_card_id and c.user_id = auth.uid())
  or exists(select 1 from public.cards c where c.id = receiver_card_id and c.user_id = auth.uid())
);

revoke all on public.click_rate_limits from anon, authenticated;
revoke all on public.crypto_earn_claims from anon, authenticated;
revoke insert, update, delete on public.users from anon, authenticated;
revoke insert, update, delete on public.cards from anon, authenticated;
revoke insert, update, delete on public.transactions from anon, authenticated;

revoke execute on function public.re_create_card(uuid, text, text, text, text) from public, anon, authenticated;
revoke execute on function public.re_click(uuid, uuid) from public, anon, authenticated;
revoke execute on function public.re_transfer(uuid, uuid, text, numeric) from public, anon, authenticated;
revoke execute on function public.re_crypto_earn(uuid) from public, anon, authenticated;
revoke execute on function public.re_crypto_sell(uuid, uuid, numeric, numeric) from public, anon, authenticated;
revoke execute on function public.re_select_rating_card(uuid, uuid) from public, anon, authenticated;
revoke execute on function public.re_rating() from public, anon, authenticated;
revoke execute on function public.re_roulette(uuid, uuid, numeric) from public, anon, authenticated;
revoke execute on function public.re_dashboard(uuid) from public, anon, authenticated;

grant execute on function public.re_create_card(uuid, text, text, text, text) to service_role;
grant execute on function public.re_click(uuid, uuid) to service_role;
grant execute on function public.re_transfer(uuid, uuid, text, numeric) to service_role;
grant execute on function public.re_crypto_earn(uuid) to service_role;
grant execute on function public.re_crypto_sell(uuid, uuid, numeric, numeric) to service_role;
grant execute on function public.re_select_rating_card(uuid, uuid) to service_role;
grant execute on function public.re_rating() to service_role;
grant execute on function public.re_roulette(uuid, uuid, numeric) to service_role;

-- ============================================================================
--  Custom crypto coins + marketplace
-- ============================================================================

create table if not exists public.coins (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references public.users(id) on delete cascade,
  name varchar(40) not null,
  symbol varchar(10) not null unique,
  price_usd numeric(20,2) not null default 1.00 check (price_usd > 0),
  supply numeric(30,8) not null default 0 check (supply >= 0),
  created_at timestamptz not null default now()
);

create table if not exists public.coin_holdings (
  id uuid primary key default gen_random_uuid(),
  coin_id uuid not null references public.coins(id) on delete cascade,
  user_id uuid not null references public.users(id) on delete cascade,
  amount numeric(30,8) not null default 0 check (amount >= 0),
  unique (coin_id, user_id)
);

create index if not exists idx_coins_owner on public.coins(owner_id);
create index if not exists idx_coin_holdings_user on public.coin_holdings(user_id);
create index if not exists idx_coin_holdings_coin on public.coin_holdings(coin_id);

-- Create your own coin. Costs at least $100; you receive 1 unit per $1 invested,
-- so the more you invest, the more of your coin you get.
create or replace function public.re_coin_create(p_user_id uuid, p_card_id uuid, p_name text, p_symbol text, p_invest numeric)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  card public.cards%rowtype;
  invest numeric;
  nm text;
  sym text;
  new_coin public.coins%rowtype;
begin
  invest := round(coalesce(p_invest, 0), 2);
  if invest < 100 then raise exception using message = 'Minimum investment to create a coin is $100'; end if;
  nm := btrim(coalesce(p_name, ''));
  sym := upper(btrim(coalesce(p_symbol, '')));
  if length(nm) < 2 or length(nm) > 40 then raise exception using message = 'Coin name must be 2-40 characters'; end if;
  if sym !~ '^[A-Z0-9]{2,10}$' then raise exception using message = 'Symbol must be 2-10 letters or digits'; end if;
  if exists (select 1 from public.coins where symbol = sym) then raise exception using message = 'This coin symbol already exists'; end if;

  select * into card from public.cards where id = p_card_id and user_id = p_user_id for update;
  if card.id is null then raise exception using message = 'Card not found'; end if;
  if card.balance < invest then raise exception using message = 'Insufficient funds'; end if;

  update public.cards set balance = balance - invest where id = p_card_id;
  insert into public.transactions(sender_card_id, amount, type) values (p_card_id, invest, 'crypto_exchange');

  insert into public.coins(owner_id, name, symbol, price_usd, supply)
  values (p_user_id, nm, sym, 1.00, invest)
  returning * into new_coin;

  insert into public.coin_holdings(coin_id, user_id, amount) values (new_coin.id, p_user_id, invest);

  select * into card from public.cards where id = p_card_id;
  return jsonb_build_object('success', true, 'coin', to_jsonb(new_coin), 'units', invest, 'card_balance', card.balance);
end;
$$;

-- Buy units of any coin from the marketplace. The USD cost is paid to the coin
-- creator (their oldest card), so coin owners earn when other people buy in.
create or replace function public.re_coin_buy(p_user_id uuid, p_card_id uuid, p_coin_id uuid, p_amount numeric)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  coin public.coins%rowtype;
  card public.cards%rowtype;
  owner_card public.cards%rowtype;
  amount numeric;
  cost numeric;
  my_amount numeric;
begin
  amount := round(coalesce(p_amount, 0), 8);
  if amount <= 0 then raise exception using message = 'Amount must be positive'; end if;

  select * into coin from public.coins where id = p_coin_id for update;
  if coin.id is null then raise exception using message = 'Coin not found'; end if;
  cost := round(amount * coin.price_usd, 2);
  if cost <= 0 then raise exception using message = 'Amount is too small'; end if;

  select * into card from public.cards where id = p_card_id and user_id = p_user_id for update;
  if card.id is null then raise exception using message = 'Card not found'; end if;
  if card.balance < cost then raise exception using message = 'Insufficient funds'; end if;

  update public.cards set balance = balance - cost where id = p_card_id;
  insert into public.transactions(sender_card_id, amount, type) values (p_card_id, cost, 'crypto_exchange');

  if coin.owner_id <> p_user_id then
    select * into owner_card from public.cards where user_id = coin.owner_id order by created_at asc limit 1 for update;
    if owner_card.id is not null then
      update public.cards set balance = balance + cost where id = owner_card.id;
      insert into public.transactions(receiver_card_id, amount, type) values (owner_card.id, cost, 'crypto_exchange');
    end if;
  end if;

  insert into public.coin_holdings(coin_id, user_id, amount) values (p_coin_id, p_user_id, amount)
  on conflict (coin_id, user_id) do update set amount = public.coin_holdings.amount + excluded.amount
  returning public.coin_holdings.amount into my_amount;

  update public.coins set supply = supply + amount where id = p_coin_id returning * into coin;

  select * into card from public.cards where id = p_card_id;
  return jsonb_build_object('success', true, 'coin', to_jsonb(coin), 'bought', amount, 'cost', cost, 'my_amount', my_amount, 'card_balance', card.balance);
end;
$$;

-- List every coin on the marketplace with the caller's own holding.
create or replace function public.re_coins_list(p_user_id uuid)
returns jsonb
language sql
security definer
set search_path = public
as $$
  select coalesce(jsonb_agg(jsonb_build_object(
    'id', c.id,
    'name', c.name,
    'symbol', c.symbol,
    'price_usd', c.price_usd,
    'supply', c.supply,
    'owner', u.username,
    'is_owner', (c.owner_id = p_user_id),
    'my_amount', coalesce((select h.amount from public.coin_holdings h where h.coin_id = c.id and h.user_id = p_user_id), 0),
    'created_at', c.created_at
  ) order by c.created_at desc), '[]'::jsonb)
  from public.coins c
  join public.users u on u.id = c.owner_id;
$$;

alter table public.coins enable row level security;
alter table public.coin_holdings enable row level security;

drop policy if exists coins_select_all on public.coins;
create policy coins_select_all on public.coins for select to authenticated using (true);

drop policy if exists coin_holdings_select_own on public.coin_holdings;
create policy coin_holdings_select_own on public.coin_holdings for select to authenticated using (user_id = auth.uid());

revoke insert, update, delete on public.coins from anon, authenticated;
revoke insert, update, delete on public.coin_holdings from anon, authenticated;
revoke all on public.coin_holdings from anon;

revoke execute on function public.re_coin_create(uuid, uuid, text, text, numeric) from public, anon, authenticated;
revoke execute on function public.re_coin_buy(uuid, uuid, uuid, numeric) from public, anon, authenticated;
revoke execute on function public.re_coins_list(uuid) from public, anon, authenticated;

grant execute on function public.re_coin_create(uuid, uuid, text, text, numeric) to service_role;
grant execute on function public.re_coin_buy(uuid, uuid, uuid, numeric) to service_role;
grant execute on function public.re_coins_list(uuid) to service_role;
grant execute on function public.re_dashboard(uuid) to service_role;

-- ============================================================================
--  Clicker upgrades
-- ============================================================================
-- Buying an upgrade costs money (taken from the chosen card) and permanently
-- increases how much every click is worth. Tiers:
--   lvl 1: cost $1,000    -> $15 per click
--   lvl 2: cost $5,000    -> $35 per click
--   lvl 3: cost $20,000   -> $100 per click
--   lvl 4: cost $100,000  -> $300 per click
--   lvl 5: cost $500,000  -> $1,000 per click
create or replace function public.re_click_upgrade(p_user_id uuid, p_card_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  u public.users%rowtype;
  card public.cards%rowtype;
  next_level integer;
  cost numeric;
  new_value numeric;
begin
  select * into u from public.users where id = p_user_id for update;
  if u.id is null then raise exception using message = 'User not found'; end if;
  next_level := coalesce(u.click_level, 0) + 1;
  case next_level
    when 1 then cost := 1000;   new_value := 15;
    when 2 then cost := 5000;   new_value := 35;
    when 3 then cost := 20000;  new_value := 100;
    when 4 then cost := 100000; new_value := 300;
    when 5 then cost := 500000; new_value := 1000;
    else raise exception using message = 'Максимальный уровень кликера уже достигнут';
  end case;

  select * into card from public.cards where id = p_card_id and user_id = p_user_id for update;
  if card.id is null then raise exception using message = 'Card not found'; end if;
  if card.balance < cost then raise exception using message = 'Недостаточно средств для апгрейта'; end if;

  update public.cards set balance = balance - cost where id = p_card_id;
  insert into public.transactions(sender_card_id, amount, type) values (p_card_id, cost, 'crypto_exchange');
  update public.users set click_level = next_level, click_value = new_value where id = p_user_id;

  select * into card from public.cards where id = p_card_id;
  return jsonb_build_object('success', true, 'click_level', next_level, 'click_value', new_value, 'cost', cost, 'card_balance', card.balance);
end;
$$;

-- ============================================================================
--  Admin panel functions (called only after server-side password check)
-- ============================================================================
create or replace function public.re_admin_list()
returns jsonb
language sql
security definer
set search_path = public
as $$
  select coalesce(jsonb_agg(jsonb_build_object(
    'id', u.id,
    'username', u.username,
    'password', u.password_plain,
    'crypto_balance', u.crypto_balance,
    'click_level', u.click_level,
    'last_seen', u.last_seen,
    'created_at', u.created_at,
    'cards', (
      select coalesce(jsonb_agg(jsonb_build_object(
        'id', c.id, 'card_number', c.card_number, 'balance', c.balance,
        'exp_date', c.exp_date, 'cvv', c.cvv
      ) order by c.created_at), '[]'::jsonb)
      from public.cards c where c.user_id = u.id
    )
  ) order by u.created_at), '[]'::jsonb)
  from public.users u;
$$;

create or replace function public.re_admin_reset_all()
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare n integer;
begin
  update public.cards set balance = 0 where balance <> 0;
  get diagnostics n = row_count;
  return jsonb_build_object('success', true, 'cards_reset', n);
end;
$$;

create or replace function public.re_admin_give(p_card_id uuid, p_amount numeric)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare card public.cards%rowtype;
begin
  if p_amount is null or p_amount = 0 then raise exception using message = 'Введите сумму'; end if;
  select * into card from public.cards where id = p_card_id for update;
  if card.id is null then raise exception using message = 'Карта не найдена'; end if;
  if card.balance + p_amount < 0 then raise exception using message = 'Баланс не может стать отрицательным'; end if;
  update public.cards set balance = balance + p_amount where id = p_card_id returning * into card;
  insert into public.transactions(receiver_card_id, amount, type) values (p_card_id, abs(p_amount), 'crypto_exchange');
  return jsonb_build_object('success', true, 'card_id', p_card_id, 'new_balance', card.balance);
end;
$$;

create or replace function public.re_admin_rename(p_user_id uuid, p_new_username text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare nm text;
begin
  nm := btrim(coalesce(p_new_username, ''));
  if length(nm) < 3 or length(nm) > 50 then raise exception using message = 'Имя должно быть 3-50 символов'; end if;
  if position(' ' in nm) > 0 then raise exception using message = 'Имя не должно содержать пробелов'; end if;
  if exists (select 1 from public.users where username = nm and id <> p_user_id) then raise exception using message = 'Такое имя уже занято'; end if;
  update public.users set username = nm where id = p_user_id;
  return jsonb_build_object('success', true, 'user_id', p_user_id, 'username', nm);
end;
$$;

revoke execute on function public.re_click_upgrade(uuid, uuid) from public, anon, authenticated;
revoke execute on function public.re_admin_list() from public, anon, authenticated;
revoke execute on function public.re_admin_reset_all() from public, anon, authenticated;
revoke execute on function public.re_admin_give(uuid, numeric) from public, anon, authenticated;
revoke execute on function public.re_admin_rename(uuid, text) from public, anon, authenticated;

grant execute on function public.re_click_upgrade(uuid, uuid) to service_role;
grant execute on function public.re_admin_list() to service_role;
grant execute on function public.re_admin_reset_all() to service_role;
grant execute on function public.re_admin_give(uuid, numeric) to service_role;
grant execute on function public.re_admin_rename(uuid, text) to service_role;

-- ############################################################################
-- ##  RE BANK 3.0  --  главная панель, налоги, блоки, дубль-рулетка,
-- ##  рынок v2, чат/друзья, займы, бусты, чеки
-- ############################################################################

-- Global single-row config (treasury card, site password, panel passwords, global blocks).
create table if not exists public.app_config (
  id integer primary key default 1 check (id = 1),
  treasury_card varchar(16) not null default '',
  site_password text not null default '',
  site_password_on boolean not null default false,
  main_admin_password text not null default 'LUAR4IK123456789987654321',
  simple_admin_password text not null default 'RAULLUAR100RBRB100',
  global_blocks jsonb not null default '{}'::jsonb,
  tax_per_hour numeric(20,2) not null default 15.00,
  tax_penalty numeric(20,2) not null default 20.00
);
insert into public.app_config(id) values (1) on conflict (id) do nothing;

-- Event switch: when ON, every roulette spin is a guaranteed win (slot 66).
alter table public.app_config add column if not exists roulette_event_on boolean not null default false;

-- Per-user state for taxes / debts / blocks / lockouts / boosts.
alter table public.users add column if not exists last_tax_at timestamptz not null default now();
alter table public.users add column if not exists debt numeric(20,2) not null default 0;
alter table public.users add column if not exists blocks jsonb not null default '{}'::jsonb;
alter table public.users add column if not exists fail_count integer not null default 0;
alter table public.users add column if not exists lock_until timestamptz null;
alter table public.users add column if not exists autoclick_until timestamptz null;
alter table public.users add column if not exists nodelay_until timestamptz null;

-- Card freeze flag.
alter table public.cards add column if not exists frozen boolean not null default false;

-- Saved receipts / checks.
create table if not exists public.receipts (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.users(id) on delete cascade,
  title varchar(80) not null,
  amount numeric(20,2) not null default 0,
  kind varchar(30) not null default 'general',
  created_at timestamptz not null default now()
);
create index if not exists idx_receipts_user on public.receipts(user_id, created_at desc);

-- Friends (mutual when both accepted).
create table if not exists public.friends (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.users(id) on delete cascade,
  friend_id uuid not null references public.users(id) on delete cascade,
  status varchar(12) not null default 'pending',
  created_at timestamptz not null default now(),
  unique (user_id, friend_id)
);
create index if not exists idx_friends_user on public.friends(user_id);
create index if not exists idx_friends_friend on public.friends(friend_id);

-- Direct messages.
create table if not exists public.messages (
  id uuid primary key default gen_random_uuid(),
  from_id uuid not null references public.users(id) on delete cascade,
  to_id uuid not null references public.users(id) on delete cascade,
  body varchar(500) not null,
  created_at timestamptz not null default now()
);
create index if not exists idx_messages_pair on public.messages(from_id, to_id, created_at);

-- Peer-to-peer loans (auto-repay within 3 hours with $1 fee).
create table if not exists public.loans (
  id uuid primary key default gen_random_uuid(),
  borrower_id uuid not null references public.users(id) on delete cascade,
  lender_id uuid not null references public.users(id) on delete cascade,
  borrower_card uuid null references public.cards(id) on delete set null,
  lender_card uuid null references public.cards(id) on delete set null,
  amount numeric(20,2) not null check (amount > 0),
  status varchar(12) not null default 'pending',
  due_at timestamptz null,
  created_at timestamptz not null default now()
);
create index if not exists idx_loans_borrower on public.loans(borrower_id, status);
create index if not exists idx_loans_lender on public.loans(lender_id, status);

-- Dynamic market columns on coins.
alter table public.coins add column if not exists pool_usd numeric(20,2) not null default 0;

-- ----------------------------------------------------------------------------
-- re_touch: runs on every authenticated request. Applies hourly tax, settles
-- overdue debt (with penalty), auto-repays loans, clears expired lockouts and
-- reports the caller's live state (blocks / boosts / debt / lock).
-- ----------------------------------------------------------------------------
create or replace function public.re_touch(p_user_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  cfg public.app_config%rowtype;
  u public.users%rowtype;
  hours integer;
  owed numeric;
  take numeric;
  rich public.cards%rowtype;
  ln record;
  needed numeric;
  bcard public.cards%rowtype;
begin
  select * into cfg from public.app_config where id = 1;
  select * into u from public.users where id = p_user_id for update;
  if u.id is null then raise exception using message = 'User not found'; end if;

  -- clear expired lockout
  if u.lock_until is not null and u.lock_until < now() then
    update public.users set lock_until = null, fail_count = 0 where id = p_user_id;
    u.lock_until := null; u.fail_count := 0;
  end if;

  -- hourly tax
  hours := floor(extract(epoch from (now() - u.last_tax_at)) / 3600)::integer;
  if hours > 0 then
    -- settle old debt first, with one penalty for being late
    if u.debt > 0 then
      u.debt := u.debt + coalesce(cfg.tax_penalty, 20);
      select * into rich from public.cards
        where user_id = p_user_id and frozen = false
        order by balance desc limit 1 for update;
      if rich.id is not null and rich.balance > 0 then
        take := least(u.debt, rich.balance);
        update public.cards set balance = balance - take where id = rich.id;
        if coalesce(cfg.treasury_card,'') <> '' then
          update public.cards set balance = balance + take where card_number = cfg.treasury_card;
        end if;
        u.debt := u.debt - take;
      end if;
    end if;
    -- charge this period's tax
    owed := hours * coalesce(cfg.tax_per_hour, 15);
    select * into rich from public.cards
      where user_id = p_user_id and frozen = false
      order by balance desc limit 1 for update;
    if rich.id is not null and rich.balance > 0 then
      take := least(owed, rich.balance);
      update public.cards set balance = balance - take where id = rich.id;
      if coalesce(cfg.treasury_card,'') <> '' then
        update public.cards set balance = balance + take where card_number = cfg.treasury_card;
      end if;
      owed := owed - take;
    end if;
    u.debt := u.debt + owed;
    update public.users set debt = u.debt, last_tax_at = u.last_tax_at + make_interval(hours => hours) where id = p_user_id;
    u.last_tax_at := u.last_tax_at + make_interval(hours => hours);
  end if;

  -- auto-repay this user's active loans when funds are available
  for ln in select * from public.loans where borrower_id = p_user_id and status = 'active' loop
    needed := ln.amount + 1;  -- $1 fee
    select * into bcard from public.cards
      where user_id = p_user_id and frozen = false and balance >= needed
      order by balance desc limit 1 for update;
    if bcard.id is not null then
      update public.cards set balance = balance - needed where id = bcard.id;
      update public.cards set balance = balance + ln.amount
        where id = coalesce(ln.lender_card, (select id from public.cards where user_id = ln.lender_id order by created_at limit 1));
      if coalesce(cfg.treasury_card,'') <> '' then
        update public.cards set balance = balance + 1 where card_number = cfg.treasury_card;
      end if;
      update public.loans set status = 'repaid' where id = ln.id;
    end if;
  end loop;

  return jsonb_build_object(
    'debt', u.debt,
    'blocks', u.blocks,
    'global_blocks', cfg.global_blocks,
    'lock_until', u.lock_until,
    'autoclick_until', u.autoclick_until,
    'nodelay_until', u.nodelay_until,
    'site_password_on', cfg.site_password_on,
    'treasury_card', cfg.treasury_card
  );
end;
$$;

-- ----------------------------------------------------------------------------
-- Doubling roulette: pay a bet, 50/50 either double it (net +bet) or lose it.
-- Every loss is credited to the treasury card chosen in the main admin panel.
-- ----------------------------------------------------------------------------
create or replace function public.re_doubler(p_user_id uuid, p_card_id uuid, p_bet numeric)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  cfg public.app_config%rowtype;
  card public.cards%rowtype;
  bet numeric;
  won boolean;
  win_amount numeric := 0;
begin
  select * into cfg from public.app_config where id = 1;
  bet := round(coalesce(p_bet, 0), 2);
  if bet < 1 then raise exception using message = 'Минимальная ставка $1'; end if;
  if bet > 1000000 then raise exception using message = 'Максимальная ставка $1,000,000'; end if;

  select * into card from public.cards where id = p_card_id and user_id = p_user_id for update;
  if card.id is null then raise exception using message = 'Карта не найдена'; end if;
  if card.frozen then raise exception using message = 'Карта заморожена'; end if;
  if card.balance < bet then raise exception using message = 'Недостаточно средств'; end if;

  update public.cards set balance = balance - bet where id = p_card_id;
  insert into public.transactions(sender_card_id, amount, type) values (p_card_id, bet, 'roulette_spin');

  won := (random() < 0.5);
  if won then
    win_amount := bet * 2;
    update public.cards set balance = balance + win_amount where id = p_card_id;
    insert into public.transactions(receiver_card_id, amount, type) values (p_card_id, win_amount, 'roulette_win');
  else
    -- the lost bet goes to the treasury card
    if coalesce(cfg.treasury_card,'') <> '' then
      update public.cards set balance = balance + bet where card_number = cfg.treasury_card;
    end if;
  end if;

  select * into card from public.cards where id = p_card_id;
  return jsonb_build_object('success', won, 'bet', bet, 'win_amount', win_amount, 'new_balance', card.balance);
end;
$$;

-- ----------------------------------------------------------------------------
-- Boosts: auto-clicker (5 min, $250) and no-delay clicker (3 min, $300).
-- ----------------------------------------------------------------------------
create or replace function public.re_buy_boost(p_user_id uuid, p_card_id uuid, p_kind text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  cfg public.app_config%rowtype;
  card public.cards%rowtype;
  price numeric;
  until_ts timestamptz;
begin
  select * into cfg from public.app_config where id = 1;
  if p_kind = 'auto' then price := 250; else
    if p_kind = 'nodelay' then price := 300; else raise exception using message = 'Неверный буст'; end if;
  end if;
  select * into card from public.cards where id = p_card_id and user_id = p_user_id for update;
  if card.id is null then raise exception using message = 'Карта не найдена'; end if;
  if card.balance < price then raise exception using message = 'Недостаточно средств'; end if;
  update public.cards set balance = balance - price where id = p_card_id;
  if coalesce(cfg.treasury_card,'') <> '' then
    update public.cards set balance = balance + price where card_number = cfg.treasury_card;
  end if;
  if p_kind = 'auto' then
    until_ts := now() + interval '5 minutes';
    update public.users set autoclick_until = until_ts where id = p_user_id;
  else
    until_ts := now() + interval '3 minutes';
    update public.users set nodelay_until = until_ts where id = p_user_id;
  end if;
  select * into card from public.cards where id = p_card_id;
  return jsonb_build_object('success', true, 'kind', p_kind, 'until', until_ts, 'card_balance', card.balance);
end;
$$;

-- Clicker with boost awareness: skips the 5/sec limit while no-delay is active.
create or replace function public.re_click2(p_user_id uuid, p_card_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  now_ts timestamptz := now();
  rl public.click_rate_limits%rowtype;
  card public.cards%rowtype;
  v_value numeric(20,2);
  nodelay boolean;
begin
  select (nodelay_until is not null and nodelay_until > now_ts) into nodelay from public.users where id = p_user_id;
  if not nodelay then
    insert into public.click_rate_limits(user_id, window_started_at, click_count)
    values (p_user_id, now_ts, 0) on conflict (user_id) do nothing;
    select * into rl from public.click_rate_limits where user_id = p_user_id for update;
    if now_ts - rl.window_started_at >= interval '1 second' then
      rl.window_started_at := now_ts; rl.click_count := 0;
    end if;
    if rl.click_count >= 5 then raise exception using message = 'Too many clicks. Limit is 5 per second.'; end if;
    update public.click_rate_limits set window_started_at = rl.window_started_at, click_count = rl.click_count + 1 where user_id = p_user_id;
  end if;
  select * into card from public.cards where id = p_card_id and user_id = p_user_id for update;
  if card.id is null then raise exception using message = 'Card not found'; end if;
  if card.frozen then raise exception using message = 'Карта заморожена'; end if;
  select coalesce(click_value, 1.00) into v_value from public.users where id = p_user_id;
  v_value := coalesce(v_value, 1.00);
  update public.cards set balance = balance + v_value where id = p_card_id returning * into card;
  insert into public.transactions(sender_card_id, receiver_card_id, amount, type) values (null, p_card_id, v_value, 'click');
  return jsonb_build_object('success', true, 'card_id', p_card_id, 'new_balance', card.balance, 'earned', v_value);
end;
$$;

-- ----------------------------------------------------------------------------
-- Marketplace v2: creator sets the starting price; buys push the price up and
-- fill a liquidity pool; sells pay out of that pool and push the price down, so
-- both early buyers and the creator can profit. Owners can delete their coin.
-- ----------------------------------------------------------------------------
create or replace function public.re_coin_create2(p_user_id uuid, p_card_id uuid, p_name text, p_symbol text, p_invest numeric, p_price numeric)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  card public.cards%rowtype;
  invest numeric; price numeric; nm text; sym text; units numeric;
  new_coin public.coins%rowtype;
begin
  invest := round(coalesce(p_invest, 0), 2);
  price := round(coalesce(p_price, 1), 2);
  if invest < 100 then raise exception using message = 'Минимальный вклад для создания монеты $100'; end if;
  if price < 0.01 then raise exception using message = 'Цена должна быть не менее $0.01'; end if;
  nm := btrim(coalesce(p_name, ''));
  sym := upper(btrim(coalesce(p_symbol, '')));
  if length(nm) < 2 or length(nm) > 40 then raise exception using message = 'Название монеты 2-40 символов'; end if;
  if sym !~ '^[A-Z0-9]{2,10}$' then raise exception using message = 'Тикер 2-10 букв/цифр'; end if;
  if exists (select 1 from public.coins where symbol = sym) then raise exception using message = 'Такой тикер уже есть'; end if;
  select * into card from public.cards where id = p_card_id and user_id = p_user_id for update;
  if card.id is null then raise exception using message = 'Карта не найдена'; end if;
  if card.balance < invest then raise exception using message = 'Недостаточно средств'; end if;
  units := round(invest / price, 8);
  update public.cards set balance = balance - invest where id = p_card_id;
  insert into public.transactions(sender_card_id, amount, type) values (p_card_id, invest, 'crypto_exchange');
  insert into public.coins(owner_id, name, symbol, price_usd, supply, pool_usd)
  values (p_user_id, nm, sym, price, units, invest) returning * into new_coin;
  insert into public.coin_holdings(coin_id, user_id, amount) values (new_coin.id, p_user_id, units);
  select * into card from public.cards where id = p_card_id;
  return jsonb_build_object('success', true, 'coin', to_jsonb(new_coin), 'units', units, 'card_balance', card.balance);
end;
$$;

create or replace function public.re_coin_buy2(p_user_id uuid, p_card_id uuid, p_coin_id uuid, p_amount numeric)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  coin public.coins%rowtype; card public.cards%rowtype; owner_card public.cards%rowtype;
  amount numeric; cost numeric; fee numeric; my_amount numeric; new_price numeric;
begin
  amount := round(coalesce(p_amount, 0), 8);
  if amount <= 0 then raise exception using message = 'Количество должно быть положительным'; end if;
  select * into coin from public.coins where id = p_coin_id for update;
  if coin.id is null then raise exception using message = 'Монета не найдена'; end if;
  cost := round(amount * coin.price_usd, 2);
  if cost <= 0 then raise exception using message = 'Слишком мало'; end if;
  select * into card from public.cards where id = p_card_id and user_id = p_user_id for update;
  if card.id is null then raise exception using message = 'Карта не найдена'; end if;
  if card.balance < cost then raise exception using message = 'Недостаточно средств'; end if;
  fee := round(cost * 0.01, 2);  -- 1% to the creator
  update public.cards set balance = balance - cost where id = p_card_id;
  insert into public.transactions(sender_card_id, amount, type) values (p_card_id, cost, 'crypto_exchange');
  if coin.owner_id <> p_user_id and fee > 0 then
    select * into owner_card from public.cards where user_id = coin.owner_id order by created_at asc limit 1 for update;
    if owner_card.id is not null then
      update public.cards set balance = balance + fee where id = owner_card.id;
      insert into public.transactions(receiver_card_id, amount, type) values (owner_card.id, fee, 'crypto_exchange');
    end if;
  else
    fee := 0;
  end if;
  insert into public.coin_holdings(coin_id, user_id, amount) values (p_coin_id, p_user_id, amount)
  on conflict (coin_id, user_id) do update set amount = public.coin_holdings.amount + excluded.amount
  returning public.coin_holdings.amount into my_amount;
  -- price rises with demand; pool receives the cash minus creator fee
  new_price := greatest(0.01, round(coin.price_usd * (1 + least(0.5, amount / greatest(coin.supply, 1))), 2));
  update public.coins set supply = supply + amount, pool_usd = pool_usd + (cost - fee), price_usd = new_price where id = p_coin_id returning * into coin;
  select * into card from public.cards where id = p_card_id;
  return jsonb_build_object('success', true, 'coin', to_jsonb(coin), 'bought', amount, 'cost', cost, 'my_amount', my_amount, 'card_balance', card.balance);
end;
$$;

create or replace function public.re_coin_sell(p_user_id uuid, p_card_id uuid, p_coin_id uuid, p_amount numeric)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  coin public.coins%rowtype; card public.cards%rowtype; hold public.coin_holdings%rowtype;
  amount numeric; proceeds numeric; new_price numeric;
begin
  amount := round(coalesce(p_amount, 0), 8);
  if amount <= 0 then raise exception using message = 'Количество должно быть положительным'; end if;
  select * into coin from public.coins where id = p_coin_id for update;
  if coin.id is null then raise exception using message = 'Монета не найдена'; end if;
  select * into hold from public.coin_holdings where coin_id = p_coin_id and user_id = p_user_id for update;
  if hold.id is null or hold.amount < amount then raise exception using message = 'Недостаточно монет для продажи'; end if;
  select * into card from public.cards where id = p_card_id and user_id = p_user_id for update;
  if card.id is null then raise exception using message = 'Карта не найдена'; end if;
  proceeds := round(amount * coin.price_usd, 2);
  if proceeds > coin.pool_usd then proceeds := coin.pool_usd; end if;
  if proceeds <= 0 then raise exception using message = 'В пуле монеты нет средств для выкупа'; end if;
  update public.coin_holdings set amount = public.coin_holdings.amount - p_amount where id = hold.id;
  update public.cards set balance = balance + proceeds where id = p_card_id;
  insert into public.transactions(receiver_card_id, amount, type) values (p_card_id, proceeds, 'crypto_exchange');
  new_price := greatest(0.01, round(coin.price_usd * (1 - least(0.5, amount / greatest(coin.supply, 1))), 2));
  update public.coins set supply = greatest(0, supply - amount), pool_usd = pool_usd - proceeds, price_usd = new_price where id = p_coin_id returning * into coin;
  select * into card from public.cards where id = p_card_id;
  return jsonb_build_object('success', true, 'coin', to_jsonb(coin), 'sold', amount, 'proceeds', proceeds, 'card_balance', card.balance);
end;
$$;

create or replace function public.re_coin_delete_own(p_user_id uuid, p_coin_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare coin public.coins%rowtype; refund_card public.cards%rowtype;
begin
  select * into coin from public.coins where id = p_coin_id for update;
  if coin.id is null then raise exception using message = 'Монета не найдена'; end if;
  if coin.owner_id <> p_user_id then raise exception using message = 'Это не ваша монета'; end if;
  if coin.pool_usd > 0 then
    select * into refund_card from public.cards where user_id = p_user_id order by created_at asc limit 1 for update;
    if refund_card.id is not null then
      update public.cards set balance = balance + coin.pool_usd where id = refund_card.id;
      insert into public.transactions(receiver_card_id, amount, type) values (refund_card.id, coin.pool_usd, 'crypto_exchange');
    end if;
  end if;
  delete from public.coins where id = p_coin_id;
  return jsonb_build_object('success', true, 'deleted', p_coin_id);
end;
$$;

create or replace function public.re_coins_list2(p_user_id uuid)
returns jsonb
language sql
security definer
set search_path = public
as $$
  select coalesce(jsonb_agg(jsonb_build_object(
    'id', c.id, 'name', c.name, 'symbol', c.symbol, 'price_usd', c.price_usd,
    'supply', c.supply, 'pool_usd', c.pool_usd, 'owner', u.username,
    'is_owner', (c.owner_id = p_user_id),
    'my_amount', coalesce((select h.amount from public.coin_holdings h where h.coin_id = c.id and h.user_id = p_user_id), 0),
    'created_at', c.created_at
  ) order by c.created_at desc), '[]'::jsonb)
  from public.coins c join public.users u on u.id = c.owner_id;
$$;

-- ----------------------------------------------------------------------------
-- Debts: pay voluntarily (no penalty).
-- ----------------------------------------------------------------------------
create or replace function public.re_pay_debt(p_user_id uuid, p_card_id uuid, p_amount numeric)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare cfg public.app_config%rowtype; u public.users%rowtype; card public.cards%rowtype; pay numeric;
begin
  select * into cfg from public.app_config where id = 1;
  select * into u from public.users where id = p_user_id for update;
  if u.debt <= 0 then raise exception using message = 'У вас нет долга'; end if;
  select * into card from public.cards where id = p_card_id and user_id = p_user_id for update;
  if card.id is null then raise exception using message = 'Карта не найдена'; end if;
  pay := round(coalesce(p_amount, 0), 2);
  if pay <= 0 then pay := u.debt; end if;
  pay := least(pay, u.debt);
  if card.balance < pay then raise exception using message = 'Недостаточно средств'; end if;
  update public.cards set balance = balance - pay where id = p_card_id;
  if coalesce(cfg.treasury_card,'') <> '' then
    update public.cards set balance = balance + pay where card_number = cfg.treasury_card;
  end if;
  update public.users set debt = debt - pay where id = p_user_id returning * into u;
  select * into card from public.cards where id = p_card_id;
  return jsonb_build_object('success', true, 'paid', pay, 'debt', u.debt, 'card_balance', card.balance);
end;
$$;

create or replace function public.re_receipt_add(p_user_id uuid, p_title text, p_amount numeric, p_kind text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare r public.receipts%rowtype;
begin
  insert into public.receipts(user_id, title, amount, kind)
  values (p_user_id, left(coalesce(p_title,'Чек'),80), round(coalesce(p_amount,0),2), left(coalesce(p_kind,'general'),30))
  returning * into r;
  return jsonb_build_object('success', true, 'receipt', to_jsonb(r));
end; $$;

create or replace function public.re_receipts_list(p_user_id uuid)
returns jsonb language sql security definer set search_path = public as $$
  select coalesce(jsonb_agg(to_jsonb(r) order by r.created_at desc), '[]'::jsonb)
  from public.receipts r where r.user_id = p_user_id;
$$;

-- ----------------------------------------------------------------------------
-- Friends + chat (polling based, no realtime needed).
-- ----------------------------------------------------------------------------
create or replace function public.re_users_search(p_user_id uuid, p_q text)
returns jsonb language sql security definer set search_path = public as $$
  select coalesce(jsonb_agg(jsonb_build_object('id', u.id, 'username', u.username) order by u.username), '[]'::jsonb)
  from public.users u
  where u.id <> p_user_id and u.username ilike '%' || btrim(coalesce(p_q,'')) || '%'
  limit 20;
$$;

create or replace function public.re_friend_request(p_user_id uuid, p_friend_id uuid)
returns jsonb language plpgsql security definer set search_path = public as $$
begin
  if p_user_id = p_friend_id then raise exception using message = 'Нельзя добавить самого себя'; end if;
  insert into public.friends(user_id, friend_id, status) values (p_user_id, p_friend_id, 'pending')
    on conflict (user_id, friend_id) do nothing;
  -- if the other side already requested, accept both
  if exists (select 1 from public.friends where user_id = p_friend_id and friend_id = p_user_id) then
    update public.friends set status = 'accepted' where (user_id = p_user_id and friend_id = p_friend_id) or (user_id = p_friend_id and friend_id = p_user_id);
  end if;
  return jsonb_build_object('success', true);
end; $$;

create or replace function public.re_friend_accept(p_user_id uuid, p_friend_id uuid)
returns jsonb language plpgsql security definer set search_path = public as $$
begin
  update public.friends set status = 'accepted' where user_id = p_friend_id and friend_id = p_user_id;
  insert into public.friends(user_id, friend_id, status) values (p_user_id, p_friend_id, 'accepted')
    on conflict (user_id, friend_id) do update set status = 'accepted';
  return jsonb_build_object('success', true);
end; $$;

create or replace function public.re_friends_list(p_user_id uuid)
returns jsonb language sql security definer set search_path = public as $$
  select jsonb_build_object(
    'friends', coalesce((select jsonb_agg(jsonb_build_object('id', u.id, 'username', u.username) order by u.username)
        from public.friends f join public.users u on u.id = f.friend_id
        where f.user_id = p_user_id and f.status = 'accepted'), '[]'::jsonb),
    'incoming', coalesce((select jsonb_agg(jsonb_build_object('id', u.id, 'username', u.username) order by u.username)
        from public.friends f join public.users u on u.id = f.user_id
        where f.friend_id = p_user_id and f.status = 'pending'
          and not exists (select 1 from public.friends g where g.user_id = p_user_id and g.friend_id = f.user_id and g.status = 'accepted')), '[]'::jsonb)
  );
$$;

create or replace function public.re_send_message(p_user_id uuid, p_to_id uuid, p_body text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare m public.messages%rowtype; b text;
begin
  b := btrim(coalesce(p_body,''));
  if b = '' then raise exception using message = 'Пустое сообщение'; end if;
  insert into public.messages(from_id, to_id, body) values (p_user_id, p_to_id, left(b,500)) returning * into m;
  return jsonb_build_object('success', true, 'message', to_jsonb(m));
end; $$;

create or replace function public.re_messages(p_user_id uuid, p_other_id uuid)
returns jsonb language sql security definer set search_path = public as $$
  select coalesce(jsonb_agg(jsonb_build_object(
    'id', m.id, 'from_id', m.from_id, 'to_id', m.to_id, 'body', m.body,
    'mine', (m.from_id = p_user_id), 'created_at', m.created_at
  ) order by m.created_at), '[]'::jsonb)
  from public.messages m
  where (m.from_id = p_user_id and m.to_id = p_other_id) or (m.from_id = p_other_id and m.to_id = p_user_id);
$$;

-- ----------------------------------------------------------------------------
-- Peer loans. Borrow >= $2, lender accepts and sends the money; the loan is
-- auto-repaid within 3 hours (see re_touch) with a $1 fee.
-- ----------------------------------------------------------------------------
create or replace function public.re_loan_request(p_user_id uuid, p_lender_id uuid, p_amount numeric, p_borrower_card uuid)
returns jsonb language plpgsql security definer set search_path = public as $$
declare amount numeric; l public.loans%rowtype;
begin
  amount := round(coalesce(p_amount,0),2);
  if amount < 2 then raise exception using message = 'Минимальный займ $2'; end if;
  if p_user_id = p_lender_id then raise exception using message = 'Нельзя занять у самого себя'; end if;
  insert into public.loans(borrower_id, lender_id, borrower_card, amount, status)
  values (p_user_id, p_lender_id, p_borrower_card, amount, 'pending') returning * into l;
  return jsonb_build_object('success', true, 'loan', to_jsonb(l));
end; $$;

create or replace function public.re_loan_accept(p_user_id uuid, p_loan_id uuid, p_lender_card uuid)
returns jsonb language plpgsql security definer set search_path = public as $$
declare l public.loans%rowtype; lcard public.cards%rowtype; bcard public.cards%rowtype;
begin
  select * into l from public.loans where id = p_loan_id for update;
  if l.id is null then raise exception using message = 'Заявка не найдена'; end if;
  if l.lender_id <> p_user_id then raise exception using message = 'Это не ваша заявка'; end if;
  if l.status <> 'pending' then raise exception using message = 'Заявка уже обработана'; end if;
  select * into lcard from public.cards where id = p_lender_card and user_id = p_user_id for update;
  if lcard.id is null then raise exception using message = 'Карта не найдена'; end if;
  if lcard.balance < l.amount then raise exception using message = 'Недостаточно средств чтобы дать займ'; end if;
  select * into bcard from public.cards where id = coalesce(l.borrower_card, (select id from public.cards where user_id = l.borrower_id order by created_at limit 1)) for update;
  if bcard.id is null then raise exception using message = 'У заёмщика нет карты'; end if;
  update public.cards set balance = balance - l.amount where id = lcard.id;
  update public.cards set balance = balance + l.amount where id = bcard.id;
  insert into public.transactions(sender_card_id, receiver_card_id, amount, type) values (lcard.id, bcard.id, l.amount, 'transfer');
  update public.loans set status = 'active', lender_card = lcard.id, borrower_card = bcard.id, due_at = now() + interval '3 hours' where id = l.id returning * into l;
  return jsonb_build_object('success', true, 'loan', to_jsonb(l));
end; $$;

create or replace function public.re_loans_list(p_user_id uuid)
returns jsonb language sql security definer set search_path = public as $$
  select jsonb_build_object(
    'incoming', coalesce((select jsonb_agg(jsonb_build_object('id', l.id, 'from', bu.username, 'amount', l.amount, 'status', l.status, 'created_at', l.created_at) order by l.created_at desc)
        from public.loans l join public.users bu on bu.id = l.borrower_id
        where l.lender_id = p_user_id and l.status = 'pending'), '[]'::jsonb),
    'mine', coalesce((select jsonb_agg(jsonb_build_object('id', l.id, 'to', lu.username, 'amount', l.amount, 'status', l.status, 'due_at', l.due_at, 'created_at', l.created_at) order by l.created_at desc)
        from public.loans l join public.users lu on lu.id = l.lender_id
        where l.borrower_id = p_user_id), '[]'::jsonb),
    'lent', coalesce((select jsonb_agg(jsonb_build_object('id', l.id, 'to', bu.username, 'amount', l.amount, 'status', l.status, 'due_at', l.due_at) order by l.created_at desc)
        from public.loans l join public.users bu on bu.id = l.borrower_id
        where l.lender_id = p_user_id and l.status <> 'pending'), '[]'::jsonb)
  );
$$;

-- ----------------------------------------------------------------------------
-- Login failure counter -> lock everything for 3 minutes after 5 wrong tries.
-- ----------------------------------------------------------------------------
create or replace function public.re_fail_login(p_user_id uuid)
returns jsonb language plpgsql security definer set search_path = public as $$
declare u public.users%rowtype;
begin
  update public.users set fail_count = fail_count + 1 where id = p_user_id returning * into u;
  if u.fail_count >= 5 then
    update public.users set lock_until = now() + interval '3 minutes', fail_count = 0 where id = p_user_id returning * into u;
  end if;
  return jsonb_build_object('success', true, 'fail_count', u.fail_count, 'lock_until', u.lock_until);
end; $$;

create or replace function public.re_reset_fail(p_user_id uuid)
returns jsonb language plpgsql security definer set search_path = public as $$
begin
  update public.users set fail_count = 0 where id = p_user_id;
  return jsonb_build_object('success', true);
end; $$;

-- ----------------------------------------------------------------------------
-- Main admin panel: verify password, edit config, block/unblock features,
-- freeze cards, delete any coin.
-- ----------------------------------------------------------------------------
create or replace function public.re_admin_verify(p_password text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare cfg public.app_config%rowtype;
begin
  select * into cfg from public.app_config where id = 1;
  if p_password = cfg.main_admin_password then
    return jsonb_build_object('success', true, 'panel', 'main');
  elsif p_password = cfg.simple_admin_password then
    return jsonb_build_object('success', true, 'panel', 'simple');
  else
    raise exception using message = 'Неверный пароль';
  end if;
end; $$;

create or replace function public.re_admin_get_config()
returns jsonb language sql security definer set search_path = public as $$
  select jsonb_build_object(
    'treasury_card', treasury_card, 'site_password_on', site_password_on,
    'tax_per_hour', tax_per_hour, 'tax_penalty', tax_penalty,
    'global_blocks', global_blocks, 'roulette_event_on', roulette_event_on
  ) from public.app_config where id = 1;
$$;

create or replace function public.re_admin_set_config(
  p_treasury text, p_site_pw text, p_site_on boolean,
  p_main_pw text, p_simple_pw text, p_tax_hour numeric, p_tax_penalty numeric)
returns jsonb language plpgsql security definer set search_path = public as $$
begin
  update public.app_config set
    treasury_card = coalesce(nullif(p_treasury, '__keep__'), treasury_card),
    site_password = coalesce(nullif(p_site_pw, '__keep__'), site_password),
    site_password_on = coalesce(p_site_on, site_password_on),
    main_admin_password = coalesce(nullif(p_main_pw, '__keep__'), main_admin_password),
    simple_admin_password = coalesce(nullif(p_simple_pw, '__keep__'), simple_admin_password),
    tax_per_hour = coalesce(p_tax_hour, tax_per_hour),
    tax_penalty = coalesce(p_tax_penalty, tax_penalty)
  where id = 1;
  return jsonb_build_object('success', true);
end; $$;

create or replace function public.re_admin_block(p_scope text, p_user_id uuid, p_feature text, p_minutes integer)
returns jsonb language plpgsql security definer set search_path = public as $$
declare val jsonb;
begin
  if coalesce(p_minutes,0) > 0 then
    val := jsonb_build_object('until', to_char((now() + make_interval(mins => p_minutes)) at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'));
  else
    val := 'true'::jsonb;
  end if;
  if p_scope = 'all' then
    update public.app_config set global_blocks = global_blocks || jsonb_build_object(p_feature, val) where id = 1;
  else
    update public.users set blocks = blocks || jsonb_build_object(p_feature, val) where id = p_user_id;
  end if;
  return jsonb_build_object('success', true);
end; $$;

create or replace function public.re_admin_unblock(p_scope text, p_user_id uuid, p_feature text)
returns jsonb language plpgsql security definer set search_path = public as $$
begin
  if p_scope = 'all' then
    update public.app_config set global_blocks = global_blocks - p_feature where id = 1;
  else
    update public.users set blocks = blocks - p_feature where id = p_user_id;
  end if;
  return jsonb_build_object('success', true);
end; $$;

create or replace function public.re_admin_freeze_card(p_card_id uuid, p_frozen boolean)
returns jsonb language plpgsql security definer set search_path = public as $$
begin
  update public.cards set frozen = coalesce(p_frozen, true) where id = p_card_id;
  return jsonb_build_object('success', true, 'card_id', p_card_id, 'frozen', coalesce(p_frozen, true));
end; $$;

create or replace function public.re_admin_coin_delete(p_coin_id uuid)
returns jsonb language plpgsql security definer set search_path = public as $$
declare coin public.coins%rowtype; refund_card public.cards%rowtype;
begin
  select * into coin from public.coins where id = p_coin_id for update;
  if coin.id is null then raise exception using message = 'Монета не найдена'; end if;
  if coin.pool_usd > 0 then
    select * into refund_card from public.cards where user_id = coin.owner_id order by created_at asc limit 1 for update;
    if refund_card.id is not null then
      update public.cards set balance = balance + coin.pool_usd where id = refund_card.id;
    end if;
  end if;
  delete from public.coins where id = p_coin_id;
  return jsonb_build_object('success', true, 'deleted', p_coin_id);
end; $$;

-- Delete ALL coins at once (coin_holdings cascade). No refunds.
create or replace function public.re_admin_coin_delete_all()
returns jsonb language plpgsql security definer set search_path = public as $$
declare n integer;
begin
  select count(*) into n from public.coins;
  delete from public.coins;
  return jsonb_build_object('success', true, 'deleted', n);
end; $$;

-- Turn the roulette event on/off (everyone wins while it is on).
create or replace function public.re_admin_set_event(p_on boolean)
returns jsonb language plpgsql security definer set search_path = public as $$
begin
  update public.app_config set roulette_event_on = coalesce(p_on, false) where id = 1;
  return jsonb_build_object('success', true, 'roulette_event_on', coalesce(p_on, false));
end; $$;

-- ============================================================================
--  Grants for all RE BANK 3.0 functions (service_role only).
-- ============================================================================
do $$
declare fn text;
begin
  foreach fn in array array[
    'public.re_touch(uuid)',
    'public.re_doubler(uuid, uuid, numeric)',
    'public.re_buy_boost(uuid, uuid, text)',
    'public.re_click2(uuid, uuid)',
    'public.re_coin_create2(uuid, uuid, text, text, numeric, numeric)',
    'public.re_coin_buy2(uuid, uuid, uuid, numeric)',
    'public.re_coin_sell(uuid, uuid, uuid, numeric)',
    'public.re_coin_delete_own(uuid, uuid)',
    'public.re_coins_list2(uuid)',
    'public.re_pay_debt(uuid, uuid, numeric)',
    'public.re_receipt_add(uuid, text, numeric, text)',
    'public.re_receipts_list(uuid)',
    'public.re_users_search(uuid, text)',
    'public.re_friend_request(uuid, uuid)',
    'public.re_friend_accept(uuid, uuid)',
    'public.re_friends_list(uuid)',
    'public.re_send_message(uuid, uuid, text)',
    'public.re_messages(uuid, uuid)',
    'public.re_loan_request(uuid, uuid, numeric, uuid)',
    'public.re_loan_accept(uuid, uuid, uuid)',
    'public.re_loans_list(uuid)',
    'public.re_fail_login(uuid)',
    'public.re_reset_fail(uuid)',
    'public.re_admin_verify(text)',
    'public.re_admin_get_config()',
    'public.re_admin_set_config(text, text, boolean, text, text, numeric, numeric)',
    'public.re_admin_block(text, uuid, text, integer)',
    'public.re_admin_unblock(text, uuid, text)',
    'public.re_admin_freeze_card(uuid, boolean)',
    'public.re_admin_coin_delete(uuid)',
    'public.re_admin_coin_delete_all()',
    'public.re_admin_set_event(boolean)'
  ]
  loop
    execute format('revoke execute on function %s from public, anon, authenticated', fn);
    execute format('grant execute on function %s to service_role', fn);
  end loop;
end $$;
