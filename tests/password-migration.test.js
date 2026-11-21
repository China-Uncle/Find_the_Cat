'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { openDatabase, initializeSchema } = require('../db');
const tables = ['users', 'levels', 'runs', 'run_moves', 'completions', 'practice_runs', 'practice_moves', 'oauth_flows', 'login_tickets', 'generation_jobs'];
const snapshot = db => Object.fromEntries(tables.map(table => [table, db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()]));
function legacy(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cat-password-migration-'));
  const file = path.join(dir, 'fixture.sqlite');
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const db = new DatabaseSync(file);
  const current = fs.readFileSync(path.join(__dirname, '../schema.sql'), 'utf8');
  const old = current.split('-- Password secrets')[0].replace("'wechat','password'", "'wechat'");
  db.exec(old + '\nPRAGMA user_version=1;');
  for (const provider of ['github', 'guest', 'wechat']) {
    db.prepare('INSERT INTO users(auth_provider,open_id,username,current_level,created_at,updated_at) VALUES(?,?,?,2,1,2)').run(provider, provider, 'samecat');
  }
  db.exec(`INSERT INTO levels VALUES(1,4,'[0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0]','[2,4,11,13]','hash',1,1,1,1);
    INSERT INTO runs(id,user_id,level_id,started_at,expires_at) VALUES('run',1,1,1,1000);
    INSERT INTO run_moves VALUES('run','move',2,'place','{}');
    INSERT INTO practice_runs(id,user_id,level_id,started_at,expires_at) VALUES('practice',1,1,1,1000);
    INSERT INTO practice_moves VALUES('practice','move',2,'place','{}');
    INSERT INTO completions VALUES(1,1,1000,1000,'completed-run');
    INSERT INTO oauth_flows VALUES('state','browser','verifier',1000);
    INSERT INTO login_tickets VALUES('ticket','browser',1,1000);
    INSERT INTO generation_jobs(id,requested,status,owner,created_at,updated_at) VALUES('job',1,'done','fixture',1,2);
    CREATE INDEX custom_users_name ON users(username);
    CREATE TRIGGER custom_username_guard BEFORE UPDATE OF username ON users WHEN NEW.username='' BEGIN SELECT RAISE(ABORT,'empty name'); END;`);
  return { db, file };
}
test('legacy migration is additive: identities, progress, runs, OAuth state and FKs survive repeated opens', t => {
  let { db, file } = legacy(t);
  const before = snapshot(db);
  db.close();
  for (let attempt = 0; attempt < 3; attempt++) {
    db = openDatabase(file);
    try {
      assert.deepEqual(snapshot(db), before);
      assert.equal(db.prepare('PRAGMA user_version').get().user_version, 2);
      assert.equal(db.prepare('PRAGMA foreign_keys').get().foreign_keys, 1);
      assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
      assert.ok(db.prepare("SELECT 1 FROM sqlite_schema WHERE name='custom_users_name'").get());
      assert.throws(() => db.exec("UPDATE users SET username='' WHERE id=1"), /empty name/);
      assert.throws(() => db.exec("INSERT INTO login_tickets VALUES('bad','hash',999,1)"), /FOREIGN KEY/);
      assert.throws(() => db.exec("INSERT INTO users(auth_provider,open_id,username,created_at,updated_at) VALUES('github','github','duplicate',1,1)"), /UNIQUE/);
      assert.equal(db.prepare('SELECT COUNT(*) n FROM password_credentials').get().n, 0);
    } finally { db.close(); }
  }
  db = openDatabase(file);
  try {
    const id = db.prepare("INSERT INTO users(auth_provider,open_id,username,created_at,updated_at) VALUES('password','new-random-id','samecat',1,1)").run().lastInsertRowid;
    const insert = db.prepare("INSERT INTO password_credentials VALUES(?,?,'scrypt',32768,8,1,64,?,?)");
    insert.run(id, 'samecat', 'a'.repeat(32), 'b'.repeat(128));
    assert.throws(() => insert.run(1, 'othercat', 'c'.repeat(32), 'd'.repeat(128)), /password identity/);
    assert.throws(() => db.exec("UPDATE password_credentials SET user_id=1"), /password identity/);
    assert.throws(() => db.prepare("UPDATE users SET auth_provider='github' WHERE id=?").run(id), /password identity/);
    assert.throws(() => db.exec("UPDATE password_credentials SET username='UPPERCASE'"), /CHECK/);
    db.prepare('DELETE FROM users WHERE id=?').run(id);
    assert.equal(db.prepare('SELECT COUNT(*) n FROM password_credentials').get().n, 0);
    db.exec('DELETE FROM users WHERE id=1');
    for (const table of ['runs', 'run_moves', 'completions', 'practice_runs', 'practice_moves', 'login_tickets']) {
      assert.equal(db.prepare(`SELECT COUNT(*) n FROM ${table}`).get().n, 0, table);
    }
  } finally { db.close(); }
});
test('migration failure rolls back schema and data; foreign key enforcement is restored', t => {
  const { db } = legacy(t);
  t.after(() => db.close());
  db.exec("PRAGMA foreign_keys=OFF; INSERT INTO login_tickets VALUES('orphan','hash',999,1); PRAGMA foreign_keys=ON;");
  const before = snapshot(db);
  assert.throws(() => initializeSchema(db), /foreign key check failed/);
  assert.deepEqual(snapshot(db), before);
  assert.equal(db.prepare('PRAGMA user_version').get().user_version, 1);
  assert.equal(db.prepare('PRAGMA foreign_keys').get().foreign_keys, 1);
  assert.throws(() => db.exec("INSERT INTO users(auth_provider,open_id,username,created_at,updated_at) VALUES('password','bad','newcat',1,1)"), /CHECK/);
  db.exec("DELETE FROM login_tickets WHERE ticket_hash='orphan'");
  const repaired = snapshot(db);
  initializeSchema(db);
  assert.deepEqual(snapshot(db), repaired);
});
test('fresh initialization is idempotent and does not downgrade newer schema versions', t => {
  const db = openDatabase(':memory:');
  t.after(() => db.close());
  const before = db.prepare('SELECT type,name,sql FROM sqlite_schema ORDER BY name').all();
  db.exec('PRAGMA user_version=7');
  initializeSchema(db);
  initializeSchema(db);
  assert.deepEqual(db.prepare('SELECT type,name,sql FROM sqlite_schema ORDER BY name').all(), before);
  assert.equal(db.prepare('PRAGMA user_version').get().user_version, 7);
});
