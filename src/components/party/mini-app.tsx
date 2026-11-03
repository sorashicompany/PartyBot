import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from "react";

type TelegramApp = {
  initData?: string;
  initDataUnsafe?: { start_param?: string; user?: { first_name?: string; last_name?: string } };
  HapticFeedback?: { notificationOccurred(type: "error" | "success" | "warning"): void; impactOccurred(style: "light" | "medium" | "heavy"): void };
};
type Player = { name: string; score: number; isHost: boolean };
type Prompt = { assignmentId: string; promptId: string; text: string; answered: boolean; slot: number };
type Answer = { id: string; promptId: string; text: string; name?: string; own: boolean; votes: number; voted: boolean; wager: number };
type RoomState = {
  code: string; status: string; round: number; deadline: string | null; customPromptCount: number;
  votingPromptIndex: number; customPromptsEnabled: boolean; isPromptAuthor: boolean; players: Player[]; prompts: Prompt[];
  promptLabels: Record<string,string>; activeVotingPromptId: string | null; answers: Answer[];
  votesCast: number; votesNeeded: number; isHost: boolean;
};
type Props = { initData: string; startCode: string; displayName: string };

export function MiniApp({ initData, startCode, displayName }: Props) {
  const [code, setCode] = useState(startCode);
  const [room, setRoom] = useState<RoomState | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [custom, setCustom] = useState<[string,string]>(["",""]);
  const [answer, setAnswer] = useState("");
  const [wager, setWager] = useState(0);
  const [refresh, setRefresh] = useState(0);
  const autoJoinAttempted = useRef(false);

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
    if (!room) return;
    const timer = window.setInterval(() => setRefresh(v => v + 1), 1800);
    return () => window.clearInterval(timer);
  }, [room?.code]);

  useEffect(() => { void loadState(); }, [loadState, refresh]);

  const join = async (event?: FormEvent) => {
    event?.preventDefault();
    if (!/^[A-HJ-NP-Z2-9]{5}$/i.test(code.trim())) { setError("Введи пятизначный код комнаты"); return; }
    setBusy(true); setError("");
    try {
      const data = await api("/api/rooms/join", "POST", { code: code.trim().toUpperCase() });
      const joinedCode = String(data.code || code).toUpperCase();
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
      await api(path, "POST", { code: room.code, ...payload });
      await loadState();
      setRefresh(v => v + 1);
      window.Telegram?.WebApp?.HapticFeedback?.impactOccurred("medium");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Не удалось выполнить действие");
    } finally { setBusy(false); }
  };

  const activeAnswers = useMemo(
    () => room?.answers.filter(a => a.promptId === room.activeVotingPromptId) ?? [],
    [room?.answers, room?.activeVotingPromptId],
  );

  if (!initData) {
    return <main className="stage"><div className="frame"><header className="topbar"><div><div className="brand">Сораши <span>Пати</span></div><p className="mode">Острослов</p></div></header><section className="sheet"><p className="kicker">Telegram Mini App</p><h1 className="display">Открой<br/><em>в Telegram.</em></h1><p className="lead">Для безопасного входа нужен профиль Telegram. Открой игру через кнопку бота в Telegram.</p></section></div></main>;
  }

  return (
    <main className="stage">
      <div className="watermark" aria-hidden="true">ПАТИ</div>
      <div className="frame">
        <header className="topbar">
          <div><div className="brand">Сораши <span>Пати</span></div><p className="mode">Острослов</p></div>
          <div className="top-actions"><span className="scorebug"><span>{displayName || "игрок"}</span></span></div>
        </header>

        {!room ? (
          <section className="sheet slam-in">
            <div className="lobby-grid">
              <div><p className="kicker">Шоу коротких ответов</p><h1 className="display">Время<br/><em>острить.</em></h1><p className="lead">Войди в комнату по коду. Имя уже взято из твоего профиля Telegram.</p></div>
              <form className="stack" onSubmit={join}>
                <label className="field-label" htmlFor="room-code">Код комнаты</label>
                <input id="room-code" className="field" value={code} maxLength={5} autoCapitalize="characters" autoComplete="one-time-code" placeholder="K7P4X" onChange={e => setCode(e.target.value.toUpperCase().replace(/[^A-HJ-NP-Z2-9]/g,""))}/>
                <div className="roster"><li>Игрок: {displayName || "Профиль Telegram"}</li></div>
                <button className="btn btn-lime" type="submit" disabled={busy || code.length !== 5}>{busy ? "Подключаем…" : "Войти в комнату"}</button>
              </form>
            </div>
          </section>
        ) : (
          <section className="sheet slam-in">
            <p className="kicker">Комната · {room.code}</p>
            <h1 className="display">{room.status === "lobby" ? "Собираем зал." : room.status === "custom_writing" ? "Своя колода." : room.status === "answering" ? "Время отвечать." : room.status === "voting" ? "Выбирай панч." : room.status === "round_results" ? "Итоги раунда." : "Шоу завершено."}</h1>
            <p className="lead">{room.status === "lobby" ? "Игроки подключаются по коду комнаты." : `Раунд ${room.round} из 3`}</p>
            <ul className="roster">
              {room.players.map((player,i) => <li key={i}>{player.name} · {player.score.toLocaleString("ru-RU")}{player.isHost ? " · ведущий" : ""}</li>)}
            </ul>

            {room.status === "lobby" && room.isHost ? (
              <div className="stack">
                <p className="sub">Для старта нужно от 4 до 10 реальных игроков.</p>
                <button className="btn btn-lime" disabled={busy || room.players.length < 4} onClick={() => void action("/api/game/start")}>Начать шоу</button>
              </div>
            ) : null}
            {room.status === "lobby" && !room.isHost ? <p className="lead">Ожидаем, пока ведущий начнёт игру.</p> : null}

            {room.status === "custom_writing" ? (
              <div className="stack">
                {room.customPromptCount >= 2 ? <p className="lead">Вопросы отправлены. Ждём остальных игроков.</p> : <>
                  <label className="field-label" htmlFor="custom-one">Первый вопрос</label>
                  <textarea id="custom-one" className="area" maxLength={240} value={custom[0]} onChange={e => setCustom([e.target.value,custom[1]])}/>
                  <label className="field-label" htmlFor="custom-two">Второй вопрос</label>
                  <textarea id="custom-two" className="area" maxLength={240} value={custom[1]} onChange={e => setCustom([custom[0],e.target.value])}/>
                  <button className="btn btn-lime" disabled={busy || custom.some(x => x.trim().length < 5)} onClick={() => void action("/api/game/custom-prompts",{prompts:custom})}>Отправить вопросы</button>
                </>}
              </div>
            ) : null}

            {room.status === "answering" && !room.prompts[0] ? <p className="lead">Ответы отправлены. Ждём остальных игроков.</p> : null}
            {room.status === "answering" && room.prompts[0] ? (
              <div className="stack">
                <p className="kicker">Твой вопрос · {room.prompts[0].slot === 1 ? "первый" : "второй"}</p>
                <h2 className="prompt">{room.prompts[0].text}</h2>
                {room.prompts[0].answered ? <p className="lead">Ответ принят. Ожидаем остальных игроков.</p> : <>
                  <label className="field-label" htmlFor="answer-text">Твой ответ <span>{answer.length}/240</span></label>
                  <input id="answer-text" className="field" maxLength={240} value={answer} autoCapitalize="none" onChange={e => setAnswer(e.target.value)}/>
                  {room.round === 3 ? <><label className="field-label" htmlFor="wager">Ставка: {wager.toLocaleString("ru-RU")}</label><input id="wager" className="slider" type="range" min="0" max="100000" step="100" value={wager} onChange={e => setWager(Number(e.target.value))}/></> : null}
                  <button className="btn btn-lime" disabled={busy || !answer.trim()} onClick={() => void action("/api/game/answer",{assignmentId:room.prompts[0].assignmentId,text:answer,wager})}>Отправить ответ</button>
                </>}
              </div>
            ) : null}

            {room.status === "voting" ? (
              <div className="stack">
                <p className="kicker">Голосование · {room.votingPromptIndex + 1}</p>
                <h2 className="prompt">{room.promptLabels[room.activeVotingPromptId || ""] || "Выбери лучший ответ"}</h2>
                {room.isPromptAuthor ? <p className="lead">Ты автор этого вопроса — здесь голосуют другие игроки.</p> : activeAnswers.map(a => <button key={a.id} className="vcard" disabled={busy || a.own || a.voted || activeAnswers.some(item => item.voted)} onClick={() => void action("/api/game/vote",{answerId:a.id})}><p className="punch">{a.text}</p><span className="stamp">{a.own ? "твой ответ" : a.voted ? "голос учтён" : "выбрать"}</span></button>)}
                <p className="sub">{activeAnswers.some(item => item.voted) ? "Голос принят. Ждём остальных." : "Выбери ответ, который смешнее."}</p>
              </div>
            ) : null}

            {room.status === "round_results" ? (
              <div className="stack">
                <h2 className="prompt">Текущий счёт</h2>
                {room.players.slice().sort((a,b)=>b.score-a.score).map((p,i)=><div className="board-row" key={p.name}><b>{i+1}</b><span>{p.name}</span><b>{p.score.toLocaleString("ru-RU")}</b></div>)}
                {room.isHost ? <button className="btn btn-lime" disabled={busy} onClick={() => void action("/api/game/next")}>{room.round >= 3 ? "Завершить шоу" : "Следующий раунд"}</button> : <p className="lead">Ждём ведущего.</p>}
              </div>
            ) : null}
            {room.status === "finished" ? <div className="stack"><h2 className="prompt">Финальный счёт</h2>{room.players.slice().sort((a,b)=>b.score-a.score).map((p,i)=><div className="board-row" key={p.name}><b>{i+1}</b><span>{p.name}</span><b>{p.score.toLocaleString("ru-RU")}</b></div>)}<button className="btn btn-ghost" onClick={()=>setRoom(null)}>Выйти из комнаты</button></div> : null}
            <div className="stack"><button className="btn btn-ghost" disabled={busy} onClick={()=>void loadState()}>Обновить</button></div>
          </section>
        )}
        {error ? <div className="toast" role="alert">{error}</div> : null}
      </div>
    </main>
  );
}
