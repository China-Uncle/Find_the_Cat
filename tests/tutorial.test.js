'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createHarness, ANSWER, level, run, plain } = require('./helpers/frontend-harness');
const { GameEngine, TutorialController, PuzzleSolver } = createHarness();

function setup(board = level(), answer = ANSWER, savedRun = {}) {
  const engine = new GameEngine();
  engine.load(board, run(savedRun), answer);
  const tutorial = new TutorialController(board, answer);
  const sync = () => {
    const automatic = Array.from(tutorial.reconcile(engine.marks, engine.status));
    for (const cell of automatic) assert.equal(engine.applyMark(cell, 1), true);
    return automatic;
  };
  sync();
  return { engine, tutorial, sync };
}

function reachStep(step, state = setup()) {
  const { engine, sync } = state;
  if (step > 1) {
    for (const cell of [8, 12]) engine.applyMark(cell, 1);
    sync();
    for (const cell of [13, 11, 2].slice(0, step - 2)) { engine.move(cell, 'place'); sync(); }
  }
  assert.equal(state.tutorial.step, step);
  return state;
}

function uiSetup(options) {
  const h = createHarness(options);
  h.UI.engine = new h.GameEngine(h.render);
  h.renderAccount({ id: 42, username: 'Fixture', isAdmin: true });
  h.UI.engine.load(level(), run(), ANSWER);
  h.setupTutorial(false);
  return h;
}

const sorted = values => [...values].sort((a, b) => a - b);

test('tutorial fixture is uniquely solved independently of any local or production DB', () => {
  const solved = new PuzzleSolver(4, level().regions).solve({ limit: 2 });
  assert.equal(solved.count, 1);
  assert.deepEqual(sorted(solved.solution), sorted(ANSWER));
});

test('five tutorial steps enforce exact targets and actions, then finish without losing hearts or time', () => {
  const { engine: e, tutorial: t, sync } = setup();
  for (const cell of [8, 12]) {
    assert.equal(t.step, 1);
    assert.deepEqual(Array.from(t.targets()), [8, 12]);
    for (let c = 0; c < 16; c++) {
      for (const action of ['mark', 'pointer', 'place', 'remove']) {
        assert.equal(t.allows(c, action), [8, 12].includes(c) && ['mark', 'pointer'].includes(action));
      }
    }
    e.applyMark(cell, 1); sync();
  }
  const expectedDemos = [[9, 10, 14], [3, 6, 7, 15], [0, 1, 5], []];
  for (const [index, target] of [13, 11, 2, 4].entries()) {
    assert.equal(t.step, index + 2);
    assert.deepEqual(Array.from(t.targets()), [target]);
    for (let cell = 0; cell < 16; cell++) {
      for (const action of ['mark', 'pointer', 'place', 'remove']) {
        assert.equal(t.allows(cell, action), cell === target && ['place', 'pointer'].includes(action));
      }
    }
    assert.equal(e.move(target, 'place').correct, true);
    assert.deepEqual(sorted(sync()), expectedDemos[index]);
    for (const cat of ANSWER) assert.notEqual(e.marks[cat], 1, 'demo cannot cross a solution cell');
    assert.deepEqual(sync(), [], 'reconciliation is idempotent');
  }
  assert.equal(t.active, false);
  assert.equal(t.step, 0);
  assert.equal(e.status, 'ready');
  assert.equal(e.hearts, 3);
  assert.equal(e.elapsedMs, 1234);
  assert.equal(e.revision, 7);
  assert.equal(e.marks.filter(mark => mark === 1).length, 12);
});

