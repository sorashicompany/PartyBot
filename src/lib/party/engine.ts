import {
  BOT_NAMES,
  BOT_QUESTIONS,
  BUILTINS,
  EXAMPLES,
  GENERIC,
  SAFETY,
  type Prompt,
} from "./content";

export const TIMING = {
  customMs: 70_000,
  answerMs: 56_000,
  voteMs: 13_000,
  finalVoteMs: 16_000,
  revealMs: 5_600,
  dealMs: 1_700,
  boardMs: 8_000,
  settleMs: 700,
} as const;

export type Phase = "lobby" | "custom" | "deal" | "answer" | "vote" | "reveal" | "board" | "podium";

export type Player = { id: string; name: string; bot: boolean; score: number };

export type Assignment = {
  id: string;
  qid: string;
  playerId: string;
  pair: string;
  slot: 1 | 2;
};

export type Answer = {
  id: string;
  assignmentId: string;
  qid: string;
  playerId: string;
  text: string;
  wager: number;
  safety: boolean;
};

export type Vote = { pair: string; voterId: string; answerId: string };

type Plan =
  | { at: number; kind: "custom"; playerId: string; prompts: [string, string] }
  | { at: number; kind: "answer"; playerId: string; assignmentId: string; text: string; wager: number }
  | { at: number; kind: "vote"; playerId: string; pair: string; answerId: string };

export type Game = {
  phase: Phase;
  round: 0 | 1 | 2 | 3;
  players: Player[];
  youName: string;
  botCount: number;
  customOn: boolean;
  customTexts: [string, string];
  customs: { playerId: string; text: string }[];
  deck: Prompt[];
  roundQuestions: Prompt[];
  seenTexts: string[];
  assignments: Assignment[];
  answers: Answer[];
  votes: Vote[];
  order: string[];
  voteCursor: number;
  draft: string;
  wager: number;
  deadline: number;
  phaseUntil: number;
  plans: Plan[];
  seq: number;
  rng: number;
  awardedPairs: string[];
  lastDeltas: Record<string, number>;
  toast: string;
};

type Roller = { next: () => number; state: () => number };

function roller(seed: number): Roller {
  let a = seed >>> 0;
  return {
    next() {
      a = (a + 0x6d2b79f5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    },
    state: () => a >>> 0,
  };
}

function shuffle<T>(items: readonly T[], rng: Roller): T[] {
  const arr = [...items];
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(rng.next() * (i + 1));
    const swap = arr[i]!;
    arr[i] = arr[j]!;
    arr[j] = swap;
  }
  return arr;
}

export function formatPoints(n: number): string {
  const sign = n < 0 ? "−" : "";
  const body = Math.abs(Math.round(n))
    .toString()
    .replace(/\B(?=(\d{3})+(?!\d))/g, " ");
  return sign + body;
}

export function duelPoints(counts: number[], eligible: number): number[] {
  return counts.map((count) => {
    const sweep = eligible >= 2 && count > 0 && count === eligible;
    return count * 1000 * (sweep ? 2 : 1);
  });
}

export type FinalIn = { id: string; score: number; wager: number; votes: number };
export type FinalOut = { id: string; score: number; delta: number };

export function finalPayout(rows: FinalIn[]): FinalOut[] {
  const cleaned = rows.map((row) => ({
    ...row,
    wager: Math.max(0, Math.min(Math.round(row.wager), row.score)),
  }));
  const pot = cleaned.reduce((sum, row) => sum + row.wager, 0);
  const high = cleaned.reduce((max, row) => Math.max(max, row.votes), 0);
  const winners = high > 0 ? cleaned.filter((row) => row.votes === high) : [];
  const share = winners.length ? Math.floor(pot / winners.length) : 0;
  const refund = winners.length === 0;
  return cleaned.map((row) => {
    let delta = 0;
    if (!refund) {
      delta = -row.wager;
      if (winners.some((winner) => winner.id === row.id)) delta += share;
      if (pot === 0) delta += row.votes * 1000;
    }
    return { id: row.id, delta, score: Math.max(0, row.score + delta) };
  });
}

