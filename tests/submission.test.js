'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { once } = require('node:events');
const { randomBytes } = require('node:crypto');
const jwt = require('jsonwebtoken');
const { openDatabase } = require('../db');
const { makeApp } = require('../server');

const ANSWER = [2, 4, 11, 13];
const REGIONS = [1, 0, 0, 2, 1, 0, 2, 2, 1, 3, 2, 2, 1, 3, 2, 2];
const GAME = '/api/game/';
// Fetch blocks these ports even when listen(0) selects one on loopback.
const FETCH_BLOCKED_PORTS = new Set([
  1, 7, 9, 11, 13, 15, 17, 19, 20, 21, 22, 23, 25, 37, 42, 43, 53, 69, 77, 79, 87, 95,
  101, 102, 103, 104, 109, 110, 111, 113, 115, 117, 119, 123, 135, 137, 139, 143, 161, 179,
  389, 427, 465, 512, 513, 514, 515, 526, 530, 531, 532, 540, 548, 554, 556, 563, 587, 601,
  636, 989, 990, 993, 995, 1719, 1720, 1723, 2049, 3659, 4045, 4190, 5060, 5061, 6000, 6566,
  6665, 6666, 6667, 6668, 6669, 6679, 6697, 10080,
]);
const PRACTICE = '/api/admin/practice/';

function snapshot(db, tables = ['users', 'levels', 'runs', 'run_moves', 'completions', 'practice_runs', 'practice_moves']) {
  return Object.fromEntries(tables.map(table => [table, db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()]));
}
function noSolution(value) {
  if (!value || typeof value !== 'object') return;
  for (const [key, child] of Object.entries(value)) {
    assert.ok(!/solution/i.test(key), `response must not disclose ${key}`);
    noSolution(child);
  }
}
async function fixture(t) {
  const db = openDatabase(':memory:');
  let app, server;
  t.after(async () => {
    try {
      if (server?.listening) await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    } finally {
      try { if (app) await app.locals.close(); } finally { db.close(); }
    }
  });
  for (const id of [1, 2, 3]) {
    db.prepare('INSERT INTO levels(id,size,region_map,solution,map_hash,seed,search_nodes,generation_attempts,created_at) VALUES(?,4,?,?,?,?,1,1,1)')
      .run(id, JSON.stringify(REGIONS), JSON.stringify(ANSWER), `submission-fixture-${id}`, id);
  }
  const addUser = (provider, name) => Number(db.prepare(
    'INSERT INTO users(auth_provider,open_id,username,created_at,updated_at) VALUES(?,?,?,1,1)',
  ).run(provider, `${provider}-${name}`, name).lastInsertRowid);
  const ids = {
    admin: addUser('github', 'CatAdmin'), otherAdmin: addUser('github', 'catadmin'),
    regular: addUser('github', 'ordinary'), guest: addUser('guest', 'CatAdmin'),
    wechat: addUser('wechat', 'CatAdmin'),
  };
  const secret = randomBytes(32).toString('hex');
  const sign = (user = 'admin', claims = {}, options = {}, signingKey = secret) => jwt.sign({
    sub: String(ids[user]), provider: 'github', ...claims,
  }, signingKey, { algorithm: 'HS256', expiresIn: '1h', issuer: 'find-the-cat', audience: 'find-the-cat-web', ...options });
  app = makeApp({ db, env: {
    NODE_ENV: 'test', PUBLIC_URL: 'http://localhost:3000', JWT_SECRET: secret,
    ADMIN_GITHUB_USERNAME: ' cAtAdMiN ', ADMIN_GITHUB_USERNAMES: '', ADMIN_SECRET: '',
    RUN_TTL_HOURS: '1', TRUST_PROXY_HOPS: '0',
  } });
  let now = Date.now();
  const clock = { get now() { return now; }, advance(ms) { now += ms; } };
  app.locals.service.now = app.locals.practiceService.now = app.locals.practiceService.game.now = () => now;
  let port;
  do {
    server = app.listen(0, '127.0.0.1');
    await once(server, 'listening');
    port = server.address().port;
    if (!FETCH_BLOCKED_PORTS.has(port)) break;
    t.diagnostic(`Rebinding fetch-blocked listener port=${port} before HTTP requests`);
    await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  } while (true);
  const base = `http://127.0.0.1:${port}`;
  async function request(endpoint, body, { user = 'admin', token, headers = {} } = {}) {
    const authorization = token !== undefined ? token : user === null ? null : sign(user);
    const response = await fetch(base + endpoint, {
      method: 'POST', headers: { 'Content-Type': 'application/json',
        ...(authorization ? { Authorization: `Bearer ${authorization}` } : {}), ...headers },
      body: JSON.stringify(body),
    }).catch(error => {
      t.diagnostic(`HTTP request failed: port=${port}, cause=${JSON.stringify({
        message: error.cause?.message ?? error.message, code: error.cause?.code ?? null,
      })}`);
      throw error;
    });
    const data = await response.json();
    noSolution(data);
    return { status: response.status, data, headers: response.headers };
  }
  async function ok(endpoint, body, options) {
    const response = await request(endpoint, body, options);
    assert.equal(response.status, 200, JSON.stringify(response.data));
    return response.data;
  }
  const payload = run => ({ runId: run.id, levelId: run.levelId, cats: [...ANSWER] });
  const row = (run, table = 'runs') => db.prepare(`SELECT * FROM ${table} WHERE id=?`).get(run.id);
  async function solve(prefix, run) {
    for (const cell of ANSWER) {
      run = (await ok(prefix + 'move', { runId: run.id, requestId: `right_${cell}_request`,
        cell, operation: 'place', revision: run.revision })).run;
    }
    return run;
  }
  return { db, app, ids, sign, clock, request, ok, payload, row, solve };
}

