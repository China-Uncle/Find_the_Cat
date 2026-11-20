'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const html = fs.readFileSync(path.join(__dirname, '..', 'public/index.html'), 'utf8');
const math = html.slice(html.indexOf('function boardTileSize('), html.indexOf('function fitBoard()'));
const calculate = vm.runInNewContext(`(${math.trim()})`);

test('4 through 11 columns share the same responsive board footprint', () => {
  for (const [width, height, pad, gap] of [[370, 500, 12, 3], [480, 640, 12, 3], [872, 680, 14, 4], [700, 140, 12, 3]]) {
    const footprints = [];
    for (let n = 4; n <= 11; n++) {
      const tile = calculate(n, width, height, pad, pad, gap, gap);
      const side = n * tile + (n - 1) * gap + pad;
      assert.ok(side <= width + 0.01 && side <= height + 0.01);
      assert.ok(Math.abs(side - Math.min(width, height, 560)) < 0.01);
      footprints.push(side);
    }
    assert.ok(Math.max(...footprints) - Math.min(...footprints) < 0.01);
    assert.ok(calculate(4, width, height, pad, pad, gap, gap) > calculate(11, width, height, pad, pad, gap, gap));
  }
});
test('layout sizing never depends on the content-sized board frame', () => {
  const fit = html.slice(html.indexOf('function fitBoard()'), html.indexOf('function formatTime'));
  assert.ok(fit.includes('play.clientWidth'));
  assert.ok(fit.includes('play.clientHeight'));
  assert.ok(!/frame\.client(?:Width|Height)/.test(fit));
  assert.ok(html.includes('ResizeObserver(fitBoard)'));
});
