import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent, type RefObject } from "react";

type Player = { name: string; score: number; isHost: boolean; you?: boolean };
type Prompt = { assignmentId: string; promptId: string; text: string; answered: boolean; slot: number };
type Answer = { id: string; promptId: string; pairKey?: string; text: string; name?: string; own: boolean; votes: number; voted: boolean; wager: number };
type ChatLine = { id: number; name: string; text: string; mine: boolean; at: number };
type RoomState = {
  code: string; status: string; round: number; deadline: string | null; customPromptCount: number; customPromptSubmitted: boolean; customPromptSubmittedSlots?: number[]; customPromptRequired: number; customPromptWriterName: string; isCustomPromptWriter: boolean; isFinalQuestionAuthor: boolean;
  votingPromptIndex: number; votingPromptTotal?: number; customPromptsEnabled: boolean; isPromptAuthor: boolean;
  players: Player[]; prompts: Prompt[]; promptLabels: Record<string, string>;
  activeVotingPromptId: string | null; activePairKey: string | null; answers: Answer[];
  unitVotes: number; unitVotesNeeded: number; isHost: boolean; chat?: ChatLine[];
};
type Props = { initData: string; startCode: string; displayName: string };

const REACTS = ["ахах", "в зал", "мимо", "жесть", "ещё"];
const MARKS = ["А", "Б", "В", "Г", "Д", "Е", "Ж", "З"];

