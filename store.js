'use strict';

// Persistence for "which questions have already been asked", tracked PER SET.
//
// Two interchangeable backends behind ONE synchronous interface:
//
//   file  (default)  — atomic JSON file. Single node. Unchanged behaviour.
//   redis (REDIS_URL set) — shared across replicas.
//
// The interface stays synchronous on purpose: getUsed() is called from
// GameEngine.publicState(), i.e. on every broadcast. Making it async would
// turn the whole engine async for no benefit. Instead the Redis backend keeps
// a local in-memory cache that is:
//   - loaded once at init()
//   - updated immediately on our own writes (write-through)
//   - refreshed when ANOTHER replica publishes a change (pub/sub invalidation)
//
// Writes use native atomic Redis ops (SADD / DEL), never read-modify-write, so
// two replicas marking questions used at the same time cannot clobber each other.
// The only cost is a sub-millisecond window where a replica's cache is stale --
// harmless here: the worst case is a question repeating once across two games.

const fs = require('fs');
const path = require('path');
const redis = require('./src/redis');
const logger = require('./src/logger');

const DATA_FILE = process.env.DATA_FILE || path.join(__dirname, 'data', 'state.json');
const KEY_PREFIX = 'quiz:used:'; // one Redis SET per stack id
const CHANNEL = 'quiz:used:changed';

// ---------------- file backend (single node) ----------------

function ensure() {
  const dir = path.dirname(DATA_FILE);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  if (!fs.existsSync(DATA_FILE)) writeFile({ usedByStack: {} });
}

function readFile() {
  ensure();
  try {
    const raw = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
    if (!raw.usedByStack) raw.usedByStack = {}; // migrate/ignore legacy shapes
    return raw;
  } catch (e) {
    return { usedByStack: {} };
  }
}

function writeFile(obj) {
  const dir = path.dirname(DATA_FILE);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const tmp = DATA_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2));
  fs.renameSync(tmp, DATA_FILE);
}

const fileBackend = {
  async init() {},
  getUsed(stackId) {
    return readFile().usedByStack[stackId] || [];
  },
  markUsed(stackId, id) {
    const s = readFile();
    s.usedByStack[stackId] = s.usedByStack[stackId] || [];
    if (!s.usedByStack[stackId].includes(id)) {
      s.usedByStack[stackId].push(id);
      writeFile(s);
    }
  },
  resetUsed(stackId) {
    const s = readFile();
    s.usedByStack[stackId] = [];
    writeFile(s);
  },
  describe() {
    return DATA_FILE;
  }
};

// ---------------- redis backend (multi replica) ----------------

const cache = new Map(); // stackId -> Set of question ids

function makeRedisBackend() {
  async function loadAll() {
    const c = redis.getClient();
    if (!c) return;
    const keys = await c.keys(KEY_PREFIX + '*');
    cache.clear();
    for (const k of keys) {
      const ids = await c.smembers(k);
      cache.set(k.slice(KEY_PREFIX.length), new Set(ids));
    }
  }

  async function refresh(stackId) {
    const c = redis.getClient();
    if (!c) return;
    try {
      const ids = await c.smembers(KEY_PREFIX + stackId);
      cache.set(stackId, new Set(ids));
    } catch (err) {
      logger.error({ err: err.message, stackId }, 'store: refresh failed');
    }
  }

  return {
    async init() {
      redis.connect();
      await loadAll();
      const sub = redis.getSubscriber();
      await sub.subscribe(CHANNEL);
      sub.on('message', (chan, msg) => {
        if (chan !== CHANNEL) return;
        // Another replica changed a stack — pull its current members.
        refresh(String(msg));
      });
      logger.info({ stacks: cache.size }, 'store: redis backend ready');
    },

    // Synchronous read straight from the local cache.
    getUsed(stackId) {
      const s = cache.get(stackId);
      return s ? [...s] : [];
    },

    markUsed(stackId, id) {
      // Update our own cache immediately so the very next read is correct...
      if (!cache.has(stackId)) cache.set(stackId, new Set());
      if (cache.get(stackId).has(id)) return;
      cache.get(stackId).add(id);
      // ...then push to Redis. SADD is atomic: concurrent replicas merge, never clobber.
      const c = redis.getClient();
      if (!c) return;
      c.sadd(KEY_PREFIX + stackId, id)
        .then(() => c.publish(CHANNEL, stackId))
        .catch((err) => logger.error({ err: err.message, stackId, id }, 'store: markUsed failed'));
    },

    resetUsed(stackId) {
      cache.set(stackId, new Set());
      const c = redis.getClient();
      if (!c) return;
      c.del(KEY_PREFIX + stackId)
        .then(() => c.publish(CHANNEL, stackId))
        .catch((err) => logger.error({ err: err.message, stackId }, 'store: resetUsed failed'));
    },

    describe() {
      return 'redis(' + KEY_PREFIX + '*)';
    }
  };
}

// ---------------- public interface (unchanged, synchronous) ----------------

const backend = redis.enabled() ? makeRedisBackend() : fileBackend;

module.exports = {
  init: () => backend.init(),
  getUsed: (stackId) => backend.getUsed(stackId),
  markUsed: (stackId, id) => backend.markUsed(stackId, id),
  resetUsed: (stackId) => backend.resetUsed(stackId),
  filePath: () => backend.describe(),
  usingRedis: () => redis.enabled()
};
