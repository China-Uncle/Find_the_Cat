'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { DatabaseSync } = require('node:sqlite');
const { Solver, fingerprint } = require('../level_generator');
const { auditLevel, auditLevels, auditDatabase, parseArgs, formatReport, main } = require('../scripts/audit_levels');

// Small deterministic fixtures: no generation, timing budgets, or production writes.
const UNIQUE_MAP = [1, 0, 0, 2, 1, 0, 2, 2, 1, 3, 2, 2, 1, 3, 2, 2];
const UNIQUE_ANSWER = [2, 4, 11, 13];
const UNIQUE_FIVE = [1, 1, 1, 0, 0, 1, 1, 1, 0, 2, 4, 1, 3, 3, 2, 4, 1, 3, 3, 4, 4, 4, 4, 4, 4];
const MULTIPLE_MAP = Array.from({ length: 16 }, (_, cell) => Math.floor(cell / 4));
const NO_SOLUTION_MAP = [0, 1, 2, 3, ...Array(12).fill(0)];
const CLI = path.join(__dirname, '..', 'scripts', 'audit_levels.js');

function row(overrides = {}) {
  return {
    id: 1, size: 4, region_map: JSON.stringify(UNIQUE_MAP),
    solution: JSON.stringify(UNIQUE_ANSWER), map_hash: fingerprint(4, UNIQUE_MAP),
    ...overrides,
  };
}
function mapRow(map, overrides = {}) {
  return row({ region_map: JSON.stringify(map), map_hash: fingerprint(4, map), ...overrides });
}
function codes(result) { return result.errors.map(error => error.code); }
function temp(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'find-cat-audit-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return { dir, file: path.join(dir, 'levels.sqlite') };
}
function insertRows(db, rows) {
  const statement = db.prepare('INSERT INTO levels(id, size, region_map, solution, map_hash) VALUES (?, ?, ?, ?, ?)');
  for (const level of rows) statement.run(level.id, level.size, level.region_map, level.solution, level.map_hash);
}
function fixture(t, rows = [row()]) {
  const target = temp(t), db = new DatabaseSync(target.file);
  try {
    // Deliberately no JSON/hash constraints so the auditor sees damaged legacy rows.
    db.exec('CREATE TABLE levels (id INTEGER PRIMARY KEY, size INTEGER, region_map TEXT, solution TEXT, map_hash TEXT)');
    insertRows(db, rows);
  } finally { db.close(); }
  return target;
}
function files(dir) {
  return Object.fromEntries(fs.readdirSync(dir).sort().map(name => [name, fs.readFileSync(path.join(dir, name))]));
}
function cli(args, options = {}) {
  const result = spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8', timeout: 30000, ...options });
  assert.ifError(result.error);
  return result;
}
function rotate(map, n) {
  const out = new Array(map.length);
  for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) out[c * n + n - 1 - r] = map[r * n + c];
  return out;
}

test('unique map passes exact unconditioned limit=2 search and is not mutated', () => {
  const level = Object.freeze(row()), before = JSON.stringify(level);
  const result = auditLevel(level);
  assert.equal(result.ok, true);
  assert.equal(result.solutionCount, 1);
  assert.equal(result.fingerprint, fingerprint(4, UNIQUE_MAP));
  assert.ok(result.nodes > 0);
  assert.deepEqual(result.errors, []);
  assert.equal(JSON.stringify(level), before);
  assert.equal(auditLevel(row({ solution: JSON.stringify([...UNIQUE_ANSWER].reverse()) })).ok, true);
});

test('multiple solutions are rejected even when the stored answer is valid', () => {
  const exact = new Solver(4, MULTIPLE_MAP).solve({ limit: 2 });
  assert.equal(exact.count, 2);
  const result = auditLevel(mapRow(MULTIPLE_MAP, { solution: JSON.stringify(exact.solution) }));
  assert.equal(result.ok, false);
  assert.equal(result.solutionCount, 2);
  assert.deepEqual(codes(result), ['MULTIPLE_SOLUTIONS']);
});

