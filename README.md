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
| `CORS_ORIGINS` | Optional extra allowed origins (comma separated) |

## REST API
| Method | Path | Description |
| --- | --- | --- |
| POST | `/api/auth/signup` · `/api/auth/login` · `/api/auth/logout` | Auth (cookie session) |
| GET | `/api/auth/me` | Current user |
| GET/POST | `/api/groups`, `/api/groups/create`, `/api/groups/join` | Groups |
| GET | `/api/groups/:groupId` · `/api/groups/:groupId/members` | Group + members |
| GET | `/api/chats/:groupId` | Group chat history |
| GET/POST | `/api/expenses` · `/api/expenses/summary/:groupId` · `/api/expenses/:groupId/balance` | Expenses |
| GET/POST | `/api/stories` · `/api/stories/group/:groupId` · `/api/stories/user/:userId` | Trip stories |
| GET/POST | `/api/dm` · `/api/dm/:otherUserId` | Direct messages |

## Socket.IO events
Authenticated via the Better Auth session cookie (`src/middleware/socketAuth.js`).

**Client → Server:** `join-group`, `update-location`, `send-message`, `send-dm`,
`vibrate-user`, `ring-user`, `stop-ring`, `post-story`

**Server → Client:** `user-moved`, `receive-message`, `receive-dm`, `vibrate`,
`ring`, `ring-stopped`, `story-updated`, `story-deleted`

## Project layout
```
src/
  config/     db.js, origins.js
  middleware/ authMiddleware.js, socketAuth.js
  routes/     auth, group, chat, expense, story, dm
  sockets/    index, locationSocket, chatSocket, interactionSocket, storySocket
  auth.js     server.js   swagger.js
schema.sql   seed.js   scripts/migrate.js
```
