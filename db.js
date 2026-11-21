'use strict';
const { DatabaseSync } = require('node:sqlite');
const fs = require('node:fs');
const path = require('node:path');
function resolveDatabase(file = process.env.DATABASE_PATH || './data/cats.sqlite') {
  return file === ':memory:' ? file : path.resolve(__dirname, file);
}
function openDatabase(file) {
  const target = resolveDatabase(file);
  if (target !== ':memory:') fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
  const db = new DatabaseSync(target);
  db.exec('PRAGMA busy_timeout=5000; PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL;');
  try { initializeSchema(db); return db; }
  catch (error) { db.close(); throw error; }
}
function transaction(db, fn) {
  db.exec('BEGIN IMMEDIATE');
  try { const result = fn(); db.exec('COMMIT'); return result; }
  catch (error) { db.exec('ROLLBACK'); throw error; }
}
// SQLite cannot widen a CHECK in place. Rebuild only users in a transaction,
// retaining every column, identity, user-defined index/trigger and child FK.
// Foreign keys MUST be disabled outside the transaction to avoid ON DELETE CASCADE.
function initializeSchema(db) {
  const schema = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
  const foreignKeys = db.prepare('PRAGMA foreign_keys').get().foreign_keys;
  db.exec('PRAGMA foreign_keys=OFF');
  try {
    transaction(db, () => {
      // Read after BEGIN IMMEDIATE so simultaneous initializers see committed DDL.
      const users = db.prepare("SELECT sql FROM sqlite_schema WHERE type='table' AND name='users'").get();
      if (users && !users.sql.includes("'password'")) {
        const oldCheck = /CHECK\s*\(\s*auth_provider\s+IN\s*\(\s*'github'\s*,\s*'guest'\s*,\s*'wechat'\s*\)\s*\)/i;
        if (!oldCheck.test(users.sql)) throw new Error('Unsupported users provider constraint; migration aborted');
        const extras = db.prepare("SELECT sql FROM sqlite_schema WHERE tbl_name='users' AND type IN ('index','trigger') AND sql IS NOT NULL").all();
        const replacement = users.sql.replace(/^CREATE TABLE\s+(?:IF NOT EXISTS\s+)?["`\[]?users["`\]]?/i, 'CREATE TABLE users_password_migration')
          .replace(oldCheck, "CHECK(auth_provider IN ('github','guest','wechat','password'))");
        db.exec(replacement);
        const columns = db.prepare('PRAGMA table_info(users)').all().map(c => '"' + c.name.replaceAll('"', '""') + '"').join(',');
        db.exec(`INSERT INTO users_password_migration(${columns}) SELECT ${columns} FROM users;
          DROP TABLE users; ALTER TABLE users_password_migration RENAME TO users;`);
        for (const extra of extras) db.exec(extra.sql);
      }
      db.exec(schema);
      if (db.prepare('PRAGMA foreign_key_check').all().length) throw new Error('Schema migration foreign key check failed');
      if (db.prepare('PRAGMA user_version').get().user_version < 2) db.exec('PRAGMA user_version=2');
    });
  } finally { db.exec(`PRAGMA foreign_keys=${foreignKeys ? 'ON' : 'OFF'}`); }
}
module.exports = { openDatabase, resolveDatabase, transaction, initializeSchema };
