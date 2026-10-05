'use strict';

// Persistent admin accounts + super-admin verification (Tappa B).
//
// - Admins live in data/admins.json (gitignored), passwords stored as scrypt hashes.
//   The super-admin creates them; each admin can host their own room.
// - The super-admin is env-based (SUPER_ADMIN_USER / SUPER_ADMIN_PASSWORD): it holds
//   no game state, only manages admins. If the password is unset, the super panel is
//   LOCKED (all logins fail) rather than open — this is the most powerful role.
//
// Storage has two interchangeable backends behind one SYNCHRONOUS interface:
//   file  (default)        — data/admins.json, mode 0600. Single node.
//   redis (REDIS_URL set)  — a Redis hash, shared across replicas.
//
// Sharing admins is not optional once you run more than one replica: an admin
// created on pod A must exist on pod B, or logins succeed or fail depending on
// which pod you happen to land on — the most maddening bug there is.
//
// The Redis backend keeps an in-memory cache (loaded at init, updated on our own
// writes, refreshed via pub/sub when another replica changes something) so that
// verify() stays synchronous and fast. Writes use atomic HSET/HDEL, so two
// replicas creating different admins at once cannot overwrite each other.
// Password hashes never leave Redis in plaintext — the same scrypt salt+hash
// records are stored, exactly as in the file backend.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const redis = require('./redis');
const logger = require('./logger');

const ADMINS_FILE = process.env.ADMINS_FILE || path.join(__dirname, '..', 'data', 'admins.json');
const REDIS_KEY = 'quiz:admins'; // hash: username -> JSON record
const CHANNEL = 'quiz:admins:changed';
const MIN_PASSWORD = 8;
const USERNAME_RE = /^[a-zA-Z0-9_-]{3,32}$/;

function hash(password, salt) {
  return crypto.scryptSync(String(password), salt, 64).toString('hex');
}

function timingSafeEq(a, b) {
  const ba = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
}

// ---- file backend ----

function readFile() {
  try {
    const raw = JSON.parse(fs.readFileSync(ADMINS_FILE, 'utf8'));
    if (Array.isArray(raw)) return raw;
  } catch (e) {
    /* no file yet, or unreadable — treat as empty */
  }
  return [];
}

function writeFile(list) {
  const dir = path.dirname(ADMINS_FILE);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const tmp = ADMINS_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(list, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, ADMINS_FILE);
}

// ---- redis backend (cache + write-through + pub/sub invalidation) ----

let cache = []; // full admin records; the synchronous source of truth for reads

async function reload() {
  const c = redis.getClient();
  if (!c) return;
  try {
    const h = await c.hgetall(REDIS_KEY);
    cache = Object.values(h || {})
      .map((v) => {
        try {
          return JSON.parse(v);
        } catch (e) {
          return null;
        }
      })
      .filter(Boolean);
  } catch (err) {
    logger.error({ err: err.message }, 'admins: reload failed');
  }
}

// One-time migration: if Redis is empty but a local admins.json exists, seed it.
// Makes the EC2 -> EKS move painless — no admin has to be recreated by hand.
async function seedFromFileIfEmpty() {
  const c = redis.getClient();
  const existing = await c.hlen(REDIS_KEY);
  if (existing > 0) return 0;
  const fromFile = readFile();
  if (!fromFile.length) return 0;
  const flat = [];
  for (const a of fromFile) flat.push(a.username, JSON.stringify(a));
  await c.hset(REDIS_KEY, ...flat);
  logger.info({ count: fromFile.length }, 'admins: seeded redis from admins.json');
  return fromFile.length;
}

async function init() {
  if (!redis.enabled()) return;
  redis.connect();
  await seedFromFileIfEmpty();
  await reload();
  const sub = redis.getSubscriber();
  await sub.subscribe(CHANNEL);
  sub.on('message', (chan) => {
    if (chan === CHANNEL) reload(); // another replica changed the admin list
  });
  logger.info({ admins: cache.length }, 'admins: redis backend ready');
}

function publish() {
  const c = redis.getClient();
  if (c) c.publish(CHANNEL, '1').catch(() => {});
}

// ---- dispatch: one synchronous interface over both backends ----

