'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const html = fs.readFileSync(path.join(__dirname, '..', 'public/index.html'), 'utf8');

function harness(storage = new Map()) {
  class Node {
    constructor() { this.children = []; this.dataset = {}; this.attributes = {}; this.style = { setProperty() {} }; this.className = ''; }
    set innerHTML(value) { this.children = []; this.html = value; }
    get innerHTML() { return this.html; }
    replaceChildren() { this.children = []; this.html = ''; }
    append(node) { this.children.push(node); }
    setAttribute(key, value) { this.attributes[key] = value; }
    removeAttribute(key) { delete this.attributes[key]; }
    get classList() { return { add: name => this.className += ' ' + name, remove: name => { this.className = this.className.split(' ').filter(x => x !== name).join(' '); } }; }
    querySelector(selector) { this.queries ||= new Map(); if (!this.queries.has(selector)) this.queries.set(selector, new Node()); return this.queries.get(selector); }
    querySelectorAll() { return this.children.filter(x => x.className.split(' ').includes('cat')); }
  }
  const elements = new Map(), timers = new Map(), intervals = new Map(); let nextTimer = 0, now = 1000;
  const node = id => { if (!elements.has(id)) elements.set(id, new Node()); return elements.get(id); };
  const sandbox = { performance:{now:()=>now},localStorage:{getItem:k=>storage.get(k)??null,setItem:(k,v)=>storage.set(k,String(v)),removeItem:k=>storage.delete(k)},document: {
    getElementById: node, createElement: () => new Node(),
    querySelector: selector => node('board').children.find(x => String(x.dataset.cell) === selector.match(/data-cell="(\d+)"/)?.[1])
  }, setInterval:callback=>{intervals.set(++nextTimer,callback);return nextTimer;},clearInterval:id=>intervals.delete(id),requestAnimationFrame() {}, setTimeout: callback => { timers.set(++nextTimer, callback); return nextTimer; }, clearTimeout: id => timers.delete(id) };
  vm.createContext(sandbox);
  const script = html.match(/<script>([\s\S]*?)<\/script>/)[1].replace('boot().catch(showError);', '');
  vm.runInContext(script, sandbox);
  const api = vm.runInContext('({UI, CAT, GameEngine, PlatformAdapter, gameApi, loadLevel, render, flagCellError, clearCellFeedback, showWin, showPracticeWin, closeModal, finishLevel, continueAfterCompletion, move, markCell, saveLocalRun, restoreLocalRun, draftKey, PuzzleSolver, singleTap, initialize, loadSessionLevel, startClock, updateClock, handleVisibility, flushLocalRun})', sandbox);
  return { ...api, node, timers, storage, intervals, document:sandbox.document, advance:ms=>now+=ms };
}
const snapshot = () => ({ level: { id: 1, size: 4, regions: [1,0,0,2,1,0,2,2,1,3,2,2,1,3,2,2] }, marks: Array(16).fill(0), hearts: 3, elapsedMs: 0, status: 'playing' });

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


test('normal and practice use different server endpoints and default is normal', () => {
  const { UI, gameApi } = harness();
  assert.equal(UI.mode, 'normal');
  assert.equal(gameApi('move'), '/api/game/move');
  UI.mode = 'practice';
  assert.equal(gameApi('move'), '/api/admin/practice/move');
  assert.equal(gameApi('start', 'normal'), '/api/game/start');
});

test('only admins can switch to practice; failed requests do not switch modes', async () => {
  const { UI, GameEngine, loadLevel, PlatformAdapter } = harness();
  UI.engine = new GameEngine();
  let calls = 0;
  PlatformAdapter.request = async () => {calls++; throw new Error('offline');};
  await assert.rejects(loadLevel(false, {mode:'practice', levelId:2}), /仅管理员/);
  assert.equal(calls, 0);
  UI.account = {isAdmin:true};
  await assert.rejects(loadLevel(false, {mode:'practice', levelId:2}), /offline/);
  assert.equal(UI.mode, 'normal'); assert.equal(UI.loading, false);
});

test('switching practice preserves normal run and manual marks, with no levelId sent to scoring API', async () => {
  const { UI, GameEngine, render, loadLevel, PlatformAdapter } = harness();
  UI.account = {isAdmin:true}; UI.engine = new GameEngine(render);
  const level = snapshot().level;
  const run = {id:'normal-run',cats:[2],hearts:2,elapsedMs:5000,revision:1,status:'playing'};
  UI.engine.load(level, run); UI.engine.applyMark(3,1);
  const requests=[];
  PlatformAdapter.request = async (url, options) => {
    requests.push([url,options.body]);
    return url.includes('/practice/') ? {level:{...level,id:5},run:{...run,id:'practice-run',hearts:3,cats:[],revision:0}} : {level,run};
  };
  await loadLevel(true, {mode:'practice',levelId:5});
  assert.equal(UI.mode, 'practice'); assert.equal(UI.engine.level.id,5);
  assert.equal(UI.engine.hearts,3); assert.equal(UI.engine.marks[3],0);
  await loadLevel(false, {mode:'normal'});
  assert.equal(UI.mode,'normal'); assert.equal(UI.engine.run.id,'normal-run');
  assert.equal(UI.engine.hearts,2); assert.equal(UI.engine.marks[2],2); assert.equal(UI.engine.marks[3],1);
  assert.equal(requests[0][0], '/api/admin/practice/start');
  assert.deepEqual({...requests[0][1]}, {restart:true,levelId:5});
  assert.equal(requests[1][0], '/api/game/start');
  assert.deepEqual({...requests[1][1]}, {restart:false});
});