test('S2 explains both rejected red candidates and the blocked row/orange alternatives', () => {
  const { tutorial } = reachStep(2);
  const copy = tutorial.message(region => ['青柠绿', '黄色', '橙色', '红色'][region]);
  for (const phrase of [
    '红色猫若在第3行第2列', '橙色猫只能在第4行第4列', '第2行无处放猫',
    '若在第4行第3列', '封死所有橙色格', '双击高亮格找出第1只猫',
  ]) assert.ok(copy.includes(phrase), `Missing reasoning: ${phrase}\n${copy}`);
  // Validate the explanation against puzzle constraints, not only its wording.
  // Red at 9 forces orange to 15; these leave no legal yellow/green cat in row 2.
  const adjacent = (a, b) => Math.abs(Math.floor(a / 4) - Math.floor(b / 4)) <= 1 && Math.abs(a % 4 - b % 4) <= 1;
  const conflicts = (a, b) => Math.floor(a / 4) === Math.floor(b / 4) || a % 4 === b % 4 || adjacent(a, b);
  const orange = [10, 11, 15];
  assert.deepEqual(orange.filter(cell => !conflicts(cell, 9)), [15]);
  assert.deepEqual([4, 5, 6, 7].filter(cell => ![9, 15].some(cat => conflicts(cell, cat))), []);
  assert.deepEqual(orange.filter(cell => !conflicts(cell, 14)), []);
  assert.equal(new PuzzleSolver(4, level().regions).solve({ fixed: [9], limit: 2 }).count, 0);
  assert.equal(new PuzzleSolver(4, level().regions).solve({ fixed: [14], limit: 2 }).count, 0);
});

function permutations(values) {
  return values.length ? values.flatMap((value, index) => permutations(values.filter((_, i) => i !== index)).map(rest => [value, ...rest])) : [[]];
}

test('all 24 region relabelings × 8 D4 symmetries preserve targets, safe demos, positions, and completion', () => {
  let checked = 0;
  for (const labels of permutations([0, 1, 2, 3])) {
    for (let symmetry = 0; symmetry < 8; symmetry++) {
      const transform = cell => {
        let row = Math.floor(cell / 4), column = cell % 4;
        if (symmetry >= 4) column = 3 - column;
        for (let rotation = 0; rotation < symmetry % 4; rotation++) [row, column] = [column, 3 - row];
        return row * 4 + column;
      };
      const regions = [];
      level().regions.forEach((region, cell) => { regions[transform(cell)] = labels[region]; });
      const { engine: e, tutorial: t, sync } = setup(level({ regions }), ANSWER.map(transform));
      assert.equal(t.active, true, `labels=${labels}, symmetry=${symmetry}`);
      assert.deepEqual(Array.from(t.mapping), Array.from({ length: 16 }, (_, cell) => transform(cell)));
      assert.deepEqual(Array.from(t.targets()), [8, 12].map(transform));
      for (const cell of [8, 12].map(transform)) { e.applyMark(cell, 1); sync(); }
      const position = cell => `第${Math.floor(transform(cell) / 4) + 1}行第${transform(cell) % 4 + 1}列`;
      const message = t.message(region => `颜色${region}`);
      for (const cell of [9, 15, 14]) assert.ok(message.includes(position(cell)));
      assert.ok(message.includes(`颜色${labels[3]}猫`));
      assert.ok(message.includes(`颜色${labels[2]}猫`));
      for (const target of [13, 11, 2, 4].map(transform)) {
        assert.deepEqual(Array.from(t.targets()), [target]);
        e.move(target, 'place');
        const demos = sync();
        assert.ok(demos.every(cell => !ANSWER.map(transform).includes(cell)));
      }
      assert.equal(t.active, false);
      assert.equal(e.status, 'ready');
      assert.equal(e.hearts, 3);
      checked++;
    }
  }
  assert.equal(checked, 192);
});

test('nonmatching id, size, partition, or solution safely falls back to unrestricted play', () => {
  const cases = [
    [level({ id: 2 }), ANSWER], [level({ id: '1' }), ANSWER],
    [level({ size: 5 }), ANSWER], [level({ regions: Array(16).fill(0) }), ANSWER],
    [level({ regions: level().regions.slice(1) }), ANSWER],
    // Same four cats is insufficient: the actual partition must match as well.
    [level({ regions: [0, 0, 0, 1, 0, 2, 0, 1, 2, 2, 2, 2, 2, 3, 3, 3] }), ANSWER],
    [level(), [1, 4, 11, 13]], [level(), [2, 4, 11]], [level(), [2, 4, 11, 11]],
    [null, ANSWER],
  ];
  for (const [board, answer] of cases) {
    const t = new TutorialController(board, answer);
    assert.equal(t.active, false);
    assert.equal(t.mapping, null);
    assert.deepEqual(Array.from(t.targets()), []);
    assert.deepEqual(Array.from(t.reconcile(Array(16).fill(0), 'playing')), []);
    for (let cell = 0; cell < 16; cell++) {
      for (const action of ['mark', 'pointer', 'place', 'remove']) assert.equal(t.allows(cell, action), true);
    }
  }
});

