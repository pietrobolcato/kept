drop policy if exists "Owners and permitted collaborators can update Kept images" on storage.objects;
drop policy if exists "Owners and permitted collaborators can delete Kept images" on storage.objects;

create policy "Owners and permitted collaborators can update Kept images"
  on storage.objects for update to authenticated
  using (
    bucket_id = 'kept-images'
    and (
      owner_id = (select auth.uid()::text)
      or exists (
        select 1 from public.memory_items
        where memory_items.storage_path = storage.objects.name
          and memory_items.user_id = (select auth.uid())
      )
      or exists (
        select 1
        from public.memory_items
        join public.space_members
          on space_members.owner_user_id = memory_items.user_id
          and space_members.space_name = memory_items.space
        where memory_items.storage_path = storage.objects.name
          and space_members.member_user_id = (select auth.uid())
          and space_members.can_edit
      )
    )
  )
  with check (bucket_id = 'kept-images');

create policy "Owners and permitted collaborators can delete Kept images"
  on storage.objects for delete to authenticated
  using (
    bucket_id = 'kept-images'
    and (
      owner_id = (select auth.uid()::text)
      or exists (
        select 1 from public.memory_items
        where memory_items.storage_path = storage.objects.name
          and memory_items.user_id = (select auth.uid())
      )
      or exists (
        select 1
        from public.memory_items
        join public.space_members
          on space_members.owner_user_id = memory_items.user_id
          and space_members.space_name = memory_items.space
        where memory_items.storage_path = storage.objects.name
          and space_members.member_user_id = (select auth.uid())
          and space_members.can_delete
      )
    )
  );
