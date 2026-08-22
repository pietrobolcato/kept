create table if not exists public.user_taste_profiles (
  user_id uuid primary key default auth.uid() references auth.users (id) on delete cascade,
  profile jsonb not null default '{}'::jsonb check (jsonb_typeof(profile) = 'object'),
  source_fingerprint text not null check (source_fingerprint ~ '^[0-9a-f]{64}$'),
  source_item_count integer not null default 0 check (source_item_count >= 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on table public.user_taste_profiles is 'A compact, durable taste summary derived from a user’s personal Kept library and recalled by the assistant.';

alter table public.user_taste_profiles enable row level security;

create policy "Users can read their own taste profile"
  on public.user_taste_profiles for select to authenticated
  using ((select auth.uid()) = user_id);

create policy "Users can create their own taste profile"
  on public.user_taste_profiles for insert to authenticated
  with check ((select auth.uid()) = user_id);

create policy "Users can update their own taste profile"
  on public.user_taste_profiles for update to authenticated
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);

create policy "Users can delete their own taste profile"
  on public.user_taste_profiles for delete to authenticated
  using ((select auth.uid()) = user_id);
