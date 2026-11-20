'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { once } = require('node:events');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const jwt = require('jsonwebtoken');
const { openDatabase } = require('../db');
const { makeApp } = require('../server');
const { PracticeService } = require('../practice_service');

const SECRET = 'practice-test-only-jwt-secret-at-least-32-characters';
const ANSWER = [2, 4, 11, 13];
const REGIONS = [1, 0, 0, 2, 1, 0, 2, 2, 1, 3, 2, 2, 1, 3, 2, 2];
const PRACTICE = '/api/admin/practice/';
const GAME = '/api/game/';
// Fetch blocks these ports even when listen(0) selects one on loopback.
const FETCH_BLOCKED_PORTS = new Set([
  1, 7, 9, 11, 13, 15, 17, 19, 20, 21, 22, 23, 25, 37, 42, 43, 53, 69, 77, 79, 87, 95,
  101, 102, 103, 104, 109, 110, 111, 113, 115, 117, 119, 123, 135, 137, 139, 143, 161, 179,
  389, 427, 465, 512, 513, 514, 515, 526, 530, 531, 532, 540, 548, 554, 556, 563, 587, 601,
  636, 989, 990, 993, 995, 1719, 1720, 1723, 2049, 3659, 4045, 4190, 5060, 5061, 6000, 6566,
  6665, 6666, 6667, 6668, 6669, 6679, 6697, 10080,
]);
const RUN_KEYS = ['id', 'levelId', 'hearts', 'cats', 'revision', 'status', 'elapsedMs', 'expiresAt'].sort();

