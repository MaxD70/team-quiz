'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const { loadSets } = require('../src/questions');
const { GameEngine } = require('../src/game');

const QUESTIONS_DIR = path.join(__dirname, '..', 'questions');

// In-memory store implementing the same interface as store.js.
function fakeStore() {
  const m = {};
  return {
    getUsed: (id) => m[id] || [],
    markUsed: (id, q) => {
      (m[id] = m[id] || []).push(q);
    },
    resetUsed: (id) => {
      m[id] = [];
    },
    filePath: () => ':memory:'
  };
}

function newEngine(store = fakeStore()) {
  const { sets, order } = loadSets(QUESTIONS_DIR);
  return new GameEngine({
    sets,
    order,
    store,
    winScore: 3,
    requiresPassword: false,
    maxPlayers: 200
  });
}

function startTwoPlayerMatch(e) {
  e.join('a', 'Alice');
  e.join('b', 'Bob');
  assert.ok(e.drawTeams().ok);
  assert.ok(e.start().ok);
  return { teamA: e.game.players.a.team, teamB: e.game.players.b.team };
}

describe('GameEngine (unit)', () => {
  test('setWinScore: accepts a valid target before the match starts', () => {
    const e = newEngine();
    assert.strictEqual(e.phase, 'login');
    assert.strictEqual(e.setWinScore(7), true);
    assert.strictEqual(e.winScore, 7);
    assert.strictEqual(e.publicState('host').winScore, 7);

    // still editable in 'ready' (teams drawn, match not started)
    e.join('a', 'Alice');
    e.join('b', 'Bob');
    assert.ok(e.drawTeams().ok);
    assert.strictEqual(e.phase, 'ready');
    assert.strictEqual(e.setWinScore(2), true);
    assert.strictEqual(e.winScore, 2);
  });

  test('setWinScore: rejects out-of-range and non-integer values', () => {
    const e = newEngine();
    for (const bad of [0, -1, 21, 2.5, 'x', null, undefined, NaN]) {
      assert.strictEqual(e.setWinScore(bad), false, 'should reject ' + String(bad));
    }
    assert.strictEqual(e.winScore, 3);
  });

  test('setWinScore: refused once the match is under way', () => {
    const e = newEngine();
    startTwoPlayerMatch(e);
    assert.strictEqual(e.phase, 'question');
    assert.strictEqual(e.setWinScore(1), false);
    assert.strictEqual(e.winScore, 3);

    // and editable again after a new match resets to 'login'
    e.resetMatch();
    assert.strictEqual(e.setWinScore(5), true);
    assert.strictEqual(e.winScore, 5);
  });

  test('a custom target score actually decides the match', () => {
    const e = newEngine();
    assert.strictEqual(e.setWinScore(1), true);
    const { teamA } = startTwoPlayerMatch(e);
    const c = e.game.current.correct;
    e.vote('a', c);
    e.vote('b', (c + 1) % 4);
    assert.strictEqual(e.game.teams[teamA].score, 1);
    assert.strictEqual(e.phase, 'gameover');
    assert.strictEqual(e.game.winner, teamA);
  });

  test('constructor clamps an out-of-range WIN_SCORE from the environment', () => {
    const { sets, order } = loadSets(QUESTIONS_DIR);
    const mk = (winScore) =>
      new GameEngine({ sets, order, store: fakeStore(), winScore, requiresPassword: false });
    assert.strictEqual(mk(0).winScore, 1);
    assert.strictEqual(mk(999).winScore, 20);
    assert.strictEqual(mk(NaN).winScore, 3);
  });

  test('scoring: correct answer scores, wrong does not', () => {
    const e = newEngine();
    const { teamA, teamB } = startTwoPlayerMatch(e);
    const c = e.game.current.correct;
    e.vote('a', c); // Alice correct
    e.vote('b', (c + 1) % 4); // Bob wrong
    assert.strictEqual(e.game.teams[teamA].score, 1);
    assert.strictEqual(e.game.teams[teamB].score, 0);
    assert.strictEqual(e.phase, 'reveal');
  });

  test('win requires reaching the score AND being ahead (ties continue)', () => {
    const e = newEngine();
    const { teamA, teamB } = startTwoPlayerMatch(e);
    // 3 rounds both correct -> 3-3, must NOT end
    for (let i = 0; i < 3; i++) {
      const c = e.game.current.correct;
      e.vote('a', c);
      e.vote('b', c);
      assert.strictEqual(e.phase, 'reveal', 'a tie at threshold keeps playing');
      e.next();
    }
    assert.strictEqual(e.game.teams[teamA].score, 3);
    assert.strictEqual(e.game.teams[teamB].score, 3);
    assert.strictEqual(e.game.winner, null);
    // now break the tie
    const c = e.game.current.correct;
    e.vote('a', c);
    e.vote('b', (c + 1) % 4);
    assert.strictEqual(e.phase, 'gameover');
    assert.strictEqual(e.game.winner, teamA);
    assert.strictEqual(e.next().ok, false, 'no next after gameover');
  });

  test('vote locks per team and ignores invalid answers', () => {
    const e = newEngine();
    const { teamA } = startTwoPlayerMatch(e);
    const c = e.game.current.correct;
    assert.strictEqual(e.vote('a', c), true);
    assert.strictEqual(e.vote('a', (c + 1) % 4), false, 'second vote ignored');
    assert.strictEqual(e.game.votes[teamA], c);
    // invalid answers rejected
    assert.strictEqual(e.vote('b', 9), false);
    assert.strictEqual(e.vote('b', 'x'), false);
  });

  test('no-repeat within a set, then history resets when exhausted', () => {
    const e = newEngine();
    e.setStack('ai-foundations');
    startTwoPlayerMatch(e);
    const total = e.sets['ai-foundations'].questions.length;
    const seen = new Set([e.game.current.id]);
    for (let i = 1; i < total; i++) {
      e.next();
      seen.add(e.game.current.id);
    }
    assert.strictEqual(seen.size, total, 'a full pass shows every question once');
    e.next(); // pool exhausted -> reset -> a previously seen id reappears
    assert.ok(seen.has(e.game.current.id));
  });

  test('setStack rejects unknown ids; since v1.1.0 switching mid-question is allowed', () => {
    const e = newEngine();
    assert.strictEqual(e.setStack('does-not-exist'), false);
    assert.strictEqual(e.setStack('ai-foundations'), true);
    startTwoPlayerMatch(e);
    assert.strictEqual(
      e.setStack('git-workflow'),
      true,
      'switch allowed; applies from next question'
    );
    assert.strictEqual(e.setStack('nope'), false, 'unknown ids still rejected mid-game');
  });

  test('publicState hides the answer from players until reveal', () => {
    const e = newEngine();
    startTwoPlayerMatch(e);
    const player = e.publicState('player');
    const host = e.publicState('host');
    assert.strictEqual(player.current.correct, undefined);
    assert.strictEqual(player.current.explanation, undefined);
    assert.strictEqual(typeof host.current.correct, 'number');
    assert.strictEqual(typeof host.current.explanation, 'string');
  });

  test('drawTeams needs at least two players', () => {
    const e = newEngine();
    e.join('solo', 'Solo');
    const r = e.drawTeams();
    assert.strictEqual(r.ok, false);
    assert.match(r.error, /at least 2/);
  });
});

