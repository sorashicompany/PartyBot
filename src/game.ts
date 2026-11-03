import { announce, announceVotingCard, scoreboardText, votingCardText } from "./announce";
import { escapeHtml } from "./telegram";
import { supabaseRequest } from "./supabase";
import type { Env } from "./types";

type MiniUser = { id: number; first_name: string; last_name?: string };
type Room = {
  id: string;
  code: string;
  host_telegram_id: number;
  status: string;
  round_number: number;
  phase_deadline_at?: string | null;
  voting_prompt_index?: number;
  custom_prompts_enabled?: boolean;
};
type Player = { telegram_user_id: number; display_name: string; score: number };
type Prompt = { id: string; prompt_text: string };
type Assignment = { id: string; prompt_id: string; player_telegram_id: number; pair_key?: string | null; prompt_slot?: number };
type Answer = { id: string; prompt_assignment_id: string; prompt_id?: string; author_telegram_id: number; answer_text: string; wager?: number };
type Vote = { answer_id: string; voter_telegram_id: number };
type Unit = { key: string; promptId: string };

const VOTING_MS = 22000;
const ANSWER_MS = 70000;
const CUSTOM_MS = 120000;

export async function handleGameRequest(request: Request, env: Env, user: MiniUser): Promise<Response> {
  const url = new URL(request.url);
  const body = request.method === "POST" ? await request.json() as Record<string, unknown> : {};
  const code = String(body.code || url.searchParams.get("code") || "").toUpperCase();
  if (!/^[A-HJ-NP-Z2-9]{5}$/.test(code)) return json({ error: "Неверный код комнаты" }, 400);

  const rooms = await supabaseRequest<Room[]>(env, `rooms?code=eq.${code}&select=id,code,host_telegram_id,status,round_number,phase_deadline_at,voting_prompt_index,custom_prompts_enabled&limit=1`);
  let room = rooms[0];
  if (!room) return json({ error: "Комната не найдена" }, 404);
  let players = await supabaseRequest<Player[]>(env, `room_players?room_id=eq.${room.id}&select=telegram_user_id,display_name,score&order=joined_at.asc`);
  if (!players.some(player => Number(player.telegram_user_id) === user.id)) return json({ error: "Вы не в этой комнате" }, 403);
  const advanced = await advanceExpiredPhase(env, room, players);
  room = advanced.room;
  players = advanced.players;

  if (url.pathname === "/api/game/state" && request.method === "GET") {
    return json(await getState(env, room, players, user.id));
  }

  if (url.pathname === "/api/game/settings" && request.method === "POST") {
    if (Number(room.host_telegram_id) !== user.id) return json({ error: "Только ведущий меняет настройки" }, 403);
    if (room.status !== "lobby") return json({ error: "Настройки закрыты: шоу уже идёт" }, 409);
    if (typeof body.customEnabled === "boolean") {
      await supabaseRequest(env, `rooms?id=eq.${room.id}`, { method: "PATCH", body: JSON.stringify({ custom_prompts_enabled: body.customEnabled }) });
    }
    if (typeof body.customPrompt === "string" && body.customPrompt.trim()) {
      const custom = await supabaseRequest<Array<{ id: string }>>(env, `room_custom_prompts?room_id=eq.${room.id}&select=id`);
      if (custom.length >= 50) return json({ error: "Максимум 50 своих вопросов" }, 400);
      const inserted = await supabaseRequest<Prompt[]>(env, "prompts", { method: "POST", body: JSON.stringify({ prompt_text: body.customPrompt.trim().slice(0, 240), locale: "ru", enabled: false }) });
      await supabaseRequest(env, "room_custom_prompts", { method: "POST", body: JSON.stringify({ room_id: room.id, prompt_text: body.customPrompt.trim().slice(0, 240), prompt_id: inserted[0]?.id, created_by_telegram_id: user.id }) });
    }
    return json({ ok: true });
  }

  if (url.pathname === "/api/game/start" && request.method === "POST") {
    if (Number(room.host_telegram_id) !== user.id) return json({ error: "Только ведущий запускает шоу" }, 403);
    if (room.status !== "lobby") return json({ error: "Шоу уже началось" }, 409);
    if (players.length < 3 || players.length > 10) return json({ error: "Нужно от 3 до 10 игроков" }, 409);
    // Rounds 1 and 2 always use two questions written by every player.
    await supabaseRequest(env, `rooms?id=eq.${room.id}`, {
      method: "PATCH",
      body: JSON.stringify({ custom_prompts_enabled: true }),
    });
    const deadline = new Date(Date.now() + CUSTOM_MS).toISOString();
    const won = await casRoom(env, room.id, { status: "lobby" }, { status: "custom_writing", phase_deadline_at: deadline, round_number: 1 });
    if (won) {
      await playBotQuestions(env, { ...room, status: "custom_writing", round_number: 1, custom_prompts_enabled: true }, players);
      await announce(env, code, "<b>Раунд 1 · вопросы игроков.</b>\nКаждый игрок придумывает два вопроса. На это две минуты. Автор не отвечает на собственные вопросы.", true);
    }
    return json({ ok: true, status: "custom_writing", round: 1 });
  }

  if (url.pathname === "/api/game/custom-prompts" && request.method === "POST") {
    if (room.status !== "custom_writing") return json({ error: "Сейчас вопросы не принимаются" }, 409);
    const question = String(body.prompt || "").replace(/\s+/g, " ").trim();
    const promptSlot = room.round_number === 3 ? 1 : Number(body.slot);
    if (![1, 2].includes(promptSlot)) return json({ error: "Укажите номер вопроса: 1 или 2" }, 400);
    if (question.length < 5 || question.length > 240) return json({ error: "Вопрос должен быть от 5 до 240 символов" }, 400);
    const writer = room.round_number === 3
      ? [...players].sort((a, b) => b.score - a.score)[0]
      : players.find(player => Number(player.telegram_user_id) === user.id);
    if (!writer || Number(writer.telegram_user_id) !== user.id) {
      return json({ error: room.round_number === 3 ? "Финальный вопрос пишет только лидер по очкам" : "Вы не можете отправить вопрос" }, 403);
    }
    const doRoom = env.GAME_ROOMS.getByName(code);
    const saved = await doRoom.getRoundQuestions(room.round_number);
    if (saved.some(item => Number(item.userId) === user.id && item.promptSlot === promptSlot)) return json({ error: "Этот вопрос уже отправлен" }, 409);
    const inserted = await supabaseRequest<Prompt[]>(env, "prompts", {
      method: "POST",
      body: JSON.stringify({ prompt_text: question, locale: "ru", enabled: false }),
    });
    if (!inserted[0]?.id) return json({ error: "Не удалось сохранить вопрос" }, 500);
    await doRoom.saveRoundQuestion({ round: room.round_number, userId: user.id, promptId: inserted[0].id, promptSlot });
    await notify(env, code, "room_changed", { code, customQuestionSubmitted: true });
    const questions = await doRoom.getRoundQuestions(room.round_number);
    const required = room.round_number === 3 ? 1 : players.length * 2;
    const done = room.round_number === 3
      ? questions.some(item => Number(item.userId) === user.id)
      : [1, 2].every(slot => questions.some(item => Number(item.userId) === user.id && item.promptSlot === slot));
    await announce(env, code, room.round_number === 3
      ? `<b>${escapeHtml(writer.display_name)}</b> придумал(а) финальный вопрос. Сам(а) на него не отвечает.`
      : `<b>${escapeHtml(writer.display_name)}</b> отправил(а) вопрос №${promptSlot}. Готово: <b>${questions.length}/${required}</b>.`, true);
    if (questions.length >= required) await beginCustomRound(env, room, players);
    return json({ ok: true, submitted: done, slot: promptSlot, count: questions.length, total: required });
  }
  if (url.pathname === "/api/game/answer" && request.method === "POST") {
    const answerText = String(body.text || "").trim().toLocaleLowerCase("ru-RU");
    if (room.status !== "answering") return json({ error: "Время ответов вышло" }, 409);
    if (answerText.length < 1 || answerText.length > 240) return json({ error: "Ответ: от 1 до 240 символов" }, 400);
    const assignments = await getAssignments(env, room);
    const ownAssignment = assignments.find(item => Number(item.player_telegram_id) === user.id && item.id === String(body.assignmentId || ""));
    if (!ownAssignment) return json({ error: "Этот вопрос не ваш" }, 409);
    const existing = await supabaseRequest<Answer[]>(env, `answers?prompt_assignment_id=eq.${ownAssignment.id}&select=id`);
    if (existing.length) return json({ error: "Ответ уже принят" }, 409);
    const score = players.find(p => Number(p.telegram_user_id) === user.id)?.score || 0;
    await supabaseRequest(env, "answers", { method: "POST", body: JSON.stringify({
      room_id: room.id,
      round_number: room.round_number,
      prompt_assignment_id: ownAssignment.id,
      prompt_id: ownAssignment.prompt_id,
      author_telegram_id: user.id,
      answer_text: answerText,
      wager: room.round_number === 3 ? Math.max(0, Math.min(Number(body.wager || 0), score)) : 0,
    }) });
    await notify(env, code, "room_changed", { code, answerSubmitted: true });
    const answers = await supabaseRequest<Answer[]>(env, `answers?room_id=eq.${room.id}&round_number=eq.${room.round_number}&select=id`);
    await announce(env, code, `Ответ принят: <b>${answers.length}/${assignments.length}</b>. Ответы останутся скрыты до голосования.`, false);
    if (answers.length >= assignments.length) await presentVoting(env, room, players, 0);
    return json({ ok: true, submitted: true, count: answers.length, total: assignments.length });
  }

  if (url.pathname === "/api/game/vote" && request.method === "POST") {
    if (room.status !== "voting") return json({ error: "Голосование закрыто" }, 409);
    const answerId = String(body.answerId || "");
    const assignments = await getAssignments(env, room);
    const units = votingUnits(assignments, room.round_number);
    const active = units[Number(room.voting_prompt_index || 0)];
    if (!active) return json({ error: "Этот вопрос уже закрыт" }, 409);
    const answers = await loadAnswers(env, room);
    const target = answers.find(answer => answer.id === answerId);
    if (!target || Number(target.author_telegram_id) === user.id) return json({ error: "Свой панч выбирать нельзя" }, 400);
    const pairOf = pairKeyFor(assignments);
    if (pairOf(target) !== active.key) return json({ error: "Сейчас на экране другой вопрос" }, 400);
    if (room.round_number !== 3 && assignments.some(item => Number(item.player_telegram_id) === user.id && (item.pair_key || item.prompt_id) === active.key)) {
      return json({ error: "Авторы этого вопроса не голосуют" }, 400);
    }
    const unitAnswerIds = answers.filter(answer => pairOf(answer) === active.key).map(answer => answer.id);
    const cast = unitAnswerIds.length
      ? await supabaseRequest<Vote[]>(env, `votes?answer_id=in.(${unitAnswerIds.join(",")})&voter_telegram_id=eq.${user.id}&select=answer_id,voter_telegram_id`)
      : [];
    if (cast.length) return json({ error: "Голос уже учтён" }, 409);
    await supabaseRequest(env, "votes", { method: "POST", body: JSON.stringify({ answer_id: answerId, prompt_id: target.prompt_id, voter_telegram_id: user.id }) });
    await notify(env, code, "room_changed", { code, playerVoteSubmitted: true });
    const settled = await settleVoting(env, room, players, false);
    return json({ ok: true, status: settled.room.status });
  }

  if (url.pathname === "/api/game/chat" && request.method === "POST") {
    if (room.status !== "voting") return json({ error: "Чат зала открыт только на голосовании" }, 409);
    const text = String(body.text || "").replace(/\s+/g, " ").trim();
    if (text.length < 1 || text.length > 160) return json({ error: "Сообщение: 1–160 символов" }, 400);
    const player = players.find(p => Number(p.telegram_user_id) === user.id);
    const scope = chatScope(room);
    const result = await env.GAME_ROOMS.getByName(code).postChat({
      scope,
      userId: user.id,
      name: player?.display_name || user.first_name,
      text,
    });
    if (result.error) return json({ error: result.error, messages: result.messages }, 429);
    await announce(env, code, `<b>Зал · ${escapeHtml(player?.display_name || user.first_name)}</b>\n${escapeHtml(text)}`, false);
    return json({ ok: true, messages: result.messages });
  }

  if (url.pathname === "/api/game/next" && request.method === "POST") {
    if (Number(room.host_telegram_id) !== user.id) return json({ error: "Дальше ведёт только ведущий" }, 403);
    if (room.status !== "round_results") return json({ error: "Сначала дождитесь итогов" }, 409);
    players = await ensureAwarded(env, room, players);
    if (room.round_number >= 3) {
      const won = await casRoom(env, room.id, { status: "round_results" }, { status: "finished", phase_deadline_at: null });
      if (won) {
        await announce(env, code, scoreboardText({ title: "Шоу окончено", board: players.map(player => ({ name: player.display_name, score: player.score })) }), true);
      }
      return json({ ok: true, status: "finished" });
    }
    const nextRound = room.round_number + 1;
    if (room.custom_prompts_enabled) {
      const deadline = new Date(Date.now() + CUSTOM_MS).toISOString();
      const won = await casRoom(env, room.id, { status: "round_results" }, {
        status: "custom_writing", round_number: nextRound, voting_prompt_index: 0, phase_deadline_at: deadline,
      });
      if (won) {
        await playBotQuestions(env, { ...room, status: "custom_writing", round_number: nextRound }, players);
        if (nextRound === 3) {
          const leader = [...players].sort((a, b) => b.score - a.score)[0];
          await announce(env, code, `<b>Финальный вопрос.</b> Лидер по очкам — <b>${escapeHtml(leader?.display_name || "Игрок")}</b>. Только он придумывает вопрос. Сам он на него не отвечает. Две минуты.`, true);
        } else {
          await announce(env, code, "<b>Свои вопросы · раунд 2.</b> Каждый игрок снова придумывает два вопроса. Автор не отвечает на собственные вопросы. Две минуты.", true);
        }
      }
      return json({ ok: true, status: "custom_writing", round: nextRound });
    }
    await beginRound(env, room, players, nextRound);
    return json({ ok: true, status: "answering", round: nextRound });
  }

  return json({ error: "Не найдено" }, 404);
}

