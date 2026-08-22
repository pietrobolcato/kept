create table public.assistant_conversations (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  title text not null check (char_length(title) between 1 and 120),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (id, user_id)
);

create table public.assistant_messages (
  id uuid primary key default gen_random_uuid(),
  conversation_id uuid not null,
  user_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  role text not null check (role in ('user', 'assistant')),
  content text not null check (char_length(content) between 1 and 8000),
  item_ids uuid[] not null default '{}',
  sources jsonb not null default '[]'::jsonb check (jsonb_typeof(sources) = 'array'),
  activities text[] not null default '{}',
  attachment_labels text[] not null default '{}',
  created_at timestamptz not null default now(),
  foreign key (conversation_id, user_id)
    references public.assistant_conversations (id, user_id)
    on delete cascade
);

create index assistant_conversations_user_updated_idx
  on public.assistant_conversations (user_id, updated_at desc);

create index assistant_messages_conversation_created_idx
  on public.assistant_messages (conversation_id, created_at);

alter table public.assistant_conversations enable row level security;
alter table public.assistant_messages enable row level security;

create policy "Users can read their own assistant conversations"
  on public.assistant_conversations for select to authenticated
  using ((select auth.uid()) = user_id);

create policy "Users can create their own assistant conversations"
  on public.assistant_conversations for insert to authenticated
  with check ((select auth.uid()) = user_id);

create policy "Users can update their own assistant conversations"
  on public.assistant_conversations for update to authenticated
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);

create policy "Users can delete their own assistant conversations"
  on public.assistant_conversations for delete to authenticated
  using ((select auth.uid()) = user_id);

create policy "Users can read their own assistant messages"
  on public.assistant_messages for select to authenticated
  using ((select auth.uid()) = user_id);

create policy "Users can create their own assistant messages"
  on public.assistant_messages for insert to authenticated
  with check ((select auth.uid()) = user_id);
