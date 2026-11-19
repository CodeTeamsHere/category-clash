import { useEffect, useRef, useState, type FormEvent } from "react";
import { ANSWER_MAX, type PlayerInfo, type RoomSnapshot } from "../shared/protocol";
import type { RarityView, TurnRecord } from "../shared/engine/rarity";
import type { RoomConnection } from "./useRoom";

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
  const players = new Map(room.players.map((p) => [p.id, p]));
  const me = conn.you ? players.get(conn.you) : undefined;

  return (
    <section className="card game">
      <div className="game-top">
        <span className="muted">
          Round {Math.min(game.round + 1, game.totalRounds)} / {game.totalRounds}
        </span>
        <span className="muted">Room {room.code}</span>
      </div>

      {game.phase === "game_over" ? (
        <FinalResults game={game} players={players} isHost={!!me?.isHost} onBack={() => conn.send({ type: "back_to_lobby" })} />
      ) : (
        <>
          <h2 className="prompt">{game.prompt}</h2>
          {game.phase === "turn" ? (
            <TurnPanel game={game} players={players} conn={conn} />
          ) : (
            <RoundRecap game={game} players={players} conn={conn} />
          )}
          <PlayedList turns={game.turns} players={players} />
          <Scoreboard game={game} players={players} />
        </>
      )}
    </section>
  );
}

function TurnPanel(props: { game: RarityView; players: Map<string, PlayerInfo>; conn: RoomConnection }) {
  const { game, players, conn } = props;
  const remaining = useCountdown(game.deadline, conn.clockOffset);
  const total = game.settings.turnSeconds * 1000;
  const current = game.currentPlayerId ? players.get(game.currentPlayerId) : undefined;
  const myTurn = game.currentPlayerId === conn.you;

  const [text, setText] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  const turnKey = `${game.round}:${game.turnIndex}`;

  // New turn: clear the box and focus it if it's ours.
  useEffect(() => {
    setText("");
    if (myTurn) inputRef.current?.focus();
  }, [turnKey, myTurn]);

  const rejection = conn.rejection && Date.now() - conn.rejection.at < 2500 ? conn.rejection : null;

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!text.trim()) return;
    conn.send({ type: "submit_answer", text });
  };

  return (
    <div className="turn">
      <div className="timer" aria-hidden>
        <div className="timer-fill" style={{ width: `${(remaining / total) * 100}%` }} />
      </div>
      <div className="turn-label">
        {myTurn ? (
          <strong>Your turn!</strong>
        ) : (
          <span>
            {current?.avatar} <strong>{current?.nickname ?? "..."}</strong> is thinking
          </span>
        )}
        <span className="seconds">{Math.ceil(remaining / 1000)}s</span>
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

function RoundRecap(props: { game: RarityView; players: Map<string, PlayerInfo>; conn: RoomConnection }) {
  const { game, players, conn } = props;
  const remaining = useCountdown(game.deadline, conn.clockOffset);
  const summary = game.roundSummaries[game.roundSummaries.length - 1];
  const bestPlayer = summary?.best ? players.get(summary.best.playerId) : undefined;
  const last = game.round + 1 >= game.totalRounds;

  return (
    <div className="recap">
      {summary?.best ? (
        <p className="rare-find">
          Best find: <strong>{summary.best.played.answer}</strong> by {bestPlayer?.avatar} {bestPlayer?.nickname}{" "}
          <span className={`tier tier-${summary.best.played.tier}`}>
            {summary.best.played.tierName} +{summary.best.played.points}
          </span>
        </p>
      ) : (
        <p className="muted">Nobody scored this round.</p>
      )}
      <p className="muted">
        {last ? "Final results" : "Next round"} in {Math.ceil(remaining / 1000)}s
      </p>
    </div>
  );
}

function PlayedList(props: { turns: TurnRecord[]; players: Map<string, PlayerInfo> }) {
  if (props.turns.length === 0) return null;
  return (
    <ul className="played">
      {props.turns.map((t, i) => {
        const p = props.players.get(t.playerId);
        return (
          <li key={i} className={t.played ? "" : "miss"}>
            <span>
              {p?.avatar} {p?.nickname}
            </span>
            {t.played ? (
              <span>
                <strong>{t.played.answer}</strong>{" "}
                <span className={`tier tier-${t.played.tier}`}>
                  {t.played.tierName} +{t.played.points}
                </span>
              </span>
            ) : (
              <span className="muted">{t.result === "timeout" ? "ran out of time" : "skipped"}</span>
            )}
          </li>
        );
      })}
    </ul>
  );
}

function ranked(game: RarityView, players: Map<string, PlayerInfo>) {
  return Object.entries(game.scores)
    .map(([id, score]) => ({ id, score, player: players.get(id) }))
    .sort((a, b) => b.score - a.score);
}

function Scoreboard(props: { game: RarityView; players: Map<string, PlayerInfo> }) {
  const { game, players } = props;
  return (
    <ol className="scores">
      {ranked(game, players).map(({ id, score, player }) => (
        <li key={id} className={[id === game.currentPlayerId ? "active" : "", player?.connected ? "" : "offline"].join(" ")}>
          <span>
            {player?.avatar} {player?.nickname ?? "?"}
          </span>
          <strong>{score}</strong>
        </li>
      ))}
    </ol>
  );
}

function FinalResults(props: { game: RarityView; players: Map<string, PlayerInfo>; isHost: boolean; onBack: () => void }) {
  const { game, players } = props;
  const rows = ranked(game, players);
  const top = rows[0]?.score ?? 0;
  return (
    <div className="final">
      <h2 className="prompt">Final scores</h2>
      <ol className="scores">
        {rows.map(({ id, score, player }) => (
          <li key={id} className={score === top && top > 0 ? "winner" : ""}>
            <span>
              {score === top && top > 0 ? "👑 " : ""}
              {player?.avatar} {player?.nickname ?? "?"}
            </span>
            <strong>{score}</strong>
          </li>
        ))}
      </ol>
      <h3>Best finds</h3>
      <ul className="played">
        {game.roundSummaries.map((s, i) => {
          const p = s.best ? players.get(s.best.playerId) : undefined;
          return (
            <li key={i}>
              <span className="muted">{s.prompt}</span>
              {s.best ? (
                <span>
                  <strong>{s.best.played.answer}</strong> {p?.avatar}{" "}
                  <span className={`tier tier-${s.best.played.tier}`}>{s.best.played.tierName}</span>
                </span>
              ) : (
                <span className="muted">-</span>
              )}
            </li>
          );
        })}
      </ul>
      {props.isHost ? (
        <button type="button" className="primary" onClick={props.onBack}>
          Back to lobby
        </button>
      ) : (
        <p className="muted">Waiting for the host to start a new game...</p>
      )}
    </div>
  );
}
