# TrackMyLocationBackend-

Node.js / Express + Socket.IO backend for **Trip Tracker** — a live group-travel
tracker. Handles authentication, groups, realtime location sharing, group chat,
direct messages, trip expenses, trip stories, and remote **Vibrate** / **Ring**
alerts. Data is stored in PostgreSQL (Neon).

## Tech stack
Express 5 · Socket.IO 4 · PostgreSQL (`pg`) · Better Auth · Swagger UI

## Getting started
```bash
npm install
cp .env.example .env      # then fill in DATABASE_URL and BETTER_AUTH_SECRET
npm run migrate           # create tables (safe to re-run)
npm run seed              # optional demo users/groups (password: password123)
npm run dev               # http://localhost:5000
```

Swagger docs: http://localhost:5000/api-docs

## Scripts
| Command | Description |
| --- | --- |
| `npm run dev` | Start with nodemon |
| `npm start` | Start with node |
| `npm run migrate` | Apply `schema.sql` (`IF NOT EXISTS`, idempotent) |
| `npm run seed` | Seed demo data |

## Environment variables
See `.env.example`. `.env` holds real secrets and is gitignored.

| Variable | Purpose |
| --- | --- |
| `PORT` | HTTP + Socket.IO port (default `5000`) |
| `DATABASE_URL` | Neon PostgreSQL connection string |
| `BETTER_AUTH_SECRET` | Signing secret for sessions |
| `BETTER_AUTH_URL` | Public URL of this backend |
| `CLIENT_URL` | Frontend URL, used to build invite links / QR targets |
| `CORS_ORIGINS` | Optional extra allowed origins (comma separated) |
| `LIVEKIT_URL` | LiveKit server URL (WSS) for group voice rooms |
| `LIVEKIT_API_KEY` | LiveKit API key |
| `LIVEKIT_API_SECRET` | LiveKit API secret — **server-only, never exposed to the browser** |

## Voice rooms (LiveKit)
Discord-style group voice. `LIVEKIT_*` above must be set or voice is disabled
(the API returns `configured: false` and the UI says so).

- **REST**: `GET /api/voice/config` (URL only — never the secret),
  `GET /api/voice/rooms`, `POST /api/voice/rooms`, `GET /api/voice/rooms/:id`,
  `GET /api/voice/invitations`
- **Socket events**: `voice:room:create|join|leave|update|delete|list`,
  `voice:participant:mute`, `voice:invite:send|accept|decline|list`
- **Server → client**: `voice:room:participants`, `voice:room:updated`,
  `voice:room:deleted`, `voice:participant:joined|left|mute`,
  `voice:invite:received|accepted|declined`
- Audio never travels through Socket.IO — the server only issues short-lived,
  room-scoped LiveKit tokens; audio is WebRTC to LiveKit.
- Presence is in-memory (`src/voice/presence.js`) and keyed by user id, never by
  socket id, so multiple tabs for one user are handled correctly.
- `npm test` runs the voice unit + integration suite (`node:test`).
| `CORS_ORIGINS` | Optional extra allowed origins (comma separated) |

## REST API
| Method | Path | Description |
| --- | --- | --- |
| POST | `/api/auth/signup` · `/api/auth/login` · `/api/auth/logout` | Auth (cookie session) |
| GET | `/api/auth/me` | Current user |
| GET/POST | `/api/groups`, `/api/groups/create`, `/api/groups/join` | Groups |
| POST | `/api/groups/invite/:token/join` | Auto-join via invite link / scanned QR |
| GET | `/api/groups/:groupId/invite` | Invite code + link (for QR) |
| PATCH | `/api/groups/:groupId/members/:userId` | Promote / demote (`{ role }`, admin) |
| DELETE | `/api/groups/:groupId/members/:userId` | Kick a member (admin) |
| GET | `/api/groups/:groupId` · `/api/groups/:groupId/members` | Group + members |
| GET | `/api/chats/:groupId` | Group chat history (text + media) |
| GET/POST | `/api/expenses` · `/api/expenses/summary/:groupId` · `/api/expenses/:groupId/balance` | Expenses |
| GET | `/api/stories/feed` | All stories visible to me (all privacy tiers) |
| GET/POST/DELETE | `/api/stories` · `/api/stories/group/:groupId` · `/api/stories/:id` | Trip stories |
| POST | `/api/stories/:id/view` | Mark viewed (enforces view-once → 410) |
| GET/POST | `/api/dm` · `/api/dm/:otherUserId` | Direct messages (text + media) |
| GET/PUT | `/api/safezone/:groupId` | Geofenced safe zone (GET for members, PUT for admins) |

## Socket.IO events
Authenticated via the Better Auth session cookie (`src/middleware/socketAuth.js`).

**Chat / presence:** `join-group`, `leave-group`, `update-location`, `send-message`
(text + `attachment`), `send-dm` (text + `attachment`), `vibrate-user`, `ring-user`,
`stop-ring`, `post-story`, `sos-alert`, `sos-clear`