describe('GameEngine v1.1.0 — end match, recap history, set switching, timer', () => {
  test('endMatch: leader wins with current score', () => {
    const e = newEngine();
    const { teamA } = startTwoPlayerMatch(e);
    const c = e.game.current.correct;
    e.vote('a', c);
    e.vote('b', (c + 1) % 4); // 1-0
    e.next();
    const r = e.endMatch();
    assert.ok(r.ok);
    assert.strictEqual(e.phase, 'gameover');
    assert.strictEqual(e.game.winner, teamA);
    assert.ok(e.game.endedByHost);
  });

  test('endMatch on equal scores declares a tie (winner null)', () => {
    const e = newEngine();
    startTwoPlayerMatch(e);
    const r = e.endMatch(); // 0-0, question in flight discarded
    assert.ok(r.ok);
    assert.strictEqual(e.phase, 'gameover');
    assert.strictEqual(e.game.winner, null);
    assert.ok(e.game.endedByHost);
  });

  test('endMatch is rejected outside question/reveal', () => {
    const e = newEngine();
    assert.strictEqual(e.endMatch().ok, false); // login phase
  });

  test('history records every revealed round with votes, results and explanation', () => {
    const e = newEngine();
    startTwoPlayerMatch(e);
    for (let i = 0; i < 2; i++) {
      const c = e.game.current.correct;
      e.vote('a', c);
      e.vote('b', (c + 1) % 4);
      if (i === 0) e.next();
    }
    assert.strictEqual(e.game.history.length, 2);
    const h = e.game.history[0];
    assert.ok(typeof h.correct === 'number');
    assert.ok(Array.isArray(h.options) && h.options.length === 4);
    assert.ok('A' in h.votes && 'B' in h.votes);
    assert.ok('A' in h.results && 'B' in h.results);
    assert.ok(typeof h.explanation === 'string');
    assert.ok(h.setName.length > 0);
    // history is exposed only at gameover
    assert.strictEqual(e.publicState('player').history, undefined);
    e.endMatch();
    assert.strictEqual(e.publicState('player').history.length, 2);
  });

  test('start() and resetMatch() clear the previous history', () => {
    const e = newEngine();
    startTwoPlayerMatch(e);
    const c = e.game.current.correct;
    e.vote('a', c);
    e.vote('b', c);
    assert.strictEqual(e.game.history.length, 1);
    e.resetMatch();
    assert.strictEqual(e.game.history.length, 0);
  });

  test('setStack mid-question: current question unaffected, next question from new set', () => {
    const e = newEngine();
    startTwoPlayerMatch(e);
    const firstSet = e.game.currentSetId;
    const other = e.order.find((id) => id !== firstSet);
    assert.ok(e.setStack(other), 'switch allowed during a question');
    assert.strictEqual(e.game.currentSetId, firstSet, 'current question keeps its set');
    const c = e.game.current.correct;
    e.vote('a', c);
    e.vote('b', c);
    e.next();
    assert.strictEqual(e.game.currentSetId, other, 'next question drawn from the new set');
  });

  test('timer: deadline armed on question, cleared on reveal', () => {
    const e = newEngine();
    e.setTimer(60);
    startTwoPlayerMatch(e);
    assert.ok(e.game.deadline > Date.now());
    const c = e.game.current.correct;
    e.vote('a', c);
    e.vote('b', c);
    assert.strictEqual(e.game.deadline, null);
  });

  test('timer expiry reveals; teams without a vote score nothing', () => {
    const e = newEngine();
    e.setTimer(60);
    const { teamA } = startTwoPlayerMatch(e);
    const c = e.game.current.correct;
    e.vote('a', c); // only one team votes
    assert.strictEqual(e.checkTimeout(Date.now()), false, 'not yet expired');
    assert.strictEqual(e.checkTimeout(e.game.deadline + 1), true, 'expired -> reveal');
    assert.strictEqual(e.phase, 'reveal');
    assert.strictEqual(e.game.teams[teamA].score, 1);
    const other = teamA === 'A' ? 'B' : 'A';
    assert.strictEqual(e.game.teams[other].score, 0);
    assert.strictEqual(e.game.history[0].votes[other], null);
  });

  test('setTimer validates input; 0 disables the deadline', () => {
    const e = newEngine();
    assert.strictEqual(e.setTimer(-5), false);
    assert.strictEqual(e.setTimer(1000), false);
    assert.strictEqual(e.setTimer('abc'), false);
    assert.ok(e.setTimer(0));
    startTwoPlayerMatch(e);
    assert.strictEqual(e.game.deadline, null);
  });
});

