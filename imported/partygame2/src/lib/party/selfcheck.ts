import {
  castVote,
  continueBoard,
  createLobby,
  duelPoints,
  finalPayout,
  present,
  setBotCount,
  setCustomOn,
  setCustomText,
  setDraft,
  setName,
  startGame,
  submitAnswer,
  submitCustom,
  tick,
  TIMING,
  type Game,
} from "./engine";

function assert(cond: boolean, msg: string, errors: string[]): void {
  if (!cond) errors.push(msg);
}

function pairingOk(g: Game, errors: string[]): void {
  const players = g.players.length;
  assert(g.assignments.length === players * 2, `round 1 assignments ${g.assignments.length}`, errors);
  const pairs = new Map<string, string[]>();
  for (const assignment of g.assignments) {
    const bucket = pairs.get(assignment.pair) ?? [];
    bucket.push(assignment.playerId);
    pairs.set(assignment.pair, bucket);
  }
  assert(pairs.size === players, `pair count ${pairs.size}`, errors);
  for (const [pair, ids] of pairs) {
    assert(new Set(ids).size === 2, `${pair} not a duel`, errors);
  }
  for (const player of g.players) {
    const mine = g.assignments.filter((assignment) => assignment.playerId === player.id);
    assert(mine.length === 2, `${player.name} slots ${mine.length}`, errors);
    assert(new Set(mine.map((assignment) => assignment.qid)).size === 2, `${player.name} repeated prompt`, errors);
  }
}

function play(custom: boolean): Game {
  const start = 1_700_000_000_000;
  let g = setBotCount(setName(createLobby(), "Лера"), 3);
  g = setCustomOn(g, custom);
  g = startGame(g, start);
  let t = start;
  let guard = 0;
  let checkedIllegal = false;
  while (g.phase !== "podium" && guard++ < 6000) {
    const view = present(g, t);
    if (g.phase === "custom") {
      if (!g.customs.some((row) => row.playerId === "you")) {
        g = setCustomText(g, 0, "Что нельзя класть в общую пельменную комнату?");
        g = setCustomText(g, 1, "Худшее имя для городской площади?");
        g = submitCustom(g, t);
      } else {
        t += 450;
        g = tick(g, t);
      }
    } else if (g.phase === "answer" && view.currentAssignmentId) {
      g = setDraft(g, `ответ номера ${view.slotLabel ?? guard}`);
      g = submitAnswer(g, t);
    } else if (view.cards?.canVote) {
      if (!checkedIllegal && view.cards.mode === "final") {
        const own = view.cards.items.find((item) => item.you);
        if (own) {
          const before = g.votes.length;
          g = castVote(g, own.id, t);
          if (g.votes.length !== before) throw new Error("final accepted a self vote");
          if (!g.toast) throw new Error("final self vote had no toast");
        }
        checkedIllegal = true;
      }
      const choice = view.cards.items.find((item) => !item.you);
      if (!choice) throw new Error("no legal card");
      g = castVote(g, choice.id, t);
    } else if (view.cards?.youAreAuthor) {
      const before = g.votes.length;
      const any = view.cards.items[0];
      if (any) g = castVote(g, any.id, t);
      if (g.votes.length !== before) throw new Error("author voted in own duel");
      t += 500;
      g = tick(g, t);
    } else if (g.phase === "board") {
      g = continueBoard(g, t);
    } else {
      t += 450;
      g = tick(g, t);
    }
  }
  if (g.phase !== "podium") throw new Error(`stuck in ${g.phase} round ${g.round} after ${guard}`);
  return g;
}

export function runSelfCheck(): void {
  const errors: string[] = [];
  const points = duelPoints([2, 0], 2);
  assert(points[0] === 4000 && points[1] === 0, `sweep points ${points.join(",")}`, errors);
  assert(duelPoints([1, 1], 2).join() === "1000,1000", "split duel", errors);

  const pot = finalPayout([
    { id: "a", score: 2000, wager: 1000, votes: 2 },
    { id: "b", score: 2000, wager: 1000, votes: 0 },
  ]);
  assert(pot[0]?.score === 3000 && pot[0]?.delta === 1000, "pot winner", errors);
  assert(pot[1]?.score === 1000 && pot[1]?.delta === -1000, "pot loser", errors);

  const empty = finalPayout([
    { id: "a", score: 0, wager: 0, votes: 3 },
    { id: "b", score: 0, wager: 0, votes: 1 },
  ]);
  assert(empty[0]?.delta === 3000 && empty[1]?.delta === 1000, "empty pot pays votes", errors);

  const tie = finalPayout([
    { id: "a", score: 500, wager: 100, votes: 1 },
    { id: "b", score: 500, wager: 100, votes: 1 },
  ]);
  assert(tie[0]?.delta === 0 && tie[1]?.delta === 0, "tie refunds via split", errors);

  const refund = finalPayout([
    { id: "a", score: 400, wager: 200, votes: 0 },
    { id: "b", score: 400, wager: 200, votes: 0 },
  ]);
  assert(refund[0]?.score === 400 && refund[1]?.score === 400, "no votes refunds", errors);

  const start = 1_700_000_000_000;
  let opener = startGame(setBotCount(setName(createLobby(), "Лера"), 3), start);
  opener = tick(opener, start + TIMING.dealMs + 20);
  assert(opener.phase === "answer" && opener.round === 1, `expected answer, got ${opener.phase}`, errors);
  pairingOk(opener, errors);

  const finished = play(false);
  assert(finished.players.length === 4, "player count", errors);
  assert(finished.players.every((player) => player.score >= 0 && Number.isInteger(player.score)), "scores", errors);
  assert(Math.max(...finished.players.map((player) => player.score)) > 0, "somebody scored", errors);
  assert(finished.seenTexts.length === 9, `dealt ${finished.seenTexts.length}`, errors);
  for (const vote of finished.votes) {
    const answer = finished.answers.find((item) => item.id === vote.answerId);
    assert(Boolean(answer && answer.playerId !== vote.voterId), "self vote in final", errors);
  }

  const custom = play(true);
  assert(custom.phase === "podium", "custom podium", errors);
  assert(
    custom.seenTexts.some((text) => text.includes("пельмен")),
    "custom prompt was dealt",
    errors,
  );
  assert(custom.players.every((player) => player.score >= 0), "custom scores", errors);

  if (errors.length) throw new Error(errors.join("\n"));
}