function readAll() {
  return redis.enabled() ? cache : readFile();
}

// Persist a single record (create/update). Atomic HSET — no read-modify-write.
function putOne(record) {
  if (!redis.enabled()) {
    const all = readFile();
    const i = all.findIndex((a) => a.username === record.username);
    if (i === -1) all.push(record);
    else all[i] = record;
    writeFile(all);
    return;
  }
  const i = cache.findIndex((a) => a.username === record.username);
  if (i === -1) cache.push(record);
  else cache[i] = record;
  const c = redis.getClient();
  if (!c) return;
  c.hset(REDIS_KEY, record.username, JSON.stringify(record))
    .then(publish)
    .catch((err) => logger.error({ err: err.message }, 'admins: write failed'));
}

// Delete a single record. Atomic HDEL.
function deleteOne(username) {
  if (!redis.enabled()) {
    const all = readFile();
    const i = all.findIndex((a) => a.username === username);
    if (i === -1) return false;
    all.splice(i, 1);
    writeFile(all);
    return true;
  }
  const i = cache.findIndex((a) => a.username === username);
  if (i === -1) return false;
  cache.splice(i, 1);
  const c = redis.getClient();
  if (c) {
    c.hdel(REDIS_KEY, username)
      .then(publish)
      .catch((err) => logger.error({ err: err.message }, 'admins: delete failed'));
  }
  return true;
}

// ---- Admin store (public: never returns hashes/salts) ----

function list() {
  return readAll().map((a) => ({
    username: a.username,
    createdAt: a.createdAt,
    createdBy: a.createdBy || null
  }));
}

function exists(username) {
  const u = String(username || '').trim();
  return readAll().some((a) => a.username === u);
}

function create(username, password, createdBy) {
  const u = String(username || '').trim();
  if (!USERNAME_RE.test(u)) {
    return { ok: false, error: 'Username must be 3–32 chars: letters, numbers, _ or -' };
  }
  if (String(password || '').length < MIN_PASSWORD) {
    return { ok: false, error: 'Password must be at least ' + MIN_PASSWORD + ' characters' };
  }
  const all = readAll();
  if (all.some((a) => a.username === u)) {
    return { ok: false, error: 'That username already exists' };
  }
  const salt = crypto.randomBytes(16).toString('hex');
  putOne({
    username: u,
    salt,
    hash: hash(password, salt),
    createdAt: new Date().toISOString(),
    createdBy: createdBy || null
  });
  return { ok: true };
}

function verify(username, password) {
  const a = readAll().find((x) => x.username === String(username || '').trim());
  if (!a) return false;
  return timingSafeEq(hash(password, a.salt), a.hash);
}

function setPassword(username, newPassword) {
  if (String(newPassword || '').length < MIN_PASSWORD) {
    return { ok: false, error: 'Password must be at least ' + MIN_PASSWORD + ' characters' };
  }
  const a = readAll().find((x) => x.username === String(username || '').trim());
  if (!a) return { ok: false, error: 'No such admin' };
  const salt = crypto.randomBytes(16).toString('hex');
  putOne({ ...a, salt, hash: hash(newPassword, salt) });
  return { ok: true };
}

function changePassword(username, current, next) {
  if (!verify(username, current)) return { ok: false, error: 'Current password is wrong' };
  return setPassword(username, next);
}

function remove(username) {
  const u = String(username || '').trim();
  if (!deleteOne(u)) return { ok: false, error: 'No such admin' };
  return { ok: true };
}

// ---- Super-admin (env-based) ----

// Locked (always false) when envPassword is empty — the super panel must be
// explicitly enabled by setting SUPER_ADMIN_PASSWORD.
function verifySuper(username, password, envUser, envPassword) {
  if (!envPassword) return false;
  const uOk = timingSafeEq(username, envUser || 'superadmin');
  const pOk = timingSafeEq(password, envPassword);
  return uOk && pOk;
}

module.exports = {
  init,
  list,
  exists,
  create,
  verify,
  setPassword,
  changePassword,
  remove,
  verifySuper,
  MIN_PASSWORD,
  filePath: () => (redis.enabled() ? 'redis(' + REDIS_KEY + ')' : ADMINS_FILE),
  usingRedis: () => redis.enabled()
};
