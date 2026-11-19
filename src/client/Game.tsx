import { useEffect, useRef, useState, type FormEvent } from "react";
import type { EliminationView } from "../shared/engine/elimination";
import type { PlayedAnswer, RarityView, TurnRecord } from "../shared/engine/rarity";
import { ANSWER_MAX, type PlayerInfo, type RoomSnapshot } from "../shared/protocol";
import type { RoomConnection } from "./useRoom";

type Players = Map<string, PlayerInfo>;

function useCountdown(deadline: number, clockOffset: number): number {
  const [now, setNow] = useState(() => Date.now() + clockOffset);
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now() + clockOffset), 100);
    return () => clearInterval(id);
  }, [clockOffset]);
  return Math.max(0, deadline - now);
}

const REJECT_TEXT: Record<string, string> = {
  not_in_list: "Not on our list. Try another!",
  taken: "Already said",
  time_up: "Time's up",
  not_your_turn: "Not your turn",
  empty: "Type an answer first",
};

export function Game(props: { room: RoomSnapshot; conn: RoomConnection }) {
  const { room, conn } = props;
  const game = room.game!;
  const players: Players = new Map(room.players.map((p) => [p.id, p]));
  const me = conn.you ? players.get(conn.you) : undefined;
  const hostAway = !room.players.some((p) => p.isHost && p.connected);
  const canReturn = !!me?.isHost || hostAway;
  const onBack = () => conn.send({ type: "back_to_lobby" });

  return (
    <section className="card game">
      <div className="game-top">
        <span className="muted">
          {game.mode === "rarity"
            ? `Round ${Math.min(game.round + 1, game.totalRounds)} / ${game.totalRounds}`
            : `Round ${game.round + 1} · first to ${game.settings.roundsToWin}`}
        </span>
        <span className="muted">Room {room.code}</span>
      </div>
      {game.mode === "rarity" ? (
        <RarityGame game={game} players={players} conn={conn} canReturn={canReturn} onBack={onBack} />
      ) : (
        <EliminationGame game={game} players={players} conn={conn} canReturn={canReturn} onBack={onBack} />
      )}
    </section>
  );
}

interface ModeProps<G> {
  game: G;
  players: Players;
  conn: RoomConnection;
  canReturn: boolean;
  onBack: () => void;
}

// ---------- shared pieces ----------

function TurnPanel(props: { currentPlayerId: string | null; deadline: number; totalMs: number; turnKey: string; players: Players; conn: RoomConnection }) {
  const { players, conn } = props;
  const remaining = useCountdown(props.deadline, conn.clockOffset);
  const current = props.currentPlayerId ? players.get(props.currentPlayerId) : undefined;
  const myTurn = props.currentPlayerId === conn.you;
  const urgent = remaining < 3000;

  const [text, setText] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  // New turn: clear the box and focus it if it's ours.
  useEffect(() => {
    setText("");
    if (myTurn) inputRef.current?.focus();
  }, [props.turnKey, myTurn]);

  const rejection = conn.rejection && Date.now() - conn.rejection.at < 2500 ? conn.rejection : null;

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!text.trim()) return;
    conn.send({ type: "submit_answer", text });
  };

  return (
    <div className="turn">
      <div className="timer" aria-hidden>
        <div className={urgent ? "timer-fill urgent" : "timer-fill"} style={{ width: `${(remaining / Math.max(1, props.totalMs)) * 100}%` }} />
      </div>
      <div className="turn-label">
        {myTurn ? (
          <strong>Your turn!</strong>
        ) : (
          <span>
            {current?.avatar} <strong>{current?.nickname ?? "..."}</strong> is thinking
          </span>
        )}
        <span className={urgent ? "seconds urgent" : "seconds"}>{Math.ceil(remaining / 1000)}s</span>
      </div>
      {myTurn && (
        <form className="row" onSubmit={submit}>
          <input
            ref={inputRef}
            value={text}
            maxLength={ANSWER_MAX}
            onChange={(e) => setText(e.target.value)}
            placeholder="Type an answer"
            autoComplete="off"
            autoCapitalize="off"
            spellCheck={false}
            aria-label="Your answer"
          />
          <button type="submit" className="primary">
            Send
          </button>
        </form>
      )}
      {myTurn && rejection && (
        <p className="error" role="status">
          {REJECT_TEXT[rejection.reason] ?? "Try again"}
          {rejection.taken ? `: ${rejection.taken}` : ""}
        </p>
      )}
    </div>
  );
}

