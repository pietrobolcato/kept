alter table public.memory_items
  drop constraint if exists memory_items_kind_check;

alter table public.memory_items
  add constraint memory_items_kind_check check (kind in ('image', 'video', 'link', 'note')),
  add column if not exists video_storage_path text,
  add column if not exists video_mime_type text;

update storage.buckets
set file_size_limit = 209715200,
  allowed_mime_types = array['image/jpeg', 'image/png', 'image/gif', 'image/webp', 'video/mp4', 'video/quicktime', 'video/webm']
where id = 'kept-images';

comment on column public.memory_items.storage_path is 'Private image or video-poster storage object.';
comment on column public.memory_items.video_storage_path is 'Private playable video storage object.';

drop policy if exists "Owners and collaborators can read Kept images" on storage.objects;
drop policy if exists "Owners and permitted collaborators can upload Kept images" on storage.objects;
drop policy if exists "Owners and permitted collaborators can update Kept images" on storage.objects;
drop policy if exists "Owners and permitted collaborators can delete Kept images" on storage.objects;

create policy "Owners and collaborators can read Kept images" on storage.objects for select to authenticated using (
  bucket_id = 'kept-images' and (
    (storage.foldername(name))[1] = (select auth.uid()::text)
    or exists (select 1 from public.memory_items where storage_path = storage.objects.name or video_storage_path = storage.objects.name)
  )
);
create policy "Owners and permitted collaborators can upload Kept images" on storage.objects for insert to authenticated with check (
  bucket_id = 'kept-images' and (
    (storage.foldername(name))[1] = (select auth.uid()::text)
    or exists (select 1 from public.library_members where owner_user_id::text = (storage.foldername(name))[1] and member_user_id = (select auth.uid()) and can_add)
    or exists (select 1 from public.space_members where owner_user_id::text = (storage.foldername(name))[1] and member_user_id = (select auth.uid()) and can_add)
  )
);
create policy "Owners and permitted collaborators can update Kept images" on storage.objects for update to authenticated using (
  bucket_id = 'kept-images' and (
    owner_id = (select auth.uid()::text)
    or exists (select 1 from public.memory_items where (storage_path = storage.objects.name or video_storage_path = storage.objects.name) and user_id = (select auth.uid()))
    or exists (select 1 from public.memory_items join public.library_members on owner_user_id = memory_items.user_id where (storage_path = storage.objects.name or video_storage_path = storage.objects.name) and member_user_id = (select auth.uid()) and can_edit)
    or exists (select 1 from public.memory_items join public.space_members on owner_user_id = memory_items.user_id and space_name = memory_items.space where (storage_path = storage.objects.name or video_storage_path = storage.objects.name) and member_user_id = (select auth.uid()) and can_edit)
  )
) with check (bucket_id = 'kept-images');
create policy "Owners and permitted collaborators can delete Kept images" on storage.objects for delete to authenticated using (
  bucket_id = 'kept-images' and (
    owner_id = (select auth.uid()::text)
    or exists (select 1 from public.memory_items where (storage_path = storage.objects.name or video_storage_path = storage.objects.name) and user_id = (select auth.uid()))
    or exists (select 1 from public.memory_items join public.library_members on owner_user_id = memory_items.user_id where (storage_path = storage.objects.name or video_storage_path = storage.objects.name) and member_user_id = (select auth.uid()) and can_delete)
    or exists (select 1 from public.memory_items join public.space_members on owner_user_id = memory_items.user_id and space_name = memory_items.space where (storage_path = storage.objects.name or video_storage_path = storage.objects.name) and member_user_id = (select auth.uid()) and can_delete)
  )
);
