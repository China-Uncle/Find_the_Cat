'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createHarness, html, level, run, plain } = require('./helpers/frontend-harness');

const USER = Object.freeze({ id: 42, username: 'Fixture', isAdmin: false, isGuest: false });
const CONFIG = Object.freeze({ githubLogin: true, guestLogin: false, totalLevels: 237 });
const urls = h => h.requests.map(request => request.url);

function responder({ config = {}, user = {}, savedRun = {}, extra } = {}) {
  return request => {
    if (extra) {
      const response = extra(request);
      if (response !== undefined) return response;
    }
    if (request.url === '/api/config') return { body: { ...CONFIG, ...config } };
    if (request.url === '/api/me') return { body: { user: { ...USER, ...user } } };
    if (['/api/game/start', '/api/admin/practice/start'].includes(request.url)) {
      return { body: { level: level(), run: run(savedRun) } };
    }
    throw new Error(`Unexpected fixture request: ${request.method} ${request.url}`);
  };
}

function assertWelcome(h) {
  assert.equal(h.node('welcome').hidden, false);
  assert.equal(h.node('app').classList.contains('welcome-mode'), true);
  assert.equal(h.node('app').classList.contains('auth-pending'), false);
  assert.equal(h.node('tutorial').hidden, true);
  assert.equal(h.node('account').hidden, true);
  assert.equal(h.UI.account, null);
  assert.equal(h.UI.engine?.level ?? null, null);
  assert.equal(h.UI.engine?.run ?? null, null);
  assert.equal(h.intervals.size, 0);
}

function assertPlaying(h) {
  assert.equal(h.node('welcome').hidden, true);
  assert.equal(h.node('app').classList.contains('welcome-mode'), false);
  assert.equal(h.node('app').classList.contains('auth-pending'), false);
  assert.equal(h.UI.engine.status, 'playing');
  assert.equal(h.UI.engine.level.id, 1);
  assert.equal(h.node('board').children.length, 16);
  assert.equal(h.intervals.size, 1);
}

test('boot with no token and guest disabled presents welcome without authenticating or starting a run', async () => {
  const h = createHarness({ respond: responder() });
  assert.equal(h.node('app').classList.contains('auth-pending'), true);
  await h.boot();
  assertWelcome(h);
  assert.deepEqual(urls(h), ['/api/config']);
  assert.equal(h.node('board').children.length, 0);
  assert.equal(h.node('welcomeLogin').disabled, false);
  assert.equal(h.node('welcomeGuest').hidden, true);
  assert.equal(h.node('welcomeConfig').hidden, true);
  assert.ok(h.node('welcomeLevels').textContent.includes('237'));
});

test('boot with a valid existing token initializes account and resumes same-run marks and skip', async () => {
  const marks = Array(16).fill(0);
  marks[8] = marks[12] = 1; marks[13] = 2;
  const storage = new Map([
    ['findcat:token', 'fixture-existing-token'],
    ['findcat:local-run:42:normal', JSON.stringify({
      version: 1, runId: 'fixture-run', levelId: 1, size: 4, revision: 7,
      regions: level().regions.join(','), marks, hearts: 2,
      tutorial: { version: 1, skipped: true },
    })],
  ]);
  const h = createHarness({ storage, respond: responder({ config: { guestLogin: true } }) });
  await h.boot();
  assertPlaying(h);
  assert.equal(h.UI.account.id, 42);
  assert.equal(h.UI.engine.hearts, 2);
  assert.deepEqual(plain(h.UI.engine.marks), marks);
  assert.equal(h.UI.tutorial.active, false);
  assert.equal(storage.get('findcat:token'), 'fixture-existing-token');
  assert.ok(urls(h).includes('/api/me'));
  assert.ok(!urls(h).includes('/api/auth/guest'));
  const start = h.requests.find(request => request.url === '/api/game/start');
  assert.deepEqual(start.body, { restart: false });
  assert.equal(start.headers.Authorization, 'Bearer fixture-existing-token');
});