export function createLobby(): Game {
  return {
    phase: "lobby",
    round: 0,
    players: [],
    youName: "",
    botCount: 3,
    customOn: false,
    customTexts: ["", ""],
    customs: [],
    deck: [],
    roundQuestions: [],
    seenTexts: [],
    assignments: [],
    answers: [],
    votes: [],
    order: [],
    voteCursor: 0,
    draft: "",
    wager: 0,
    deadline: 0,
    phaseUntil: 0,
    plans: [],
    seq: 1,
    rng: 0x51a9,
    awardedPairs: [],
    lastDeltas: {},
    toast: "",
  };
}

export function setName(g: Game, name: string): Game {
  if (g.phase !== "lobby") return g;
  return { ...g, youName: name.slice(0, 16), toast: "" };
}

export function setBotCount(g: Game, count: number): Game {
  if (g.phase !== "lobby") return g;
  return { ...g, botCount: Math.max(3, Math.min(7, Math.round(count))) };
}

export function setCustomOn(g: Game, on: boolean): Game {
  if (g.phase !== "lobby") return g;
  return { ...g, customOn: on };
}

export function setCustomText(g: Game, index: 0 | 1, text: string): Game {
  if (g.phase !== "custom") return g;
  const next: [string, string] = [g.customTexts[0], g.customTexts[1]];
  next[index] = text.slice(0, 140);
  return { ...g, customTexts: next, toast: "" };
}

export function fillExamples(g: Game): Game {
  if (g.phase !== "custom") return g;
  return { ...g, customTexts: [EXAMPLES[0], EXAMPLES[1]], toast: "" };
}

export function setDraft(g: Game, text: string): Game {
  if (g.phase !== "answer") return g;
  const clean = text.replace(/\s+/g, " ").slice(0, 80);
  return { ...g, draft: clean.toLocaleLowerCase("ru-RU"), toast: "" };
}

export function setWager(g: Game, value: number): Game {
  if (g.phase !== "answer" || g.round !== 3) return g;
  const max = g.players.find((player) => player.id === "you")?.score ?? 0;
  return { ...g, wager: Math.max(0, Math.min(max, Math.round(value))) };
}

function makePlayers(g: Game): Player[] {
  const name = g.youName.trim() || "Ты";
  const bots = BOT_NAMES.slice(0, g.botCount).map((botName, index) => ({
    id: `bot-${index}`,
    name: botName,
    bot: true,
    score: 0,
  }));
  return [{ id: "you", name, bot: false, score: 0 }, ...bots];
}

export function startGame(g: Game, now: number): Game {
  if (g.phase !== "lobby" || now <= 0) return g;
  const seeded: Game = {
    ...g,
    players: makePlayers(g),
    toast: "",
    round: 0,
    rng: (g.rng ^ Math.imul(now, 0x9e3779b1) ^ 0x85ebca6b) >>> 0,
    seenTexts: [],
    customs: [],
    answers: [],
    votes: [],
    plans: [],
    lastDeltas: {},
  };
  if (g.customOn) return enterCustom(seeded, now);
  const rng = roller(seeded.rng);
  return enterDeal({ ...seeded, deck: shuffle(BUILTINS, rng), rng: rng.state() }, 1, now);
}

function enterCustom(g: Game, now: number): Game {
  const rng = roller(g.rng);
  const pool = [...BOT_QUESTIONS];
  const plans: Plan[] = [];
  let index = 0;
  for (const player of g.players) {
    if (!player.bot) continue;
    const first = pool.splice(Math.floor(rng.next() * pool.length), 1)[0];
    const second = pool.splice(Math.floor(rng.next() * pool.length), 1)[0];
    if (!first || !second) continue;
    plans.push({
      at: now + 700 + index * 480,
      kind: "custom",
      playerId: player.id,
      prompts: [first, second],
    });
    index += 1;
  }
  return {
    ...g,
    phase: "custom",
    rng: rng.state(),
    plans,
    customs: [],
    customTexts: ["", ""],
    deadline: now + TIMING.customMs,
    phaseUntil: 0,
  };
}