test('submit HTTP requires valid authentication and stored GitHub admin for practice', async t => {
  const { db, ids, sign, request, ok } = await fixture(t);
  const before = snapshot(db);
  for (const prefix of [GAME, PRACTICE]) {
    const body = { runId: 'not-a-run', levelId: 1, cats: ANSWER, userId: ids.admin, isAdmin: true };
    assert.equal((await request(prefix + 'submit', body, { user: null })).status, 401);
    for (const token of [
      'invalid.jwt', sign('admin', {}, {}, randomBytes(32).toString('hex')),
      sign('admin', {}, { expiresIn: -1 }), sign('admin', {}, { issuer: 'wrong' }),
      sign('admin', {}, { audience: 'wrong' }), sign('admin', {}, { algorithm: 'HS384' }),
      sign('admin', { sub: '999999' }),
    ]) assert.equal((await request(prefix + 'submit', body, { token })).status, 401);
    for (const user of ['regular', 'guest', 'wechat']) {
      const response = await request(prefix + 'submit', body, {
        token: sign(user, { isAdmin: true, username: 'CatAdmin', provider: 'github' }),
        headers: { 'x-admin-secret': 'spoofed', 'x-user-id': String(ids.admin) },
      });
      assert.equal(response.status, prefix === PRACTICE ? 403 : 409);
    }
  }
  assert.deepEqual(snapshot(db), before);
  // Claims cannot keep admin rights after the stored account changes.
  const token = sign();
  db.prepare("UPDATE users SET username='demoted' WHERE id=?").run(ids.admin);
  assert.equal((await request(PRACTICE + 'submit', { runId: 'missing', levelId: 1, cats: ANSWER }, { token })).status, 403);
  // Ordinary authenticated users (including guests) can play official mode.
  for (const user of ['regular', 'guest', 'wechat']) {
    const { run } = await ok(GAME + 'start', {}, { user });
    assert.equal((await ok(GAME + 'submit', { runId: run.id, levelId: 1, cats: ANSWER }, { user })).currentLevel, 2);
  }
});