async function getState(env: Env, room: Room, players: Player[], userId: number): Promise<Record<string, unknown>> {
  if (room.status === "round_results") players = await ensureAwarded(env, room, players);
  const assignments = room.round_number > 0 ? await getAssignments(env, room) : [];
  const units = votingUnits(assignments, room.round_number);
  const active = units[Number(room.voting_prompt_index || 0)] || null;
  const ownAssignments = assignments.filter(item => Number(item.player_telegram_id) === userId).sort((a, b) => (a.prompt_slot || 1) - (b.prompt_slot || 1));
  const promptIds = [...new Set(assignments.map(a => a.prompt_id))];
  const [prompts, submitted, myAnswers] = await Promise.all([
    promptIds.length
      ? supabaseRequest<Prompt[]>(env, `prompts?id=in.(${promptIds.join(",")})&select=id,prompt_text`)
      : Promise.resolve([] as Prompt[]),
    ["voting", "question_results", "round_results", "finished"].includes(room.status)
      ? loadAnswers(env, room)
      : Promise.resolve([] as Answer[]),
    ownAssignments.length
      ? supabaseRequest<Array<{ prompt_assignment_id: string }>>(env, `answers?prompt_assignment_id=in.(${ownAssignments.map(a => a.id).join(",")})&select=prompt_assignment_id`)
      : Promise.resolve([] as Array<{ prompt_assignment_id: string }>),
  ]);
  const votes = submitted.length
    ? await supabaseRequest<Vote[]>(env, `votes?answer_id=in.(${submitted.map(a => a.id).join(",")})&select=answer_id,voter_telegram_id`)
    : [];
  const pairOf = pairKeyFor(assignments);
  const names = Object.fromEntries(players.map(p => [String(p.telegram_user_id), p.display_name]));
  const revealNames = room.status === "question_results" || room.status === "round_results" || room.status === "finished";
  const activeAnswers = active ? submitted.filter(answer => pairOf(answer) === active.key) : [];
  const activeVotes = votes.filter(vote => activeAnswers.some(answer => answer.id === vote.answer_id));
  const playerIdsForState = new Set(players.map(player => Number(player.telegram_user_id)));
  const activePlayerVotes = activeVotes.filter(vote => playerIdsForState.has(Number(vote.voter_telegram_id)));
  const ownVoteTargets = votes.filter(v => Number(v.voter_telegram_id) === userId).map(v => v.answer_id);
  const voteCounts = Object.fromEntries(submitted.map(a => [a.id, votes.filter(v => v.answer_id === a.id).length]));
  const audienceRows = room.status === "question_results"
    ? await env.GAME_ROOMS.getByName(room.code).getAudienceVoters(room.round_number, Number(room.voting_prompt_index || 0))
    : [];
  const audienceNameById = new Map(audienceRows.map(row => [row.userId, row.userName]));
  const audienceCounts = room.status === "question_results"
    ? await env.GAME_ROOMS.getByName(room.code).getAudienceCounts(room.round_number, Number(room.voting_prompt_index || 0))
    : {};
  const resultPoints = new Map<string, number>();
  if (room.status === "question_results" && room.round_number !== 3 && active) {
    const playerVoteRows = activeVotes.filter(vote => playerIdsForState.has(Number(vote.voter_telegram_id)));
    const totalPlayerVotes = playerVoteRows.length;
    const eligible = expectedVoters(room.round_number, players, assignments, active.key);
    const audienceHigh = Math.max(0, ...Object.values(audienceCounts));
    const audienceWinners = activeAnswers.filter(answer => audienceHigh > 0 && (audienceCounts[answer.id] || 0) === audienceHigh);
    const audienceShare = audienceWinners.length ? Math.floor(500 / audienceWinners.length) : 0;
    for (const answerItem of activeAnswers) {
      const playerCount = playerVoteRows.filter(vote => vote.answer_id === answerItem.id).length;
      const sweep = playerCount > 0 && playerCount === totalPlayerVotes && playerCount >= eligible ? 1000 : 0;
      const audienceBonus = audienceWinners.some(item => item.id === answerItem.id) ? audienceShare : 0;
      const raw = playerCount * 1000 + sweep + audienceBonus;
      const author = players.find(player => Number(player.telegram_user_id) === Number(answerItem.author_telegram_id));
      resultPoints.set(answerItem.id, author ? Math.max(0, author.score + raw) - author.score : raw);
    }
  }
  const roomQuestionsCache = room.status === "custom_writing"
    ? await env.GAME_ROOMS.getByName(room.code).getRoundQuestions(room.round_number) : [];
  const scope = chatScope(room);
  let chat: Array<{ id: number; name: string; text: string; mine: boolean; at: number }> = [];
  if (room.status === "voting") {
    try { chat = await env.GAME_ROOMS.getByName(room.code).listChat(scope, userId); }
    catch (error) { console.error(JSON.stringify({ level: "warn", message: "chat read failed", detail: error instanceof Error ? error.message : "unknown" })); }
  }
  const showPrompts = room.round_number === 3
    ? ownAssignments
    : ownAssignments.filter(a => !myAnswers.some(x => x.prompt_assignment_id === a.id));
  return {
    code: room.code,
    status: room.status,
    round: room.round_number,
    deadline: room.phase_deadline_at || null,
    customPromptCount: room.status === "custom_writing" ? roomQuestionsCache.length : 0,
    customPromptSubmitted: room.status === "custom_writing"
      ? (room.round_number === 3
        ? roomQuestionsCache.some(item => Number(item.userId) === userId)
        : [1, 2].every(slot => roomQuestionsCache.some(item => Number(item.userId) === userId && item.promptSlot === slot))) : false,
    customPromptSubmittedSlots: roomQuestionsCache.filter(item => Number(item.userId) === userId).map(item => item.promptSlot),
    customPromptRequired: room.status === "custom_writing" ? (room.round_number === 3 ? 1 : players.length * 2) : 0,
    customPromptWriterName: room.status === "custom_writing" && room.round_number === 3
      ? ([...players].sort((a, b) => b.score - a.score)[0]?.display_name || "") : "",
    isCustomPromptWriter: room.status === "custom_writing" && (room.round_number === 3
      ? Number([...players].sort((a, b) => b.score - a.score)[0]?.telegram_user_id) === userId : true),
    isFinalQuestionAuthor: room.round_number === 3 && assignments.length > 0 && !ownAssignments.length,
    votingPromptIndex: room.voting_prompt_index || 0,
    votingPromptTotal: units.length,
    customPromptsEnabled: Boolean(room.custom_prompts_enabled),
    players: players.map(p => ({
      name: p.display_name,
      score: p.score,
      isHost: Number(room.host_telegram_id) === Number(p.telegram_user_id),
      you: Number(p.telegram_user_id) === userId,
    })),
    prompts: showPrompts.map(a => ({
      assignmentId: a.id,
      promptId: a.prompt_id,
      text: prompts.find(p => p.id === a.prompt_id)?.prompt_text || "",
      answered: myAnswers.some(x => x.prompt_assignment_id === a.id),
      slot: a.prompt_slot || 1,
    })),
    promptLabels: Object.fromEntries(prompts.map(p => [p.id, p.prompt_text])),
    activeVotingPromptId: active?.promptId || null,
    activePairKey: active?.key || null,
    isPromptAuthor: room.round_number !== 3 && Boolean(active) && assignments.some(a => Number(a.player_telegram_id) === userId && (a.pair_key || a.prompt_id) === active?.key),
    answers: submitted.map(a => ({
      id: a.id,
      promptId: a.prompt_id,
      pairKey: pairOf(a),
      text: a.answer_text,
      name: revealNames ? names[String(a.author_telegram_id)] : undefined,
      own: Number(a.author_telegram_id) === userId,
      votes: voteCounts[a.id] || 0,
      voters: revealNames ? votes.filter(vote => vote.answer_id === a.id).map(vote =>
        names[String(vote.voter_telegram_id)] || audienceNameById.get(Number(vote.voter_telegram_id)) || "Зритель") : [],
      points: resultPoints.get(a.id),
      voted: ownVoteTargets.includes(a.id),
      wager: a.wager || 0,
    })),
    unitVotes: new Set(activePlayerVotes.map(vote => Number(vote.voter_telegram_id))).size,
    unitVotesNeeded: active ? expectedVoters(room.round_number, players, assignments, active.key) : 0,
    votesCast: ownVoteTargets.length,
    votesNeeded: units.length,
    chat,
    isHost: Number(room.host_telegram_id) === userId,
  };
}

