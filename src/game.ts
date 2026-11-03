import { supabaseRequest } from "./supabase";
import type { Env } from "./types";

type MiniUser = { id: number; first_name: string; last_name?: string };
type Room = { id: string; code: string; host_telegram_id: number; status: string; round_number: number; phase_deadline_at?: string | null; voting_prompt_index?: number; custom_prompts_enabled?: boolean };
type Player = { telegram_user_id: number; display_name: string; score: number };
type Prompt = { id: string; prompt_text: string };
type Assignment = { id: string; prompt_id: string; player_telegram_id: number; pair_key?: string | null; prompt_slot?: number };
type Answer = { id: string; prompt_assignment_id: string; prompt_id?: string; author_telegram_id: number; answer_text: string; wager?: number };
type Vote = { answer_id: string; voter_telegram_id: number };

export async function handleGameRequest(request: Request, env: Env, user: MiniUser): Promise<Response> {
  const url = new URL(request.url);
  const body = request.method === "POST" ? await request.json() as Record<string, unknown> : {};
  const code = String(body.code || url.searchParams.get("code") || "").toUpperCase();
  if (!/^[A-HJ-NP-Z2-9]{5}$/.test(code)) return json({ error: "Invalid room code" }, 400);

  const rooms = await supabaseRequest<Room[]>(env, `rooms?code=eq.${code}&select=id,code,host_telegram_id,status,round_number,phase_deadline_at,voting_prompt_index,custom_prompts_enabled&limit=1`);
  let room = rooms[0];
  if (!room) return json({ error: "Room not found" }, 404);
  const players = await supabaseRequest<Player[]>(env, `room_players?room_id=eq.${room.id}&telegram_user_id=gt.0&select=telegram_user_id,display_name,score&order=joined_at.asc`);
  if (!players.some(player => Number(player.telegram_user_id) === user.id)) return json({ error: "Not a room member" }, 403);
  room = await advanceExpiredPhase(env, room, players);

  if (url.pathname === "/api/game/state" && request.method === "GET") {
    return json(await getState(env, room, players, user.id));
  }

  if (url.pathname === "/api/game/settings" && request.method === "POST") {
    if (Number(room.host_telegram_id) !== user.id) return json({ error: "Only the host can change game settings" }, 403);
    if (room.status !== "lobby") return json({ error: "Settings are locked after the game starts" }, 409);
    if (typeof body.customEnabled === "boolean") await supabaseRequest(env, `rooms?id=eq.${room.id}`, { method: "PATCH", body: JSON.stringify({ custom_prompts_enabled: body.customEnabled }) });
    if (typeof body.customPrompt === "string" && body.customPrompt.trim()) {
      const custom = await supabaseRequest<Array<{id:string}>>(env, `room_custom_prompts?room_id=eq.${room.id}&select=id`);
      if (custom.length >= 50) return json({ error: "Maximum 50 custom prompts" }, 400);
      const inserted = await supabaseRequest<Prompt[]>(env, "prompts", { method: "POST", headers: { Prefer: "return=representation" }, body: JSON.stringify({ prompt_text: body.customPrompt.trim().slice(0,240), locale: "ru", enabled: false }) });
      await supabaseRequest(env, "room_custom_prompts", { method: "POST", body: JSON.stringify({ room_id: room.id, prompt_text: body.customPrompt.trim().slice(0,240), prompt_id: inserted[0]?.id, created_by_telegram_id: user.id }) });
    }
    return json({ ok: true });
  }
  if (url.pathname === "/api/game/start" && request.method === "POST") {
    if (Number(room.host_telegram_id) !== user.id) return json({ error: "Only the host can start" }, 403);
    if (room.status !== "lobby") return json({ error: "Game already started" }, 409);
    if (players.length < 4 || players.length > 10) return json({ error: "A game requires 4–10 players" }, 409);
    if (room.custom_prompts_enabled) {
      const deadline = new Date(Date.now() + 120000).toISOString();
      await supabaseRequest(env, `rooms?id=eq.${room.id}`, { method: "PATCH", body: JSON.stringify({ status: "custom_writing", phase_deadline_at: deadline, updated_at: new Date().toISOString() }) });
      await notify(env, code, "custom_writing", { round: 1 });
      return json({ ok: true, status: "custom_writing", round: 1 });
    }
    await beginRound(env, room, players, 1);
    await notify(env, code, "game_started", { round: 1 });
    return json({ ok: true, status: "answering", round: 1 });
  }

  if (url.pathname === "/api/game/custom-prompts" && request.method === "POST") {
    if (room.status !== "custom_writing") return json({ error: "Custom prompt phase is closed" }, 409);
    const values = Array.isArray(body.prompts) ? body.prompts.map(v => String(v || "").trim()) : [];
    if (values.length !== 2 || values.some(v => v.length < 5 || v.length > 240)) return json({ error: "Enter exactly two questions, each 5–240 characters" }, 400);
    const existing = await supabaseRequest<Array<{id:string}>>(env, `room_custom_prompts?room_id=eq.${room.id}&created_by_telegram_id=eq.${user.id}&select=id`);
    if (existing.length >= 2) return json({ error: "You already submitted two questions" }, 409);
    const prompts = await supabaseRequest<Prompt[]>(env, "prompts", { method: "POST", headers: { Prefer: "return=representation" }, body: JSON.stringify(values.map(prompt_text => ({ prompt_text, locale: "ru", enabled: false }))) });
    if (prompts.length !== 2) return json({ error: "Could not save both questions" }, 500);
    await supabaseRequest(env, "room_custom_prompts", { method: "POST", body: JSON.stringify(prompts.map(p => ({ room_id: room.id, prompt_text: p.prompt_text, prompt_id: p.id, created_by_telegram_id: user.id }))) });
    return json({ ok: true });
  }
  if (url.pathname === "/api/game/answer" && request.method === "POST") {
    const answerText = String(body.text || "").trim().toLocaleLowerCase("ru-RU");
    if (room.status !== "answering") return json({ error: "Answer phase is closed" }, 409);
    if (answerText.length < 1 || answerText.length > 240) return json({ error: "Answer must be 1–240 characters" }, 400);
    const assignments = await getAssignments(env, room);
    const ownAssignment = assignments.find(item => Number(item.player_telegram_id) === user.id && item.id === String(body.assignmentId || ""));
    if (!ownAssignment) return json({ error: "No prompt assigned" }, 409);
    const existing = await supabaseRequest<Answer[]>(env, `answers?prompt_assignment_id=eq.${ownAssignment.id}&select=id`);
    if (existing.length) return json({ error: "Answer already submitted" }, 409);
    await supabaseRequest(env, "answers", { method: "POST", body: JSON.stringify({
      room_id: room.id, round_number: room.round_number, prompt_assignment_id: ownAssignment.id, prompt_id: ownAssignment.prompt_id,
      author_telegram_id: user.id, answer_text: answerText, wager: room.round_number === 3 ? Math.max(0, Math.min(Number(body.wager || 0), players.find(p => Number(p.telegram_user_id) === user.id)?.score || 0)) : 0
    }) });
    const answers = await supabaseRequest<Answer[]>(env, `answers?room_id=eq.${room.id}&round_number=eq.${room.round_number}&select=id`);
    if (answers.length >= (room.round_number === 3 ? players.length : players.length * 2)) {
      await supabaseRequest(env, `rooms?id=eq.${room.id}`, { method: "PATCH", body: JSON.stringify({ status: "voting", voting_prompt_index: 0, phase_deadline_at: new Date(Date.now() + 20000).toISOString(), updated_at: new Date().toISOString() }) });
      await notify(env, code, "voting_started", { round: room.round_number });
    } else {
      await notify(env, code, "answer_received", { count: answers.length, total: players.length });
    }
    return json({ ok: true, submitted: true, count: answers.length, total: players.length });
  }

  if (url.pathname === "/api/game/vote" && request.method === "POST") {
    if (room.status !== "voting") return json({ error: "Voting is closed" }, 409);
    const answerId = String(body.answerId || "");
    const assignments = await getAssignments(env, room);
    const ownAssignment = assignments.find(item => Number(item.player_telegram_id) === user.id);
    if (!ownAssignment) return json({ error: "No prompt assigned" }, 409);
    const answers = await supabaseRequest<Answer[]>(env, `answers?room_id=eq.${room.id}&round_number=eq.${room.round_number}&select=id,prompt_assignment_id,prompt_id,author_telegram_id,answer_text,wager`);
    const target = answers.find(answer => answer.id === answerId);
    if (!target || Number(target.author_telegram_id) === user.id) return json({ error: "You cannot vote for your own answer" }, 400);
    const matchupAnswers = await supabaseRequest<Answer[]>(env, `answers?room_id=eq.${room.id}&round_number=eq.${room.round_number}&prompt_id=eq.${target.prompt_id}&select=author_telegram_id`);
    if (matchupAnswers.some(a => Number(a.author_telegram_id) === user.id)) return json({ error: "Writers cannot vote in their own matchup" }, 400);
    const ownVotes = await supabaseRequest<Vote[]>(env, `votes?prompt_id=eq.${target.prompt_id}&voter_telegram_id=eq.${user.id}&select=answer_id`);
    if (ownVotes.length) return json({ error: "Already voted for this answer" }, 409);
    await supabaseRequest(env, "votes", { method: "POST", body: JSON.stringify({ answer_id: answerId, prompt_id: target.prompt_id, voter_telegram_id: user.id }) });
    const allVotes = await supabaseRequest<Vote[]>(env, `answers?room_id=eq.${room.id}&round_number=eq.${room.round_number}&select=votes(answer_id,voter_telegram_id)`);
    const voteCount = allVotes.reduce((sum, answer) => sum + ((answer as unknown as { votes?: Vote[] }).votes?.length || 0), 0);
    const expected = 0;
    if (false) {
      await supabaseRequest(env, `rooms?id=eq.${room.id}`, { method: "PATCH", body: JSON.stringify({ status: "round_results", phase_deadline_at: null, updated_at: new Date().toISOString() }) });
      await notify(env, code, "round_results", { round: room.round_number });
    }
    return json({ ok: true, voteCount, expected });
  }

  if (url.pathname === "/api/game/next" && request.method === "POST") {
    if (Number(room.host_telegram_id) !== user.id) return json({ error: "Only the host can continue" }, 403);
    if (room.status !== "round_results") return json({ error: "Round results are not ready" }, 409);
    await awardRoundPoints(env, room, players);
    if (room.round_number >= 3) {
      await supabaseRequest(env, `rooms?id=eq.${room.id}`, { method: "PATCH", body: JSON.stringify({ status: "finished", updated_at: new Date().toISOString() }) });
      await notify(env, code, "game_finished", {});
      return json({ ok: true, status: "finished" });
    }
    await beginRound(env, room, players, room.round_number + 1);
    await notify(env, code, "next_round", { round: room.round_number + 1 });
    return json({ ok: true, status: "answering", round: room.round_number + 1 });
  }

  return json({ error: "Not found" }, 404);
}

