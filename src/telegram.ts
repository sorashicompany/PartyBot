import type { Env, TelegramUpdate } from "./types";

export function escapeHtml(value: string): string {
  return value.replace(/&/g, "&").replace(/</g, "<").replace(/>/g, ">");
}

export async function sendTelegramMessage(
  env: Env,
  chatId: number,
  text: string,
  replyMarkup?: unknown,
  parseMode?: "HTML"
): Promise<void> {
  const response = await fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: chatId,
      text,
      parse_mode: parseMode,
      reply_markup: replyMarkup,
      disable_web_page_preview: true,
    }),
  });
  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    throw new Error(`Telegram sendMessage failed: ${response.status} ${detail.slice(0, 240)}`);
  }
}

export async function handleTelegramUpdate(env: Env, update: TelegramUpdate): Promise<void> {
  const message = update.message;
  if (!message?.text || !message.from || !["group", "supergroup"].includes(message.chat.type)) return;
  if (!/^\/party(?:@\w+)?(?:\s|$)/i.test(message.text.trim())) return;

  const cooldownSince = new Date(Date.now() - 5 * 60 * 1000).toISOString();
  const cooldownUrl = "/rest/v1/rooms?group_chat_id=eq." + message.chat.id + "&created_at=gte." + encodeURIComponent(cooldownSince) + "&select=id&limit=1";
  const recentRooms = await fetch(new URL(cooldownUrl, env.SUPABASE_URL), {
    headers: { apikey: env.SUPABASE_SERVICE_ROLE_KEY, Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}` },
  });
  if (!recentRooms.ok) throw new Error(`Lobby cooldown lookup failed: ${recentRooms.status}`);
  const recent = await recentRooms.json() as Array<{ id: string }>;
  if (recent.length) {
    await sendTelegramMessage(env, message.chat.id, "Новое лобби можно открыть раз в 5 минут. Зал ещё не остыл.");
    return;
  }

  const code = randomRoomCode();
  const inserted = await fetch(new URL("/rest/v1/rooms", env.SUPABASE_URL), {
    method: "POST",
    headers: {
      apikey: env.SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
      "Content-Type": "application/json",
      Prefer: "return=representation",
    },
    body: JSON.stringify({
      code,
      host_telegram_id: message.from.id,
      group_chat_id: message.chat.id,
      status: "lobby",
    }),
  });
  if (!inserted.ok) throw new Error(`Room insert failed: ${inserted.status} ${(await inserted.text()).slice(0, 300)}`);

  const roomRows = await inserted.json() as Array<{ id: string }>;
  const roomId = roomRows[0]?.id;
  if (!roomId) throw new Error("Room insert returned no ID");

  const hostName = displayName(message.from.first_name, message.from.last_name);
  const playerResponse = await fetch(new URL("/rest/v1/room_players", env.SUPABASE_URL), {
    method: "POST",
    headers: {
      apikey: env.SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      room_id: roomId,
      telegram_user_id: message.from.id,
      display_name: hostName,
    }),
  });
  if (!playerResponse.ok) throw new Error(`Host membership insert failed: ${playerResponse.status}`);

  const deepLink = `https://t.me/${env.BOT_USERNAME}?startapp=${code}`;
  await sendTelegramMessage(
    env,
    message.chat.id,
    `Сораши Пати открывает зал.\nКомната <b>${code}</b>\nВедущий: <b>${escapeHtml(hostName)}</b>\nИгроков: 3–10\n\nЖмите кнопку и садитесь. Я буду писать сюда вопросы, панчи и счёт — чтобы весь чат ржал вместе с игроками.`,
    { inline_keyboard: [[{ text: "Сесть в зал", url: deepLink }]] },
    "HTML",
  );
}

function displayName(first: string, last?: string): string {
  return [first, last].filter(Boolean).join(" ").slice(0, 80);
}

function randomRoomCode(): string {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const bytes = crypto.getRandomValues(new Uint8Array(5));
  return Array.from(bytes, byte => alphabet[byte % alphabet.length]).join("");
}