test('boot with no token and guest enabled automatically authenticates and loads without a click or prompt', async () => {
  const h = createHarness({
    storage: new Map([['findcat:guest-id', 'fixture-guest-id']]),
    respond: responder({
      config: { guestLogin: true },
      extra: request => {
        if (request.url !== '/api/auth/guest') return;
        assert.equal(request.method, 'POST');
        assert.deepEqual(request.body, { username: '本地猫友', guestId: 'fixture-guest-id' });
        return { body: { accessToken: 'fixture-guest-token', user: { ...USER, isGuest: true } } };
      },
    }),
  });
  await h.boot();
  assertPlaying(h);
  assert.equal(h.storage.get('findcat:token'), 'fixture-guest-token');
  assert.equal(h.UI.account.isGuest, true);
  assert.equal(urls(h).filter(url => url === '/api/auth/guest').length, 1);
  assert.ok(urls(h).indexOf('/api/auth/guest') < urls(h).indexOf('/api/game/start'));
  assert.equal(h.requests.find(request => request.url === '/api/game/start').headers.Authorization, 'Bearer fixture-guest-token');
  assert.equal(h.UI.tutorial.step, 1);
});

test('automatic guest boot creates and persists its guest identity when none exists', async () => {
  const h = createHarness({
    respond: responder({
      config: { guestLogin: true },
      extra: request => request.url === '/api/auth/guest' ? {
        body: { accessToken: 'fixture-guest-token', user: { ...USER, isGuest: true } },
      } : undefined,
    }),
  });
  await h.boot();
  const guestId = h.storage.get('findcat:guest-id');
  assert.match(guestId, /^[a-f\d-]{36}$/);
  assert.equal(h.requests.find(request => request.url === '/api/auth/guest').body.guestId, guestId);
  assertPlaying(h);
});

test('existing administrator token restores saved practice mode through initialize rather than guest boot', async () => {
  const storage = new Map([
    ['findcat:token', 'fixture-admin-token'],
    ['findcat:active-mode:42', JSON.stringify({ mode: 'practice', levelId: 1 })],
  ]);
  const h = createHarness({ storage, respond: responder({ config: { guestLogin: true }, user: { isAdmin: true } }) });
  await h.boot();
  assertPlaying(h);
  assert.equal(h.UI.mode, 'practice');
  assert.equal(h.UI.tutorial.active, true);
  assert.ok(!urls(h).includes('/api/game/start'));
  assert.ok(!urls(h).includes('/api/auth/guest'));
  assert.deepEqual(h.requests.find(request => request.url === '/api/admin/practice/start').body, { restart: false, levelId: 1 });
});

test('OAuth login_ticket has priority over existing token and automatic guest boot', async () => {
  const h = createHarness({
    hash: '#login_ticket=fixture-oauth-ticket',
    storage: new Map([['findcat:token', 'fixture-old-token']]),
    respond: responder({
      config: { guestLogin: true },
      extra: request => {
        if (request.url !== '/api/auth/exchange') return;
        assert.equal(request.method, 'POST');
        assert.equal(request.body.ticket, 'fixture-oauth-ticket');
        assert.match(request.body.browserSecret, /^[a-f\d]{64}$/);
        return { body: { accessToken: 'fixture-exchanged-token' } };
      },
    }),
  });
  await h.boot();
  assertPlaying(h);
  assert.equal(h.location.hash, '');
  assert.equal(h.storage.get('findcat:token'), 'fixture-exchanged-token');
  assert.ok(urls(h).indexOf('/api/auth/exchange') < urls(h).indexOf('/api/me'));
  assert.ok(!urls(h).includes('/api/auth/guest'));
  assert.equal(h.requests.find(request => request.url === '/api/me').headers.Authorization, 'Bearer fixture-exchanged-token');
});

test('OAuth auth_error is handled before account initialization or automatic guest authentication', async () => {
  const h = createHarness({
    hash: '#auth_error=fixture-denied',
    storage: new Map([['findcat:token', 'fixture-old-token']]),
    respond: responder({ config: { guestLogin: true } }),
  });
  await h.boot();
  assertWelcome(h);
  assert.deepEqual(urls(h), ['/api/config']);
  assert.equal(h.location.hash, '');
  assert.equal(h.node('toast').textContent, 'fixture-denied');
});