test('official one-shot HTTP submit works without moves and persists only server time and state', async t => {
  const { db, ids, clock, ok, payload, row } = await fixture(t);
  const levels = snapshot(db, ['levels']);
  const { run } = await ok(GAME + 'start', {});
  const started = row(run).started_at;
  assert.deepEqual(run.cats, []);
  clock.advance(5432);
  const body = { ...payload(run), cats: [...ANSWER].reverse(), elapsedMs: 1, hearts: 0,
    status: 'failed', started_at: 0, finished_at: 1, revision: 900, currentLevel: 100 };
  const result = await ok(GAME + 'submit', body);
  assert.equal(result.elapsedMs, 5432);
  assert.equal(result.currentLevel, 2);
  assert.equal(result.levelId, 1);
  assert.equal(result.allComplete, false);
  const stored = row(run);
  assert.equal(stored.started_at, started);
  assert.equal(stored.finished_at, clock.now);
  assert.equal(stored.status, 'completed');
  assert.equal(stored.revision, 1);
  assert.equal(stored.hearts, 3);
  assert.deepEqual(JSON.parse(stored.cats), ANSWER);
  const receipt = db.prepare('SELECT * FROM completions').get();
  assert.equal(receipt.run_id, run.id);
  assert.equal(receipt.elapsed_ms, 5432);
  assert.equal(receipt.completed_at, clock.now);
  assert.equal(db.prepare('SELECT current_level,updated_at FROM users WHERE id=?').get(ids.admin).updated_at, clock.now);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM run_moves').get().n, 0);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM practice_runs').get().n, 0);
  assert.deepEqual(snapshot(db, ['levels']), levels);
  assert.equal((await ok(GAME + 'complete', payload(run))).elapsedMs, 5432);
});

test('practice one-shot HTTP submit accepts a locked level and never touches official data', async t => {
  const { db, clock, ok, payload, row } = await fixture(t);
  let { run: official } = await ok(GAME + 'start', {});
  official = (await ok(GAME + 'move', { runId: official.id, requestId: 'official_wrong', cell: 0,
    operation: 'place', revision: 0 })).run;
  const before = snapshot(db, ['users', 'levels', 'runs', 'run_moves', 'completions']);
  const { run } = await ok(PRACTICE + 'start', { levelId: 3 });
  clock.advance(6789);
  const result = await ok(PRACTICE + 'submit', { ...payload(run), elapsedMs: -100, hearts: 99, status: 'ready' });
  assert.deepEqual(result, { practice: true, levelId: 3, elapsedMs: 6789, totalLevels: 3, nextLevelId: null });
  const stored = row(run, 'practice_runs');
  assert.equal(stored.status, 'completed');
  assert.equal(stored.finished_at, clock.now);
  assert.equal(stored.revision, 1);
  assert.equal(stored.hearts, 3);
  assert.deepEqual(JSON.parse(stored.cats), ANSWER);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM practice_moves').get().n, 0);
  assert.deepEqual(snapshot(db, ['users', 'levels', 'runs', 'run_moves', 'completions']), before);
  clock.advance(5000);
  const completed = snapshot(db);
  assert.deepEqual(await ok(PRACTICE + 'submit', payload(run)), result);
  assert.deepEqual(await ok(PRACTICE + 'complete', payload(run)), result);
  assert.deepEqual(snapshot(db), completed);
});

