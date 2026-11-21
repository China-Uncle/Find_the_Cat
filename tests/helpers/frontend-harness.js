'use strict';

// Runs the real inline frontend without HTTP, a database, or browser dependencies.
// This intentionally models only DOM APIs used by these behavior tests; it is not
// a CSS layout engine or a substitute for real-browser/OAuth acceptance tests.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { webcrypto } = require('node:crypto');
const { TextEncoder } = require('node:util');

const html = fs.readFileSync(path.join(__dirname, '..', '..', 'public', 'index.html'), 'utf8');
// Fixed public puzzle contract, independent of generated/local/production DBs.
const LEVEL = Object.freeze({
  id: 1, size: 4,
  regions: Object.freeze([1, 1, 0, 0, 1, 1, 0, 0, 1, 3, 2, 2, 1, 3, 3, 2]),
});
const ANSWER = Object.freeze([2, 4, 11, 13]);
const plain = value => JSON.parse(JSON.stringify(value));
const level = (overrides = {}) => ({ ...LEVEL, regions: [...LEVEL.regions], ...overrides });
const run = (overrides = {}) => ({
  id: 'fixture-run', cats: [], hearts: 3, elapsedMs: 1234, revision: 7,
  status: 'playing', ...overrides,
});

class Element {
  constructor(tagName = 'div') {
    this.tagName = tagName.toUpperCase();
    this.children = [];
    this.dataset = {};
    this.attributes = {};
    this.className = '';
    this.hidden = false;
    this.disabled = false;
    this.textContent = '';
    this.listeners = new Map();
    this.style = { setProperty(name, value) { this[name] = value; } };
    this.clientWidth = 400;
    this.clientHeight = 400;
  }
  set innerHTML(value) { this.html = value; this.children = []; }
  get innerHTML() { return this.html || ''; }
  replaceChildren(...children) { this.html = ''; this.children = children; }
  append(...children) { this.children.push(...children); }
  setAttribute(name, value) {
    this.attributes[name] = String(value);
    if (name === 'class') this.className = value;
    if (name === 'hidden' || name === 'disabled') this[name] = true;
  }
  removeAttribute(name) { delete this.attributes[name]; }
  get classList() {
    return {
      contains: name => this.className.split(/\s+/).includes(name),
      add: (...names) => { this.className = [...new Set([...this.className.split(/\s+/), ...names])].filter(Boolean).join(' '); },
      remove: (...names) => { this.className = this.className.split(/\s+/).filter(name => !names.includes(name)).join(' '); },
    };
  }
  querySelector(selector) {
    this.queries ||= new Map();
    if (!this.queries.has(selector)) this.queries.set(selector, new Element());
    return this.queries.get(selector);
  }
  querySelectorAll(selector) {
    const names = selector.split('.').filter(Boolean);
    return this.children.filter(child => names.every(name => child.classList.contains(name)));
  }
  addEventListener(type, callback) {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type).add(callback);
  }
  async dispatch(type, event = {}) {
    const e = { target: this, preventDefault() {}, ...event };
    for (const listener of this.listeners.get(type) || []) await listener(e);
  }
  setPointerCapture(id) { this.capturedPointer = id; }
  getBoundingClientRect() { return { left: 0, top: 0, width: 400, height: 400 }; }
}

function createHarness({ storage = new Map(), hash = '', respond } = {}) {
  const elements = new Map(), classes = new Map();
  for (const match of html.matchAll(/<([a-z][\w-]*)\b([^>]*)>/gi)) {
    const el = new Element(match[1]);
    for (const attribute of match[2].matchAll(/([\w-]+)(?:="([^"]*)")?/g)) {
      el.setAttribute(attribute[1], attribute[2] ?? '');
    }
    if (el.attributes.id) elements.set(el.attributes.id, el);
    for (const name of el.className.split(/\s+/).filter(Boolean)) {
      if (!classes.has(name)) classes.set(name, el);
    }
  }
  const node = id => {
    assert.ok(elements.has(id), `Unknown HTML id: ${id}`);
    return elements.get(id);
  };
  const document = new Element('document');
  document.hidden = false;
  document.getElementById = node;
  document.createElement = tag => new Element(tag);
  document.querySelector = selector => {
    if (selector.startsWith('.')) return classes.get(selector.slice(1)) || null;
    const cell = selector.match(/^\[data-cell="(\d+)"\]$/)?.[1];
    return cell === undefined ? null : node('board').children.find(el => String(el.dataset.cell) === cell) || null;
  };
  const window = new Element('window');
  const timers = new Map(), intervals = new Map(), requests = [], navigations = [];
  let nextTimer = 0, now = 1000;
  const location = { hash, pathname: '/', assign: url => navigations.push(url) };
  const history = { replaceState(_state, _title, url) { location.hash = ''; location.pathname = url; } };
  let responder = respond || (request => { throw new Error(`Unexpected HTTP request: ${request.method} ${request.url}`); });
  const sandbox = {
    document, window, location, history, URLSearchParams, TextEncoder, crypto: webcrypto,
    performance: { now: () => now },
    localStorage: {
      getItem: key => storage.get(key) ?? null,
      setItem: (key, value) => storage.set(key, String(value)),
      removeItem: key => storage.delete(key),
    },
    async fetch(url, options = {}) {
      const request = {
        url, method: options.method || 'GET', headers: plain(options.headers || {}),
        body: options.body === undefined ? undefined : JSON.parse(options.body),
      };
      requests.push(request);
      const response = await responder(request);
      const status = response.status ?? 200;
      return { ok: status >= 200 && status < 300, status, json: async () => plain(response.body ?? {}) };
    },
    getComputedStyle: () => ({ paddingLeft: '0', paddingRight: '0', paddingTop: '0', paddingBottom: '0', columnGap: '0', rowGap: '0' }),
    requestAnimationFrame() {},
    setTimeout: callback => { timers.set(++nextTimer, callback); return nextTimer; },
    clearTimeout: id => timers.delete(id),
    setInterval: callback => { intervals.set(++nextTimer, callback); return nextTimer; },
    clearInterval: id => intervals.delete(id),
    prompt() { throw new Error('Unexpected prompt: automatic guest boot must not prompt'); },
  };
  vm.createContext(sandbox);
  const script = html.match(/<script>([\s\S]*?)<\/script>/)?.[1];
  assert.ok(script, 'frontend inline script must exist');
  const autoBoot = 'boot().catch(showError);';
  assert.equal(script.split(autoBoot).length, 2, 'expected one bootstrap call');
  vm.runInContext(script.replace(autoBoot, ''), sandbox, { filename: 'public/index.html' });
  // Access lexical bindings in this VM, without adding exports to business code.
  const api = vm.runInContext(`({
    TutorialController, GameEngine, PuzzleSolver, UI, PlatformAdapter,
    boot, initialize, loadLevel, loadSessionLevel, move, markCell, singleTap,
    setupTutorial, advanceTutorial, skipTutorial, saveLocalRun, restoreLocalRun,
    draftKey, render, renderAccount, renderWelcomeConfig, showLogin, showError,
    logout, bind, startClock, flagCellError, modal
  })`, sandbox);
  return {
    ...api, node, document, window, storage, requests, navigations, timers, intervals,
    location, setResponder: fn => { responder = fn; },
    evaluate: expression => vm.runInContext(expression, sandbox),
    advance: ms => { now += ms; },
    pointer: cell => ({ pointerId: 1, clientX: (cell % 4) * 100 + 50, clientY: Math.floor(cell / 4) * 100 + 50 }),
  };
}

module.exports = { createHarness, html, LEVEL, ANSWER, level, run, plain };