export function submitCustom(g: Game, now: number): Game {
  if (g.phase !== "custom") return g;
  if (g.customs.some((row) => row.playerId === "you")) return g;
  const texts = g.customTexts.map((text) => text.trim().replace(/\s+/g, " ")) as [string, string];
  if (texts.some((text) => text.length < 8 || text.length > 140)) {
    return { ...g, toast: "Два вопроса, каждый от 8 до 140 символов" };
  }
  if (texts[0].toLocaleLowerCase("ru-RU") === texts[1].toLocaleLowerCase("ru-RU")) {
    return { ...g, toast: "Нужны два разных вопроса" };
  }
  const next: Game = {
    ...g,
    toast: "",
    customs: [
      ...g.customs,
      { playerId: "you", text: texts[0] },
      { playerId: "you", text: texts[1] },
    ],
  };
  return customComplete(next) ? finishCustom(next, now) : next;
}

export function skipCustom(g: Game, now: number): Game {
  if (g.phase !== "custom") return g;
  const pulled = applyDuePlans(
    { ...g, plans: g.plans.map((plan) => ({ ...plan, at: now })) },
    now,
  );
  return finishCustom(pulled, now);
}

function customComplete(g: Game): boolean {
  return g.players.every((player) => g.customs.filter((row) => row.playerId === player.id).length >= 2);
}

function finishCustom(g: Game, now: number): Game {
  const rng = roller(g.rng);
  const seen = new Set<string>();
  const customQs: Prompt[] = [];
  g.customs.forEach((row, index) => {
    const key = row.text.toLocaleLowerCase("ru-RU");
    if (seen.has(key)) return;
    seen.add(key);
    customQs.push({ id: `c${index}-${row.playerId}`, text: row.text, replies: [] });
  });
  const rest = shuffle(
    BUILTINS.filter((prompt) => !seen.has(prompt.text.toLocaleLowerCase("ru-RU"))),
    rng,
  );
  return enterDeal(
    { ...g, deck: [...shuffle(customQs, rng), ...rest], rng: rng.state(), plans: [] },
    1,
    now,
  );
}

function enterDeal(g: Game, round: 1 | 2 | 3, now: number): Game {
  const need = round === 3 ? 1 : g.players.length;
  const rng = roller(g.rng ^ (round * 0x45d9f3b));
  let deck = [...g.deck];
  if (deck.length < need) {
    const more = shuffle(
      BUILTINS.map((prompt, index) => ({ ...prompt, id: `${prompt.id}-r${round}-${index}` })),
      rng,
    );
    deck = [...deck, ...more];
  }
  const picked = deck.slice(0, need);
  deck = deck.slice(need);
  const ring = shuffle(g.players, rng);
  const assignments: Assignment[] = [];
  let seq = g.seq;
  const nextId = () => `a${seq++}`;
  if (round === 3) {
    const question = picked[0];
    if (!question) return g;
    for (const player of ring) {
      assignments.push({ id: nextId(), qid: question.id, playerId: player.id, pair: "final", slot: 1 });
    }
  } else {
    for (let i = 0; i < ring.length; i++) {
      const question = picked[i];
      const left = ring[i];
      const right = ring[(i + 1) % ring.length];
      if (!question || !left || !right) continue;
      const pair = `p${i}`;
      assignments.push({ id: nextId(), qid: question.id, playerId: left.id, pair, slot: 1 });
      assignments.push({ id: nextId(), qid: question.id, playerId: right.id, pair, slot: 2 });
    }
  }
  const pairs = round === 3 ? ["final"] : shuffle(
    Array.from({ length: ring.length }, (_, index) => `p${index}`),
    rng,
  );
  const you = g.players.find((player) => player.id === "you");
  const wager = round === 3 && you && you.score > 0 ? Math.floor(you.score / 2 / 50) * 50 : 0;
  return {
    ...g,
    phase: "deal",
    round,
    rng: rng.state(),
    deck,
    seq,
    assignments,
    roundQuestions: picked,
    seenTexts: [...g.seenTexts, ...picked.map((question) => question.text)],
    answers: [],
    votes: [],
    order: pairs,
    voteCursor: 0,
    awardedPairs: [],
    lastDeltas: {},
    plans: [],
    draft: "",
    wager,
    deadline: 0,
    phaseUntil: now + TIMING.dealMs,
    toast: "",
  };
}