async function getState(env: Env, room: Room, players: Player[], userId: number): Promise<Record<string, unknown>> {
  const assignments = await getAssignments(env, room);
  const ownAssignments = assignments.filter(item => Number(item.player_telegram_id) === userId).sort((a,b) => (a.prompt_slot || 1) - (b.prompt_slot || 1));
  const promptIds = [...new Set(assignments.map(a => a.prompt_id))];
  const prompts = promptIds.length ? await supabaseRequest<Prompt[]>(env, `prompts?id=in.(${promptIds.join(",")})&select=id,prompt_text`) : [];
  const submitted = ["voting", "round_results", "finished"].includes(room.status)
    ? await supabaseRequest<Answer[]>(env, `answers?room_id=eq.${room.id}&round_number=eq.${room.round_number}&select=id,prompt_assignment_id,prompt_id,author_telegram_id,answer_text,wager`)
    : [];
  const votes = submitted.length ? await supabaseRequest<Vote[]>(env, `votes?answer_id=in.(${submitted.map(a => a.id).join(",")})&select=answer_id,voter_telegram_id`) : [];
  const myAnswers = ownAssignments.length ? await supabaseRequest<Answer[]>(env, `answers?prompt_assignment_id=in.(${ownAssignments.map(a => a.id).join(",")})&select=prompt_assignment_id`) : [];
  const ownVoteTargets = votes.filter(v => Number(v.voter_telegram_id) === userId).map(v => v.answer_id);
  const voteCounts = Object.fromEntries(submitted.map(a => [a.id, votes.filter(v => v.answer_id === a.id).length]));
  const names = Object.fromEntries(players.map(p => [String(p.telegram_user_id), p.display_name]));
  return {
    code: room.code, status: room.status, round: room.round_number, deadline: room.phase_deadline_at || null, customPromptCount: room.status === "custom_writing" ? await (async () => (await supabaseRequest<Array<{id:string}>>(env, `room_custom_prompts?room_id=eq.${room.id}&created_by_telegram_id=eq.${userId}&select=id`)).length)() : 0, votingPromptIndex: room.voting_prompt_index || 0, customPromptsEnabled: Boolean((room as Room & {custom_prompts_enabled?:boolean}).custom_prompts_enabled),
    players: players.map(p => ({ name: p.display_name, score: p.score, isHost: Number(room.host_telegram_id) === Number(p.telegram_user_id) })),
    prompts: (room.round_number === 3 ? ownAssignments : ownAssignments.filter(a => !myAnswers.some(x => x.prompt_assignment_id === a.id)).sort((a,b) => (a.prompt_slot || 1) - (b.prompt_slot || 1)).slice(0,1)).map(a => ({ assignmentId: a.id, promptId: a.prompt_id, text: prompts.find(p => p.id === a.prompt_id)?.prompt_text || "", answered: myAnswers.some(x => x.prompt_assignment_id === a.id), slot: a.prompt_slot || 1 })),
    promptLabels: Object.fromEntries(prompts.map(p => [p.id, p.prompt_text])),
    activeVotingPromptId: [...new Set(assignments.map(a => a.prompt_id))][Number(room.voting_prompt_index || 0)] || null,
    answers: submitted.map(a => ({ id: a.id, promptId: a.prompt_id, text: a.answer_text, name: room.status === "round_results" || room.status === "finished" ? names[String(a.author_telegram_id)] : undefined, own: Number(a.author_telegram_id) === userId, votes: voteCounts[a.id] || 0, voted: ownVoteTargets.includes(a.id), wager: a.wager || 0 })),
    votesCast: ownVoteTargets.length, votesNeeded: room.round_number === 3 ? 1 : 2,
    isHost: Number(room.host_telegram_id) === userId
  };
}

