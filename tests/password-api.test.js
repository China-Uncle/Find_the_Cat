'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { once } = require('node:events');
const { randomBytes, randomUUID, createHash } = require('node:crypto');
const jwt = require('jsonwebtoken');
const { openDatabase } = require('../db');
const { makeApp } = require('../server');
const PASSWORD = 'fixture password 123';
const WRONG_PASSWORD = 'fixture wrong password';
const ADMIN_SECRET = 'fixture-admin-key-not-a-real-credential';
const ANSWER = [2, 4, 11, 13];
const FETCH_BLOCKED_PORTS = new Set([
  1,7,9,11,13,15,17,19,20,21,22,23,25,37,42,43,53,69,77,79,87,95,101,102,103,104,109,110,111,113,
  115,117,119,123,135,137,139,143,161,179,389,427,465,512,513,514,515,526,530,531,532,540,548,554,
  556,563,587,601,636,989,990,993,995,1719,1720,1723,2049,3659,4045,4190,5060,5061,6000,6566,
  6665,6666,6667,6668,6669,6679,6697,10080,
]);
function noSecrets(value) {
  for (const [key, item] of Object.entries(value || {})) {
    assert.ok(!/password|salt|scrypt|^cost$|block_size|parallelism|key_length|open_id/i.test(key), `leaked ${key}`);
    if (item && typeof item === 'object') noSecrets(item);
  }
}
async function fixture(t, overrides = {}) {
  const db = openDatabase(':memory:');
  let app, server;
  t.after(async () => {
    try { if (server?.listening) await new Promise((resolve, reject) => server.close(e => e ? reject(e) : resolve())); }
    finally { try { if (app) await app.locals.close(); } finally { db.close(); } }
  });
  for (const id of [1,2]) db.prepare(`INSERT INTO levels
    (id,size,region_map,solution,map_hash,seed,search_nodes,generation_attempts,created_at)
    VALUES(?,4,?,?,?,1,1,1,1)`).run(id, JSON.stringify([1,0,0,2,1,0,2,2,1,3,2,2,1,3,2,2]), JSON.stringify(ANSWER), 'fixture-'+id);
  let now = 100000;
  const secret = randomBytes(48).toString('hex');
  const upstream = [];
  let profile = { id: 123, login: 'CatAdmin' };
  const env = {
    NODE_ENV: 'test', PUBLIC_URL: 'http://localhost:3000', JWT_SECRET: secret,
    GITHUB_CLIENT_ID: 'fixture-public-client', GITHUB_CLIENT_SECRET: 'fixture-not-a-real-secret',
    GITHUB_CALLBACK_PATH: '/api/auth/github/callback', ALLOW_GUEST_LOGIN: 'true', TRUST_PROXY_HOPS: '0',
    ADMIN_GITHUB_USERNAME: ' cAtAdMiN ', ADMIN_GITHUB_USERNAMES: ' second_admin ', ADMIN_SECRET,
    ...overrides,
  };
  app = makeApp({ db, env, fetch: async (url, options) => {
    upstream.push({ url, options });
    if (url === 'https://github.com/login/oauth/access_token') return { ok: true, json: async () => ({ access_token: 'fixture-upstream-access' }) };
    assert.equal(url, 'https://api.github.com/user');
    return { ok: true, json: async () => profile };
  } });
  app.locals.service.now = () => now;
  do {
    server = app.listen(0, '127.0.0.1');
    await once(server, 'listening');
    if (!FETCH_BLOCKED_PORTS.has(server.address().port)) break;
    await new Promise(resolve => server.close(resolve));
  } while (true);
  const base = `http://127.0.0.1:${server.address().port}`;
  async function request(endpoint, body, { token, method, headers = {}, raw } = {}) {
    const response = await fetch(base+endpoint, {
      method: method || (body === undefined && raw === undefined ? 'GET' : 'POST'), redirect: 'manual',
      headers: { ...(body === undefined && raw === undefined ? {} : { 'Content-Type': 'application/json' }),
        ...(token ? { Authorization: 'Bearer '+token } : {}), ...headers },
      body: raw !== undefined ? raw : body === undefined ? undefined : JSON.stringify(body),
    });
    const data = response.status === 303 ? null : await response.json();
    return { status: response.status, data, headers: response.headers };
  }
  const register = username => request('/api/auth/register', { username, password: PASSWORD });
  const login = (username, password = PASSWORD) => request('/api/auth/login', { username, password });
  async function github(loginName = 'CatAdmin', id = 123) {
    profile = { id, login: loginName };
    const browserSecret = randomBytes(32).toString('hex');
    const hash = createHash('sha256').update(browserSecret).digest('hex');
    const start = await request('/api/auth/github/start?browser_hash='+hash);
    assert.equal(start.status, 200);
    const provider = new URL(start.data.url);
    assert.equal(provider.searchParams.get('code_challenge_method'), 'S256');
    assert.equal(provider.searchParams.get('redirect_uri'), env.PUBLIC_URL+'/api/auth/github/callback');
    const state = provider.searchParams.get('state');
    const callback = '/api/auth/github/callback?state='+state+'&code=fixture-code';
    const redirect = await request(callback);
    assert.equal(redirect.status, 303);
    const location = new URL(redirect.headers.get('location'));
    assert.ok(!location.href.includes('fixture-upstream-access'));
    const ticket = new URLSearchParams(location.hash.slice(1)).get('login_ticket');
    assert.ok(ticket);
    const result = await request('/api/auth/exchange', { ticket, browserSecret });
    assert.equal(result.status, 200);
    return { ...result, callback, ticket, browserSecret };
  }
  return { db, app, request, register, login, github, upstream, secret, advance: ms => { now += ms; } };
}
test('register/login use existing JWT subject/provider and /me; private credentials never leave the API', async t => {
  const f = await fixture(t);
  const config = await f.request('/api/config');
  assert.equal(config.data.passwordLogin, true);
  assert.equal(config.data.githubLogin, true);
  assert.equal(config.data.guestLogin, true);
  const created = await f.register('  Player_Cat ');
  assert.equal(created.status, 201);
  assert.equal(created.headers.get('cache-control'), 'no-store');
  assert.equal(created.data.user.username, 'player_cat');
  assert.equal(created.data.user.auth_provider, 'password');
  assert.equal(created.data.user.isAdmin, false);
  assert.equal(created.data.user.isGuest, false);
  noSecrets(created.data.user);
  const claims = jwt.verify(created.data.accessToken, f.secret, {
    algorithms: ['HS256'], issuer: 'find-the-cat', audience: 'find-the-cat-web',
  });
  assert.equal(claims.sub, String(created.data.user.id));
  assert.equal(claims.provider, 'password');
  const logged = await f.login(' PLAYER_CAT ');
  assert.equal(logged.status, 200);
  assert.equal(logged.data.user.id, created.data.user.id);
  const me = await f.request('/api/me', undefined, { token: logged.data.accessToken });
  assert.equal(me.status, 200);
  assert.deepEqual(me.data.user, logged.data.user);
  noSecrets(me.data);
  assert.equal((await f.register('player_cat')).status, 409);
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM users').get().n, 1);
});
test('registration and API body validation reject malformed input without identity/credential writes', async t => {
  const f = await fixture(t);
  for (const body of [
    { username: 'ab', password: PASSWORD }, { username: 'Kat', password: PASSWORD },
    { username: 'validcat', password: ['array'] }, { username: 'validcat', password: PASSWORD+' ' },
    { username: 'validcat', password: '密'.repeat(43) },
  ]) assert.equal((await f.request('/api/auth/register', body)).status, 400);
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM users').get().n, 0);
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM password_credentials').get().n, 0);
  for (const endpoint of ['/api/auth/register', '/api/auth/login']) {
    for (const body of [null, [], 'string']) assert.equal((await f.request(endpoint, body)).status, 400);
    assert.equal((await f.request(endpoint, undefined, { raw: '{' })).status, 400);
    assert.equal((await f.request(endpoint, undefined, { method: 'POST' })).status, 400);
    assert.equal((await f.request(endpoint, { username: 'bigcat', password: 'a'.repeat(17000) })).status, 413);
    assert.equal((await f.request(endpoint, { username: 'validcat', password: PASSWORD }, { headers: { Origin: 'https://foreign.invalid' } })).status, 403);
  }
});
test('wrong, unknown, malformed, and GitHub-only login all return identical invalid-credentials errors', async t => {
  const f = await fixture(t);
  await f.register('passwordcat');
  f.db.prepare("INSERT INTO users(auth_provider,open_id,username,created_at,updated_at) VALUES('github','oauth-only','githubcat',1,1)").run();
  let expected;
  for (const [username, password] of [['passwordcat', WRONG_PASSWORD], ['missingcat', PASSWORD], ['githubcat', PASSWORD], ['!!!', PASSWORD], ['passwordcat', 'short'], [null, PASSWORD], ['passwordcat', {}]]) {
    const response = await f.login(username, password);
    assert.equal(response.status, 401);
    expected ||= response.data;
    assert.deepEqual(response.data, expected);
    assert.equal(response.data.code, 'INVALID_CREDENTIALS');
  }
  assert.equal((await f.login('passwordcat')).status, 200);
});
test('password users share official progress and public rankings with GitHub, while guest behavior stays unchanged', async t => {
  const f = await fixture(t);
  const password = await f.register('publiccat');
  const github = await f.github('OtherCat', 456);
  const guestId = randomUUID();
  const guest = await f.request('/api/auth/guest', { guestId, username: 'GuestCat' });
  assert.equal(guest.status, 200);
  assert.equal(guest.data.user.isGuest, true);
  assert.equal(guest.data.user.isAdmin, false);
  for (const session of [password.data, github.data, guest.data]) {
    const token = session.accessToken;
    const start = await f.request('/api/game/start', {}, { token });
    assert.equal(start.status, 200);
    f.advance(1700);
    const body = { runId: start.data.run.id, levelId: 1, cats: ANSWER };
    const score = await f.request('/api/game/submit', body, { token });
    assert.equal(score.status, 200);
    assert.equal(score.data.currentLevel, 2);
    const retry = await f.request('/api/game/submit', body, { token });
    assert.equal(retry.status, 200);
    assert.equal(retry.data.elapsedMs, score.data.elapsedMs);
    const levels = await f.request('/api/levels', undefined, { token });
    assert.equal(levels.data.levels[0].status, 'completed');
  }
  const again = await f.login('PUBLICCAT');
  assert.equal(again.data.user.id, password.data.user.id);
  assert.equal(again.data.user.current_level, 2);
  const guestAgain = await f.request('/api/auth/guest', { guestId, username: 'GuestRenamed' });
  assert.equal(guestAgain.data.user.id, guest.data.user.id);
  assert.equal(guestAgain.data.user.current_level, 2);
  const leaderboard = await f.request('/api/leaderboard');
  assert.equal(leaderboard.data.total, 2);
  assert.deepEqual(leaderboard.data.rows.map(row => row.id).sort(), [password.data.user.id, github.data.user.id].sort());
  assert.ok(leaderboard.data.rows.every(row => row.cleared === 1));
  noSecrets(leaderboard.data);
  assert.equal((await f.request('/api/levels/1/top3')).data.rows.length, 2);
});
test('same-named password and GitHub accounts never link; only GitHub allowlists grant admin', async t => {
  const f = await fixture(t);
  const password = await f.register('CatAdmin');
  const oauth = await f.github();
  assert.notEqual(password.data.user.id, oauth.data.user.id);
  assert.equal(password.data.user.isAdmin, false);
  assert.equal(oauth.data.user.isAdmin, true);
  const additional = await f.github('SECOND_ADMIN', 777);
  assert.equal(additional.data.user.isAdmin, true);
  const ordinary = await f.github('OtherCat', 778);
  assert.equal(ordinary.data.user.isAdmin, false);
  const otherName = await f.register('othercat');
  assert.notEqual(otherName.data.user.id, ordinary.data.user.id);
  const passwordToken = password.data.accessToken;
  // A misleading provider claim cannot grant GitHub privileges: auth reloads identity.
  const forgedProvider = jwt.sign({ sub: String(password.data.user.id), provider: 'github' }, f.secret, {
    algorithm: 'HS256', issuer: 'find-the-cat', audience: 'find-the-cat-web', expiresIn: '1h',
  });
  for (const token of [passwordToken, forgedProvider]) {
    for (const action of ['start', 'move', 'complete', 'submit']) {
      assert.equal((await f.request('/api/admin/practice/'+action, {}, { token })).status, 403);
    }
    assert.equal((await f.request('/api/admin/generate-levels', { count: 1 }, { token, headers: { 'X-Admin-Secret': ADMIN_SECRET } })).status, 403);
    assert.equal((await f.request('/api/admin/generation-jobs/fixture', undefined, { token })).status, 403);
  }
  assert.equal((await f.request('/api/admin/practice/start', { levelId: 2 }, { token: oauth.data.accessToken })).status, 200);
  // Preserve the additional admin-secret requirement without launching a worker.
  assert.equal((await f.request('/api/admin/generate-levels', { count: 1 }, { token: oauth.data.accessToken })).status, 403);
  assert.equal((await f.login('catadmin')).data.user.id, password.data.user.id);
  const renamed = await f.github('RenamedCat', 123);
  assert.equal(renamed.data.user.id, oauth.data.user.id);
  assert.equal(renamed.data.user.isAdmin, false);
  assert.equal((await f.request('/api/me', undefined, { token: oauth.data.accessToken })).data.user.isAdmin, false);
  assert.equal((await f.request('/api/auth/exchange', { ticket: oauth.ticket, browserSecret: oauth.browserSecret })).status, 401);
  assert.equal(f.db.prepare("SELECT COUNT(*) n FROM users WHERE auth_provider='password'").get().n, 2);
});
test('GitHub exchange remains browser-bound, single-use and PKCE-protected', async t => {
  const f = await fixture(t);
  const browserSecret = randomBytes(32).toString('hex');
  const browserHash = createHash('sha256').update(browserSecret).digest('hex');
  const start = await f.request('/api/auth/github/start?browser_hash='+browserHash);
  const state = new URL(start.data.url).searchParams.get('state');
  const callbackPath = '/api/auth/github/callback?state='+state+'&code=fixture-code';
  const callback = await f.request(callbackPath);
  const ticket = new URLSearchParams(new URL(callback.headers.get('location')).hash.slice(1)).get('login_ticket');
  assert.ok(ticket);
  const bad = await f.request('/api/auth/exchange', { ticket, browserSecret: 'x'.repeat(64) });
  assert.equal(bad.status, 401);
  const good = await f.request('/api/auth/exchange', { ticket, browserSecret });
  assert.equal(good.status, 200);
  assert.equal((await f.request('/api/auth/exchange', { ticket, browserSecret })).status, 401);
  const replay = await f.request(callbackPath);
  assert.match(replay.headers.get('location'), /#auth_error=/);
  const tokenRequest = f.upstream.find(item => item.url.endsWith('/access_token'));
  assert.ok(JSON.parse(tokenRequest.options.body).code_verifier);
  noSecrets(good.data.user);
});
test('password login is available in production while guest login remains forbidden', async t => {
  const f = await fixture(t, { NODE_ENV: 'production', PUBLIC_URL: 'https://cat-fixture.invalid', ALLOW_GUEST_LOGIN: 'true' });
  const config = await f.request('/api/config');
  assert.equal(config.data.passwordLogin, true);
  assert.equal(config.data.guestLogin, false);
  assert.equal((await f.request('/api/auth/guest', { guestId: randomUUID(), username: 'guestcat' })).status, 403);
  assert.equal((await f.register('production_fixture')).status, 201);
  assert.equal((await f.login('production_fixture')).status, 200);
});
test('normalized account rate limit cannot be bypassed by case/whitespace; registration and rotating-name IP budgets apply', async t => {
  const f = await fixture(t);
  await f.register('ratecat');
  for (let index = 0; index < 10; index++) {
    assert.equal((await f.login(index % 2 ? ' RATECAT ' : 'ratecat', 'short')).status, 401);
  }
  const blocked = await f.login('RateCat');
  assert.equal(blocked.status, 429);
  assert.ok(Number(blocked.headers.get('retry-after')) > 0);
  for (let index = 0; index < 4; index++) assert.equal((await f.request('/api/auth/register', {})).status, 400);
  assert.equal((await f.register('newcat')).status, 429);
  const g = await fixture(t);
  for (let index = 0; index < 30; index++) {
    assert.equal((await g.login('rotating_'+index, 'short')).status, 401);
  }
  const ipBlocked = await g.login('another_rotating_cat');
  assert.equal(ipBlocked.status, 429);
  assert.ok(Number(ipBlocked.headers.get('retry-after')) > 0);
});
test('per-account limits span IPs and spoofed forwarding headers are ignored unless explicitly trusted', async t => {
  const f = await fixture(t, { TRUST_PROXY_HOPS: '1' });
  for (let index = 0; index < 10; index++) {
    const result = await f.request('/api/auth/login', { username: index % 2 ? ' ACCOUNT_CAT ' : 'account_cat', password: 'short' },
      { headers: { 'X-Forwarded-For': `192.0.2.${index+1}` } });
    assert.equal(result.status, 401);
  }
  assert.equal((await f.request('/api/auth/login', { username: 'account_cat', password: PASSWORD },
    { headers: { 'X-Forwarded-For': '192.0.2.200' } })).status, 429);
  const g = await fixture(t);
  for (let index = 0; index < 30; index++) {
    assert.equal((await g.request('/api/auth/login', { username: 'different_'+index, password: 'short' },
      { headers: { 'X-Forwarded-For': `192.0.2.${index+1}` } })).status, 401);
  }
  assert.equal((await g.login('yet_another_cat')).status, 429);
});
test('concurrent duplicate registration creates only one identity and one credential row', async t => {
  const f = await fixture(t);
  const replies = await Promise.all([f.register('RaceCat'), f.register(' RACECAT ')]);
  assert.deepEqual(replies.map(r => r.status).sort(), [201, 409]);
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM users').get().n, 1);
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM password_credentials').get().n, 1);
});
test('registration persistence failures are atomic and do not leak credentials or leave auth capacity locked', async t => {
  const f = await fixture(t);
  f.db.exec("CREATE TRIGGER fail_fixture_registration BEFORE INSERT ON password_credentials BEGIN SELECT RAISE(ABORT,'fixture failure'); END");
  const failed = await f.register('rollbackcat');
  assert.equal(failed.status, 500);
  assert.equal(failed.data.error, '服务暂时不可用');
  assert.ok(!JSON.stringify(failed.data).includes(PASSWORD));
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM users').get().n, 0);
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM password_credentials').get().n, 0);
  f.db.exec('DROP TRIGGER fail_fixture_registration');
  assert.equal((await f.register('rollbackcat')).status, 201);
  assert.equal((await f.login('rollbackcat')).status, 200);
});
