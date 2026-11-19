import { isValidRoomCode, normalizeRoomCode } from "../shared/protocol";

export { Room } from "./room";
export { PublicLobby } from "./public-lobby";

export default {
  async fetch(request, env): Promise<Response> {
    const url = new URL(request.url);

    // WebSocket: /ws/ABCD -> the Room Durable Object named ABCD
    if (url.pathname.startsWith("/ws/")) {
      if (request.headers.get("Upgrade") !== "websocket") {
        return new Response("Expected Upgrade: websocket", { status: 426 });
      }
      const code = normalizeRoomCode(url.pathname.slice("/ws/".length));
      if (!isValidRoomCode(code)) return new Response("Bad room code", { status: 400 });
      return env.ROOMS.getByName(code).fetch(request);
    }

    if (url.pathname === "/api/health") {
      return Response.json({ ok: true });
    }

    if (url.pathname === "/api/public-rooms") {
      return env.PUBLIC_LOBBY.getByName("global").fetch(request);
    }

    return new Response("Not found", { status: 404 });
  },
} satisfies ExportedHandler<Env>;