async function advanceExpiredPhase(env: Env, room: Room, players: Player[]): Promise<{ room: Room; players: Player[] }> {
  if (!room.phase_deadline_at || Date.now() < Date.parse(room.phase_deadline_at)) return { room, players };
  if (room.status === "custom_writing") {
    await beginCustomRound(env, room, players);
    const current = (await freshRoom(env, room.code)) || { ...room, status: "answering", phase_deadline_at: new Date(Date.now() + ANSWER_MS).toISOString() };
    return { room: current, players };
  }
  if (room.status === "answering") {
    const next = await presentVoting(env, room, players, 0);
    return { room: next, players };
  }
  if (room.status === "question_results") {
    const next = await presentVoting(env, room, players, Number(room.voting_prompt_index || 0) + 1);
    return { room: next, players: next.status === "round_results" ? await reloadPlayers(env, room.id) : players };
  }
  if (room.status === "voting") {
    const next = await settleVoting(env, room, players, true);
    return next;
  }
  return { room, players };
}

async function presentVoting(env: Env, room: Room, players: Player[], startIndex: number): Promise<Room> {
  const [assignments, answers] = await Promise.all([getAssignments(env, room), loadAnswers(env, room)]);
  const units = votingUnits(assignments, room.round_number);
  const pairOf = pairKeyFor(assignments);
  let index = startIndex;
  while (index < units.length && answers.filter(answer => pairOf(answer) === units[index].key).length === 0) index += 1;
  if (index >= units.length) return enterResults(env, room, players);
  const expectStatus = room.status;
  const expect: Record<string, string | number> = { status: expectStatus };
  if (expectStatus === "voting" || expectStatus === "question_results") {
    expect.voting_prompt_index = Number(room.voting_prompt_index || 0);
  }
  const deadline = new Date(Date.now() + VOTING_MS).toISOString();
  const won = await casRoom(env, room.id, expect, { status: "voting", voting_prompt_index: index, phase_deadline_at: deadline });
  if (!won) return (await freshRoom(env, room.code)) || { ...room, status: "voting", voting_prompt_index: index, phase_deadline_at: deadline };
  const next = { ...room, status: "voting", voting_prompt_index: index, phase_deadline_at: deadline };
  await narrateVotingCard(env, next, assignments, answers, units, index);
  // Bot votes and room fan-out are independent once the voting card is live.
  await Promise.all([
    notify(env, room.code, "voting_started", { round: room.round_number, index }),
    playBotVotes(env, next, players, assignments, answers, units, index),
  ]);
  return next;
}