function Who(props: { id: string; players: Players }) {
  const p = props.players.get(props.id);
  return (
    <span>
      {p?.avatar} {p?.nickname ?? "?"}
    </span>
  );
}

function TierBadge(props: { played: PlayedAnswer; showPoints: boolean }) {
  const { played } = props;
  return (
    <span className={`tier tier-${played.tier}`}>
      {played.tierName}
      {props.showPoints ? ` +${played.points}` : ""}
    </span>
  );
}

function ReturnButton(props: { canReturn: boolean; onBack: () => void }) {
  return props.canReturn ? (
    <button type="button" className="primary" onClick={props.onBack}>
      Back to lobby
    </button>
  ) : (
    <p className="muted">Waiting for the host to start a new game...</p>
  );
}

function Intermission(props: { deadline: number; conn: RoomConnection; label: string }) {
  const remaining = useCountdown(props.deadline, props.conn.clockOffset);
  return (
    <p className="muted center">
      {props.label} in {Math.ceil(remaining / 1000)}s
    </p>
  );
}

// ---------- Rarity ----------

function RarityGame({ game, players, conn, canReturn, onBack }: ModeProps<RarityView>) {
  if (game.phase === "game_over") return <RarityResults game={game} players={players} canReturn={canReturn} onBack={onBack} />;
  const summary = game.roundSummaries[game.roundSummaries.length - 1];
  const last = game.round + 1 >= game.totalRounds;
  return (
    <>
      <h2 className="prompt">{game.prompt}</h2>
      {game.phase === "turn" ? (
        <TurnPanel
          currentPlayerId={game.currentPlayerId}
          deadline={game.deadline}
          totalMs={game.settings.turnSeconds * 1000}
          turnKey={`${game.round}:${game.turnIndex}`}
          players={players}
          conn={conn}
        />
      ) : (
        <div className="recap">
          {summary?.best ? (
            <p className="rare-find">
              Best find: <strong>{summary.best.played.answer}</strong> by <Who id={summary.best.playerId} players={players} />{" "}
              <TierBadge played={summary.best.played} showPoints />
            </p>
          ) : (
            <p className="muted">Nobody scored this round.</p>
          )}
          <Intermission deadline={game.deadline} conn={conn} label={last ? "Final results" : "Next round"} />
        </div>
      )}
      <PlayedList turns={game.turns} players={players} showPoints />
      <ol className="scores">
        {rankBy(game.scores).map(([id, score]) => (
          <li key={id} className={rowClass(id === game.currentPlayerId, players.get(id))}>
            <Who id={id} players={players} />
            <strong>{score}</strong>
          </li>
        ))}
      </ol>
    </>
  );
}

function PlayedList(props: { turns: TurnRecord[]; players: Players; showPoints: boolean }) {
  if (props.turns.length === 0) return null;
  return (
    <ul className="played">
      {props.turns.map((t, i) => (
        <li key={i} className={t.played ? "" : "miss"}>
          <Who id={t.playerId} players={props.players} />
          {t.played ? (
            <span>
              <strong>{t.played.answer}</strong> <TierBadge played={t.played} showPoints={props.showPoints} />
            </span>
          ) : (
            <span className="muted">{t.result === "timeout" ? "ran out of time" : "skipped"}</span>
          )}
        </li>
      ))}
    </ul>
  );
}

function RarityResults(props: { game: RarityView; players: Players; canReturn: boolean; onBack: () => void }) {
  const { game, players } = props;
  const rows = rankBy(game.scores);
  const top = rows[0]?.[1] ?? 0;
  return (
    <div className="final">
      <h2 className="prompt">Final scores</h2>
      <ol className="scores">
        {rows.map(([id, score]) => (
          <li key={id} className={score === top && top > 0 ? "winner" : ""}>
            <span>
              {score === top && top > 0 ? "👑 " : ""}
              <Who id={id} players={players} />
            </span>
            <strong>{score}</strong>
          </li>
        ))}
      </ol>
      <h3>Best finds</h3>
      <ul className="played">
        {game.roundSummaries.map((s, i) => (
          <li key={i}>
            <span className="muted">{s.prompt}</span>
            {s.best ? (
              <span>
                <strong>{s.best.played.answer}</strong> {players.get(s.best.playerId)?.avatar} <TierBadge played={s.best.played} showPoints={false} />
              </span>
            ) : (
              <span className="muted">-</span>
            )}
          </li>
        ))}
      </ul>
      <ReturnButton canReturn={props.canReturn} onBack={props.onBack} />
    </div>
  );
}

