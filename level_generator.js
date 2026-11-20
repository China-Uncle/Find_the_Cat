'use strict';
const { createHash, randomBytes, randomUUID } = require('node:crypto');
const { openDatabase, transaction } = require('./db');
class Random {
  constructor(seed) { this.state = (seed >>> 0) || 0x9e3779b9; }
  next() { let x = this.state; x ^= x << 13; x ^= x >>> 17; x ^= x << 5; this.state = x >>> 0; return this.state / 4294967296; }
  int(n) { return Math.floor(this.next() * n); }
  shuffle(a) { for (let i = a.length - 1; i > 0; i--) { const j = this.int(i + 1); [a[i], a[j]] = [a[j], a[i]]; } return a; }
}
class Rules {
  static conflicts(a, b, n, map) {
    const ar = Math.floor(a / n), br = Math.floor(b / n), ac = a % n, bc = b % n;
    return ar === br || ac === bc || map[a] === map[b] || (Math.abs(ar - br) <= 1 && Math.abs(ac - bc) <= 1);
  }
  static neighbors(i, n) {
    const a = []; if (i >= n) a.push(i - n); if (i < n * (n - 1)) a.push(i + n);
    if (i % n) a.push(i - 1); if (i % n < n - 1) a.push(i + 1); return a;
  }
  static groups(n, map) {
    const groups = [];
    for (let kind = 0; kind < 3; kind++) for (let g = 0; g < n; g++) {
      const ids = []; for (let i = 0; i < n * n; i++) if ((kind === 0 ? Math.floor(i / n) : kind === 1 ? i % n : map[i]) === g) ids.push(i);
      groups.push({ ids, label: kind === 0 ? `第 ${g + 1} 行` : kind === 1 ? `第 ${g + 1} 列` : `色块 ${g + 1}` });
    }
    return groups;
  }
  static conflictInfo(n, map, cats) {
    const bad = new Set(), zones = new Set();
    for (let a = 0; a < cats.length; a++) for (let b = a + 1; b < cats.length; b++) {
      const x = cats[a], y = cats[b]; if (!this.conflicts(x, y, n, map)) continue;
      bad.add(x); bad.add(y);
      for (let i = 0; i < n * n; i++) {
        if ((Math.floor(x / n) === Math.floor(y / n) && Math.floor(i / n) === Math.floor(x / n)) ||
            (x % n === y % n && i % n === x % n) || (map[x] === map[y] && map[i] === map[x])) zones.add(i);
      }
      // For diagonal-only conflicts, show the local neighborhood instead of an unrelated whole row.
      if (Math.abs(Math.floor(x / n) - Math.floor(y / n)) <= 1 && Math.abs(x % n - y % n) <= 1) { zones.add(x); zones.add(y); }
    }
    return { bad, zones };
  }
}
class Solver {
  constructor(n, map) {
    if (!Number.isInteger(n) || n < 1 || n > 12 || !map || map.length !== n * n || Array.from(map).some(g => !Number.isInteger(g) || g < 0 || g >= n)) throw new Error('无效的棋盘');
    this.n = n; this.map = map;
  }
  // Exact MRV over THREE constraint families: rows, regions and columns. No time cutoff can masquerade as uniqueness.
  solve({ limit = 2, fixed = [], banned = [], onProgress } = {}) {
    if (!Number.isInteger(limit) || limit < 1) throw new Error('limit 必须为正整数');
    const { n, map } = this, full = (1 << n) - 1, rowC = new Int8Array(n).fill(-1), ban = new Uint8Array(n * n);
    for (const id of banned) { if (!Number.isInteger(id) || id < 0 || id >= n * n) throw new Error('无效的排除位置'); ban[id] = 1; }
    let usedR = 0, usedC = 0, usedG = 0, count = 0, nodes = 0, solution = null;
    for (const id of fixed) {
      if (!Number.isInteger(id) || id < 0 || id >= n * n || ban[id]) return { count: 0, nodes: 0, solution: null };
      const r = Math.floor(id / n), c = id % n, g = map[id];
      if ((usedR & (1 << r)) || (usedC & (1 << c)) || (usedG & (1 << g)) ||
          (r > 0 && rowC[r - 1] >= 0 && Math.abs(rowC[r - 1] - c) <= 1) ||
          (r + 1 < n && rowC[r + 1] >= 0 && Math.abs(rowC[r + 1] - c) <= 1)) return { count: 0, nodes: 0, solution: null };
      rowC[r] = c; usedR |= 1 << r; usedC |= 1 << c; usedG |= 1 << g;
    }
    // Depth-local buffers avoid candidate array churn and preserve a parent's MRV candidates on return.
    const masks = Array.from({ length: n + 1 }, () => new Uint16Array(n));
    const regionCounts = Array.from({ length: n + 1 }, () => new Uint16Array(n));
    const colCounts = Array.from({ length: n + 1 }, () => new Uint16Array(n));
    const dfs = (ur, uc, ug, depth) => {
      nodes++;
      if (onProgress && nodes % 2048 === 0) onProgress(nodes);
      if (ur === full) { count++; if (!solution) solution = Array.from(rowC, (c, r) => r * n + c); return count >= limit; }
      const rc = masks[depth], gc = regionCounts[depth], cc = colCounts[depth]; gc.fill(0); cc.fill(0);
      let min = Infinity, kind = 0, group = -1;
      for (let r = 0; r < n; r++) {
        rc[r] = 0; if (ur & (1 << r)) continue;
        let available = full & ~uc;
        // Only adjacent rows can violate the 8-neighbor rule; columns already exclude all vertical neighbors.
        for (const nr of [r - 1, r + 1]) if (nr >= 0 && nr < n && rowC[nr] >= 0) {
          const b = 1 << rowC[nr]; available &= ~(b | (b << 1) | (b >>> 1));
        }
        let num = 0;
        while (available) {
          const bit = available & -available; available -= bit; const c = 31 - Math.clz32(bit), id = r * n + c, g = map[id];
          if ((ug & (1 << g)) || ban[id]) continue;
          rc[r] |= bit; num++; gc[g]++; cc[c]++;
        }
        if (!num) return false; // Forward checking: a missing row has zero candidates.
        if (num < min) { min = num; kind = 0; group = r; }
      }
      for (let g = 0; g < n; g++) {
        if (!(ug & (1 << g))) { if (!gc[g]) return false; if (gc[g] < min) { min = gc[g]; kind = 1; group = g; } }
        if (!(uc & (1 << g))) { if (!cc[g]) return false; if (cc[g] < min) { min = cc[g]; kind = 2; group = g; } }
      }
      for (let r = 0; r < n; r++) {
        if (kind === 0 && r !== group) continue;
        let available = rc[r];
        while (available) {
          const bit = available & -available; available -= bit; const c = 31 - Math.clz32(bit), g = map[r * n + c];
          if ((kind === 1 && g !== group) || (kind === 2 && c !== group)) continue;
          rowC[r] = c;
          const stop = dfs(ur | (1 << r), uc | bit, ug | (1 << g), depth + 1);
          rowC[r] = -1;
          if (stop) return true; // Stop immediately on the second solution (or requested limit).
        }
      }
      return false;
    };
    dfs(usedR, usedC, usedG, fixed.length);
    return { count, nodes, solution };
  }
}
class Logic {
  // Deliberately limited, explainable deductions; never reads the hidden solution.
  static next(n, map, cats = [], excluded = []) {
    const catSet = new Set(cats), banned = new Set(excluded);
    const candidates = Array.from({ length: n * n }, (_, i) => i).filter(i => !catSet.has(i) && !banned.has(i) && !cats.some(c => Rules.conflicts(i, c, n, map)));
    const groups = Rules.groups(n, map).filter(g => !g.ids.some(i => catSet.has(i))).map(g => ({ ...g, options: g.ids.filter(i => candidates.includes(i)) }));
    for (const g of groups) {
      if (!g.options.length) return { kind: 'error', ids: g.ids, reason: `${g.label}已经没有合法位置了，请检查最近放的猫或手动排除。` };
      if (g.options.length === 1) return { kind: 'cat', ids: g.options, source: g.ids, reason: `${g.label}只剩一个合法位置，猫猫一定藏在绿色框里。` };
    }
    // Generalized locked candidates: if EVERY candidate of an unsatisfied group conflicts with X, X is impossible.
    for (const g of groups) {
      const options = new Set(g.options);
      const ids = candidates.filter(i => !options.has(i) && g.options.every(j => Rules.conflicts(i, j, n, map)));
      if (ids.length) return { kind: 'exclude', ids, source: g.options, reason: `${g.label}的猫无论落在哪个候选格，都会排除绿色框中的 ${ids.length} 格，所以这些位置可以标 ×。` };
    }
    return null;
  }
  static replay(n, map) {
    const cats = [], excluded = new Set(); let steps = 0;
    while (steps <= n * n + n) {
      if (cats.length === n) return { solved: true, steps };
      const step = this.next(n, map, cats, excluded);
      if (!step || step.kind === 'error') return { solved: false, steps };
      if (step.kind === 'cat') cats.push(step.ids[0]); else for (const i of step.ids) excluded.add(i);
      steps++;
    }
    return { solved: false, steps };
  }
}
class LevelGenerator {
  constructor(n, seed) { if (!Number.isInteger(n) || n < 4 || n > 11) throw new Error('请选择 4–11 阶棋盘'); this.n = n; this.seed = seed >>> 0; this.rng = new Random(seed); this.attempts = 0; }
  terminal() {
    const { n, rng } = this, cols = new Int8Array(n).fill(-1);
    const search = (r, used) => {
      if (r === n) return true;
      for (const c of rng.shuffle(Array.from({ length: n }, (_, i) => i))) {
        if ((used & (1 << c)) || (r && Math.abs(cols[r - 1] - c) <= 1)) continue;
        cols[r] = c; if (search(r + 1, used | (1 << c))) return true;
      }
      cols[r] = -1; return false;
    };
    if (!search(0, 0)) throw new Error('无法生成合法终局');
    return Array.from(cols, (c, r) => r * n + c);
  }
  flood(seeds) {
    const { n, rng } = this, map = new Int8Array(n * n).fill(-1), sizes = new Uint8Array(n);
    const front = Array.from({ length: n }, () => []);
    // Start moderately balanced, increase shape diversity on retries. A size penalty tempers growth.
    const spread = Math.min(18, 10 + this.attempts * .18), weights = Array.from({ length: n }, () => Math.exp(rng.next() * spread));
    const add = (id, g) => { map[id] = g; sizes[g]++; for (const j of Rules.neighbors(id, n)) if (map[j] < 0) front[g].push(j); };
    seeds.forEach((id, g) => add(id, g));
    for (let left = n * n - n; left > 0; left--) {
      let active = [];
      for (let g = 0; g < n; g++) { front[g] = front[g].filter(i => map[i] < 0); if (front[g].length) active.push(g); }
      const tiny = active.filter(g => sizes[g] < 2); if (tiny.length) active = tiny;
      const total = active.reduce((sum, g) => sum + weights[g] / sizes[g], 0); let pick = rng.next() * total, g = active[active.length - 1];
      for (const h of active) { pick -= weights[h] / sizes[h]; if (pick <= 0) { g = h; break; } }
      add(front[g][rng.int(front[g].length)], g);
    }
    return { map, sizes };
  }
  attempt(onProgress) {
    this.attempts++;
    const seeds = this.terminal(), { map, sizes } = this.flood(seeds);
    if (Math.min(...sizes) < 2) return null;
    if (Math.max(...sizes) > this.n*this.n*.48) return null;
    const exact = new Solver(this.n, map).solve({ onProgress });
    if (exact.count !== 1) return null;
    const logic = Logic.replay(this.n, map); if (!logic.solved) return null;
    return { n: this.n, map: Array.from(map), solution: exact.solution, seed: this.seed, attempts: this.attempts, nodes: exact.nodes, logicSteps: logic.steps, sizes: Array.from(sizes) };
  }
  static generate(n, seed, maxAttempts = 20000, existing = new Set(), { onHeartbeat } = {}) {
    if (!Number.isSafeInteger(maxAttempts) || maxAttempts < 1) throw new Error('maxAttempts 必须为正安全整数');
    const start = performance.now(), gen = new LevelGenerator(n, seed);
    let heartbeatAt = start;
    while (gen.attempts < maxAttempts) {
      // Renew outside the exact search: a deadline must never imply uniqueness.
      if (onHeartbeat && gen.attempts % 64 === 0 && performance.now() - heartbeatAt >= 1000) {
        onHeartbeat(); heartbeatAt = performance.now();
      }
      const level = gen.attempt(() => {
        if (onHeartbeat && performance.now() - heartbeatAt >= 1000) { onHeartbeat(); heartbeatAt = performance.now(); }
      });
      if (!level) continue;
      const hash = fingerprint(n, level.map);
      if (!existing.has(hash)) return { ...level, hash, computeMs: performance.now() - start };
    }
    const error = new Error(`尺寸 ${n} 在 ${maxAttempts} 次内未找到新唯一解地图；已保留此前成功追加的关卡。`);
    error.code = 'GENERATION_EXHAUSTED'; error.attempts = gen.attempts;
    throw error;
  }
}
// Normalize label permutations AND all D4 rotations/reflections: recoloring or turning a puzzle is not a new puzzle.
function fingerprint(n, map) {
  if (!Number.isInteger(n) || n < 1 || n > 12 || !map || map.length !== n * n ||
      Array.from(map).some(g => !Number.isInteger(g) || g < 0 || g >= n)) throw new Error('无效的棋盘');
  const variants = [];
  for (let t = 0; t < 8; t++) {
    const out = new Array(n*n);
    for (let r=0;r<n;r++) for(let c=0;c<n;c++) {
      let rr=r, cc=t>=4?n-1-c:c;
      for(let k=0;k<t%4;k++) [rr,cc]=[cc,n-1-rr];
      out[rr*n+cc]=map[r*n+c];
    }
    const labels=new Map(); variants.push(out.map(g=>{if(!labels.has(g))labels.set(g,labels.size);return labels.get(g).toString(16);}).join(''));
  }
  return createHash('sha256').update(`${n}:${variants.sort()[0]}`).digest('hex');
}
function sizeForLevel(id) {
  if(!Number.isSafeInteger(id)||id<1)throw new Error('无效关卡号');
  for(const [end,n] of [[5,4],[15,5],[35,6],[65,7],[100,8],[135,9],[170,10]])if(id<=end)return n;
  return 11;
}
const GENERATION_LEASE_MS = 300000;
function createGenerationJob(db, count, owner='cli') {
  if(!Number.isInteger(count)||count<1||count>1000)throw new Error('每次追加数量应为 1–1000');
  return transaction(db,()=>{
    const now=Date.now();
    db.prepare("UPDATE generation_jobs SET status='failed',error='生成进程中断或租约过期',updated_at=? WHERE status IN ('queued','running') AND updated_at<?").run(now,now-GENERATION_LEASE_MS);
    if(db.prepare("SELECT id FROM generation_jobs WHERE status IN ('queued','running')").get())throw new Error('已有题库任务正在运行，请稍后再试');
    const id=randomUUID();
    db.prepare("INSERT INTO generation_jobs(id,requested,status,owner,created_at,updated_at) VALUES(?,?,'queued',?,?,?)").run(id,count,owner,now,now);
    return id;
  });
}
function appendLevels(count, { dbPath, jobId, onProgress = () => {}, seed: batchSeed, maxAttempts = 20000 } = {}) {
  if (!Number.isInteger(count) || count < 1 || count > 1000) throw new Error('每次追加数量应为 1–1000');
  if (batchSeed !== undefined && (!Number.isInteger(batchSeed) || batchSeed < 0 || batchSeed > 0xffffffff)) throw new Error('seed 必须为 0–4294967295 的整数');
  if (!Number.isSafeInteger(maxAttempts) || maxAttempts < 1) throw new Error('maxAttempts 必须为正安全整数');
  if (typeof onProgress !== 'function') throw new Error('onProgress 必须为函数');
  const db = openDatabase(dbPath);
  let id = jobId, ownsJob = false;
  try {
    if (!id) id = createGenerationJob(db, count);
    // Claim and snapshot the sequence together. A rejected duplicate claimant must
    // never mark another worker's running (or still queued) job as failed.
    let max = transaction(db, () => {
      const now = Date.now();
      const claimed = db.prepare("UPDATE generation_jobs SET status='running',updated_at=? WHERE id=? AND status='queued' AND requested=? AND updated_at>=?")
        .run(now, id, count, now - GENERATION_LEASE_MS);
      if (!claimed.changes) throw new Error('生成任务无效或已经启动');
      return db.prepare('SELECT COALESCE(MAX(id),0) AS max FROM levels').get().max;
    });
    ownsJob = true;
    const existing = new Map();
    for (const row of db.prepare('SELECT size,map_hash FROM levels').all()) {
      if (!existing.has(row.size)) existing.set(row.size, new Set());
      existing.get(row.size).add(row.map_hash);
    }
    const renewLease = () => {
      const renewed = db.prepare("UPDATE generation_jobs SET updated_at=? WHERE id=? AND status='running'").run(Date.now(), id);
      if (!renewed.changes) throw new Error('生成租约已失效');
    };
    const insert = db.prepare('INSERT INTO levels(id,size,region_map,solution,map_hash,seed,search_nodes,generation_attempts,created_at) VALUES(?,?,?,?,?,?,?,?,?)');
    const update = db.prepare('UPDATE generation_jobs SET created_count=?,start_level=COALESCE(start_level,?),end_level=?,updated_at=? WHERE id=?');
    let total = db.prepare('SELECT COUNT(*) AS n FROM levels').get().n;
    for (let i = 0; i < count; i++) {
      const next = max + 1, n = sizeForLevel(next);
      if (!existing.has(n)) existing.set(n, new Set());
      // Absolute level IDs make seeded generation stable across split append calls.
      const seed = batchSeed === undefined ? randomBytes(4).readUInt32LE() : (batchSeed + next) >>> 0;
      renewLease();
      const level = LevelGenerator.generate(n, seed, maxAttempts, existing.get(n), { onHeartbeat: renewLease });
      transaction(db, () => {
        const job = db.prepare('SELECT status FROM generation_jobs WHERE id=?').get(id);
        if (job?.status !== 'running') throw new Error('生成租约已失效');
        if (db.prepare('SELECT COALESCE(MAX(id),0) AS max FROM levels').get().max !== max) throw new Error('关卡序号发生并发变化');
        insert.run(next, n, JSON.stringify(level.map), JSON.stringify(level.solution), level.hash, seed, level.nodes, level.attempts, Date.now());
        update.run(i + 1, next, next, Date.now(), id);
      });
      existing.get(n).add(level.hash); max = next; total++;
      onProgress({ jobId: id, created: i + 1, requested: count, total, levelId: next, computeMs: level.computeMs });
    }
    const finished = db.prepare("UPDATE generation_jobs SET status='done',updated_at=? WHERE id=? AND status='running'").run(Date.now(), id);
    if (!finished.changes) throw new Error('生成租约已失效');
    return db.prepare('SELECT * FROM generation_jobs WHERE id=?').get(id);
  } catch (error) {
    if (ownsJob) db.prepare("UPDATE generation_jobs SET status='failed',error=?,updated_at=? WHERE id=? AND status='running'").run(error.message, Date.now(), id);
    throw error;
  } finally { db.close(); }
}
module.exports={Random,Rules,Solver,Logic,LevelGenerator,fingerprint,sizeForLevel,createGenerationJob,appendLevels};
