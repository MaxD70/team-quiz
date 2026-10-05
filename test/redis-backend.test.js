'use strict';

// Shared-state backends against a REAL Redis.
//
// These tests are SKIPPED unless REDIS_TEST_URL is set, so `npm test` still
// passes on a laptop or in CI with no Redis running. To run them:
//
//   redis-server --daemonize yes --port 6379
//   REDIS_TEST_URL=redis://127.0.0.1:6379 npm test
//
// What matters here is the property that makes multi-replica correct: a write
// on one "replica" (module instance) becomes visible to another, and concurrent
// writes merge instead of clobbering each other.

const test = require('node:test');
const assert = require('node:assert');
const path = require('path');

const URL = process.env.REDIS_TEST_URL || '';
const skip = URL ? false : 'set REDIS_TEST_URL to run the Redis backend tests';

// Each backend module reads REDIS_URL at require() time, so we set it and load
// fresh module instances — two of them stand in for two replicas.
function freshModules(prefix) {
  for (const k of Object.keys(require.cache)) {
    if (k.includes(path.sep + 'src' + path.sep) || k.endsWith(path.sep + 'store.js')) {
      delete require.cache[k];
    }
  }
  process.env.REDIS_URL = URL;
  process.env.ADMINS_FILE = '/tmp/team-quiz-test-' + prefix + '/admins.json';
  process.env.DATA_FILE = '/tmp/team-quiz-test-' + prefix + '/state.json';
  return {
    store: require('../store'),
    admins: require('../src/admins'),
    redis: require('../src/redis')
  };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test('redis backend: shared state across replicas', { skip }, async (t) => {
  const Redis = require('ioredis');
  const raw = new Redis(URL);
  await raw.del('quiz:admins');
  const keys = await raw.keys('quiz:used:*');
  if (keys.length) await raw.del(...keys);

  const A = freshModules('a');
  await A.store.init();
  await A.admins.init();

  const B = freshModules('b');
  await B.store.init();
  await B.admins.init();

  t.after(async () => {
    await A.redis.quit();
    await B.redis.quit();
    raw.disconnect();
    delete process.env.REDIS_URL;
  });

  await t.test('an admin created on replica A can log in on replica B', async () => {
    assert.equal(A.admins.create('alice', 'password123', 'super').ok, true);
    await sleep(250); // pub/sub propagation
    assert.equal(B.admins.verify('alice', 'password123'), true, 'B must accept the password');
    assert.equal(B.admins.verify('alice', 'wrong-password'), false);
    assert.ok(
      B.admins.list().some((a) => a.username === 'alice'),
      'B must list the admin'
    );
  });

  await t.test('removing an admin on B revokes them on A', async () => {
    assert.equal(B.admins.remove('alice').ok, true);
    await sleep(250);
    assert.equal(A.admins.verify('alice', 'password123'), false, 'A must no longer accept them');
  });

  await t.test('a password reset on A takes effect on B', async () => {
    A.admins.create('bob', 'password123', 'super');
    await sleep(250);
    assert.equal(B.admins.verify('bob', 'password123'), true);
    A.admins.setPassword('bob', 'newpassword456');
    await sleep(250);
    assert.equal(B.admins.verify('bob', 'newpassword456'), true, 'B must accept the new password');
    assert.equal(B.admins.verify('bob', 'password123'), false, 'B must reject the old one');
  });

  await t.test('used questions written on A are visible on B', async () => {
    A.store.markUsed('linux-cli', 'q001');
    await sleep(250);
    assert.deepEqual(B.store.getUsed('linux-cli'), ['q001']);
  });

  await t.test('concurrent writes MERGE — no replica clobbers the other', async () => {
    // The whole point of using SADD instead of read-modify-write: both survive.
    A.store.markUsed('git-workflow', 'q010');
    B.store.markUsed('git-workflow', 'q020');
    await sleep(400);
    const onA = A.store.getUsed('git-workflow').sort();
    const onB = B.store.getUsed('git-workflow').sort();
    assert.deepEqual(onA, ['q010', 'q020'], 'A must see both writes');
    assert.deepEqual(onB, ['q010', 'q020'], 'B must see both writes');
  });

  await t.test('resetUsed on A clears the set for B too', async () => {
    A.store.resetUsed('git-workflow');
    await sleep(250);
    assert.deepEqual(B.store.getUsed('git-workflow'), []);
  });
});
