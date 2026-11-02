# Deployment

1. Configure GitHub Actions secrets: CLOUDFLARE_API_TOKEN, CLOUDFLARE_ACCOUNT_ID, BOT_TOKEN, BOT_USERNAME, TELEGRAM_WEBHOOK_SECRET, ROOM_TICKET_SECRET, SUPABASE_SERVICE_ROLE_KEY.
2. Install dependencies and build with npm install and npm run build.
3. Deploy with npx wrangler deploy. Wrangler serves dist/ through the Worker Assets binding.
4. The deployment workflow configures the Telegram webhook at https://sorashi-party-fun-bot.sorashithegod.workers.dev/telegram/webhook.
5. Set the bot Mini App URL in BotFather.

The profile/results migration is applied through Supabase. The service-role key stays in Worker secrets and is never shipped to the browser.
