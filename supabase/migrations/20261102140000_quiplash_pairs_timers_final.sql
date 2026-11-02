-- Quiplash-style rounds, pair voting, final wagers and phase timers.
alter table public.rooms
  add column if not exists phase_deadline_at timestamptz,
  add column if not exists last_lobby_created_at timestamptz;

alter table public.round_prompts
  add column if not exists pair_key text,
  add column if not exists prompt_slot smallint not null default 1;

alter table public.answers
  add column if not exists wager integer not null default 0 check (wager >= 0);

alter table public.votes
  add column if not exists prompt_id uuid references public.prompts(id);

create unique index if not exists idx_votes_prompt_voter
  on public.votes(prompt_id, voter_telegram_id)
  where prompt_id is not null;

create index if not exists idx_round_prompts_pair
  on public.round_prompts(room_id, round_number, pair_key);
