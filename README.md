# SorashiPartyFunBot

Telegram party game. First mode: **Quiplash**.

## Architecture
- Cloudflare Worker: Telegram webhook, authenticated game API and Mini App hosting.
- Cloudflare Durable Objects: room WebSocket coordination.
- Supabase Postgres: rooms, players, prompts, assignments, answers, votes and scores.
- Telegram group: room creation and invitation link.

## Local development
1. Install Node.js 22+.
2. Run `npm install`.
3. Copy `.dev.vars.example` to `.dev.vars` and fill in the values.
4. Apply `supabase/migrations/0001_quiplash.sql` to the dedicated Supabase project.
5. Run `npm run dev`.

## Worker configuration
`SUPABASE_URL` is a non-secret Wrangler variable in `wrangler.jsonc`. Set these as Worker secrets:
- `BOT_TOKEN` — Telegram bot token.
- `TELEGRAM_WEBHOOK_SECRET` — Telegram webhook secret header.
- `ROOM_TICKET_SECRET` — random secret used to sign short-lived WebSocket tickets.
- `SUPABASE_SERVICE_ROLE_KEY` — server-only Supabase key. Never expose it in browser code.

Set `BOT_USERNAME` as a Worker variable or secret. Configure the Telegram webhook at `https://<worker-domain>/telegram/webhook`, then set the Mini App URL in BotFather.

## Implemented game flow
- 4–10 players; host starts the game.
- 3 rounds; one shared prompt per round is assigned to all players.
- Players submit answers privately.
- Once all answers arrive, voting opens; answers are anonymous during voting.
- Each player votes for every answer except their own.
- Each received vote adds 1,000 points.
- Host advances between rounds; the final round ends the game.

## Not yet implemented
Round timers, two prompts per player per round, moderation/reporting, reconnect state sync beyond refresh, race-safe round transitions, automated integration tests and production deployment. Treat this as an MVP development build, not a public launch.