function enterAnswer(g: Game, now: number): Game {
  const rng = roller(g.rng);
  const usedLines = new Map<string, Set<string>>();
  const bots = g.assignments.filter((assignment) => g.players.find((player) => player.id === assignment.playerId)?.bot);
  const plans: Plan[] = shuffle(bots, rng).map((assignment) => {
    const question = g.roundQuestions.find((item) => item.id === assignment.qid);
    const used = usedLines.get(assignment.pair) ?? new Set<string>();
    const base = question && question.replies.length ? question.replies : GENERIC;
    const pool = base.filter((line) => !used.has(line));
    const source = pool.length ? pool : GENERIC;
    const text = source[Math.floor(rng.next() * source.length)] ?? SAFETY[0]!;
    used.add(text);
    usedLines.set(assignment.pair, used);
    const player = g.players.find((item) => item.id === assignment.playerId);
    let wager = 0;
    if (g.round === 3 && player && player.score > 0) {
      const ratio = 0.25 + rng.next() * 0.55;
      wager = Math.min(player.score, Math.max(50, Math.round((player.score * ratio) / 50) * 50));
    }
    return {
      at: now + 900 + rng.next() * (TIMING.answerMs - 6_000),
      kind: "answer" as const,
      playerId: assignment.playerId,
      assignmentId: assignment.id,
      text,
      wager,
    };
  });
  return { ...g, phase: "answer", plans, deadline: now + TIMING.answerMs, phaseUntil: 0, rng: rng.state() };
}

function playerAssignments(g: Game, playerId: string): Assignment[] {
  return g.assignments.filter((assignment) => assignment.playerId === playerId).sort((a, b) => a.slot - b.slot);
}

function openAssignment(g: Game, playerId: string): Assignment | null {
  return playerAssignments(g, playerId).find((assignment) => !g.answers.some((answer) => answer.assignmentId === assignment.id)) ?? null;
}

function everyoneAnswered(g: Game): boolean {
  return g.assignments.every((assignment) => g.answers.some((answer) => answer.assignmentId === assignment.id));
}

function armClose(g: Game, now: number): Game {
  if (!everyoneAnswered(g)) return g;
  return { ...g, deadline: Math.min(g.deadline || now + 350, now + 350) };
}

export function submitAnswer(g: Game, now: number): Game {
  if (g.phase !== "answer") return g;
  const assignment = openAssignment(g, "you");
  if (!assignment) return g;
  const text = g.draft.trim().replace(/\s+/g, " ").toLocaleLowerCase("ru-RU");
  if (text.length < 1) return { ...g, toast: "Нужна хотя бы одна буква" };
  if (text.length > 80) return { ...g, toast: "Короче — так смешнее" };
  const you = g.players.find((player) => player.id === "you");
  const wager = g.round === 3 ? Math.max(0, Math.min(g.wager, you?.score ?? 0)) : 0;
  const next = addAnswer(g, assignment, text, wager, false);
  return armClose({ ...next, draft: "", toast: "" }, now);
}

function addAnswer(g: Game, assignment: Assignment, text: string, wager: number, safety: boolean): Game {
  if (g.answers.some((answer) => answer.assignmentId === assignment.id)) return g;
  const answer: Answer = {
    id: `n${g.seq}`,
    assignmentId: assignment.id,
    qid: assignment.qid,
    playerId: assignment.playerId,
    text,
    wager,
    safety,
  };
  return { ...g, seq: g.seq + 1, answers: [...g.answers, answer] };
}

function closeAnswers(g: Game, now: number): Game {
  const rng = roller(g.rng ^ 0x9e3779b9);
  let seq = g.seq;
  const answers = [...g.answers];
  for (const assignment of g.assignments) {
    if (answers.some((answer) => answer.assignmentId === assignment.id)) continue;
    const text = SAFETY[Math.floor(rng.next() * SAFETY.length)] ?? SAFETY[0]!;
    answers.push({
      id: `s${seq++}`,
      assignmentId: assignment.id,
      qid: assignment.qid,
      playerId: assignment.playerId,
      text,
      wager: 0,
      safety: true,
    });
  }
  return enterVote({ ...g, answers, seq, rng: rng.state(), plans: [] }, 0, now);
}

function assignmentsInPair(g: Game, pair: string): Assignment[] {
  return g.assignments.filter((assignment) => assignment.pair === pair);
}

