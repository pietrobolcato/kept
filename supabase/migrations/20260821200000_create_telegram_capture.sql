create table public.telegram_pairing_codes (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  code_hash text not null unique check (char_length(code_hash) = 64),
  expires_at timestamptz not null,
  used_at timestamptz,
  created_at timestamptz not null default now()
);

create table public.telegram_connections (
  user_id uuid primary key references auth.users (id) on delete cascade,
  telegram_user_id bigint not null unique,
  chat_id bigint not null unique,
  username text,
  first_name text,
  created_at timestamptz not null default now(),
  last_used_at timestamptz not null default now()
);

create table public.telegram_updates (
  update_id bigint primary key,
  received_at timestamptz not null default now(),
  processed_at timestamptz
);

create index telegram_pairing_user_idx on public.telegram_pairing_codes (user_id, created_at desc);
create index telegram_connections_chat_idx on public.telegram_connections (chat_id);

alter table public.telegram_pairing_codes enable row level security;
alter table public.telegram_connections enable row level security;
alter table public.telegram_updates enable row level security;

create policy "Users can view their Telegram pairing codes"
  on public.telegram_pairing_codes for select to authenticated
  using (user_id = (select auth.uid()));

create policy "Users can create their Telegram pairing codes"
  on public.telegram_pairing_codes for insert to authenticated
  with check (user_id = (select auth.uid()));

create policy "Users can delete their Telegram pairing codes"
  on public.telegram_pairing_codes for delete to authenticated
  using (user_id = (select auth.uid()));

create policy "Users can view their Telegram connection"
  on public.telegram_connections for select to authenticated
  using (user_id = (select auth.uid()));

create policy "Users can disconnect their Telegram account"
  on public.telegram_connections for delete to authenticated
  using (user_id = (select auth.uid()));

comment on table public.telegram_pairing_codes is 'Short-lived, one-use Telegram account pairing secrets stored only as SHA-256 hashes.';
comment on table public.telegram_connections is 'Private Telegram chats paired to Kept users for low-friction capture.';
comment on table public.telegram_updates is 'Telegram webhook update IDs retained for idempotent capture.';
