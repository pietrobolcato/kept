create table public.library_members (
  owner_user_id uuid not null references auth.users (id) on delete cascade,
  member_user_id uuid not null references auth.users (id) on delete cascade,
  member_label text not null default 'Collaborator' check (char_length(member_label) between 1 and 320),
  can_add boolean not null default false,
  can_edit boolean not null default false,
  can_delete boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (owner_user_id, member_user_id),
  check (owner_user_id <> member_user_id)
);

create table public.library_invitations (
  id uuid primary key default gen_random_uuid(),
  owner_user_id uuid not null references auth.users (id) on delete cascade,
  token_hash text not null unique check (char_length(token_hash) = 64),
  can_add boolean not null default false,
  can_edit boolean not null default false,
  can_delete boolean not null default false,
  expires_at timestamptz not null default (now() + interval '7 days'),
  revoked_at timestamptz,
  accepted_by uuid references auth.users (id) on delete set null,
  accepted_at timestamptz,
  created_at timestamptz not null default now()
);

create index library_members_member_idx on public.library_members (member_user_id, created_at desc);
create index library_invitations_owner_idx on public.library_invitations (owner_user_id, created_at desc);

alter table public.library_members enable row level security;
alter table public.library_invitations enable row level security;

create policy "Owners and members can view library membership" on public.library_members for select to authenticated
  using (owner_user_id = (select auth.uid()) or member_user_id = (select auth.uid()));
create policy "Owners can update library membership" on public.library_members for update to authenticated
  using (owner_user_id = (select auth.uid())) with check (owner_user_id = (select auth.uid()));
create policy "Owners and members can remove library membership" on public.library_members for delete to authenticated
  using (owner_user_id = (select auth.uid()) or member_user_id = (select auth.uid()));

create policy "Owners can view library invitations" on public.library_invitations for select to authenticated
  using (owner_user_id = (select auth.uid()));
create policy "Owners can create library invitations" on public.library_invitations for insert to authenticated
  with check (owner_user_id = (select auth.uid()));
create policy "Owners can revoke library invitations" on public.library_invitations for update to authenticated
  using (owner_user_id = (select auth.uid())) with check (owner_user_id = (select auth.uid()));
create policy "Owners can delete library invitations" on public.library_invitations for delete to authenticated
  using (owner_user_id = (select auth.uid()));

drop policy if exists "Collaborators can view shared spaces" on public.spaces;
create policy "Collaborators can view shared spaces" on public.spaces for select to authenticated
  using (
    user_id = (select auth.uid())
    or exists (select 1 from public.library_members where owner_user_id = spaces.user_id and member_user_id = (select auth.uid()))
    or exists (select 1 from public.space_members where owner_user_id = spaces.user_id and space_name = spaces.name and member_user_id = (select auth.uid()))
  );

drop policy if exists "Owners and collaborators can read memories" on public.memory_items;
drop policy if exists "Owners and permitted collaborators can create memories" on public.memory_items;
drop policy if exists "Owners and permitted collaborators can edit memories" on public.memory_items;
drop policy if exists "Owners and permitted collaborators can delete memories" on public.memory_items;

create policy "Owners and collaborators can read memories" on public.memory_items for select to authenticated using (
  user_id = (select auth.uid())
  or exists (select 1 from public.library_members where owner_user_id = memory_items.user_id and member_user_id = (select auth.uid()))
  or exists (select 1 from public.space_members where owner_user_id = memory_items.user_id and space_name = memory_items.space and member_user_id = (select auth.uid()))
);
create policy "Owners and permitted collaborators can create memories" on public.memory_items for insert to authenticated with check (
  user_id = (select auth.uid())
  or exists (select 1 from public.library_members where owner_user_id = memory_items.user_id and member_user_id = (select auth.uid()) and can_add)
  or exists (select 1 from public.space_members where owner_user_id = memory_items.user_id and space_name = memory_items.space and member_user_id = (select auth.uid()) and can_add)
);
create policy "Owners and permitted collaborators can edit memories" on public.memory_items for update to authenticated using (
  user_id = (select auth.uid())
  or exists (select 1 from public.library_members where owner_user_id = memory_items.user_id and member_user_id = (select auth.uid()) and can_edit)
  or exists (select 1 from public.space_members where owner_user_id = memory_items.user_id and space_name = memory_items.space and member_user_id = (select auth.uid()) and can_edit)
) with check (
  user_id = (select auth.uid())
  or exists (select 1 from public.library_members where owner_user_id = memory_items.user_id and member_user_id = (select auth.uid()) and can_edit)
  or exists (select 1 from public.space_members where owner_user_id = memory_items.user_id and space_name = memory_items.space and member_user_id = (select auth.uid()) and can_edit)
);
create policy "Owners and permitted collaborators can delete memories" on public.memory_items for delete to authenticated using (
  user_id = (select auth.uid())
  or exists (select 1 from public.library_members where owner_user_id = memory_items.user_id and member_user_id = (select auth.uid()) and can_delete)
  or exists (select 1 from public.space_members where owner_user_id = memory_items.user_id and space_name = memory_items.space and member_user_id = (select auth.uid()) and can_delete)
);