for (const prefix of [GAME, PRACTICE]) {
  const mode = prefix === GAME ? 'official' : 'practice';
  const table = prefix === GAME ? 'runs' : 'practice_runs';
  test(`${mode} submit accepts legacy playing/ready boards but times the submission, not the last move`, async t => {
    const { db, clock, ok, payload, row, solve } = await fixture(t);
    let { run } = await ok(prefix + 'start', { levelId: 1 });
    run = (await ok(prefix + 'move', { runId: run.id, requestId: 'lose_one_heart', cell: 0,
      operation: 'place', revision: run.revision })).run;
    clock.advance(200);
    run = await solve(prefix, run);
    assert.equal(run.status, 'ready');
    const oldFinish = row(run, table).finished_at;
    clock.advance(800);
    const result = await ok(prefix + 'submit', payload(run));
    assert.equal(result.elapsedMs, 1000);
    const stored = row(run, table);
    assert.equal(stored.finished_at, oldFinish + 800);
    assert.equal(stored.revision, run.revision + 1);
    assert.equal(stored.hearts, 2);
    assert.equal(db.prepare(`SELECT COUNT(*) n FROM ${prefix === GAME ? 'run_moves' : 'practice_moves'}`).get().n, 5);
    assert.equal((await ok(prefix + 'complete', payload(run))).elapsedMs, 1000);
  });

  test(`${mode} submit accepts a partial server board and preserves remaining hearts`, async t => {
    const { clock, ok, payload, row } = await fixture(t);
    let { run } = await ok(prefix + 'start', { levelId: 1 });
    for (const cell of [0, ANSWER[0]]) {
      run = (await ok(prefix + 'move', { runId: run.id, requestId: `partial_${cell}_request`,
        cell, operation: 'place', revision: run.revision })).run;
    }
    assert.equal(run.status, 'playing');
    assert.deepEqual(run.cats, [ANSWER[0]]);
    clock.advance(2000);
    assert.equal((await ok(prefix + 'submit', payload(run))).elapsedMs, 2000);
    assert.equal(row(run, table).hearts, 2);
    assert.equal(row(run, table).revision, 3);
  });

  test(`${mode} submit rejects malformed bodies and coordinates without changing any data`, async t => {
    const { db, app, ids, request, ok, payload } = await fixture(t);
    const { run } = await ok(prefix + 'start', { levelId: 1 });
    const before = snapshot(db);
    const service = prefix === GAME ? app.locals.service : app.locals.practiceService;
    const invalid = [
      undefined, null, [], 'not-an-object', 1, true, {},
      ...[undefined, null, 1, '', 'x'.repeat(65), {}, []].map(runId => ({ ...payload(run), runId })),
      ...[undefined, null, 0, -1, 1.5, '1', true, 2147483648, Number.MAX_SAFE_INTEGER + 1]
        .map(levelId => ({ ...payload(run), levelId })),
      ...[undefined, null, {}, '2,4,11,13', [], [2], [2, 4, 11], [...ANSWER, 0], Array(12).fill(2),
        [2, 4, 11, 11], [-1, 4, 11, 13], [16, 4, 11, 13], [2.5, 4, 11, 13], ['2', 4, 11, 13],
        [null, 4, 11, 13], [true, 4, 11, 13], [NaN, 4, 11, 13], [Infinity, 4, 11, 13],
        [Number.MAX_SAFE_INTEGER + 1, 4, 11, 13], [[2], 4, 11, 13], [0, 4, 11, 13]]
        .map(cats => ({ ...payload(run), cats })),
    ];
    for (const body of invalid) {
      assert.throws(() => service.submit(ids.admin, body), { status: 400 });
      assert.deepEqual(snapshot(db), before);
    }
    // Real HTTP rejects invalid JSON shapes and representative bad inputs, too.
    for (const body of [null, [], 'body', {}, { ...payload(run), levelId: '1' },
      { ...payload(run), cats: [16, 4, 11, 13] }, { ...payload(run), cats: [2, 4, 11, 11] },
      { ...payload(run), cats: [0, 4, 11, 13] }]) {
      assert.equal((await request(prefix + 'submit', body)).status, 400);
    }
    assert.deepEqual(snapshot(db), before);
    const cats = Object.freeze([...ANSWER].reverse());
    service.submit(ids.admin, { ...payload(run), cats });
    assert.deepEqual(cats, [...ANSWER].reverse(), 'validation must not mutate caller coordinates');
  });

  test(`${mode} submit cannot revive a failed legacy run or trust client hearts/status`, async t => {
    const { db, request, ok, payload } = await fixture(t);
    let { run } = await ok(prefix + 'start', { levelId: 1 });
    for (let i = 0; i < 3; i++) {
      run = (await ok(prefix + 'move', { runId: run.id, requestId: `failed_${i}_request`, cell: 0,
        operation: 'place', revision: run.revision })).run;
    }
    assert.equal(run.status, 'failed');
    const before = snapshot(db);
    const response = await request(prefix + 'submit', { ...payload(run), hearts: 3, status: 'playing', elapsedMs: 1 });
    assert.equal(response.status, 409);
    assert.equal(response.data.code, 'RUN_FINISHED');
    assert.deepEqual(snapshot(db), before);
    // Enforce hearts and status independently, including inconsistent legacy states.
    for (const [status, hearts] of [['playing', 0], ['ready', 0], ['failed', 3]]) {
      db.prepare(`UPDATE ${table} SET status=?,hearts=? WHERE id=?`).run(status, hearts, run.id);
      const unchanged = snapshot(db);
      assert.equal((await request(prefix + 'submit', payload(run))).status, 409);
      assert.deepEqual(snapshot(db), unchanged);
    }
  });

  test(`${mode} submit rejects expiration at the exact server boundary`, async t => {
    const { db, clock, request, ok, payload, row } = await fixture(t);
    const { run } = await ok(prefix + 'start', { levelId: 1 });
    clock.advance(run.expiresAt - clock.now);
    const before = snapshot(db);
    const response = await request(prefix + 'submit', { ...payload(run), expiresAt: clock.now + 999999 });
    assert.equal(response.status, 409);
    assert.equal(response.data.code, 'RUN_EXPIRED');
    assert.deepEqual(snapshot(db), before);
    const fresh = (await ok(prefix + 'start', { levelId: 1 })).run;
    assert.notEqual(fresh.id, run.id);
    const current = row(fresh, table);
    assert.equal((await request(prefix + 'submit', payload(run))).data.code, 'STALE_RUN');
    assert.deepEqual(row(fresh, table), current);
    assert.equal((await ok(prefix + 'submit', payload(fresh))).elapsedMs, 1, 'zero-ms runs use the existing positive score floor');
  });
}

