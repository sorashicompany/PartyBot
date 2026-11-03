import { supabaseRequest } from "./supabase";
import { escapeHtml, sendTelegramMessage } from "./telegram";
import type { Env } from "./types";

export async function announce(env: Env, code: string, html: string, withButton = true): Promise<void> {
  try {
    if (!env.BOT_TOKEN) return;
    const rooms = await supabaseRequest<Array<{ group_chat_id: number }>>(
      env,
      `rooms?code=eq.${code}&select=group_chat_id&limit=1`,
    );
    const chatId = Number(rooms[0]?.group_chat_id);
    if (!Number.isFinite(chatId) || !chatId) return;
    const markup = withButton && env.BOT_USERNAME
      ? { inline_keyboard: [[{ text: "Открыть шоу", url: `https://t.me/${env.BOT_USERNAME}?startapp=${code}` }]] }
      : undefined;
    await sendTelegramMessage(env, chatId, html, markup, "HTML");
  } catch (error) {
    console.error(JSON.stringify({
      level: "warn",
      message: "group announce failed",
      detail: error instanceof Error ? error.message : "unknown",
    }));
  }
}

const LETTERS = ["А", "Б", "В", "Г", "Д", "Е", "Ж", "З", "И", "К"];

export async function announceVotingCard(env: Env, code: string, html: string, answerIds: string[], round: number, promptIndex: number): Promise<void> {  const rooms = await supabaseRequest<Array<{ group_chat_id: number }>>(env, `rooms?code=eq.${code}&select=group_chat_id&limit=1`);  const chatId = Number(rooms[0]?.group_chat_id);  if (!Number.isFinite(chatId) || !chatId || !answerIds.length) { await announce(env, code, html, true); return; }  const letters = ["А", "Б", "В", "Г", "Д", "Е", "Ж", "З", "И", "К"];  const inline_keyboard = answerIds.slice(0, 10).map((id, index) => [{ text: `${letters[index]}. Голосовать`, callback_data: `aud|${code}|${round}|${promptIndex}|${id}` }]);  await sendTelegramMessage(env, chatId, html, { inline_keyboard }, "HTML");}export function votingCardText(input: {
  round: number;
  index: number;
  total: number;
  prompt: string;
  answers: string[];
}): string {
  const lines = input.answers.length
    ? input.answers.slice(0, LETTERS.length).map((text, index) => `<b>${LETTERS[index]}.</b> ${escapeHtml(text)}`).join("\n")
    : "Оба автора промолчали. Этот вопрос сгорает.";
  return [
    `<b>Голосуем</b> · раунд ${input.round} · вопрос ${input.index + 1} из ${input.total}`,
    "",
    `<b>${escapeHtml(input.prompt)}</b>`,
    "",
    lines,
    "",
    "Имена авторов скрыты. Голосуйте за лучший ответ кнопками прямо под этим сообщением. Зрительский фаворит принесёт автору +500 очков.",
  ].join("\n");
}

export function scoreboardText(input: {
  title: string;
  highlight?: { prompt: string; answer: string; name: string; votes: number } | null;
  board: Array<{ name: string; score: number }>;
}): string {
  const board = [...input.board].sort((a, b) => b.score - a.score);
  const lines = board.slice(0, 10).map((row, index) => `${index + 1}. <b>${escapeHtml(row.name)}</b> — ${row.score.toLocaleString("ru-RU")}`);
  const best = input.highlight && input.highlight.votes > 0
    ? [`Панч раунда: «${escapeHtml(input.highlight.answer)}» — ${escapeHtml(input.highlight.name)} (${input.highlight.votes})`, `Вопрос: ${escapeHtml(input.highlight.prompt)}`, ""]
    : [];
  return [`<b>${escapeHtml(input.title)}</b>`, "", ...best, ...lines].join("\n");
}

export async function announceJoin(env: Env, code: string, name: string, count: number): Promise<void> {
  const need = count < 3 ? ` До старта ещё ${3 - count}.` : " Уже можно начинать.";
  await announce(
    env,
    code,
    `<b>${escapeHtml(name)}</b> садится в зал <b>${escapeHtml(code)}</b>.\nНа сцене: ${count} из 10.${need}`,
    true,
  );
}
