'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { once } = require('node:events');
const { get } = require('node:http');
const { openDatabase } = require('../db');
const { GameService } = require('../game_service');
const { makeApp } = require('../server');
const { createHarness, LEVEL, ANSWER } = require('./helpers/frontend-harness');

function fixture(t) {
  const db = openDatabase(':memory:');
  let app, server;
  t.after(async () => {
    try {
      if (server?.listening) await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    } finally {
      try { await app?.locals.close(); } finally { db.close(); }
    }
  });
  const insertLevel = db.prepare(`INSERT INTO levels
    (id,size,region_map,solution,map_hash,seed,search_nodes,generation_attempts,created_at)
    VALUES(?,4,?,?,?,1,1,1,1)`);
  for (const id of [1, 2, 3]) insertLevel.run(id, JSON.stringify(LEVEL.regions), JSON.stringify(ANSWER), `fixture-${id}`);

  const insertUser = db.prepare(`INSERT INTO users
    (id,auth_provider,open_id,username,avatar_url,created_at,updated_at) VALUES(?,?,?,?,?,1,1)`);
  insertUser.run(1, 'guest', 'guest-fixture-id', 'guestcat', '');
  insertUser.run(2, 'github', 'github-fixture-id', 'samecat', '/avatar.png');
  insertUser.run(3, 'password', 'password-fixture-id', 'samecat', '');
  insertUser.run(4, 'wechat', 'wechat-fixture-id', 'samecat', '');
  insertUser.run(5, 'github', 'second-github-fixture-id', 'slowcat', '');
  insertUser.run(6, 'wechat', 'second-wechat-fixture-id', 'newcat', '');
  db.prepare(`INSERT INTO password_credentials
    (user_id,username,algorithm,cost,block_size,parallelism,key_length,salt,password_hash)
    VALUES(3,'samecat','scrypt',32768,8,1,64,?,?)`).run('a'.repeat(32), 'b'.repeat(128));

  const insertCompletion = db.prepare('INSERT INTO completions (user_id,level_id,elapsed_ms,completed_at,run_id) VALUES(?,?,?,1,?)');
  for (const [userId, times] of [[1, [500, 500, 500]], [2, [1000]], [3, [4000, 4300]], [4, [1000]], [5, [2000]]]) {
    times.forEach((ms, index) => insertCompletion.run(userId, index + 1, ms, `${userId}-${index}`));
  }

  return {
    db,
    async start() {
      app = makeApp({ db, env: {
        NODE_ENV: 'test', PUBLIC_URL: 'http://localhost:3000', JWT_SECRET: 'leaderboard-provider-test-only-secret',
        GITHUB_CALLBACK_PATH: '/api/auth/github/callback', TRUST_PROXY_HOPS: '0',
      } });
      server = app.listen(0, '127.0.0.1');
      await once(server, 'listening');
      return `http://127.0.0.1:${server.address().port}`;
    },
  };
}

// Explicit full rows make any extra field (provider IDs, credentials, etc.) a contract failure.
const expectedRows = [
  { id: 3, username: 'samecat', authProvider: 'password', avatarUrl: '', cleared: 2, totalMs: 8300, rank: 1 },
  { id: 2, username: 'samecat', authProvider: 'github', avatarUrl: '/avatar.png', cleared: 1, totalMs: 1000, rank: 2 },
  { id: 4, username: 'samecat', authProvider: 'wechat', avatarUrl: '', cleared: 1, totalMs: 1000, rank: 3 },
  { id: 5, username: 'slowcat', authProvider: 'github', avatarUrl: '', cleared: 1, totalMs: 2000, rank: 4 },
  { id: 6, username: 'newcat', authProvider: 'wechat', avatarUrl: '', cleared: 0, totalMs: 0, rank: 5 },
];

test('leaderboard service distinguishes same-name accounts without exposing private fields', t => {
  const { db } = fixture(t);
  const game = new GameService(db);
  assert.deepEqual(game.leaderboard(), { total: 5, rows: expectedRows });
  assert.deepEqual(game.leaderboard(2, 2), { total: 5, rows: expectedRows.slice(2, 4) });
  assert.deepEqual(game.leaderboard(5, 2), { total: 5, rows: [] });
});

function getLeaderboard(base, query = '') {
  return new Promise((resolve, reject) => {
    get(base + '/api/leaderboard' + query, async response => {
      try {
        let body = '';
        response.setEncoding('utf8');
        for await (const chunk of response) body += chunk;
        assert.equal(response.statusCode, 200);
        resolve(JSON.parse(body));
      } catch (error) { reject(error); }
    }).on('error', reject);
  });
}

test('public leaderboard HTTP API preserves guest filtering, rank order, and safe fields across pages', async t => {
  const base = await fixture(t).start();
  assert.deepEqual(await getLeaderboard(base), { total: 5, rows: expectedRows });
  assert.deepEqual(await getLeaderboard(base, '?limit=2'), { total: 5, rows: expectedRows.slice(0, 2) });
  assert.deepEqual(await getLeaderboard(base, '?offset=2&limit=2'), { total: 5, rows: expectedRows.slice(2, 4) });
  assert.deepEqual(await getLeaderboard(base, '?offset=4&limit=2'), { total: 5, rows: expectedRows.slice(4) });
  assert.deepEqual(await getLeaderboard(base, '?offset=5&limit=2'), { total: 5, rows: [] });
});

test('leaderboard renders fixed provider badges beside escaped names and falls back for unrecognized values', async () => {
  const markup = '<img src=x onerror="alert(1)">';
  const providers = ['github', 'password', 'wechat', undefined, null, 'future-provider', 'guest', '__proto__', 'constructor', 'toString', ['github'], markup];
  const rows = providers.map((authProvider, i) => ({
    ...expectedRows[0], rank: i + 1, username: i === 0 ? markup : 'samecat', authProvider,
  }));
  const h = createHarness({ respond({ method, url }) {
    assert.equal(method, 'GET');
    assert.equal(url, '/api/leaderboard?limit=100');
    return { body: { total: rows.length, rows } };
  } });

  await h.evaluate('showRank()');
  const html = h.node('modal').innerHTML;
  const identities = [...html.matchAll(/<span class="leader-name">([^<]*)<\/span> <span class="leader-provider">([^<]*)<\/span>/g)];
  assert.deepEqual(identities.map(match => match[2]), ['GitHub', '账号密码', '微信', ...Array(providers.length - 3).fill('未知方式')]);
  assert.equal(identities[0][1], '&lt;img src=x onerror=&quot;alert(1)&quot;&gt;');
  assert.ok(identities.slice(1).every(match => match[1] === 'samecat'));
  for (const raw of [markup, 'future-provider', '__proto__', 'constructor', 'toString']) assert.ok(!html.includes(raw));
});