test('welcome level count is dynamic and invalid/unknown config never invents a count', () => {
  const h = createHarness();
  for (const totalLevels of [0, 1, 237, 12345]) {
    h.UI.config = { ...CONFIG, totalLevels };
    h.renderWelcomeConfig();
    assert.equal(h.node('welcomeSubtitle').textContent, `${totalLevels} 关逻辑挑战 · 全服冲榜`);
    assert.equal(h.node('welcomeLevels').textContent, `${totalLevels} 关独特谜题，和猫友一起挑战全服榜`);
  }
  for (const totalLevels of [undefined, null, -1, 1.5, '237', NaN, Infinity]) {
    h.UI.config = { ...CONFIG, totalLevels };
    h.renderWelcomeConfig();
    assert.equal(h.node('welcomeSubtitle').textContent, '逻辑推理 · 全服冲榜');
    assert.equal(h.node('welcomeLevels').textContent, '逻辑推理 · 全服冲榜');
  }
});

test('welcome GitHub and explicit guest controls follow independent login configuration flags', () => {
  const h = createHarness();
  for (const githubLogin of [false, true]) for (const guestLogin of [false, true]) {
    h.UI.config = { ...CONFIG, githubLogin, guestLogin };
    h.renderWelcomeConfig();
    assert.equal(h.node('welcomeLogin').disabled, !githubLogin);
    assert.equal(h.node('welcomeConfig').hidden, githubLogin);
    assert.equal(h.node('welcomeGuest').hidden, !guestLogin);
    if (!githubLogin) assert.ok(h.node('welcomeConfig').textContent.includes('GitHub 登录暂未开放'));
  }
  h.UI.config = null;
  h.renderWelcomeConfig();
  assert.equal(h.node('welcomeLogin').disabled, true);
  assert.equal(h.node('welcomeGuest').hidden, true);
  assert.ok(h.node('welcomeConfig').textContent.includes('暂未取得登录配置'));
});

test('disabled welcome actions cannot start an auth request even if clicked programmatically', async () => {
  const h = createHarness({ respond: responder({ config: { githubLogin: false, guestLogin: false } }) });
  await h.boot();
  h.node('welcomeLogin').onclick();
  h.node('welcomeGuest').onclick();
  assert.deepEqual(urls(h), ['/api/config']);
  assertWelcome(h);
});

test('enabled GitHub welcome action starts browser-bound login without creating a game run', async () => {
  const h = createHarness({
    respond: responder({ extra: request => request.url.startsWith('/api/auth/github/start?browser_hash=') ? {
      body: { url: '/fixture-oauth-provider' },
    } : undefined }),
  });
  await h.boot();
  // Invoke the real async handler directly; no external authorization/navigation.
  await h.evaluate('githubLogin()');
  assert.equal(h.navigations.length, 1);
  assert.equal(h.navigations[0], '/fixture-oauth-provider');
  assert.match(urls(h)[1], /^\/api\/auth\/github\/start\?browser_hash=[a-f\d]{64}$/);
  assert.ok(!urls(h).includes('/api/game/start'));
  assert.equal(h.UI.engine.run, null);
});

test('configuration failure can recover to a safe welcome view without starting a game', async () => {
  const h = createHarness({ respond: () => ({ status: 503, body: { error: 'fixture-config-unavailable' } }) });
  await assert.rejects(h.boot(), error => {
    assert.equal(error.status, 503);
    h.showError(error); // The real top-level boot().catch(showError) recovery.
    return true;
  });
  assertWelcome(h);
  assert.equal(h.node('welcomeLogin').disabled, true);
  assert.equal(h.node('welcomeGuest').hidden, true);
  assert.equal(h.node('toast').textContent, 'fixture-config-unavailable');
  assert.deepEqual(urls(h), ['/api/config']);
});

test('expired token during initialize clears credentials and stays welcome without guest fallback', async () => {
  const h = createHarness({
    storage: new Map([['findcat:token', 'fixture-expired-token'], ['findcat:user', '{}']]),
    respond: responder({
      config: { guestLogin: true },
      extra: request => request.url === '/api/me' ? { status: 401, body: { error: 'fixture-expired' } } : undefined,
    }),
  });
  await h.boot();
  assertWelcome(h);
  assert.equal(h.storage.has('findcat:token'), false);
  assert.equal(h.storage.has('findcat:user'), false);
  assert.ok(!urls(h).includes('/api/game/start'));
  assert.ok(!urls(h).includes('/api/auth/guest'));
});

