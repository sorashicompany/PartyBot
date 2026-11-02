create table if not exists public.party_profiles (
  telegram_user_id bigint primary key,
  display_name text not null default 'Player' check (char_length(display_name) between 1 and 80),
  games_played integer not null default 0 check (games_played >= 0),
  total_score bigint not null default 0 check (total_score >= 0),
  best_place smallint check (best_place between 1 and 8),
  updated_at timestamptz not null default now()
);

create table if not exists public.party_game_results (
  id uuid primary key default gen_random_uuid(),
  telegram_user_id bigint not null references public.party_profiles(telegram_user_id) on delete cascade,
  score integer not null check (score between 0 and 100000),
  place smallint not null check (place between 0 and 8),
  created_at timestamptz not null default now()
);

create index if not exists party_game_results_user_created_idx
  on public.party_game_results (telegram_user_id, created_at desc);

alter table public.party_profiles enable row level security;
alter table public.party_game_results enable row level security;
revoke all on public.party_profiles, public.party_game_results from anon, authenticated;
grant all on public.party_profiles, public.party_game_results to service_role;

create or replace function public.record_party_game_result(
  p_telegram_user_id bigint,
  p_display_name text,
  p_score integer,
  p_place smallint
) returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.party_profiles (telegram_user_id, display_name)
  values (p_telegram_user_id, left(coalesce(nullif(p_display_name, ''), 'Player'), 80))
  on conflict (telegram_user_id) do nothing;

  insert into public.party_game_results (telegram_user_id, score, place)
  values (p_telegram_user_id, p_score, p_place);

  update public.party_profiles
  set display_name = left(coalesce(nullif(p_display_name, ''), 'Player'), 80),
      games_played = games_played + 1,
      total_score = total_score + p_score,
      best_place = case
        when p_place = 0 then best_place
        when best_place is null then p_place
        else least(best_place, p_place)
      end,
      updated_at = now()
  where telegram_user_id = p_telegram_user_id;
end;
$$;

revoke all on function public.record_party_game_result(bigint, text, integer, smallint) from public, anon, authenticated;
grant execute on function public.record_party_game_result(bigint, text, integer, smallint) to service_role;