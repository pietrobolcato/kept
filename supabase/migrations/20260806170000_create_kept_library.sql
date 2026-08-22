create extension if not exists vector with schema extensions;

create table public.memory_items (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  title text not null check (char_length(title) between 1 and 160),
  description text not null default '' check (char_length(description) <= 4000),
  kind text not null check (kind in ('image', 'link', 'note')),
  image_url text,
  storage_path text,
  source_url text,
  domain text,
  space text not null default 'Inbox' check (char_length(space) between 1 and 80),
  tags text[] not null default '{}',
  palette text[] not null default '{}',
  favourite boolean not null default false,
  source text not null check (source in ('Browser', 'Upload', 'Quick note')),
  ai_confidence real not null default 0 check (ai_confidence between 0 and 1),
  search_terms text[] not null default '{}',
  embedding extensions.vector(512),
  embedding_fingerprint text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on table public.memory_items is 'Private, AI-organised memories owned by one authenticated user.';
comment on column public.memory_items.image_url is 'Remote preview URL. Private uploads use storage_path instead.';

create index memory_items_user_created_idx on public.memory_items (user_id, created_at desc);
create index memory_items_user_space_idx on public.memory_items (user_id, space);
create index memory_items_embedding_hnsw_idx on public.memory_items
  using hnsw (embedding extensions.vector_cosine_ops);

alter table public.memory_items enable row level security;

create policy "Users can read their own memories"
  on public.memory_items for select to authenticated
  using ((select auth.uid()) = user_id);

create policy "Users can create their own memories"
  on public.memory_items for insert to authenticated
  with check ((select auth.uid()) = user_id);

create policy "Users can update their own memories"
  on public.memory_items for update to authenticated
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);

create policy "Users can delete their own memories"
  on public.memory_items for delete to authenticated
  using ((select auth.uid()) = user_id);

create or replace function public.set_memory_item_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create trigger set_memory_item_updated_at
before update on public.memory_items
for each row execute function public.set_memory_item_updated_at();

create or replace function public.match_memory_items(
  query_embedding extensions.vector(512),
  match_count integer default 50,
  match_threshold double precision default 0
)
returns table (id uuid, similarity double precision)
language sql
stable
security invoker
set search_path = ''
as $$
  select memory_items.id, 1 - (memory_items.embedding OPERATOR(extensions.<=>) query_embedding) as similarity
  from public.memory_items
  where memory_items.user_id = (select auth.uid())
    and memory_items.embedding is not null
    and 1 - (memory_items.embedding OPERATOR(extensions.<=>) query_embedding) >= match_threshold
  order by memory_items.embedding OPERATOR(extensions.<=>) query_embedding
  limit least(greatest(match_count, 1), 100);
$$;

revoke all on function public.match_memory_items(extensions.vector, integer, double precision) from public;
grant execute on function public.match_memory_items(extensions.vector, integer, double precision) to authenticated;

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'kept-images',
  'kept-images',
  false,
  12582912,
  array['image/jpeg', 'image/png', 'image/gif', 'image/webp']
)
on conflict (id) do update set
  public = excluded.public,
  file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;

create policy "Users can read their own Kept images"
  on storage.objects for select to authenticated
  using (
    bucket_id = 'kept-images'
    and (storage.foldername(name))[1] = (select auth.uid()::text)
  );

create policy "Users can upload their own Kept images"
  on storage.objects for insert to authenticated
  with check (
    bucket_id = 'kept-images'
    and (storage.foldername(name))[1] = (select auth.uid()::text)
  );

create policy "Users can update their own Kept images"
  on storage.objects for update to authenticated
  using (
    bucket_id = 'kept-images'
    and owner_id = (select auth.uid()::text)
  )
  with check (
    bucket_id = 'kept-images'
    and (storage.foldername(name))[1] = (select auth.uid()::text)
  );

create policy "Users can delete their own Kept images"
  on storage.objects for delete to authenticated
  using (
    bucket_id = 'kept-images'
    and owner_id = (select auth.uid()::text)
  );