drop policy if exists "Owners and collaborators can read Kept images" on storage.objects;
drop policy if exists "Owners and permitted collaborators can upload Kept images" on storage.objects;
drop policy if exists "Owners and permitted collaborators can update Kept images" on storage.objects;
drop policy if exists "Owners and permitted collaborators can delete Kept images" on storage.objects;

create policy "Owners and collaborators can read Kept images" on storage.objects for select to authenticated using (
  bucket_id = 'kept-images' and (
    (storage.foldername(name))[1] = (select auth.uid()::text)
    or exists (select 1 from public.memory_items where storage_path = storage.objects.name)
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
    or exists (select 1 from public.memory_items where storage_path = storage.objects.name and user_id = (select auth.uid()))
    or exists (select 1 from public.memory_items join public.library_members on owner_user_id = memory_items.user_id where storage_path = storage.objects.name and member_user_id = (select auth.uid()) and can_edit)
    or exists (select 1 from public.memory_items join public.space_members on owner_user_id = memory_items.user_id and space_name = memory_items.space where storage_path = storage.objects.name and member_user_id = (select auth.uid()) and can_edit)
  )
) with check (bucket_id = 'kept-images');
create policy "Owners and permitted collaborators can delete Kept images" on storage.objects for delete to authenticated using (
  bucket_id = 'kept-images' and (
    owner_id = (select auth.uid()::text)
    or exists (select 1 from public.memory_items where storage_path = storage.objects.name and user_id = (select auth.uid()))
    or exists (select 1 from public.memory_items join public.library_members on owner_user_id = memory_items.user_id where storage_path = storage.objects.name and member_user_id = (select auth.uid()) and can_delete)
    or exists (select 1 from public.memory_items join public.space_members on owner_user_id = memory_items.user_id and space_name = memory_items.space where storage_path = storage.objects.name and member_user_id = (select auth.uid()) and can_delete)
  )
);

create or replace function public.preview_library_invitation(p_token text)
returns table (invitation_id uuid, can_add boolean, can_edit boolean, can_delete boolean, expires_at timestamptz)
language sql stable security definer set search_path = '' as $$
  select id, can_add, can_edit, can_delete, expires_at from public.library_invitations
  where token_hash = encode(extensions.digest(convert_to(p_token, 'UTF8'), 'sha256'), 'hex')
    and revoked_at is null and accepted_at is null and expires_at > now() limit 1;
$$;

create or replace function public.accept_library_invitation(p_token text)
returns table (owner_user_id uuid, can_add boolean, can_edit boolean, can_delete boolean)
language plpgsql volatile security definer set search_path = '' as $$
declare
  invitation public.library_invitations%rowtype;
  accepting_user_id uuid := auth.uid();
  accepting_label text;
begin
  if accepting_user_id is null then raise exception 'Sign in before accepting this invitation.'; end if;
  select row.* into invitation from public.library_invitations as row
    where row.token_hash = encode(extensions.digest(convert_to(p_token, 'UTF8'), 'sha256'), 'hex')
      and row.revoked_at is null and row.accepted_at is null and row.expires_at > now() for update;
  if invitation.id is null then raise exception 'This invitation is invalid, expired, or has already been used.'; end if;
  if invitation.owner_user_id = accepting_user_id then raise exception 'You already own this library.'; end if;
  select coalesce(nullif(email, ''), 'Collaborator') into accepting_label from auth.users where id = accepting_user_id;
  insert into public.library_members (owner_user_id, member_user_id, member_label, can_add, can_edit, can_delete)
  values (invitation.owner_user_id, accepting_user_id, accepting_label, invitation.can_add, invitation.can_edit, invitation.can_delete)
  on conflict (owner_user_id, member_user_id) do update set member_label = excluded.member_label,
    can_add = excluded.can_add, can_edit = excluded.can_edit, can_delete = excluded.can_delete, updated_at = now();
  update public.library_invitations set accepted_by = accepting_user_id, accepted_at = now() where id = invitation.id;
  return query select invitation.owner_user_id, invitation.can_add, invitation.can_edit, invitation.can_delete;
end;
$$;

revoke all on function public.preview_library_invitation(text) from public;
revoke all on function public.accept_library_invitation(text) from public;
grant execute on function public.preview_library_invitation(text) to authenticated;
grant execute on function public.accept_library_invitation(text) to authenticated;

create or replace function public.set_memory_item_embedding(
  p_id uuid,
  p_embedding extensions.vector(512),
  p_fingerprint text
)
returns boolean language plpgsql volatile security definer set search_path = '' as $$
declare changed_id uuid;
begin
  update public.memory_items as item
  set embedding = p_embedding, embedding_fingerprint = left(p_fingerprint, 128)
  where item.id = p_id and (
    item.user_id = auth.uid()
    or exists (select 1 from public.library_members where owner_user_id = item.user_id and member_user_id = auth.uid() and (can_add or can_edit))
    or exists (select 1 from public.space_members where owner_user_id = item.user_id and space_name = item.space and member_user_id = auth.uid() and (can_add or can_edit))
  ) returning item.id into changed_id;
  return changed_id is not null;
end;
$$;

revoke all on function public.set_memory_item_embedding(uuid, extensions.vector, text) from public;
grant execute on function public.set_memory_item_embedding(uuid, extensions.vector, text) to authenticated;
