'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { scryptSync } = require('node:crypto');
const { openDatabase } = require('../db');
const { GameService } = require('../game_service');
const { PasswordService, normalizeUsername, validPassword, PARAMETERS } = require('../password_service');
const PASSWORD = 'local-test-password-42';
function fixture(t) {
  const db = openDatabase(':memory:');
  t.after(() => db.close());
  const game = new GameService(db);
  return { db, game, passwords: new PasswordService(db, game) };
}
function noSecrets(user) {
  assert.deepEqual(Object.keys(user).sort(), ['id', 'auth_provider', 'username', 'avatar_url', 'current_level'].sort());
}
test('strict ASCII usernames canonicalize case/outer whitespace without Unicode aliasing', () => {
  for (const [input, expected] of [['  Cat_123  ', 'cat_123'], ['a'.repeat(24), 'a'.repeat(24)], ['123', '123']]) {
    assert.equal(normalizeUsername(input), expected);
  }
  for (const input of [undefined, null, {}, [], 123, '', 'ab', 'a'.repeat(25), 'a b', 'a-b', 'a.b', '猫友', 'Kat', 'ｃａｔ', 'a\0b', 'cat\nx']) {
    assert.equal(normalizeUsername(input), null, String(input));
  }
  for (const input of ['a'.repeat(12), 'a'.repeat(128), '密码'.repeat(10), 'hello world 123']) assert.equal(validPassword(input), true);
  for (const input of [undefined, null, {}, 123, '', 'short', 'a'.repeat(129), '密'.repeat(43), ' valid-password', 'valid-password ', 'valid\npassword', 'valid\0password', 'valid\x7fpassword', 'valid-password-\ud800']) {
    assert.equal(validPassword(input), false, String(input));
  }
});
test('scrypt hashes have unique random salts, explicit parameters, no plaintext and stable login IDs', async t => {
  const { db, passwords } = fixture(t);
  const first = await passwords.register({ username: '  Mixed_Cat ', password: PASSWORD });
  const second = await passwords.register({ username: 'other_cat', password: PASSWORD });
  const rows = db.prepare('SELECT * FROM password_credentials ORDER BY user_id').all();
  for (const row of rows) {
    for (const [key, value] of Object.entries(PARAMETERS)) assert.equal(row[key], value);
    assert.match(row.salt, /^[a-f0-9]{32}$/);
    assert.match(row.password_hash, /^[a-f0-9]{128}$/);
    assert.equal(row.password_hash, scryptSync(PASSWORD, Buffer.from(row.salt, 'hex'), row.key_length, {
      N: row.cost, r: row.block_size, p: row.parallelism, maxmem: 64 * 1024 * 1024,
    }).toString('hex'));
    assert.ok(!JSON.stringify(row).includes(PASSWORD));
  }
  assert.notEqual(rows[0].salt, rows[1].salt);
  assert.notEqual(rows[0].password_hash, rows[1].password_hash);
  assert.notEqual(first.id, second.id);
  assert.equal((await passwords.login({ username: ' MIXED_CAT ', password: PASSWORD })).id, first.id);
  assert.equal(first.auth_provider, 'password');
  noSecrets(first);
  noSecrets(await passwords.login({ username: 'other_cat', password: PASSWORD }));
});
test('registration never links a same-named provider and case-insensitive duplicates are atomic', async t => {
  const { db, passwords } = fixture(t);
  const github = Number(db.prepare("INSERT INTO users(auth_provider,open_id,username,created_at,updated_at) VALUES('github','123','catadmin',1,1)").run().lastInsertRowid);
  const results = await Promise.allSettled([
    passwords.register({ username: ' CatAdmin ', password: PASSWORD }),
    passwords.register({ username: 'CATADMIN', password: PASSWORD }),
  ]);
  const success = results.find(r => r.status === 'fulfilled').value;
  assert.notEqual(success.id, github);
  assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
  assert.equal(results.find(r => r.status === 'rejected').reason.code, 'USERNAME_UNAVAILABLE');
  assert.equal(db.prepare('SELECT COUNT(*) n FROM users').get().n, 2);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM password_credentials').get().n, 1);
  assert.equal(db.prepare('SELECT current_level FROM users WHERE id=?').get(github).current_level, 1);
});
test('credential insert failure rolls back the identity, and registration validation never writes', async t => {
  const { db, passwords } = fixture(t);
  for (const input of [{ username: 'ab', password: PASSWORD }, { username: 'validcat', password: 'short' }]) {
    await assert.rejects(passwords.register(input), { status: 400 });
  }
  db.exec("CREATE TRIGGER reject_test_credentials BEFORE INSERT ON password_credentials BEGIN SELECT RAISE(ABORT,'fixture insert failure'); END");
  await assert.rejects(passwords.register({ username: 'validcat', password: PASSWORD }), /fixture insert failure/);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM users').get().n, 0);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM password_credentials').get().n, 0);
  db.exec('DROP TRIGGER reject_test_credentials');
  await passwords.register({ username: 'validcat', password: PASSWORD });
});
test('unknown, incorrect, malformed, and OAuth-only credentials share the same generic failure', async t => {
  const { db, passwords } = fixture(t);
  await passwords.register({ username: 'passwordcat', password: PASSWORD });
  db.prepare("INSERT INTO users(auth_provider,open_id,username,created_at,updated_at) VALUES('github','github-only','githubcat',1,1)").run();
  for (const input of [
    { username: 'passwordcat', password: 'wrong-password-long' },
    { username: 'missingcat', password: PASSWORD }, { username: 'githubcat', password: PASSWORD },
    { username: '!!invalid!!', password: PASSWORD }, { username: 'passwordcat', password: null },
    { username: 'passwordcat', password: PASSWORD.toUpperCase() },
  ]) await assert.rejects(passwords.login(input), { status: 401, code: 'INVALID_CREDENTIALS', message: '用户名或密码不正确' });
});
test('password users share official progress/leaderboards; guests remain excluded and identities isolated', async t => {
  const { db, game, passwords } = fixture(t);
  db.prepare(`INSERT INTO levels(id,size,region_map,solution,map_hash,seed,search_nodes,generation_attempts,created_at)
    VALUES(1,4,?,?,'fixture',1,1,1,1)`).run(JSON.stringify([1,0,0,2,1,0,2,2,1,3,2,2,1,3,2,2]), JSON.stringify([2,4,11,13]));
  const user = await passwords.register({ username: 'playercat', password: PASSWORD });
  const github = Number(db.prepare("INSERT INTO users(auth_provider,open_id,username,created_at,updated_at) VALUES('github','same','playercat',1,1)").run().lastInsertRowid);
  const guest = Number(db.prepare("INSERT INTO users(auth_provider,open_id,username,created_at,updated_at) VALUES('guest','guest','localcat',1,1)").run().lastInsertRowid);
  let now = 100000;
  game.now = () => now;
  for (const id of [user.id, github, guest]) {
    const { run } = game.start(id);
    now += 1500;
    game.submit(id, { runId: run.id, levelId: 1, cats: [2,4,11,13] });
  }
  const loggedIn = await passwords.login({ username: 'PLAYERCAT', password: PASSWORD });
  assert.equal(loggedIn.current_level, 2);
  assert.equal(game.levels(user.id).levels[0].status, 'completed');
  const board = game.leaderboard();
  assert.equal(board.total, 2);
  assert.deepEqual(board.rows.map(r => r.id).sort(), [user.id, github].sort());
  assert.ok(board.rows.every(r => r.cleared === 1));
  assert.equal(game.top(1).length, 2);
});
test('malformed stored hashes and unsupported work factors fail closed without unbounded scrypt work', async t => {
  const { db, passwords } = fixture(t);
  const user = await passwords.register({ username: 'storedcat', password: PASSWORD });
  const original = db.prepare('SELECT * FROM password_credentials WHERE user_id=?').get(user.id);
  // Synthetic fixture corruption only: the normal schema rejects these writes.
  db.exec('PRAGMA ignore_check_constraints=ON');
  for (const [column, value] of [['algorithm','unknown'], ['cost', 1073741824], ['block_size', 2147483647],
    ['parallelism', 2147483647], ['key_length', 2147483647], ['salt', 'not-hex'], ['password_hash', 'short']]) {
    db.prepare(`UPDATE password_credentials SET ${column}=? WHERE user_id=?`).run(value, user.id);
    await assert.rejects(passwords.login({ username: 'storedcat', password: PASSWORD }), {
      status: 401, code: 'INVALID_CREDENTIALS', message: '用户名或密码不正确',
    });
    db.prepare(`UPDATE password_credentials SET ${column}=? WHERE user_id=?`).run(original[column], user.id);
  }
  db.exec('PRAGMA ignore_check_constraints=OFF');
  assert.equal((await passwords.login({ username: 'storedcat', password: PASSWORD })).id, user.id);
});
