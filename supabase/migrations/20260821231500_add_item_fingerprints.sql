alter table public.memory_items
  add column if not exists content_fingerprint text,
  add column if not exists visual_fingerprint text;

alter table public.memory_items
  add constraint memory_items_content_fingerprint_format
    check (content_fingerprint is null or content_fingerprint ~ '^[0-9a-f]{64}$'),
  add constraint memory_items_visual_fingerprint_format
    check (visual_fingerprint is null or visual_fingerprint ~ '^[0-9a-f]{64}$');

create unique index memory_items_owner_content_fingerprint_idx
  on public.memory_items (user_id, content_fingerprint)
  where content_fingerprint is not null;

create index memory_items_owner_visual_fingerprint_idx
  on public.memory_items (user_id, visual_fingerprint)
  where visual_fingerprint is not null;

comment on column public.memory_items.content_fingerprint is 'SHA-256 identity for a canonical link or the exact bytes of an uploaded file.';
comment on column public.memory_items.visual_fingerprint is 'Conservative perceptual fingerprint used to recognize the same photo after metadata stripping or recompression.';