test('a connected map with all four regions but no solution is rejected', () => {
  const result = auditLevel(mapRow(NO_SOLUTION_MAP));
  assert.equal(result.solutionCount, 0);
  assert.ok(codes(result).includes('NO_SOLUTION'));
  assert.ok(!codes(result).includes('REGION_COUNT'));
  assert.ok(!codes(result).includes('DISCONNECTED_REGION'));
});

test('disconnected regions fail even when the puzzle has an exact unique solution', () => {
  const map = UNIQUE_MAP.slice(); map[0] = 2;
  const result = auditLevel(mapRow(map));
  assert.equal(result.ok, false);
  assert.equal(result.solutionCount, 1);
  assert.deepEqual(codes(result), ['DISCONNECTED_REGION']);
  assert.equal(result.errors[0].region, 2);
});

test('diagonal-only contact is not four-neighbor connectivity', () => {
  const map = [0, 1, 1, 1, 2, 0, 1, 1, 2, 2, 3, 3, 2, 2, 3, 3];
  const result = auditLevel(mapRow(map));
  assert.ok(result.errors.some(error => error.code === 'DISCONNECTED_REGION' && error.region === 0));
});

test('missing regions and invalid region labels are reported', () => {
  assert.ok(codes(auditLevel(mapRow(Array(16).fill(0)))).includes('REGION_COUNT'));
  for (const label of [-1, 4, 1.5, '1', null, true, [1], {}]) {
    const map = UNIQUE_MAP.slice(); map[0] = label;
    assert.ok(codes(auditLevel(row({ region_map: JSON.stringify(map) }))).includes('INVALID_REGION_LABEL'));
  }
});

test('wrong stored answer is compared against the unique answer independently of solving', () => {
  const result = auditLevel(row({ solution: JSON.stringify([1, 4, 11, 13]) }));
  assert.equal(result.solutionCount, 1);
  assert.ok(codes(result).includes('SOLUTION_MISMATCH'));
  assert.ok(codes(result).includes('SOLUTION_CONFLICT'));
});

test('every JSON shape and size is checked without coercing cells or stopping the scan', () => {
  const badMaps = ['{', 'null', '{}', '"board"', '1', 'true', '[]', JSON.stringify(Array(4).fill([0, 1, 2, 3]))];
  for (const region_map of badMaps) {
    const report = auditLevels([row({ id: 1, region_map }), row({ id: 2 })]);
    assert.equal(report.total, 2);
    assert.equal(report.failed, 1, region_map);
    assert.equal(report.levels[1].ok, true);
    assert.ok(codes(report.levels[0]).some(code => ['INVALID_JSON', 'INVALID_MAP'].includes(code)));
  }
  for (const solution of ['{', 'null', '{}', '[]', '[2,4,11]', '[2,4,11,11]', '[2,4,11,16]', '[-1,4,11,13]', '[2,4,11,13.5]', '["2",4,11,13]', '[[2],4,11,13]']) {
    const result = auditLevel(row({ solution }));
    assert.equal(result.ok, false, solution);
    assert.equal(result.solutionCount, 1, 'malformed stored answers must not skip exact search');
    assert.ok(codes(result).some(code => ['INVALID_JSON', 'INVALID_SOLUTION'].includes(code)));
  }
  for (const field of ['region_map', 'solution']) {
    for (const value of [null, undefined, 42, [], {}]) assert.ok(codes(auditLevel(row({ [field]: value }))).includes('INVALID_JSON'));
  }
  for (const size of [0, 3, 12, 4.5, '4', null]) assert.ok(codes(auditLevel(row({ size }))).includes('INVALID_SIZE'));
});

test('stored map_hash is verified against recomputed fingerprint', () => {
  for (const map_hash of ['', null, 'not-a-hash', '0'.repeat(64)]) {
    const result = auditLevel(row({ map_hash }));
    assert.deepEqual(codes(result), ['HASH_MISMATCH']);
    assert.equal(result.solutionCount, 1);
    assert.equal(result.errors[0].expected, fingerprint(4, UNIQUE_MAP));
  }
});

