alter table public.spaces
add column description text not null default ''
check (char_length(description) <= 500);

update public.spaces
set description = case name
  when 'Home ideas' then 'Interiors, architecture, gardens, renovations and details that could shape a home.'
  when 'Design references' then 'Brand identities, typography, interfaces, layouts and visual systems worth returning to.'
  when 'Reading list' then 'Articles, essays, books and ideas to read or revisit later.'
  when 'Travel' then 'Places, stays, restaurants and experiences for future trips.'
  when 'Objects' then 'Furniture, tools, products and beautifully made everyday things.'
  when 'Inbox' then 'New or ambiguous memories waiting to find a more specific home.'
  else description
end
where description = '';

create or replace function public.create_default_spaces_for_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.spaces (user_id, name, color, description, position)
  values
    (new.id, 'Home ideas', '#d4e567', 'Interiors, architecture, gardens, renovations and details that could shape a home.', 0),
    (new.id, 'Design references', '#cdb8ee', 'Brand identities, typography, interfaces, layouts and visual systems worth returning to.', 1),
    (new.id, 'Reading list', '#ff8c77', 'Articles, essays, books and ideas to read or revisit later.', 2),
    (new.id, 'Travel', '#72c5c9', 'Places, stays, restaurants and experiences for future trips.', 3),
    (new.id, 'Objects', '#e0b275', 'Furniture, tools, products and beautifully made everyday things.', 4),
    (new.id, 'Inbox', '#b9b8b0', 'New or ambiguous memories waiting to find a more specific home.', 5)
  on conflict (user_id, name) do nothing;
  return new;
end;
$$;
