create table public.apple_shortcut_pairing_codes (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  code_hash text not null unique check (char_length(code_hash) = 64),
  expires_at timestamptz not null,
  used_at timestamptz,
  created_at timestamptz not null default now()
);

create table public.apple_shortcut_connections (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  token_hash text not null unique check (char_length(token_hash) = 64),
  device_name text not null default 'Apple device' check (char_length(device_name) between 1 and 120),
  created_at timestamptz not null default now(),
  last_used_at timestamptz
);

create index apple_shortcut_pairing_user_idx
  on public.apple_shortcut_pairing_codes (user_id, created_at desc);
create index apple_shortcut_connections_user_idx
  on public.apple_shortcut_connections (user_id, created_at desc);

alter table public.apple_shortcut_pairing_codes enable row level security;
alter table public.apple_shortcut_connections enable row level security;

create policy "Users can view their Shortcut pairing codes"
  on public.apple_shortcut_pairing_codes for select to authenticated
  using (user_id = (select auth.uid()));
create policy "Users can create their Shortcut pairing codes"
  on public.apple_shortcut_pairing_codes for insert to authenticated
  with check (user_id = (select auth.uid()));
create policy "Users can delete their Shortcut pairing codes"
  on public.apple_shortcut_pairing_codes for delete to authenticated
  using (user_id = (select auth.uid()));

create policy "Users can view their Shortcut connections"
  on public.apple_shortcut_connections for select to authenticated
  using (user_id = (select auth.uid()));
create policy "Users can rename their Shortcut connections"
  on public.apple_shortcut_connections for update to authenticated
  using (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid()));
create policy "Users can revoke their Shortcut connections"
  on public.apple_shortcut_connections for delete to authenticated
  using (user_id = (select auth.uid()));

comment on table public.apple_shortcut_pairing_codes is
  'Short-lived, one-use pairing secrets for the public Keep in Kept Apple Shortcut. Only SHA-256 hashes are stored.';
comment on table public.apple_shortcut_connections is
  'Revocable Apple Shortcut capture credentials. Only SHA-256 token hashes are stored.';
