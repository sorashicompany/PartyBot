import { useEffect, useRef, useState, type RefObject } from "react";
import { Volume2, VolumeX } from "lucide-react";
import { BOT_NAMES } from "@/lib/party/content";
import { bindMute, readMuted, setMuted, sfx, unlockAudio, type Sfx } from "@/lib/party/audio";
import {
  castVote,
  continueBoard,
  createLobby,
  fillExamples,
  formatPoints,
  hurry,
  present,
  replay,
  setBotCount,
  setCustomOn,
  setCustomText,
  setDraft,
  setName,
  setWager,
  skipCustom,
  startGame,
  submitAnswer,
  submitCustom,
  tick,
  type Game,
} from "@/lib/party/engine";

export function PartyShow() {
  const [game, setGame] = useState<Game>(createLobby);
  const [now, setNow] = useState(0);
  const [rules, setRules] = useState(false);
  const [muted, setMute] = useState(false);
  const view = present(game, now);
  const phaseKey = `${view.phase}-${view.round}-${view.cards?.index ?? 0}-${view.currentAssignmentId ?? "wait"}`;
  const inputRef = useRef<HTMLInputElement>(null);
  const you = view.players.find((player) => player.you);
  const savedRound = useRef<number | null>(null);

  useEffect(() => {
    const id = window.setInterval(() => {
      const t = Date.now();
      setNow(t);
      setGame((current) => tick(current, t));
    }, 100);
    return () => window.clearInterval(id);
  }, []);

  useEffect(() => {
    const stored = readMuted();
    setMute(stored);
    bindMute(stored);
  }, []);

  useEffect(() => {
    if (view.phase === "answer") inputRef.current?.focus();
  }, [view.phase, view.currentAssignmentId]);

  useEffect(() => {
    if (view.phase !== "podium" || !you || savedRound.current === view.round) return;
    const initData = window.Telegram?.WebApp?.initData;
    if (!initData) return;
    savedRound.current = view.round;
    void fetch("/api/profile/result", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Telegram-Init-Data": initData },
      body: JSON.stringify({ score: you.score, place: view.yourPlace ?? 0 }),
    }).catch(() => {
      savedRound.current = null;
    });
  }, [view.phase, view.round, view.yourPlace, you?.score]);

  const prev = useRef(view.phase);
  useEffect(() => {
    if (prev.current === view.phase) return;
    if (view.phase === "deal" || view.phase === "custom") sfx("go");
    if (view.phase === "reveal") sfx(view.cards?.sweep ? "sweep" : "score");
    if (view.phase === "podium") sfx(view.yourPlace === 1 ? "sweep" : "score");
    prev.current = view.phase;
  }, [view.phase, view.cards?.sweep, view.yourPlace]);

  const act = (fn: (current: Game, time: number) => Game, sound?: Sfx) => {
    const time = Date.now();
    unlockAudio();
    if (sound) sfx(sound);
    setNow(time);
    setGame((current) => fn(current, time));
  };

  const wide = view.phase === "vote" || view.phase === "reveal" || view.phase === "podium";

  return (
    <main className="stage" onPointerDown={() => unlockAudio()}>
      <div className="watermark" aria-hidden="true">ПАТИ</div>
      <div className="frame">
        <p className="sr-only" aria-live="polite">{view.announce}</p>
        <header className="topbar">
          <div>
            <div className="brand">Сораши <span>Пати</span></div>
            <p className="mode">Острослов</p>
          </div>
          <div className="top-actions">
            {view.phase !== "lobby" && view.phase !== "custom" ? (
              <div className="pips" aria-label={`Раунд ${view.round} из 3`}>
                {[1, 2, 3].map((round) => (
                  <i key={round} className={round === view.round ? "pip now" : round < view.round ? "pip on" : "pip"} />
                ))}
              </div>
            ) : null}
            {you ? (
              <div className="scorebug">
                <span>ты</span>
                <b>{formatPoints(you.score)}</b>
              </div>
            ) : null}
            <button
              type="button"
              className="icon-btn"
              aria-label={muted ? "Включить звук" : "Выключить звук"}
              onClick={() => {
                const next = !muted;
                setMute(next);
                setMuted(next);
                bindMute(next);
              }}
            >
              {muted ? <VolumeX size={18} /> : <Volume2 size={18} />}
            </button>
          </div>
        </header>

        {view.players.length ? (
          <div className="strip">
            {view.players.map((player) => (
              <div key={player.id} className={player.you ? "chip you" : player.done ? "chip done" : "chip"}>
                {player.delta ? (
                  <span className={player.delta < 0 ? "delta down pop" : "delta pop"}>
                    {player.delta > 0 ? `+${formatPoints(player.delta)}` : formatPoints(player.delta)}
                  </span>
                ) : null}
                <span className="who">{player.name}</span>
                <span className="pts">{formatPoints(player.score)}</span>
                {player.bot ? <span className="tag"> · бот</span> : null}
                {player.typing ? <span className="tag dots"> пишет</span> : null}
              </div>
            ))}
          </div>
        ) : null}

        {view.timer ? (
          <div className={view.timer.hot ? "timer hot" : "timer"} aria-hidden="true">
            <span style={{ transform: `scaleX(${view.timer.ratio})` }} />
          </div>
        ) : null}

        <section key={phaseKey} className={wide ? "sheet wide slam-in" : "sheet slam-in"}>
          {view.phase === "lobby" ? (
            <Lobby
              name={view.youName}
              bots={view.botCount}
              customOn={view.customOn}
              rules={rules}
              onRules={() => setRules((open) => !open)}
              onName={(value) => act((current) => setName(current, value))}
              onBots={(count) => act((current) => setBotCount(current, count), "tap")}
              onCustom={(on) => act((current) => setCustomOn(current, on), "tap")}
              onStart={() => act((current, time) => startGame(current, time))}
            />
          ) : null}

          {view.phase === "custom" ? (
            <CustomPhase
              texts={view.customTexts}
              submitted={view.youSubmittedCustom}
              left={view.timer?.left ?? 0}
              players={view.players}
              onChange={(index, value) => act((current) => setCustomText(current, index, value))}
              onExamples={() => act((current) => fillExamples(current), "tap")}
              onSubmit={() => act((current, time) => submitCustom(current, time), "send")}
              onSkip={() => act((current, time) => skipCustom(current, time), "tap")}
            />
          ) : null}

          {view.phase === "deal" ? (
            <div>
              <p className="kicker">{view.dealKicker}</p>
              <h1 className="display">{view.dealTitle}</h1>
              <p className="lead">{view.dealSub}</p>
              <div className="stack">
                <button type="button" className="btn btn-ghost" onClick={() => act((current, time) => hurry(current, time), "tap")}>
                  Пропустить заставку
                </button>
              </div>
            </div>
          ) : null}

          {view.phase === "answer" ? (
            <AnswerPhase
              inputRef={inputRef}
              prompt={view.prompt}
              slot={view.slotLabel}
              draft={view.draft}
              waiting={view.waiting}
              progress={view.answerProgress}
              round={view.round}
              wager={view.wager}
              wagerMax={view.wagerMax}
              left={view.timer?.left ?? 0}
              players={view.players}
              onDraft={(value) => act((current) => setDraft(current, value))}
              onWager={(value) => act((current) => setWager(current, value))}
              onSubmit={() => act((current, time) => submitAnswer(current, time), "send")}
              onHurry={() => act((current, time) => hurry(current, time), "tap")}
            />
          ) : null}

          {view.cards && (view.phase === "vote" || view.phase === "reveal") ? (
            <VotePhase
              cards={view.cards}
              phase={view.phase}
              left={view.timer?.left ?? 0}
              onVote={(id) => act((current, time) => castVote(current, id, time), "vote")}
              onHurry={() => act((current, time) => hurry(current, time), "tap")}
            />
          ) : null}

          {view.phase === "board" ? (
            <Board
              round={view.round}
              ranked={view.ranked}
              onNext={() => act((current, time) => continueBoard(current, time), "tap")}
            />
          ) : null}

          {view.phase === "podium" ? (
            <Podium
              ranked={view.ranked}
              place={view.yourPlace}
              onReplay={() => {
                sfx("tap");
                setGame((current) => replay(current));
              }}
            />
          ) : null}
        </section>
      </div>
      {view.toast ? <div className="toast" role="status">{view.toast}</div> : null}
    </main>
  );
}

