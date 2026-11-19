import { useState } from "react";
import {
  AVATARS,
  generateRoomCode,
  isValidRoomCode,
  normalizeRoomCode,
  validateNickname,
  type GameMode,
} from "../shared/protocol";
import type { RaritySettings } from "../shared/engine/rarity";
import { Game } from "./Game";
import { loadIdentity, saveIdentity, type Identity } from "./identity";
import { useRoom, type RoomConnection } from "./useRoom";

interface Session {
  code: string;
  isPublic: boolean;
}

function codeFromUrl(): string {
  const code = normalizeRoomCode(new URLSearchParams(location.search).get("room") ?? "");
  return isValidRoomCode(code) ? code : "";
}

export function App() {
  const [identity, setIdentity] = useState<Identity>(loadIdentity);
  // Reloading /?room=CODE with a saved nickname rejoins straight away (keeps your seat mid-game).
  const [session, setSession] = useState<Session | null>(() => {
    const code = codeFromUrl();
    return code && validateNickname(identity.nickname) ? { code, isPublic: false } : null;
  });

  const enter = (next: Identity, code: string, isPublic: boolean) => {
    saveIdentity(next);
    setIdentity(next);
    history.replaceState(null, "", `/?room=${code}`);
    setSession({ code, isPublic });
  };

  const leave = () => {
    history.replaceState(null, "", "/");
    setSession(null);
  };

  return (
    <main className="app">
      <h1 className="logo">Category Clash</h1>
      {session ? (
        <RoomScreen code={session.code} isPublic={session.isPublic} identity={identity} onLeave={leave} />
      ) : (
        <Home identity={identity} initialCode={codeFromUrl()} onEnter={enter} />
      )}
    </main>
  );
}

function Home(props: { identity: Identity; initialCode: string; onEnter: (id: Identity, code: string, isPublic: boolean) => void }) {
  const [nickname, setNickname] = useState(props.identity.nickname);
  const [avatar, setAvatar] = useState(props.identity.avatar);
  const [joinCode, setJoinCode] = useState(props.initialCode);
  const [error, setError] = useState<string | null>(null);

  const withName = (fn: (id: Identity) => void) => {
    const valid = validateNickname(nickname);
    if (!valid) return setError("Pick a nickname (2-16 characters).");
    setError(null);
    fn({ ...props.identity, nickname: valid, avatar });
  };

  const create = (isPublic: boolean) => withName((id) => props.onEnter(id, generateRoomCode(), isPublic));

  const join = () =>
    withName((id) => {
      const code = normalizeRoomCode(joinCode);
      if (!isValidRoomCode(code)) return setError("Room codes are 4 letters.");
      props.onEnter(id, code, false);
    });

  return (
    <section className="card">
      <label className="field">
        <span>Nickname</span>
        <input value={nickname} maxLength={16} onChange={(e) => setNickname(e.target.value)} placeholder="Your name" />
      </label>

      <div className="avatars" role="radiogroup" aria-label="Avatar">
        {AVATARS.map((a) => (
          <button
            key={a}
            type="button"
            role="radio"
            aria-checked={a === avatar}
            className={a === avatar ? "avatar selected" : "avatar"}
            onClick={() => setAvatar(a)}
          >
            {a}
          </button>
        ))}
      </div>

      <div className="row">
        <button type="button" className="primary" onClick={() => create(false)}>
          Create private room
        </button>
        <button type="button" onClick={() => create(true)}>
          Create public room
        </button>
      </div>

      <div className="row">
        <input
          className="code-input"
          value={joinCode}
          maxLength={4}
          onChange={(e) => setJoinCode(e.target.value.toUpperCase())}
          placeholder="CODE"
          aria-label="Room code"
        />
        <button type="button" onClick={join}>
          Join
        </button>
      </div>

      {error && <p className="error">{error}</p>}
    </section>
  );
}

function RoomScreen(props: { code: string; isPublic: boolean; identity: Identity; onLeave: () => void }) {
  const conn = useRoom(props.code, props.identity, props.isPublic);
  if (conn.room?.status === "playing" && conn.room.game) {
    return (
      <>
        {conn.status !== "open" && <p className="muted center">Reconnecting...</p>}
        <Game room={conn.room} conn={conn} />
        <button type="button" className="leave" onClick={props.onLeave}>
          Leave room
        </button>
      </>
    );
  }
  return <Lobby code={props.code} conn={conn} onLeave={props.onLeave} />;
}