**Safety / admin:** `set-safe-zone`, `disable-safe-zone`, `admin-broadcast`

**WebRTC voice calls (1-to-1):** `call-user` (invite + SDP offer),
`accept-call` (SDP answer), `reject-call`, `ice-candidate`, `hang-up`
(legacy `call:*` names are still accepted as aliases)

**Server → Client:** `user-moved`, `receive-message`, `receive-dm`, `vibrate`, `ring`,
`ring-stopped`, `story-updated`, `story-deleted`, `group-updated`,
`removed-from-group`, `sos`, `sos-sent`, `sos-cleared`, `safe-zone-updated`,
`boundary-breach-alert`, `boundary-restored`, `admin-broadcast-message`,
`expense-updated`, `member-profile-updated`, `incoming-call`, `call-accepted`,
`call-rejected`, `ice-candidate`, `call-ended`

## Project layout
```
index.js            entry point (keeps `node index.js` working)
Dockerfile          container image for Render / Railway / Fly
render.yaml         Render Blueprint
railway.json        Railway config
src/
  config/     db.js, origins.js
  middleware/ authMiddleware.js, socketAuth.js
  routes/     auth, group, chat, expense, story, dm, safeZone, profile, voice
  sockets/    index, locationSocket, chatSocket, interactionSocket, storySocket,
              callSocket, sosSocket, adminSocket, voiceSocket
  voice/      livekit.js, presence.js, voice-room.service.js, invitation.service.js
  attachments.js  stories.js   (shared helpers)
  auth.js     server.js   swagger.js
test/               node:test suites (presence + services)
schema.sql   seed.js   scripts/migrate.js
```

## Deployment

This backend is a **long-running Express + Socket.IO server** and keeps voice
presence in memory, so it must run on a host that supports persistent WebSocket
connections and a single stable process. **Vercel / Netlify functions are not
suitable** — the API boots, but Socket.IO features (chat, live locations, voice
signalling, presence) will not work there.

Recommended: **Render** or **Railway** (a `Dockerfile`, `render.yaml` and
`railway.json` are included).

### 1. Deploy the API (Render)

1. Push this repo to GitHub (already done).
2. **Option A — Blueprint (uses the Dockerfile):** Render Dashboard →
   **New → Blueprint** → pick this repo. Render reads `render.yaml`.
   **Option B — plain Web Service (Node runtime):** New → **Web Service**, pick
   the repo, and leave the start command as the default. `index.js` exists
   specifically so the default `node index.js` boots the server, and
   `npm start` (`node src/server.js`) is set as the explicit alternative.
   If you prefer to be explicit, set **Start Command** to `node src/server.js`.
3. Fill in the env vars below.
4. Set `BETTER_AUTH_URL` to the service's own URL and `CLIENT_URL` to the
   deployed frontend origin, then redeploy so cookies/CORS match.

> Build command: `npm install` (default). The `npm audit` summary during build is
> informational — **do not** run `npm audit fix --force`, as it applies breaking
> major-version upgrades to Express/Better Auth and will break the app.

Railway: **New Project → Deploy from GitHub**; it detects `Dockerfile` or the
`start` script. Inject the same variables below and generate a public domain.

### 2. Environment variables (set these on the host)

| Variable | Example |
| --- | --- |
| `NODE_ENV` | `production` |
| `DATABASE_URL` | `postgresql://…neon.tech/neondb?sslmode=require` |
| `BETTER_AUTH_SECRET` | `openssl rand -hex 32` |
| `BETTER_AUTH_URL` | `https://trackmylocation-api.onrender.com` |
| `CLIENT_URL` | `https://your-app.vercel.app` |
| `CORS_ORIGINS` | optional extra origins, comma separated |
| `LIVEKIT_URL` | `wss://trip-tracker-mgj9em5q.livekit.cloud` |
| `LIVEKIT_API_KEY` | *(secret)* |
| `LIVEKIT_API_SECRET` | *(secret)* |

`PORT` is injected by the host — do not set it.

> **Why `NODE_ENV=production` matters:** the frontend (Vercel) and API (Render)
> are different *sites*, so the session cookie is issued `SameSite=None; Secure`.
> That requires HTTPS on both sides (both hosts provide it).

### 3. After deploying

Run the migrations once against the production database:

```bash
DATABASE_URL="<prod connection string>" node scripts/migrate.js
```

Health check: `GET /health` → `{"ok":true,…}`. Swagger: `/api-docs`.

## Feature notes

- **Media** (chat images + voice notes, story media) is stored as base64 data URLs in
  Postgres, matching the existing stories approach. Swap in object storage for production.
- **Voice calls** are peer-to-peer (WebRTC); this server only relays signalling. Add a
  TURN server for restrictive NATs (frontend `VITE_TURN_*`).
- **Story privacy**: `group` (trip members), `global` (everyone), `selected`
  (`story_audience`). **View-once** is tracked in `story_views` and enforced on
  `POST /api/stories/:id/view` (returns `410 Gone` once consumed).
