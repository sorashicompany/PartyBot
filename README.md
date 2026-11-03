# Сораши Пати — Telegram Mini App

Партийная игра в духе Quiplash: бот открывает комнату в групповом чате, игроки отвечают в Mini App, а чат видит ход шоу.

## Что пишет бот в чат

Команда `/party` в группе создаёт комнату. Дальше бот сам присылает в **этот же чат**:

- кто сел в зал;
- старт раунда (без текстов ответов);
- каждый вопрос голосования с панчами, но без имён;
- итог раунда, лучший панч и счёт;
- финальный пьедестал.

Кнопка под сообщением снова открывает Mini App.

## Чат зала

На экране голосования внутри Mini App есть свой чат. Он живёт только у текущего вопроса и не дублируется в Telegram.

## Стек

- React + Vite — интерфейс игры.
- Telegram Mini Apps SDK — запуск внутри Telegram; авторизация проверяется Worker по подписанному `initData`.
- Cloudflare Workers + Durable Objects — API, Telegram webhook, realtime и чат голосования.
- Supabase Postgres — комнаты, ответы, профили и результаты. Серверный доступ через service role secret в Worker.

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

Примените новую миграцию `supabase/migrations/20261103030000_custom_writing_status.sql`, если свои вопросы ещё не включались: без неё статус `custom_writing` не проходит проверку таблицы `rooms`.

## Telegram

Открой Mini App из бота. Клиент передаёт исходный `Telegram.WebApp.initData` в Worker; сервер проверяет HMAC-подпись и срок действия данных перед записью результатов. `initDataUnsafe` не используется для авторизации.

## Данные

Миграция `supabase/migrations/20261102235000_partygame2_profiles_and_results.sql` создаёт таблицы профилей и результатов. Результаты записываются атомарной RPC-функцией. Существующие таблицы комнат и их миграции сохранены для текущего Telegram-бота.
