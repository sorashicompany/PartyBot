# SorashiPartyFunBot

Telegram party game. First game mode: **Quiplash**.

## Architecture
- Cloudflare Worker: Telegram webhook, API, Telegram Mini App static hosting.
- Cloudflare Durable Objects: one authoritative real-time coordinator per room (WebSocket + alarms).
- Supabase Postgres: durable users, rooms, rounds, prompts, answers, votes, scores.
- Telegram group: room creation and invitation link. Players open the bot's Mini App via Telegram deep link.

## Development
1. Install Node.js 22+.
2. `npm install`
3. Copy `.dev.vars.example` to `.dev.vars` and set secrets.
4. Apply `supabase/migrations/0001_quiplash.sql` to the selected Supabase project.
5. Run `npm run dev`.
6. Configure Telegram webhook to `https://<worker-domain>/telegram/webhook` with the webhook secret header.
7. Configure the bot's Main Mini App URL in BotFather.

## Required Worker secrets
- `BOT_TOKEN`
- `TELEGRAM_WEBHOOK_SECRET`
- `BOT_USERNAME`
- `SUPABASE_URL`
- `SUPABASE_SERVICE_ROLE_KEY`

Never put the Supabase service-role key or Telegram bot token in browser code.

## MVP game rules (initial target)
- 4–10 players.
- 3 rounds.
- Each player answers 2 prompts per round.
- 60 seconds to answer; 30 seconds to vote.
- Responses are anonymous during voting.
- Players cannot vote for their own response.
- One point per received vote; ties are allowed.
- Server-side deadlines and idempotent answer/vote writes.

## Current milestone
Repository foundation and infrastructure scaffold. Room state coordinator and Telegram webhook are being established first; full round allocation, voting, score finalization, reconnect and automated tests are subsequent milestones.
