# Deployment

The `verify-and-deploy` GitHub Actions workflow runs on pushes to `main` and can also be started manually from Actions.

Required repository Actions secrets:

- `CLOUDFLARE_API_TOKEN`
- `CLOUDFLARE_ACCOUNT_ID`
- `BOT_TOKEN`
- `BOT_USERNAME`
- `TELEGRAM_WEBHOOK_SECRET`
- `ROOM_TICKET_SECRET`
- `SUPABASE_SERVICE_ROLE_KEY`

After deployment, verify `GET /health`, then test the Telegram `/party` command in a group. Do not expose secret values in client code or commit them to the repository.

The current MVP is an initial implementation and should be tested with a small private group before broader use.
