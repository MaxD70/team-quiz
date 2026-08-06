'use strict';

const crypto = require('crypto');
const { shuffle } = require('./util');
const { pickTwoNames } = require('./teamNames');
const { cleanName, validAnswer } = require('./validation');

// Bounds for the host-configurable target score. Below 1 is meaningless; above
// 20 the match no longer fits a single session.
const WIN_SCORE_MIN = 1;
const WIN_SCORE_MAX = 20;

function clampWinScore(n) {
  const v = Number(n);
  if (!Number.isInteger(v)) return 3;
  return Math.min(WIN_SCORE_MAX, Math.max(WIN_SCORE_MIN, v));
}

// Encapsulates the whole game state machine.
// phases: 'login' | 'ready' | 'question' | 'reveal' | 'gameover'
// Pure of any transport concerns — the socket layer calls these methods and broadcasts.
class GameEngine {
  constructor({ sets, order, store, winScore, requiresPassword, maxPlayers, timerSeconds }) {
    this.sets = sets;
    this.order = order;
    this.store = store;
    this.winScore = clampWinScore(winScore);
    this.requiresPassword = !!requiresPassword;
    this.maxPlayers = maxPlayers || 200;
    this.timerSeconds = Number.isInteger(timerSeconds) ? timerSeconds : 60;
    this.defaultStack = order[0];
    this.tierCounts = {};
    for (const id of order) {
      const c = { medium: 0, hard: 0, pro: 0 };
      for (const q of sets[id].questions) c[q.difficulty || 'hard']++;
      this.tierCounts[id] = c;
    }
    this.game = this._fresh({});
  }

  _fresh(players) {
    const [n1, n2] = pickTwoNames();
    return {
      phase: 'login',
      stackId: this.defaultStack,
      teams: {
        A: { id: 'A', name: n1, score: 0 },
        B: { id: 'B', name: n2, score: 0 }
      },
      players: players || {}, // playerId -> { id, name, team, connected }
      current: null,
      votes: { A: null, B: null },
      lastReveal: null,
      winner: null,
      questionNumber: 0,
      history: [],
      deadline: null,
      currentSetId: null,
      endedByHost: false,
      difficulty: ['medium', 'hard', 'pro']
    };
  }

  get phase() {
    return this.game.phase;
  }

  playerCount() {
    return Object.keys(this.game.players).length;
  }

  connectedPlayers() {
    return Object.values(this.game.players).filter((p) => p.connected);
  }

  // ---- Players ----
  // `playerId` is the reclaim secret (client-generated, sent only on join —
  // never broadcast). `publicId` is a separate, server-generated identifier
  // that's safe to show to every client in the room: knowing it grants no
  // ability to take over that player's session, unlike `playerId`.
  join(playerId, name) {
    const g = this.game;
    const clean = cleanName(name);
    if (!g.players[playerId] && Object.keys(g.players).length >= this.maxPlayers) {
      return { ok: false, error: 'Session is full' };
    }
    const existing = g.players[playerId];
    if (existing) {
      existing.connected = true;
      existing.name = clean;
    } else {
      // Late joiners (after a draw) start unassigned; they get a team on next draw.
      g.players[playerId] = {
        id: playerId,
        publicId: crypto.randomBytes(9).toString('base64url'),
        name: clean,
        team: null,
        connected: true
      };
    }
    return { ok: true, name: clean, publicId: g.players[playerId].publicId };
  }

  setConnected(playerId, connected) {
    const p = this.game.players[playerId];
    if (!p) return false;
    p.connected = connected;
    return true;
  }

  // ---- Host controls ----
  drawTeams() {
    const g = this.game;
    if (g.phase !== 'login' && g.phase !== 'ready') return { ok: false };
    const ids = shuffle(this.connectedPlayers().map((p) => p.id));
    if (ids.length < 2) return { ok: false, error: 'Need at least 2 players to draw teams' };
    const half = Math.ceil(ids.length / 2);
    ids.forEach((id, i) => {
      g.players[id].team = i < half ? 'A' : 'B';
    });
    g.phase = 'ready';
    return { ok: true };
  }