for (let step = 1; step <= 5; step++) {
  test(`skip at step ${step} unlocks inputs, preserves state, and a fresh game returns to step 1`, () => {
    const { engine: e, tutorial: t, sync } = reachStep(step);
    const before = plain(e.snapshot());
    t.skip();
    assert.deepEqual(sync(), []);
    assert.equal(t.active, false);
    assert.deepEqual(plain(t.export()), { version: 1, skipped: true });
    for (let cell = 0; cell < 16; cell++) {
      for (const action of ['mark', 'pointer', 'place', 'remove']) assert.equal(t.allows(cell, action), true);
    }
    assert.deepEqual(plain(e.snapshot()), before);
    assert.equal(setup().tutorial.step, 1);
  });
}

test('terminal statuses disable tutorial without reviving the run or mutating marks/hearts', () => {
  for (const status of ['idle', 'failed', 'ready', 'completed', 'submitting', 'conflict']) {
    const { engine: e, tutorial: t, sync } = reachStep(3);
    e.status = status;
    const before = plain(e.snapshot());
    assert.deepEqual(sync(), []);
    assert.equal(t.active, false);
    assert.deepEqual(plain(e.snapshot()), before);
  }
});

test('all 16 subsets of restored cats retain progress and select the first missing tutorial cat', () => {
  const order = [13, 11, 2, 4];
  for (let mask = 0; mask < 16; mask++) {
    const cats = order.filter((_, index) => mask & (1 << index));
    const { engine: e, tutorial: t, sync } = setup(level(), ANSWER, { cats, hearts: 2 });
    for (const cat of cats) assert.equal(e.marks[cat], 2);
    assert.equal(e.hearts, 2);
    const firstMissing = order.findIndex(cell => !cats.includes(cell));
    assert.equal(t.step, mask === 0 ? 1 : firstMissing < 0 ? 0 : firstMissing + 2);
    assert.equal(t.active, mask !== 15);
    if (t.step >= 3) for (const cell of [8, 12]) assert.equal(e.marks[cell], 1);
    const before = plain(e.snapshot());
    assert.deepEqual(sync(), []);
    assert.deepEqual(plain(e.snapshot()), before);
  }
});

test('UI single tap, mark, placement, removal, and loading use the same tutorial guard', async () => {
  const h = uiSetup();
  const e = h.UI.engine;
  await h.singleTap(0);
  h.markCell(4, 1);
  await h.move(0, 'place');
  await h.move(13, 'place');
  assert.ok(e.marks.every(mark => mark === 0));
  assert.equal(e.hearts, 3);
  await h.singleTap(8);
  await h.singleTap(12);
  assert.equal(h.UI.tutorial.step, 2);
  h.markCell(13, 1);
  assert.equal(e.marks[13], 0);
  await h.move(13, 'place');
  assert.equal(h.UI.tutorial.step, 3);
  await h.move(13, 'remove');
  assert.equal(e.marks[13], 2);
  assert.equal(h.node('board').children[11].attributes['aria-disabled'], 'false');
  assert.equal(h.node('board').children[0].attributes['aria-disabled'], 'true');
  assert.ok(h.node('board').children[0].classList.contains('tutorial-locked'));
  h.UI.loading = true;
  await h.move(11, 'place');
  h.markCell(0, 1);
  assert.equal(e.marks[11], 0);
  h.UI.loading = false;
  h.skipTutorial();
  assert.equal(h.node('tutorial').hidden, true);
  await h.move(13, 'remove');
  h.markCell(0, 1);
  assert.equal(e.marks[13], 0);
  assert.equal(e.marks[0], 1);
});