test('same-size duplicates use recomputed hashes, not forged stored hashes', () => {
  const transformed = rotate(UNIQUE_MAP, 4).map(g => (g + 1) % 4);
  const report = auditLevels([
    row(), row({ id: 2, region_map: JSON.stringify(transformed), solution: JSON.stringify([2, 4, 11, 13].map(cell => (cell % 4) * 4 + 3 - Math.floor(cell / 4))), map_hash: 'forged' }),
    row({ id: 3, map_hash: 'another forged hash' }),
  ]);
  assert.equal(report.failed, 3);
  assert.equal(report.duplicates.length, 1);
  assert.deepEqual(report.duplicates[0].ids, [1, 2, 3]);
  assert.equal(report.duplicates[0].fingerprint, fingerprint(4, UNIQUE_MAP));
  for (const level of report.levels) assert.ok(codes(level).includes('DUPLICATE_MAP'));
  assert.ok(codes(report.levels[1]).includes('HASH_MISMATCH'));
  assert.ok(!codes(report.levels[1]).includes('SOLUTION_MISMATCH'));
});

test('equal stored hashes across different sizes do not imply duplicate maps', () => {
  const report = auditLevels([
    row(), row({ id: 6, size: 5, region_map: JSON.stringify(UNIQUE_FIVE), solution: '[3,6,14,17,20]', map_hash: fingerprint(4, UNIQUE_MAP) }),
  ]);
  assert.deepEqual(report.duplicates, []);
  assert.equal(report.levels[0].ok, true);
  assert.deepEqual(codes(report.levels[1]), ['HASH_MISMATCH']);
  assert.deepEqual(report.bySize, { 4: { total: 1, passed: 1, failed: 0 }, 5: { total: 1, passed: 0, failed: 1 } });
});

test('unexpected per-level solver exception is reported and the next level is audited', t => {
  const original = Solver.prototype.solve;
  let calls = 0;
  t.mock.method(Solver.prototype, 'solve', function (options) {
    assert.deepEqual(options, { limit: 2 });
    if (++calls === 1) throw new Error('injected solver failure');
    return original.call(this, options);
  });
  const report = auditLevels([mapRow(NO_SOLUTION_MAP), row({ id: 2 })]);
  assert.equal(report.total, 2);
  assert.equal(report.failed, 1);
  assert.ok(codes(report.levels[0]).includes('LEVEL_ERROR'));
  assert.match(report.levels[0].errors.find(error => error.code === 'LEVEL_ERROR').message, /injected solver failure/);
  assert.equal(report.levels[1].ok, true);
  assert.equal(calls, 2);
});

test('row iterator failures cannot turn a partial scan into success', () => {
  function* brokenRows() { yield row(); throw new Error('cursor interrupted'); }
  const report = auditLevels(brokenRows());
  assert.equal(report.ok, false);
  assert.equal(report.total, 1);
  assert.equal(report.issueCount, 1);
  assert.equal(report.errors[0].code, 'DATABASE_ERROR');
});

test('database audit scans all rows after malformed JSON, no solution, multiple solutions, and wrong answers', t => {
  const { file } = fixture(t, [
    row({ id: 1, region_map: '{', solution: '{' }),
    mapRow(MULTIPLE_MAP, { id: 2 }), mapRow(NO_SOLUTION_MAP, { id: 3 }),
    row({ id: 4, solution: '[1,4,11,13]' }),
    row({ id: 6, size: 5, region_map: JSON.stringify(UNIQUE_FIVE), solution: '[3,6,14,17,20]', map_hash: fingerprint(5, UNIQUE_FIVE) }),
  ]);
  const report = auditDatabase(file);
  assert.equal(report.ok, false);
  assert.equal(report.total, 5);
  assert.equal(report.failed, 4);
  assert.equal(report.passed, 1);
  assert.equal(report.levels[4].ok, true);
  assert.ok(codes(report.levels[0]).includes('INVALID_JSON'));
  assert.ok(codes(report.levels[1]).includes('MULTIPLE_SOLUTIONS'));
  assert.ok(codes(report.levels[2]).includes('NO_SOLUTION'));
  assert.ok(codes(report.levels[3]).includes('SOLUTION_MISMATCH'));
});

