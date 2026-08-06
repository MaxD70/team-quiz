# Team Quiz

Real-time two-team quiz game for early-talent sessions (16 topic sets, 500+ questions).
Multiple hosts can run **concurrent games**: each host opens a room with a 4-digit code,
players join by code, and every game is isolated. Players are drawn into two teams, then
each team votes one answer per question. First to **3 points and ahead** wins; both teams
see each question at once and the answer reveals when both have voted.

Access has three levels: a **super-admin** (you) creates **admin** accounts; each admin
signs in and hosts their own room; **players** need no account and join by code.

Stack: Node.js + Express + Socket.IO. Live game state is in memory; the **history of
already-asked questions is persisted to disk** so questions don't repeat across
sessions or restarts until all 60 are used.

---

## Run locally

```bash
npm install
npm start            # http://localhost:3000
```

- Players: open `/`, enter the game code and a name, click Join.
- Hosts (admins): open `/host.html`, sign in with a username + password.
- Super-admin: open `/admin.html` to create admin accounts and watch active games.

**First-run setup:** set `SUPER_ADMIN_PASSWORD` (and optionally `SUPER_ADMIN_USER`,
default `superadmin`), start the server, sign in at `/admin.html`, and create at least
one admin account — until then nobody can host.

Environment variables:

| Var                    | Default              | Meaning                                                                                                             |
| ---------------------- | -------------------- | ------------------------------------------------------------------------------------------------------------------- |
| `PORT`                 | `3000`               | HTTP port                                                                                                           |
| `WIN_SCORE`            | `3`                  | Points needed to win (must also be ahead)                                                                           |
| `SHARED_PASSWORD`      | _(empty)_            | If set, players must also enter this shared password to join. Empty = no player password.                           |
| `SUPER_ADMIN_USER`     | `superadmin`         | Username for the super-admin panel (`/admin.html`).                                                                 |
| `SUPER_ADMIN_PASSWORD` | _(empty)_            | Super-admin password. **Empty = the super panel is LOCKED** (no one can create admins). Set it on every deployment. |
| `ADMINS_FILE`          | `./data/admins.json` | Where admin accounts are stored (scrypt-hashed passwords). Keep it off version control.                             |
| `DATA_FILE`            | `./data/state.json`  | Where the used-question history is stored                                                                           |
| `QUESTIONS_DIR`        | `./questions`        | Directory of question-set files                                                                                     |
| `MAX_PLAYERS`          | `200`                | Cap on distinct players held in memory                                                                              |
| `LOG_LEVEL`            | `info`               | Pino log level (`debug`, `info`, `warn`, …)                                                                         |

## Production hardening

- **Security headers** via Helmet (CSP, HSTS, X-Frame-Options, nosniff, no `X-Powered-By`).
- **Per-socket rate limiting**: excess events are dropped and flooding sockets disconnected.
- **Input validation**: player ids, names (sanitised, length-capped) and answers are checked server-side; Socket.IO frame size is capped.
- **`GET /healthz`** returns a small JSON status for monitoring / load-balancer probes.
- **Graceful shutdown** on SIGTERM/SIGINT (drains connections, then exits).
- **Structured logging** with pino (JSON; pipe through `pino-pretty` locally if you like).

```bash
SUPER_ADMIN_PASSWORD=pick-a-strong-one SHARED_PASSWORD=letmein npm start
```

## Tests

```bash
npm test
```

Node's built-in runner (`node --test`) covers four files:

- **`test/engine.test.js`** — the `GameEngine` in isolation with an in-memory store: scoring, the win/tie rule, no-repeat + reset, vote locking, timer, difficulty tiers, and answer hiding. Fast, no sockets.
- **`test/rooms.test.js`** — the `RoomManager`: unique codes, per-room isolation, capacity, idle sweep, and per-admin lookup.
- **`test/admins.test.js`** — the admin store: validation, scrypt hashing (no plaintext on disk), verify/reset/change/remove, and super-admin verification.
- **`test/game.test.js`** — the real server over live sockets: game logic end-to-end, admin + super-admin authentication, room isolation, input sanitisation and `/healthz`.

## Development

```bash
npm run lint          # ESLint
npm run format        # Prettier (write)
npm run validate      # check every question set (schema + answer-bias guards)
npm run format:check  # Prettier (check only)
```

CI runs lint, format check and tests on every push/PR (`.github/workflows/ci.yml`).

## Project structure

```
server.js            entry point: express app, helmet, Socket.IO, listen, graceful shutdown
store.js             persistence for per-set "already asked" history (atomic file writes)
src/
  config.js          env + paths
  logger.js          pino logger
  questions.js       loads question sets from a directory
  game.js            GameEngine — the whole game state machine (no transport concerns)
  socketHandlers.js  wires Socket.IO events to the engine (auth, rate limiting, broadcast)
  validation.js      name/answer input helpers
  teamNames.js       funny team-name pool
  util.js            shuffle
questions/           one JSON file per question set
public/              player (index.html) and host (host.html) front-ends + style.css
test/                unit + integration tests
infra/               Terraform (EC2 + nginx + HTTPS)
```

---