test('a pending submission prevents mode switch and does not send any start request', async () => {
  const { UI, GameEngine, loadLevel, PlatformAdapter } = harness();
  UI.engine = new GameEngine(); UI.account={isAdmin:true};UI.engine.status='submitting';
  let calls=0; PlatformAdapter.request=async()=>{calls++;};
  assert.equal(await loadLevel(true,{mode:'practice',levelId:2}),false);
  assert.equal(calls,0); assert.equal(UI.mode,'normal');
});


test('dismissing a win leaves a next-level button and reopenable result without another completion write', async () => {
  const {UI,GameEngine,render,node,showWin,closeModal,PlatformAdapter}=harness();
  UI.engine=new GameEngine(render);
  UI.engine.load(snapshot().level,{id:'won-run',cats:[2,4,11,13],status:'completed',hearts:3,elapsedMs:5000,revision:4});
  const result={levelId:1,elapsedMs:5000,top3:[],allComplete:false};
  await showWin(result); closeModal();
  assert.equal(node('restart').textContent,'继续下一关');
  assert.match(node('subrow').innerHTML,/reopenResult/);
  let calls=[];
  PlatformAdapter.request=async(url,options)=>{calls.push([url,options.body]);return {level:{...snapshot().level,id:2},run:{id:'next-run',cats:[],hearts:3,elapsedMs:0,revision:0,status:'playing'}};};
  node('reopenResult').onclick();
  assert.match(node('modal').innerHTML,/第 1 关完成/);
  assert.equal(calls.length,0,'reopening is presentation only');
  closeModal();await node('restart').onclick();
  assert.equal(calls.length,1);assert.equal(calls[0][0],'/api/game/start');
  assert.equal(calls[0][1].restart,false);assert.equal(UI.level,2);
  assert.equal(node('restart').textContent,'重新开始');assert.equal(UI.completionResult,null);
});

test('failed next-level request preserves the completed board and its recovery controls', async () => {
  const {UI,GameEngine,render,node,showWin,closeModal,PlatformAdapter}=harness();
  UI.engine=new GameEngine(render);UI.engine.load(snapshot().level,{id:'won-run',cats:[],status:'completed',hearts:3});
  await showWin({levelId:1,elapsedMs:1000,allComplete:false});closeModal();
  PlatformAdapter.request=async()=>{throw Error('offline');};
  await node('restart').onclick();
  assert.equal(UI.engine.status,'completed');assert.equal(UI.engine.run.id,'won-run');
  assert.equal(node('restart').textContent,'继续下一关');assert.ok(UI.completionResult);
});

test('practice win recovery advances only practice; last official level checks updates without replay', async () => {
  const {UI,GameEngine,render,node,showWin,showPracticeWin,closeModal,PlatformAdapter}=harness();
  UI.account={isAdmin:true};UI.mode='practice';UI.engine=new GameEngine(render);
  UI.engine.load(snapshot().level,{id:'practice-won',cats:[],status:'completed',hearts:3});
  showPracticeWin({levelId:1,elapsedMs:1000,nextLevelId:5});closeModal();
  assert.equal(node('restart').textContent,'试下一关');
  let request;
  PlatformAdapter.request=async(url,options)=>{request=[url,options.body];return {level:{...snapshot().level,id:5},run:{id:'next-practice',cats:[],status:'playing',hearts:3}};};
  await node('restart').onclick();
  assert.equal(request[0],'/api/admin/practice/start');assert.equal(request[1].levelId,5);assert.equal(request[1].restart,true);
  UI.mode='normal';UI.engine.setStatus('completed');
  await showWin({levelId:5,elapsedMs:1000,allComplete:true});closeModal();
  assert.equal(node('restart').textContent,'检查新关卡');
  PlatformAdapter.request=async(url,options)=>{request=[url,options.body];return {allComplete:true};};
  await node('restart').onclick();assert.equal(request[0],'/api/game/start');assert.equal(request[1].restart,false);
});

