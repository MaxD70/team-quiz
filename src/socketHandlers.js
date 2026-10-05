'use strict';

const config = require('./config');
const logger = require('./logger');
const admins = require('./admins');
const sessions = require('./sessions');
const loginThrottle = require('./loginThrottle');
const { clientIp } = require('./util');

// Wire Socket.IO events to per-room game engines (Tappa B: named admins + super-admin).
//
// Principals:
//   super  — env-based; manages admin accounts and sees all rooms. Holds no game.
//   admin  — persistent account (admins.json); hosts exactly one room at a time.
//   player — no account; joins a room by 4-digit code.
//
// Broadcasts are scoped to `${code}:hosts` and `${code}:players`.
function registerSocketHandlers(io, manager) {
  function broadcastRoom(code) {
    const room = manager.get(code);
    if (!room) return;
    manager.touch(code);
    io.to(`${code}:hosts`).emit('state', room.engine.publicState('host'));
    io.to(`${code}:players`).emit('state', room.engine.publicState('player'));
  }

  function superSnapshot() {
    return {
      admins: admins.list().map((a) => {
        const r = manager.findByAdmin(a.username);
        return { ...a, activeRoom: r ? r.code : null };
      }),
      rooms: manager.list()
    };
  }

  // Shared by admin:login and admin:resume: resolve (or open) the admin's
  // room and put the socket into the 'admin' role.
  function openAdminSession(socket, username, token) {
    let found = manager.findByAdmin(username);
    if (!found) {
      const created = manager.create(username);
      if (!created) {
        socket.emit('adminAuthError', { reason: 'Server is at capacity, try again shortly' });
        return;
      }
      found = { code: created.code, room: created.room };
    }
    socket.data.role = 'admin';
    socket.data.admin = username;
    socket.data.code = found.code;
    socket.data.sessionToken = token;
    socket.join(`${found.code}:hosts`);
    socket.emit('adminAuthOk', { code: found.code, username, token });
    socket.emit('state', found.room.engine.publicState('host'));
  }

  io.on('connection', (socket) => {
    socket.data.role = null; // 'super' | 'admin' | 'player'
    socket.data.code = null;
    socket.data.admin = null;
    socket.data.sessionToken = null;

    // Per-socket rate limiting: drop bursts, disconnect flooders.
    socket.use((packet, next) => {
      const now = Date.now();
      const rl = socket._rl || (socket._rl = { start: now, count: 0 });
      if (now - rl.start > config.RL_WINDOW_MS) {
        rl.start = now;
        rl.count = 0;
      }
      rl.count++;
      if (rl.count > config.RL_DISCONNECT_AT) {
        logger.warn({ id: socket.id }, 'socket flooding — disconnecting');
        socket.disconnect(true);
        return;
      }
      if (rl.count > config.RL_MAX_EVENTS) return;
      next();
    });

    // Run fn(engine) only if this socket is an admin who OWNS its room, then broadcast.
    const asAdmin = (fn) => {
      if (socket.data.role !== 'admin') return;
      const room = socket.data.code && manager.get(socket.data.code);
      if (!room || room.hostAdmin !== socket.data.admin) {
        socket.emit('roomClosed');
        return;
      }
      const changed = fn(room.engine);
      if (changed !== false) broadcastRoom(socket.data.code);
    };

    const asSuper = (fn) => {
      if (socket.data.role !== 'super') return;
      fn();
      socket.emit('superState', superSnapshot());
    };

    // ================= SUPER-ADMIN =================
    socket.on('super:login', ({ username, password } = {}) => {
      const ip = clientIp(socket, config.TRUST_PROXY);
      if (loginThrottle.isBlocked(ip)) {
        logger.warn({ id: socket.id, ip }, 'super-admin login throttled');
        socket.emit('superAuthError', { reason: 'Too many attempts. Try again later.' });
        return;
      }
      if (
        !admins.verifySuper(
          username,
          password,
          config.SUPER_ADMIN_USER,
          config.SUPER_ADMIN_PASSWORD
        )
      ) {
        loginThrottle.recordFailure(ip);
        logger.warn({ id: socket.id }, 'super-admin auth failed');
        socket.emit('superAuthError', { reason: 'Wrong super-admin credentials' });
        return;
      }
      loginThrottle.recordSuccess(ip);
      const token = sessions.issue('super');
      socket.data.role = 'super';
      socket.data.sessionToken = token;
      socket.emit('superAuthOk', { token });
      socket.emit('superState', superSnapshot());
    });

    // Resume a super-admin session from a previously issued token — no
    // password involved, so the client never needs to keep one around.
    socket.on('super:resume', ({ token } = {}) => {
      const s = sessions.verify(token);
      if (!s || s.role !== 'super') {
        socket.emit('superAuthError', { reason: 'Session expired, please sign in again' });
        return;
      }
      socket.data.role = 'super';
      socket.data.sessionToken = token;
      socket.emit('superAuthOk', { token });
      socket.emit('superState', superSnapshot());
    });

    socket.on('super:logout', () => {
      if (socket.data.sessionToken) sessions.revoke(socket.data.sessionToken);
      socket.data.role = null;
      socket.data.sessionToken = null;
    });

    socket.on('super:createAdmin', ({ username, password } = {}) =>
      asSuper(() => {
        const r = admins.create(username, password, 'super');
        if (!r.ok) socket.emit('superError', { reason: r.error });
        else logger.info({ username }, 'admin created');
      })
    );

    socket.on('super:removeAdmin', ({ username } = {}) =>
      asSuper(() => {
        const code = manager.removeByAdmin(username); // close their room, if any
        if (code) io.to(`${code}:players`).emit('roomClosed');
        const r = admins.remove(username);
        if (!r.ok) socket.emit('superError', { reason: r.error });
        else logger.info({ username, closedRoom: code || null }, 'admin removed');
      })
    );

    socket.on('super:resetPassword', ({ username, password } = {}) =>
      asSuper(() => {
        const r = admins.setPassword(username, password);
        if (!r.ok) socket.emit('superError', { reason: r.error });
        else logger.info({ username }, 'admin password reset by super');
      })
    );

    socket.on('super:refresh', () => asSuper(() => {}));

    // ================= ADMIN (host) =================
    // Login resolves the admin's room: resume the existing one, or open a new one.
    socket.on('admin:login', ({ username, password } = {}) => {
      const ip = clientIp(socket, config.TRUST_PROXY);
      if (loginThrottle.isBlocked(ip)) {
        logger.warn({ id: socket.id, ip }, 'admin login throttled');
        socket.emit('adminAuthError', { reason: 'Too many attempts. Try again later.' });
        return;
      }
      if (!admins.verify(username, password)) {
        loginThrottle.recordFailure(ip);
        logger.warn({ id: socket.id }, 'admin auth failed');
        socket.emit('adminAuthError', { reason: 'Wrong username or password' });
        return;
      }
      loginThrottle.recordSuccess(ip);
      openAdminSession(socket, username, sessions.issue('admin', username));
    });

    // Resume an admin session from a previously issued token — no password
    // resend on reconnect.
    socket.on('admin:resume', ({ token } = {}) => {
      const s = sessions.verify(token);
      if (!s || s.role !== 'admin') {
        socket.emit('adminAuthError', { reason: 'Session expired, please sign in again' });
        return;
      }
      openAdminSession(socket, s.username, token);
    });

    socket.on('admin:logout', () => {
      if (socket.data.sessionToken) sessions.revoke(socket.data.sessionToken);
      socket.data.role = null;
      socket.data.admin = null;
      socket.data.sessionToken = null;
    });

    socket.on('admin:changePassword', ({ current, next } = {}) => {
      if (socket.data.role !== 'admin') return;
      const r = admins.changePassword(socket.data.admin, current, next);
      if (r.ok) {
        logger.info({ username: socket.data.admin }, 'admin changed own password');
        // Force every other signed-in session (other tab/device) to log in
        // again with the new password, then issue this socket a fresh token.
        sessions.revokeAllForAdmin(socket.data.admin);
        const token = sessions.issue('admin', socket.data.admin);
        socket.data.sessionToken = token;
        socket.emit('passwordChanged', { token });
      } else {
        socket.emit('hostError', { reason: r.error });
      }
    });

    // ---- Game controls (admin, room-owned) ----
    socket.on('host:drawTeams', () =>
      asAdmin((e) => {
        const r = e.drawTeams();
        if (!r.ok && r.error) socket.emit('hostError', { reason: r.error });
        return r.ok;
      })
    );
    socket.on('host:start', () =>
      asAdmin((e) => {
        const r = e.start();
        if (!r.ok && r.error) socket.emit('hostError', { reason: r.error });
        return r.ok;
      })
    );
    socket.on('host:next', () => asAdmin((e) => e.next().ok));
    socket.on('host:reveal', () => asAdmin((e) => e.hostReveal()));
    socket.on('host:reset', () => asAdmin((e) => (e.resetMatch(), true)));
    socket.on('host:resetHistory', () => asAdmin((e) => (e.resetHistory(), true)));
    socket.on('host:setStack', ({ stackId } = {}) => asAdmin((e) => e.setStack(stackId)));
    socket.on('host:endMatch', () => asAdmin((e) => e.endMatch().ok));
    socket.on('host:setTimer', ({ seconds } = {}) => asAdmin((e) => e.setTimer(seconds)));
    socket.on('host:setWinScore', ({ score } = {}) =>
      asAdmin((e) => {
        if (e.setWinScore(score)) return true;
        socket.emit('hostError', {
          reason:
            'Target score must be a whole number 1-20, and can only be changed before the match starts.'
        });
        return false;
      })
    );
    socket.on('host:setDifficulty', ({ tiers } = {}) => asAdmin((e) => e.setDifficulty(tiers)));
    socket.on('host:rerollNames', () => asAdmin((e) => e.rerollNames()));
    socket.on('host:setName', ({ team, name } = {}) => asAdmin((e) => e.setName(team, name)));

    socket.on('host:closeRoom', () => {
      if (socket.data.role !== 'admin' || !socket.data.code) return;
      const room = manager.get(socket.data.code);
      if (!room || room.hostAdmin !== socket.data.admin) return;
      const code = socket.data.code;
      io.to(`${code}:players`).emit('roomClosed');
      manager.remove(code);
    });

    // ================= PLAYER =================
    socket.on('player:join', ({ playerId, name, password, code } = {}) => {
      if (config.SHARED_PASSWORD && password !== config.SHARED_PASSWORD) {
        socket.emit('joinError', { reason: 'Wrong password' });
        return;
      }
      if (!playerId || typeof playerId !== 'string' || playerId.length > 100) {
        socket.emit('joinError', { reason: 'Missing or invalid player id' });
        return;
      }
      const c = String(code || '').trim();
      const room = manager.get(c);
      if (!room) {
        socket.emit('joinError', { reason: 'No game with that code', badCode: true });
        return;
      }
      const res = room.engine.join(playerId, name);
      if (!res.ok) {
        socket.emit('joinError', { reason: res.error });
        return;
      }
      socket.data.role = 'player';
      socket.data.code = c;
      socket.data.playerId = playerId;
      socket.join(`${c}:players`);
      socket.emit('joined', { playerId, publicId: res.publicId, name: res.name, code: c });
      socket.emit('state', room.engine.publicState('player'));
      broadcastRoom(c);
    });

    socket.on('team:vote', ({ answer } = {}) => {
      if (socket.data.role !== 'player') return;
      const room = socket.data.code && manager.get(socket.data.code);
      if (room && room.engine.vote(socket.data.playerId, answer)) broadcastRoom(socket.data.code);
    });

    // ================= SPECTATOR (read-only big screen) =================
    // Joins the room's player broadcast group but never enters the game:
    // not in the roster, cannot vote, and sees the player view of the state
    // (so the correct answer stays hidden until reveal, same as players).
    socket.on('spectator:join', ({ code, password } = {}) => {
      if (config.SHARED_PASSWORD && password !== config.SHARED_PASSWORD) {
        socket.emit('spectateError', { reason: 'Wrong password' });
        return;
      }
      const c = String(code || '').trim();
      const room = manager.get(c);
      if (!room) {
        socket.emit('spectateError', { reason: 'No game with that code', badCode: true });
        return;
      }
      socket.data.role = 'spectator';
      socket.data.code = c;
      socket.join(`${c}:players`);
      socket.emit('spectating', { code: c });
      socket.emit('state', room.engine.publicState('player'));
    });

    socket.on('disconnect', () => {
      const { code, playerId } = socket.data;
      if (!code || !playerId) return;
      const room = manager.get(code);
      if (room && room.engine.setConnected(playerId, false)) broadcastRoom(code);
    });
  });

  // Per-room question timer: reveal automatically when a deadline passes.
  const ticker = setInterval(() => {
    for (const { code } of manager.list()) {
      const room = manager.get(code);
      if (room && room.engine.checkTimeout()) broadcastRoom(code);
    }
  }, 500);
  if (ticker.unref) ticker.unref();

  // Idle-room sweeper.
  const sweeper = setInterval(() => manager.sweep(), 60 * 1000);
  if (sweeper.unref) sweeper.unref();

  return { broadcastRoom };
}

module.exports = { registerSocketHandlers };
