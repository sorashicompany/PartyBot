-- Sequential 20-second voting screens and host-controlled custom prompts.
alter table public.rooms
  add column if not exists voting_prompt_index integer not null default 0,
  add column if not exists custom_prompts_enabled boolean not null default false;

create table if not exists public.room_custom_prompts (
  id uuid primary key default gen_random_uuid(),
  room_id uuid not null references public.rooms(id) on delete cascade,
  prompt_text text not null check (char_length(prompt_text) between 5 and 240),
  prompt_id uuid references public.prompts(id),
  created_by_telegram_id bigint not null,
  created_at timestamptz not null default now()
);

create index if not exists idx_room_custom_prompts_room
  on public.room_custom_prompts(room_id);

alter table public.room_custom_prompts enable row level security;
revoke all on public.room_custom_prompts from anon, authenticated;
