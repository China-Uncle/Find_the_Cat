'use strict';
const { randomBytes, randomUUID, scrypt, timingSafeEqual } = require('node:crypto');
const { promisify } = require('node:util');
const { transaction } = require('./db');
const { assert } = require('./game_service');
const derive = promisify(scrypt);
// Versioned, explicit work factors. Never accept unbounded parameters from storage.
const PARAMETERS = Object.freeze({ algorithm: 'scrypt', cost: 32768, block_size: 8, parallelism: 1, key_length: 64 });
const INVALID = '用户名或密码不正确';
function normalizeUsername(value) {
  if (typeof value !== 'string' || value.length > 64) return null;
  const trimmed = value.trim();
  // Validate BEFORE lowercasing: Unicode lookalikes must not fold into ASCII names.
  return /^[A-Za-z0-9_]{3,24}$/.test(trimmed) ? trimmed.toLowerCase() : null;
}
function validPassword(value) {
  return typeof value === 'string' && value.isWellFormed() &&
    Buffer.byteLength(value, 'utf8') >= 12 && Buffer.byteLength(value, 'utf8') <= 128 &&
    value === value.trim() && !/[\u0000-\u001f\u007f-\u009f]/u.test(value);
}
async function passwordHash(password, salt, parameters = PARAMETERS) {
  return derive(password, salt, parameters.key_length, {
    N: parameters.cost, r: parameters.block_size, p: parameters.parallelism, maxmem: 64 * 1024 * 1024,
  });
}
function supported(record) {
  return record && Object.entries(PARAMETERS).every(([key, value]) => record[key] === value) &&
    /^[a-f0-9]{32}$/.test(record.salt) && /^[a-f0-9]{128}$/.test(record.password_hash);
}
class PasswordService {
  constructor(db, game) {
    this.db = db;
    this.game = game;
    // A nonexistent account takes the same scrypt path as a wrong password.
    this.dummy = { ...PARAMETERS, salt: randomBytes(16).toString('hex'), password_hash: randomBytes(64).toString('hex') };
  }
  async register(input) {
    const username = normalizeUsername(input.username);
    assert(username, 400, '用户名须为 3–24 位英文字母、数字或下划线', 'INVALID_USERNAME');
    assert(validPassword(input.password), 400, '密码须为 12–128 个 UTF-8 字节，且不能有控制字符或首尾空白', 'INVALID_PASSWORD');
    const salt = randomBytes(16).toString('hex');
    const digest = (await passwordHash(input.password, Buffer.from(salt, 'hex'))).toString('hex');
    // Hash outside the synchronous transaction; identity and credentials commit together.
    return transaction(this.db, () => {
      assert(!this.db.prepare('SELECT 1 FROM password_credentials WHERE username=?').get(username),
        409, '用户名不可用', 'USERNAME_UNAVAILABLE');
      const now = Date.now();
      const id = Number(this.db.prepare(`INSERT INTO users(auth_provider,open_id,username,created_at,updated_at)
        VALUES('password',?,?,?,?)`).run(randomUUID(), username, now, now).lastInsertRowid);
      this.db.prepare(`INSERT INTO password_credentials
        (user_id,username,algorithm,cost,block_size,parallelism,key_length,salt,password_hash)
        VALUES(?,?,?,?,?,?,?,?,?)`).run(id, username, PARAMETERS.algorithm, PARAMETERS.cost,
        PARAMETERS.block_size, PARAMETERS.parallelism, PARAMETERS.key_length, salt, digest);
      return this.game.user(id);
    });
  }
  async login(input) {
    const username = normalizeUsername(input.username);
    assert(username && validPassword(input.password), 401, INVALID, 'INVALID_CREDENTIALS');
    // Never look up or attach an identity by users.username (GitHub names are separate).
    const record = this.db.prepare(`SELECT c.* FROM password_credentials c JOIN users u ON u.id=c.user_id
      WHERE c.username=? AND u.auth_provider='password'`).get(username);
    const usable = supported(record), target = usable ? record : this.dummy;
    const actual = await passwordHash(input.password, Buffer.from(target.salt, 'hex'), target);
    const matches = timingSafeEqual(actual, Buffer.from(target.password_hash, 'hex'));
    assert(usable && matches, 401, INVALID, 'INVALID_CREDENTIALS');
    return this.game.user(record.user_id);
  }
}
module.exports = { PasswordService, normalizeUsername, validPassword, PARAMETERS };
