'use strict';

const express = require('express');
const http = require('http');
const helmet = require('helmet');
const { Server } = require('socket.io');
const { createAdapter } = require('@socket.io/redis-adapter');

const config = require('./src/config');
const redis = require('./src/redis');
const logger = require('./src/logger');
const store = require('./store');
const { loadSets } = require('./src/questions');
const { RoomManager } = require('./src/rooms');
const admins = require('./src/admins');
const { registerSocketHandlers } = require('./src/socketHandlers');

// ---- Load content + build the room manager ----
const { sets, order } = loadSets(config.QUESTIONS_DIR);
const manager = new RoomManager({
  sets,
  order,
  store,
  winScore: config.WIN_SCORE,
  requiresPassword: !!config.SHARED_PASSWORD,
  maxPlayers: config.MAX_PLAYERS,
  timerSeconds: config.TIMER_SECONDS
});

// ---- HTTP app ----
const app = express();

// Security headers. Scripts are locked to same-origin — there are no inline <script>
// blocks; all page JS loads from external files (app.js, hostapp.js, adminapp.js).
// Inline style="" attributes are used, so styleSrc allows 'unsafe-inline'; everything
// else is same-origin. data: is needed for a small inline SVG in CSS.
// HTTPS-forcing headers (HSTS, and CSP's upgrade-insecure-requests) are correct
// ONLY when the app is actually reached over HTTPS. Behind a TLS-terminating
// proxy (ALB on EKS, nginx on the EC2 box) that's the production case. Emitting
// them unconditionally breaks plain-HTTP access — e.g. a local k3d cluster with
// no TLS — by making the browser rewrite every request to https:// and then
// remember to do so (HSTS) for months. So gate them on ENABLE_HTTPS, which
// defaults on for production and is turned off for local plain-HTTP testing.
const httpsHeaders = config.ENABLE_HTTPS;
const cspDirectives = {
  defaultSrc: ["'self'"],
  scriptSrc: ["'self'"],
  styleSrc: ["'self'", "'unsafe-inline'"],
  imgSrc: ["'self'", 'data:'],
  connectSrc: ["'self'"],
  objectSrc: ["'none'"],
  baseUri: ["'self'"],
  frameAncestors: ["'none'"]
};
// helmet injects upgrade-insecure-requests unless the key is present and null.
if (!httpsHeaders) cspDirectives['upgrade-insecure-requests'] = null;

app.use(
  helmet({
    contentSecurityPolicy: { directives: cspDirectives },
    // HSTS off when not served over HTTPS, or the browser caches the redirect.
    strictTransportSecurity: httpsHeaders,
    crossOriginEmbedderPolicy: false
  })
);

// Legacy page names (pre-1.3.0) — permanent redirects so old links keep working.
app.get('/instructions.html', (req, res) => res.redirect(301, '/guide.html'));
app.get('/overview.html', (req, res) => res.redirect(301, '/tech.html'));

app.use(express.static(config.PUBLIC_DIR));

app.get('/config', (req, res) =>
  res.json({
    requiresPassword: !!config.SHARED_PASSWORD,
    superEnabled: !!config.SUPER_ADMIN_PASSWORD
  })
);

// Lightweight health check for monitoring / load-balancer probes.
app.get('/healthz', (req, res) =>
  res.json({
    status: 'ok',
    uptime: Math.round(process.uptime()),
    sets: order.length,
    rooms: manager.count(),
    admins: admins.list().length,
    players: manager.list().reduce((n, r) => n + r.players, 0),
    // Which pod answered, and whether shared state is on. Invaluable when
    // debugging room affinity: hit /healthz repeatedly and watch the id change.
    replica: process.env.HOSTNAME || 'single',
    redis: redis.enabled()
  })
);

// ---- Realtime ----
const server = http.createServer(app);
const io = new Server(server, {
  maxHttpBufferSize: 1e4 // 10 KB — cap frame size so a client can't send huge payloads
});
registerSocketHandlers(io, manager);

// ---- Start ----
// Async boot: the shared-state backends must be warm BEFORE the first socket
// connects, otherwise an admin could hit a pod whose cache is still empty and
// be told their password is wrong. With no REDIS_URL these are no-ops.
async function boot() {
  if (redis.enabled()) {
    redis.connect();
    // Socket.IO's Redis adapter relays broadcasts between replicas. With room
    // affinity at the ingress a single pod normally owns a whole game, so this
    // is belt-and-braces: it keeps things correct while the hash rebalances
    // after a pod is added or removed.
    const pubClient = redis.getClient();
    const subClient = pubClient.duplicate();
    io.adapter(createAdapter(pubClient, subClient));
  }
  await Promise.all([store.init(), admins.init()]);
  listen();
}

function listen() {
  server.listen(config.PORT, () => {
    logger.info(
      {
        port: Number(config.PORT),
        winScore: config.WIN_SCORE,
        sets: order.length,
        playerPassword: !!config.SHARED_PASSWORD,
        superEnabled: !!config.SUPER_ADMIN_PASSWORD,
        admins: admins.list().length,
        store: store.filePath(),
        redis: redis.enabled() ? 'enabled (multi-replica)' : 'disabled (single node)'
      },
      `Quiz server listening on :${config.PORT}`
    );
    order.forEach((id) =>
      logger.info(`  set: ${id} (${sets[id].questions.length}) ${sets[id].name}`)
    );
    if (!config.SUPER_ADMIN_PASSWORD) {
      logger.warn(
        'SUPER_ADMIN_PASSWORD is not set — the super-admin panel is LOCKED. Set it to create admin accounts.'
      );
    } else if (admins.list().length === 0) {
      logger.warn(
        'No admin accounts yet — sign in at /admin.html as the super-admin and create one before anyone can host.'
      );
    }
  });
}

// Tests import this module for `app` and `manager` without wanting a listener.
if (require.main === module) {
  boot().catch((err) => {
    logger.error({ err: err.message }, 'failed to start');
    process.exit(1);
  });
}

// ---- Graceful shutdown ----
let shuttingDown = false;
function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info({ signal }, 'shutting down');
  io.close(() => {
    server.close(async () => {
      await redis.quit();
      logger.info('closed cleanly');
      process.exit(0);
    });
  });
  setTimeout(() => {
    logger.warn('forced exit');
    process.exit(1);
  }, 5000).unref();
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

module.exports = { app, manager, boot };
