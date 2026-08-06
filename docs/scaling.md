# Running more than one replica

This document exists because the obvious plan was wrong, and the reason it was
wrong is more instructive than the fix.

## The plan that doesn't work

The README used to suggest:

> Run multi-replica by moving game state behind a Redis adapter with sticky sessions.

That sentence contains two ideas, and neither does what it sounds like.

**The Socket.IO Redis adapter does one thing:** it makes `io.to(room).emit(...)`
on replica A reach sockets connected to replica B. It relays _messages_. It does
not move, share, or replicate application state. Game state in this app lives here:

```js
// src/rooms.js
this.rooms = new Map(); // code -> { engine, createdAt, lastActivity, hostAdmin }
```

That is a plain `Map` in one Node process. The adapter never touches it.

**Sticky sessions don't rescue this**, because sticky is _per client_. It
guarantees that one player keeps hitting the same replica across reconnects. It
says nothing about where their _teammates_ land. Player 1 sticks to replica A,
player 2 sticks to replica B — and replica B has never heard of room 4271, so
`manager.get('4271')` returns `null` and player 2 is told the room doesn't
exist, on a service that is running perfectly.

Sticky sessions solve "keep a client on one replica". The problem here is
"keep a _game_ on one replica". Different problem, different tool.

There is a second, quieter bug in the naive plan. Each replica runs this:

```js
// src/socketHandlers.js
const ticker = setInterval(() => {
  /* ... engine.checkTimeout() ... */
}, 500);
```

If replicas shared game state, every replica would run its own ticker over every
room. Three replicas would fire three `reveal()` calls on the same question the
moment a timer expired.

## What actually makes this app scale

The saving grace is a property of the domain: **games are islands.** Room 4271
never needs to know anything about room 8830. That makes a game a perfect unit of
sharding.

So instead of sharing game state, we make sure **exactly one replica owns any
given game**, and route by room code at the ingress:

```yaml
# nginx ingress
nginx.ingress.kubernetes.io/upstream-hash-by: '$arg_room'
```

Every connection carrying `?room=4271` hashes to the same pod. Game state stays
in memory. The engine stays synchronous. The ticker stays correct, because each
room has exactly one owner. No locks, no `WATCH`/`MULTI`, no serialising a
`GameEngine` into JSON on every vote.

This is _room affinity_, and it is not the same thing as sticky sessions.

## What genuinely must be shared

Two pieces of state are not per-game, and break in ugly ways if each replica
keeps its own copy:

| State                            | Where           | What breaks without sharing                                                                                                                      |
| -------------------------------- | --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| Admin accounts                   | `src/admins.js` | An admin created on pod A cannot log in on pod B. Logins appear to work or fail at random depending on which pod you hit. The worst kind of bug. |
| Question history (`usedByStack`) | `store.js`      | Each pod thinks different questions have been asked, so the "don't repeat questions" guarantee quietly dies.                                     |

Both now have two interchangeable backends behind **the same synchronous
interface**:

- **file** (default, `REDIS_URL` unset) — exactly the old behaviour. Single node,
  atomic JSON files. `npm start`, the test suite and plain Docker Compose are
  completely unaffected.
- **redis** (`REDIS_URL` set) — shared across replicas.

### Why the interface stayed synchronous

`store.getUsed()` is called from `GameEngine.publicState()`, which runs on
**every broadcast**. Making it `async` would have turned the entire engine
async — and `GameEngine` is the cleanest, purest, most testable part of this
codebase. Not worth it.

Instead the Redis backend keeps an in-memory cache that is:

1. loaded once at `init()`, before the server starts listening;
2. updated immediately on our own writes (write-through), so the next read is correct;
3. refreshed when _another_ replica publishes a change (pub/sub invalidation).

### Why concurrent writes don't clobber each other

Every write uses a **native atomic Redis operation** — `SADD` for used questions,
`HSET`/`HDEL` for admins — never read-modify-write. Two replicas marking
different questions used at the same instant both survive; two replicas creating
different admins both survive. There is a sub-millisecond window in which one
replica's cache is stale, and the worst case it can produce is a question
repeating once. Acceptable. A lost admin account would not have been.

There is a test for exactly this property
(`test/redis-backend.test.js` → "concurrent writes MERGE — no replica clobbers
the other").

### Migration is automatic

On first boot with `REDIS_URL` set, if Redis has no admins but a local
`admins.json` exists, it is seeded into Redis. Moving from the EC2 box to EKS
does not mean recreating every admin account by hand.

## The trade-off you are accepting

Game state lives in one pod's memory. **If that pod dies mid-game, that game is
lost.** Players see the room disappear; the host reopens it and replays the
question.

This is a real cost and it should be a conscious choice, not an accident. It is
acceptable here because:

- games are short (~20 minutes) and scheduled, not 24/7;
- you control when deployments happen, so you simply don't deploy during a session;
- a `PodDisruptionBudget` plus a generous `terminationGracePeriodSeconds` keeps
  voluntary disruptions (node drains, rollouts) from landing on a live game.

The alternative — serialising the whole `GameEngine` into Redis with optimistic
locking on every vote, plus a leader-elected ticker — buys you survival of a pod
death mid-game, at the cost of rewriting the core of the app. That is a much
bigger project, and it is not needed for the load this thing will ever see:
ten concurrent games of ten players is a hundred sockets. A single small instance
idles through that.

**Scale is not why you would run this on Kubernetes.** Running where the rest of
the platform runs, with the same deployment story and the same observability, is.
Be honest about that when you propose it.

## Running it

Single node (unchanged, still the default):

```bash
npm start
```

Two replicas locally, with Redis and room-affinity routing:

```bash
# .env
REDIS_URL=redis://redis:6379

docker compose --profile redis up -d --scale app=2
```

Check which replica answered, and that shared state is on:

```bash
curl -s localhost:3000/healthz | jq '.replica, .redis, .admins'
```

Run the Redis backend tests (skipped by default):

```bash
redis-server --daemonize yes --port 6379
REDIS_TEST_URL=redis://127.0.0.1:6379 npm test
```