describe('GameEngine v1.2.0 — difficulty tiers', () => {
  test('loader normalises difficulty; every question has a valid tier', () => {
    const { sets } = loadSets(QUESTIONS_DIR);
    const VALID = ['medium', 'hard', 'pro'];
    for (const id of Object.keys(sets)) {
      for (const q of sets[id].questions) {
        assert.ok(VALID.includes(q.difficulty), id + '/' + q.id);
      }
    }
  });

  test('setDifficulty validates input', () => {
    const e = newEngine();
    assert.strictEqual(e.setDifficulty([]), false);
    assert.strictEqual(e.setDifficulty('medium'), false);
    assert.strictEqual(e.setDifficulty(['nope']), false);
    assert.ok(e.setDifficulty(['medium', 'pro']));
    assert.deepStrictEqual(e.game.difficulty, ['medium', 'pro']);
  });

  test('filter serves only questions from the chosen tiers', () => {
    const e = newEngine();
    e.setStack('ai-foundations');
    e.setDifficulty(['medium']);
    startTwoPlayerMatch(e);
    for (let i = 0; i < 5; i++) {
      assert.strictEqual(e.game.current.difficulty, 'medium');
      const c = e.game.current.correct;
      e.vote('a', c);
      e.vote('b', (c + 1) % 4);
      if (e.phase === 'gameover') break;
      e.next();
    }
  });

  test('falls back to the whole set when no question matches the tiers', () => {
    const e = newEngine();
    e.setStack('zen-nightmare'); // all pro
    e.setDifficulty(['medium']);
    startTwoPlayerMatch(e);
    assert.ok(e.game.current, 'a question is still served');
    assert.strictEqual(e.game.current.difficulty, 'pro');
  });

  test('publicState exposes tiers, per-set counts and question difficulty', () => {
    const e = newEngine();
    startTwoPlayerMatch(e);
    const st = e.publicState('player');
    assert.ok(Array.isArray(st.difficulty));
    const stack = st.stacks.find((x) => x.id === st.stackId);
    assert.ok(stack.tiers && typeof stack.tiers.medium === 'number');
    assert.ok(['medium', 'hard', 'pro'].includes(st.current.difficulty));
  });

  test('history entries carry the question difficulty', () => {
    const e = newEngine();
    startTwoPlayerMatch(e);
    const c = e.game.current.correct;
    e.vote('a', c);
    e.vote('b', c);
    assert.ok(['medium', 'hard', 'pro'].includes(e.game.history[0].difficulty));
  });
});