function answersInPair(g: Game, pair: string): Answer[] {
  const ordered: Answer[] = [];
  for (const assignment of g.assignments) {
    if (assignment.pair !== pair) continue;
    const answer = g.answers.find((item) => item.assignmentId === assignment.id);
    if (answer) ordered.push(answer);
  }
  return ordered;
}

function eligiblePlayers(g: Game, pair: string): Player[] {
  if (g.round === 3) return g.players;
  const authors = new Set(assignmentsInPair(g, pair).map((assignment) => assignment.playerId));
  return g.players.filter((player) => !authors.has(player.id));
}

function enterVote(g: Game, cursor: number, now: number): Game {
  const pair = g.order[cursor];
  if (!pair) return enterBoard(g, now);
  const rng = roller((g.rng + cursor * 97) >>> 0);
  const answers = answersInPair(g, pair);
  const authors = new Set(assignmentsInPair(g, pair).map((assignment) => assignment.playerId));
  const plans: Plan[] = [];
  g.players.forEach((player, index) => {
    if (!player.bot) return;
    if (g.round !== 3 && authors.has(player.id)) return;
    const options = g.round === 3 ? answers.filter((answer) => answer.playerId !== player.id) : answers;
    const pick = options[Math.floor(rng.next() * options.length)];
    if (!pick) return;
    plans.push({
      at: now + 450 + index * 260 + rng.next() * 800,
      kind: "vote",
      playerId: player.id,
      pair,
      answerId: pick.id,
    });
  });
  const window = g.round === 3 ? TIMING.finalVoteMs : TIMING.voteMs;
  return {
    ...g,
    phase: "vote",
    voteCursor: cursor,
    plans,
    deadline: now + window,
    phaseUntil: 0,
    rng: rng.state(),
    lastDeltas: {},
    toast: "",
  };
}

function everyoneVoted(g: Game, pair: string): boolean {
  return eligiblePlayers(g, pair).every((player) => g.votes.some((vote) => vote.pair === pair && vote.voterId === player.id));
}

export function castVote(g: Game, answerId: string, now: number): Game {
  if (g.phase !== "vote") return g;
  const pair = g.order[g.voteCursor];
  if (!pair) return g;
  if (g.votes.some((vote) => vote.pair === pair && vote.voterId === "you")) return g;
  const answers = answersInPair(g, pair);
  const target = answers.find((answer) => answer.id === answerId);
  if (!target) return g;
  const authors = new Set(assignmentsInPair(g, pair).map((assignment) => assignment.playerId));
  if (g.round !== 3 && authors.has("you")) return { ...g, toast: "В своей паре ты не голосуешь" };
  if (target.playerId === "you") return { ...g, toast: "Свой ответ выбрать нельзя" };
  return settleVote({ ...g, votes: [...g.votes, { pair, voterId: "you", answerId }], toast: "" }, now);
}

function settleVote(g: Game, now: number): Game {
  const pair = g.order[g.voteCursor];
  if (!pair || !everyoneVoted(g, pair)) return g;
  if (g.phaseUntil && g.phaseUntil > now) return g;
  return { ...g, phaseUntil: now + TIMING.settleMs };
}

function award(g: Game, pair: string): { players: Player[]; lastDeltas: Record<string, number> } {
  const answers = answersInPair(g, pair);
  const lastDeltas: Record<string, number> = {};
  if (g.round === 3) {
    const paid = finalPayout(
      g.players.map((player) => {
        const answer = answers.find((item) => item.playerId === player.id);
        return {
          id: player.id,
          score: player.score,
          wager: answer?.wager ?? 0,
          votes: g.votes.filter((vote) => vote.pair === pair && vote.answerId === answer?.id).length,
        };
      }),
    );
    return {
      lastDeltas: Object.fromEntries(paid.map((row) => [row.id, row.delta])),
      players: g.players.map((player) => {
        const row = paid.find((item) => item.id === player.id);
        return { ...player, score: row?.score ?? player.score };
      }),
    };
  }
  const eligible = eligiblePlayers(g, pair).length;
  const counts = answers.map((answer) => g.votes.filter((vote) => vote.answerId === answer.id).length);
  const points = duelPoints(counts, eligible);
  const players = g.players.map((player) => {
    const index = answers.findIndex((answer) => answer.playerId === player.id);
    const delta = index >= 0 ? (points[index] ?? 0) : 0;
    lastDeltas[player.id] = delta;
    return { ...player, score: player.score + delta };
  });
  return { players, lastDeltas };
}