async function settleVoting(env: Env, room: Room, players: Player[], force: boolean): Promise<{ room: Room; players: Player[] }> {
  const assignments = await getAssignments(env, room);
  const units = votingUnits(assignments, room.round_number);
  const index = Number(room.voting_prompt_index || 0);
  const active = units[index];
  if (!active) {
    const finished = await enterResults(env, room, players);
    const scored = await reloadPlayers(env, room.id);
    return { room: finished, players: scored };
  }
  const answers = await loadAnswers(env, room);
  const pairOf = pairKeyFor(assignments);
  const unitAnswers = answers.filter(answer => pairOf(answer) === active.key);
  if (!force && unitAnswers.length) {
    const playerIds = players.map(player => Number(player.telegram_user_id));
    const votes = await supabaseRequest<Vote[]>(env, `votes?answer_id=in.(${unitAnswers.map(answer => answer.id).join(",")})&voter_telegram_id=in.(${playerIds.join(",")})&select=answer_id,voter_telegram_id`);
    const voters = new Set(votes.map(vote => Number(vote.voter_telegram_id)));
    if (voters.size < expectedVoters(room.round_number, players, assignments, active.key)) return { room, players };
  }
  await announceQuestionResults(env, room, players, active, unitAnswers, index);
  // Pause on a dedicated reveal screen so every player sees authors, voters
  // and the per-answer award before the next voting card appears.
  const deadline = new Date(Date.now() + 8000).toISOString();
  const won = await casRoom(env, room.id, {
    status: "voting",
    voting_prompt_index: index,
  }, {
    status: "question_results",
    phase_deadline_at: deadline,
  });
  const moved = won
    ? { ...room, status: "question_results", voting_prompt_index: index, phase_deadline_at: deadline }
    : (await freshRoom(env, room.code)) || room;
  return { room: moved, players };
}

