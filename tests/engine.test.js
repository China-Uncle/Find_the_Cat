'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { Random, Rules, LevelGenerator, Solver, Logic, sizeForLevel, fingerprint } = require('../level_generator');

function checkRegions(n, map) {
  for (let g = 0; g < n; g++) {
    const cells = map.flatMap((value, id) => value === g ? [id] : []);
    assert.ok(cells.length >= 2, `region ${g} must have at least two cells`);
    const seen = new Set([cells[0]]), queue = [cells[0]];
    for (let at = 0; at < queue.length; at++) for (const id of Rules.neighbors(queue[at], n)) {
      if (map[id] === g && !seen.has(id)) { seen.add(id); queue.push(id); }
    }
    assert.equal(seen.size, cells.length, `region ${g} must be 4-connected`);
  }
}
function brute(n, map, fixed = [], banned = []) {
  // Deliberately independent row-by-row reference, without MRV or bit masks.
  let count = 0;
  const cats = [];
  function visit(row) {
    if (row === n) { count++; return; }
    for (let col = 0; col < n; col++) {
      const cell = row * n + col;
      if (banned.includes(cell) || fixed.some(id => Math.floor(id / n) === row && id !== cell)) continue;
      if (cats.some(id => id % n === col || map[id] === map[cell] ||
          (Math.floor(id / n) === row - 1 && Math.abs(id % n - col) <= 1))) continue;
      cats.push(cell); visit(row + 1); cats.pop();
    }
  }
  visit(0); return count;
}
function transform(map, n, turns, mirror) {
  const out = new Array(map.length);
  for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) {
    let x = r, y = mirror ? n - 1 - c : c;
    for (let k = 0; k < turns; k++) [x, y] = [y, n - 1 - x];
    out[x * n + y] = map[r * n + c];
  }
  return out;
}

test('all 4–11 thresholds and invalid level IDs', () => {
  const sizes = new Map();
  for (let id = 1; id <= 200; id++) sizes.set(sizeForLevel(id), (sizes.get(sizeForLevel(id)) || 0) + 1);
  assert.deepEqual([...sizes], [[4, 5], [5, 10], [6, 20], [7, 30], [8, 35], [9, 35], [10, 35], [11, 30]]);
  for (const [id, size] of [[5, 4], [6, 5], [15, 5], [16, 6], [35, 6], [36, 7], [65, 7], [66, 8], [100, 8], [101, 9], [135, 9], [136, 10], [170, 10], [171, 11], [201, 11], [Number.MAX_SAFE_INTEGER, 11]]) assert.equal(sizeForLevel(id), size);
  for (const id of [0, -1, 1.5, NaN, Infinity, '5', Number.MAX_SAFE_INTEGER + 1]) assert.throws(() => sizeForLevel(id));
});

test('random terminal positions and seeded flood maps are legal, connected and reproducible', () => {
  for (let n = 4; n <= 11; n++) {
    const gen = new LevelGenerator(n, 0xabc + n), twin = new LevelGenerator(n, 0xabc + n), terminals = new Set();
    for (let trial = 0; trial < 30; trial++) {
      const seeds = gen.terminal();
      assert.deepEqual(seeds, twin.terminal()); terminals.add(seeds.join(','));
      assert.equal(new Set(seeds.map(id => id % n)).size, n);
      seeds.forEach((id, r) => { assert.equal(Math.floor(id / n), r); if (r) assert.ok(Math.abs(id % n - seeds[r - 1] % n) > 1); });
      const { map, sizes } = gen.flood(seeds), other = twin.flood(seeds);
      assert.deepEqual(map, other.map); assert.equal([...sizes].reduce((a, b) => a + b), n * n);
      seeds.forEach((id, g) => assert.equal(map[id], g)); checkRegions(n, Array.from(map));
    }
    assert.ok(terminals.size > 1, `terminal generation is not constant at size ${n}`);
  }
});

test('4×4 through 11×11 accepted boards have exact unique solutions and sound logic', () => {
  for (let n = 4; n <= 11; n++) {
    const level = LevelGenerator.generate(n, 0x345612 + n);
    const exact = new Solver(n, level.map).solve({ limit: 100000 });
    assert.equal(exact.count, 1); assert.deepEqual(exact.solution, level.solution);
    checkRegions(n, level.map); assert.ok(Math.max(...level.sizes) <= n * n * .48);
    const cats = [], excluded = new Set(); let steps = 0;
    while (cats.length < n) {
      const step = Logic.next(n, level.map, cats, excluded);
      assert.ok(step && step.kind !== 'error');
      if (step.kind === 'cat') { assert.ok(level.solution.includes(step.ids[0])); cats.push(step.ids[0]); }
      else for (const id of step.ids) { assert.ok(!level.solution.includes(id)); excluded.add(id); }
      assert.ok(++steps <= n * n + n);
    }
    assert.equal(Logic.replay(n, level.map).solved, true);
  }
});

