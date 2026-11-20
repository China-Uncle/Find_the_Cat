#!/usr/bin/env node
'use strict';
const { randomBytes } = require('node:crypto');
const { isMainThread, parentPort, workerData } = require('node:worker_threads');
const { appendLevels } = require('./level_generator');

const USAGE = '用法：node seed_levels.js [1–1000] [--seed 0–4294967295] [--max-attempts 正整数]；默认追加 200 关';
function parseArgs(args) {
  const options = { count: 200 };
  let hasCount = false;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--seed' || arg === '--max-attempts') {
      const key = arg === '--seed' ? 'seed' : 'maxAttempts', raw = args[++i];
      if (options[key] !== undefined || !/^\d+$/.test(raw ?? '')) throw new Error(USAGE);
      const value = Number(raw);
      if (!Number.isSafeInteger(value) || (key === 'seed' ? value > 0xffffffff : value < 1)) throw new Error(USAGE);
      options[key] = value;
    } else {
      if (hasCount || !/^\d+$/.test(arg)) throw new Error(USAGE);
      options.count = Number(arg); hasCount = true;
      if (!Number.isInteger(options.count) || options.count < 1 || options.count > 1000) throw new Error(USAGE);
    }
  }
  return options;
}
function main(args = process.argv.slice(2)) {
  try {
    // Native Node 22 loader keeps the seeder/worker runnable fully offline.
    try { process.loadEnvFile(); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    const { count, ...options } = parseArgs(args);
    options.seed ??= randomBytes(4).readUInt32LE();
    console.log(`批次种子：${options.seed}（相同初始题库及参数可复现）`);
    const job = appendLevels(count, { ...options, onProgress: p => process.stdout.write(`\r已追加 ${p.created}/${count}，当前共 ${p.total} 关（第 ${p.levelId} 关）   `) });
    console.log(`\n完成：第 ${job.start_level}–${job.end_level} 关。`);
  } catch (error) {
    console.error('\n追加失败：' + error.message); process.exitCode = 1;
  }
}
if (require.main === module) {
  if (!isMainThread) {
    try {
      const { count, ...options } = workerData;
      const job = appendLevels(count, { ...options, onProgress: p => parentPort.postMessage(p) });
      parentPort.postMessage({ done: true, job });
    } catch (error) { parentPort.postMessage({ failed: true, error: error.message }); process.exitCode = 1; }
  } else main();
}
module.exports = { parseArgs, main };