test('closing a completion error leaves a retry action instead of a stranded ready board', async () => {
  const {UI,GameEngine,render,node,finishLevel,closeModal,PlatformAdapter}=harness();
  UI.engine=new GameEngine(render);UI.engine.load(snapshot().level,{id:'ready-run',cats:[2,4,11,13],status:'ready',hearts:3,revision:4});
  let count=0;
  PlatformAdapter.request=async()=>{if(++count===1)throw Error('offline');return {levelId:1,elapsedMs:1000,allComplete:false};};
  await finishLevel();closeModal();
  assert.equal(node('restart').textContent,'重试结算');assert.equal(UI.completeLock,false);
  await node('restart').onclick();assert.equal(count,2);assert.equal(UI.engine.status,'completed');
  assert.equal(node('restart').textContent,'继续下一关');
});


test('a late board click cannot dismiss a newly opened win backdrop', async () => {
  const {node,showWin}=harness();
  await showWin({levelId:1,elapsedMs:1000,allComplete:false});
  const overlay=node('modal').querySelector('[data-overlay]');
  overlay.onclick({target:overlay});
  assert.match(node('modal').innerHTML,/第 1 关完成/,'no backdrop pointerdown means an old board click');
  overlay.onpointerdown({target:overlay});overlay.onclick({target:overlay});
  assert.equal(node('modal').innerHTML,'','a deliberate backdrop click may still close');
});


test('local correct cats, errors, removal and crosses never request the server', async()=>{
  const {UI,GameEngine,render,move,markCell,PlatformAdapter,node}=harness();
  UI.engine=new GameEngine(render);UI.engine.load(snapshot().level,{id:'local-run',cats:[],status:'playing',hearts:3,elapsedMs:0});
  let requests=0;PlatformAdapter.request=async()=>{requests++;throw Error('must stay local');};
  markCell(3,1);assert.equal(UI.engine.marks[3],1);markCell(3,0);
  await move(2,'place');assert.equal(UI.engine.marks[2],2);
  await move(2,'remove');assert.equal(UI.engine.marks[2],0);
  await move(0,'place');assert.equal(UI.engine.hearts,2);assert.equal(UI.engine.marks[0],0);
  assert.match(node('board').children[0].className,/error/);
  await move(0,'place');await move(0,'place');assert.equal(UI.engine.status,'failed');
  await move(2,'place');markCell(3,1);assert.equal(UI.engine.marks[2],0);assert.equal(UI.engine.marks[3],0);
  assert.equal(requests,0);
});

test('all cats trigger one final submit and block duplicate placement/submit while awaiting response',async()=>{
  const {UI,GameEngine,render,move,finishLevel,PlatformAdapter}=harness();
  UI.engine=new GameEngine(render);UI.engine.load(snapshot().level,{id:'local-run',cats:[],status:'playing',hearts:3,elapsedMs:0});
  let requests=[],resolve;
  PlatformAdapter.request=(url,options)=>{requests.push([url,options.body]);return new Promise(r=>resolve=r);};
  for(const c of [2,4,11])await move(c,'place');assert.equal(requests.length,0);
  const pending=move(13,'place');assert.equal(UI.engine.marks[13],2);assert.equal(UI.engine.status,'submitting');
  await move(0,'place');await finishLevel();assert.equal(requests.length,1);
  assert.equal(requests[0][0],'/api/game/submit');assert.deepEqual(Array.from(requests[0][1].cats),[2,4,11,13]);
  assert.deepEqual(Object.keys(requests[0][1]).sort(),['cats','levelId','runId']);
  resolve({levelId:1,elapsedMs:2345,allComplete:false});await pending;
  assert.equal(UI.engine.status,'completed');assert.equal(UI.engine.elapsedMs,2345);
});

test('failed final submission retains every cat and local hearts for a single safe retry',async()=>{
  const {UI,GameEngine,render,move,PlatformAdapter,closeModal,node}=harness();
  UI.engine=new GameEngine(render);UI.engine.load(snapshot().level,{id:'offline-run',cats:[],status:'playing',hearts:3,elapsedMs:0});
  let requests=0;PlatformAdapter.request=async()=>{requests++;throw Error('offline');};
  await move(0,'place');for(const c of [2,4,11,13])await move(c,'place');
  assert.equal(requests,1);assert.equal(UI.engine.status,'ready');assert.equal(UI.engine.hearts,2);
  assert.equal(UI.engine.marks.filter(v=>v===2).length,4);closeModal();
  PlatformAdapter.request=async(url)=>{requests++;assert.equal(url,'/api/game/submit');return {levelId:1,elapsedMs:3000};};
  await node('restart').onclick();assert.equal(requests,2);assert.equal(UI.engine.status,'completed');
});

