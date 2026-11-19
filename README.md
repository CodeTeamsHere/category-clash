# Category Clash

A browser party game for friends. Join a public lobby or a private room with a 4-letter code, pick a nickname and avatar, then take turns naming things that fit a category.

- **Rarity mode**: valid answers score by how obscure they are. Common answers earn a little; deep cuts earn a lot.
- **Elimination mode**: say a valid, unused answer before the timer runs out or lose a life. The timer shrinks every lap.

No accounts. Runs on Cloudflare Workers with one Durable Object per room.

## Stack

- React + Vite + TypeScript (`src/client`)
- Cloudflare Worker (`src/worker/index.ts`) serving the static frontend and routing `/ws/:code` to the `Room` Durable Object
- `Room` Durable Object (`src/worker/room.ts`) using the Hibernation WebSocket API
- `PublicLobby` Durable Object (`src/worker/public-lobby.ts`) indexing open public rooms
- Shared protocol and game logic (`src/shared`), unit tested with Vitest

## Development

```sh
npm install
npm run dev        # Vite + Worker + Durable Objects locally on http://localhost:5173
npm test           # unit tests
npm run typecheck  # TypeScript project references
```

Open the dev URL in two browser tabs (or a normal and a private window) to test multiplayer.

After changing `wrangler.jsonc`, regenerate Worker types:

```sh
npm run cf-typegen
```

## Deploy

Pushes to `main` deploy through Cloudflare Workers Builds once the repo is connected in the Cloudflare dashboard (Workers & Pages > Create > Import a repository). Build command: `npm run build`. Deploy command: `npx wrangler deploy`.

Manual deploy:

```sh
npx wrangler login
npm run deploy
```

## Roadmap

1. Lobby: nickname, avatar, create/join by code, host controls, reconnect (done)
2. Rarity mode engine and UI (done)
3. Elimination mode (done)
4. Public rooms and Quick Play
5. Category content (40 curated lists with rarity tiers) and a content checker
6. Polish: mobile, sounds, animations, rate limits
