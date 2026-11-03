import { supabaseRequest } from "./supabase";
import type { Env, TelegramUpdate } from "./types";

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
  if (update.callback_query) {
    await handleAudienceCallback(env, update.callback_query);
    return;
  }
  const message = update.message;
  if (!message?.text || !message.from || !["group", "supergroup"].includes(message.chat.type)) return;
  if (!/^\/party(?:@\w+)?(?:\s|$)/i.test(message.text.trim())) return;

  const command = message.text.trim().replace(/^\/party(?:@\w+)?\s*/i, "").trim();
  if (/^(?:bots(?:\s+\d+)?|clearbots)$/i.test(command)) {
    const rooms = await supabaseRequest<Array<{ id: string; code: string; host_telegram_id: number; status: string }>>(
      env,
      `rooms?group_chat_id=eq.${message.chat.id}&status=eq.lobby&select=id,code,host_telegram_id,status&order=created_at.desc&limit=1`,
    );
    const room = rooms[0];
    if (!room) {
      await sendTelegramMessage(env, message.chat.id, "Нет открытого лобби. Сначала отправьте /party.");
      return;
    }
    if (Number(room.host_telegram_id) !== message.from.id) {
      await sendTelegramMessage(env, message.chat.id, "Управлять тестовыми игроками может только ведущий лобби.");
      return;
    }
    if (/^clearbots$/i.test(command)) {
      const removed = await supabaseRequest<Array<{ telegram_user_id: number }>>(
        env,
        `room_players?room_id=eq.${room.id}&telegram_user_id=lt.0&select=telegram_user_id`,
      );
      const deletion = await fetch(new URL(`/rest/v1/room_players?room_id=eq.${room.id}&telegram_user_id=lt.0`, env.SUPABASE_URL), {
        method: "DELETE",
        headers: { apikey: env.SUPABASE_SERVICE_ROLE_KEY, Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}` },
      });
      if (!deletion.ok) throw new Error(`Test player deletion failed: ${deletion.status}`);
      await env.GAME_ROOMS.getByName(room.code).broadcast("room_changed", { code: room.code });
      await sendTelegramMessage(env, message.chat.id, `Удалено тестовых игроков: ${removed.length}.`);
    } else {
      const requested = Number(command.match(/\d+/)?.[0] || 1);
      if (!Number.isInteger(requested) || requested < 1 || requested > 10) {
        await sendTelegramMessage(env, message.chat.id, "Укажите количество от 1 до 10: /party bots 5");
        return;
      }
      const current = await supabaseRequest<Array<{ telegram_user_id: number; display_name: string }>>(
        env,
        `room_players?room_id=eq.${room.id}&select=telegram_user_id,display_name`,
      );
      const available = Math.max(0, 10 - current.length);
      const count = Math.min(requested, available);
      if (!count) {
        await sendTelegramMessage(env, message.chat.id, "Лобби уже заполнено (10/10).");
        return;
      }
      const names = ["Тестовый игрок", "Бот Проверяка", "Панч-Машина", "Капитан Мем", "Случайный Гений", "Лорд Абсурда", "Шутник 3000", "Мисс Ирония", "Профессор Хаос", "Зритель №1"];
      const now = Date.now();
      const rows = Array.from({ length: count }, (_, index) => ({
        room_id: room.id,
        telegram_user_id: -(now * 100 + index + 1),
        display_name: names[index % names.length],
        score: 0,
      }));
      const response = await fetch(new URL("/rest/v1/room_players", env.SUPABASE_URL), {
        method: "POST",
        headers: {
          apikey: env.SUPABASE_SERVICE_ROLE_KEY,
          Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(rows),
      });
      if (!response.ok) throw new Error(`Test player insert failed: ${response.status} ${(await response.text()).slice(0, 200)}`);
      await env.GAME_ROOMS.getByName(room.code).broadcast("room_changed", { code: room.code });
      await sendTelegramMessage(env, message.chat.id, `Добавлено тестовых игроков: ${count}. В лобби ${current.length + count}/10. Удалить их можно командой /party clearbots.`);
    }
    return;
  }

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

  // Development-only autofill keeps a newly created room playable without real participants.
  if (env.ENABLE_DEV_BOTS === "true") {
    const currentPlayers = await supabaseRequest<Array<{ telegram_user_id: number }>>(
      env, `room_players?room_id=eq.${roomId}&select=telegram_user_id`,
    );
    const botCount = Math.min(2, Math.max(0, 3 - currentPlayers.length));
    if (botCount > 0) {
      const names = ["Бот Проверяка", "Панч-Машина", "Капитан Мем", "Случайный Гений", "Лорд Абсурда", "Шутник 3000", "Мисс Ирония", "Профессор Хаос", "Зритель №1"];
      const now = Date.now();
      const rows = Array.from({ length: botCount }, (_, index) => ({
        room_id: roomId,
        telegram_user_id: -(now * 100 + index + 1),
        display_name: names[index % names.length],
        score: 0,
      }));
      const botResponse = await fetch(new URL("/rest/v1/room_players", env.SUPABASE_URL), {
        method: "POST",
        headers: {
          apikey: env.SUPABASE_SERVICE_ROLE_KEY,
          Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(rows),
      });
      if (!botResponse.ok) throw new Error(`Development bot autofill failed: ${botResponse.status} ${(await botResponse.text()).slice(0, 200)}`);
      await env.GAME_ROOMS.getByName(code).broadcast("room_changed", { code });
    }
  }

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
  const match = /^aud\|([A-HJ-NP-Z2-9]{5})\|(\d+)\|(\d+)\|([0-9a-f-]{20,40})$/i.exec(data);
  const message = query.message;
  const ack = async (text = "") => {
    const response = await fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/answerCallbackQuery`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ callback_query_id: query.id, text, show_alert: false }),
    });
    if (!response.ok) throw new Error(`Telegram callback acknowledgement failed: ${response.status}`);
  };
  if (!match || !message || !["group", "supergroup"].includes(message.chat.type)) {
    await ack("Эта кнопка голосования недействительна");
    return;
  }

  // Stop Telegram's button spinner before doing the database work.
  await ack("Проверяю и фиксирую голос…");
  const fail = async (text: string) => {
    try { await sendTelegramMessage(env, message.chat.id, text); }
    catch (error) { console.error(JSON.stringify({ level: "warn", message: "audience vote feedback failed", detail: error instanceof Error ? error.message : "unknown" })); }
  };

  try {
    const [, code, roundText, indexText, answerId] = match;
    const round = Number(roundText), promptIndex = Number(indexText);
    const rooms = await supabaseRequest<Array<{ id: string; status: string; round_number: number; voting_prompt_index: number; group_chat_id: number }>>(
      env, `rooms?code=eq.${code}&select=id,status,round_number,voting_prompt_index,group_chat_id&limit=1`,
    );
    const room = rooms[0];
    if (!room || Number(room.group_chat_id) !== message.chat.id || room.status !== "voting" ||
        Number(room.round_number) !== round || Number(room.voting_prompt_index || 0) !== promptIndex) {
      await fail("Это голосование уже закрыто.");
      return;
    }
    const playerRows = await supabaseRequest<Array<{ telegram_user_id: number }>>(
      env, `room_players?room_id=eq.${room.id}&telegram_user_id=eq.${query.from.id}&select=telegram_user_id&limit=1`,
    );
    if (playerRows.length) {
      await fail("Игроки голосуют в приложении. Голосование в чате — для зрителей.");
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
      await fail("Ответ не относится к текущему вопросу.");
      return;
    }

    // The Durable Object is the atomic per-question vote gate. Claim there
    // first so Telegram retries cannot create duplicate rows in Supabase.
    const display = displayName(query.from.first_name, query.from.last_name);
    const roomStub = env.GAME_ROOMS.getByName(code);
    const result = await roomStub.castAudienceVote({
      round, promptIndex, userId: query.from.id, answerId, userName: display,
    });
    if (!result.ok) {
      await fail(result.error || "Вы уже голосовали за этот вопрос.");
      return;
    }
    try {
      await supabaseRequest(env, "votes", {
        method: "POST",
        body: JSON.stringify({
          answer_id: answerId,
          prompt_id: target.prompt_id,
          voter_telegram_id: query.from.id,
        }),
      });
    } catch (error) {
      // Keep the DO and shared scoring table consistent if persistence fails.
      await roomStub.rollbackAudienceVote({ round, promptIndex, userId: query.from.id });
      throw error;
    }
    const ids = answers.filter(answer => pairOf(answer) === active.key).map(answer => answer.id);
    const letters = ["А", "Б", "В", "Г", "Д", "Е", "Ж", "З", "И", "К"];
    const inline_keyboard = ids.slice(0, 10).map((id, index) => [{
      text: `${letters[index]}. ${result.counts[id] || 0} голосов`,
      callback_data: `aud|${code}|${round}|${promptIndex}|${id}`,
    }]);
    const edited = await fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/editMessageReplyMarkup`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: message.chat.id, message_id: message.message_id, reply_markup: { inline_keyboard } }),
    });
    const editResult = await edited.json().catch(() => ({})) as { ok?: boolean; description?: string };
    if (!edited.ok || !editResult.ok) throw new Error(editResult.description || `Telegram markup update failed: ${edited.status}`);
  } catch (error) {
    console.error(JSON.stringify({ level: "error", message: "audience vote failed", detail: error instanceof Error ? error.message : "unknown" }));
    await fail("Не удалось сохранить голос. Попробуйте ещё раз или проголосуйте в приложении.");
  }
}

function displayName(first: string, last?: string): string {
  return [first, last].filter(Boolean).join(" ").slice(0, 80);
}

function randomRoomCode(): string {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const bytes = crypto.getRandomValues(new Uint8Array(5));
  return Array.from(bytes, byte => alphabet[byte % alphabet.length]).join("");
}
