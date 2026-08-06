'use strict';

const path = require('path');

const ROOT = path.join(__dirname, '..');

module.exports = {
  ROOT,
  PORT: process.env.PORT || 3000,
  WIN_SCORE: parseInt(process.env.WIN_SCORE || '3', 10),
  SHARED_PASSWORD: process.env.SHARED_PASSWORD || '', // empty => no player password
  SUPER_ADMIN_USER: process.env.SUPER_ADMIN_USER || 'superadmin',
  SUPER_ADMIN_PASSWORD: process.env.SUPER_ADMIN_PASSWORD || '', // empty => super panel LOCKED
  MAX_PLAYERS: parseInt(process.env.MAX_PLAYERS || '200', 10),
  TIMER_SECONDS: parseInt(process.env.TIMER_SECONDS || '60', 10), // per-question timer; 0 disables
  NAME_MAX: 24, // max chars for player/team names
  RL_WINDOW_MS: 1000, // rate-limit window per socket
  RL_MAX_EVENTS: 25, // max events per window before dropping
  RL_DISCONNECT_AT: 100, // hard disconnect if wildly over
  // Trust X-Real-IP / X-Forwarded-For for login throttling. Default true:
  // every documented deployment (Caddy, nginx, EKS ingress) puts a reverse
  // proxy in front that sets these. Set to "false" only if the app is ever
  // exposed directly with no proxy — otherwise a client could spoof the
  // header and bypass the per-IP login throttle entirely.
  TRUST_PROXY: process.env.TRUST_PROXY !== 'false',
  // Emit HTTPS-forcing headers (HSTS + CSP upgrade-insecure-requests). Default on
  // for production behind a TLS proxy; set ENABLE_HTTPS=false for plain-HTTP
  // deployments such as a local k3d cluster, or the browser will force https://.
  ENABLE_HTTPS: process.env.ENABLE_HTTPS !== 'false',
  LOG_LEVEL: process.env.LOG_LEVEL || 'info',
  // Set REDIS_URL to run more than one replica. Empty => single-node file backends
  // (the default: `npm start`, tests and plain Docker Compose are unaffected).
  // See docs/scaling.md for why room affinity, not sticky sessions, is what makes
  // multiple replicas correct here.
  REDIS_URL: process.env.REDIS_URL || '',
  QUESTIONS_DIR: process.env.QUESTIONS_DIR || path.join(ROOT, 'questions'),
  PUBLIC_DIR: path.join(ROOT, 'public')
};
