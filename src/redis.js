'use strict';

// Optional Redis wiring. The app is designed to run happily WITHOUT Redis:
// if REDIS_URL is unset, everything falls back to the single-node file backends
// and this module hands back nulls. That keeps `npm start`, the tests and the
// plain Docker Compose setup exactly as they were.
//
// When REDIS_URL *is* set (the multi-replica / EKS case), Redis becomes the
// source of truth for the two pieces of state that must be shared across pods:
//   - which questions have already been asked (store.js)
//   - the admin accounts (src/admins.js)
// Game state itself stays in each pod's memory — rooms are sharded by room code
// at the ingress (see the Helm chart), so exactly one pod owns any given game.

const Redis = require('ioredis');
const logger = require('./logger');

const URL = process.env.REDIS_URL || '';

let client = null; // commands
let subscriber = null; // pub/sub (a subscribed connection can't run commands)

function enabled() {
  return !!URL;
}

// Two connections: one for commands, one parked in subscribe mode.
function connect() {
  if (!enabled() || client) return { client, subscriber };

  const opts = {
    lazyConnect: false,
    maxRetriesPerRequest: 2,
    retryStrategy: (times) => Math.min(times * 200, 3000)
  };

  client = new Redis(URL, opts);
  subscriber = new Redis(URL, opts);

  for (const [name, c] of [
    ['client', client],
    ['subscriber', subscriber]
  ]) {
    c.on('error', (err) => logger.error({ err: err.message, name }, 'redis error'));
    c.on('connect', () => logger.info({ name }, 'redis connected'));
    c.on('close', () => logger.warn({ name }, 'redis connection closed'));
  }

  return { client, subscriber };
}

function getClient() {
  return client;
}

function getSubscriber() {
  return subscriber;
}

async function quit() {
  const cs = [client, subscriber].filter(Boolean);
  client = null;
  subscriber = null;
  await Promise.allSettled(cs.map((c) => c.quit()));
}

module.exports = { enabled, connect, getClient, getSubscriber, quit, URL };
