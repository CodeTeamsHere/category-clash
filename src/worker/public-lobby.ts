import { DurableObject } from "cloudflare:workers";

// Index of open public rooms. Filled in during the public matchmaking phase;
// for now it only returns an empty list so the route works end to end.
export class PublicLobby extends DurableObject<Env> {
  async fetch(_request: Request): Promise<Response> {
    return Response.json({ rooms: [] });
  }
}