async function announceQuestionResults(
  env: Env,
  room: Room,
  players: Player[],
  unit: Unit,
  answers: Answer[],
  promptIndex: number,
): Promise<void> {
  if (!answers.length) return;
  const claimed = await env.GAME_ROOMS.getByName(room.code).claimQuestionReveal(room.round_number, promptIndex);
  if (!claimed) return;
  const ids = answers.map(answer => answer.id);
  const [votes, audienceVotes, audienceCounts, prompt, assignments] = await Promise.all([
    supabaseRequest<Vote[]>(env, `votes?answer_id=in.(${ids.join(",")})&select=answer_id,voter_telegram_id`),
    env.GAME_ROOMS.getByName(room.code).getAudienceVoters(room.round_number, promptIndex),
    env.GAME_ROOMS.getByName(room.code).getAudienceCounts(room.round_number, promptIndex),
    supabaseRequest<Prompt[]>(env, `prompts?id=eq.${unit.promptId}&select=id,prompt_text&limit=1`),
    getAssignments(env, room),
  ]);
  const playerIds = new Set(players.map(player => Number(player.telegram_user_id)));
  const playerVotes = votes.filter(vote => playerIds.has(Number(vote.voter_telegram_id)));
  const names = new Map(players.map(player => [Number(player.telegram_user_id), player.display_name]));
  const eligible = expectedVoters(room.round_number, players, assignments, unit.key);
  const totalPlayerVotes = playerVotes.length;
  const playerCounts = answers.map(answer => ({
    answer,
    count: playerVotes.filter(vote => vote.answer_id === answer.id).length,
  }));
  const audienceHigh = Math.max(0, ...Object.values(audienceCounts));
  const audienceWinners = answers.filter(answer => audienceHigh > 0 && (audienceCounts[answer.id] || 0) === audienceHigh);
  const audienceShare = audienceWinners.length ? Math.floor(500 / audienceWinners.length) : 0;
  const finalHigh = Math.max(0, ...playerCounts.map(row => row.count));
  const finalWinners = answers.filter(answer => finalHigh > 0 && (playerCounts.find(row => row.answer.id === answer.id)?.count || 0) === finalHigh);
  const finalPool = answers.reduce((sum, answer) => sum + Math.min(Number(answer.wager || 0), 1000000), 0);
  const finalShare = finalWinners.length ? Math.floor(finalPool / finalWinners.length) : 0;
  const lines = answers.map(({ id, author_telegram_id, answer_text }) => {
    const playerCount = playerCounts.find(row => row.answer.id === id)?.count || 0;
    const audienceCount = audienceCounts[id] || 0;
    const voters = [
      ...playerVotes.filter(vote => vote.answer_id === id).map(vote => names.get(Number(vote.voter_telegram_id)) || "Игрок"),
      ...audienceVotes.filter(vote => vote.answerId === id).map(vote => vote.userName),
    ];
    const sweep = room.round_number !== 3 && playerCount > 0 && playerCount === totalPlayerVotes && playerCount >= eligible ? 1000 : 0;
    const audienceBonus = audienceWinners.some(answer => answer.id === id) ? audienceShare : 0;
    const rawPoints = room.round_number === 3
      ? -Math.min(Number(answers.find(answer => answer.id === id)?.wager || 0), 1000000) + (finalWinners.some(answer => answer.id === id) ? finalShare : 0) + audienceBonus
      : playerCount * 1000 + sweep + audienceBonus;
    const author = players.find(player => Number(player.telegram_user_id) === Number(author_telegram_id));
    const points = author ? Math.max(0, author.score + rawPoints) - author.score : rawPoints;
    const pointLabel = `${points > 0 ? "+" : ""}${points.toLocaleString("ru-RU")} очков`;
    return `<b>${escapeHtml(names.get(Number(author_telegram_id)) || "Игрок")}</b>: «${escapeHtml(answer_text)}»\nГолоса: <b>${playerCount + audienceCount}</b> (игроки: ${playerCount}, зрители: ${audienceCount})\nКто голосовал: ${voters.length ? voters.map(escapeHtml).join(", ") : "нет голосов"}\n${pointLabel}`;
  });
  await announce(env, room.code, [
    `<b>Итоги вопроса · раунд ${room.round_number}</b>`,
    escapeHtml(prompt[0]?.prompt_text || "Вопрос"),
    "",
    ...lines,
  ].join("\n\n"), false);
}

async function enterResults(env: Env, room: Room, players: Player[]): Promise<Room> {
  const expect: Record<string, string | number> = { status: room.status };
  if (room.status === "voting" || room.status === "question_results") {
    expect.voting_prompt_index = Number(room.voting_prompt_index || 0);
  }
  const won = await casRoom(env, room.id, expect, {
    status: "round_results",
    phase_deadline_at: null,
  });
  if (!won) {
    const current = (await freshRoom(env, room.code)) || { ...room, status: "round_results", phase_deadline_at: null };
    if (current.status === "round_results" || current.status === "finished") await ensureAwarded(env, room, players);
    return current;
  }
  const scored = await ensureAwarded(env, room, players);
  const highlight = await bestLaugh(env, room, scored);
  await announce(env, room.code, scoreboardText({
    title: `Раунд ${room.round_number} закрыт`,
    highlight,
    board: scored.map(player => ({ name: player.display_name, score: player.score })),
  }), true);
  await notify(env, room.code, "round_results", { round: room.round_number });
  return { ...room, status: "round_results", phase_deadline_at: null };
}

async function ensureAwarded(env: Env, room: Room, players: Player[]): Promise<Player[]> {
  if (room.round_number < 1) return players;
  const claimed = await env.GAME_ROOMS.getByName(room.code).claimRoundAward(room.round_number);
  if (!claimed) return reloadPlayers(env, room.id);
  await awardRoundPoints(env, room, players);
  return reloadPlayers(env, room.id);
}

async function narrateVotingCard(env: Env, room: Room, assignments: Assignment[], answers: Answer[], units: Unit[], index: number): Promise<void> {
  const unit = units[index];
  if (!unit) return;
  const prompts = await supabaseRequest<Prompt[]>(env, `prompts?id=eq.${unit.promptId}&select=id,prompt_text&limit=1`);
  const pairOf = pairKeyFor(assignments);
  const unitAnswers = answers.filter(answer => pairOf(answer) === unit.key);
  const texts = unitAnswers.map(answer => answer.answer_text);
  const html = votingCardText({
    round: room.round_number,
    index,
    total: units.length,
    prompt: prompts[0]?.prompt_text || "Вопрос сгорел по дороге",
    answers: texts,
  });
  await announceVotingCard(env, room.code, html, unitAnswers.map(answer => answer.id), room.round_number, index);
}

async function bestLaugh(env: Env, room: Room, players: Player[]): Promise<{ prompt: string; answer: string; name: string; votes: number } | null> {
  const answers = await loadAnswers(env, room);
  if (!answers.length) return null;
  const votes = await supabaseRequest<Vote[]>(env, `votes?answer_id=in.(${answers.map(answer => answer.id).join(",")})&select=answer_id,voter_telegram_id`);
  const prompts = await supabaseRequest<Prompt[]>(env, `prompts?id=in.(${[...new Set(answers.map(answer => answer.prompt_id).filter(Boolean))].join(",")})&select=id,prompt_text`);
  const names = Object.fromEntries(players.map(player => [String(player.telegram_user_id), player.display_name]));
  let best: { prompt: string; answer: string; name: string; votes: number } | null = null;
  for (const answer of answers) {
    const count = votes.filter(vote => vote.answer_id === answer.id).length;
    if (!best || count > best.votes) {
      best = {
        prompt: prompts.find(prompt => prompt.id === answer.prompt_id)?.prompt_text || "",
        answer: answer.answer_text,
        name: names[String(answer.author_telegram_id)] || "Кто-то",
        votes: count,
      };
    }
  }
  return best;
}

async function getAssignments(env: Env, room: Room): Promise<Assignment[]> {
  if (!room.round_number) return [];
  return supabaseRequest<Assignment[]>(env, `round_prompts?room_id=eq.${room.id}&round_number=eq.${room.round_number}&select=id,prompt_id,player_telegram_id,pair_key,prompt_slot&order=created_at.asc`);
}

async function loadAnswers(env: Env, room: Room): Promise<Answer[]> {
  return supabaseRequest<Answer[]>(env, `answers?room_id=eq.${room.id}&round_number=eq.${room.round_number}&select=id,prompt_assignment_id,prompt_id,author_telegram_id,answer_text,wager`);
}

async function reloadPlayers(env: Env, roomId: string): Promise<Player[]> {
  return supabaseRequest<Player[]>(env, `room_players?room_id=eq.${roomId}&select=telegram_user_id,display_name,score&order=joined_at.asc`);
}

function votingUnits(assignments: Assignment[], round: number): Unit[] {
  if (!assignments.length) return [];
  if (round === 3) return [{ key: "final", promptId: assignments[0].prompt_id }];
  const units: Unit[] = [];
  for (const assignment of assignments) {
    const key = assignment.pair_key || assignment.prompt_id;
    if (!units.some(unit => unit.key === key)) units.push({ key, promptId: assignment.prompt_id });
  }
  return units;
}

function pairKeyFor(assignments: Assignment[]): (answer: Answer) => string {
  const byAssignment = new Map(assignments.map(item => [item.id, item.pair_key || item.prompt_id]));
  return (answer) => byAssignment.get(answer.prompt_assignment_id) || answer.prompt_id || "";
}

