'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createHarness, level, run, html } = require('./helpers/frontend-harness');
const CONFIG = { githubLogin: true, passwordLogin: true, guestLogin: false, totalLevels: 2 };
const USER = { id: 99, auth_provider: 'password', username: 'testcat', isGuest: false, isAdmin: false };
const PASSWORD = 'local-test-password-42';
const submit = async h => h.node('passwordForm').onsubmit({ preventDefault() {} });
const open = (h, register = false) => h.evaluate(`showPasswordAuth(${register})`);
const fill = (h, username = ' TestCat ', password = PASSWORD) => {
  h.node('passwordUsername').value = username;
  h.node('passwordInput').value = password;
};
function fixture(options = {}) {
  return createHarness({ ...options, respond: options.respond || (request => {
    if (request.url === '/api/config') return { body: CONFIG };
    if (request.url === '/api/me') return { body: { user: USER } };
    if (request.url === '/api/game/start') return { body: { level: level(), run: run() } };
    throw new Error('unexpected request: ' + request.url);
  }) });
}
test('username/password entry coexists with GitHub, does not start a run while signed out, and is config guarded', async () => {
  const h = fixture();
  await h.boot();
  assert.equal(h.node('welcomePassword').disabled, false);
  assert.equal(h.node('welcomeLogin').disabled, false);
  h.node('welcomePassword').onclick();
  assert.match(h.node('modal').innerHTML, /用户名登录/);
  assert.match(h.node('modal').innerHTML, /autocomplete="current-password"/);
  assert.match(h.node('modal').innerHTML, /无需邮箱或验证码/);
  assert.match(h.node('modal').innerHTML, /不合并进度/);
  assert.deepEqual(h.requests.map(r => r.url), ['/api/config']);
  h.node('passwordSwitch').onclick();
  assert.match(h.node('modal').innerHTML, /注册用户名账号/);
  assert.match(h.node('modal').innerHTML, /autocomplete="new-password"/);
  assert.match(h.node('modal').innerHTML, /type="password"/);
  assert.match(h.node('modal').innerHTML, /role="alert"/);
  assert.ok(!/type="email"|verification/i.test(html));
  h.UI.config = { githubLogin: false, passwordLogin: false, guestLogin: false };
  h.renderWelcomeConfig();
  assert.equal(h.node('welcomePassword').disabled, true);
  h.evaluate('closeModal()');
  h.node('welcomePassword').onclick();
  assert.equal(h.node('modal').innerHTML, '');
});
test('registration stores only the JWT and starts the existing official game flow', async () => {
  const h = fixture();
  await h.boot();
  open(h, true);fill(h);
  h.setResponder(request => {
    if (request.url === '/api/auth/register') {
      assert.deepEqual(request.body, { username: 'testcat', password: PASSWORD });
      assert.equal(request.method, 'POST');
      return { status: 201, body: { accessToken: 'fixture-password-token', user: USER } };
    }
    assert.equal(request.url, '/api/game/start');
    assert.equal(request.headers.Authorization, 'Bearer fixture-password-token');
    return { body: { level: level(), run: run() } };
  });
  await submit(h);
  assert.equal(h.storage.get('findcat:token'), 'fixture-password-token');
  assert.ok([...h.storage.values()].every(value => !value.includes(PASSWORD)));
  assert.equal(h.UI.account.id, USER.id);
  assert.equal(h.UI.engine.run.id, 'fixture-run');
  assert.equal(h.node('adminBtn').hidden, true);
  assert.equal(h.node('modeBtn').hidden, true);
  assert.equal(h.node('welcome').hidden, true);
  assert.equal(h.node('passwordInput').value, '');
  assert.equal(h.node('modal').innerHTML, '');
});
test('strict form validation blocks malformed names and invalid passwords without sending HTTP', async () => {
  const h = fixture();await h.boot();open(h);
  for (const [username, password] of [['ab', PASSWORD], ['Kat', PASSWORD], ['cat name', PASSWORD], ['cat', 'short'], ['cat', PASSWORD+' '], ['cat', '密'.repeat(43)], ['cat', 'good\0password'], ['cat', 'valid-password\ud800']]) {
    fill(h, username, password);await submit(h);
    assert.ok(h.node('passwordError').textContent);
  }
  assert.deepEqual(h.requests.map(r => r.url), ['/api/config']);
});
test('invalid credentials and rate limits keep the form open and clear the password without removing an existing session', async () => {
  const h = fixture({ storage: new Map([['findcat:token', 'fixture-existing-token']]) });
  await h.boot();open(h);fill(h);
  for (const status of [401, 429]) {
    h.setResponder(request => {
      assert.equal(request.url, '/api/auth/login');
      return { status, body: { error: status === 401 ? '用户名或密码不正确' : '操作太快，请稍后再试' } };
    });
    await submit(h);
    assert.equal(h.storage.get('findcat:token'), 'fixture-existing-token');
    assert.equal(h.UI.account.id, USER.id);
    assert.equal(h.node('passwordInput').value, '');
    assert.equal(h.node('passwordSubmit').disabled, false);
    assert.ok(h.node('passwordError').textContent);
    assert.match(h.node('modal').innerHTML, /用户名登录/);
    fill(h);
  }
});
test('double submits send only one request, and a dismissed auth response cannot switch sessions', async () => {
  const h = fixture();await h.boot();open(h);fill(h);
  let resolve;
  h.setResponder(() => new Promise(done => { resolve = done; }));
  const pending = submit(h);
  assert.equal(h.node('passwordSubmit').disabled, true);
  await submit(h);
  assert.equal(h.requests.filter(r => r.url === '/api/auth/login').length, 1);
  h.evaluate('closeModal()');
  assert.equal(h.node('passwordInput').value, '');
  resolve({ body: { accessToken: 'fixture-stale-token', user: USER } });
  await pending;
  assert.equal(h.UI.account, null);
  assert.equal(h.storage.has('findcat:token'), false);
  assert.equal(h.UI.engine.run, null);
});
test('successful guest-to-password switch preserves the guest draft and never reuses its run or admin state', async () => {
  const guest = { id: 8, auth_provider: 'guest', username: 'localcat', isGuest: true, isAdmin: false };
  const h = fixture({ respond: request => {
    if (request.url === '/api/config') return { body: { ...CONFIG, guestLogin: true } };
    if (request.url === '/api/auth/guest') return { body: { accessToken: 'fixture-guest-token', user: guest } };
    if (request.url === '/api/game/start') return { body: { level: level(), run: run({ id: 'guest-run' }) } };
    throw new Error('unexpected request');
  } });
  await h.boot();h.UI.engine.applyMark(3, 1);
  h.node('accountBtn').onclick();fill(h);
  h.setResponder(request => {
    if (request.url === '/api/auth/login') return { body: { accessToken: 'fixture-password-token', user: USER } };
    assert.equal(request.url, '/api/game/start');
    return { body: { level: level(), run: run({ id: 'password-run' }) } };
  });
  await submit(h);
  assert.equal(h.UI.account.id, USER.id);
  assert.equal(h.UI.engine.run.id, 'password-run');
  assert.equal(h.UI.engine.marks[3], 0);
  assert.equal(JSON.parse(h.storage.get('findcat:local-run:8:normal')).runId, 'guest-run');
  assert.equal(h.UI.mode, 'normal');
});
test('password login resumes an existing saved account run and logout returns to welcome', async () => {
  const h = fixture();await h.boot();open(h);fill(h);
  h.setResponder(request => {
    if (request.url === '/api/auth/login') return { body: { accessToken: 'fixture-token', user: USER } };
    if (request.url === '/api/config') return { body: CONFIG };
    return { body: { level: level(), run: run({ id: 'persistent-password-run' }) } };
  });
  await submit(h);h.skipTutorial();h.UI.engine.applyMark(3, 1);h.saveLocalRun();
  await h.logout();
  assert.equal(h.node('welcome').hidden, false);
  assert.equal(h.UI.account, null);
  assert.equal(h.storage.has('findcat:token'), false);
  open(h);fill(h);await submit(h);
  assert.equal(h.UI.engine.run.id, 'persistent-password-run');
  assert.equal(h.UI.engine.marks[3], 1);
});
