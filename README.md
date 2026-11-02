# Сораши Пати — Telegram Mini App

Исходная игра перенесена из `sorashicompany/partygame2`: React-интерфейс, игровой движок, колода вопросов, аудио и стили. Приложение собирается Vite в статические assets и раздаётся Cloudflare Worker.

## Стек

- React + Vite — интерфейс игры.
- Telegram Mini Apps SDK — запуск внутри Telegram; авторизация проверяется Worker по подписанному `initData`.
- Cloudflare Workers + Durable Objects — API, Telegram webhook и realtime-комнаты.
- Supabase Postgres — профили и результаты игр; серверный доступ через service role secret в Worker.

## Разработка

```sh
npm install
npm run dev
```

## Сборка и деплой

```sh
npm run build
npm run deploy
```

Перед деплоем в Cloudflare должны быть настроены secrets: `BOT_TOKEN`, `BOT_USERNAME`, `TELEGRAM_WEBHOOK_SECRET`, `ROOM_TICKET_SECRET`, `SUPABASE_SERVICE_ROLE_KEY`. URL Supabase задаётся в `wrangler.jsonc`. Секреты нельзя помещать во frontend или коммитить в репозиторий.

## Telegram

Открой Mini App из бота. Клиент передаёт исходный `Telegram.WebApp.initData` в Worker; сервер проверяет HMAC-подпись и срок действия данных перед записью результатов. `initDataUnsafe` не используется для авторизации.

## Данные

Миграция `supabase/migrations/20261102235000_partygame2_profiles_and_results.sql` создаёт таблицы профилей и результатов. Результаты записываются атомарной RPC-функцией. Существующие таблицы комнат и их миграции сохранены для текущего Telegram-бота.