function Lobby({
  name, bots, customOn, rules, onRules, onName, onBots, onCustom, onStart,
}: {
  name: string;
  bots: number;
  customOn: boolean;
  rules: boolean;
  onRules: () => void;
  onName: (value: string) => void;
  onBots: (count: number) => void;
  onCustom: (on: boolean) => void;
  onStart: () => void;
}) {
  const cast = ["Ты", ...BOT_NAMES.slice(0, bots)];
  return (
    <div className="lobby-grid">
      <div>
        <p className="kicker">Шоу коротких ответов</p>
        <h1 className="display">Время<br /><em>острить.</em></h1>
        <p className="lead">Два панча, потом зал выбирает, что смешнее. В финале очки можно поставить в банк.</p>
      </div>
      <div className="stack">
        <label className="field-label" htmlFor="player-name">
          Как тебя объявить
        </label>
        <input
          id="player-name"
          className="field"
          maxLength={16}
          placeholder="Ты"
          value={name}
          autoComplete="nickname"
          onChange={(event) => onName(event.target.value)}
        />
        <ul className="roster">
          {cast.map((person) => <li key={person}>{person}{person === "Ты" ? "" : " · бот"}</li>)}
        </ul>
        <div className="stepper">
          <button type="button" aria-label="Меньше ботов" disabled={bots <= 3} onClick={() => onBots(bots - 1)}>−</button>
          <b>В зале: {bots + 1}</b>
          <button type="button" aria-label="Больше ботов" disabled={bots >= 7} onClick={() => onBots(bots + 1)}>+</button>
        </div>
        <div className="toggle-row">
          <div>
            <strong>Свои вопросы</strong>
            <p className="sub">Каждый пишет два вопроса. Не сдашь — возьмём из колоды шоу.</p>
          </div>
          <button type="button" role="switch" aria-checked={customOn} className={customOn ? "switch on" : "switch"} onClick={() => onCustom(!customOn)}>
            <span />
          </button>
        </div>
        <button type="button" className="btn btn-lime" onClick={onStart}>Начать шоу</button>
        <button type="button" className="btn btn-ghost" onClick={onRules}>{rules ? "Скрыть правила" : "Как считают очки"}</button>
      </div>
      {rules ? (
        <div className="rules">
          <p className="kicker">Правила</p>
          <ol>
            <li>Раунды 1 и 2 — пары. У каждого два вопроса, на каждый отвечают двое.</li>
            <li>Голосуют те, кто этот вопрос не писал. Голос стоит 1000. Если все голоса на одной стороне — ×2.</li>
            <li>Финал — один вопрос на всех. Победитель забирает банк. Если ставить было нечего, голос стоит 1000.</li>
            <li>Не успел — шоу ставит сейф. Его тоже можно выбрать. Пиши строчными.</li>
          </ol>
        </div>
      ) : null}
    </div>
  );
}

