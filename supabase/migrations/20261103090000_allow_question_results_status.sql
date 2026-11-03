-- The per-question reveal phase is persisted in rooms.status.
-- Keep the database constraint in sync with the game state machine.
ALTER TABLE public.rooms
  DROP CONSTRAINT IF EXISTS rooms_status_check;

ALTER TABLE public.rooms
  ADD CONSTRAINT rooms_status_check
  CHECK (status = ANY (ARRAY[
    'lobby',
    'custom_writing',
    'answering',
    'voting',
    'question_results',
    'round_results',
    'finished',
    'cancelled'
  ]::text[]));
