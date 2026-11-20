#!/usr/bin/env node
'use strict';

const { DatabaseSync } = require('node:sqlite');
const { resolveDatabase } = require('../db');
const { Rules, Solver, fingerprint } = require('../level_generator');

const USAGE = '用法：node scripts/audit_levels.js [数据库路径 | --db 数据库路径] [--json]\n默认读取 DATABASE_PATH 或项目下的 data/cats.sqlite；只读审计，不创建或修复数据库。';

/** Audit one stored row without trusting its JSON, answer, or stored hash. */
function auditLevel(row) {
  const result = { id: row?.id ?? null, size: row?.size ?? null, ok: false, errors: [], solutionCount: null, nodes: null, fingerprint: null };
  const fail = (code, message, details = {}) => result.errors.push({ code, message, ...details });
  try {
    if (!row || typeof row !== 'object') throw new Error('关卡记录必须为对象');
    const n = row.size;
    const validSize = Number.isInteger(n) && n >= 4 && n <= 11;
    if (!validSize) fail('INVALID_SIZE', 'size 必须为 4–11 的整数');
    const parse = field => {
      if (typeof row[field] !== 'string') {
        fail('INVALID_JSON', `${field} 必须为 JSON 字符串`, { field });
        return undefined;
      }
      try { return JSON.parse(row[field]); }
      catch (error) { fail('INVALID_JSON', `${field} JSON 解析失败：${error.message}`, { field }); }
    };
    const map = parse('region_map'), answer = parse('solution');
    let validMap = false, validAnswer = false;
    if (map !== undefined) {
      if (!Array.isArray(map)) fail('INVALID_MAP', 'region_map 必须为一维数组');
      else if (validSize) {
        if (map.length !== n * n) fail('INVALID_MAP', `region_map 长度必须为 ${n * n}`);
        else if (map.some(g => !Number.isInteger(g) || g < 0 || g >= n)) {
          fail('INVALID_REGION_LABEL', `区域编号必须为 0–${n - 1} 的整数`);
        } else validMap = true;
      }
    }
    if (answer !== undefined) {
      if (!Array.isArray(answer)) fail('INVALID_SOLUTION', 'solution 必须为一维数组');
      else if (validSize) {
        if (answer.length !== n || answer.some(id => !Number.isInteger(id) || id < 0 || id >= n * n) || new Set(answer).size !== n) {
          fail('INVALID_SOLUTION', `solution 必须包含 ${n} 个互不重复、范围为 0–${n * n - 1} 的整数格子编号`);
        } else validAnswer = true;
      }
    }
    if (validMap) {
      const groups = Array.from({ length: n }, () => []);
      map.forEach((g, cell) => groups[g].push(cell));
      const regionCount = groups.filter(cells => cells.length).length;
      if (regionCount !== n) fail('REGION_COUNT', `区域数应为 ${n}，实际为 ${regionCount}`);
      groups.forEach((cells, region) => {
        if (!cells.length) return;
        const visited = new Set([cells[0]]), queue = [cells[0]];
        for (let at = 0; at < queue.length; at++) {
          for (const cell of Rules.neighbors(queue[at], n)) {
            if (map[cell] === region && !visited.has(cell)) { visited.add(cell); queue.push(cell); }
          }
        }
        if (visited.size !== cells.length) fail('DISCONNECTED_REGION', `区域 ${region} 不满足四邻接连通`, { region, cells: cells.length, reached: visited.size });
      });
      result.fingerprint = fingerprint(n, map);
      if (row.map_hash !== result.fingerprint) fail('HASH_MISMATCH', 'map_hash 与重新计算的 fingerprint 不一致', { expected: result.fingerprint });
      if (validAnswer) {
        let conflict = false;
        for (let i = 0; i < answer.length && !conflict; i++) {
          for (let j = i + 1; j < answer.length; j++) {
            if (Rules.conflicts(answer[i], answer[j], n, map)) { conflict = true; break; }
          }
        }
        if (conflict) fail('SOLUTION_CONFLICT', '存储答案违反行、列、区域唯一或八邻域不相邻规则');
      }
      // Never fix the stored answer or use a deadline: either would hide non-uniqueness.
      const exact = new Solver(n, map).solve({ limit: 2 });
      result.solutionCount = exact.count;
      result.nodes = exact.nodes;
      if (exact.count === 0) fail('NO_SOLUTION', '精确求解无解');
      else if (exact.count !== 1) fail('MULTIPLE_SOLUTIONS', '精确求解至少有两个解');
      else if (validAnswer) {
        // Stored answers are sets of cells; their JSON ordering is not significant.
        const expected = new Set(exact.solution);
        if (answer.some(cell => !expected.has(cell))) fail('SOLUTION_MISMATCH', '存储答案与精确唯一解不一致', { expected: exact.solution });
      }
    }
  } catch (error) {
    fail('LEVEL_ERROR', `关卡审计异常：${error.message}`);
  }
  result.ok = result.errors.length === 0;
  return result;
}