test('401 during play saves draft, clears tutorial/input/timer state, and returns to welcome', async () => {
  const h = createHarness({
    storage: new Map([['findcat:token', 'fixture-playing-token'], ['findcat:user', '{}']]),
    respond: responder(),
  });
  await h.boot();
  await h.singleTap(8);
  h.UI.gesture = { id: 1, visited: new Set() };
  h.UI.lastTap = { cell: 8, time: 1000 };
  h.flagCellError(0);
  h.modal('Fixture', '<p>fixture dialog</p>');
  const beforeEpoch = h.UI.gameEpoch;
  h.setResponder(() => ({ status: 401, body: { error: 'fixture-expired' } }));
  await assert.rejects(h.PlatformAdapter.request('/api/fixture-protected'), error => error.status === 401);
  assertWelcome(h);
  assert.equal(h.UI.gameEpoch, beforeEpoch + 1);
  assert.equal(h.UI.tutorial, null);
  assert.equal(h.UI.gesture, null);
  assert.equal(h.UI.lastTap.cell, -1);
  assert.equal(h.UI.cellErrors.size, 0);
  assert.equal(h.node('modal').children.length, 0);
  assert.equal(h.UI.loading, false);
  assert.equal(h.UI.completeLock, false);
  assert.equal(h.storage.has('findcat:token'), false);
  const draft = JSON.parse(h.storage.get('findcat:local-run:42:normal'));
  assert.equal(draft.marks[8], 1);
  assert.equal(draft.runId, 'fixture-run');
});

test('logout returns to welcome, clears identity and in-memory progress, and does not auto-login a guest', async () => {
  const h = createHarness({
    storage: new Map([['findcat:token', 'fixture-playing-token'], ['findcat:user', '{}']]),
    respond: responder({ config: { guestLogin: true } }),
  });
  await h.boot();
  await h.singleTap(8);
  h.UI.mode = 'practice';
  h.UI.completionResult = { fixture: true };
  const before = h.requests.length;
  await h.logout();
  assertWelcome(h);
  assert.equal(h.UI.mode, 'normal');
  assert.equal(h.UI.drafts.size, 0);
  assert.equal(h.UI.completionResult, null);
  assert.equal(h.storage.has('findcat:token'), false);
  assert.equal(h.storage.has('findcat:user'), false);
  assert.deepEqual(urls(h).slice(before), ['/api/config']);
});

test('welcome state CSS hides gameplay controls and initial auth state does not flash an empty board', () => {
  // Structural checks are limited to styling/markup, which a pure VM cannot lay out.
  const rules = new Map();
  const css = html.match(/<style>([\s\S]*?)<\/style>/)[1].replace(/\/\*[\s\S]*?\*\//g, '');
  for (const match of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    for (const selector of match[1].trim().split(',')) {
      const declarations = Object.fromEntries(match[2].split(';').filter(Boolean).map(pair => {
        const colon = pair.indexOf(':');
        return [pair.slice(0, colon).trim(), pair.slice(colon + 1).replace(/!important/g, '').trim()];
      }));
      rules.set(selector.trim(), { ...rules.get(selector.trim()), ...declarations });
    }
  }
  for (const selector of [
    '.app.welcome-mode>.legend', '.app.welcome-mode>.tutorial', '.app.welcome-mode>.status',
    '.app.welcome-mode>.play', '.app.welcome-mode .brand', '.app.welcome-mode .hearts',
    '.app.welcome-mode .nav>:not(#rankBtn)', '.app.auth-pending>:not(.topbar)',
  ]) assert.equal(rules.get(selector)?.display, 'none', `controls must be hidden: ${selector}`);
  assert.equal(rules.get('.app.welcome-mode .welcome')?.display, 'flex');
  const h = createHarness();
  assert.equal(h.node('app').classList.contains('auth-pending'), true);
  assert.equal(h.node('welcome').hidden, true);
  assert.equal(h.node('welcomeLogin').disabled, true);
  assert.equal(h.node('welcomeGuest').hidden, true);
  assert.equal(h.node('welcome').attributes['aria-labelledby'], 'welcomeHeading');
});
