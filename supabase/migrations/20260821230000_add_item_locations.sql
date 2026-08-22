alter table public.memory_items
  add column if not exists location_name text check (location_name is null or char_length(location_name) <= 240),
  add column if not exists location_latitude double precision check (location_latitude is null or location_latitude between -90 and 90),
  add column if not exists location_longitude double precision check (location_longitude is null or location_longitude between -180 and 180),
  add column if not exists location_source text check (location_source is null or location_source in ('exif', 'page', 'inferred', 'manual'));

alter table public.memory_items
  add constraint memory_items_location_coordinate_pair
  check ((location_latitude is null) = (location_longitude is null));

comment on column public.memory_items.location_name is 'Optional human-readable place explicitly exposed by a page or conservatively inferred from visual context.';
comment on column public.memory_items.location_latitude is 'WGS84 latitude extracted from source metadata such as photo EXIF or page geo tags.';
comment on column public.memory_items.location_longitude is 'WGS84 longitude extracted from source metadata such as photo EXIF or page geo tags.';
comment on column public.memory_items.location_source is 'Provenance for location metadata: exif, page, inferred, or manual.';