function sign(id, claims = {}, secret = SECRET) {
  return jwt.sign({ sub: String(id), provider: 'github', ...claims }, secret, {
    algorithm: 'HS256', expiresIn: '1h', issuer: 'find-the-cat', audience: 'find-the-cat-web',
  });
}
function noSolution(value) {
  if (!value || typeof value !== 'object') return;
  for (const [key, child] of Object.entries(value)) {
    assert.ok(!/solution/i.test(key), `response must not disclose ${key}`);
    noSolution(child);
  }
}
function snapshot(db) {
  return Object.fromEntries(['users', 'levels', 'runs', 'run_moves', 'completions'].map(table =>
    [table, db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()]));
}
async function fixture(t, env = {}) {
  const db = openDatabase(':memory:');
  let app, server;
  t.after(async () => {
    try { if (server?.listening) await new Promise((resolve, reject) => server.close(e => e ? reject(e) : resolve())); }
    finally { try { if (app) await app.locals.close(); } finally { db.close(); } }
  });
  for (const id of [1, 2, 5]) {
    db.prepare('INSERT INTO levels(id,size,region_map,solution,map_hash,seed,search_nodes,generation_attempts,created_at) VALUES(?,4,?,?,?,?,1,1,1)')
      .run(id, JSON.stringify(REGIONS), JSON.stringify(ANSWER), `practice-fixture-${id}`, id);
  }
  const addUser = (provider, openId, name) => Number(db.prepare(
    'INSERT INTO users(auth_provider,open_id,username,created_at,updated_at) VALUES(?,?,?,1,1)',
  ).run(provider, openId, name).lastInsertRowid);
  const ids = {
    admin: addUser('github', 'admin-one', 'CatAdmin'),
    otherAdmin: addUser('github', 'admin-two', 'catadmin'),
    regular: addUser('github', 'ordinary', 'ordinary'),
    guest: addUser('guest', 'guest', 'CatAdmin'),
    wechat: addUser('wechat', 'wechat', 'CatAdmin'),
  };
  app = makeApp({ db, env: {
    NODE_ENV: 'test', PUBLIC_URL: 'http://localhost:3000', JWT_SECRET: SECRET,
    ADMIN_GITHUB_USERNAME: '  cAtAdMiN  ', ADMIN_SECRET: 'generation-only-secret-long-enough',
    RUN_TTL_HOURS: '1', TRUST_PROXY_HOPS: '0', ...env,
  } });
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
  async function request(endpoint, body, { user = 'admin', token, headers = {}, method } = {}) {
    const authorization = token !== undefined ? token : user === null ? null : sign(ids[user]);
    const response = await fetch(base + endpoint, {
      method: method || (body === undefined ? 'GET' : 'POST'),
      headers: { ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
        ...(authorization ? { Authorization: `Bearer ${authorization}` } : {}), ...headers },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
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
  const move = (run, cell, requestId, operation = 'place') => ({
    runId: run.id, cell, requestId, operation, revision: run.revision,
  });
  async function solve(run, endpoint = PRACTICE, options) {
    for (const cell of ANSWER) run = (await ok(endpoint + 'move', move(run, cell, `solve_${cell}_request`), options)).run;
    return run;
  }
  return { db, app, ids, request, ok, move, solve };
}

test('practice HTTP authentication uses stored GitHub admin, not body/header/JWT claims', async t => {
  const { db, ids, request, ok } = await fixture(t);
  const before = snapshot(db);
  for (const action of ['start', 'move', 'complete']) {
    const body = { levelId: 1, runId: 'not-a-run', cats: ANSWER, isAdmin: true, userId: ids.admin };
    assert.equal((await request(PRACTICE + action, body, { user: null })).status, 401);
    assert.equal((await request(PRACTICE + action, body, { token: 'bad-token' })).status, 401);
    for (const user of ['regular', 'guest', 'wechat']) {
      const response = await request(PRACTICE + action, body, {
        token: sign(ids[user], { isAdmin: true, provider: 'github', username: 'CatAdmin' }),
        headers: { 'X-Admin-Secret': 'generation-only-secret-long-enough', 'X-Is-Admin': 'true' },
      });
      assert.equal(response.status, 403, `${user} ${action}`);
    }
  }
  assert.equal((await request(PRACTICE + 'start', { levelId: 1 }, { token: sign(ids.admin, {}, 'wrong-secret') })).status, 401);
  assert.equal((await request(PRACTICE + 'start', { levelId: 1 }, { token: sign(9999, { isAdmin: true }) })).status, 401);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM practice_runs').get().n, 0);
  assert.deepEqual(snapshot(db), before);
  assert.equal((await ok('/api/me')).user.isAdmin, true);
  assert.equal((await ok('/api/me', undefined, { user: 'guest' })).user.isAdmin, false);
  assert.equal((await ok(PRACTICE + 'start', { levelId: 5 }, { headers: { 'X-Admin-Secret': 'wrong-but-not-needed' } })).practice, true);
  assert.equal((await request('/api/admin/generate-levels', { count: 1 })).status, 403);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM generation_jobs').get().n, 0);
  // Re-read the database identity on every call, including a token issued before demotion.
  db.prepare("UPDATE users SET username='no-longer-admin' WHERE id=?").run(ids.admin);
  assert.equal((await request(PRACTICE + 'start', { levelId: 1 })).status, 403);
});

test('additional GitHub admins preserve the original login and require exact names, not substrings or guests', async t => {
  const { db, ids, request, ok } = await fixture(t, {
    ADMIN_GITHUB_USERNAME: ' cAtAdMiN ', ADMIN_GITHUB_USERNAMES: ' , OTHER-ADMIN , another-admin, ',
  });
  db.prepare('UPDATE users SET username=? WHERE id=?').run('other-admin', ids.regular);
  assert.equal((await ok('/api/me')).user.isAdmin, true);
  assert.equal((await ok('/api/me', undefined, { user: 'regular' })).user.isAdmin, true);
  assert.equal((await ok(PRACTICE + 'start', { levelId: 5 }, { user: 'regular' })).practice, true);
  for (const name of ['otheradmin', 'other-admin-extra']) {
    db.prepare('UPDATE users SET username=? WHERE id=?').run(name, ids.regular);
    assert.equal((await request(PRACTICE + 'start', { levelId: 1 }, { user: 'regular' })).status, 403);
  }
  db.prepare('UPDATE users SET username=? WHERE id=?').run('other-admin', ids.guest);
  assert.equal((await request(PRACTICE + 'start', { levelId: 1 }, { user: 'guest' })).status, 403);
});

test('practice needs no configured admin secret; whitespace-only admin configuration never authorizes', async t => {
  const first = await fixture(t, { ADMIN_SECRET: '' });
  assert.equal((await first.ok(PRACTICE + 'start', { levelId: 1 })).practice, true);
  assert.equal((await first.request('/api/admin/generate-levels', { count: 1 })).status, 503);
  const second = await fixture(t, { ADMIN_GITHUB_USERNAME: '   ' });
  assert.equal((await second.request(PRACTICE + 'start', { levelId: 1 })).status, 403);
  assert.equal((await second.ok('/api/me')).user.isAdmin, false);
});

test('start requires a positive integer levelId and validates body/restart; invalid input preserves run', async t => {
  const { db, request, ok } = await fixture(t);
  const started = await ok(PRACTICE + 'start', { levelId: 2 });
  assert.deepEqual(Object.keys(started).sort(), ['allComplete', 'totalLevels', 'level', 'run', 'practice'].sort());
  assert.deepEqual(Object.keys(started.level).sort(), ['id', 'regions', 'size']);
  assert.deepEqual(Object.keys(started.run).sort(), RUN_KEYS);
  assert.deepEqual(started.level.regions, REGIONS);
  for (const body of [{}, ...[null, 0, -1, 1.5, '1', true, [], {}, 2147483648].map(levelId => ({ levelId })),
    ...['false', 0, null, []].map(restart => ({ levelId: 2, restart })), [], null]) {
    assert.equal((await request(PRACTICE + 'start', body)).status, 400, JSON.stringify(body));
  }
  assert.equal((await request(PRACTICE + 'start', undefined, { method: 'POST' })).status, 400);
  const noBody = await request(PRACTICE + 'start', {}, { headers: { 'Content-Type': 'text/plain' } });
  assert.equal(noBody.status, 400);
  assert.equal((await request(PRACTICE + 'start', { levelId: 3 })).status, 404);
  assert.equal(db.prepare('SELECT id FROM practice_runs').get().id, started.run.id);
});

test('practice owns three hearts, idempotency, optimistic revision, and restart receipts', async t => {
  const { db, ok, request, move } = await fixture(t);
  let { run } = await ok(PRACTICE + 'start', { levelId: 2 });
  const before = snapshot(db);
  assert.equal(run.hearts, 3);
  assert.equal(run.revision, 0);
  const firstPayload = move(run, ANSWER[0], 'correct_first');
  const first = await ok(PRACTICE + 'move', firstPayload);
  assert.equal(first.correct, true);
  assert.equal(first.run.hearts, 3);
  assert.deepEqual(first.run.cats, [ANSWER[0]]);
  assert.deepEqual(await ok(PRACTICE + 'move', firstPayload), first);
  const stale = await request(PRACTICE + 'move', move(run, ANSWER[1], 'stale_revision'));
  assert.equal(stale.status, 409);
  assert.equal(stale.data.code, 'STALE_REVISION');
  assert.equal((await request(PRACTICE + 'move', { ...firstPayload, cell: ANSWER[1] })).status, 409);
  assert.equal((await request(PRACTICE + 'move', { ...firstPayload, operation: 'remove' })).status, 409);
  run = first.run;
  const remove = await ok(PRACTICE + 'move', move(run, ANSWER[0], 'remove_first', 'remove'));
  run = remove.run;
  assert.deepEqual(run.cats, []);
  assert.equal(run.hearts, 3);
  assert.equal((await request(PRACTICE + 'move', move(run, ANSWER[0], 'remove_missing', 'remove'))).status, 400);
  for (let i = 0; i < 3; i++) {
    const payload = move(run, 0, `wrong_try_${i}`);
    const result = await ok(PRACTICE + 'move', payload);
    assert.equal(result.correct, false);
    assert.equal(result.run.hearts, 2 - i);
    assert.deepEqual(result.run.cats, []);
    assert.deepEqual(await ok(PRACTICE + 'move', payload), result);
    run = result.run;
  }
  assert.equal(run.status, 'failed');
  assert.equal((await request(PRACTICE + 'move', move(run, ANSWER[0], 'after_failure'))).data.code, 'RUN_FINISHED');
  assert.equal((await request(PRACTICE + 'complete', { runId: run.id, levelId: 2, cats: ANSWER })).status, 409);
  assert.equal((await ok(PRACTICE + 'start', { levelId: 2 })).run.status, 'failed');
  const restarted = await ok(PRACTICE + 'start', { levelId: 2, restart: true });
  assert.notEqual(restarted.run.id, run.id);
  assert.equal(restarted.run.hearts, 3);
  assert.equal(restarted.run.revision, 0);
  assert.deepEqual(restarted.run.cats, []);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM practice_runs').get().n, 1);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM practice_moves').get().n, 0);
  assert.equal((await request(PRACTICE + 'move', firstPayload)).data.code, 'STALE_RUN');
  assert.deepEqual(snapshot(db), before);
});

test('practice move/complete reject malformed fields and cannot submit an unsolved server board', async t => {
  const { db, ok, request, move } = await fixture(t);
  const { run } = await ok(PRACTICE + 'start', { levelId: 1 });
  const valid = move(run, 0, 'valid_request');
  const malformed = [{ runId: '' }, { runId: 1 }, { runId: 'x'.repeat(65) },
    { requestId: 'short' }, { requestId: '!bad_id!' }, { requestId: 5 },
    { operation: 'solve' }, { revision: '0' }, { revision: -1 }, { revision: 1.5 },
    { cell: -1 }, { cell: 16 }, { cell: '0' }, { cell: 0.5 }, { cell: null }];
  for (const changes of malformed) {
    assert.equal((await request(PRACTICE + 'move', { ...valid, ...changes })).status, 400, JSON.stringify(changes));
  }
  assert.equal((await request(PRACTICE + 'move', {})).status, 400);
  for (const body of [{}, { runId: run.id, levelId: '1', cats: ANSWER },
    { runId: run.id, levelId: 1, cats: ['2'] }, { runId: run.id, levelId: 1, cats: Array(12).fill(2) },
    { runId: '', levelId: 1, cats: ANSWER }]) {
    assert.equal((await request(PRACTICE + 'complete', body)).status, 400);
  }
  assert.equal((await request(PRACTICE + 'complete', { runId: run.id, levelId: 1, cats: ANSWER, elapsedMs: 1 })).status, 409);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM practice_moves').get().n, 0);
  assert.equal(db.prepare('SELECT revision FROM practice_runs').get().revision, 0);
});

test('arbitrary earlier/later levels, ready removal, frozen time, completion retries and real next IDs', async t => {
  const { db, ids, app, ok, request, move, solve } = await fixture(t);
  db.prepare('UPDATE users SET current_level=2 WHERE id=?').run(ids.admin);
  const before = snapshot(db);
  let now = Date.now();
  app.locals.practiceService.now = app.locals.practiceService.game.now = () => now;
  for (const [levelId, nextLevelId] of [[5, null], [1, 2], [2, 5]]) {
    let { run } = await ok(PRACTICE + 'start', { levelId });
    // Clock injection remains inside the service; callers cannot supply an elapsed time.
    now += 1000;
    assert.equal((await request(PRACTICE + 'complete', { runId: run.id, levelId, cats: ANSWER })).status, 409);
    run = await solve(run);
    assert.equal(run.status, 'ready');
    assert.equal(run.hearts, 3);
    now += 2000;
    assert.equal((await ok(PRACTICE + 'start', { levelId })).run.elapsedMs, run.elapsedMs);
    run = (await ok(PRACTICE + 'move', move(run, ANSWER[0], 'remove_when_ready', 'remove'))).run;
    assert.equal(run.status, 'playing');
    assert.equal(db.prepare('SELECT finished_at FROM practice_runs').get().finished_at, null);
    now += 1000;
    run = (await ok(PRACTICE + 'move', move(run, ANSWER[0], 'replace_ready'))).run;
    assert.equal(run.status, 'ready');
    const payload = { runId: run.id, levelId, cats: ANSWER, elapsedMs: -999, isAdmin: true };
    for (const cats of [[], [2, 2, 11, 13], [2, 4, 11, 12], [2, 4, 11]]) {
      assert.equal((await request(PRACTICE + 'complete', { ...payload, cats })).status, 400);
    }
    assert.equal((await request(PRACTICE + 'complete', { ...payload, levelId: levelId === 5 ? 1 : 5 })).data.code, 'LEVEL_MISMATCH');
    now += 5000;
    const result = await ok(PRACTICE + 'complete', payload);
    assert.deepEqual(result, { practice: true, levelId, elapsedMs: run.elapsedMs, totalLevels: 3, nextLevelId });
    now += 10000;
    assert.deepEqual(await ok(PRACTICE + 'complete', { ...payload, cats: [...ANSWER].reverse() }), result);
    const resumed = await ok(PRACTICE + 'start', { levelId });
    assert.equal(resumed.run.id, run.id);
    assert.equal(resumed.run.status, 'completed');
    assert.equal(resumed.run.elapsedMs, result.elapsedMs);
    assert.deepEqual(Object.keys(resumed.run).sort(), RUN_KEYS);
    assert.equal((await request(PRACTICE + 'move', move(resumed.run, 0, 'after_complete'))).data.code, 'RUN_FINISHED');
    assert.deepEqual(snapshot(db), before);
  }
  assert.equal(db.prepare('SELECT COUNT(*) n FROM practice_runs WHERE user_id=?').get(ids.admin).n, 1);
});

test('practice and official runs cannot cross namespaces or users; official admin play still scores normally', async t => {
  const { db, ids, ok, request, move, solve } = await fixture(t);
  let official = (await ok(GAME + 'start', {})).run;
  official = (await ok(GAME + 'move', move(official, ANSWER[0], 'official_first'))).run;
  const before = snapshot(db);
  const leaderboard = await ok('/api/leaderboard');
  const top = await ok('/api/levels/1/top3');
  const levels = await ok('/api/levels');
  let practice = (await ok(PRACTICE + 'start', { levelId: 1 })).run;
  const other = (await ok(PRACTICE + 'start', { levelId: 2 }, { user: 'otherAdmin' })).run;
  for (const [endpoint, run, user, levelId] of [
    [PRACTICE, official, 'admin', 1], [GAME, practice, 'admin', 1],
    [PRACTICE, practice, 'otherAdmin', 1], [PRACTICE, other, 'admin', 2],
    [GAME, official, 'otherAdmin', 1],
  ]) {
    assert.equal((await request(endpoint + 'move', move(run, ANSWER[1], 'cross_user_run'), { user })).data.code, 'STALE_RUN');
    assert.equal((await request(endpoint + 'complete', { runId: run.id, levelId, cats: ANSWER }, { user })).data.code, 'STALE_RUN');
  }
  practice = await solve(practice);
  const practicePayload = { runId: practice.id, levelId: 1, cats: ANSWER };
  await ok(PRACTICE + 'complete', practicePayload);
  assert.deepEqual(await ok('/api/leaderboard'), leaderboard);
  assert.deepEqual(await ok('/api/levels/1/top3'), top);
  assert.deepEqual(await ok('/api/levels'), levels);
  assert.deepEqual(snapshot(db), before);
  assert.equal((await ok(GAME + 'start', {})).run.id, official.id);
  for (const cell of ANSWER.slice(1)) official = (await ok(GAME + 'move', move(official, cell, `official_${cell}_move`))).run;
  const score = await ok(GAME + 'complete', { runId: official.id, levelId: 1, cats: ANSWER });
  assert.equal(score.currentLevel, 2);
  assert.equal(score.practice, undefined);
  assert.equal(db.prepare('SELECT current_level FROM users WHERE id=?').get(ids.admin).current_level, 2);
  assert.equal((await ok('/api/levels/1/top3')).rows.length, 1);
  assert.equal((await ok('/api/leaderboard')).rows.find(u => u.id === ids.admin).cleared, 1);
  assert.equal((await ok(PRACTICE + 'start', { levelId: 1 })).run.id, practice.id);
  assert.equal((await ok(PRACTICE + 'complete', practicePayload)).practice, true);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM completions').get().n, 1);
  assert.equal((await ok(GAME + 'start', {})).level.id, 2);
});

test('TTL invalidates moves/complete, resume replaces expired run, cleanup touches only practice tables', async t => {
  let sweep;
  const nativeSetInterval = global.setInterval;
  const mock = t.mock.method(global, 'setInterval', (callback, ...args) => {
    sweep = callback;
    return nativeSetInterval(callback, ...args);
  });
  const { db, ids, ok, request, move, solve } = await fixture(t);
  mock.mock.restore();
  const official = (await ok(GAME + 'start', {})).run;
  let practice = (await ok(PRACTICE + 'start', { levelId: 1 })).run;
  assert.ok(Math.abs(practice.expiresAt - Date.now() - 3600000) < 5000);
  const retryMove = move(practice, 0, 'expired_retry');
  await ok(PRACTICE + 'move', retryMove);
  db.prepare('UPDATE practice_runs SET expires_at=? WHERE id=?').run(Date.now() - 1, practice.id);
  assert.equal((await request(PRACTICE + 'move', retryMove)).data.code, 'RUN_EXPIRED');
  assert.equal((await request(PRACTICE + 'complete', { runId: practice.id, levelId: 1, cats: ANSWER })).data.code, 'RUN_EXPIRED');
  const old = practice;
  practice = (await ok(PRACTICE + 'start', { levelId: 1 })).run;
  assert.notEqual(practice.id, old.id);
  assert.equal(practice.hearts, 3);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM practice_moves').get().n, 0);
  practice = await solve(practice);
  const payload = { runId: practice.id, levelId: 1, cats: ANSWER };
  await ok(PRACTICE + 'complete', payload);
  db.prepare('UPDATE practice_runs SET expires_at=? WHERE id=?').run(Date.now() - 1, practice.id);
  assert.equal((await request(PRACTICE + 'complete', payload)).data.code, 'RUN_EXPIRED');
  const other = (await ok(PRACTICE + 'start', { levelId: 5 }, { user: 'otherAdmin' })).run;
  db.prepare('UPDATE runs SET expires_at=? WHERE id=?').run(Date.now() - 1, official.id);
  const before = snapshot(db);
  sweep();
  assert.deepEqual(snapshot(db), before, 'even expired official runs must not be touched by practice cleanup');
  assert.equal(db.prepare('SELECT COUNT(*) n FROM practice_runs WHERE user_id=?').get(ids.admin).n, 0);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM practice_moves WHERE run_id=?').get(practice.id).n, 0);
  assert.equal(db.prepare('SELECT id FROM practice_runs WHERE user_id=?').get(ids.otherAdmin).id, other.id);
  assert.equal((await request(PRACTICE + 'complete', payload)).data.code, 'STALE_RUN');
});

test('practice rate limits are separate for start/move/complete and do not consume official start quota', async t => {
  const { db, ok, request, move } = await fixture(t);
  const started = await ok(PRACTICE + 'start', { levelId: 1 });
  for (let i = 1; i < 30; i++) await ok(PRACTICE + 'start', { levelId: 1 });
  const limited = await request(PRACTICE + 'start', { levelId: 1 });
  assert.equal(limited.status, 429);
  assert.ok(Number(limited.headers.get('retry-after')) > 0);
  const result = await ok(PRACTICE + 'move', move(started.run, 0, 'rate_receipt'));
  for (let i = 1; i < 240; i++) assert.deepEqual(await ok(PRACTICE + 'move', move(started.run, 0, 'rate_receipt')), result);
  assert.equal((await request(PRACTICE + 'move', move(result.run, 0, 'rate_limited'))).status, 429);
  for (let i = 0; i < 30; i++) assert.equal((await request(PRACTICE + 'complete', {})).status, 400);
  assert.equal((await request(PRACTICE + 'complete', {})).status, 429);
  assert.equal((await ok(GAME + 'start', {})).run.hearts, 3);
  assert.equal(db.prepare('SELECT hearts FROM practice_runs').get().hearts, 2);
});

test('schema upgrade is additive, reopens safely, and practice ownership/receipts cascade', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'find-cat-practice-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'test.sqlite');
  let db = openDatabase(file);
  try {
    db.exec('DROP TABLE practice_moves; DROP TABLE practice_runs');
    db.prepare("INSERT INTO users(auth_provider,open_id,username,created_at,updated_at) VALUES('github','upgrade','CatAdmin',1,1)").run();
    db.prepare('INSERT INTO levels(id,size,region_map,solution,map_hash,seed,search_nodes,generation_attempts,created_at) VALUES(1,4,?,?,?,1,1,1,1)')
      .run(JSON.stringify(REGIONS), JSON.stringify(ANSWER), 'upgrade-fixture');
    const before = snapshot(db);
    db.close(); db = openDatabase(file);
    assert.deepEqual(snapshot(db), before);
    const svc = new PracticeService(db);
    const { run } = svc.start(1, { levelId: 1 });
    const payload = { runId: run.id, requestId: 'persisted_retry', cell: 0, operation: 'place', revision: 0 };
    const result = svc.move(1, payload);
    db.close(); db = openDatabase(file);
    assert.deepEqual(new PracticeService(db).move(1, payload), result);
    assert.throws(() => db.prepare('INSERT INTO practice_runs(id,user_id,level_id,started_at,expires_at) VALUES(?,?,?,?,?)')
      .run('duplicate', 1, 1, 1, 2), /UNIQUE/);
    db.prepare('DELETE FROM users WHERE id=1').run();
    assert.equal(db.prepare('SELECT COUNT(*) n FROM practice_runs').get().n, 0);
    assert.equal(db.prepare('SELECT COUNT(*) n FROM practice_moves').get().n, 0);
  } finally { db.close(); }
});