test('actual pointer drag/tap bindings cannot mark locked cells or remove a tutorial cat', async () => {
  const h = uiSetup();
  h.bind();
  const board = h.node('board'), e = h.UI.engine;
  await board.dispatch('pointerdown', h.pointer(0));
  assert.equal(h.UI.gesture, null);
  await board.dispatch('pointerdown', h.pointer(8));
  await board.dispatch('pointermove', h.pointer(9));
  assert.equal(e.marks[9], 0);
  await board.dispatch('pointermove', h.pointer(12));
  await board.dispatch('pointerup', h.pointer(12));
  assert.equal(h.UI.tutorial.step, 2);
  assert.equal(e.marks[8], 1);
  assert.equal(e.marks[12], 1);
  for (let tap = 0; tap < 2; tap++) {
    await board.dispatch('pointerdown', h.pointer(13));
    await board.dispatch('pointerup', h.pointer(13));
  }
  assert.equal(e.marks[13], 2);
  assert.equal(h.UI.tutorial.step, 3);
  await board.dispatch('pointerdown', h.pointer(13));
  assert.equal(h.UI.gesture, null);
  await board.dispatch('pointerdown', h.pointer(11));
  await board.dispatch('pointermove', h.pointer(0));
  await board.dispatch('pointerup', h.pointer(0));
  assert.equal(e.marks[0], 0);
  assert.equal(e.marks[11], 0, 'drag must not turn a cat-only target into a cross');
  assert.equal(e.hearts, 3);
});

test('same-run tutorial skip and local marks restore after refresh; explicit restart clears the skip', async () => {
  const first = uiSetup();
  await first.singleTap(8); await first.singleTap(12); await first.move(13, 'place');
  first.skipTutorial();
  const key = 'findcat:' + first.draftKey();
  assert.equal(JSON.parse(first.storage.get(key)).tutorial.skipped, true);
  const fresh = uiSetup({ storage: first.storage });
  // uiSetup has not saved over the persisted draft; emulate loadLevel's restore order.
  fresh.restoreLocalRun(); fresh.setupTutorial(false);
  assert.equal(fresh.UI.tutorial.active, false);
  assert.equal(fresh.UI.engine.marks[13], 2);
  assert.equal(fresh.UI.engine.marks[8], 1);
  fresh.setResponder(request => {
    assert.equal(request.url, '/api/game/start');
    assert.deepEqual(request.body, { restart: true });
    return { body: { level: level(), run: run({ id: 'restarted-run' }) } };
  });
  await fresh.loadLevel(true);
  assert.equal(fresh.UI.tutorial.step, 1);
  assert.equal(fresh.UI.tutorial.active, true);
  assert.ok(fresh.UI.engine.marks.every(mark => mark === 0));
});

test('skip restoration is scoped to exact account, mode, run, board, and tutorial version', () => {
  const baseline = uiSetup();
  baseline.skipTutorial();
  const key = 'findcat:' + baseline.draftKey();
  const original = JSON.parse(baseline.storage.get(key));
  const variants = [
    { ...original, runId: 'different-run' },
    { ...original, levelId: 2 },
    { ...original, size: 5 },
    { ...original, regions: 'different-board' },
    { ...original, tutorial: { version: 2, skipped: true } },
    { ...original, tutorial: { version: 1, skipped: false } },
  ];
  for (const draft of variants) {
    const h = uiSetup({ storage: new Map([[key, JSON.stringify(draft)]]) });
    h.setupTutorial(false);
    assert.equal(h.UI.tutorial.active, true);
  }
  for (const storedKey of ['findcat:local-run:99:normal', 'findcat:local-run:42:practice']) {
    const h = uiSetup({ storage: new Map([[storedKey, JSON.stringify(original)]]) });
    h.setupTutorial(false);
    assert.equal(h.UI.tutorial.active, true);
  }
});

test('normal and administrator practice loads share tutorial behavior without crossing API namespaces', async () => {
  for (const mode of ['normal', 'practice']) {
    const h = uiSetup();
    h.setResponder(request => {
      assert.equal(request.url, mode === 'practice' ? '/api/admin/practice/start' : '/api/game/start');
      assert.deepEqual(request.body, mode === 'practice' ? { restart: false, levelId: 1 } : { restart: false });
      return { body: { level: level(), run: run({ id: `${mode}-run` }) } };
    });
    await h.loadLevel(false, { mode, levelId: 1 });
    assert.equal(h.UI.tutorial.active, true);
    assert.equal(h.UI.tutorial.step, 1);
    assert.equal(h.UI.mode, mode);
  }
});
