delete from public.apple_shortcut_connections as older
using public.apple_shortcut_connections as newer
where older.user_id = newer.user_id
  and (older.created_at < newer.created_at or (older.created_at = newer.created_at and older.id < newer.id));

create unique index apple_shortcut_connections_one_per_user_idx
  on public.apple_shortcut_connections (user_id);

comment on index public.apple_shortcut_connections_one_per_user_idx is
  'A Kept account has one current Apple Shortcut credential; its private iCloud configuration may sync across that user’s Apple devices.';