test('exact MRV matches independent exhaustive counts with fixed and banned cells', () => {
  const rng = new Random(93841);
  for (let n = 4; n <= 6; n++) for (let trial = 0; trial < 35; trial++) {
    const map = Array.from({ length: n * n }, () => rng.int(n));
    const fixed = trial % 2 ? [rng.int(n * n)] : [], banned = [rng.int(n * n), rng.int(n * n)];
    const expected = brute(n, map, fixed, banned), solver = new Solver(n, map);
    assert.equal(solver.solve({ limit: 100000, fixed, banned }).count, expected);
    assert.equal(solver.solve({ fixed, banned }).count, Math.min(expected, 2));
  }
});

test('MRV stops immediately at the requested solution count; unique/no-solution are exact', () => {
  const n = 7, map = Array.from({ length: n * n }, (_, id) => Math.floor(id / n)), solver = new Solver(n, map);
  const one = solver.solve({ limit: 1 }), two = solver.solve(), all = solver.solve({ limit: 10000 });
  assert.equal(one.count, 1); assert.equal(two.count, 2); assert.equal(all.count, 646);
  assert.ok(one.nodes < two.nodes && two.nodes < all.nodes);
  assert.deepEqual(two.solution, one.solution);
  assert.equal(new Solver(4, Array(16).fill(0)).solve().count, 0);
  for (const fixed of [[0, 5], [0, 4], [1, 1], [-1], [1.5]]) assert.equal(solver.solve({ fixed }).count, 0);
  assert.equal(solver.solve({ fixed: one.solution }).count, 1);
  assert.equal(solver.solve({ fixed: [0], banned: [0] }).count, 0);
});

test('hash normalizes all eight D4 symmetries and color permutations, not different partitions', () => {
  for (const n of [4, 11]) {
    const map = LevelGenerator.generate(n, 0x345612 + n).map, hash = fingerprint(n, map);
    for (let turns = 0; turns < 4; turns++) for (const mirror of [false, true]) {
      const changed = transform(map, n, turns, mirror).map(g => n - 1 - g);
      assert.equal(fingerprint(n, changed), hash);
    }
    const changed = [...map]; changed[0] = (changed[0] + 1) % n;
    assert.notEqual(fingerprint(n, changed), hash);
  }
});

test('4×4 has more than five canonical connected unique logically solvable maps', t => {
  const gen = new LevelGenerator(4, 123), seen = new Set(); let accepted = 0;
  for (let i = 0; i < 1000; i++) { const level = gen.attempt(); if (level) { accepted++; seen.add(fingerprint(4, level.map)); } }
  assert.ok(seen.size >= 5); t.diagnostic(JSON.stringify({ attempts: 1000, accepted, canonicalMaps: seen.size }));
  const existing = new Set();
  for (let i = 0; i < 5; i++) { const level = LevelGenerator.generate(4, 123 + i, 20000, existing); assert.ok(!existing.has(level.hash)); existing.add(level.hash); }
});

test('retry exhaustion is finite, counts duplicates, and does not corrupt existing hashes', () => {
  const original = LevelGenerator.prototype.attempt;
  try {
    let calls = 0;
    LevelGenerator.prototype.attempt = function () { this.attempts++; calls++; return null; };
    assert.throws(() => LevelGenerator.generate(4, 1, 7), error => error.code === 'GENERATION_EXHAUSTED' && error.attempts === 7);
    assert.equal(calls, 7);
    const map = Array.from({ length: 16 }, (_, i) => Math.floor(i / 4)), existing = new Set([fingerprint(4, map)]);
    calls = 0;
    LevelGenerator.prototype.attempt = function () { this.attempts++; calls++; return { map }; };
    assert.throws(() => LevelGenerator.generate(4, 1, 9, existing), /9 次/); assert.equal(calls, 9); assert.equal(existing.size, 1);
    calls = 0;
    for (const limit of [0, -1, 1.5, NaN, Infinity]) assert.throws(() => LevelGenerator.generate(4, 1, limit));
    assert.equal(calls, 0);
  } finally { LevelGenerator.prototype.attempt = original; }
});

test('solver, generator and fingerprint reject invalid structural inputs', () => {
  for (const n of [3, 12, 4.5, NaN, '4']) assert.throws(() => new LevelGenerator(n, 1));
  for (const map of [null, [], Array(16).fill(-1), Array(16).fill(4), Array(16).fill(1.5), Array(16)]) {
    assert.throws(() => new Solver(4, map)); assert.throws(() => fingerprint(4, map));
  }
  const solver = new Solver(4, Array.from({ length: 16 }, (_, id) => Math.floor(id / 4)));
  for (const id of [-1, 16, NaN, 1.5, '2']) assert.throws(() => solver.solve({ banned: [id] }));
  for (const limit of [0, -1, Infinity, 1.5]) assert.throws(() => solver.solve({ limit }));
});

