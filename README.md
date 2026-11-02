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

Set `BOT_USERNAME` as a Worker secret. The GitHub Actions workflow deploys automatically after typecheck when all required repository secrets are present. Configure these GitHub Actions secrets in **Settings → Secrets and variables → Actions**:

- `CLOUDFLARE_API_TOKEN` — API token with Workers Scripts edit permission.
- `CLOUDFLARE_ACCOUNT_ID` — Cloudflare account ID.
- `BOT_TOKEN` — Telegram bot token from BotFather.
- `BOT_USERNAME` — bot username without `@`.
- `TELEGRAM_WEBHOOK_SECRET` — random 32-byte hex string.
- `ROOM_TICKET_SECRET` — a different random 32-byte hex string.
- `SUPABASE_SERVICE_ROLE_KEY` — server-only key from the Supabase project's API settings.

The workflow deploys `https://sorashi-party-fun-bot.sorashithegod.workers.dev`, registers the Telegram webhook and installs the `/party` command. After deployment, set the bot's Main Mini App URL to `https://sorashi-party-fun-bot.sorashithegod.workers.dev` in BotFather. Do not paste any of these credentials into chat or commit them to the repository.

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
