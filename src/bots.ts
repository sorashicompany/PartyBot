import { PARTY_BOT_QUESTIONS, PARTY_GENERIC_ANSWERS, partyReplyForPrompt } from "./party-content";

export const BOT_PLAYERS = [
  { telegram_user_id: -900000001, display_name: "🤖 Бот Макс" },
  { telegram_user_id: -900000002, display_name: "🤖 Бот Луна" },
  { telegram_user_id: -900000003, display_name: "🤖 Бот Борис" }
] as const;

export function isBotPlayer(telegramUserId: number): boolean {
  return telegramUserId <= -900000001 && telegramUserId >= -900000003;
}

/** A short, prompt-aware reply from the Sorashi Party question deck. */
export function makeBotAnswer(seed: number, promptText?: string): string {
  return partyReplyForPrompt(seed, promptText) || PARTY_GENERIC_ANSWERS[Math.abs(seed) % PARTY_GENERIC_ANSWERS.length];
}

export function makeBotPrompt(seed: number): string {
  return PARTY_BOT_QUESTIONS[Math.abs(seed) % PARTY_BOT_QUESTIONS.length];
}