test('local draft resumes marks/cats/hearts on same run, but not on restart or another account/mode',async()=>{
  const {UI,GameEngine,render,move,markCell,saveLocalRun,loadLevel,PlatformAdapter}=harness();
  UI.account={id:1,isAdmin:true};const storage=new Map();
  PlatformAdapter.setStorage=(k,v)=>storage.set(k,String(v));
  PlatformAdapter.getStorage=k=>storage.get(k);
  const run={id:'same-run',cats:[],hearts:3,status:'playing',elapsedMs:5000,revision:0};
  UI.engine=new GameEngine(render);UI.engine.load(snapshot().level,run);
  await move(2,'place');await move(0,'place');markCell(3,1);saveLocalRun();UI.drafts.clear();
  PlatformAdapter.request=async()=>({level:snapshot().level,run});
  await loadLevel();assert.equal(UI.engine.marks[2],2);assert.equal(UI.engine.marks[3],1);assert.equal(UI.engine.hearts,2);
  PlatformAdapter.request=async()=>({level:snapshot().level,run:{...run,id:'new-run'}});
  await loadLevel(true);assert.equal(UI.engine.hearts,3);assert.equal(UI.engine.marks.filter(v=>v).length,0);
  UI.account={id:2,isAdmin:true};PlatformAdapter.request=async()=>({level:snapshot().level,run});
  await loadLevel();assert.equal(UI.engine.marks.filter(v=>v).length,0);assert.equal(UI.engine.hearts,3);
});

test('restored local failure stays failed and damaged storage is ignored',()=>{
  const {GameEngine}=harness();const e=new GameEngine();e.load(snapshot().level,{id:'r',cats:[],hearts:3,status:'playing'});
  assert.equal(e.restoreLocal({marks:Array(16).fill(0),hearts:0}),true);assert.equal(e.status,'failed');
  assert.equal(e.move(2,'place'),null);
  e.load(snapshot().level,{id:'r2',cats:[],hearts:3,status:'playing'});
  const invalid=Array(16).fill(0);invalid[0]=2;
  assert.equal(e.restoreLocal({marks:invalid,hearts:3}),false);assert.equal(e.hearts,3);
  assert.equal(e.restoreLocal({marks:Array(16).fill(0),hearts:99}),false);
});

test('browser solver agrees with server MRV for generated 4–11 boards and rejects ambiguous/corrupt maps',()=>{
  const {GameEngine,PuzzleSolver}=harness();const {LevelGenerator,Solver}=require('../level_generator');
  for(let n=4;n<=11;n++){
    const level=LevelGenerator.generate(n,12345+n),map=Array.from(level.map);
    const expected=new Solver(n,map).solve({limit:2});
    const actual=new PuzzleSolver(n,map).solve({limit:2});
    assert.equal(actual.count,1);assert.deepEqual(Array.from(actual.solution),expected.solution);
    assert.deepEqual(Array.from(GameEngine.prepare({size:n,regions:map})),expected.solution);
  }
  assert.throws(()=>GameEngine.prepare({size:4,regions:Array.from({length:16},(_,i)=>Math.floor(i/4))}),/唯一解/);
  assert.throws(()=>GameEngine.prepare({size:4,regions:[0]}),/无效/);
});

test('drafts survive a real string-only storage boundary and a new JS session, including failed hearts',async()=>{
  const storage=new Map(), a=harness(storage);
  a.UI.account={id:17,isAdmin:true};a.UI.engine=new a.GameEngine(a.render);
  const run={id:'persisted',cats:[],hearts:3,status:'playing',elapsedMs:0,revision:0};
  a.UI.engine.load(snapshot().level,run);
  await a.move(2,'place');a.markCell(3,1);await a.move(0,'place');
  const raw=storage.get('findcat:local-run:17:normal');assert.equal(typeof raw,'string');assert.equal(JSON.parse(raw).hearts,2);
  const b=harness(storage);b.UI.account={id:17,isAdmin:true};b.UI.engine=new b.GameEngine(b.render);
  b.PlatformAdapter.request=async()=>({level:snapshot().level,run});
  await b.loadLevel();assert.equal(b.UI.engine.marks[2],2);assert.equal(b.UI.engine.marks[3],1);assert.equal(b.UI.engine.hearts,2);
  await b.move(0,'place');await b.move(0,'place');assert.equal(b.UI.engine.status,'failed');
  const c=harness(storage);c.UI.account={id:17};c.UI.engine=new c.GameEngine(c.render);
  c.PlatformAdapter.request=async()=>({level:snapshot().level,run});
  await c.loadLevel();assert.equal(c.UI.engine.status,'failed');assert.equal(c.UI.engine.hearts,0);
  await c.move(4,'place');assert.equal(c.UI.engine.marks[4],0);assert.equal(c.UI.engine.marks[2],2);
});