function CustomPhase({
  texts, submitted, left, players, onChange, onExamples, onSubmit, onSkip,
}: {
  texts: [string, string];
  submitted: boolean;
  left: number;
  players: { id: string; name: string; done: boolean; typing: boolean }[];
  onChange: (index: 0 | 1, value: string) => void;
  onExamples: () => void;
  onSubmit: () => void;
  onSkip: () => void;
}) {
  return (
    <div>
      <p className="kicker">Своя колода · {left} с</p>
      <h1 className="prompt">Два вопроса, на которые стыдно отвечать всерьёз</h1>
      {submitted ? (
        <p className="lead">Принято. Ждём, пока допишут остальные.</p>
      ) : (
        <div className="stack">
          <label className="field-label" htmlFor="q1">Первый вопрос <span>{texts[0].length}/140</span></label>
          <textarea id="q1" className="area" maxLength={140} value={texts[0]} onChange={(event) => onChange(0, event.target.value)} />
          <label className="field-label" htmlFor="q2">Второй вопрос <span>{texts[1].length}/140</span></label>
          <textarea id="q2" className="area" maxLength={140} value={texts[1]} onChange={(event) => onChange(1, event.target.value)} />
          <button type="button" className="btn btn-ghost" onClick={onExamples}>Подставить пример</button>
          <button type="button" className="btn btn-lime" onClick={onSubmit}>Сдать два вопроса</button>
        </div>
      )}
      <Roster players={players} />
      <div className="stack">
        <button type="button" className="btn btn-ghost" onClick={onSkip}>Дальше с тем, что уже есть</button>
      </div>
    </div>
  );
}