function enterReveal(g: Game, now: number): Game {
  const pair = g.order[g.voteCursor];
  if (!pair) return enterBoard(g, now);
  if (g.awardedPairs.includes(pair)) {
    return { ...g, phase: "reveal", plans: [], phaseUntil: now + TIMING.revealMs };
  }
  const paid = award(g, pair);
  return {
    ...g,
    phase: "reveal",
    players: paid.players,
    lastDeltas: paid.lastDeltas,
    awardedPairs: [...g.awardedPairs, pair],
    plans: [],
    phaseUntil: now + TIMING.revealMs,
    toast: "",
  };
}

function advanceAfterReveal(g: Game, now: number): Game {
  const next = g.voteCursor + 1;
  if (next < g.order.length) return enterVote(g, next, now);
  if (g.round >= 3) return enterPodium(g);
  return enterBoard(g, now);
}

function enterBoard(g: Game, now: number): Game {
  return { ...g, phase: "board", plans: [], deadline: 0, phaseUntil: now + TIMING.boardMs, toast: "" };
}

function enterPodium(g: Game): Game {
  return { ...g, phase: "podium", plans: [], deadline: 0, phaseUntil: 0, toast: "" };
}

export function continueBoard(g: Game, now: number): Game {
  if (g.phase === "reveal") return advanceAfterReveal(g, now);
  if (g.phase === "deal") return enterAnswer(g, now);
  if (g.phase !== "board") return g;
  if (g.round >= 3) return enterPodium(g);
  return enterDeal(g, (g.round + 1) as 2 | 3, now);
}

export function hurry(g: Game, now: number): Game {
  if (g.phase === "lobby" || g.phase === "podium" || g.phase === "custom") return g;
  const pulled = applyDuePlans(
    { ...g, plans: g.plans.map((plan) => ({ ...plan, at: now })) },
    now,
  );
  if (pulled.phase === "answer") return closeAnswers(pulled, now);
  if (pulled.phase === "vote") return enterReveal(pulled, now);
  if (pulled.phase === "reveal") return advanceAfterReveal(pulled, now);
  if (pulled.phase === "deal" || pulled.phase === "board") return continueBoard(pulled, now);
  return pulled;
}

export function replay(g: Game): Game {
  return { ...createLobby(), youName: g.youName, botCount: g.botCount, customOn: g.customOn };
}

function applyPlan(g: Game, plan: Plan): Game {
  if (plan.kind === "custom") {
    if (g.customs.some((row) => row.playerId === plan.playerId)) return g;
    return {
      ...g,
      customs: [
        ...g.customs,
        { playerId: plan.playerId, text: plan.prompts[0] },
        { playerId: plan.playerId, text: plan.prompts[1] },
      ],
    };
  }
  if (plan.kind === "answer") {
    const assignment = g.assignments.find((item) => item.id === plan.assignmentId);
    if (!assignment) return g;
    return addAnswer(g, assignment, plan.text.toLocaleLowerCase("ru-RU"), plan.wager, false);
  }
  const pair = plan.pair;
  if (g.votes.some((vote) => vote.pair === pair && vote.voterId === plan.playerId)) return g;
  const answers = answersInPair(g, pair);
  const target = answers.find((answer) => answer.id === plan.answerId);
  if (!target || target.playerId === plan.playerId) return g;
  if (g.round !== 3) {
    const authors = new Set(assignmentsInPair(g, pair).map((assignment) => assignment.playerId));
    if (authors.has(plan.playerId)) return g;
  }
  return { ...g, votes: [...g.votes, { pair, voterId: plan.playerId, answerId: plan.answerId }] };
}

function applyDuePlans(g: Game, now: number): Game {
  const due = g.plans.filter((plan) => plan.at <= now);
  if (!due.length) return g;
  let next: Game = { ...g, plans: g.plans.filter((plan) => plan.at > now) };
  for (const plan of due) next = applyPlan(next, plan);
  if (next.phase === "answer") next = armClose(next, now);
  if (next.phase === "vote") next = settleVote(next, now);
  return next;
}