test('corrupt or stale persisted drafts cannot overwrite newer legacy server state',async()=>{
  const h=harness();h.UI.account={id:18};h.UI.engine=new h.GameEngine(h.render);
  const run={id:'legacy',cats:[2],hearts:2,status:'playing',elapsedMs:0,revision:2};
  for(const raw of ['[object Object]','{bad','null','"text"',JSON.stringify({version:1,runId:'legacy',levelId:1,size:4,revision:1,regions:snapshot().level.regions.join(','),marks:Array(16).fill(0),hearts:0})]){
    h.UI.drafts.clear();h.storage.set('findcat:local-run:18:normal',raw);
    h.PlatformAdapter.request=async()=>({level:snapshot().level,run});await h.loadLevel();
    assert.equal(h.UI.engine.marks[2],2);assert.equal(h.UI.engine.hearts,2);assert.equal(h.UI.engine.status,'playing');
  }
  const e=h.UI.engine;e.load(snapshot().level,{...run,status:'failed',hearts:0});
  assert.equal(e.restoreLocal({marks:Array(16).fill(0),hearts:3}),false);assert.equal(e.status,'failed');
});

test('refresh restores only this account admin mode and level, never a nonadmin practice session',async()=>{
  const storage=new Map(),a=harness(storage);a.UI.account={id:19,isAdmin:true};a.UI.engine=new a.GameEngine(a.render);
  const run={id:'practice',cats:[],hearts:3,status:'playing',elapsedMs:0,revision:0};
  a.PlatformAdapter.request=async()=>({level:{...snapshot().level,id:7},run});
  await a.loadLevel(false,{mode:'practice',levelId:7});await a.move(2,'place');await a.move(0,'place');
  for(const [id,isAdmin,mode] of [[19,true,'practice'],[20,true,'normal'],[19,false,'normal']]){
    const b=harness(storage);b.UI.account={id,isAdmin};b.UI.engine=new b.GameEngine(b.render);
    const requests=[];b.PlatformAdapter.request=async(url,options)=>{requests.push([url,options.body]);return {level:{...snapshot().level,id:7},run};};
    await b.loadSessionLevel();assert.equal(b.UI.mode,mode);assert.equal(requests.length,1);
    assert.equal(requests[0][0],mode==='practice'?'/api/admin/practice/start':'/api/game/start');
    if(mode==='practice'){assert.equal(requests[0][1].levelId,7);assert.equal(b.UI.engine.marks[2],2);assert.equal(b.UI.engine.hearts,2);}
    else assert.equal(b.UI.engine.hearts,3);
  }
});

test('loading errors and invalid puzzles preserve the current board, draft, mode, account and auth',async()=>{
  const h=harness();h.UI.account={id:21,isAdmin:true};h.UI.engine=new h.GameEngine(h.render);
  h.PlatformAdapter.setStorage('token','test-only-token');
  h.UI.engine.load(snapshot().level,{id:'keep',cats:[2],hearts:2,status:'playing',elapsedMs:0,revision:0});h.markCell(3,1);
  for(const response of [async()=>{throw Error('offline');},async()=>({level:{...snapshot().level,regions:[]},run:{}})]){
    h.PlatformAdapter.request=response;
    await assert.rejects(h.loadLevel(false,{mode:'practice',levelId:10}));
    assert.equal(h.UI.engine.run.id,'keep');assert.equal(h.UI.engine.marks[2],2);assert.equal(h.UI.engine.marks[3],1);
    assert.equal(h.UI.mode,'normal');assert.equal(h.UI.loading,false);assert.equal(h.PlatformAdapter.getStorage('token'),'test-only-token');
  }
  h.PlatformAdapter.request=async url=>{
    if(url==='/api/config')return {};
    if(url==='/api/me')return {user:{id:21,isAdmin:true}};
    throw Error('start offline');
  };
  await assert.rejects(h.initialize(),/start offline/);
  assert.equal(h.PlatformAdapter.getStorage('token'),'test-only-token');assert.equal(h.UI.account.id,21);assert.equal(h.UI.engine.run.id,'keep');
});

test('completed legacy practice reload shows its receipt without a duplicate submit',async()=>{
  const h=harness();h.UI.account={id:22,isAdmin:true};h.UI.engine=new h.GameEngine(h.render);const requests=[];
  h.PlatformAdapter.request=async url=>{requests.push(url);return {totalLevels:3,level:snapshot().level,run:{id:'done',cats:[2,4,11,13],hearts:2,status:'completed',elapsedMs:8000,revision:4}};};
  await h.loadLevel(false,{mode:'practice',levelId:1});assert.deepEqual(requests,['/api/admin/practice/start']);
  assert.equal(h.UI.engine.status,'completed');h.closeModal();assert.equal(h.node('restart').textContent,'试下一关');
  h.node('reopenResult').onclick();assert.equal(requests.length,1);
});

test('single-tapping a cat is a no-op; removal is explicit and local',async()=>{
  const h=harness();h.UI.engine=new h.GameEngine(h.render);h.UI.engine.load(snapshot().level,{id:'tap',cats:[2],hearts:3,status:'playing',elapsedMs:0});
  h.PlatformAdapter.request=async()=>{throw Error('no network expected');};
  await h.singleTap(2);assert.equal(h.UI.engine.marks[2],2);assert.equal(h.UI.engine.hearts,3);
  await h.move(2,'remove');assert.equal(h.UI.engine.marks[2],0);
});