test('200-level batch is reproducible with a recorded seed and reports honest measured latency', { timeout: 120000 }, () => {
  const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
  const { openDatabase } = require('../db'), { appendLevels } = require('../level_generator');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'find-cat-200-'));
  try {
    const runs = [];
    for (let copy = 0; copy < 2; copy++) {
      const file = path.join(dir, `batch-${copy}.sqlite`), progress = [], started = performance.now();
      const job = appendLevels(200, { dbPath: file, seed: 20261120, onProgress: item => progress.push(item) });
      const elapsedMs = performance.now() - started, db = openDatabase(file);
      const levels = db.prepare('SELECT id,size,map_hash,seed,search_nodes,generation_attempts FROM levels ORDER BY id').all();
      assert.equal(job.status, 'done'); assert.equal(job.start_level, 1); assert.equal(job.end_level, 200);
      assert.equal(job.created_count, 200); assert.equal(progress.length, 200);
      assert.ok(progress.every((item, i) => item.levelId === i + 1 && item.created === i + 1));
      assert.deepEqual([...new Set(levels.map(row => row.size))], [4, 5, 6, 7, 8, 9, 10, 11]);
      assert.equal(new Set(levels.map(row => `${row.size}:${row.map_hash}`)).size, 200);
      assert.ok(levels.every(row => row.seed === (20261120 + row.id) >>> 0));
      runs.push({ elapsedMs, levels }); db.close();
    }
    assert.deepEqual(runs[0].levels, runs[1].levels);
    const ordered = runs.map(run => run.elapsedMs).sort((a, b) => a - b);
    console.log(`200-level seeded batch wall time (ms): ${runs.map(r => r.elapsedMs.toFixed(1)).join(', ')}; median=${ordered[1].toFixed(1)}; max=${ordered[1].toFixed(1)}; p95 not claimed from n=2`);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('append continues after the actual maximum ID and partial success survives exhaustion', () => {
  const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
  const { openDatabase } = require('../db'), { appendLevels, createGenerationJob } = require('../level_generator');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'find-cat-sequence-')), file = path.join(dir, 'levels.sqlite');
  try {
    appendLevels(3, { dbPath: file, seed: 91 });
    let db = openDatabase(file);
    db.prepare('DELETE FROM levels WHERE id=2').run(); db.close();
    const next = appendLevels(1, { dbPath: file, seed: 92 });
    assert.equal(next.start_level, 4); assert.equal(next.end_level, 4);
    const queuedDb = openDatabase(file), jobId = createGenerationJob(queuedDb, 2); // one-job lease is shared across CLI and workers.
    queuedDb.close();
    assert.throws(() => appendLevels(2, { dbPath: file, jobId: 'not-the-job', seed: 3 }), /无效或已经启动/);
    const leaseDb = openDatabase(file);
    assert.equal(leaseDb.prepare('SELECT status FROM generation_jobs WHERE id=?').get(jobId).status, 'queued');
    leaseDb.close();
    db = openDatabase(file); db.prepare('UPDATE generation_jobs SET updated_at=? WHERE id=?').run(Date.now() - 600000, jobId); db.close();
    const brokenDb = openDatabase(file), brokenJob = createGenerationJob(brokenDb, 2);
    brokenDb.close();
    const original = LevelGenerator.generate;
    try {
      let calls = 0;
      LevelGenerator.generate = (...args) => { if (++calls === 2) throw new Error('injected exhaustion'); return original(...args); };
      assert.throws(() => appendLevels(2, { dbPath: file, jobId: brokenJob, seed: 44 }), /injected exhaustion/);
    } finally { LevelGenerator.generate = original; }
    db = openDatabase(file);
    assert.ok(db.prepare('SELECT 1 FROM levels WHERE id=5').get());
    assert.equal(db.prepare('SELECT status,created_count,start_level,end_level FROM generation_jobs WHERE id=?').get(brokenJob).status, 'failed');
    assert.deepEqual({ ...db.prepare('SELECT created_count,start_level,end_level FROM generation_jobs WHERE id=?').get(brokenJob) }, { created_count: 1, start_level: 5, end_level: 5 });
    db.close();
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('simultaneous append workers cannot claim one lease twice or assign duplicate IDs', { timeout: 30000 }, async () => {
  const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), { Worker } = require('node:worker_threads');
  const { openDatabase } = require('../db'), { createGenerationJob } = require('../level_generator');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'find-cat-race-')), file = path.join(dir, 'levels.sqlite');
  try {
    const db = openDatabase(file), jobId = createGenerationJob(db, 1);
    db.close();
    const source = `const { parentPort, workerData } = require('node:worker_threads'); const { appendLevels } = require(workerData.modulePath); try { appendLevels(1,{dbPath:workerData.file,jobId:workerData.jobId,seed:123}); parentPort.postMessage('done'); } catch(e) { parentPort.postMessage(e.message); }`;
    const start = () => new Promise((resolve, reject) => {
      const worker = new Worker(source, { eval: true, workerData: { modulePath: path.join(__dirname, '..', 'level_generator.js'), file, jobId } });
      worker.once('message', resolve); worker.once('error', reject);
    });
    const results = await Promise.all([start(), start()]);
    assert.equal(results.filter(result => result === 'done').length, 1, JSON.stringify(results));
    const check = openDatabase(file);
    assert.equal(check.prepare('SELECT COUNT(*) AS n FROM levels').get().n, 1);
    assert.equal(check.prepare("SELECT status FROM generation_jobs WHERE id=?").get(jobId).status, 'done');
    check.close();
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