function expectedVoters(round: number, players: Player[], assignments: Assignment[], unitKey: string): number {
  if (round === 3) return players.length;
  const authors = new Set(assignments.filter(item => (item.pair_key || item.prompt_id) === unitKey).map(item => Number(item.player_telegram_id)));
  return Math.max(0, players.length - authors.size);
}

function chatScope(room: Room): string {
  return `${room.round_number}:${room.voting_prompt_index || 0}`;
}


const BOT_ANSWER_TEMPLATES = [
  "я бы сделал вид, что так и было задумано, и попросил за это доплату",
  "позвал бы свидетелей, но они уже заблокировали меня",
  "сначала уверенно сказал бы «без паники», а потом запаниковал",
  "это был план б, план а мы потеряли ещё до начала",
  "объявил бы это новой традицией и назначил себя главным",
  "сказал бы, что это интерактив, и собрал донаты",
  "списал бы всё на ретроградный холодильник",
  "молча ушёл бы за хлебом и вернулся в следующем сезоне",
  "попросил бы инструкцию у человека, который тоже ничего не понял",
  "сделал бы презентацию на сорок слайдов и назвал это решением",
  "уверенно кивнул бы, потому что уверенность — это половина ответа",
  "позвонил бы маме. у неё на всё есть отдельный пакет с пакетами",
];

function botAnswer(prompt: string, botId: number, round: number): string {
  const normalized = prompt.replace(/\s+/g, " ").trim().replace(/[?!.]+$/, "").toLocaleLowerCase("ru-RU");
  const hash = Math.abs([...normalized].reduce((sum, char) => sum * 31 + char.charCodeAt(0), botId * 17 + round));
  const punchline = BOT_ANSWER_TEMPLATES[hash % BOT_ANSWER_TEMPLATES.length];
  const lead = ["мой официальный план:", "короткий ответ:", "по версии экспертов:", "я провёл исследование и выяснил:"][hash % 4];
  const context = normalized.length > 48 ? `${normalized.slice(0, 45)}…` : normalized;
  return `${lead} если речь про «${context}»: ${punchline}`.slice(0, 240);
}

async function playBotAnswers(env: Env, room: Room, players: Player[]): Promise<void> {
  const bots = players.filter(player => Number(player.telegram_user_id) < 0);
  if (!bots.length) return;
  const assignments = await getAssignments(env, room);
  const botAssignments = assignments.filter(item => Number(item.player_telegram_id) < 0);
  if (!botAssignments.length) return;
  const existing = await supabaseRequest<Array<{ prompt_assignment_id: string }>>(
    env,
    `answers?prompt_assignment_id=in.(${botAssignments.map(item => item.id).join(",")})&select=prompt_assignment_id`,
  );
  const answered = new Set(existing.map(item => item.prompt_assignment_id));
  const promptIds = [...new Set(botAssignments.map(item => item.prompt_id))];
  const prompts = promptIds.length
    ? await supabaseRequest<Prompt[]>(env, `prompts?id=in.(${promptIds.join(",")})&select=id,prompt_text`)
    : [];
  const promptText = new Map(prompts.map(prompt => [prompt.id, prompt.prompt_text]));
  const rows = botAssignments.filter(item => !answered.has(item.id)).map(item => ({
    room_id: room.id,
    round_number: room.round_number,
    prompt_assignment_id: item.id,
    prompt_id: item.prompt_id,
    author_telegram_id: Number(item.player_telegram_id),
    answer_text: botAnswer(promptText.get(item.prompt_id) || "что делать?", Number(item.player_telegram_id), room.round_number),
    wager: 0,
  }));
  if (rows.length) {
    await supabaseRequest(env, "answers", { method: "POST", body: JSON.stringify(rows) });
    await notify(env, room.code, "room_changed", { code: room.code, botAnswers: rows.length });
  }
}

async function playBotVotes(
  env: Env,
  room: Room,
  players: Player[],
  assignments: Assignment[],
  answers: Answer[],
  units: Unit[],
  index: number,
): Promise<void> {
  const bots = players.filter(player => Number(player.telegram_user_id) < 0);
  const unit = units[index];
  if (!bots.length || !unit) return;
  const pairOf = pairKeyFor(assignments);
  const options = answers.filter(answer => pairOf(answer) === unit.key);
  if (options.length < 2) return;
  const eligibleBots = bots.filter(bot => room.round_number === 3
    || !assignments.some(item => Number(item.player_telegram_id) === Number(bot.telegram_user_id)
      && (item.pair_key || item.prompt_id) === unit.key));
  const allIds = options.map(answer => answer.id);
  const botIds = eligibleBots.map(bot => Number(bot.telegram_user_id));
  const existing = allIds.length && botIds.length
    ? await supabaseRequest<Vote[]>(env, `votes?answer_id=in.(${allIds.join(",")})&voter_telegram_id=in.(${botIds.join(",")})&select=answer_id,voter_telegram_id`)
    : [];
  const voted = new Set(existing.map(vote => `${vote.voter_telegram_id}:${vote.answer_id}`));
  const alreadyVoted = new Set(existing.map(vote => Number(vote.voter_telegram_id)));
  const rows = eligibleBots.flatMap(bot => {
    if (alreadyVoted.has(Number(bot.telegram_user_id))) return [];
    const eligibleAnswers = options.filter(answer => Number(answer.author_telegram_id) !== Number(bot.telegram_user_id));
    if (!eligibleAnswers.length) return [];
    const pickIndex = Math.abs(Number(bot.telegram_user_id) + room.round_number * 19 + index * 7) % eligibleAnswers.length;
    const picked = eligibleAnswers[pickIndex];
    return voted.has(`${bot.telegram_user_id}:${picked.id}`) ? [] : [{
      answer_id: picked.id, prompt_id: picked.prompt_id, voter_telegram_id: Number(bot.telegram_user_id),
    }];
  });
  if (rows.length) {
    await supabaseRequest(env, "votes", { method: "POST", body: JSON.stringify(rows) });
    await notify(env, room.code, "room_changed", { code: room.code, botVotes: rows.length });
  }
}

function botQuestion(bot: Player, round: number, slot = 1): string {
  const subjects = ["на вечеринке", "в семейном чате", "на первом свидании", "в офисе в понедельник", "во время важного собеседования", "в отпуске с друзьями", "на свадьбе", "в очереди за кофе"];
  const twists = ["Что самое нелепое может пойти не так", "Какой самый странный поступок можно совершить", "Как объяснить окружающим, почему внезапно", "Что гарантированно превратит обычный день в легенду", "Какой секрет лучше никогда не раскрывать", "Как выкрутиться, если внезапно выяснилось"];
  const seed = Math.abs(Number(bot.telegram_user_id)) + round * 31 + slot * 13;
  return `${twists[seed % twists.length]} ${subjects[Math.floor(seed / 7) % subjects.length]}?`;
}