export function MiniApp({ initData, startCode, displayName }: Props) {
  const [code, setCode] = useState(startCode);
  const [room, setRoom] = useState<RoomState | null>(null);
  const [roomTicket, setRoomTicket] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [custom, setCustom] = useState("");
  const [answer, setAnswer] = useState("");
  const [wager, setWager] = useState(0);
  const [draft, setDraft] = useState("");
  const [now, setNow] = useState(() => Date.now());
  const [refresh, setRefresh] = useState(0);
  const autoJoinAttempted = useRef(false);
  const savedResult = useRef("");
  const logRef = useRef<HTMLDivElement>(null);

  const api = useCallback(async (path: string, method: "GET" | "POST" = "GET", payload?: Record<string, unknown>) => {
    const response = await fetch(path, {
      method,
      headers: { "Content-Type": "application/json", "X-Telegram-Init-Data": initData },
      ...(payload ? { body: JSON.stringify(payload) } : {}),
    });
    const data = await response.json().catch(() => ({})) as Record<string, unknown>;
    if (!response.ok) throw new Error(typeof data.error === "string" ? data.error : "Не удалось выполнить запрос");
    return data;
  }, [initData]);

  const loadState = useCallback(async () => {
    if (!room?.code) return;
    try {
      const data = await api(`/api/game/state?code=${encodeURIComponent(room.code)}`);
      setRoom(data as unknown as RoomState);
      setError("");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Ошибка загрузки комнаты");
    }
  }, [api, room?.code]);

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 500);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    if (!room) return;
    const timer = window.setInterval(() => setRefresh(v => v + 1), 5000);
    return () => window.clearInterval(timer);
  }, [room?.code, room?.status]);

  useEffect(() => { void loadState(); }, [loadState, refresh]);

  useEffect(() => {
    if (!room?.code || !roomTicket) return;
    const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
    const socket = new WebSocket(`${protocol}//${window.location.host}/ws/rooms/${room.code}?ticket=${encodeURIComponent(roomTicket)}`);
    socket.onmessage = (event) => {
      try {
        const message = JSON.parse(String(event.data)) as { type?: string };
        if (message.type && message.type !== "connected" && message.type !== "pong") {
          void loadState();
        }
      } catch { /* Ignore malformed room events; the fallback poll remains active. */ }
    };
    return () => socket.close(1000, "room view changed");
  }, [room?.code, roomTicket, loadState]);

  useEffect(() => {
    logRef.current?.scrollTo({ top: logRef.current.scrollHeight });
  }, [room?.chat?.length, room?.activePairKey]);

  useEffect(() => {
    if (!room || room.status !== "finished" || savedResult.current === room.code) return;
    const ranked = [...room.players].sort((a, b) => b.score - a.score);
    const place = ranked.findIndex(player => player.you) + 1;
    const me = ranked.find(player => player.you);
    if (!me || place < 1) return;
    savedResult.current = room.code;
    void api("/api/profile/result", "POST", { score: me.score, place }).catch(() => {
      savedResult.current = "";
    });
  }, [api, room]);

  const join = async (event?: FormEvent) => {
    event?.preventDefault();
    if (!/^[A-HJ-NP-Z2-9]{5}$/i.test(code.trim())) { setError("Нужен код из пяти знаков"); return; }
    setBusy(true); setError("");
    try {
      const data = await api("/api/rooms/join", "POST", { code: code.trim().toUpperCase() });
      const joinedCode = String(data.code || code).toUpperCase();
      setRoomTicket(String(data.ticket || ""));
      const state = await api(`/api/game/state?code=${encodeURIComponent(joinedCode)}`);
      setRoom(state as unknown as RoomState);
      setCode(joinedCode);
      window.Telegram?.WebApp?.HapticFeedback?.notificationOccurred("success");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Не удалось войти в комнату");
      window.Telegram?.WebApp?.HapticFeedback?.notificationOccurred("error");
    } finally { setBusy(false); }
  };

  useEffect(() => {
    if (!room && initData && /^[A-HJ-NP-Z2-9]{5}$/i.test(startCode) && !autoJoinAttempted.current) {
      autoJoinAttempted.current = true;
      void join();
    }
  }, [startCode, initData]);

  const action = async (path: string, payload: Record<string, unknown> = {}) => {
    if (!room) return;
    setBusy(true); setError("");
    try {
      const data = await api(path, "POST", { code: room.code, ...payload });
      if (path.endsWith("/answer")) setAnswer("");
      if (path.endsWith("/custom-prompts")) setCustom("");
      if (path.endsWith("/chat") && Array.isArray(data.messages)) {
        setDraft("");
        setRoom(current => current ? { ...current, chat: data.messages as ChatLine[] } : current);
      }
      await loadState();
      setRefresh(v => v + 1);
      window.Telegram?.WebApp?.HapticFeedback?.impactOccurred("medium");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Не удалось выполнить действие");
    } finally { setBusy(false); }
  };

  const activeAnswers = useMemo(() => {
    if (!room) return [];
    if (room.activePairKey) return room.answers.filter(item => item.pairKey === room.activePairKey);
    return room.answers.filter(item => item.promptId === room.activeVotingPromptId);
  }, [room]);

  const lockedVote = activeAnswers.some(item => item.voted);
  const remain = room?.deadline ? Math.max(0, Date.parse(room.deadline) - now) : 0;
  const totalWindow = room?.status === "answering" ? 70000 : room?.status === "custom_writing" ? 120000 : 22000;
  const timerScale = room?.deadline ? Math.max(0, Math.min(1, remain / totalWindow)) : 0;
  const you = room?.players.find(player => player.you);

  if (!initData) {
    return (
      <main className="stage">
        <div className="watermark" aria-hidden="true">ПАТИ</div>
        <div className="frame">
          <Brand name={displayName} />
          <section className="sheet slam-in">
            <p className="kicker">только из Telegram</p>
            <h1 className="display">Зал<br /><em>закрыт.</em></h1>
            <p className="lead">Открой игру кнопкой бота в чате, где написали /party. Оттуда же бот будет кричать вопросы и счёт.</p>
          </section>
        </div>
      </main>
    );
  }

  return (
    <main className="stage">
      <div className="watermark" aria-hidden="true">ПАТИ</div>
      <div className="frame">
        <Brand name={you?.name || displayName || "игрок"} score={you?.score} />
        {!room ? (
          <section className="sheet slam-in">
            <p className="kicker">шоу коротких ответов</p>
            <h1 className="display">Время<br /><em>острить.</em></h1>
            <p className="lead">Код комнаты уже в чате. Имя возьмём из Telegram, выдумывать сцену не надо.</p>
            <form className="stack" onSubmit={join}>
              <label className="field-label" htmlFor="room-code">Код комнаты</label>
              <input id="room-code" className="field" value={code} maxLength={5} autoCapitalize="characters" autoComplete="one-time-code" placeholder="K7P4X" onChange={e => setCode(e.target.value.toUpperCase().replace(/[^A-HJ-NP-Z2-9]/g, ""))} />
              <button className="btn btn-yellow" type="submit" disabled={busy || code.length !== 5}>{busy ? "Сажаем…" : "Сесть в зал"}</button>
            </form>
          </section>
        ) : (
          <section key={`${room.code}:${room.status}:${room.round}:${room.votingPromptIndex}`} className={`sheet slam-in${room.status === "voting" ? " wide" : ""}`}>
            <p className="kicker">
              {room.code}
              {room.round ? ` · раунд ${room.round}/3` : " · лобби"}
              {room.status === "voting" && room.votingPromptTotal ? ` · вопрос ${room.votingPromptIndex + 1}/${room.votingPromptTotal}` : ""}
            </p>
            {room.deadline && room.status !== "round_results" && room.status !== "finished" ? (
              <div className={`timer${remain < 8000 ? " hot" : ""}`} aria-hidden="true"><span style={{ transform: `scaleX(${timerScale})` }} /></div>
            ) : null}
            <PlayerStrip players={room.players} />

            {room.status === "lobby" ? (
              <div className="stack">
                <h1 className="display">Ждём<br /><em>зал.</em></h1>
                <p className="lead">{room.isHost ? "Как только вас трое — жми старт. Чат группы уже слышит, кто садится." : "Ведущий откроет шоу. Бот в чате напишет, когда начнётся."}</p>
                {room.isHost ? (
                  <>
                    <button className="btn btn-ghost" disabled={busy} onClick={() => void action("/api/game/settings", { customEnabled: !room.customPromptsEnabled })}>
                      {room.customPromptsEnabled ? "Свои вопросы включены" : "Играть колодой бота"}
                    </button>
                    <button className="btn btn-yellow" disabled={busy || room.players.length < 3} onClick={() => void action("/api/game/start")}>Начать шоу</button>
                  </>
                ) : null}
              </div>
            ) : null}

            {room.status === "custom_writing" ? (
              <div className="stack">
                <h1 className="display">{room.round === 3 ? <>Финальный<br /><em>вопрос.</em></> : <>Твой<br /><em>вопрос.</em></>}</h1>
                {room.round === 3 ? (
                  <p className="lead">Лидер по очкам — {room.customPromptWriterName}. Он придумывает финальный вопрос, но сам на него не отвечает.</p>
                ) : (
                  <p className="lead">Каждый игрок пишет два вопроса. Принято: {room.customPromptCount}/{room.customPromptRequired}.</p>
                )}
                {room.customPromptSubmitted ? <p className="lead">Все вопросы отправлены. Ждём остальных.</p> : room.isCustomPromptWriter ? (
                  <>
                    <label className="field-label" htmlFor="custom-question">{room.round === 3 ? "Финальный вопрос" : `Вопрос №${room.customPromptSubmittedSlots?.includes(1) ? 2 : 1} из 2`} <span>{custom.length}/240</span></label>
                    <textarea id="custom-question" className="area" maxLength={240} value={custom} onChange={e => setCustom(e.target.value)} />
                    <button className="btn btn-yellow" disabled={busy || custom.trim().length < 5} onClick={() => void action("/api/game/custom-prompts", { prompt: custom, slot: room.round === 3 ? 1 : (room.customPromptSubmittedSlots?.includes(1) ? 2 : 1) })}>Отправить вопрос</button>
                  </>
                ) : <p className="lead">В этом раунде вопрос придумывает лидер. Ждём его вопрос.</p>}
              </div>
            ) : null}

            {room.status === "answering" && !room.prompts[0] ? <div className="stack"><h1 className="display">{room.isFinalQuestionAuthor ? <>Твой<br /><em>финал.</em></> : <>Ответ<br /><em>улетел.</em></>}</h1><p className="lead">{room.isFinalQuestionAuthor ? "Ты придумал финальный вопрос. Сам отвечать не можешь — дождись ответов остальных и голосуй за лучший." : "Ждём остальные ответы. В чат панчи попадут только на голосовании."}</p></div> : null}
            {room.status === "answering" && room.prompts[0] ? (
              <div className="stack">
                <h1 className="display">{room.prompts[0].slot === 2 ? "Второй" : "Первый"}<br /><em>панч.</em></h1>
                <div className="bubble"><p className="kicker">вопрос</p><h2 className="prompt">{room.prompts[0].text}</h2></div>
                {room.prompts[0].answered ? <p className="lead">Принято. Можно выдохнуть.</p> : (
                  <>
                    <label className="field-label" htmlFor="answer-text">Ответ <span>{answer.length}/240</span></label>
                    <input id="answer-text" className="field" maxLength={240} value={answer} autoCapitalize="sentences" placeholder="короче и злее" onChange={e => setAnswer(e.target.value)} />
                    {room.round === 3 ? (
                      <>
                        <label className="field-label" htmlFor="wager">Ставка {wager.toLocaleString("ru-RU")}</label>
                        <input id="wager" className="slider" type="range" min="0" max={Math.max(0, you?.score || 0)} step="100" value={Math.min(wager, you?.score || 0)} onChange={e => setWager(Number(e.target.value))} />
                      </>
                    ) : null}
                    <button className="btn btn-yellow" disabled={busy || !answer.trim()} onClick={() => void action("/api/game/answer", { assignmentId: room.prompts[0].assignmentId, text: answer, wager })}>Отправить</button>
                  </>
                )}
              </div>
            ) : null}

            {room.status === "voting" ? (
              <div className="stack">
                <h1 className="display">Кто<br /><em>смешнее?</em></h1>
                <div className="bubble">
                  <p className="kicker">вопрос</p>
                  <h2 className="prompt">{room.promptLabels[room.activeVotingPromptId || ""] || "Выбирай панч"}</h2>
                </div>
                {room.isPromptAuthor ? <p className="lead">Ты автор — голосуют другие. Зато чат зала твой.</p> : null}
                <div className="duel">
                  {activeAnswers.map((item, index) => (
                    <button
                      key={item.id}
                      className={`quip${item.voted ? " chosen" : ""}`}
                      aria-pressed={item.voted}
                      aria-label={`Ответ ${MARKS[index] || index + 1}: ${item.text}`}
                      disabled={busy || item.own || lockedVote || room.isPromptAuthor}
                      onClick={() => void action("/api/game/vote", { answerId: item.id })}
                    >
                      <span className="mark">{MARKS[index] || index + 1}</span>
                      <p className="punch">{item.text}</p>
                      <span className="stamp">{item.own ? "это ты" : item.voted ? "голос ушёл" : lockedVote ? "уже выбрал" : "выбрать"}</span>
                    </button>
                  ))}
                </div>
                <p className="sub" role="status" aria-live="polite">{lockedVote ? "Ждём зал." : `Голоса ${room.unitVotes}/${room.unitVotesNeeded}`}</p>
                <Audience chat={room.chat || []} draft={draft} busy={busy} logRef={logRef} onDraft={setDraft} onSend={(text) => void action("/api/game/chat", { text })} />
              </div>
            ) : null}

            {room.status === "round_results" || room.status === "finished" ? (
              <div className="stack">
                <h1 className="display">{room.status === "finished" ? "Занавес." : "Счёт."}</h1>
                <Scoreboard players={room.players} reveal={room.answers} />
                {room.status === "round_results" && room.isHost ? (
                  <button className="btn btn-yellow" disabled={busy} onClick={() => void action("/api/game/next")}>{room.round >= 3 ? "Закрыть шоу" : "Дальше"}</button>
                ) : null}
                {room.status === "round_results" && !room.isHost ? <p className="lead">Ведущий листает дальше. Бот уже написал итог в чат.</p> : null}
                {room.status === "finished" ? <button className="btn btn-ghost" onClick={() => setRoom(null)}>Выйти</button> : null}
              </div>
            ) : null}
          </section>
        )}
        {error ? <div className="toast" role="alert">{error}</div> : null}
      </div>
    </main>
  );
}

