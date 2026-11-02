-- SorashiPartyFunBot / Quiplash MVP
-- Apply only to the dedicated game Supabase project.
create extension if not exists pgcrypto;

create table if not exists public.rooms (
  id uuid primary key default gen_random_uuid(),
  code text not null unique check (code ~ '^[A-HJ-NP-Z2-9]{5}$'),
  host_telegram_id bigint not null,
  group_chat_id bigint not null,
  status text not null default 'lobby' check (status in ('lobby','answering','voting','round_results','finished','cancelled')),
  round_number smallint not null default 0 check (round_number between 0 and 3),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  expires_at timestamptz not null default now() + interval '6 hours'
);

create table if not exists public.room_players (
  id uuid primary key default gen_random_uuid(),
  room_id uuid not null references public.rooms(id) on delete cascade,
  telegram_user_id bigint not null,
  display_name text not null check (char_length(display_name) between 1 and 80),
  score integer not null default 0 check (score >= 0),
  joined_at timestamptz not null default now(),
  unique(room_id, telegram_user_id)
);

create table if not exists public.prompts (
  id uuid primary key default gen_random_uuid(),
  prompt_text text not null,
  locale text not null default 'ru',
  enabled boolean not null default true,
  created_at timestamptz not null default now()
);

create table if not exists public.round_prompts (
  id uuid primary key default gen_random_uuid(),
  room_id uuid not null references public.rooms(id) on delete cascade,
  round_number smallint not null check (round_number between 1 and 3),
  prompt_id uuid not null references public.prompts(id),
  player_telegram_id bigint not null,
  created_at timestamptz not null default now(),
  unique(room_id, round_number, player_telegram_id, prompt_id)
);

create table if not exists public.answers (
  id uuid primary key default gen_random_uuid(),
  room_id uuid not null references public.rooms(id) on delete cascade,
  round_number smallint not null check (round_number between 1 and 3),
  prompt_assignment_id uuid not null references public.round_prompts(id) on delete cascade,
  author_telegram_id bigint not null,
  answer_text text not null check (char_length(answer_text) between 1 and 240),
  submitted_at timestamptz not null default now(),
  unique(prompt_assignment_id)
);

create table if not exists public.votes (
  id uuid primary key default gen_random_uuid(),
  answer_id uuid not null references public.answers(id) on delete cascade,
  voter_telegram_id bigint not null,
  created_at timestamptz not null default now(),
  unique(answer_id, voter_telegram_id)
);

create index if not exists idx_room_players_room on public.room_players(room_id);
create index if not exists idx_round_prompts_room_round on public.round_prompts(room_id, round_number);
create index if not exists idx_answers_room_round on public.answers(room_id, round_number);
create index if not exists idx_votes_answer on public.votes(answer_id);

-- All mutations go through the Cloudflare Worker using the server-side service role.
-- No anon/authenticated grants or policies are created; keep service credentials server-only.
alter table public.rooms enable row level security;
alter table public.room_players enable row level security;
alter table public.prompts enable row level security;
alter table public.round_prompts enable row level security;
alter table public.answers enable row level security;
alter table public.votes enable row level security;

insert into public.prompts(prompt_text, locale) values
('Самая странная причина опоздать на собственную свадьбу?', 'ru'),
('Что нельзя говорить роботу-пылесосу?', 'ru'),
('Как назвать ресторан, где готовят только лёд?', 'ru'),
('Что было бы худшим названием для супергероя?', 'ru'),
('Какой предмет точно не стоит брать на первое свидание?', 'ru'),
('Что написать на кнопке, которую никто не должен нажимать?', 'ru'),
('Как объяснить инопланетянам, что такое очередь?', 'ru'),
('Самая нелепая причина стать знаменитым?', 'ru'),
('Что могло бы испортить идеальный отпуск?', 'ru'),
('Какой закон ввели бы коты, если бы управляли миром?', 'ru')
on conflict do nothing;
