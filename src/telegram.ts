import type { Env, TelegramUpdate } from "./types";
import { BOT_PLAYERS } from "./bots";

export async function sendTelegramMessage(
  env: Env,
  chatId: number,
  text: string,
  replyMarkup?: unknown
): Promise<void> {
  const response = await fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: chatId,
      text,
      reply_markup: replyMarkup,
      disable_web_page_preview: true
    })
  });
  if (!response.ok) throw new Error(`Telegram sendMessage failed: ${response.status}`);
}

export async function handleTelegramUpdate(env: Env, update: TelegramUpdate): Promise<void> {
  const message = update.message;
  if (!message?.text || !message.from || !["group", "supergroup"].includes(message.chat.type)) return;
  if (!/^\/party(?:@\w+)?(?:\s|$)/i.test(message.text.trim())) return;

  const cooldownSince = new Date(Date.now() - 5 * 60 * 1000).toISOString();
  const cooldownUrl = "/rest/v1/rooms?group_chat_id=eq." + message.chat.id + "&created_at=gte." + encodeURIComponent(cooldownSince) + "&select=id&limit=1";
  const recentRooms = await fetch(new URL(cooldownUrl, env.SUPABASE_URL), {
    headers: { apikey: env.SUPABASE_SERVICE_ROLE_KEY, Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}` }
  });
  if (!recentRooms.ok) throw new Error(`Lobby cooldown lookup failed: ${recentRooms.status}`);
  const recent = await recentRooms.json() as Array<{ id: string }>;
  if (recent.length) {
    await sendTelegramMessage(env, message.chat.id, "⏳ Новое лобби можно создать раз в 5 минут. Попробуйте немного позже.");
    return;
  }

  const code = randomRoomCode();
  const inserted = await fetch(new URL("/rest/v1/rooms", env.SUPABASE_URL), {
    method: "POST",
    headers: {
      apikey: env.SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
      "Content-Type": "application/json",
      Prefer: "return=representation"
    },
    body: JSON.stringify({
      code,
      host_telegram_id: message.from.id,
      group_chat_id: message.chat.id,
      status: "lobby"
    })
  });
  if (!inserted.ok) throw new Error(`Room insert failed: ${inserted.status} ${(await inserted.text()).slice(0, 300)}`);

  const roomRows = await inserted.json() as Array<{ id: string }>;
  const roomId = roomRows[0]?.id;
  if (!roomId) throw new Error("Room insert returned no ID");

  const playerResponse = await fetch(new URL("/rest/v1/room_players", env.SUPABASE_URL), {
    method: "POST",
    headers: {
      apikey: env.SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      room_id: roomId,
      telegram_user_id: message.from.id,
      display_name: displayName(message.from.first_name, message.from.last_name)
    })
  });
  if (!playerResponse.ok) throw new Error(`Host membership insert failed: ${playerResponse.status}`);

  const botResponse = await fetch(new URL("/rest/v1/room_players", env.SUPABASE_URL), {
    method: "POST",
    headers: {
      apikey: env.SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify(BOT_PLAYERS.map(bot => ({ room_id: roomId, ...bot })))
  });
  if (!botResponse.ok) throw new Error(`Lobby bot insert failed: ${botResponse.status}`);

  const deepLink = `https://t.me/${env.BOT_USERNAME}?startapp=${code}`;
  await sendTelegramMessage(env, message.chat.id,
    `🎉 SorashiPartyFunBot\nКомната создана: ${code}\nИгроки: 4–10\n\nКаждый игрок откройте Mini App по кнопке ниже. Ведущий сможет начать игру, когда соберутся минимум 4 участника.`,
    { inline_keyboard: [[{ text: "Открыть игру", url: deepLink }]] }
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