// ---------- Elimination ----------

function Hearts(props: { lives: number; max: number }) {
  return (
    <span className="hearts" aria-label={`${props.lives} lives`}>
      {"❤️".repeat(props.lives)}
      <span className="lost">{"🖤".repeat(Math.max(0, props.max - props.lives))}</span>
    </span>
  );
}

function EliminationGame({ game, players, conn, canReturn, onBack }: ModeProps<EliminationView>) {
  if (game.phase === "game_over") return <EliminationResults game={game} players={players} canReturn={canReturn} onBack={onBack} />;
  const answered = game.turns.filter((t) => t.result === "answered").length;
  const seconds = Math.round(game.turnMs / 1000);
  return (
    <>
      <h2 className="prompt">{game.prompt}</h2>
      {game.phase === "turn" ? (
        <>
          <TurnPanel
            currentPlayerId={game.currentPlayerId}
            deadline={game.deadline}
            totalMs={game.turnMs}
            turnKey={`${game.round}:${game.turns.length}`}
            players={players}
            conn={conn}
          />
          <p className="muted small center">
            {answered} answers so far · {seconds}s per turn{seconds > 5 ? ", shrinking every lap" : " (minimum)"}
          </p>
        </>
      ) : (
        <div className="recap">
          {game.roundWinner ? (
            <p className="rare-find">
              <Who id={game.roundWinner} players={players} /> {game.matchWinner ? "wins the match!" : "survives the round!"}
            </p>
          ) : (
            <p className="muted">No survivor this round.</p>
          )}
          <Intermission deadline={game.deadline} conn={conn} label={game.matchWinner ? "Final results" : "Next round"} />
        </div>
      )}

      <ul className="scores">
        {game.seats.map((id) => {
          const lives = game.lives[id] ?? 0;
          return (
            <li key={id} className={[rowClass(id === game.currentPlayerId, players.get(id)), lives === 0 ? "out" : ""].join(" ")}>
              <Who id={id} players={players} />
              <span className="elim-stats">
                <Hearts lives={lives} max={game.settings.lives} />
                <span className="wins" title="Round wins">
                  🏆 {game.wins[id] ?? 0}
                </span>
              </span>
            </li>
          );
        })}
      </ul>

      {game.turns.length > 0 && (
        <ul className="played">
          {[...game.turns].reverse().map((t, i) => (
            <li key={game.turns.length - i} className={t.played ? "" : "miss"}>
              <Who id={t.playerId} players={players} />
              {t.played ? (
                <span>
                  <strong>{t.played.answer}</strong> <TierBadge played={t.played} showPoints={false} />
                </span>
              ) : (
                <span className="boom">
                  💥 {t.result === "timeout" ? "too slow" : "away"}
                  {t.livesLeft === 0 ? ", out!" : ""}
                </span>
              )}
            </li>
          ))}
        </ul>
      )}
    </>
  );
}

function EliminationResults(props: { game: EliminationView; players: Players; canReturn: boolean; onBack: () => void }) {
  const { game, players } = props;
  return (
    <div className="final">
      <h2 className="prompt">{game.matchWinner ? <>👑 <Who id={game.matchWinner} players={players} /> wins!</> : "Match over"}</h2>
      <ol className="scores">
        {rankBy(game.wins).map(([id, wins]) => (
          <li key={id} className={id === game.matchWinner ? "winner" : ""}>
            <Who id={id} players={players} />
            <strong>
              {wins} round{wins === 1 ? "" : "s"}
            </strong>
          </li>
        ))}
      </ol>
      <h3>Rounds</h3>
      <ul className="played">
        {game.roundSummaries.map((s, i) => (
          <li key={i}>
            <span className="muted">{s.prompt}</span>
            <span>
              {s.winnerId ? <Who id={s.winnerId} players={players} /> : "-"} <span className="muted">· {s.answers} answers</span>
            </span>
          </li>
        ))}
      </ul>
      <ReturnButton canReturn={props.canReturn} onBack={props.onBack} />
    </div>
  );
}

// ---------- helpers ----------

function rankBy(values: Record<string, number>): [string, number][] {
  return Object.entries(values).sort((a, b) => b[1] - a[1]);
}

function rowClass(active: boolean, player: PlayerInfo | undefined): string {
  return [active ? "active" : "", player?.connected ? "" : "offline"].join(" ");
}