describe('GameEngine v1.9.0 — player identity (publicId vs reclaim secret)', () => {
  test('join() returns a publicId distinct from the reclaim secret', () => {
    const e = newEngine();
    const res = e.join('alice-secret', 'Alice');
    assert.ok(res.ok);
    assert.ok(typeof res.publicId === 'string' && res.publicId.length > 0);
    assert.notStrictEqual(res.publicId, 'alice-secret');
  });

  test('publicState never exposes the reclaim secret, only the publicId', () => {
    const e = newEngine();
    const res = e.join('alice-secret', 'Alice');
    const st = e.publicState('player');
    const me = st.players.find((p) => p.name === 'Alice');
    assert.strictEqual(me.id, res.publicId);
    assert.notStrictEqual(me.id, 'alice-secret');
    // the raw secret must not appear anywhere in the serialized broadcast
    assert.ok(!JSON.stringify(st).includes('alice-secret'));
  });

  test('knowing a publicId does not let another client take over that identity', () => {
    const e = newEngine();
    const alice = e.join('alice-secret', 'Alice');
    // an attacker who only saw Alice's publicId (from the broadcast) cannot
    // reclaim her slot by using it as a join playerId — it just becomes a
    // brand new, unrelated player.
    const attacker = e.join(alice.publicId, 'Mallory');
    assert.notStrictEqual(attacker.publicId, alice.publicId);
    const st = e.publicState('player');
    assert.strictEqual(st.players.find((p) => p.name === 'Alice').team, null);
    assert.ok(st.players.some((p) => p.name === 'Mallory'));
    assert.strictEqual(st.players.length, 2, 'Alice and the attacker are two separate players');
  });

  test('reconnecting with the real secret preserves the same publicId', () => {
    const e = newEngine();
    const first = e.join('alice-secret', 'Alice');
    const second = e.join('alice-secret', 'Alice again');
    assert.strictEqual(second.publicId, first.publicId);
  });
});

describe('loadSets (v1.10.0) — dotfile immunity', () => {
  test('AppleDouble junk ("._*.json") next to real sets is ignored, not parsed', () => {
    const fs = require('node:fs');
    const os = require('node:os');
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'quiz-sets-'));
    fs.writeFileSync(
      path.join(tmp, 'real.json'),
      JSON.stringify({
        id: 'real',
        name: 'Real set',
        questions: [{ id: 'q1', topic: 't', text: 'x?', options: ['a', 'b', 'c', 'd'], correct: 0 }]
      })
    );
    // Binary-ish garbage the way macOS scp leaves it — invalid JSON on purpose.
    fs.writeFileSync(
      path.join(tmp, '._real.json'),
      Buffer.from([0x00, 0x05, 0x16, 0x07, 0x4d, 0x61])
    );
    const { sets, order } = loadSets(tmp);
    assert.deepStrictEqual(order, ['real']);
    assert.ok(sets.real);
  });
});