function AnswerPhase({
  inputRef, prompt, slot, draft, waiting, progress, round, wager, wagerMax, left, players, onDraft, onWager, onSubmit, onHurry,
}: {
  inputRef: RefObject<HTMLInputElement | null>;
  prompt: string | null;
  slot: string | null;
  draft: string;
  waiting: boolean;
  progress: { done: number; total: number };
  round: number;
  wager: number;
  wagerMax: number;
  left: number;
  players: { id: string; name: string; done: boolean; typing: boolean }[];
  onDraft: (value: string) => void;
  onWager: (value: number) => void;
  onSubmit: () => void;
  onHurry: () => void;
}) {
  return (
    <div>
      <p className="kicker">{slot} · {left} с · сдано {progress.done}/{progress.total}</p>
      <h1 className="prompt">{waiting ? "Ждём остальные панчи" : prompt}</h1>
      {waiting ? (
        <p className="lead">Твои ответы уже в зале. Боты ещё дописывают — или ускорь шоу.</p>
      ) : (
        <form
          className="stack"
          onSubmit={(event) => {
            event.preventDefault();
            onSubmit();
          }}
        >
          <label className="field-label" htmlFor="punch">
            Ответ строчными
            <span>{draft.length}/80</span>
          </label>
          <input
            ref={inputRef}
            id="punch"
            className="field"
            maxLength={80}
            placeholder="коротко и больнее"
            value={draft}
            enterKeyHint="send"
            autoCapitalize="none"
            autoCorrect="off"
            spellCheck={false}
            onChange={(event) => onDraft(event.target.value)}
          />
          {round === 3 && wagerMax > 0 ? (
            <>
              <label className="field-label" htmlFor="wager">
                Ставка в банк
                <span>{formatPoints(wager)}</span>
              </label>
              <input
                id="wager"
                className="slider"
                type="range"
                min={0}
                max={wagerMax}
                step={wagerMax >= 200 ? 50 : 10}
                value={Math.min(wager, wagerMax)}
                onChange={(event) => onWager(Number(event.target.value))}
              />
              <p className="sub">Победитель по голосам забирает весь банк. Ничья делит его.</p>
            </>
          ) : null}
          {round === 3 && wagerMax === 0 ? (
            <p className="sub">Ставить нечего. Если банк пуст, каждый голос в финале стоит 1000.</p>
          ) : null}
          <button type="submit" className="btn btn-lime">Отправить ответ</button>
        </form>
      )}
      <Roster players={players} />
      {waiting ? (
        <div className="stack">
          <button type="button" className="btn btn-ink" onClick={onHurry}>К голосованию</button>
        </div>
      ) : null}
    </div>
  );
}

function VotePhase({
  cards, phase, left, onVote, onHurry,
}: {
  cards: NonNullable<ReturnType<typeof present>["cards"]>;
  phase: "vote" | "reveal";
  left: number;
  onVote: (id: string) => void;
  onHurry: () => void;
}) {
  const note = phase === "reveal"
    ? (cards.sweep ? "Весь зал за одну сторону. Очки удваиваются." : "Авторы вскрыты.")
    : cards.youAreAuthor
      ? "Ты в этой паре — голосует зал."
      : cards.youVoted
        ? "Голос принят. Смотрим, куда клонится зал."
        : cards.mode === "final"
          ? "Один голос. Свой ответ не выбрать."
          : "Что смешнее?";
  return (
    <div>
      <p className="kicker">
        {cards.mode === "final" ? "Финал · банк" : `Пара ${cards.index} из ${cards.total}`}
        {phase === "vote" ? ` · ${left} с` : ""}
        {cards.sweep ? " · все согласны ×2" : ""}
      </p>
      <h1 className="prompt">{cards.prompt}</h1>
      <p className="lead">{note}</p>
      <div className={cards.mode === "final" ? "vote-grid final" : "vote-grid duel"} style={{ marginTop: "1rem" }}>
        {cards.items.map((item, index) => (
          <CardFace key={item.id} item={item} phase={phase} interactive={cards.canVote && !item.you} onVote={onVote} showVs={cards.mode === "duel" && index === 0} />
        ))}
      </div>
      <div className="stack">
        <button type="button" className="btn btn-ghost" onClick={onHurry}>
          {phase === "reveal" ? "Дальше" : "К итогам"}
        </button>
      </div>
    </div>
  );
}