async function advanceExpiredPhase(env: Env, room: Room, players: Player[]): Promise<Room> {
  if (!room.phase_deadline_at || Date.now() < Date.parse(room.phase_deadline_at)) return room;
  if (room.status === "custom_writing") {
    await beginRound(env, room, players, 1);
    await notify(env, room.code, "game_started", { round: 1 });
    return { ...room, status: "answering", phase_deadline_at: new Date(Date.now() + 60000).toISOString() };
  }
  if (room.status === "answering") {
    const deadline = new Date(Date.now() + 10000).toISOString();
    await supabaseRequest(env, `rooms?id=eq.${room.id}`, { method: "PATCH", body: JSON.stringify({ status: "voting", phase_deadline_at: deadline, updated_at: new Date().toISOString() }) });
    await notify(env, room.code, "voting_started", { round: room.round_number });
    return { ...room, status: "voting", phase_deadline_at: deadline };
  }
  if (room.status === "voting") {
    const assignments = await getAssignments(env, room);
    const promptCount = new Set(assignments.map(a => a.prompt_id)).size;
    const nextIndex = Number(room.voting_prompt_index || 0) + 1;
    if (nextIndex < promptCount) {
      const deadline = new Date(Date.now() + 20000).toISOString();
      await supabaseRequest(env, `rooms?id=eq.${room.id}`, { method: "PATCH", body: JSON.stringify({ voting_prompt_index: nextIndex, phase_deadline_at: deadline, updated_at: new Date().toISOString() }) });
      return { ...room, voting_prompt_index: nextIndex, phase_deadline_at: deadline };
    }
    await supabaseRequest(env, `rooms?id=eq.${room.id}`, { method: "PATCH", body: JSON.stringify({ status: "round_results", phase_deadline_at: null, updated_at: new Date().toISOString() }) });
    await notify(env, room.code, "round_results", { round: room.round_number });
    return { ...room, status: "round_results", phase_deadline_at: null };
  }
  return room;
}