  start() {
    const g = this.game;
    if (g.phase !== 'ready' && g.phase !== 'gameover') return { ok: false };
    const hasA = this.connectedPlayers().some((p) => p.team === 'A');
    const hasB = this.connectedPlayers().some((p) => p.team === 'B');
    if (!hasA || !hasB) return { ok: false, error: 'Draw teams first' };
    g.teams.A.score = 0;
    g.teams.B.score = 0;
    g.winner = null;
    g.questionNumber = 0;
    g.history = [];
    g.endedByHost = false;
    this._nextQuestion();
    return { ok: true };
  }

  next() {
    if (this.game.phase === 'gameover') return { ok: false };
    this._nextQuestion();
    return { ok: true };
  }

  _nextQuestion() {
    const g = this.game;
    const set = this.sets[g.stackId] || this.sets[this.defaultStack];
    // Difficulty filter; if the set has no questions in the chosen tiers, fall back to all.
    let pool = set.questions.filter((q) => g.difficulty.includes(q.difficulty || 'hard'));
    if (pool.length === 0) pool = set.questions;
    const used = this.store.getUsed(set.id);
    let unused = pool.filter((q) => !used.includes(q.id));
    if (unused.length === 0) {
      this.store.resetUsed(set.id);
      unused = pool.slice();
    }
    const q = unused[Math.floor(Math.random() * unused.length)];
    this.store.markUsed(set.id, q.id);
    g.current = q;
    g.currentSetId = set.id;
    g.votes = { A: null, B: null };
    g.lastReveal = null;
    g.phase = 'question';
    g.questionNumber++;
    g.deadline = this.timerSeconds > 0 ? Date.now() + this.timerSeconds * 1000 : null;
  }

  reveal() {
    const g = this.game;
    if (!g.current) return;
    const correct = g.current.correct;
    const results = { A: g.votes.A === correct, B: g.votes.B === correct };
    if (results.A) g.teams.A.score++;
    if (results.B) g.teams.B.score++;
    g.lastReveal = { correct, results };
    g.phase = 'reveal';
    g.deadline = null;
    const setName = (this.sets[g.currentSetId] || this.sets[this.defaultStack]).name;
    g.history.push({
      number: g.questionNumber,
      setName,
      topic: g.current.topic,
      text: g.current.text,
      difficulty: g.current.difficulty || 'hard',
      options: g.current.options,
      correct,
      explanation: g.current.explanation || '',
      votes: { A: g.votes.A, B: g.votes.B },
      results
    });

    const a = g.teams.A.score;
    const b = g.teams.B.score;
    if ((a >= this.winScore || b >= this.winScore) && a !== b) {
      g.phase = 'gameover';
      g.winner = a > b ? 'A' : 'B';
    }
  }

  hostReveal() {
    if (this.game.phase !== 'question') return false;
    this.reveal();
    return true;
  }

  // Host ends the match early. Leader wins; equal scores => declared tie (winner null).
  // A question in flight is discarded and does not score.
  endMatch() {
    const g = this.game;
    if (g.phase !== 'question' && g.phase !== 'reveal') return { ok: false };
    const a = g.teams.A.score;
    const b = g.teams.B.score;
    g.winner = a > b ? 'A' : b > a ? 'B' : null;
    g.endedByHost = true;
    g.deadline = null;
    g.phase = 'gameover';
    return { ok: true };
  }

  // Per-question timer in seconds; 0 disables. Applies from the next question.
  setTimer(seconds) {
    const n = Number(seconds);
    if (!Number.isInteger(n) || n < 0 || n > 600) return false;
    this.timerSeconds = n;
    return true;
  }

  // Host-configurable target score, per room. Only settable before the match is
  // under way: lowering it mid-match would hand out a retroactive win, and
  // raising it while a team sits one point from the line is just as unfair.
  setWinScore(score) {
    const n = Number(score);
    if (!Number.isInteger(n) || n < WIN_SCORE_MIN || n > WIN_SCORE_MAX) return false;
    const phase = this.game.phase;
    if (phase !== 'login' && phase !== 'ready') return false;
    this.winScore = n;
    return true;
  }

  // Called periodically by the transport layer; reveals when time is up.
  // Teams that have not voted simply score nothing (reveal treats null as wrong).
  checkTimeout(now = Date.now()) {
    const g = this.game;
    if (g.phase !== 'question' || !g.deadline || now < g.deadline) return false;
    this.reveal();
    return true;
  }