function Brand({ name, score }: { name: string; score?: number }) {
  return (
    <header className="topbar">
      <div className="brand-lockup">
        <div>
          <div className="brand">Сораши <span>Пати</span></div>
          <p className="mode">Острослов · живая комната</p>
        </div>
      </div>
      <div className="scorebug">
        <span>{name}</span>
        {typeof score === "number" ? <b key={score}>{score.toLocaleString("ru-RU")}</b> : null}
      </div>
    </header>
  );
}

function PlayerStrip({ players }: { players: Player[] }) {
  return (
    <div className="strip" aria-label="Игроки комнаты">
      {players.map((player, index) => (
        <div key={`${player.name}-${index}`} className={player.you ? "chip you" : "chip"}>
          <span className="who">{player.name}</span>
          <span className="pts">{player.score.toLocaleString("ru-RU")}</span>
          {player.isHost ? <span className="tag"> · ведущий</span> : null}
        </div>
      ))}
    </div>
  );
}

function Scoreboard({ players, reveal }: { players: Player[]; reveal: Answer[] }) {
  const ranked = [...players].sort((a, b) => b.score - a.score);
  const laughs = reveal.filter(item => item.name && item.votes > 0).sort((a, b) => b.votes - a.votes).slice(0, 3);
  return (
    <div className="stack">
      {ranked.map((player, index) => (
        <div className="board-row" key={`${player.name}-${index}`}>
          <b>{index + 1}</b>
          <span>{player.name}</span>
          <b>{player.score.toLocaleString("ru-RU")}</b>
        </div>
      ))}
      {laughs.map(item => (
        <p className="lead" key={item.id}>«{item.text}» — {item.name}, {item.votes}</p>
      ))}
    </div>
  );
}

