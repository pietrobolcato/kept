alter table public.memory_items
  add column if not exists captured_at timestamptz,
  add column if not exists captured_at_source text;

alter table public.memory_items
  drop constraint if exists memory_items_captured_at_source_check;

alter table public.memory_items
  add constraint memory_items_captured_at_source_check
  check (captured_at_source is null or captured_at_source in ('exif', 'apple_photos', 'manual'));

create index if not exists memory_items_user_captured_at_idx
  on public.memory_items (user_id, captured_at desc)
  where captured_at is not null;

comment on column public.memory_items.created_at is 'When the item was added to Kept.';
comment on column public.memory_items.captured_at is 'When an image was originally captured, if reliably known.';
comment on column public.memory_items.captured_at_source is 'Provenance for captured_at: EXIF, Apple Photos, or manual.';