test('hidden-tab display time follows server wall time and restarts after a hidden failed run',async()=>{
  const h=harness();h.UI.engine=new h.GameEngine(h.render);
  const run={id:'clock',cats:[],hearts:3,status:'playing',elapsedMs:1000};h.UI.engine.load(snapshot().level,run);h.startClock();
  assert.equal(h.intervals.size,1);h.advance(500);h.document.hidden=true;h.handleVisibility();
  assert.equal(h.UI.engine.elapsedMs,1500);assert.equal(h.intervals.size,0);
  h.advance(10000);h.document.hidden=false;h.handleVisibility();assert.equal(h.UI.engine.elapsedMs,11500);assert.equal(h.intervals.size,1);
  h.document.hidden=true;h.handleVisibility();h.UI.engine.status='failed';h.document.hidden=false;h.handleVisibility();assert.equal(h.intervals.size,0);
  h.PlatformAdapter.request=async()=>({level:snapshot().level,run:{...run,id:'new-clock'}});
  await h.loadLevel(true);assert.equal(h.intervals.size,1);h.advance(1000);h.updateClock();assert.equal(h.UI.engine.elapsedMs,2000);
});

test('a loaded run solves once, then rapid local moves and final submit never solve again',async()=>{
  const h=harness();h.UI.engine=new h.GameEngine(h.render);let solves=0;const solve=h.PuzzleSolver.prototype.solve;
  h.PuzzleSolver.prototype.solve=function(options){solves++;return solve.call(this,options);};
  const requests=[];h.PlatformAdapter.request=async(url)=>{requests.push(url);return url.endsWith('/start')?
    {level:snapshot().level,run:{id:'one-solve',cats:[],hearts:3,status:'playing',elapsedMs:0,revision:0}}:{levelId:1,elapsedMs:3000};};
  await h.loadLevel();assert.equal(solves,1);
  await Promise.all([h.move(2,'place'),h.move(4,'place'),h.move(11,'place')]);h.markCell(3,1);
  await h.move(2,'remove');await h.move(2,'place');assert.equal(solves,1);assert.deepEqual(requests,['/api/game/start']);
  await Promise.all([h.move(13,'place'),h.finishLevel(),h.finishLevel()]);
  assert.equal(solves,1);assert.deepEqual(requests,['/api/game/start','/api/game/submit']);
});

test('blocked browser storage never prevents in-memory local play or mode recovery',async()=>{
  const blocked={get(){throw Error('denied');},set(){throw Error('quota');},delete(){throw Error('denied');}};
  const h=harness(blocked);h.UI.account={id:23,isAdmin:true};h.UI.engine=new h.GameEngine(h.render);
  const run={id:'storage-blocked',cats:[],hearts:3,status:'playing',elapsedMs:0,revision:0};
  h.PlatformAdapter.request=async()=>({level:snapshot().level,run});await h.loadLevel();
  await h.move(2,'place');await h.move(0,'place');h.markCell(3,1);await h.loadLevel();
  assert.equal(h.UI.engine.hearts,2);assert.equal(h.UI.engine.marks[2],2);assert.equal(h.UI.engine.marks[3],1);
});

test('legacy ready run submits once; legacy failed run never resumes or submits',async()=>{
  const h=harness();h.UI.engine=new h.GameEngine(h.render);const requests=[];
  h.PlatformAdapter.request=async url=>{requests.push(url);return url.endsWith('/start')?{level:snapshot().level,
    run:{id:'legacy-ready',cats:[2,4,11,13],hearts:1,status:'ready',elapsedMs:5000,revision:4}}:{levelId:1,elapsedMs:6000};};
  await h.loadLevel();assert.deepEqual(requests,['/api/game/start','/api/game/submit']);assert.equal(h.UI.engine.status,'completed');
  requests.length=0;h.PlatformAdapter.request=async url=>{requests.push(url);return {level:snapshot().level,
    run:{id:'legacy-failed',cats:[2],hearts:0,status:'failed',elapsedMs:5000,revision:4}};};
  await h.loadLevel();assert.deepEqual(requests,['/api/game/start']);assert.equal(h.UI.engine.status,'failed');assert.equal(h.UI.engine.marks[2],2);
});

test('an account switch cannot overwrite the destination account draft with the previous board',async()=>{
  const storage=new Map(),h=harness(storage);h.UI.engine=new h.GameEngine(h.render);
  const runs={a:{id:'account-a',cats:[],hearts:3,status:'playing',elapsedMs:0,revision:0},b:{id:'account-b',cats:[],hearts:3,status:'playing',elapsedMs:0,revision:0}};
  h.UI.account={id:24};h.PlatformAdapter.request=async()=>({level:snapshot().level,run:runs.b});
  await h.loadLevel();await h.move(4,'place');await h.move(0,'place');
  const savedB=storage.get('findcat:local-run:24:normal');
  h.UI.account={id:25};h.PlatformAdapter.request=async()=>({level:snapshot().level,run:runs.a});
  await h.loadLevel();await h.move(2,'place');
  assert.equal(storage.get('findcat:local-run:24:normal'),savedB);
  h.UI.account={id:24};h.PlatformAdapter.request=async()=>({level:snapshot().level,run:runs.b});
  await h.loadLevel();assert.equal(h.UI.engine.marks[4],2);assert.equal(h.UI.engine.marks[2],0);assert.equal(h.UI.engine.hearts,2);
});

