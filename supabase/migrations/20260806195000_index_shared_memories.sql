-- Shared retrieval itself is enabled in the preceding migration. This migration
-- also lets collaborators with add/edit permission persist server-generated vectors.
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

create or replace function public.set_memory_item_embedding(
  p_id uuid,
  p_embedding extensions.vector(512),
  p_fingerprint text
)
returns boolean
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  changed_id uuid;
begin
  update public.memory_items as item
  set embedding = p_embedding, embedding_fingerprint = left(p_fingerprint, 128)
  where item.id = p_id
    and (
      item.user_id = auth.uid()
      or exists (
        select 1 from public.space_members as membership
        where membership.owner_user_id = item.user_id
          and membership.space_name = item.space
          and membership.member_user_id = auth.uid()
          and (membership.can_add or membership.can_edit)
      )
    )
  returning item.id into changed_id;
  return changed_id is not null;
end;
$$;

revoke all on function public.match_memory_items(extensions.vector, integer, double precision) from public;
grant execute on function public.match_memory_items(extensions.vector, integer, double precision) to authenticated;
revoke all on function public.set_memory_item_embedding(uuid, extensions.vector, text) from public;
grant execute on function public.set_memory_item_embedding(uuid, extensions.vector, text) to authenticated;
