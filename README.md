# Trip Tracker — Backend

**API, realtime and voice infrastructure for the Trip Tracker tourist-group app.**

Node.js + Express 5 + Socket.IO + PostgreSQL (Neon), with Better Auth sessions,
LiveKit group-voice tokens, WebRTC call signalling, Web Push, geofencing, and a
fully offline Raspberry Pi **hotspot mode**.

> Frontend: [`TrackMyLocation`](https://github.com/nomayen31/TrackMyLocation)

---

## Table of contents

1. [What it powers](#1-what-it-powers)
2. [Feature modules](#2-feature-modules)
3. [Tech stack](#3-tech-stack)
4. [Architecture](#4-architecture)
5. [Getting started](#5-getting-started)
6. [Environment variables](#6-environment-variables)
7. [Scripts](#7-scripts)
8. [REST API](#8-rest-api)
9. [Socket.IO protocol](#9-socketio-protocol)
10. [Database](#10-database)
11. [Hotspot (LAN) mode](#11-hotspot-lan-mode)
12. [Security model](#12-security-model)
13. [Testing](#13-testing)
14. [Deployment](#14-deployment)
15. [Troubleshooting](#15-troubleshooting)

---

## 1. What it powers

Everything behind the frontend:

- **accounts** and sessions (Better Auth, cookie-based)
- **trips**: create, invite by code/link/QR, roles, kick/promote
- **live locations**: GPS fan-out, server-side geofencing
- **group chat** and **private DMs** with images and voice notes
- **stories** with privacy tiers and view-once
- **group voice rooms** (LiveKit) and **1-to-1 WebRTC calls**
- **push notifications** so calls ring with the tab closed
- **expenses** with real per-person splits and settlement
- **admin safety tools**: safe zone, broadcasts, SOS
- **offline hotspot mode** for a Raspberry Pi access point

---

## 2. Feature modules

| Module | What it does |
| --- | --- |
| **Auth** | Sign-up / sign-in / logout via Better Auth; session cookie; `req.user` and `socket.user` everywhere. |
| **Trips** | Owner becomes admin. Invite codes + unique invitation tokens (QR). Promote/demote, remove members. |
| **Locations** | `update-location` fan-out; server computes distance to the safe-zone centre with geolib and emits breach/restore events. |
| **Chat** | Group messages with text, image or audio attachments. |
| **DMs** | 1-to-1 conversations with the same attachment support. |
| **Stories** | image/video/text, privacy `group` \| `global` \| `selected`, **view-once**, 24 h expiry. |
| **Group voice** | LiveKit rooms, private invites, presence, capacity limits, scoped tokens. |
| **1-to-1 calls** | WebRTC signalling relay (offer/answer/ICE), reject, hang-up. |
| **Push** | Web Push subscriptions; incoming calls ring closed tabs. |
| **Expenses** | Categories, equal/custom/payer splits, balances from real shares, settle-up. |
| **Safety** | SOS broadcast, admin map announcements (notice/warning/danger). |
| **Profile** | Name, photo, phone, social handle; broadcast to trip members. |
| **Hotspot** | Offline LAN identity, subnet discovery, WebRTC mesh voice. |

---

## 3. Tech stack

| Concern | Choice |
| --- | --- |
| Runtime | Node.js (CommonJS, `.js` only) |
| HTTP | Express 5 |
| Realtime | Socket.IO 4 |
| Database | PostgreSQL (Neon) via `pg` — raw SQL |
| Auth | Better Auth (cookie sessions) |
| Voice | `livekit-server-sdk` (tokens), WebRTC signalling |
| Push | `web-push` (VAPID) |
| Geo | `geolib` |
| Docs | Swagger UI at `/api-docs` |

---

## 4. Architecture

```
Backend/
├── index.js                 # entry point (`node index.js` works)
├── Dockerfile / render.yaml / railway.json
├── schema.sql               # idempotent schema (run via npm run migrate)
├── seed.js                  # demo users, trips, expenses, messages
├── docs/
│   └── HOTSPOT_SETUP.md     # Raspberry Pi access-point + TLS guide
├── scripts/
│   ├── migrate.js           # applies schema.sql
│   ├── make-cert.js         # self-signed HTTPS cert with SANs
│   └── reset-groups.js      # wipe trip data, keep users
├── src/
│   ├── server.js            # app wiring; switches cloud ⇄ LAN mode
│   ├── auth.js              # Better Auth config
│   ├── swagger.js
│   ├── config/              # db, origins, clientUrl
│   ├── middleware/          # authMiddleware, socketAuth, lanAuth
│   ├── routes/              # 11 route modules (see §8)
│   ├── sockets/             # 10 socket modules (see §9)
│   ├── notifications/push.js
│   ├── lan/                 # config, network, token, presence, mesh
│   ├── voice/               # livekit, presence, voice-room + invitation services
│   ├── attachments.js       # chat media validation
│   └── stories.js           # story visibility / view-once SQL helpers
└── test/                    # node:test suites (45 tests)
```

**Request flow:** route → auth middleware (`req.user`) → service/SQL → response.
**Realtime flow:** socket → `socketAuth` → handler → room emit (`group_<id>`,
`user_<id>`).

---

## 5. Getting started

```bash
git clone https://github.com/nomayen31/TrackMyLocationBackend-.git
cd TrackMyLocationBackend-
npm install

cp .env.example .env          # fill DATABASE_URL, BETTER_AUTH_SECRET, LIVEKIT_*, VAPID_*
npm run migrate               # create tables (idempotent)
npm run seed                  # optional demo data (password: password123)
npm run dev                   # http://localhost:5000
```

- Swagger: <http://localhost:5000/api-docs>
- Health: <http://localhost:5000/health>
- Demo login: `alice@trip.com` / `password123`

---

## 6. Environment variables

Copy `.env.example`. **`.env` is gitignored — never commit it.**

| Variable | Required | Purpose |
| --- | --- | --- |
| `PORT` | no | HTTP port (hosts inject it; default `5000`) |
| `DATABASE_URL` | **yes** | Neon PostgreSQL URI (`?sslmode=require`) |
| `BETTER_AUTH_SECRET` | **yes** | Session signing secret (`openssl rand -hex 32`) |
| `BETTER_AUTH_URL` | **yes** (prod) | This API's public URL |
| `CLIENT_URL` | **yes** (prod) | Frontend origin — CORS, cookies, invite links |
| `CORS_ORIGINS` | no | Extra allowed origins (comma separated) |
| `LIVEKIT_URL` | voice | `wss://…livekit.cloud` |
| `LIVEKIT_API_KEY` | voice | LiveKit API key |
| `LIVEKIT_API_SECRET` | voice | **server-only** token signing secret |
| `VAPID_PUBLIC_KEY` | push | Web Push public key |
| `VAPID_PRIVATE_KEY` | push | **server-only** Web Push private key |
| `VAPID_SUBJECT` | no | `mailto:` contact sent to push services |
| `LAN_MODE` | no | `true` = offline hotspot mode (see §11) |
| `LAN_SECRET` | no | LAN identity token signing secret |
| `LAN_NETWORK_NAME` | no | Name shown in the hotspot UI |
| `LAN_MAX_PEERS` | no | Voice mesh cap (default `6`) |
| `LAN_PRESENCE_TTL_MS` | no | Nearby expiry (default `45000`) |
| `FRONTEND_DIST` | LAN | Path to the built frontend served by the Pi |
| `LAN_HTTPS_CERT` / `LAN_HTTPS_KEY` | LAN voice | TLS cert/key (mic requires HTTPS) |

Generate secrets:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"   # BETTER_AUTH_SECRET
node -e "console.log(require('web-push').generateVAPIDKeys())"             # VAPID
```

---

## 7. Scripts

| Command | Description |
| --- | --- |
| `npm run dev` | nodemon |
| `npm start` | plain node |
| `npm run migrate` | apply `schema.sql` |
| `npm run seed` | demo users/trips/expenses/messages |
| `npm test` | run all `node:test` suites |
| `npm run cert -- --ip 192.168.4.1` | generate a hotspot HTTPS certificate |
| `npm run reset:groups` | dry-run wipe of trip data (`-- --yes` to delete) |

---

## 8. REST API

All routes below require a valid session cookie except `/health`, `/api/lan/info`
and `POST /api/lan/join`. Errors are JSON: `{ "error": "message" }`.

### Auth — `/api/auth`
| Method | Path | Notes |
| --- | --- | --- |
| POST | `/signup` | `{ name, email, password, image?, phone? }` |
| POST | `/login` | `{ email, password }` |
| POST | `/logout` | clears the session |
| GET | `/me` | current user |
| * | `/sign-up/email`, `/get-session`, … | Better Auth native handlers |

### Trips — `/api/groups`
| Method | Path | Notes |
| --- | --- | --- |
| GET | `/` | trips the caller belongs to |
| GET | `/user/:userId` | trips of a user |
| POST | ``, `/create` | create (caller becomes admin) |
| POST | `/join` | `{ inviteCode }` |
| POST | `/invite/:token/join` | auto-join via link/QR (idempotent) |
| GET | `/:groupId` | trip + members |
| GET | `/:groupId/members` | members with role |
| GET | `/:groupId/invite` | code + link + token |
| POST | `/:groupId/members` | admin adds by email/userId |
| PATCH | `/:groupId/members/:userId` | `{ role: 'admin' \| 'member' }` |
| DELETE | `/:groupId/members/:userId` | remove member |

### Chat — `/api/chats`
| GET | `/:groupId` | message history (with sender name) |

### Direct messages — `/api/dm`
| GET | `/` | recent conversations |
| GET | `/:otherUserId` | conversation history (marks read) |
| POST | `/` | REST fallback for sending |

### Stories — `/api/stories`
| GET | `/feed` | every story visible to me (all tiers) |
| GET | `/group/:groupId` | trip stories |
| GET | `/user/:userId` | one member's stories |
| POST | `/` | create (`media`, `mediaType`, `text`, `privacy`, `audienceIds`, `viewOnce`) |
| POST | `/:id/view` | record view; returns the payload once for view-once (`410` afterwards) |
| DELETE | `/:id` | delete your own |

### Expenses — `/api/expenses`
| GET | `/:groupId` | expenses + shares |
| POST | `/` | `{ groupId, amount, category, splitType, participants, customShares }` |
| DELETE | `/:id` | payer or admin |
| GET | `/:groupId/balance` | per-person balances + settlements + categories |
| GET | `/summary/:groupId` | compact summary |

### Safe zone — `/api/safezone`
| GET | `/:groupId` | current zone |
| PUT | `/:groupId` | admin sets radius / disables |

### Profile — `/api/profile`
| GET | `/me` | full profile (name, phone, social, photo) |
| PATCH | `/` | update any of them |

### Voice rooms — `/api/voice`
| GET | `/config` | `{ configured, livekitUrl }` — **never the secret** |
| GET | `/rooms` | visible rooms |
| POST | `/rooms` | create (REST mirror of the socket event) |
| GET | `/rooms/:roomId` | room + allowed members |
| GET | `/invitations` | pending invites for the caller |

### Push — `/api/push`
| GET | `/public-key` | VAPID public key |
| POST | `/subscribe` | store a browser subscription |
| DELETE | `/subscribe` | remove it |
| POST | `/test` | send yourself a test notification |

### Hotspot — `/api/lan` *(LAN mode only)*
| GET | `/info` | `{ lanMode, networkName, maxPeers, subnet }` |
| POST | `/join` | `{ name, deviceId }` → signed LAN token |
| GET | `/me` | validate an existing LAN token |
| GET | `/nearby` | devices on the same /24 |

---

## 9. Socket.IO protocol

Connections are authenticated by `src/middleware/socketAuth.js` (Better Auth
cookie in cloud mode, signed LAN token in hotspot mode). Each socket joins:

- `user_<id>` — personal room (DMs, calls, push-like alerts)
- `group_<id>` — trip room
- `lan_net_<subnet>` / voice rooms — mode-specific

### Client → server
| Event | Payload | Effect |
| --- | --- | --- |
| `join-group` / `leave-group` | `{ groupId }` | trip room membership |
| `update-location` | `{ groupId, lat, lng }` | fan-out + geofence check |
| `send-message` | `{ groupId, message, attachment? }` | group chat |
| `send-dm` | `{ toUserId, groupId?, message, attachment? }` | direct message |
| `voice:room:create/join/leave/update/delete/list` | room payloads | LiveKit rooms |
| `voice:participant:mute` | `{ roomId, muted }` | mute broadcast |
| `voice:invite:send/accept/decline/list` | invitation payloads | private rooms |
| `call-user` | `{ toUserId, groupId?, callId, offer }` | 1-to-1 call invite |
| `accept-call` / `reject-call` | `{ toUserId, callId, answer? }` | answer/decline |
| `ice-candidate` | `{ toUserId, callId, candidate }` | trickle ICE |
| `hang-up` | `{ toUserId, callId }` | end call |
| `post-story` | `{ groupId, media, privacy, … }` | story over socket |
| `vibrate-user` / `ring-user` / `stop-ring` | `{ toUserId }` | device alerts |
| `sos-alert` / `sos-clear` | `{ groupId, lat, lng, message }` | SOS |
| `set-safe-zone` / `disable-safe-zone` | `{ groupId, radiusM }` | admin geofence |
| `admin-broadcast` | `{ groupId, type, title, message }` | map announcement |
| `lan:ping` / `lan:nearby` | — | hotspot presence |
| `mesh:join` / `mesh:leave` / `mesh:signal` / `mesh:speaking` | mesh payloads | LAN voice |

### Server → client
`user-moved`, `boundary-breach-alert`, `boundary-restored`, `receive-message`,
`receive-dm`, `vibrate`, `ring`, `ring-stopped`, `story-updated`,
`story-deleted`, `group-updated`, `member-profile-updated`, `expense-updated`,
`removed-from-group`, `safe-zone-updated`, `admin-broadcast-message`,
`sos`, `sos-sent`, `sos-cleared`,
`voice:room:participants`, `voice:room:updated`, `voice:room:deleted`,
`voice:participant:joined/left/mute`, `voice:invite:received/accepted/declined`,
`incoming-call`, `call-accepted`, `call-rejected`, `ice-candidate`, `call-ended`,
`lan:presence`, `mesh:roster`, `mesh:signal`, `mesh:speaking`.

**Operations that can fail use acknowledgements:**

```js
socket.emit('voice:room:join', { roomId }, (res) => {
  if (!res.ok) console.error(res.error.code, res.error.message);
});
// { ok: true, ...data } | { ok: false, error: { code, message } }
```

---

## 10. Database

PostgreSQL. Schema is applied with `npm run migrate` (idempotent `IF NOT EXISTS`).

**Auth (Better Auth):** `user`, `session`, `account`, `verification`.
The app extends `user` with `phone`, `social`, `avatarUrl`.

**Application:**

| Table | Purpose |
| --- | --- |
| `groups` | trips (`invite_code`, `invite_token`, `created_by`) |
| `group_members` | membership + `role` (`admin`/`member`) |
| `messages` | group chat (+ `attachment_*`, `duration_seconds`) |
| `direct_messages` | 1-to-1 chat (+ attachments, `read_at`) |
| `expenses` / `expense_shares` | spend + exact per-person shares |
| `stories` / `story_audience` / `story_views` | privacy tiers + view-once |
| `group_safe_zones` | radius, owner, live centre |
| `voice_rooms` / `voice_room_members` / `voice_invitations` / `voice_room_bans` | voice rooms |
| `push_subscriptions` | Web Push endpoints per user |

All child tables use `ON DELETE CASCADE`, so deleting a trip removes its
messages, expenses, stories, memberships and safe zone.

---

## 11. Hotspot (LAN) mode

Set `LAN_MODE=true` to run the backend as an **offline Raspberry Pi hotspot
server**:

- no cloud auth or database is touched (`socketAuth` uses signed LAN tokens),
- devices are discovered by **/24 subnet** — everyone on the Pi's access point,
- **group voice is a WebRTC mesh** signalled over Socket.IO (host ICE, no
  STUN/TURN, no internet),
- the built frontend is served from the same origin (no CORS),
- optional HTTPS via `LAN_HTTPS_CERT` / `LAN_HTTPS_KEY`.

```bash
LAN_MODE=true PORT=3000 \
FRONTEND_DIST=/path/to/Frontend/dist \
LAN_HTTPS_CERT=./certs/cert.pem LAN_HTTPS_KEY=./certs/key.pem \
node src/server.js
```

Full setup (hostapd, dnsmasq, TLS, systemd, capacity tuning):
**[docs/HOTSPOT_SETUP.md](docs/HOTSPOT_SETUP.md)**

> Microphones require HTTPS on a LAN IP — this is a browser rule, so TLS is
> mandatory for hotspot voice.

---

## 12. Security model

- **Sessions**: Better Auth cookie; validated per request (`authMiddleware`) and
  per socket (`socketAuth`). The frontend and API are separate sites in
  production, so cookies are issued `SameSite=None; Secure` when
  `NODE_ENV=production`.
- **Authorization is always server-side**: admin-only actions re-check
  `group_members.role`; private-room access and invitations are validated in the
  services, never trusted from the client.
- **Secrets stay server-side**: `BETTER_AUTH_SECRET`, `LIVEKIT_API_SECRET`,
  `VAPID_PRIVATE_KEY`, `DATABASE_URL`, and the LAN private key are never sent to
  the browser.
- **Voice tokens** are scoped to one LiveKit room and a stable user identity,
  with a 15-minute TTL.
- **CORS** is an explicit allow-list (`CLIENT_URL` + `CORS_ORIGINS` + loopback).
- **Input validation** on every handler; attachment size/type limits; per-socket
  rate limits on pokes and invitations.
- **LAN mode is an explicitly trusted-network design** — anyone on the Wi-Fi can
  join. Use a WPA2 password on the access point.

---

## 13. Testing

```bash
npm test
```

Uses Node's built-in test runner (`node:test`) — no extra dependencies.

| Suite | Covers |
| --- | --- |
| `test/voice.presence.test.js` | multi-tab presence, mute state, cleanup |
| `test/voice.services.test.js` | room access, invitations, expiry, bans, capacity, LiveKit token scoping |
| `test/lan.test.js` | subnet grouping, signed LAN tokens, presence TTL, mesh capacity |
| `test/invite.test.js` | invite-link base URL resolution |

**45 tests pass.** Integration suites hit the real database and clean up after
themselves.

---

## 14. Deployment

This is a **long-running server** (persistent WebSockets + in-memory presence), so
it needs a host with persistent processes. **Serverless platforms (Vercel/Netlify
functions) cannot host it** — Socket.IO features break there.

### Render (recommended)
`render.yaml` provisions a Node web service:

- build `npm install`, start `node src/server.js`, health check `/health`
- set the env vars from §6, then set `BETTER_AUTH_URL` to the service URL and
  `CLIENT_URL` to the frontend origin, and redeploy.

### Docker
`Dockerfile` is included for Railway/Fly/any container host:

```bash
docker build -t trip-tracker-api .
docker run -p 5000:5000 --env-file .env trip-tracker-api
```

### After deploying
```bash
DATABASE_URL="<prod connection string>" node scripts/migrate.js
```
Then verify `GET /health` → `{ "ok": true, "mode": "cloud" }`.

---

## 15. Troubleshooting

| Symptom | Cause / fix |
| --- | --- |
| `Cannot find module .../index.js` | Start command must be `node src/server.js` (or `node index.js`). |
| 500 on every request | `DATABASE_URL` missing — `pg` falls back to `localhost:5432`. |
| Browser CORS error | `CLIENT_URL` doesn't match the frontend origin, or the API wasn't redeployed. |
| Login works but session doesn't stick | Cookies need `NODE_ENV=production` (for `SameSite=None`) and HTTPS on both sites. |
| Voice "not configured" | `LIVEKIT_*` missing or the secret is wrong. |
| Calls connect but no audio | Symmetric NAT — add a TURN server. |
| Push never delivered | `VAPID_*` missing, or (iOS) the app isn't installed to the Home Screen. |
| Hotspot mic blocked | Serve the Pi over HTTPS and trust the certificate. |
| Tiles/QR show localhost links | Set `CLIENT_URL`; the code falls back to the request origin, then Host. |

---

## Credits

Express · Socket.IO · Better Auth · LiveKit · Web Push · PostgreSQL/Neon.
Map/routing/weather data from OpenStreetMap, MapTiler, OSRM and Open-Meteo.
