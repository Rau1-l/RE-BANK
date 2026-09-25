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

  update public.cards set balance = balance + 1.00 where id = p_card_id returning * into card;
  insert into public.transactions(sender_card_id, receiver_card_id, amount, type)
  values (null, p_card_id, 1.00, 'click');

  return jsonb_build_object('success', true, 'card_id', p_card_id, 'new_balance', card.balance);
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

create or replace function public.re_roulette(p_user_id uuid, p_card_id uuid, p_winning_slot integer)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  card public.cards%rowtype;
  win_amount numeric := 0;
begin
  if p_winning_slot < 1 or p_winning_slot > 100 then raise exception using message = 'Invalid roulette slot'; end if;
  select * into card from public.cards where id = p_card_id and user_id = p_user_id for update;
  if card.id is null then raise exception using message = 'Card not found'; end if;
  if card.balance < 1 then raise exception using message = 'Insufficient funds for roulette spin'; end if;
  update public.cards set balance = balance - 1.00 where id = p_card_id;
  insert into public.transactions(sender_card_id, amount, type) values (p_card_id, 1.00, 'roulette_spin');
  if p_winning_slot = 77 then
    win_amount := 100000.00;
    update public.cards set balance = balance + win_amount where id = p_card_id;
    insert into public.transactions(receiver_card_id, amount, type) values (p_card_id, win_amount, 'roulette_win');
  end if;
  select * into card from public.cards where id = p_card_id;
  return jsonb_build_object('success', p_winning_slot = 77, 'winning_slot', p_winning_slot, 'lucky_slot', 77, 'new_balance', card.balance, 'win_amount', win_amount);
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
revoke execute on function public.re_roulette(uuid, uuid, integer) from public, anon, authenticated;
revoke execute on function public.re_dashboard(uuid) from public, anon, authenticated;

grant execute on function public.re_create_card(uuid, text, text, text, text) to service_role;
grant execute on function public.re_click(uuid, uuid) to service_role;
grant execute on function public.re_transfer(uuid, uuid, text, numeric) to service_role;
grant execute on function public.re_crypto_earn(uuid) to service_role;
grant execute on function public.re_crypto_sell(uuid, uuid, numeric, numeric) to service_role;
grant execute on function public.re_select_rating_card(uuid, uuid) to service_role;
grant execute on function public.re_rating() to service_role;
grant execute on function public.re_roulette(uuid, uuid, integer) to service_role;
grant execute on function public.re_dashboard(uuid) to service_role;
