'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const html = fs.readFileSync(path.join(__dirname, '..', 'public/index.html'), 'utf8');

function harness() {
  class Node {
    constructor() { this.children = []; this.dataset = {}; this.attributes = {}; this.style = { setProperty() {} }; this.className = ''; }
    set innerHTML(value) { this.children = []; this.html = value; }
    get innerHTML() { return this.html; }
    append(node) { this.children.push(node); }
    setAttribute(key, value) { this.attributes[key] = value; }
    removeAttribute(key) { delete this.attributes[key]; }
    get classList() { return { add: name => this.className += ' ' + name, remove: name => { this.className = this.className.split(' ').filter(x => x !== name).join(' '); } }; }
    querySelectorAll() { return this.children.filter(x => x.className.split(' ').includes('cat')); }
  }
  const elements = new Map(), timers = new Map(); let nextTimer = 0;
  const node = id => { if (!elements.has(id)) elements.set(id, new Node()); return elements.get(id); };
  const sandbox = { document: {
    getElementById: node, createElement: () => new Node(),
    querySelector: selector => node('board').children.find(x => String(x.dataset.cell) === selector.match(/data-cell="(\d+)"/)?.[1])
  }, requestAnimationFrame() {}, setTimeout: callback => { timers.set(++nextTimer, callback); return nextTimer; }, clearTimeout: id => timers.delete(id) };
  vm.createContext(sandbox);
  const script = html.match(/<script>([\s\S]*?)<\/script>/)[1].replace('boot().catch(showError);', '');
  vm.runInContext(script, sandbox);
  const api = vm.runInContext('({UI, CAT, GameEngine, render, flagCellError, clearCellFeedback})', sandbox);
  return { ...api, node, timers };
}
const snapshot = () => ({ level: { id: 1, size: 4, regions: Array.from({length: 16}, (_, i) => i % 4) }, marks: Array(16).fill(0), hearts: 3, elapsedMs: 0, status: 'playing' });

test('board uses a complete cat with explicit square, centered SVG viewport', () => {
  const { CAT, render, node } = harness(), state = snapshot(); state.marks[5] = 2;
  render(state);
  assert.match(CAT, /viewBox="0 0 80 80"/);
  assert.match(CAT, /preserveAspectRatio="xMidYMid meet"/);
  assert.match(CAT, /href="#cat-full"/);
  assert.match(html, /id="cat-full"/);
  assert.match(html, /\.cell \.cat-svg\{[^}]*position:absolute;inset:0;margin:auto/);
  assert.match(node('board').children[5].className, /cat-pop/);
  render(state);
  assert.ok(!node('board').children[5].className.includes('cat-pop'), 'unchanged cats must not reanimate on every mark');
});

test('wrong-cell red frame survives rerender, then clears without changing marks', () => {
  const { UI, render, flagCellError, node, timers } = harness(), state = snapshot();
  flagCellError(5); render(state);
  let cell = node('board').children[5];
  assert.match(cell.className, /error/); assert.equal(cell.attributes['aria-invalid'], 'true');
  state.marks[7] = 1; render(state); cell = node('board').children[5];
  assert.match(cell.className, /error/); assert.equal(state.marks[5], 0);
  [...timers.values()][0]();
  assert.equal(UI.cellErrors.size, 0); assert.ok(!cell.className.includes('error'));
  assert.equal(cell.attributes['aria-invalid'], undefined);
  assert.match(html, /\.cell.error::after\{[^}]*border:3px solid #c82039/);
});

test('feedback resets safely on retry or level change and stays outside GameEngine', () => {
  const { UI, flagCellError, clearCellFeedback, timers, GameEngine } = harness();
  flagCellError(2); const stale = [...timers.values()][0]; flagCellError(2);
  stale(); assert.equal(UI.cellErrors.size, 1, 'old timeout cannot remove a newer warning');
  flagCellError(7); clearCellFeedback();
  assert.equal(UI.cellErrors.size, 0); assert.equal(timers.size, 0);
  const engine = new GameEngine(); assert.ok(!('cellErrors' in engine.snapshot()));
});