function step(g: Game, now: number): Game {
  if (g.phase === "custom") {
    if (customComplete(g) || now >= g.deadline) return finishCustom(g, now);
    return g;
  }
  if (g.phase === "deal") return now >= g.phaseUntil ? enterAnswer(g, now) : g;
  if (g.phase === "answer") return now >= g.deadline ? closeAnswers(g, now) : g;
  if (g.phase === "vote") {
    const pair = g.order[g.voteCursor];
    if (!pair) return enterBoard(g, now);
    const ready = everyoneVoted(g, pair);
    if (ready && g.phaseUntil && now >= g.phaseUntil) return enterReveal(g, now);
    if (!ready && now >= g.deadline) return enterReveal(g, now);
    return g;
  }
  if (g.phase === "reveal") return now >= g.phaseUntil ? advanceAfterReveal(g, now) : g;
  if (g.phase === "board") return now >= g.phaseUntil ? continueBoard(g, now) : g;
  return g;
}

export function tick(g: Game, now: number): Game {
  if (g.phase === "lobby" || g.phase === "podium" || now <= 0) return g;
  return step(applyDuePlans(g, now), now);
}

export type TimerView = { left: number; ratio: number; hot: boolean } | null;

export type CardView = {
  id: string;
  text: string;
  votes: number;
  you: boolean;
  safety: boolean;
  author: string | null;
  points: number | null;
  wager: number;
  side: "lime" | "coral";
};

export type CardsView = {
  mode: "duel" | "final";
  prompt: string;
  items: CardView[];
  canVote: boolean;
  youVoted: boolean;
  youAreAuthor: boolean;
  index: number;
  total: number;
  sweep: boolean;
};

export type PersonView = {
  id: string;
  name: string;
  score: number;
  you: boolean;
  bot: boolean;
  done: boolean;
  typing: boolean;
  delta: number;
};

export type View = {
  phase: Phase;
  round: number;
  youName: string;
  botCount: number;
  customOn: boolean;
  customTexts: [string, string];
  youSubmittedCustom: boolean;
  players: PersonView[];
  timer: TimerView;
  prompt: string | null;
  slotLabel: string | null;
  draft: string;
  wager: number;
  wagerMax: number;
  currentAssignmentId: string | null;
  waiting: boolean;
  answerProgress: { done: number; total: number };
  cards: CardsView | null;
  ranked: PersonView[];
  yourPlace: number;
  toast: string;
  announce: string;
  dealKicker: string;
  dealTitle: string;
  dealSub: string;
};

function clock(total: number, deadline: number, now: number): TimerView {
  if (!deadline || total <= 0) return null;
  if (!now) return { left: Math.ceil(total / 1000), ratio: 1, hot: false };
  const leftMs = Math.max(0, deadline - now);
  const left = Math.ceil(leftMs / 1000);
  return { left, ratio: Math.max(0, Math.min(1, leftMs / total)), hot: left <= 5 && leftMs > 0 };
}

function personDone(g: Game, playerId: string): boolean {
  if (g.phase === "custom") return g.customs.filter((row) => row.playerId === playerId).length >= 2;
  if (g.phase === "answer") {
    const need = g.assignments.filter((assignment) => assignment.playerId === playerId);
    return need.length > 0 && need.every((assignment) => g.answers.some((answer) => answer.assignmentId === assignment.id));
  }
  return false;
}