function CardFace({
  item, phase, interactive, onVote, showVs,
}: {
  item: NonNullable<ReturnType<typeof present>["cards"]>["items"][number];
  phase: "vote" | "reveal";
  interactive: boolean;
  onVote: (id: string) => void;
  showVs: boolean;
}) {
  const body = (
    <>
      <div style={{ display: "flex", gap: "0.4rem", flexWrap: "wrap" }}>
        {item.you ? <span className="stamp">твой</span> : null}
        {item.safety ? <span className="stamp">сейф</span> : null}
        {phase === "reveal" && item.points !== null && item.points !== 0 ? (
          <span className="float-pts pop">{item.points > 0 ? `+${formatPoints(item.points)}` : formatPoints(item.points)}</span>
        ) : null}
      </div>
      <p className="punch">{item.text}</p>
      <div className="card-meta">
        <span>{phase === "reveal" ? (item.author ?? "игрок") : item.you ? "это ты" : "аноним"}</span>
        <span className="votes pop" key={item.votes}>{item.votes}</span>
      </div>
      {phase === "reveal" && item.wager > 0 ? <span className="stamp">ставка {formatPoints(item.wager)}</span> : null}
      {interactive ? <span className="stamp">это смешнее</span> : null}
    </>
  );
  const className = `vcard ${item.side}${item.you ? " mine" : ""}`;
  return (
    <>
      {interactive ? (
        <button type="button" className={className} onClick={() => onVote(item.id)}>
          {body}
        </button>
      ) : (
        <article className={className}>{body}</article>
      )}
      {showVs ? <div className="vs" aria-hidden="true">VS</div> : null}
    </>
  );
}

function Board({
  round, ranked, onNext,
}: {
  round: number;
  ranked: { id: string; name: string; score: number; you: boolean }[];
  onNext: () => void;
}) {
  const max = Math.max(1, ...ranked.map((player) => player.score));
  return (
    <div>
      <p className="kicker">После раунда {round}</p>
      <h1 className="display">Счёт</h1>
      <div className="board">
        {ranked.map((player, index) => (
          <div key={player.id} className={player.you ? "board-row you" : "board-row"}>
            <b>{index + 1}</b>
            <div>
              <div>{player.name}</div>
              <div className="bar" aria-hidden="true"><span style={{ transform: `scaleX(${player.score / max})` }} /></div>
            </div>
            <b>{formatPoints(player.score)}</b>
          </div>
        ))}
      </div>
      <div className="stack">
        <button type="button" className="btn btn-lime" onClick={onNext}>{round >= 3 ? "К финалу зала" : "Следующий раунд"}</button>
      </div>
    </div>
  );
}

function Podium({
  ranked, place, onReplay,
}: {
  ranked: { id: string; name: string; score: number; you: boolean }[];
  place: number;
  onReplay: () => void;
}) {
  const [first, ...rest] = ranked;
  return (
    <div style={{ position: "relative" }}>
      {place === 1 ? (
        <div className="confetti" aria-hidden="true">
          {Array.from({ length: 10 }, (_, index) => <i key={index} />)}
        </div>
      ) : null}
      <p className="kicker">{place === 1 ? "Зал выбрал тебя" : `Ты на ${place} месте`}</p>
      <h1 className="display">{place === 1 ? "Твой зал." : <>Шоу<br />закрыто.</>}</h1>
      <div className="podium">
        {first ? (
          <article className="place first">
            <div className="rank">01</div>
            <div className="who">{first.name}</div>
            <b>{formatPoints(first.score)}</b>
          </article>
        ) : null}
        {rest.slice(0, 4).map((player, index) => (
          <article key={player.id} className="place rest">
            <div className="rank">0{index + 2}{player.you ? " · это ты" : ""}</div>
            <div className="who">{player.name}</div>
            <b>{formatPoints(player.score)}</b>
          </article>
        ))}
      </div>
      <div className="stack">
        <button type="button" className="btn btn-lime" onClick={onReplay}>Ещё партию</button>
      </div>
    </div>
  );
}

function Roster({ players }: { players: { id: string; name: string; done: boolean; typing: boolean }[] }) {
  return (
    <ul className="roster">
      {players.map((player) => (
        <li key={player.id} className={player.done ? "done" : undefined}>
          {player.name}
          {player.done ? " · сдал" : player.typing ? " · пишет" : ""}
        </li>
      ))}
    </ul>
  );
}