const ROUND_OPTIONS = [3, 5, 7];
const TURN_OPTIONS = [1, 2, 3];
const SECOND_OPTIONS = [10, 15, 20, 30];

function Lobby(props: { code: string; conn: RoomConnection; onLeave: () => void }) {
  const { status, room, you, error, send } = props.conn;
  const me = room?.players.find((p) => p.id === you);
  const isHost = !!me?.isHost;
  const shareUrl = `${location.origin}/?room=${props.code}`;

  const setMode = (mode: GameMode) => send({ type: "set_mode", mode });
  const setSetting = (settings: Partial<RaritySettings>) => send({ type: "set_settings", settings });

  return (
    <section className="card">
      <div className="room-header">
        <div>
          <div className="muted">Room code</div>
          <div className="room-code">{props.code}</div>
        </div>
        <button type="button" onClick={() => navigator.clipboard?.writeText(shareUrl)}>
          Copy invite link
        </button>
      </div>

      {status !== "open" && <p className="muted">{status === "connecting" ? "Connecting..." : "Reconnecting..."}</p>}
      {error && <p className="error">{error}</p>}

      {room && (
        <>
          <div className="row">
            <span className="muted">Mode:</span>
            {(["rarity", "elimination"] as const).map((m) => (
              <button
                key={m}
                type="button"
                className={room.mode === m ? "chip selected" : "chip"}
                disabled={!isHost}
                onClick={() => setMode(m)}
              >
                {m === "rarity" ? "Rarity" : "Elimination"}
              </button>
            ))}
            <span className="muted">{room.isPublic ? "Public" : "Private"}</span>
          </div>

          {room.mode === "rarity" ? (
            <div className="settings">
              <SettingRow label="Rounds" options={ROUND_OPTIONS} value={room.settings.rounds} disabled={!isHost} onPick={(rounds) => setSetting({ rounds })} />
              <SettingRow
                label="Turns each"
                options={TURN_OPTIONS}
                value={room.settings.turnsPerPlayer}
                disabled={!isHost}
                onPick={(turnsPerPlayer) => setSetting({ turnsPerPlayer })}
              />
              <SettingRow
                label="Seconds"
                options={SECOND_OPTIONS}
                value={room.settings.turnSeconds}
                disabled={!isHost}
                onPick={(turnSeconds) => setSetting({ turnSeconds })}
              />
              <p className="muted small">
                Take turns naming things in the category. Rarer answers score more: Common 10, Solid 20, Sharp 40, Rare 70,
                Legendary 100. No repeats!
              </p>
            </div>
          ) : (
            <p className="muted">Elimination mode is coming soon.</p>
          )}

          <ul className="players">
            {room.players.map((p) => (
              <li key={p.id} className={p.connected ? "" : "offline"}>
                <span className="avatar-sm">{p.avatar}</span>
                {p.nickname}
                {p.isHost && <span className="badge">host</span>}
                {p.id === you && <span className="badge">you</span>}
              </li>
            ))}
          </ul>
          {isHost ? (
            <button type="button" className="primary big" disabled={room.mode !== "rarity" || status !== "open"} onClick={() => send({ type: "start_game" })}>
              Start game
            </button>
          ) : (
            <p className="muted">Waiting for the host to start...</p>
          )}
        </>
      )}

      <button type="button" onClick={props.onLeave}>
        Leave room
      </button>
    </section>
  );
}

function SettingRow(props: { label: string; options: number[]; value: number; disabled: boolean; onPick: (v: number) => void }) {
  return (
    <div className="row">
      <span className="muted setting-label">{props.label}</span>
      {props.options.map((o) => (
        <button
          key={o}
          type="button"
          className={o === props.value ? "chip selected" : "chip"}
          disabled={props.disabled}
          onClick={() => props.onPick(o)}
        >
          {o}
        </button>
      ))}
    </div>
  );
}