test('official submit is idempotent concurrently, after advancing, and after run expiration/replacement', async t => {
  const { db, clock, request, ok, payload, row } = await fixture(t);
  const { run } = await ok(GAME + 'start', {});
  clock.advance(1234);
  const results = await Promise.all(Array.from({ length: 8 }, () => ok(GAME + 'submit', payload(run))));
  for (const result of results) assert.deepEqual(result, results[0]);
  assert.equal(row(run).revision, 1);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM completions').get().n, 1);
  const newer = (await ok(GAME + 'start', {})).run;
  clock.advance(321);
  await ok(GAME + 'submit', payload(newer));
  const newest = (await ok(GAME + 'start', {})).run;
  clock.advance(3600001);
  const before = snapshot(db);
  const retry = await ok(GAME + 'submit', { ...payload(run), elapsedMs: 999999, hearts: 0, status: 'failed' });
  assert.equal(retry.elapsedMs, 1234);
  assert.equal(retry.currentLevel, 3);
  assert.deepEqual(snapshot(db), before);
  assert.equal(row(newest).status, 'playing');
  assert.equal((await request(GAME + 'submit', { ...payload(run), cats: [0, 4, 11, 13] })).status, 400);
  assert.equal((await request(GAME + 'submit', { ...payload(run), levelId: 2 })).status, 409);
  assert.equal((await request(GAME + 'submit', payload(run), { user: 'otherAdmin' })).status, 409);
  assert.deepEqual(snapshot(db), before);
});

test('practice retries are idempotent but stale/expired receipts cannot overwrite a new practice run', async t => {
  const { db, clock, request, ok, payload, row } = await fixture(t);
  const { run } = await ok(PRACTICE + 'start', { levelId: 2 });
  clock.advance(2222);
  const results = await Promise.all(Array.from({ length: 8 }, () => ok(PRACTICE + 'submit', payload(run))));
  for (const result of results) assert.deepEqual(result, results[0]);
  assert.equal(row(run, 'practice_runs').revision, 1);
  const before = snapshot(db);
  assert.equal((await request(PRACTICE + 'submit', { ...payload(run), cats: [0, 4, 11, 13] })).status, 400);
  assert.deepEqual(snapshot(db), before);
  clock.advance(run.expiresAt - clock.now);
  assert.equal((await request(PRACTICE + 'submit', payload(run))).data.code, 'RUN_EXPIRED');
  assert.deepEqual(snapshot(db), before);
  const fresh = (await ok(PRACTICE + 'start', { levelId: 3 })).run;
  const replaced = snapshot(db);
  assert.equal((await request(PRACTICE + 'submit', payload(run))).data.code, 'STALE_RUN');
  assert.deepEqual(snapshot(db), replaced);
  assert.equal(row(fresh, 'practice_runs').status, 'playing');
});

test('submit rejects other users, cross-mode runs, mismatched levels and official level skipping', async t => {
  const { db, ids, request, ok, payload } = await fixture(t);
  const official = (await ok(GAME + 'start', {})).run;
  const practice = (await ok(PRACTICE + 'start', { levelId: 2 })).run;
  const before = snapshot(db);
  for (const [prefix, run] of [[GAME, official], [PRACTICE, practice]]) {
    assert.equal((await request(prefix + 'submit', payload(run), { user: 'otherAdmin' })).data.code, 'STALE_RUN');
    assert.equal((await request(prefix + 'submit', { ...payload(run), levelId: 3 })).status, prefix === GAME ? 403 : 409);
    const otherMode = prefix === GAME ? practice : official;
    assert.equal((await request(prefix + 'submit', payload(otherMode))).data.code, 'STALE_RUN');
    assert.equal((await request(prefix + 'submit', { ...payload(run), runId: 'not-a-run' })).data.code, 'STALE_RUN');
  }
  assert.deepEqual(snapshot(db), before);
  db.prepare('UPDATE runs SET level_id=2 WHERE user_id=?').run(ids.admin);
  const locked = snapshot(db);
  assert.equal((await request(GAME + 'submit', { ...payload(official), levelId: 2 })).data.code, 'LEVEL_LOCKED');
  assert.deepEqual(snapshot(db), locked);
});

