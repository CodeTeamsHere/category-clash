import { useEffect, useRef, useState } from "react";
import type { ClientMessage, RoomSnapshot, ServerMessage } from "../shared/protocol";
import type { Identity } from "./identity";

export type ConnectionStatus = "connecting" | "open" | "closed";

export interface RoomConnection {
  status: ConnectionStatus;
  room: RoomSnapshot | null;
  you: string | null;
  error: string | null;
  send: (msg: ClientMessage) => void;
}

// Opens a WebSocket to /ws/CODE, joins, and reconnects with backoff if the socket drops.
export function useRoom(code: string, identity: Identity, isPublic: boolean): RoomConnection {
  const [status, setStatus] = useState<ConnectionStatus>("connecting");
  const [room, setRoom] = useState<RoomSnapshot | null>(null);
  const [you, setYou] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const wsRef = useRef<WebSocket | null>(null);

  useEffect(() => {
    let stopped = false;
    let attempt = 0;
    let retryTimer: ReturnType<typeof setTimeout> | undefined;

    const connect = () => {
      const proto = location.protocol === "https:" ? "wss:" : "ws:";
      const ws = new WebSocket(`${proto}//${location.host}/ws/${code}`);
      wsRef.current = ws;
      setStatus("connecting");

      ws.onopen = () => {
        attempt = 0;
        setStatus("open");
        const join: ClientMessage = {
          type: "join",
          playerId: identity.playerId,
          nickname: identity.nickname,
          avatar: identity.avatar,
          isPublic,
        };
        ws.send(JSON.stringify(join));
      };

      ws.onmessage = (event) => {
        let msg: ServerMessage;
        try {
          msg = JSON.parse(event.data as string);
        } catch {
          return;
        }
        if (msg.type === "room") {
          setRoom(msg.room);
          setYou(msg.you);
          setError(null);
        } else if (msg.type === "error") {
          setError(msg.message);
        }
      };

      ws.onclose = (event) => {
        if (wsRef.current === ws) wsRef.current = null;
        setStatus("closed");
        // 4000 = another tab took over this seat; don't fight it.
        if (stopped || event.code === 4000) return;
        const delay = Math.min(10_000, 500 * 2 ** attempt++);
        retryTimer = setTimeout(connect, delay);
      };
    };

    connect();
    return () => {
      stopped = true;
      clearTimeout(retryTimer);
      wsRef.current?.close(1000, "Leaving");
    };
  }, [code, identity.playerId, identity.nickname, identity.avatar, isPublic]);

  const send = (msg: ClientMessage) => {
    const ws = wsRef.current;
    if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
  };

  return { status, room, you, error, send };
}
