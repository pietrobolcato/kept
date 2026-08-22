create extension if not exists pgcrypto with schema extensions;

create table public.space_members (
  owner_user_id uuid not null,
  space_name text not null,
  member_user_id uuid not null references auth.users (id) on delete cascade,
  member_label text not null default 'Collaborator' check (char_length(member_label) between 1 and 320),
  can_add boolean not null default false,
  can_edit boolean not null default false,
  can_delete boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (owner_user_id, space_name, member_user_id),
  foreign key (owner_user_id, space_name)
    references public.spaces (user_id, name) on update cascade on delete cascade,
  check (owner_user_id <> member_user_id)
);

create table public.space_invitations (
  id uuid primary key default gen_random_uuid(),
  owner_user_id uuid not null,
  space_name text not null,
  token_hash text not null unique check (char_length(token_hash) = 64),
  can_add boolean not null default false,
  can_edit boolean not null default false,
  can_delete boolean not null default false,
  expires_at timestamptz not null default (now() + interval '7 days'),
  revoked_at timestamptz,
  accepted_by uuid references auth.users (id) on delete set null,
  accepted_at timestamptz,
  created_at timestamptz not null default now(),
  foreign key (owner_user_id, space_name)
    references public.spaces (user_id, name) on update cascade on delete cascade
);

comment on table public.space_members is 'Accepted collaborators and their granular permissions for a personal space.';
comment on table public.space_invitations is 'Revocable, expiring link invitations. Only a SHA-256 token digest is stored.';

create index space_members_member_idx on public.space_members (member_user_id, created_at desc);
create index space_invitations_owner_idx on public.space_invitations (owner_user_id, space_name, created_at desc);

alter table public.space_members enable row level security;
alter table public.space_invitations enable row level security;

create policy "Owners and members can view space membership"
  on public.space_members for select to authenticated
  using (
    owner_user_id = (select auth.uid())
    or member_user_id = (select auth.uid())
  );

create policy "Owners can update space membership"
  on public.space_members for update to authenticated
  using (owner_user_id = (select auth.uid()))
  with check (owner_user_id = (select auth.uid()));

create policy "Owners and members can remove membership"
  on public.space_members for delete to authenticated
  using (
    owner_user_id = (select auth.uid())
    or member_user_id = (select auth.uid())
  );

create policy "Owners can view space invitations"
  on public.space_invitations for select to authenticated
  using (owner_user_id = (select auth.uid()));

create policy "Owners can create space invitations"
  on public.space_invitations for insert to authenticated
  with check (owner_user_id = (select auth.uid()));

create policy "Owners can revoke space invitations"
  on public.space_invitations for update to authenticated
  using (owner_user_id = (select auth.uid()))
  with check (owner_user_id = (select auth.uid()));

create policy "Owners can delete space invitations"
  on public.space_invitations for delete to authenticated
  using (owner_user_id = (select auth.uid()));

-- Collaborators need to see the space in navigation after accepting a link.
create policy "Collaborators can view shared spaces"
  on public.spaces for select to authenticated
  using (
    user_id = (select auth.uid())
    or exists (
      select 1 from public.space_members
      where space_members.owner_user_id = spaces.user_id
        and space_members.space_name = spaces.name
        and space_members.member_user_id = (select auth.uid())
    )
  );

-- Replace private-only item policies with ownership plus explicit collaboration.
drop policy if exists "Users can read their own memories" on public.memory_items;
drop policy if exists "Users can create their own memories" on public.memory_items;
drop policy if exists "Users can update their own memories" on public.memory_items;
drop policy if exists "Users can delete their own memories" on public.memory_items;

create policy "Owners and collaborators can read memories"
  on public.memory_items for select to authenticated
  using (
    user_id = (select auth.uid())
    or exists (
      select 1 from public.space_members
      where space_members.owner_user_id = memory_items.user_id
        and space_members.space_name = memory_items.space
        and space_members.member_user_id = (select auth.uid())
    )
  );

create policy "Owners and permitted collaborators can create memories"
  on public.memory_items for insert to authenticated
  with check (
    user_id = (select auth.uid())
    or exists (
      select 1 from public.space_members
      where space_members.owner_user_id = memory_items.user_id
        and space_members.space_name = memory_items.space
        and space_members.member_user_id = (select auth.uid())
        and space_members.can_add
    )
  );

create policy "Owners and permitted collaborators can edit memories"
  on public.memory_items for update to authenticated
  using (
    user_id = (select auth.uid())
    or exists (
      select 1 from public.space_members
      where space_members.owner_user_id = memory_items.user_id
        and space_members.space_name = memory_items.space
        and space_members.member_user_id = (select auth.uid())
        and space_members.can_edit
    )
  )
  with check (
    user_id = (select auth.uid())
    or exists (
      select 1 from public.space_members
      where space_members.owner_user_id = memory_items.user_id
        and space_members.space_name = memory_items.space
        and space_members.member_user_id = (select auth.uid())
        and space_members.can_edit
    )
  );