test('submit transactions roll back all run, receipt and progress writes on a database failure', async t => {
  const { db, app, ids, clock, ok, payload } = await fixture(t);
  const { run } = await ok(GAME + 'start', {});
  clock.advance(1000);
  db.exec("CREATE TRIGGER fail_advance BEFORE UPDATE OF current_level ON users BEGIN SELECT RAISE(ABORT, 'test advance failure'); END;");
  const before = snapshot(db);
  assert.throws(() => app.locals.service.submit(ids.admin, payload(run)), /test advance failure/);
  assert.deepEqual(snapshot(db), before);
  db.exec('DROP TRIGGER fail_advance');
  assert.equal((await ok(GAME + 'submit', payload(run))).elapsedMs, 1000);
  const practice = (await ok(PRACTICE + 'start', { levelId: 3 })).run;
  db.exec("CREATE TRIGGER fail_practice AFTER UPDATE ON practice_runs BEGIN SELECT RAISE(ABORT, 'test practice failure'); END;");
  const officialUnchanged = snapshot(db);
  assert.throws(() => app.locals.practiceService.submit(ids.admin, payload(practice)), /test practice failure/);
  assert.deepEqual(snapshot(db), officialUnchanged);
});

test('submit uses separate per-user/mode rate buckets with the existing completion limit', async t => {
  const { db, request, ok } = await fixture(t);
  const before = snapshot(db);
  for (const prefix of [GAME, PRACTICE]) {
    for (let i = 0; i < 30; i++) assert.equal((await request(prefix + 'submit', {})).status, 400);
    const limited = await request(prefix + 'submit', {});
    assert.equal(limited.status, 429);
    assert.ok(Number(limited.headers.get('retry-after')) > 0);
    assert.equal((await request(prefix + 'submit', {}, { user: 'otherAdmin' })).status, 400);
    assert.equal((await request(prefix + 'complete', {})).status, 400, 'legacy completion quota is separate');
  }
  assert.deepEqual(snapshot(db), before);
  assert.equal((await ok(GAME + 'start', {})).run.status, 'playing');
  assert.equal((await ok(PRACTICE + 'start', { levelId: 2 })).run.status, 'playing');
});

test('legacy completion receipts work with submit and final official submission keeps level metadata unchanged', async t => {
  const { db, clock, ok, payload, solve, row } = await fixture(t);
  const levels = snapshot(db, ['levels']);
  let run = (await ok(GAME + 'start', {})).run;
  clock.advance(100);
  run = await solve(GAME, run);
  const legacy = await ok(GAME + 'complete', payload(run));
  clock.advance(900);
  const completed = snapshot(db);
  assert.deepEqual(await ok(GAME + 'submit', payload(run)), legacy);
  assert.deepEqual(snapshot(db), completed);
  const practice = await solve(PRACTICE, (await ok(PRACTICE + 'start', { levelId: 2 })).run);
  const practiceLegacy = await ok(PRACTICE + 'complete', payload(practice));
  clock.advance(1000);
  const practiceBefore = row(practice, 'practice_runs');
  assert.deepEqual(await ok(PRACTICE + 'submit', payload(practice)), practiceLegacy);
  assert.deepEqual(row(practice, 'practice_runs'), practiceBefore);
  for (const levelId of [2, 3]) {
    run = (await ok(GAME + 'start', {})).run;
    assert.equal(run.levelId, levelId);
    clock.advance(1000);
    const result = await ok(GAME + 'submit', payload(run));
    assert.equal(result.currentLevel, levelId + 1);
    assert.equal(result.allComplete, levelId === 3);
  }
  assert.equal((await ok(GAME + 'start', {})).allComplete, true);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM completions').get().n, 3);
  assert.deepEqual(snapshot(db, ['levels']), levels);
});