test('audit never initializes schema or changes database bytes, metadata, or neighboring files', t => {
  const { dir, file } = fixture(t), writable = new DatabaseSync(file);
  writable.exec("PRAGMA user_version=73; CREATE TABLE sentinel(value TEXT); INSERT INTO sentinel VALUES ('untouched'); CREATE INDEX sentinel_index ON sentinel(value)");
  const beforeSchema = writable.prepare('SELECT * FROM sqlite_schema ORDER BY name').all();
  const beforeVersion = writable.prepare('PRAGMA user_version').get();
  writable.close();
  const before = files(dir);
  const report = auditDatabase(file);
  assert.equal(report.ok, true);
  assert.equal(report.total, 1);
  assert.deepEqual(files(dir), before);
  assert.equal(cli(['--db', file, '--json']).status, 0);
  assert.equal(cli([file]).status, 0);
  assert.deepEqual(files(dir), before);
  const check = new DatabaseSync(file, { readOnly: true });
  try {
    assert.deepEqual(check.prepare('SELECT * FROM sqlite_schema ORDER BY name').all(), beforeSchema);
    assert.deepEqual(check.prepare('PRAGMA user_version').get(), beforeVersion);
    assert.equal(check.prepare('SELECT value FROM sentinel').get().value, 'untouched');
    assert.equal(check.prepare('SELECT COUNT(*) AS n FROM levels').get().n, 1);
  } finally { check.close(); }
});

test('real project schema with populated application tables stays byte-for-byte unchanged', t => {
  const { dir, file } = temp(t), db = new DatabaseSync(file), level = row();
  try {
    db.exec(fs.readFileSync(path.join(__dirname, '..', 'schema.sql'), 'utf8'));
    db.prepare('INSERT INTO levels(id,size,region_map,solution,map_hash,seed,search_nodes,generation_attempts,created_at) VALUES(?,?,?,?,?,123,6,1,100)').run(level.id, level.size, level.region_map, level.solution, level.map_hash);
    db.exec("INSERT INTO users(id,auth_provider,open_id,username,created_at,updated_at) VALUES(1,'guest','audit-fixture','Fixture',100,100); INSERT INTO runs(id,user_id,level_id,started_at,expires_at) VALUES('run-fixture',1,1,100,200); INSERT INTO generation_jobs(id,requested,status,owner,created_at,updated_at) VALUES('job-fixture',1,'queued','fixture',100,100)");
  } finally { db.close(); }
  const before = files(dir);
  assert.equal(auditDatabase(file).ok, true);
  assert.deepEqual(files(dir), before);
});

test('read-only audit includes committed WAL rows without checkpointing or changing files', t => {
  const { dir, file } = fixture(t), writer = new DatabaseSync(file);
  try {
    writer.exec('PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0');
    insertRows(writer, [row({ id: 6, size: 5, region_map: JSON.stringify(UNIQUE_FIVE), solution: '[3,6,14,17,20]', map_hash: fingerprint(5, UNIQUE_FIVE) })]);
    const before = files(dir);
    assert.ok(Object.keys(before).includes('levels.sqlite-wal'));
    const report = auditDatabase(file);
    assert.equal(report.ok, true);
    assert.equal(report.total, 2);
    // SQLite may update transient read marks inside SHM; durable data must not change.
    const after = files(dir);
    assert.deepEqual(Object.keys(after), Object.keys(before));
    for (const name of Object.keys(before)) if (!name.endsWith('-shm')) assert.deepEqual(after[name], before[name], name);
    assert.equal(writer.prepare('SELECT COUNT(*) AS n FROM levels').get().n, 2);
  } finally { writer.close(); }
});

