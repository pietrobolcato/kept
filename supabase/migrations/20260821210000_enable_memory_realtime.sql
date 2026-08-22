do $$
begin
  if not exists (
    select 1
    from pg_publication_tables
    where pubname = 'supabase_realtime'
      and schemaname = 'public'
      and tablename = 'memory_items'
  ) then
    alter publication supabase_realtime add table public.memory_items;
  end if;
end
$$;

comment on table public.memory_items is 'Per-user and permissioned shared memories. Changes are published to Supabase Realtime for live library refresh.';