function persistedDraft(runId='mixed-run', overrides={}) {
  const marks=Array(16).fill(0);marks[2]=2;marks[3]=1;marks[4]=1;
  return {version:1,runId,levelId:1,size:4,revision:0,regions:snapshot().level.regions.join(','),marks,hearts:3,...overrides};
}
function draftStorage(mode,draft) {return new Map([[`findcat:local-run:31:${mode}`,JSON.stringify(draft)]]);}
async function loadStoredDraft(storage,mode,run) {
  const h=harness(storage);h.UI.account={id:31,isAdmin:true};h.UI.engine=new h.GameEngine(h.render);
  h.requests=[];h.PlatformAdapter.request=async(url,options)=>{h.requests.push([url,options?.body]);return {level:snapshot().level,run,totalLevels:3};};
  await h.loadLevel(false,{mode,levelId:1});return h;
}
const mixedRun = overrides=>({id:'mixed-run',cats:[4],hearts:2,status:'playing',elapsedMs:2000,revision:1,...overrides});

test('mixed old/new revision refresh merges crosses only in normal and practice with server cats/hearts first',async()=>{
  for(const mode of ['normal','practice']) {
    const original=persistedDraft(),storage=draftStorage(mode,original);
    let h=await loadStoredDraft(storage,mode,mixedRun());
    assert.equal(h.UI.engine.marks[2],0,'old local cat must not reappear');
    assert.equal(h.UI.engine.marks[3],1,'manual cross survives revision mismatch');
    assert.equal(h.UI.engine.marks[4],2,'server cat wins over manual cross');
    assert.equal(h.UI.engine.hearts,2,'old hearts must not overwrite server');assert.equal(h.UI.engine.status,'playing');
    const backupKey=`findcat:local-run:31:${mode}:conflict`,backup=JSON.parse(storage.get(backupKey));
    assert.deepEqual(backup.draft,{...original,conflict:false});assert.equal(backup.reason,'server-revision-changed');
    const primary=JSON.parse(storage.get(`findcat:local-run:31:${mode}`));assert.equal(primary.revision,1);assert.equal(primary.marks[3],1);
    h=await loadStoredDraft(storage,mode,mixedRun());assert.equal(h.UI.engine.marks[3],1);assert.equal(h.UI.engine.marks[4],2);assert.equal(h.UI.engine.hearts,2);
    assert.equal(h.requests.length,1);assert.ok(!h.requests[0][0].endsWith('/move'));
    assert.deepEqual(JSON.parse(storage.get(backupKey)),backup,'ordinary refresh never overwrites original backup');
  }
});

test('revision conflict never revives a failed/lower-heart draft and lock survives refresh, sync and mode switch',async()=>{
  for(const mode of ['normal','practice'])for(const hearts of [0,1]) {
    const storage=draftStorage(mode,persistedDraft('mixed-run',{hearts}));
    let h=await loadStoredDraft(storage,mode,mixedRun({hearts:3}));
    assert.equal(h.UI.engine.status,'conflict');assert.equal(h.UI.engine.hearts,3,'keep server value without granting playable hearts');
    assert.equal(h.node('hearts').textContent,'待同步');assert.equal(h.UI.engine.marks[2],0);assert.equal(h.UI.engine.marks[3],1);
    const before=Array.from(h.UI.engine.marks);await h.move(11,'place');h.markCell(5,1);await h.finishLevel();
    assert.deepEqual(Array.from(h.UI.engine.marks),before);assert.equal(h.requests.length,1,'conflict cannot submit or move');
    await h.loadLevel();assert.equal(h.UI.engine.status,'conflict','same-run sync cannot revive');
    h=await loadStoredDraft(storage,mode,mixedRun({hearts:3}));assert.equal(h.UI.engine.status,'conflict','new JS session must remain locked');
    assert.equal(h.UI.engine.marks[3],1);
    h.PlatformAdapter.request=async()=>({level:snapshot().level,run:mixedRun({id:'explicit-restart',revision:0,hearts:3,cats:[]})});
    await h.loadLevel(true,{mode,levelId:1});assert.equal(h.UI.engine.status,'playing');assert.equal(h.UI.engine.marks[3],0);assert.equal(h.UI.engine.run.id,'explicit-restart');
  }
});

