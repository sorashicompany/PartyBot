import { supabaseRequest } from "./supabase";import type { Env, TelegramUpdate } from "./types";

export function escapeHtml(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
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


async function handleAudienceCallback(env: Env, query: NonNullable<TelegramUpdate["callback_query"]>): Promise<void> {
  const data = String(query.data || "");
  const match = /^aud\\|([A-HJ-NP-Z2-9]{5})\\|(\\d+)\\|(\\d+)\\|([0-9a-f-]{20,40})$/i.exec(data);
  const reply = async (text: string) => {
    await fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/answerCallbackQuery`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ callback_query_id: query.id, text, show_alert: false }),
    });
  };
  if (!match || !query.message || !["group", "supergroup"].includes(query.message.chat.type)) {
    await reply("Эта кнопка голосования недействительна");
    return;
  }
  const [, code, roundText, indexText, answerId] = match;
  const round = Number(roundText), promptIndex = Number(indexText);
  const rooms = await supabaseRequest<Array<{ id: string; status: string; round_number: number; voting_prompt_index: number; group_chat_id: number }>>(
    env, `rooms?code=eq.${code}&select=id,status,round_number,voting_prompt_index,group_chat_id&limit=1`,
  );
  const room = rooms[0];
  if (!room || Number(room.group_chat_id) !== query.message.chat.id || room.status !== "voting" ||
      Number(room.round_number) !== round || Number(room.voting_prompt_index || 0) !== promptIndex) {
    await reply("Это голосование уже закрыто");
    return;
  }
  const assignments = await supabaseRequest<Array<{ id: string; prompt_id: string; pair_key?: string | null }>>(
    env, `round_prompts?room_id=eq.${room.id}&round_number=eq.${round}&select=id,prompt_id,pair_key&order=created_at.asc`,
  );
  const answers = await supabaseRequest<Array<{ id: string; prompt_assignment_id: string; prompt_id: string }>>(
    env, `answers?room_id=eq.${room.id}&round_number=eq.${round}&select=id,prompt_assignment_id,prompt_id`,
  );
  const units: Array<{ key: string }> = [];
  for (const assignment of assignments) {
    const key = assignment.pair_key || assignment.prompt_id;
    if (!units.some(unit => unit.key === key)) units.push({ key });
  }
  const active = round === 3 ? { key: "final" } : units[promptIndex];
  const pairOf = (answer: typeof answers[number]) => {
    const assignment = assignments.find(item => item.id === answer.prompt_assignment_id);
    return assignment?.pair_key || assignment?.prompt_id || answer.prompt_id;
  };
  const target = answers.find(answer => answer.id === answerId);
  if (!active || !target || pairOf(target) !== active.key) {
    await reply("Ответ не относится к текущему вопросу");
    return;
  }
  const result = await env.GAME_ROOMS.getByName(code).castAudienceVote({
    round, promptIndex, userId: query.from.id, answerId,
  });
  if (!result.ok) {
    await reply(result.error || "Вы уже голосовали за этот вопрос");
    return;
  }
  await reply("Голос учтён. Спасибо!");
  const ids = answers.filter(answer => pairOf(answer) === active.key).map(answer => answer.id);
  const letters = ["А", "Б", "В", "Г", "Д", "Е", "Ж", "З", "И", "К"];
  const inline_keyboard = ids.slice(0, 10).map((id, index) => [{
    text: `${letters[index]}. ${result.counts[id] || 0} голосов`,
    callback_data: `aud|${code}|${round}|${promptIndex}|${id}`,
  }]);
  await fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/editMessageReplyMarkup`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: query.message.chat.id, message_id: query.message.message_id, reply_markup: { inline_keyboard } }),
  });
}
function displayName(first: string, last?: string): string {
  return [first, last].filter(Boolean).join(" ").slice(0, 80);
}

function randomRoomCode(): string {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const bytes = crypto.getRandomValues(new Uint8Array(5));
  return Array.from(bytes, byte => alphabet[byte % alphabet.length]).join("");
}