async function playBotQuestions(env: Env, room: Room, players: Player[]): Promise<void> {
  const round = room.round_number;
  const leader = [...players].sort((a, b) => b.score - a.score)[0];
  const writers = round === 3 ? (leader && Number(leader.telegram_user_id) < 0 ? [leader] : []) : players.filter(player => Number(player.telegram_user_id) < 0);
  if (!writers.length) return;
  const doRoom = env.GAME_ROOMS.getByName(room.code);
  const existing = await doRoom.getRoundQuestions(round);
  const submitted = new Set(existing.map(item => `${item.userId}:${item.promptSlot}`));
  const slots = round === 3 ? [1] : [1, 2];
  const pending = writers.flatMap(bot => slots
    .filter(slot => !submitted.has(`${bot.telegram_user_id}:${slot}`))
    .map(slot => ({ bot, slot })));
  const created = await Promise.all(pending.map(async ({ bot, slot }) => {
    const inserted = await supabaseRequest<Prompt[]>(env, "prompts", {
      method: "POST",
      body: JSON.stringify({ prompt_text: botQuestion(bot, round, slot), locale: "ru", enabled: false }),
    });
    return inserted[0]?.id ? { userId: Number(bot.telegram_user_id), promptId: inserted[0].id, slot } : null;
  }));
  await Promise.all(created.filter((item): item is NonNullable<typeof item> => Boolean(item)).map(item =>
    doRoom.saveRoundQuestion({ round, userId: item.userId, promptId: item.promptId, promptSlot: item.slot })));
  if (created.some(Boolean)) await notify(env, room.code, "room_changed", { code: room.code, botQuestions: created.filter(Boolean).length });
}

async function beginCustomRound(env: Env, room: Room, players: Player[]): Promise<void> {
  const round = room.round_number;
  const doRoom = env.GAME_ROOMS.getByName(room.code);
  let questions = await doRoom.getRoundQuestions(round);
  const leader = [...players].sort((a, b) => b.score - a.score)[0];
  const writers = round === 3 ? (leader ? [leader] : []) : players;
  const slots = round === 3 ? [1] : [1, 2];
  const submitted = new Set(questions.map(item => `${item.userId}:${item.promptSlot}`));
  const missing = writers.flatMap(writer => slots
    .filter(slot => !submitted.has(`${writer.telegram_user_id}:${slot}`))
    .map(slot => ({ writer, slot })));
  const fallbacks = await Promise.all(missing.map(async ({ writer, slot }) => {
    const text = round === 3
      ? "Какой поступок гарантированно превратит обычный день в легенду?"
      : slot === 1
        ? "Что самое нелепое может случиться на вечеринке?"
        : "Как выкрутиться, если случайно отправил сообщение не в тот чат?";
    const inserted = await supabaseRequest<Prompt[]>(env, "prompts", {
      method: "POST",
      body: JSON.stringify({ prompt_text: text, locale: "ru", enabled: false }),
    });
    return inserted[0]?.id ? { userId: Number(writer.telegram_user_id), promptId: inserted[0].id, slot } : null;
  }));
  await Promise.all(fallbacks.filter((item): item is NonNullable<typeof item> => Boolean(item)).map(item =>
    doRoom.saveRoundQuestion({ round, userId: item.userId, promptId: item.promptId, promptSlot: item.slot })));
  questions = await doRoom.getRoundQuestions(round);
  const existing = await supabaseRequest<Array<{ id: string }>>(env, `round_prompts?room_id=eq.${room.id}&round_number=eq.${round}&select=id&limit=1`);
  if (existing.length) return;
  const won = await casRoom(env, room.id, { status: "custom_writing", round_number: round }, {
    status: "answering", phase_deadline_at: new Date(Date.now() + ANSWER_MS).toISOString(), voting_prompt_index: 0,
  });
  if (!won) return;
  const rows: Array<Record<string, unknown>> = [];
  const questionBySlot = new Map(questions.map(item => [`${item.userId}:${item.promptSlot}`, item]));
  if (round === 3) {
    if (leader) {
      const question = questionBySlot.get(`${leader.telegram_user_id}:1`);
      if (question) for (const player of players) {
        if (Number(player.telegram_user_id) === Number(leader.telegram_user_id)) continue;
        rows.push({ room_id: room.id, round_number: round, prompt_id: question.promptId, player_telegram_id: player.telegram_user_id, pair_key: "final", prompt_slot: 1 });
      }
    }
  } else {
    for (let index = 0; index < players.length; index++) {
      const writer = players[index];
      for (const slot of [1, 2]) {
        const question = questionBySlot.get(`${writer.telegram_user_id}:${slot}`);
        if (!question) continue;
        const offset = slot === 1 ? 1 : 2;
        const respondents = [players[(index + offset) % players.length], players[(index + offset + 1) % players.length]];
        const pairKey = `custom-${round}-${writer.telegram_user_id}-${slot}`;
        for (const player of respondents) rows.push({
          room_id: room.id, round_number: round, prompt_id: question.promptId,
          player_telegram_id: player.telegram_user_id, pair_key: pairKey, prompt_slot: slot,
        });
      }
    }
  }
  if (rows.length) await supabaseRequest(env, "round_prompts", { method: "POST", body: JSON.stringify(rows) });
  const label = round === 3 ? "Финал. Вопрос лидера — отвечают остальные игроки." : `Раунд ${round} из 3. Каждый игрок задал два вопроса; на каждый отвечают два игрока, кроме автора.`;
  await Promise.all([
    announce(env, room.code, `<b>${label}</b>\nОтветы пишутся в приложении. Вопросы появятся на голосовании без имён авторов ответов.`, true),
    notify(env, room.code, "next_round", { round }),
    playBotAnswers(env, room, players),
  ]);
}

async function beginRound(env: Env, room: Room, players: Player[], round: number): Promise<void> {
  const existing = await supabaseRequest<Array<{ id: string }>>(env, `round_prompts?room_id=eq.${room.id}&round_number=eq.${round}&select=id&limit=1`);
  const fromStatus = room.status === "lobby" || room.status === "custom_writing" || room.status === "round_results" ? room.status : "lobby";
  const deadline = new Date(Date.now() + ANSWER_MS).toISOString();
  if (existing.length) {
    if (room.status !== "answering") {
      await casRoom(env, room.id, { status: room.status }, {
        status: "answering",
        round_number: round,
        voting_prompt_index: 0,
        phase_deadline_at: deadline,
      });
    }
    return;
  }
  const won = await casRoom(env, room.id, { status: fromStatus }, {
    status: "answering",
    round_number: round,
    voting_prompt_index: 0,
    phase_deadline_at: deadline,
  });
  if (!won) return;
  const needed = round === 3 ? 1 : players.length;
  const deck = await ensurePromptPool(env, room, needed);
  const shuffled = [...players].sort(() => Math.random() - 0.5);
  const rows: Array<Record<string, unknown>> = [];
  if (round === 3) {
    for (const player of shuffled) {
      rows.push({ room_id: room.id, round_number: round, prompt_id: deck[0].id, player_telegram_id: player.telegram_user_id, pair_key: "final", prompt_slot: 1 });
    }
  } else {
    for (let i = 0; i < shuffled.length; i++) {
      const prompt = deck[i];
      const pairKey = `p${i}`;
      rows.push({ room_id: room.id, round_number: round, prompt_id: prompt.id, player_telegram_id: shuffled[i].telegram_user_id, pair_key: pairKey, prompt_slot: 1 });
      rows.push({ room_id: room.id, round_number: round, prompt_id: prompt.id, player_telegram_id: shuffled[(i + 1) % shuffled.length].telegram_user_id, pair_key: pairKey, prompt_slot: 2 });
    }
  }
  await supabaseRequest(env, "round_prompts", { method: "POST", body: JSON.stringify(rows) });
  const label = round === 3 ? "Финал. Один вопрос на всех, можно ставить очки." : `Раунд ${round} из 3. У каждого два вопроса.`;
  await Promise.all([
    announce(env, room.code, `<b>${label}</b>\nОтветы пишутся в приложении. В этот чат они прилетят, когда откроется голосование — без имён, чтобы не подглядывать.`, true),
    notify(env, room.code, round === 1 && fromStatus !== "round_results" ? "game_started" : "next_round", { round }),
    playBotAnswers(env, { ...room, round_number: round }, players),
  ]);
}