test('local ready versus partial server locks without auto-submit; server failed/completed always win over conflict',async()=>{
  for(const mode of ['normal','practice']){
    const marks=Array(16).fill(0);for(const c of [2,4,11,13])marks[c]=2;marks[3]=1;
    const storage=draftStorage(mode,persistedDraft('mixed-run',{marks,hearts:2}));
    let h=await loadStoredDraft(storage,mode,mixedRun({hearts:2}));
    assert.equal(h.UI.engine.status,'conflict');assert.equal(h.requests.length,1);assert.equal(h.UI.engine.marks[3],1);
    h=await loadStoredDraft(storage,mode,mixedRun({status:'failed',hearts:0}));
    assert.equal(h.UI.engine.status,'failed');assert.equal(h.UI.engine.hearts,0);assert.equal(h.requests.length,1);
    assert.equal(h.UI.engine.marks[3],1);
    // A completed practice run has a server receipt; do not let the stale conflict mask it or resubmit it.
    if(mode==='practice'){
      storage.set(`findcat:local-run:31:${mode}`,JSON.stringify(persistedDraft('mixed-run',{conflict:true,hearts:3})));
      h=await loadStoredDraft(storage,mode,mixedRun({status:'completed',cats:[2,4,11,13],hearts:2}));
      assert.equal(h.UI.engine.status,'completed');assert.equal(h.UI.engine.marks[3],1);assert.equal(h.requests.length,1);
    }
  }
});

test('revision-cross salvage never mixes different run, board size, map, account or mode',async()=>{
  for(const overrides of [{runId:'other-run'},{size:5},{regions:Array(16).fill(0).join(',')},{levelId:2}]){
    const storage=draftStorage('normal',persistedDraft('mixed-run',overrides));
    const h=await loadStoredDraft(storage,'normal',mixedRun());assert.equal(h.UI.engine.marks[3],0);assert.equal(h.UI.engine.marks[4],2);
  }
  const storage=draftStorage('normal',persistedDraft());
  let h=await loadStoredDraft(storage,'practice',mixedRun());assert.equal(h.UI.engine.marks[3],0);
  h=harness(storage);h.UI.account={id:32,isAdmin:true};h.UI.engine=new h.GameEngine(h.render);
  h.PlatformAdapter.request=async()=>({level:snapshot().level,run:mixedRun()});await h.loadLevel();assert.equal(h.UI.engine.marks[3],0);
});

test('conflict backups are single bounded slots; backup quota errors preserve primary and use memory fallback',async()=>{
  const original=persistedDraft(),storage=draftStorage('normal',original);
  let h=harness(storage);h.UI.account={id:31};h.UI.engine=new h.GameEngine(h.render);
  const normalSet=h.PlatformAdapter.setStorage;h.PlatformAdapter.setStorage=(key,value)=>key.endsWith(':conflict')?false:normalSet(key,value);
  h.PlatformAdapter.request=async()=>({level:snapshot().level,run:mixedRun()});
  await h.loadLevel();h.flushLocalRun();h.document.hidden=true;h.handleVisibility();
  assert.deepEqual(JSON.parse(storage.get('findcat:local-run:31:normal')),original,'failed backup must not destroy persisted original');
  assert.ok(h.UI.drafts.get('local-run:31:normal:conflict'));assert.equal(h.UI.engine.marks[3],1);
  // Storage errors do not break ordinary local play in the loaded board.
  await h.move(11,'place');assert.equal(h.UI.engine.marks[11],2);
  const saved=h.UI.drafts.get('local-run:31:normal:conflict');
  await h.loadLevel();assert.deepEqual(h.UI.drafts.get('local-run:31:normal:conflict'),saved);
  h=await loadStoredDraft(draftStorage('normal',original),'normal',mixedRun());
  for(let revision=2;revision<8;revision++){
    h.PlatformAdapter.request=async()=>({level:snapshot().level,run:mixedRun({revision})});await h.loadLevel();h.flushLocalRun();
  }
  const keys=[...h.storage.keys()].filter(k=>k.endsWith(':conflict'));assert.equal(keys.length,1);assert.ok(h.storage.get(keys[0]).length<16384);
});

test('visibility/pagehide flush is idempotent and skips partially loading boards without adding requests',async()=>{
  const storage=draftStorage('normal',persistedDraft());const h=await loadStoredDraft(storage,'normal',mixedRun());
  const backup=storage.get('findcat:local-run:31:normal:conflict');
  h.UI.engine.applyMark(5,1);h.document.hidden=true;h.handleVisibility();assert.equal(JSON.parse(storage.get('findcat:local-run:31:normal')).marks[5],1);
  h.flushLocalRun();assert.equal(storage.get('findcat:local-run:31:normal:conflict'),backup);assert.equal(h.requests.length,1);
  const before=storage.get('findcat:local-run:31:normal');h.UI.loading=true;h.UI.engine.marks[6]=1;h.flushLocalRun();h.handleVisibility();
  assert.equal(storage.get('findcat:local-run:31:normal'),before);
  assert.match(html,/window\.addEventListener\('pagehide',flushLocalRun\)/);
});
