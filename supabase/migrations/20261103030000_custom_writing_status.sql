-- Allow the custom-question phase. The worker already writes status = 'custom_writing'.
do $$
declare r record;
begin
  for r in
    select c.conname
    from pg_constraint c
    join pg_class t on c.conrelid = t.oid
    join pg_namespace n on t.relnamespace = n.oid
    where n.nspname = 'public'
      and t.relname = 'rooms'
      and c.contype = 'c'
      and pg_get_constraintdef(c.oid) ilike '%status%'
  loop
    execute format('alter table public.rooms drop constraint %I', r.conname);
  end loop;
end $$;

alter table public.rooms
  add constraint rooms_status_check
  check (status in ('lobby', 'custom_writing', 'answering', 'voting', 'round_results', 'finished', 'cancelled'));