  vote(playerId, answer) {
    const g = this.game;
    const p = playerId && g.players[playerId];
    if (!p || !p.team) return false; // spectators / unassigned can't vote
    const team = p.team;
    if (g.phase !== 'question') return false;
    if (g.votes[team] !== null) return false; // team vote locks once cast
    if (!validAnswer(answer)) return false;
    g.votes[team] = answer;
    if (g.votes.A !== null && g.votes.B !== null) this.reveal();
    return true;
  }

  // New match: keep connected players, clear teams + scores, back to login.
  // Does NOT touch the persistent used-question history.
  resetMatch() {
    const g = this.game;
    Object.values(g.players).forEach((p) => {
      p.team = null;
    });
    g.teams.A.score = 0;
    g.teams.B.score = 0;
    g.current = null;
    g.votes = { A: null, B: null };
    g.lastReveal = null;
    g.winner = null;
    g.questionNumber = 0;
    g.history = [];
    g.deadline = null;
    g.currentSetId = null;
    g.endedByHost = false;
    g.phase = 'login';
  }

  resetHistory() {
    this.store.resetUsed(this.game.stackId);
  }

  // Allowed in any phase; mid-game it takes effect from the next question.
  setStack(id) {
    if (!this.sets[id]) return false;
    this.game.stackId = id;
    return true;
  }

  // tiers: non-empty array drawn from medium|hard|pro. Applies from the next question.
  setDifficulty(tiers) {
    const VALID = ['medium', 'hard', 'pro'];
    if (!Array.isArray(tiers)) return false;
    const norm = VALID.filter((t) => tiers.includes(t));
    if (norm.length === 0) return false;
    this.game.difficulty = norm;
    return true;
  }

  rerollNames() {
    if (this.game.phase === 'question') return false;
    const [n1, n2] = pickTwoNames();
    this.game.teams.A.name = n1;
    this.game.teams.B.name = n2;
    return true;
  }

  setName(team, name) {
    const g = this.game;
    if ((team === 'A' || team === 'B') && typeof name === 'string' && name.trim()) {
      g.teams[team].name = cleanName(name, g.teams[team].name);
      return true;
    }
    return false;
  }

  // ---- State view ----
  publicState(role) {
    const g = this.game;
    const players = this.connectedPlayers().map((p) => ({
      id: p.publicId,
      name: p.name,
      team: p.team
    }));
    const base = {
      phase: g.phase,
      teams: {
        A: { name: g.teams.A.name, score: g.teams.A.score },
        B: { name: g.teams.B.name, score: g.teams.B.score }
      },
      players,
      votes: { A: g.votes.A !== null, B: g.votes.B !== null },
      winner: g.winner,
      questionNumber: g.questionNumber,
      winScore: this.winScore,
      requiresPassword: this.requiresPassword,
      stackId: g.stackId,
      stacks: this.order.map((id) => ({
        id,
        name: this.sets[id].name,
        description: this.sets[id].description,
        total: this.sets[id].questions.length,
        used: this.store.getUsed(id).length,
        tiers: this.tierCounts[id]
      })),
      difficulty: g.difficulty.slice(),
      usedCount: this.store.getUsed(g.stackId).length,
      totalQuestions: (this.sets[g.stackId] || this.sets[this.defaultStack]).questions.length,
      deadline: g.deadline,
      timerSeconds: this.timerSeconds,
      currentSetId: g.currentSetId,
      endedByHost: g.endedByHost
    };
    if (g.phase === 'gameover') base.history = g.history;
    if (g.current) {
      base.current = {
        topic: g.current.topic,
        text: g.current.text,
        options: g.current.options,
        difficulty: g.current.difficulty || 'hard'
      };
      if (role === 'host' || g.phase === 'reveal' || g.phase === 'gameover') {
        base.current.correct = g.current.correct;
        base.current.explanation = g.current.explanation;
      }
    }
    if (g.phase === 'reveal' || g.phase === 'gameover') {
      base.lastReveal = g.lastReveal;
      base.teamVotes = { A: g.votes.A, B: g.votes.B };
    }
    return base;
  }
}

module.exports = { GameEngine, WIN_SCORE_MIN, WIN_SCORE_MAX };