async function getAssignments(env: Env, room: Room): Promise<Assignment[]> {
  return supabaseRequest<Assignment[]>(env, `round_prompts?room_id=eq.${room.id}&round_number=eq.${room.round_number}&select=id,prompt_id,player_telegram_id,pair_key,prompt_slot&order=created_at.asc`);
}

async function beginRound(env: Env, room: Room, players: Player[], round: number): Promise<void> {
  const customRows = room.custom_prompts_enabled ? await supabaseRequest<Array<{prompt_id:string}>>(env, `room_custom_prompts?room_id=eq.${room.id}&select=prompt_id`) : [];
  const customIds = customRows.map(row => row.prompt_id).filter(Boolean);
  const customPrompts = customIds.length ? await supabaseRequest<Prompt[]>(env, `prompts?id=in.(${customIds.join(",")})&select=id,prompt_text`) : [];
  const used = await supabaseRequest<Array<{ prompt_id: string }>>(env, `round_prompts?room_id=eq.${room.id}&select=prompt_id`);
  const usedIds = [...new Set(used.map(row => row.prompt_id))];
  let available = customPrompts.length ? customPrompts : await supabaseRequest<Prompt[]>(env, "prompts?enabled=eq.true&locale=eq.ru&select=id,prompt_text&limit=100");
  available = available.filter(prompt => !usedIds.includes(prompt.id));
  if (available.length < players.length) available = customPrompts.length ? [...customPrompts] : await supabaseRequest<Prompt[]>(env, "prompts?enabled=eq.true&locale=eq.ru&select=id,prompt_text&limit=100");
  if (!available.length) throw new Error("No enabled prompts available");
  available = [...available].sort(() => Math.random() - 0.5);
  const shuffled = [...players].sort(() => Math.random() - 0.5);
  const rows: Array<Record<string, unknown>> = [];
  if (round === 3) {
    const prompt = available[randomIndex(available.length)];
    for (const player of shuffled) rows.push({ room_id: room.id, round_number: round, prompt_id: prompt.id, player_telegram_id: player.telegram_user_id, pair_key: "final", prompt_slot: 1 });
  } else {
    // Ring pairing: each player receives two prompts; each prompt is shared by two players.
    for (let i = 0; i < shuffled.length; i++) {
      const prompt = available[i % available.length];
      const pairKey = "p" + i;
      rows.push({ room_id: room.id, round_number: round, prompt_id: prompt.id, player_telegram_id: shuffled[i].telegram_user_id, pair_key: pairKey, prompt_slot: 1 });
      rows.push({ room_id: room.id, round_number: round, prompt_id: prompt.id, player_telegram_id: shuffled[(i + 1) % shuffled.length].telegram_user_id, pair_key: pairKey, prompt_slot: 2 });
    }
  }
  await supabaseRequest(env, "round_prompts", { method: "POST", body: JSON.stringify(rows) });
  await supabaseRequest(env, `rooms?id=eq.${room.id}`, { method: "PATCH", body: JSON.stringify({ status: "answering", round_number: round, voting_prompt_index: 0, phase_deadline_at: new Date(Date.now() + 60000).toISOString(), updated_at: new Date().toISOString() }) });

}