async function ensurePromptPool(env: Env, room: Room, needed: number): Promise<Prompt[]> {
  const customRows = room.custom_prompts_enabled
    ? await supabaseRequest<Array<{ prompt_id: string }>>(env, `room_custom_prompts?room_id=eq.${room.id}&select=prompt_id`)
    : [];
  const customIds = customRows.map(row => row.prompt_id).filter(Boolean);
  const customPrompts = customIds.length ? await supabaseRequest<Prompt[]>(env, `prompts?id=in.(${customIds.join(",")})&select=id,prompt_text`) : [];
  const used = await supabaseRequest<Array<{ prompt_id: string }>>(env, `round_prompts?room_id=eq.${room.id}&select=prompt_id`);
  const usedIds = new Set(used.map(row => row.prompt_id));
  let bag = (customPrompts.length ? customPrompts : await supabaseRequest<Prompt[]>(env, "prompts?enabled=eq.true&locale=eq.ru&select=id,prompt_text&limit=200"))
    .filter(prompt => !usedIds.has(prompt.id));
  if (bag.length < needed) {
    const refill = customPrompts.length ? customPrompts : await supabaseRequest<Prompt[]>(env, "prompts?enabled=eq.true&locale=eq.ru&select=id,prompt_text&limit=200");
    bag = refill.length ? refill : bag;
  }
  bag = [...bag].sort(() => Math.random() - 0.5);
  const picked: Prompt[] = [];
  while (picked.length < needed) {
    if (!bag.length) {
      const source = picked[picked.length % Math.max(picked.length, 1)];
      const inserted = await supabaseRequest<Prompt[]>(env, "prompts", {
        method: "POST",
        body: JSON.stringify({ prompt_text: source?.prompt_text || "Самая странная причина опоздать на собственную свадьбу?", locale: "ru", enabled: false }),
      });
      if (!inserted[0]?.id) throw new Error("Не удалось добрать колоду");
      bag.push(inserted[0]);
    }
    picked.push(bag.shift() as Prompt);
  }
  return picked;
}

async function awardRoundPoints(env: Env, room: Room, players: Player[]): Promise<void> {
  const answers = await loadAnswers(env, room);
  const answerIds = answers.map(a => a.id);
  const playerIds = players.map(player => Number(player.telegram_user_id));
  const votes = answerIds.length ? await supabaseRequest<Vote[]>(env, `votes?answer_id=in.(${answerIds.join(",")})&voter_telegram_id=in.(${playerIds.join(",")})&select=answer_id,voter_telegram_id`) : [];
  const earned = new Map<number, number>();
  if (room.round_number === 3) {
    const pool = answers.reduce((sum, a) => sum + Math.min(Number(a.wager || 0), 1000000), 0);
    for (const answer of answers) earned.set(Number(answer.author_telegram_id), -Math.min(Number(answer.wager || 0), 1000000));
    const counts = answers.map(answer => ({ id: answer.id, author: Number(answer.author_telegram_id), count: votes.filter(v => v.answer_id === answer.id).length }));
    const high = Math.max(0, ...counts.map(x => x.count));
    const winners = counts.filter(x => x.count === high && high > 0);
    if (winners.length) {
      const share = Math.floor(pool / winners.length);
      for (const winner of winners) earned.set(winner.author, (earned.get(winner.author) || 0) + share);
    }
  } else {
    const assignments = await getAssignments(env, room);
    const pairOf = pairKeyFor(assignments);
    const keys = [...new Set(answers.map(pairOf))];
    for (const key of keys) {
      const options = answers.filter(answer => pairOf(answer) === key);
      const counts = options.map(answer => ({ answer, count: votes.filter(v => v.answer_id === answer.id).length }));
      const total = counts.reduce((sum, row) => sum + row.count, 0);
      const eligibleVoters = expectedVoters(room.round_number, players, assignments, key);
      for (const row of counts) {
        const sweep = total > 0 && row.count === total && row.count >= eligibleVoters ? 1000 : 0;
        const points = row.count * 1000 + sweep;
        const author = Number(row.answer.author_telegram_id);
        earned.set(author, (earned.get(author) || 0) + points);
      }
    }
  }
  const bonusAssignments = await getAssignments(env, room);
  const bonusPairOf = pairKeyFor(bonusAssignments);
  const bonusUnits = votingUnits(bonusAssignments, room.round_number);
  for (let index = 0; index < bonusUnits.length; index++) {
    const counts = await env.GAME_ROOMS.getByName(room.code).getAudienceCounts(room.round_number, index);
    const high = Math.max(0, ...Object.values(counts));
    if (!high) continue;
    const winnerIds = answers
      .filter(answer => bonusPairOf(answer) === bonusUnits[index].key && (counts[answer.id] || 0) === high)
      .map(answer => Number(answer.author_telegram_id));
    if (!winnerIds.length) continue;
    const bonusShare = Math.floor(500 / winnerIds.length);
    for (const author of winnerIds) earned.set(author, (earned.get(author) || 0) + bonusShare);
  }
  for (const player of players) {
    const delta = earned.get(Number(player.telegram_user_id)) || 0;
    if (!delta) continue;
    await supabaseRequest(env, `room_players?room_id=eq.${room.id}&telegram_user_id=eq.${player.telegram_user_id}`, {
      method: "PATCH",
      body: JSON.stringify({ score: Math.max(0, player.score + delta) }),
    });
  }
}

async function casRoom(env: Env, id: string, expect: Record<string, string | number>, patch: Record<string, unknown>): Promise<boolean> {
  const filter = Object.entries(expect)
    .map(([key, value]) => `${key}=eq.${encodeURIComponent(String(value))}`)
    .join("&");
  const rows = await supabaseRequest<Array<{ id: string }>>(env, `rooms?id=eq.${id}&${filter}`, {
    method: "PATCH",
    body: JSON.stringify({ ...patch, updated_at: new Date().toISOString() }),
  });
  return Array.isArray(rows) && rows.length > 0;
}

async function freshRoom(env: Env, code: string): Promise<Room | null> {
  const rooms = await supabaseRequest<Room[]>(env, `rooms?code=eq.${code}&select=id,code,host_telegram_id,status,round_number,phase_deadline_at,voting_prompt_index,custom_prompts_enabled&limit=1`);
  return rooms[0] || null;
}

async function notify(env: Env, code: string, event: string, payload: unknown): Promise<void> {
  try { await env.GAME_ROOMS.getByName(code).broadcast(event, payload); }
  catch (error) { console.error(JSON.stringify({ level: "warn", message: "broadcast failed", detail: error instanceof Error ? error.message : "unknown" })); }
}

function json(data: unknown, status = 200): Response {
  return Response.json(data, { status, headers: { "Access-Control-Allow-Origin": "*" } });
}
