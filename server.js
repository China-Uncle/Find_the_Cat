'use strict';
require('dotenv').config();
const express=require('express');
const helmet=require('helmet');
const jwt=require('jsonwebtoken');
const crypto=require('node:crypto');
const path=require('node:path');
const {Worker}=require('node:worker_threads');
const {openDatabase,resolveDatabase,transaction}=require('./db');
const {GameService,AppError,assert}=require('./game_service');
const {PracticeService}=require('./practice_service');
const {createGenerationJob}=require('./level_generator');
function makeApp(options={}){
  const env={...process.env,...options.env},production=env.NODE_ENV==='production';
  const secret=env["JWT"+"_SECRET"]||options.jwtSecret||"";if(secret.length<32)throw new Error("请设置至少 32 字符的 JWT_SECRET，不提供不安全的默认密钥");
  const origin=new URL(env.PUBLIC_URL||'http://localhost:3000');
  if(production&&origin.protocol!=='https:')throw new Error('生产环境 PUBLIC_URL 必须为 HTTPS');
  if(origin.username||origin.password||origin.pathname!=='/'||origin.search||origin.hash)throw new Error('PUBLIC_URL 只能填写站点来源，例如 https://cat.example.com');
  const base=origin.origin;
  const callbackPath=env.GITHUB_CALLBACK_PATH||'/api/auth/github/callback';
  if(!/^\/(?!\/)[A-Za-z0-9/_-]+$/.test(callbackPath)||callbackPath.includes('//')||callbackPath.split('/').some(part=>part==='.'||part==='..'))throw new Error('GITHUB_CALLBACK_PATH 必须是以 / 开头的安全路径');
  const callbackUrl=base+callbackPath,allowGuest=!production&&env.ALLOW_GUEST_LOGIN==='true';
  const db=options.db||openDatabase(env.DATABASE_PATH),service=new GameService(db,{runTtlHours:Number(env.RUN_TTL_HOURS)||24});
  const practiceService=new PracticeService(db,{runTtlHours:Number(env.RUN_TTL_HOURS)||24});
  const app=express();app.disable('x-powered-by');
  const hops=Number(env.TRUST_PROXY_HOPS||0);if(!Number.isInteger(hops)||hops<0||hops>5)throw new Error('TRUST_PROXY_HOPS 必须为 0–5');app.set('trust proxy',hops);
  app.use(helmet({contentSecurityPolicy:{directives:{defaultSrc:["'self'"],scriptSrc:["'self'","'unsafe-inline'"],styleSrc:["'self'","'unsafe-inline'"],imgSrc:["'self'",'data:','https://avatars.githubusercontent.com'],connectSrc:["'self'"],fontSrc:["'self'"],objectSrc:["'none'"],frameAncestors:["'none'"],...(production?{}:{upgradeInsecureRequests:null})}},hsts:production?{maxAge:31536000,includeSubDomains:false}:false,referrerPolicy:{policy:'no-referrer'}}));
  app.use(express.json({limit:'16kb',strict:true}));
  // All write endpoints accept JSON objects only, never arrays or missing bodies.
  app.use('/api',(req,res,next)=>{if(['POST','PUT','PATCH'].includes(req.method)&&(!req.body||typeof req.body!=='object'||Array.isArray(req.body)))return next(new AppError(400,'请求体必须为 JSON 对象'));next();});
  app.use('/api',(req,res,next)=>{res.set('Cache-Control','no-store');if(req.method!=='GET'&&req.get('origin')&&req.get('origin')!==base)return next(new AppError(403,'请求来源不匹配'));next();});
  const buckets=new Map();
  function key(req){return req.user?String(req.user.id):String(req.ip||'unknown');}
  function rate(label,max,ms=60000,keyFn=key){return (req,res,next)=>{const id=label+':'+keyFn(req),now=Date.now();let b=buckets.get(id);if(!b||b.until<now){b={count:0,until:now+ms};buckets.set(id,b);}if(++b.count>max){res.set('Retry-After',Math.ceil((b.until-now)/1000));return next(new AppError(429,'操作太快，请稍后再试'));}next();};}
  const cleanup=setInterval(()=>{const now=Date.now();for(const[k,v]of buckets)if(v.until<now)buckets.delete(k);db.prepare('DELETE FROM oauth_flows WHERE expires_at<?').run(now);db.prepare('DELETE FROM login_tickets WHERE expires_at<?').run(now);db.prepare('DELETE FROM practice_runs WHERE expires_at<=?').run(now);},60000);cleanup.unref();
  const hash=s=>crypto.createHash('sha256').update(s).digest('hex');
  const random=()=>crypto.randomBytes(32).toString('base64url');
  // Keep the original single-admin setting; optionally add more GitHub logins.
  const adminUsernames=new Set([env.ADMIN_GITHUB_USERNAME,env.ADMIN_GITHUB_USERNAMES]
    .filter(Boolean).flatMap(value=>value.split(',')).map(value=>value.trim().toLowerCase()).filter(Boolean));
  const admin=u=>u.auth_provider==='github'&&adminUsernames.has(u.username.trim().toLowerCase());
  const issue=u=>jwt.sign({sub:String(u.id),provider:u.auth_provider},secret,{algorithm:'HS256',expiresIn:'7d',issuer:'find-the-cat',audience:'find-the-cat-web'});
  function auth(req,res,next){try{const value=req.get('authorization')||'';assert(/^Bearer \S+$/.test(value)&&value.length<2048,401,'请先登录','UNAUTHORIZED');const payload=jwt.verify(value.slice(7),secret,{algorithms:['HS256'],issuer:'find-the-cat',audience:'find-the-cat-web'});assert(/^\d+$/.test(payload.sub),401,'登录已失效');req.user=service.user(Number(payload.sub));next();}catch(e){next(e instanceof AppError?e:new AppError(401,'登录已过期，请重新登录','UNAUTHORIZED'));}}
  const userView=u=>({...u,isAdmin:admin(u),isGuest:u.auth_provider==='guest'});
  function upsert(provider,openId,username,avatar=''){
    const now=Date.now();db.prepare('INSERT INTO users(auth_provider,open_id,username,avatar_url,created_at,updated_at) VALUES(?,?,?,?,?,?) ON CONFLICT(auth_provider,open_id) DO UPDATE SET username=excluded.username,avatar_url=excluded.avatar_url,updated_at=excluded.updated_at').run(provider,String(openId),username,avatar,now,now);
    return service.user(db.prepare('SELECT id FROM users WHERE auth_provider=? AND open_id=?').get(provider,String(openId)).id);
  }
  app.get('/api/health',(req,res)=>res.json({ok:true,totalLevels:service.total()}));
  app.get('/api/config',(req,res)=>res.json({githubLogin:!!(env.GITHUB_CLIENT_ID&&env.GITHUB_CLIENT_SECRET),guestLogin:allowGuest,totalLevels:service.total()}));
  app.post('/api/auth/guest',rate('guest',12,900000),(req,res)=>{assert(allowGuest,403,'游客登录仅限本地测试');const name=typeof req.body.username==='string'?req.body.username.trim().slice(0,24):'测试猫友',guestId=req.body.guestId;assert(name.length>0,400,'请输入昵称');assert(typeof guestId==='string'&&/^[a-f0-9-]{36}$/i.test(guestId),400,'游客设备编号无效');const u=upsert('guest',guestId,name);res.json({['access'+'Token']:issue(u),user:userView(u)});});
  app.get('/api/auth/github/start',rate('oauth',20,900000),(req,res)=>{
    assert(env.GITHUB_CLIENT_ID&&env.GITHUB_CLIENT_SECRET,503,'尚未配置 GitHub OAuth');
    const browserHash=req.query.browser_hash;assert(typeof browserHash==='string'&&/^[a-f0-9]{64}$/.test(browserHash),400,'缺少浏览器绑定信息');
    const state=random(),verifier=random(),challenge=crypto.createHash('sha256').update(verifier).digest('base64url');
    db.prepare('INSERT INTO oauth_flows(state_hash,browser_hash,code_verifier,expires_at) VALUES(?,?,?,?)').run(hash(state),browserHash,verifier,Date.now()+600000);
    const url=new URL('https://github.com/login/oauth/authorize');for(const[k,v]of Object.entries({client_id:env.GITHUB_CLIENT_ID,redirect_uri:callbackUrl,scope:'read:user',state,code_challenge:challenge,code_challenge_method:'S256'}))url.searchParams.set(k,v);
    res.json({url:url.toString()});
  });
  const upstreamFetch=options.fetch||fetch;
  async function githubJson(url,options={}){const r=await upstreamFetch(url,{...options,signal:AbortSignal.timeout(15000),headers:{Accept:'application/json','User-Agent':'Find-the-Cat',...options.headers}});assert(r.ok,502,'GitHub 登录服务暂时不可用');return r.json();}
  app.get(callbackPath,rate('callback',30,900000),async(req,res)=>{
    try{
      assert(typeof req.query.state==='string'&&req.query.state.length<200,400,'OAuth state 缺失');
      const flow=transaction(db,()=>{const f=db.prepare('SELECT * FROM oauth_flows WHERE state_hash=?').get(hash(req.query.state));assert(f&&f.expires_at>Date.now(),400,'登录请求已过期，请重试');db.prepare('DELETE FROM oauth_flows WHERE state_hash=?').run(hash(req.query.state));return f;});
      assert(!req.query.error&&typeof req.query.code==='string'&&req.query.code.length<1000,400,'已取消 GitHub 授权');
      const access=await githubJson('https://github.com/login/oauth/access_token',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({client_id:env.GITHUB_CLIENT_ID,['client'+'_secret']:env.GITHUB_CLIENT_SECRET,redirect_uri:callbackUrl,code:req.query.code,code_verifier:flow.code_verifier})});
      assert(access.access_token,401,'GitHub 授权码无效');
      const profile=await githubJson('https://api.github.com/user',{headers:{Authorization:'Bearer '+access.access_token,Accept:'application/vnd.github+json','X-GitHub-Api-Version':'2022-11-28'}});
      assert(Number.isSafeInteger(profile.id)&&typeof profile.login==='string',502,'GitHub 返回了无效用户信息');
      const avatar=`https://avatars.githubusercontent.com/u/${profile.id}?s=80`,u=upsert('github',profile.id,profile.login,avatar),ticket=random();
      db.prepare('INSERT INTO login_tickets(ticket_hash,browser_hash,user_id,expires_at) VALUES(?,?,?,?)').run(hash(ticket),flow.browser_hash,u.id,Date.now()+60000);
      // Only a short-lived exchange ticket is placed in the fragment. JWT and GitHub tokens never enter URLs.
      res.redirect(303,base+'/#login_ticket='+encodeURIComponent(ticket));
    }catch(e){console.warn('OAuth callback failed:',e instanceof AppError?e.message:'upstream request failed');res.redirect(303,base+'/#auth_error='+encodeURIComponent('GitHub 登录未完成，请重新尝试。'));}
  });
  app.post('/api/auth/exchange',rate('exchange',30,900000),(req,res)=>{
    const {ticket,browserSecret}=req.body;assert(typeof ticket==='string'&&ticket.length<200&&typeof browserSecret==='string'&&browserSecret.length>=32&&browserSecret.length<=200,400,'登录票据无效');
    const u=transaction(db,()=>{const t=db.prepare('SELECT * FROM login_tickets WHERE ticket_hash=?').get(hash(ticket));assert(t&&t.expires_at>Date.now()&&t.browser_hash===hash(browserSecret),401,'登录请求已过期或不属于此浏览器');db.prepare('DELETE FROM login_tickets WHERE ticket_hash=?').run(hash(ticket));return service.user(t.user_id);});
    res.json({['access'+'Token']:issue(u),user:userView(u)});
  });
  app.get('/api/me',auth,(req,res)=>res.json({user:userView(req.user),totalLevels:service.total()}));
  app.get('/api/levels',auth,(req,res)=>res.json(service.levels(req.user.id,Number(req.query.offset??0),Number(req.query.limit??100))));
  app.post('/api/game/start',auth,rate('start',30,60000,r=>r.user.id),(req,res)=>{assert(req.body.restart===undefined||typeof req.body.restart==='boolean',400,'restart 必须为布尔值');res.json(service.start(req.user.id,{restart:req.body.restart===true}));});
  app.post('/api/game/move',auth,rate('move',240,60000,r=>r.user.id),(req,res)=>res.json(service.move(req.user.id,req.body)));
  app.post('/api/game/complete',auth,rate('complete',30,60000,r=>r.user.id),(req,res)=>res.json(service.complete(req.user.id,req.body)));
  app.post('/api/game/submit',auth,rate('submit',30,60000,r=>r.user.id),(req,res)=>res.json(service.submit(req.user.id,req.body)));
  app.get('/api/levels/:id/top3',(req,res)=>res.json({rows:service.top(Number(req.params.id))}));
  app.get('/api/leaderboard',rate('rank',120),(req,res)=>res.json(service.leaderboard(Number(req.query.offset??0),Number(req.query.limit??50))));
  function practiceAdmin(req,res,next){try{assert(admin(req.user),403,'仅 GitHub 管理员可操作');next();}catch(e){next(e);}}
  app.post('/api/admin/practice/start',auth,practiceAdmin,rate('practice-start',30,60000,r=>r.user.id),(req,res)=>res.json(practiceService.start(req.user.id,req.body)));
  app.post('/api/admin/practice/move',auth,practiceAdmin,rate('practice-move',240,60000,r=>r.user.id),(req,res)=>res.json(practiceService.move(req.user.id,req.body)));
  app.post('/api/admin/practice/complete',auth,practiceAdmin,rate('practice-complete',30,60000,r=>r.user.id),(req,res)=>res.json(practiceService.complete(req.user.id,req.body)));
  app.post('/api/admin/practice/submit',auth,practiceAdmin,rate('practice-submit',30,60000,r=>r.user.id),(req,res)=>res.json(practiceService.submit(req.user.id,req.body)));
  function adminAuth(req,res,next){try{assert(admin(req.user),403,'仅 GitHub 管理员可操作');const supplied=req.get('x-admin-secret')||'',expected=env.ADMIN_SECRET||'';assert(expected.length>=24,503,'管理员密钥未配置或过短');const a=Buffer.from(hash(supplied)),b=Buffer.from(hash(expected));assert(supplied.length>0&&crypto.timingSafeEqual(a,b),403,'管理员密钥不正确');next();}catch(e){next(e);}}
  const workers=new Set();
  app.post('/api/admin/generate-levels',auth,rate('admin',10,3600000,r=>r.user.id),adminAuth,(req,res)=>{
    const count=req.body.count;assert(Number.isInteger(count)&&count>=1&&count<=1000,400,'每次可追加 1–1000 关');let id;
    try{id=createGenerationJob(db,count,'github:'+req.user.id);}catch(e){throw new AppError(409,e.message);}
    try{const worker=new Worker(path.join(__dirname,'seed_levels.js'),{workerData:{count,jobId:id,dbPath:resolveDatabase(env.DATABASE_PATH)}});workers.add(worker);
      worker.on('error',()=>db.prepare("UPDATE generation_jobs SET status='failed',error='生成 Worker 异常退出',updated_at=? WHERE id=? AND status IN ('queued','running')").run(Date.now(),id));
      worker.on('exit',code=>{workers.delete(worker);if(code!==0)db.prepare("UPDATE generation_jobs SET status='failed',error=COALESCE(error,'生成 Worker 已停止'),updated_at=? WHERE id=? AND status IN ('queued','running')").run(Date.now(),id);});
    }catch(e){db.prepare("UPDATE generation_jobs SET status='failed',error='无法启动生成进程',updated_at=? WHERE id=?").run(Date.now(),id);throw e;}
    res.status(202).json({jobId:id,totalLevels:service.total()});
  });
  app.get('/api/admin/generation-jobs/:id',auth,(req,res)=>{assert(admin(req.user),403,'仅管理员可查询');const job=db.prepare('SELECT id,requested,created_count,status,start_level,end_level,error FROM generation_jobs WHERE id=?').get(req.params.id);assert(job,404,'任务不存在');res.json({job,totalLevels:service.total()});});
  app.use('/api',(req,res)=>res.status(404).json({error:'接口不存在',code:'NOT_FOUND'}));
  app.get('/',(req,res)=>{res.set('Cache-Control','no-cache');res.sendFile(path.join(__dirname,'public/index.html'));});
  app.use(express.static(path.join(__dirname,'public'),{maxAge:'1h',index:false}));
  app.use((error,req,res,next)=>{if(res.headersSent)return next(error);let status=error.status||500;const message=error instanceof AppError?error.message:status===400?'请求 JSON 格式无效':status===413?'请求过大':'服务暂时不可用';if(status>=500)console.error('Server error:',error.message);res.status(status).json({error:message,code:error.code||'SERVER_ERROR'});});
  app.locals.db=db;app.locals.service=service;app.locals.practiceService=practiceService;app.locals.close=async()=>{clearInterval(cleanup);await Promise.all([...workers].map(w=>w.terminate()));if(!options.db)db.close();};
  return app;
}
if(require.main===module){const app=makeApp(),server=app.listen(Number(process.env.PORT)||3000,process.env.HOST||'127.0.0.1',()=>console.log(`Find the Cat: ${process.env.PUBLIC_URL||'http://localhost:3000'}`));const stop=()=>server.close(async()=>{await app.locals.close();process.exit(0);});process.once('SIGTERM',stop);process.once('SIGINT',stop);}
module.exports={makeApp};