async function awardRoundPoints(env: Env, room: Room, players: Player[]): Promise<void> {
  const answers = await supabaseRequest<Answer[]>(env, `answers?room_id=eq.${room.id}&round_number=eq.${room.round_number}&select=id,prompt_id,author_telegram_id,wager`);
  const answerIds = answers.map(a => a.id);
  const votes = answerIds.length ? await supabaseRequest<Vote[]>(env, `votes?answer_id=in.(${answerIds.join(",")})&select=answer_id,voter_telegram_id`) : [];
  const earned = new Map<number, number>();
  if (room.round_number === 3) {
    const pool = answers.reduce((sum, a) => sum + Math.min(Number(a.wager || 0), 1000000), 0);
    for (const a of answers) earned.set(Number(a.author_telegram_id), -Math.min(Number(a.wager || 0), 1000000));
    const counts = answers.map(a => ({ id: a.id, author: Number(a.author_telegram_id), count: votes.filter(v => v.answer_id === a.id).length }));
    const high = Math.max(0, ...counts.map(x => x.count));
    const winners = counts.filter(x => x.count === high && high > 0);
    if (winners.length) { const share = Math.floor(pool / winners.length); for (const w of winners) earned.set(w.author, (earned.get(w.author) || 0) + share); }
  } else {
    const promptIds = [...new Set(answers.map(a => a.prompt_id).filter(Boolean))] as string[];
    for (const promptId of promptIds) {
      const options = answers.filter(a => a.prompt_id === promptId);
      const counts = options.map(a => ({ answer: a, count: votes.filter(v => v.answer_id === a.id).length }));
      const total = counts.reduce((sum, x) => sum + x.count, 0);
      for (const x of counts) {
        const unanimousBonus = total > 0 && x.count === total && x.count === players.length - 2 ? 1000 : 0;
        const points = x.count * 1000 + unanimousBonus;
        earned.set(Number(x.answer.author_telegram_id), (earned.get(Number(x.answer.author_telegram_id)) || 0) + points);
      }
    }
  }
  for (const player of players) {
    const delta = earned.get(Number(player.telegram_user_id)) || 0;
    if (delta) await supabaseRequest(env, `room_players?room_id=eq.${room.id}&telegram_user_id=eq.${player.telegram_user_id}`, { method: "PATCH", body: JSON.stringify({ score: Math.max(0, player.score + delta) }) });
  }
}

async function notify(env: Env, code: string, event: string, payload: unknown): Promise<void> {
  await env.GAME_ROOMS.getByName(code).broadcast(event, payload);
}

function randomIndex(max: number): number {
  const value = new Uint32Array(1);
  crypto.getRandomValues(value);
  return value[0] % max;
}

function json(data: unknown, status = 200): Response {
  return Response.json(data, { status, headers: { "Access-Control-Allow-Origin": "*" } });
}
