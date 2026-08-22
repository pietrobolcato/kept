alter table public.telegram_connections
  add column if not exists default_owner_user_id uuid references auth.users (id) on delete set null;

drop policy if exists "Users can update their Telegram connection" on public.telegram_connections;
create policy "Users can update their Telegram connection"
  on public.telegram_connections for update to authenticated
  using (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid()));

comment on column public.telegram_connections.default_owner_user_id is
  'Optional shared-library owner used as the default destination for Telegram captures; null means the connected user personal library.';
