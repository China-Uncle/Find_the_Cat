'use strict';
const { randomUUID } = require('node:crypto');
const { transaction } = require('./db');
class AppError extends Error { constructor(status,message,code='REQUEST_ERROR'){super(message);this.status=status;this.code=code;} }
function assert(ok,status,message,code){if(!ok)throw new AppError(status,message,code);}
function int(value,min,max,label){assert(Number.isSafeInteger(value)&&value>=min&&value<=max,400,`${label}无效`);return value;}
class GameService {
  constructor(db,{runTtlHours=24,now=Date.now}={}){this.db=db;this.now=now;this.ttl=runTtlHours*3600000;}
  user(id){const u=this.db.prepare('SELECT id,auth_provider,username,avatar_url,current_level FROM users WHERE id=?').get(id);assert(u,401,'请重新登录','UNAUTHORIZED');return u;}
  total(){return this.db.prepare('SELECT COUNT(*) AS n FROM levels').get().n;}
  runView(run){return {id:run.id,levelId:run.level_id,hearts:run.hearts,cats:JSON.parse(run.cats),revision:run.revision,status:run.status,elapsedMs:Math.max(0,(run.finished_at??this.now())-run.started_at),expiresAt:run.expires_at};}
  getRun(userId,runId){const run=this.db.prepare('SELECT * FROM runs WHERE id=? AND user_id=?').get(runId,userId);assert(run,409,'本局已被其他页面重新开始，请刷新','STALE_RUN');return run;}
  playable(run,user){assert(run.level_id===user.current_level,409,'该关已结算或尚未解锁','LEVEL_LOCKED');assert(run.expires_at>this.now(),409,'本局已过期，请重新开始','RUN_EXPIRED');assert(run.status==='playing',409,run.status==='failed'?'红心已用完，请重新开始':'本局已结束','RUN_FINISHED');}
  start(userId,{restart=false}={}){
    return transaction(this.db,()=>{
      const u=this.user(userId),level=this.db.prepare('SELECT id,size,region_map FROM levels WHERE id=?').get(u.current_level);
      if(!level)return {allComplete:true,totalLevels:this.total(),currentLevel:u.current_level};
      let run=this.db.prepare('SELECT * FROM runs WHERE user_id=?').get(userId);
      if(restart||!run||run.level_id!==u.current_level||run.expires_at<=this.now()){
        this.db.prepare('DELETE FROM runs WHERE user_id=?').run(userId);
        const now=this.now(),id=randomUUID();
        this.db.prepare('INSERT INTO runs(id,user_id,level_id,started_at,expires_at) VALUES(?,?,?,?,?)').run(id,userId,level.id,now,now+this.ttl);
        run=this.getRun(userId,id);
      }
      return {allComplete:false,totalLevels:this.total(),level:{id:level.id,size:level.size,regions:JSON.parse(level.region_map)},run:this.runView(run)};
    });
  }
  move(userId,{runId,requestId,cell,operation,revision}){
    assert(typeof runId==='string'&&runId.length<=64,400,'局次无效');
    assert(typeof requestId==='string'&&/^[a-zA-Z0-9_-]{8,80}$/.test(requestId),400,'操作编号无效');
    assert(operation==='place'||operation==='remove',400,'操作无效');int(revision,0,1000000,'版本号');
    return transaction(this.db,()=>{
      const u=this.user(userId),run=this.getRun(userId,runId);
      const prior=this.db.prepare('SELECT * FROM run_moves WHERE run_id=? AND request_id=?').get(runId,requestId);
      if(prior){assert(prior.cell===cell&&prior.operation===operation,409,'操作编号已被使用');return JSON.parse(prior.result_json);}
      if(operation==='remove'&&run.status==='ready'){assert(run.expires_at>this.now(),409,'本局已过期，请重新开始','RUN_EXPIRED');assert(run.level_id===u.current_level,409,'该关已结算或尚未解锁','LEVEL_LOCKED');}else this.playable(run,u);assert(run.revision===revision,409,'盘面已变化，请同步后再操作','STALE_REVISION');
      const level=this.db.prepare('SELECT size,solution FROM levels WHERE id=?').get(run.level_id);int(cell,0,level.size**2-1,'格子坐标');
      const cats=JSON.parse(run.cats),at=cats.indexOf(cell);let correct=true;
      if(operation==='remove'){assert(at>=0,400,'该格子没有猫');cats.splice(at,1);}
      else {
        assert(at<0,400,'猫已经在这里了');correct=JSON.parse(level.solution).includes(cell);
        if(correct)cats.push(cell);else run.hearts--;
      }
      run.cats=JSON.stringify(cats.sort((a,b)=>a-b));run.revision++;
      if(!run.hearts)run.status='failed';else if(cats.length===level.size){run.status='ready';run.finished_at=this.now();}else if(operation==='remove'&&run.status==='ready'){run.status='playing';run.finished_at=null;}
      this.db.prepare('UPDATE runs SET cats=?,hearts=?,revision=?,status=?,finished_at=? WHERE id=?').run(run.cats,run.hearts,run.revision,run.status,run.finished_at,run.id);
      const result={correct,cell,run:this.runView(run)};
      this.db.prepare('INSERT INTO run_moves(run_id,request_id,cell,operation,result_json) VALUES(?,?,?,?,?)').run(runId,requestId,cell,operation,JSON.stringify(result));return result;
    });
  }
  complete(userId,{runId,levelId,cats}){
    int(levelId,1,2147483647,'关卡');assert(typeof runId==='string',400,'局次无效');
    assert(Array.isArray(cats)&&cats.length<=11&&cats.every(Number.isSafeInteger),400,'猫坐标无效');
    return transaction(this.db,()=>{
      const u=this.user(userId);
      const prior=this.db.prepare('SELECT elapsed_ms FROM completions WHERE user_id=? AND level_id=? AND run_id=?').get(userId,levelId,runId);
      // Network retry may re-read this exact receipt, but can never create a second score.
      if(prior)return this.completionView(u,levelId,prior.elapsed_ms);
      const run=this.getRun(userId,runId);
      assert(levelId===u.current_level&&run.level_id===levelId,403,'只能提交当前解锁关卡','LEVEL_LOCKED');
      assert(run.status==='ready'&&run.hearts>0,409,'尚未找到全部猫');
      assert(run.expires_at>this.now(),409,'本局已过期，请重新开始','RUN_EXPIRED');
      const level=this.db.prepare('SELECT size,solution FROM levels WHERE id=?').get(levelId);
      const canonical=a=>[...a].sort((a,b)=>a-b).join(',');
      assert(cats.length===level.size&&new Set(cats).size===level.size&&canonical(cats)===canonical(JSON.parse(level.solution))&&canonical(cats)===canonical(JSON.parse(run.cats)),400,'答案或服务端盘面不匹配');
      // Ignore any client elapsed time. Run's final correct placement freezes authoritative wall-clock time.
      const elapsed=Math.max(1,run.finished_at-run.started_at);
      this.db.prepare('INSERT INTO completions(user_id,level_id,elapsed_ms,completed_at,run_id) VALUES(?,?,?,?,?)').run(userId,levelId,elapsed,this.now(),runId);
      this.db.prepare('UPDATE users SET current_level=current_level+1,updated_at=? WHERE id=? AND current_level=?').run(this.now(),userId,levelId);
      this.db.prepare("UPDATE runs SET status='completed' WHERE id=?").run(runId);
      return this.completionView(this.user(userId),levelId,elapsed);
    });
  }
  completionView(user,levelId,elapsed){return {levelId,elapsedMs:elapsed,currentLevel:user.current_level,totalLevels:this.total(),allComplete:!this.db.prepare('SELECT 1 FROM levels WHERE id=?').get(user.current_level),top3:this.top(levelId)};}
  top(levelId){int(levelId,1,2147483647,'关卡');return this.db.prepare("SELECT u.username,u.avatar_url AS avatarUrl,c.elapsed_ms AS elapsedMs FROM completions c JOIN users u ON u.id=c.user_id WHERE c.level_id=? AND u.auth_provider!='guest' ORDER BY c.elapsed_ms,c.completed_at,u.id LIMIT 3").all(levelId);}
  levels(userId,offset=0,limit=100){
    int(offset,0,2147483647,'起始位置');int(limit,1,100,'每页数量');const user=this.user(userId);
    return {totalLevels:this.total(),currentLevel:user.current_level,levels:this.db.prepare('SELECT l.id,l.size,c.elapsed_ms AS elapsedMs FROM levels l LEFT JOIN completions c ON c.level_id=l.id AND c.user_id=? ORDER BY l.id LIMIT ? OFFSET ?').all(userId,limit,offset).map(l=>({...l,status:l.id<user.current_level?'completed':l.id===user.current_level?'current':'locked'}))};
  }
  leaderboard(offset=0,limit=50){int(offset,0,2147483647,'起始位置');int(limit,1,100,'每页数量');return {total:this.db.prepare("SELECT COUNT(*) AS n FROM users WHERE auth_provider!='guest'").get().n,rows:this.db.prepare("SELECT u.id,u.username,u.avatar_url AS avatarUrl,COUNT(c.level_id) AS cleared,COALESCE(SUM(c.elapsed_ms),0) AS totalMs FROM users u LEFT JOIN completions c ON c.user_id=u.id WHERE u.auth_provider!='guest' GROUP BY u.id ORDER BY cleared DESC,totalMs ASC,u.id ASC LIMIT ? OFFSET ?").all(limit,offset).map((r,i)=>({...r,rank:offset+i+1}))};}
}
module.exports={GameService,AppError,assert,int};
