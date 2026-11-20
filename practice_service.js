'use strict';
const { randomUUID } = require('node:crypto');
const { transaction } = require('./db');
const { GameService, assert, int } = require('./game_service');

function inputObject(input) {
  assert(input && typeof input === 'object' && !Array.isArray(input), 400, '请求体必须为 JSON 对象');
}
function runIdInput(runId) {
  assert(typeof runId === 'string' && runId.length > 0 && runId.length <= 64, 400, '局次无效');
}

class PracticeService {
  constructor(db, options = {}) {
    this.db = db;
    // Only read-only user/level metadata and the public run projection are shared.
    // Never delegate a practice mutation to the official game service.
    this.game = new GameService(db, options);
    this.now = this.game.now;
    this.ttl = this.game.ttl;
  }

  runView(run) { return this.game.runView(run); }

  getRun(userId, runId) {
    const run = this.db.prepare('SELECT * FROM practice_runs WHERE id=? AND user_id=?').get(runId, userId);
    assert(run, 409, '试关已被其他页面重新开始，请刷新', 'STALE_RUN');
    return run;
  }

  unexpired(run) {
    assert(run.expires_at > this.now(), 409, '本局已过期，请重新开始', 'RUN_EXPIRED');
  }

  start(userId, input = {}) {
    inputObject(input);
    const { levelId, restart = false } = input;
    int(levelId, 1, 2147483647, '关卡');
    assert(typeof restart === 'boolean', 400, 'restart 必须为布尔值');
    return transaction(this.db, () => {
      this.game.user(userId);
      const level = this.db.prepare('SELECT id,size,region_map FROM levels WHERE id=?').get(levelId);
      assert(level, 404, '关卡不存在', 'LEVEL_NOT_FOUND');
      let run = this.db.prepare('SELECT * FROM practice_runs WHERE user_id=?').get(userId);
      if (restart || !run || run.level_id !== levelId || run.expires_at <= this.now()) {
        this.db.prepare('DELETE FROM practice_runs WHERE user_id=?').run(userId);
        const now = this.now(), id = randomUUID();
        this.db.prepare('INSERT INTO practice_runs(id,user_id,level_id,started_at,expires_at) VALUES(?,?,?,?,?)')
          .run(id, userId, levelId, now, now + this.ttl);
        run = this.getRun(userId, id);
      }
      return {
        allComplete: false, totalLevels: this.game.total(),
        level: { id: level.id, size: level.size, regions: JSON.parse(level.region_map) },
        run: this.runView(run), practice: true,
      };
    });
  }

  move(userId, input = {}) {
    inputObject(input);
    const { runId, requestId, cell, operation, revision } = input;
    runIdInput(runId);
    assert(typeof requestId === 'string' && /^[a-zA-Z0-9_-]{8,80}$/.test(requestId), 400, '操作编号无效');
    assert(operation === 'place' || operation === 'remove', 400, '操作无效');
    int(revision, 0, 1000000, '版本号');
    return transaction(this.db, () => {
      this.game.user(userId);
      const run = this.getRun(userId, runId);
      this.unexpired(run);
      const level = this.db.prepare('SELECT size,solution FROM levels WHERE id=?').get(run.level_id);
      int(cell, 0, level.size ** 2 - 1, '格子坐标');
      const prior = this.db.prepare('SELECT cell,operation,result_json FROM practice_moves WHERE run_id=? AND request_id=?')
        .get(runId, requestId);
      if (prior) {
        assert(prior.cell === cell && prior.operation === operation, 409, '操作编号已被使用');
        return JSON.parse(prior.result_json);
      }
      assert(run.status === 'playing' || (operation === 'remove' && run.status === 'ready'),
        409, run.status === 'failed' ? '红心已用完，请重新开始' : '本局已结束', 'RUN_FINISHED');
      assert(run.revision === revision, 409, '盘面已变化，请同步后再操作', 'STALE_REVISION');
      const cats = JSON.parse(run.cats), at = cats.indexOf(cell);
      let correct = true;
      if (operation === 'remove') {
        assert(at >= 0, 400, '该格子没有猫');
        cats.splice(at, 1);
      } else {
        assert(at < 0, 400, '猫已经在这里了');
        correct = JSON.parse(level.solution).includes(cell);
        if (correct) cats.push(cell); else run.hearts--;
      }
      run.cats = JSON.stringify(cats.sort((a, b) => a - b));
      run.revision++;
      if (!run.hearts) run.status = 'failed';
      else if (cats.length === level.size) { run.status = 'ready'; run.finished_at = this.now(); }
      else if (operation === 'remove' && run.status === 'ready') { run.status = 'playing'; run.finished_at = null; }
      this.db.prepare('UPDATE practice_runs SET cats=?,hearts=?,revision=?,status=?,finished_at=? WHERE id=?')
        .run(run.cats, run.hearts, run.revision, run.status, run.finished_at, run.id);
      const result = { correct, cell, run: this.runView(run) };
      this.db.prepare('INSERT INTO practice_moves(run_id,request_id,cell,operation,result_json) VALUES(?,?,?,?,?)')
        .run(runId, requestId, cell, operation, JSON.stringify(result));
      return result;
    });
  }

  complete(userId, input = {}) {
    inputObject(input);
    const { runId, levelId, cats } = input;
    runIdInput(runId);
    int(levelId, 1, 2147483647, '关卡');
    assert(Array.isArray(cats) && cats.length <= 11 && cats.every(Number.isSafeInteger), 400, '猫坐标无效');
    return transaction(this.db, () => {
      this.game.user(userId);
      const run = this.getRun(userId, runId);
      assert(run.level_id === levelId, 409, '本局不属于该关卡', 'LEVEL_MISMATCH');
      this.unexpired(run);
      assert((run.status === 'ready' || run.status === 'completed') && run.hearts > 0, 409, '尚未找到全部猫');
      const level = this.db.prepare('SELECT size,solution FROM levels WHERE id=?').get(levelId);
      const canonical = cells => [...cells].sort((a, b) => a - b).join(',');
      assert(cats.length === level.size && new Set(cats).size === level.size &&
        canonical(cats) === canonical(JSON.parse(level.solution)) && canonical(cats) === canonical(JSON.parse(run.cats)),
      400, '答案或服务端盘面不匹配');
      // Completion is idempotent for the retained run, without any official score/progress write.
      if (run.status !== 'completed') this.db.prepare("UPDATE practice_runs SET status='completed' WHERE id=?").run(runId);
      const next = this.db.prepare('SELECT id FROM levels WHERE id>? ORDER BY id LIMIT 1').get(levelId);
      return {
        practice: true, levelId, elapsedMs: Math.max(1, run.finished_at - run.started_at),
        totalLevels: this.game.total(), nextLevelId: next ? next.id : null,
      };
    });
  }
}
module.exports = { PracticeService };