create policy "Owners and permitted collaborators can delete memories"
  on public.memory_items for delete to authenticated
  using (
    user_id = (select auth.uid())
    or exists (
      select 1 from public.space_members
      where space_members.owner_user_id = memory_items.user_id
        and space_members.space_name = memory_items.space
        and space_members.member_user_id = (select auth.uid())
        and space_members.can_delete
    )
  );

-- Signed URLs still go through Storage RLS. Permit reads for any accessible memory,
-- and permit editors to upload into or remove from the owner's folder.
drop policy if exists "Users can read their own Kept images" on storage.objects;
drop policy if exists "Users can upload their own Kept images" on storage.objects;
drop policy if exists "Users can update their own Kept images" on storage.objects;
drop policy if exists "Users can delete their own Kept images" on storage.objects;

create policy "Owners and collaborators can read Kept images"
  on storage.objects for select to authenticated
  using (
    bucket_id = 'kept-images'
    and (
      (storage.foldername(name))[1] = (select auth.uid()::text)
      or exists (
        select 1 from public.memory_items
        where memory_items.storage_path = storage.objects.name
      )
    )
  );

create policy "Owners and permitted collaborators can upload Kept images"
  on storage.objects for insert to authenticated
  with check (
    bucket_id = 'kept-images'
    and (
      (storage.foldername(name))[1] = (select auth.uid()::text)
      or exists (
        select 1 from public.space_members
        where space_members.owner_user_id::text = (storage.foldername(name))[1]
          and space_members.member_user_id = (select auth.uid())
          and space_members.can_add
      )
    )
  );

create policy "Owners and permitted collaborators can update Kept images"
  on storage.objects for update to authenticated
  using (
    bucket_id = 'kept-images'
    and (
      owner_id = (select auth.uid()::text)
      or exists (
        select 1 from public.space_members
        where space_members.owner_user_id::text = (storage.foldername(name))[1]
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
        select 1 from public.space_members
        where space_members.owner_user_id::text = (storage.foldername(name))[1]
          and space_members.member_user_id = (select auth.uid())
          and space_members.can_delete
      )
    )
  );

create or replace function public.preview_space_invitation(p_token text)
returns table (
  invitation_id uuid,
  space_name text,
  can_add boolean,
  can_edit boolean,
  can_delete boolean,
  expires_at timestamptz
)
language sql
stable
security definer
set search_path = ''
as $$
  select invitation.id, invitation.space_name, invitation.can_add,
    invitation.can_edit, invitation.can_delete, invitation.expires_at
  from public.space_invitations as invitation
  where invitation.token_hash = encode(extensions.digest(convert_to(p_token, 'UTF8'), 'sha256'), 'hex')
    and invitation.revoked_at is null
    and invitation.accepted_at is null
    and invitation.expires_at > now()
  limit 1;
$$;

create or replace function public.accept_space_invitation(p_token text)
returns table (
  owner_user_id uuid,
  space_name text,
  can_add boolean,
  can_edit boolean,
  can_delete boolean
)
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  invitation public.space_invitations%rowtype;
  accepting_user_id uuid := auth.uid();
  accepting_label text;
begin
  if accepting_user_id is null then
    raise exception 'Sign in before accepting this invitation.';
  end if;

  select * into invitation
  from public.space_invitations
  where token_hash = encode(extensions.digest(convert_to(p_token, 'UTF8'), 'sha256'), 'hex')
    and revoked_at is null
    and accepted_at is null
    and expires_at > now()
  for update;

  if invitation.id is null then
    raise exception 'This invitation is invalid, expired, or has already been used.';
  end if;
  if invitation.owner_user_id = accepting_user_id then
    raise exception 'You already own this space.';
  end if;

  select coalesce(nullif(email, ''), 'Collaborator') into accepting_label
  from auth.users where id = accepting_user_id;

  insert into public.space_members (
    owner_user_id, space_name, member_user_id, member_label,
    can_add, can_edit, can_delete
  ) values (
    invitation.owner_user_id, invitation.space_name, accepting_user_id, accepting_label,
    invitation.can_add, invitation.can_edit, invitation.can_delete
  )
  on conflict (owner_user_id, space_name, member_user_id) do update set
    member_label = excluded.member_label,
    can_add = excluded.can_add,
    can_edit = excluded.can_edit,
    can_delete = excluded.can_delete,
    updated_at = now();

  update public.space_invitations
  set accepted_by = accepting_user_id, accepted_at = now()
  where id = invitation.id;

  return query select invitation.owner_user_id, invitation.space_name,
    invitation.can_add, invitation.can_edit, invitation.can_delete;
end;
$$;

revoke all on function public.preview_space_invitation(text) from public;
revoke all on function public.accept_space_invitation(text) from public;
grant execute on function public.preview_space_invitation(text) to authenticated;
grant execute on function public.accept_space_invitation(text) to authenticated;
