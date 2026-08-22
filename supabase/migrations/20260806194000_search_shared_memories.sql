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
  where memory_items.embedding is not null
    and 1 - (memory_items.embedding OPERATOR(extensions.<=>) query_embedding) >= match_threshold
  order by memory_items.embedding OPERATOR(extensions.<=>) query_embedding
  limit least(greatest(match_count, 1), 100);
$$;