export function present(g: Game, now: number): View {
  const you = g.players.find((player) => player.id === "you");
  const players: PersonView[] = g.players.map((player) => {
    const done = personDone(g, player.id);
    return {
      id: player.id,
      name: player.name,
      score: player.score,
      you: player.id === "you",
      bot: player.bot,
      done,
      typing: player.bot && !done && (g.phase === "answer" || g.phase === "custom"),
      delta: g.phase === "reveal" ? (g.lastDeltas[player.id] ?? 0) : 0,
    };
  });
  const ranked = [...players].sort((a, b) => b.score - a.score || a.name.localeCompare(b.name, "ru"));
  const yourPlace = Math.max(1, ranked.findIndex((player) => player.you) + 1);
  const mine = openAssignment(g, "you");
  const question = mine ? g.roundQuestions.find((item) => item.id === mine.qid) : undefined;
  const waiting = g.phase === "answer" && !mine;
  const answerDone = g.assignments.filter((assignment) => g.answers.some((answer) => answer.assignmentId === assignment.id)).length;

  let timer: TimerView = null;
  if (g.phase === "custom") timer = clock(TIMING.customMs, g.deadline, now);
  if (g.phase === "answer") timer = clock(TIMING.answerMs, g.deadline, now);
  if (g.phase === "vote") timer = clock(g.round === 3 ? TIMING.finalVoteMs : TIMING.voteMs, g.deadline, now);
  if (g.phase === "board") timer = clock(TIMING.boardMs, g.phaseUntil, now);

  let cards: CardsView | null = null;
  if ((g.phase === "vote" || g.phase === "reveal") && g.order[g.voteCursor]) {
    const pair = g.order[g.voteCursor]!;
    const answers = answersInPair(g, pair);
    const prompt = g.roundQuestions.find((item) => item.id === answers[0]?.qid)?.text ?? "";
    const authors = new Set(assignmentsInPair(g, pair).map((assignment) => assignment.playerId));
    const youAreAuthor = g.round !== 3 && authors.has("you");
    const youVote = g.votes.find((vote) => vote.pair === pair && vote.voterId === "you");
    const eligible = eligiblePlayers(g, pair).length;
    const counts = answers.map((answer) => g.votes.filter((vote) => vote.answerId === answer.id).length);
    const sweep = g.phase === "reveal" && g.round !== 3 && eligible >= 2 && counts.some((count) => count === eligible && count > 0);
    cards = {
      mode: g.round === 3 ? "final" : "duel",
      prompt,
      index: g.voteCursor + 1,
      total: g.order.length,
      canVote: g.phase === "vote" && !youVote && !youAreAuthor,
      youVoted: Boolean(youVote),
      youAreAuthor,
      sweep,
      items: answers.map((answer, index) => ({
        id: answer.id,
        text: answer.text,
        votes: counts[index] ?? 0,
        you: answer.playerId === "you",
        safety: answer.safety,
        author: g.phase === "reveal" ? (g.players.find((player) => player.id === answer.playerId)?.name ?? null) : null,
        points: g.phase === "reveal" ? (g.lastDeltas[answer.playerId] ?? 0) : null,
        wager: answer.wager,
        side: index % 2 === 0 ? "lime" : "coral",
      })),
    };
  }

  const announce =
    g.phase === "lobby" ? "Лобби шоу" :
    g.phase === "custom" ? "Фаза своих вопросов" :
    g.phase === "deal" ? (g.round === 3 ? "Финальный раунд" : `Раунд ${g.round}`) :
    g.phase === "answer" ? "Пиши ответ" :
    g.phase === "vote" ? "Голосование" :
    g.phase === "reveal" ? "Вскрываем авторов" :
    g.phase === "board" ? "Счёт раунда" :
    "Итоги шоу";

  return {
    phase: g.phase,
    round: g.round,
    youName: g.youName,
    botCount: g.botCount,
    customOn: g.customOn,
    customTexts: g.customTexts,
    youSubmittedCustom: g.customs.some((row) => row.playerId === "you"),
    players,
    timer,
    prompt: g.phase === "answer" ? (question?.text ?? null) : (cards?.prompt ?? null),
    slotLabel: g.phase !== "answer" ? null : g.round === 3 ? "Финал · один на всех" : mine ? `Вопрос ${mine.slot} из 2` : "Оба ответа сданы",
    draft: g.draft,
    wager: g.wager,
    wagerMax: you?.score ?? 0,
    currentAssignmentId: mine?.id ?? null,
    waiting,
    answerProgress: { done: answerDone, total: g.assignments.length },
    cards,
    ranked,
    yourPlace,
    toast: g.toast,
    announce,
    dealKicker: g.round === 3 ? "Последний заход" : `Раунд 0${g.round}`,
    dealTitle: g.round === 3 ? "Банк" : "Пиши",
    dealSub: g.round === 3 ? "Один вопрос на всех. Поставь очки, если есть что ставить." : "Два вопроса. На каждый отвечают двое. Строчными.",
  };
}