function Audience({
  chat, draft, busy, logRef, onDraft, onSend,
}: {
  chat: ChatLine[];
  draft: string;
  busy: boolean;
  logRef: RefObject<HTMLDivElement | null>;
  onDraft: (value: string) => void;
  onSend: (text: string) => void;
}) {
  const submit = (event?: FormEvent) => {
    event?.preventDefault();
    const text = draft.trim();
    if (!text || busy) return;
    onSend(text);
  };
  return (
    <section className="audience" aria-label="Чат зала">
      <header>
        <b>Зал</b>
        <span>только этот вопрос</span>
      </header>
      <div className="log" ref={logRef}>
        {chat.length ? chat.map(line => (
          <div className={`line${line.mine ? " mine" : ""}`} key={line.id}>
            <small>{line.mine ? "ты" : line.name}</small>
            <p>{line.text}</p>
          </div>
        )) : <p className="quiet">Пока тихо. Первая реплика решает, будет ли тут цирк.</p>}
      </div>
      <div className="reacts">
        {REACTS.map(text => (
          <button key={text} type="button" disabled={busy} onClick={() => onSend(text)}>{text}</button>
        ))}
      </div>
      <form className="composer" onSubmit={submit}>
        <input value={draft} maxLength={160} placeholder="крикнуть в зал" aria-label="Сообщение в зал" onChange={e => onDraft(e.target.value)} />
        <button type="submit" disabled={busy || !draft.trim()}>Ор</button>
      </form>
    </section>
  );
}
