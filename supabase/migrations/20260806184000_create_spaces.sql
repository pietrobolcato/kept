create table public.spaces (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  name text not null check (char_length(name) between 1 and 80),
  color text not null default '#d6ef65' check (color ~ '^#[0-9A-Fa-f]{6}$'),
  position integer not null default 0 check (position >= 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (user_id, name),
  unique (id, user_id)
);

create index spaces_user_position_idx on public.spaces (user_id, position, created_at);

alter table public.spaces enable row level security;

create policy "Users can read their own spaces"
  on public.spaces for select to authenticated
  using ((select auth.uid()) = user_id);

create policy "Users can create their own spaces"
  on public.spaces for insert to authenticated
  with check ((select auth.uid()) = user_id);

create policy "Users can update their own spaces"
  on public.spaces for update to authenticated
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);

create policy "Users can delete their own spaces"
  on public.spaces for delete to authenticated
  using ((select auth.uid()) = user_id);

create trigger set_space_updated_at
before update on public.spaces
for each row execute function public.set_memory_item_updated_at();

create or replace function public.create_default_spaces_for_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.spaces (user_id, name, color, position)
  values
    (new.id, 'Home ideas', '#d4e567', 0),
    (new.id, 'Design references', '#cdb8ee', 1),
    (new.id, 'Reading list', '#ff8c77', 2),
    (new.id, 'Travel', '#72c5c9', 3),
    (new.id, 'Objects', '#e0b275', 4),
    (new.id, 'Inbox', '#b9b8b0', 5)
  on conflict (user_id, name) do nothing;
  return new;
end;
$$;

create trigger create_default_spaces_after_signup
after insert on auth.users
for each row execute function public.create_default_spaces_for_user();

insert into public.spaces (user_id, name, color, position)
select users.id, defaults.name, defaults.color, defaults.position
from auth.users as users
cross join (values
  ('Home ideas', '#d4e567', 0),
  ('Design references', '#cdb8ee', 1),
  ('Reading list', '#ff8c77', 2),
  ('Travel', '#72c5c9', 3),
  ('Objects', '#e0b275', 4),
  ('Inbox', '#b9b8b0', 5)
) as defaults(name, color, position)
on conflict (user_id, name) do nothing;

insert into public.spaces (user_id, name, color, position)
select distinct items.user_id, items.space, '#b9b8b0', 100
from public.memory_items as items
on conflict (user_id, name) do nothing;
