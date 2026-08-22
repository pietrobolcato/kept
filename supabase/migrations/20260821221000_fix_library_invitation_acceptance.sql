create or replace function public.accept_library_invitation(p_token text)
returns table (owner_user_id uuid, can_add boolean, can_edit boolean, can_delete boolean)
language plpgsql volatile security definer set search_path = '' as $$
declare
  invitation public.library_invitations%rowtype;
  accepting_user_id uuid := auth.uid();
  accepting_label text;
begin
  if accepting_user_id is null then raise exception 'Sign in before accepting this invitation.'; end if;
  select invitation_row.* into invitation from public.library_invitations as invitation_row
    where invitation_row.token_hash = encode(extensions.digest(convert_to(p_token, 'UTF8'), 'sha256'), 'hex')
      and invitation_row.revoked_at is null
      and invitation_row.accepted_at is null
      and invitation_row.expires_at > now()
    for update;
  if invitation.id is null then raise exception 'This invitation is invalid, expired, or has already been used.'; end if;
  if invitation.owner_user_id = accepting_user_id then raise exception 'You already own this library.'; end if;
  select coalesce(nullif(auth_user.email, ''), 'Collaborator') into accepting_label
    from auth.users as auth_user where auth_user.id = accepting_user_id;
  insert into public.library_members (owner_user_id, member_user_id, member_label, can_add, can_edit, can_delete)
  values (invitation.owner_user_id, accepting_user_id, accepting_label, invitation.can_add, invitation.can_edit, invitation.can_delete)
  on conflict on constraint library_members_pkey do update set
    member_label = excluded.member_label,
    can_add = excluded.can_add,
    can_edit = excluded.can_edit,
    can_delete = excluded.can_delete,
    updated_at = now();
  update public.library_invitations as invitation_row
    set accepted_by = accepting_user_id, accepted_at = now()
    where invitation_row.id = invitation.id;
  return query select invitation.owner_user_id, invitation.can_add, invitation.can_edit, invitation.can_delete;
end;
$$;

revoke all on function public.accept_library_invitation(text) from public;
grant execute on function public.accept_library_invitation(text) to authenticated;