/** Rows may be any iterable, including a SQLite statement iterator. */
function auditLevels(rows) {
  const levels = [], groups = new Map(), errors = [], duplicates = [];
  try {
    for (const row of rows) {
      const result = auditLevel(row);
      levels.push(result);
      if (result.fingerprint !== null) {
        const key = `${result.size}:${result.fingerprint}`;
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key).push(result);
      }
    }
  } catch (error) {
    // A cursor failure is a database-wide error, not a silently successful partial scan.
    errors.push({ code: 'DATABASE_ERROR', message: `读取题库失败：${error.message}` });
  }
  for (const group of groups.values()) {
    if (group.length < 2) continue;
    duplicates.push({ size: group[0].size, fingerprint: group[0].fingerprint, ids: group.map(level => level.id) });
    group.forEach((level, index) => {
      const duplicateOf = group[index === 0 ? 1 : 0].id;
      level.errors.push({ code: 'DUPLICATE_MAP', message: `与关卡 ${duplicateOf} 为同尺寸重复地图（包含换色、旋转及镜像）`, duplicateOf });
      level.ok = false;
    });
  }
  const bySize = {};
  for (const level of levels) {
    const key = String(level.size);
    if (!Object.hasOwn(bySize, key)) bySize[key] = { total: 0, passed: 0, failed: 0 };
    bySize[key].total++;
    bySize[key][level.ok ? 'passed' : 'failed']++;
  }
  const failed = levels.filter(level => !level.ok).length;
  return {
    ok: failed === 0 && errors.length === 0,
    total: levels.length, passed: levels.length - failed, failed,
    issueCount: levels.reduce((sum, level) => sum + level.errors.length, errors.length),
    bySize, duplicates, errors, levels,
  };
}

/** The audited connection must never go through openDatabase/schema initialization. */
function auditDatabase(file) {
  let db, database;
  try {
    database = resolveDatabase(file);
    db = new DatabaseSync(database, { readOnly: true });
    // One SELECT holds a consistent read snapshot, including any committed WAL rows.
    const rows = db.prepare('SELECT id, size, region_map, solution, map_hash FROM levels ORDER BY id').iterate();
    return { database, ...auditLevels(rows) };
  } catch (error) {
    const report = auditLevels([]);
    report.ok = false;
    report.errors.push({ code: 'DATABASE_ERROR', message: `无法审计数据库：${error.message}` });
    report.issueCount++;
    return { database, ...report };
  } finally {
    if (db) db.close();
  }
}

function parseArgs(args) {
  const options = { json: false, help: false };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--json') options.json = true;
    else if (arg === '--help' || arg === '-h') options.help = true;
    else {
      let file = arg;
      if (arg === '--db') file = args[++i];
      else if (arg.startsWith('-')) throw new Error(`未知参数：${arg}\n${USAGE}`);
      if (options.db !== undefined || !file || file.startsWith('-')) throw new Error(USAGE);
      options.db = file;
    }
  }
  return options;
}

function formatReport(report) {
  const lines = [
    `只读题库审计：${report.database ?? '关卡集合'}`,
    `审计${report.ok ? '通过' : '失败'}：共 ${report.total} 关，通过 ${report.passed} 关，异常 ${report.failed} 关；问题 ${report.issueCount} 项；重复组 ${report.duplicates.length} 组。`,
  ];
  for (const [size, counts] of Object.entries(report.bySize)) {
    lines.push(`  ${size}×${size}：${counts.total} 关，通过 ${counts.passed}，异常 ${counts.failed}`);
  }
  for (const error of report.errors) lines.push(`[${error.code}] ${error.message}`);
  for (const level of report.levels) {
    for (const error of level.errors) lines.push(`关卡 ${level.id}（${level.size}×${level.size}）[${error.code}] ${error.message}`);
  }
  return lines.join('\n');
}

function main(args = process.argv.slice(2), { stdout = process.stdout } = {}) {
  let options, report;
  try {
    options = parseArgs(args);
    if (options.help) { stdout.write(USAGE + '\n'); return 0; }
    try { process.loadEnvFile(); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    report = auditDatabase(options.db);
  } catch (error) {
    report = auditLevels([]);
    report.ok = false;
    report.errors.push({ code: 'AUDIT_ERROR', message: error.message });
    report.issueCount++;
  }
  stdout.write((options?.json || args.includes('--json') ? JSON.stringify(report, null, 2) : formatReport(report)) + '\n');
  return report.ok ? 0 : 1;
}

if (require.main === module) process.exitCode = main();
module.exports = { auditLevel, auditLevels, auditDatabase, parseArgs, formatReport, main };