test('a failed audit also leaves corrupted rows and database files unchanged', t => {
  const { dir, file } = fixture(t, [row({ region_map: '{' }), row({ id: 2, map_hash: 'bad' })]);
  const before = files(dir), report = auditDatabase(file);
  assert.equal(report.ok, false);
  assert.equal(report.total, 2);
  assert.deepEqual(files(dir), before);
});

test('missing databases and parents are reported without creating any files or directories', t => {
  const { dir } = temp(t), missing = path.join(dir, 'missing', 'absent.sqlite');
  const report = auditDatabase(missing);
  assert.equal(report.ok, false);
  assert.equal(report.errors[0].code, 'DATABASE_ERROR');
  const result = cli(['--db', missing, '--json']);
  assert.notEqual(result.status, 0);
  assert.equal(JSON.parse(result.stdout).ok, false);
  assert.deepEqual(fs.readdirSync(dir), []);
});

test('missing levels table is an error, not permission to install the project schema', t => {
  const { dir, file } = temp(t), db = new DatabaseSync(file);
  db.exec('CREATE TABLE unrelated(value TEXT); PRAGMA user_version=17'); db.close();
  const before = files(dir), report = auditDatabase(file);
  assert.equal(report.ok, false);
  assert.equal(report.errors[0].code, 'DATABASE_ERROR');
  assert.deepEqual(files(dir), before);
});

test('an empty levels table produces an explicit successful zero-count report', t => {
  const { file } = fixture(t, []), report = auditDatabase(file);
  assert.equal(report.ok, true);
  assert.equal(report.total, 0);
  assert.equal(report.issueCount, 0);
  assert.match(formatReport(report), /共 0 关/);
});

test('CLI has human and JSON summaries with success/failure exit codes', t => {
  const good = fixture(t), bad = fixture(t, [mapRow(MULTIPLE_MAP)]);
  const success = cli(['--db', good.file, '--json']);
  assert.equal(success.status, 0, success.stderr);
  assert.equal(JSON.parse(success.stdout).ok, true);
  const failure = cli([bad.file, '--json']);
  assert.equal(failure.status, 1);
  const report = JSON.parse(failure.stdout);
  assert.equal(report.failed, 1);
  assert.ok(codes(report.levels[0]).includes('MULTIPLE_SOLUTIONS'));
  const human = cli([bad.file]);
  assert.equal(human.status, 1);
  assert.match(human.stdout, /只读题库审计/);
  assert.match(human.stdout, /异常 1 关/);
  assert.match(human.stdout, /关卡 1.*MULTIPLE_SOLUTIONS/);
  assert.equal(cli(['--help']).status, 0);
});

test('CLI respects DATABASE_PATH when no explicit path is given', t => {
  const { dir, file } = fixture(t);
  const result = cli(['--json'], { cwd: dir, env: { ...process.env, DATABASE_PATH: file } });
  assert.equal(result.status, 0, result.stderr);
  const report = JSON.parse(result.stdout);
  assert.equal(report.database, file);
  assert.equal(report.total, 1);
});

test('argument parsing rejects typos, repeated database paths and missing values', () => {
  assert.deepEqual(parseArgs([]), { json: false, help: false });
  assert.deepEqual(parseArgs(['--json', '--db', '/tmp/cats.sqlite']), { json: true, help: false, db: '/tmp/cats.sqlite' });
  assert.deepEqual(parseArgs(['/tmp/cats.sqlite', '--json']), { json: true, help: false, db: '/tmp/cats.sqlite' });
  for (const args of [['--db'], ['--db', '--json'], ['--typo'], ['a', 'b'], ['--db', 'a', '--db', 'b'], ['']]) assert.throws(() => parseArgs(args));
  const bad = cli(['--typo', '--json']);
  assert.equal(bad.status, 1);
  assert.equal(JSON.parse(bad.stdout).errors[0].code, 'AUDIT_ERROR');
});

test('main returns exit status and writes one JSON report through an injectable output', t => {
  const { file } = fixture(t);
  let output = '';
  assert.equal(main(['--db', file, '--json'], { stdout: { write(text) { output += text; } } }), 0);
  assert.equal(JSON.parse(output).passed, 1);
});