## Access & accounts

Three roles, by design:

- **Super-admin** — one, env-based (`SUPER_ADMIN_USER` / `SUPER_ADMIN_PASSWORD`).
  Signs in at `/admin.html`. Creates and removes admin accounts, resets their passwords,
  and sees every active game. Holds no game of its own. If you want to host, give
  yourself an admin account too.
- **Admin** — a persistent account (stored in `ADMINS_FILE`, scrypt-hashed). Signs in at
  `/host.html`, hosts **one room at a time**, and controls only their own room. Can change
  their own password from the host panel. Logging in again resumes the same room rather
  than opening a second one.
- **Player** — no account. Joins a specific room with the 4-digit code and a nickname.

Rooms are **ephemeral** (in memory, swept after a few idle hours or when the host closes
them); admin accounts are **persistent**. Removing an admin also closes any game they are
running. Admins cannot create other admins — only the super-admin can.

---

## How a session works

1. A host (admin) opens `/host.html` and signs in. A **4-digit game code** is created
   for their room; they share the code (or the copy link) with their players.
2. Players open `/`, enter the code and a name, and land in that host's lobby. (Code,
   name and a random id are saved in the browser, so a refresh rejoins the same room.)
   The host clicks **Draw teams** — connected players split randomly into two teams
   (8 → 4 + 4; odd numbers handled, Team A gets the extra). **Redraw** reshuffles.
3. Host (optionally) edits or rerolls the funny team names, then clicks **Start game**.
4. Each question appears on every screen at once. A team agrees offline, any member
   taps the answer, and the team's vote locks.
5. When both teams have voted the answer reveals automatically (correct = +1). The host
   can also force **Reveal**, then **Next question**.
6. First team to the win score while ahead wins. If both tie at the threshold, play
   continues until one pulls ahead.

### No repeats

Every question has a stable id. Each new question is drawn at random from the ones not
yet used, and is recorded immediately. When all 60 have been used the history clears and
the pool starts over. The host panel shows **M / 60 used overall**.

- **New match** — resets scores and teams (players stay), but **keeps** the question
  history, so the next match continues with fresh questions.
- **Reset question history** — clears the used list so questions can appear again
  (e.g. to start a brand-new run of the 60).

---

## Deploy on Ubuntu (EC2)

1. Install Node LTS:
   ```bash
   curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
   sudo apt-get install -y nodejs
   ```
2. Copy the project, install deps:
   ```bash
   cd /opt/team-quiz && npm install --omit=dev
   ```
3. systemd unit `/etc/systemd/system/team-quiz.service`:
   ```ini
   [Unit]
   Description=Team Quiz
   After=network.target

   [Service]
   WorkingDirectory=/opt/team-quiz
   ExecStart=/usr/bin/node server.js
   Environment=PORT=3000
   Environment=WIN_SCORE=3
   Environment=SUPER_ADMIN_PASSWORD=change-me
   # Environment=SUPER_ADMIN_USER=superadmin
   # Environment=SHARED_PASSWORD=letmein
   # Environment=DATA_FILE=/var/lib/team-quiz/state.json
   # Environment=ADMINS_FILE=/var/lib/team-quiz/admins.json
   Restart=on-failure
   User=ubuntu

   [Install]
   WantedBy=multi-user.target
   ```
   ```bash
   sudo systemctl daemon-reload && sudo systemctl enable --now team-quiz
   ```
   If you set `DATA_FILE` outside the app dir, make sure that directory exists and is
   writable by the service user (`sudo mkdir -p /var/lib/team-quiz && sudo chown ubuntu /var/lib/team-quiz`).
4. nginx reverse proxy (the Upgrade/Connection headers are required for WebSockets):
   ```nginx
   server {
     listen 80;
     server_name quiz.example.com;
     location / {
       proxy_pass http://127.0.0.1:3000;
       proxy_http_version 1.1;
       proxy_set_header Upgrade $http_upgrade;
       proxy_set_header Connection "upgrade";
       proxy_set_header Host $host;
       proxy_set_header X-Real-IP $remote_addr;
       proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
       proxy_set_header X-Forwarded-Proto $scheme;
     }
   }
   ```
   Add TLS (certbot) and open 80/443 in the security group.

---

## Run with Docker

The image runs as the non-root `node` user and persists both the question history
(`DATA_FILE`) and the admin accounts (`ADMINS_FILE`) under `/data`, which is created and
owned by `node` at build time so a mounted volume is writable.

```bash
cp .env.example .env && chmod 600 .env   # set SUPER_ADMIN_PASSWORD at least
docker compose up -d                     # app on 127.0.0.1:3000, state in the quiz-data volume
```

Add automatic HTTPS with a Caddy reverse proxy (obtains/renews a Let's Encrypt cert for
`QUIZ_DOMAIN`, and forwards WebSocket/Socket.IO transparently):

```bash
docker compose --profile proxy up -d
```

By default the app is also bound to `127.0.0.1:3000` on the host for local debugging.
Remove the `ports:` block under the `app` service if you want Caddy to be the only
entry point.

Persistence lives on the named `quiz-data` volume. Back it up with:

```bash
docker run --rm -v team-quiz_quiz-data:/data -v "$PWD":/backup alpine \
  tar czf /backup/quiz-data-$(date +%F).tgz -C /data .
```

Migrating from the systemd/EC2 deployment (state in `/var/lib/team-quiz/`)? Copy `state.json`
into the volume before the first `up`. A `Dockerfile` and a Kubernetes/Helm chart (`deploy/`)
are also included for running the same image on the EKS platform.

## Question sets

Questions live in `questions/`, one JSON file per set. The host picks which set to play
from a dropdown in the lobby, and the "already asked" history is tracked **per set**, so
each set exhausts its own pool independently.

18 sets ship in `questions/` (664 questions in total) — Linux, AWS, Azure, Networking,
Cisco-style, Security, Containers & Kubernetes, CI/CD & IaC, Databases, AI, Java/DevOps
and a few for fun.
Every question carries a difficulty tier (`medium` / `hard` / `pro`); the host can filter
tiers live. `scripts/validate-sets.js` (run by `npm run validate` and in CI) checks each
set for schema, answer-position balance, length bias, and duplicates. The host panel shows
a used/total counter per set and a per-set "Reset question history".

Each set file:

```json
{
  "id": "java-devops-core",
  "name": "Java & DevOps · Core",
  "description": "Shown under the selector.",
  "order": 1,
  "questions": [
    {
      "id": "q001",
      "topic": "Java",
      "text": "…",
      "options": ["…", "…", "…", "…"],
      "correct": 0,
      "explanation": "Shown to both teams after the vote."
    }
  ]
}
```

`correct` is the zero-based index. `order` controls the position in the dropdown. To add a
set, drop a new file in `questions/` and restart the service — no code change. Ids only need
to be unique within their own set. `build_sets.py` is the tool used to create the shipped
sets, but the files are the source of truth and can be edited directly.

The explanation is revealed only after both teams vote (the host also sees it during the
question, to read aloud).

## Persistence: why a file, not a database

The only thing that needs to survive restarts is the small set of used-question ids, so
the persistence layer (`store.js`) writes an atomic JSON file. The interface is tiny —
`getUsed` / `markUsed` / `resetUsed` — so if you later want a real database (e.g. to keep
match history, leaderboards, or run multiple rooms) you can swap `store.js` for a SQLite
implementation without changing `server.js`. SQLite (single file, no server) is the
natural next step; Postgres only if you go multi-instance.

## Changelog (recent)

- **v1.13.0** — the host can set the target score per room: "Questions to win (1-20)" in the host controls, next to the timer. `WIN_SCORE` still supplies the default (now clamped into range at construction), but each room can override it. The target is locked once the match is under way — lowering it mid-match would hand out a retroactive win, and raising it with a team one point from the line is equally unfair — and unlocks again on "New match".
- **v1.12.0** — optional Redis backend for the state that must be shared between replicas (admin accounts, question history), behind the same synchronous interface; the file backend remains the default and single-node behaviour is unchanged. Includes the Socket.IO Redis adapter, an optional `redis` Compose profile, automatic seeding from `admins.json`, and [docs/scaling.md](docs/scaling.md) explaining why sticky sessions were _not_ the answer.
- **v1.11.0** — library expansion: two new sets (Observability & Monitoring; Python & Scripting, 30 questions each), Security grown 60→90 with a T-Level-friendly tier, and linux-cli/git-workflow/aws-fundamentals fattened to 40 each. 18 sets, 664 questions, all through the validator (position and length-bias checks included).
- **v1.10.0**: sound on reveal (synthesized via WebAudio — no audio assets; mute toggle in the top bar) and a read-only big-screen spectator view at `/spectate.html` (open it from the host panel's "Big screen" button, or share `/spectate.html?room=CODE`). Spectators see the player view of the state — never the answer before reveal — and don't appear in the roster. `loadSets` now also skips dotfiles, so stray macOS `._*.json` AppleDouble files can no longer crash startup.
- **v1.9.0** — security hardening (from the security review): admin/super-admin sessions now use short-lived, server-issued bearer tokens instead of keeping the password in `sessionStorage` (`admin:resume`/`super:resume`, revocable via the new "Sign out" button); repeated failed logins from the same IP are throttled (`src/loginThrottle.js`); and player identifiers broadcast to the room are now unlinkable `publicId`s — knowing one no longer lets another client take over that player's session (`src/game.js`).
- **Earlier versions** (v1.1.0–v1.8.0, including the move to concurrent rooms: `RoomManager` keys one `GameEngine` per room, so many hosts run isolated games at once): see the full version history in the [technical overview](public/tech.html).

## Possible next steps

- Run multi-replica (Redis-backed shared state is done — see [docs/scaling.md](docs/scaling.md)). What is left is the Helm chart with room-affinity routing (`upstream-hash-by: $arg_room`) and a PDB. Note: this is about running where the rest of the platform runs, **not** about load — ten concurrent games is a hundred sockets, which one small instance handles without noticing.
- Deploy on the EKS platform using the included Helm chart (`deploy/helm/`).
- Keep growing the question library as the programme runs.
