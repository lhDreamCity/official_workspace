import http from 'node:http';
import {randomBytes, createHash, timingSafeEqual, randomUUID} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {mkdirSync} from 'node:fs';
import {dirname} from 'node:path';
import {pathToFileURL} from 'node:url';
import {createWecomClient} from './wecom.mjs';
import {createSheetSync,queueSync} from './smartsheet.mjs';
import {initDirectory,handleDirectory} from './directory.mjs';

const hash=s=>createHash('sha256').update(s).digest('hex');
const random=()=>randomBytes(32).toString('hex');
const day=()=>new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Shanghai',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date());
const escape=s=>String(s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
class Failure extends Error {constructor(status,message){super(message);this.status=status;}}
function text(v,max,required=false){if(typeof v!=='string'||v.length>max||(required&&!v.trim()))throw new Failure(400,'内容为空或超过长度限制。');return v.trim();}
export function validateRecord(input,user){
 if(!input||typeof input!=='object'||Array.isArray(input))throw new Failure(400,'记录格式错误。');
 const date=text(input.date,10,true);
 if(!/^\d{4}-\d{2}-\d{2}$/.test(date)||!Number.isFinite(Date.parse(date+'T00:00:00Z'))||new Date(date+'T00:00:00Z').toISOString().slice(0,10)!==date||date>day())throw new Failure(400,'记录日期无效或晚于今天。');
 if(!Array.isArray(input.items)||!input.items.length||input.items.length>50)throw new Failure(400,'请填写 1 至 50 条工作事项。');
 const items=input.items.map(i=>{
  if(!i||!['进行中','已完成','遇到阻碍'].includes(i.progress))throw new Failure(400,'事项进度无效。');
  if(i.hours!==''&&(typeof i.hours!=='number'||!Number.isFinite(i.hours)||i.hours<0||i.hours>24))throw new Failure(400,'耗时须为 0 至 24 小时。');
  return {text:text(i.text,4000,true),progress:i.progress,hours:i.hours,blocker:text(i.blocker??'',4000)};
 });
 if(items.reduce((n,i)=>n+Number(i.hours||0),0)>24)throw new Failure(400,'一天总耗时不能超过 24 小时。');
 return {date,name:user.name,items,blockers:text(input.blockers??'',4000),next:text(input.next??'',4000),status:['draft','done'].includes(input.status)?input.status:(()=>{throw new Failure(400,'记录状态无效。');})()};
}
export function createWorkbench(config){
 const provider=config.authProvider||(config.corpId?'wecom':'feishu'),label=provider==='wecom'?'企业微信':'飞书';
 if(!['wecom','feishu'].includes(provider))throw Error('登录方式配置无效。');
 const origin=new URL(config.origin).origin, callback=origin+'/auth/'+provider+'/callback',tenant=config.recordTenant||(provider==='wecom'?config.corpId:config.tenantKey),oauthCookie=provider==='wecom'?'workroom_oauth_wecom':'workroom_oauth';
 if(provider==='feishu'&&(!config.appId||!config.appSecret))throw new Error('请先在服务器配置飞书 App ID 和 App Secret。');
 const wecom=provider==='wecom'?createWecomClient({corpId:config.corpId,agentId:config.agentId,secret:config.wecomSecret,fetch:config.fetch}):null;
 if(config.dbPath!==':memory:')mkdirSync(dirname(config.dbPath),{recursive:true});
 const db=new DatabaseSync(config.dbPath);
 db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
 CREATE TABLE IF NOT EXISTS oauth_states (state TEXT PRIMARY KEY, binding TEXT NOT NULL, expires INTEGER NOT NULL);
 CREATE TABLE IF NOT EXISTS sessions (token TEXT PRIMARY KEY, tenant TEXT NOT NULL, owner TEXT NOT NULL, name TEXT NOT NULL, csrf TEXT NOT NULL, expires INTEGER NOT NULL);
 CREATE TABLE IF NOT EXISTS records (tenant TEXT NOT NULL, owner TEXT NOT NULL, id TEXT NOT NULL, date TEXT NOT NULL, version INTEGER NOT NULL, payload TEXT NOT NULL, PRIMARY KEY(tenant,owner,id), UNIQUE(tenant,owner,date));`);
 for(const table of ['oauth_states','sessions'])if(!db.prepare('PRAGMA table_info('+table+')').all().some(column=>column.name==='provider'))db.exec("ALTER TABLE "+table+" ADD COLUMN provider TEXT NOT NULL DEFAULT 'feishu'");
 initDirectory(db);
 const sync=wecom?createSheetSync({db,client:wecom,tenant}):null;
 const syncTimer=sync?setInterval(()=>sync.drain().catch(()=>console.error('Sheet sync unavailable')),10000):null;syncTimer?.unref();
 function mutate(action,user,id){db.exec('BEGIN IMMEDIATE');try{action();if(sync)queueSync(db,user.tenant,user.owner,id);db.exec('COMMIT');}catch(e){db.exec('ROLLBACK');throw e;}}
 const fetcher=config.fetch||fetch;
 const equal=(a,b)=>typeof a==='string'&&typeof b==='string'&&a.length===b.length&&timingSafeEqual(Buffer.from(a),Buffer.from(b));
 const cookie=(name,value,max)=>`${name}=${value}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${max}`;
 const getCookie=(req,name)=>{try{return (req.headers.cookie||'').split(';').map(s=>s.trim()).find(s=>s.startsWith(name+'='))?.slice(name.length+1)||'';}catch{return '';}};
 function session(req){return db.prepare('SELECT * FROM sessions WHERE token=? AND expires>? AND provider=? AND tenant=?').get(hash(getCookie(req,'workroom_session')),Date.now(),provider,tenant||'');}
 function respond(res,status,data,headers={}){res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff','Referrer-Policy':'no-referrer',...headers});res.end(JSON.stringify(data));}
 function redirect(res,url,cookies=[]){res.writeHead(302,{Location:url,'Cache-Control':'no-store','Referrer-Policy':'no-referrer','Set-Cookie':cookies});res.end();}
 function page(res,status,title,description){res.writeHead(status,{'Content-Type':'text/html; charset=utf-8','Cache-Control':'no-store','Referrer-Policy':'no-referrer','X-Content-Type-Options':'nosniff'});res.end(`<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escape(title)}</title><body style="font-family:system-ui;max-width:640px;margin:12vh auto;padding:24px"><h1>${escape(title)}</h1><p style="white-space:pre-wrap">${escape(description)}</p><a href="/">返回工作台</a></body></html>`);}
 async function api(url,options={}){const res=await fetcher(url,{...options,signal:AbortSignal.timeout(15000)});if(!res.ok)throw new Failure(502,'飞书接口暂时不可用，请稍后重试。');const data=await res.json();if(data.code!==undefined&&data.code!==0)throw new Failure(502,`飞书接口返回错误（${Number(data.code)||'未知'}），请检查应用配置。`);return data;}
 async function body(req){let size=0,chunks=[];for await(const chunk of req){size+=chunk.length;if(size>512000)throw new Failure(413,'填写内容过长。');chunks.push(chunk);}try{return JSON.parse(Buffer.concat(chunks).toString());}catch{throw new Failure(400,'请求格式错误。');}}
 function writeGuard(req,user){if(req.headers.origin!==origin||!equal(req.headers['x-csrf-token'],user.csrf))throw new Failure(403,'请求验证失败，请刷新页面后重试。');}
 function cleanup(){db.prepare('DELETE FROM oauth_states WHERE expires<?').run(Date.now());db.prepare('DELETE FROM sessions WHERE expires<?').run(Date.now());}
 const timer=setInterval(cleanup,600000);timer.unref();
 const server=http.createServer(async(req,res)=>{
  const url=new URL(req.url,origin),path=url.pathname;
  try{
   if(path==='/api/health'&&req.method==='GET'){db.prepare('SELECT 1').get();return respond(res,200,{ok:true});}
   if(path==='/api/auth-config'&&req.method==='GET')return respond(res,200,{provider,label});
   if(path==='/auth/'+provider+'/login'&&req.method==='GET'){
    cleanup();const count=db.prepare('SELECT COUNT(*) AS n FROM oauth_states').get().n;if(count>1000)throw new Failure(429,'登录请求过多，请稍后重试。');
    const state=random(),binding=random();db.prepare('INSERT INTO oauth_states(state,binding,expires,provider) VALUES(?,?,?,?)').run(hash(state),hash(binding),Date.now()+600000,provider);
    if(wecom)return redirect(res,wecom.loginUrl(callback,state,/wxwork/i.test(req.headers['user-agent']||'')),[cookie(oauthCookie,binding,600)]);
    const login=new URL('https://accounts.feishu.cn/open-apis/authen/v1/authorize');login.search=new URLSearchParams({client_id:config.appId,redirect_uri:callback,state,response_type:'code'}).toString();
    return redirect(res,login.href,[cookie('workroom_oauth',binding,600)]);
   }
   if(path==='/auth/'+provider+'/callback'&&req.method==='GET'){
    const state=url.searchParams.get('state')||'',binding=getCookie(req,oauthCookie);
    const expected=db.prepare('SELECT * FROM oauth_states WHERE state=?').get(hash(state));
    if(!expected||expected.provider!==provider||expected.expires<Date.now()||!equal(expected.binding,hash(binding)))throw new Failure(400,'登录验证已过期，请返回工作台重新登录。');
    db.prepare('DELETE FROM oauth_states WHERE state=?').run(hash(state));
    const code=url.searchParams.get('code');if(!code||code.length>(wecom?512:2048))throw new Failure(400,'未完成'+label+'授权，请重新登录。');
    if(wecom){const profile=await wecom.member(code),sid=random(),csrf=random();db.prepare('INSERT INTO sessions(token,tenant,owner,name,csrf,expires,provider) VALUES(?,?,?,?,?,?,?)').run(hash(sid),tenant,'wecom:'+profile.userid,profile.name,csrf,Date.now()+43200000,provider);return redirect(res,'/#home',[cookie('workroom_session',sid,43200),cookie(oauthCookie,'',0)]);}
    const token=await api('https://open.feishu.cn/open-apis/authen/v2/oauth/token',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({grant_type:'authorization_code',client_id:config.appId,client_secret:config.appSecret,code,redirect_uri:callback})});
    if(!token.access_token)throw new Failure(502,'飞书未返回登录凭证，请检查应用配置。');
    const profile=(await api('https://open.feishu.cn/open-apis/authen/v1/user_info',{headers:{Authorization:'Bearer '+token.access_token}})).data;
    if(!profile?.tenant_key||!profile.open_id||!profile.name)throw new Failure(502,'飞书身份信息不完整，请检查登录权限。');
    if(!config.tenantKey){return page(res,403,'还需确认公司身份',`你的飞书企业标识为：\n${profile.tenant_key}\n\n将这个企业标识配置到服务器后，才会开放登录和工作记录。企业标识不是密钥，可以发给部署人员。`);}
    if(profile.tenant_key!==config.tenantKey)throw new Failure(403,'此工作台只允许本公司飞书账号登录。');
    const sid=random(),csrf=random();db.prepare('INSERT INTO sessions(token,tenant,owner,name,csrf,expires,provider) VALUES(?,?,?,?,?,?,?)').run(hash(sid),profile.tenant_key,profile.open_id,String(profile.name).slice(0,80),csrf,Date.now()+43200000,provider);
    return redirect(res,'/#home',[cookie('workroom_session',sid,43200),cookie('workroom_oauth','',0)]);
   }
   if(path.startsWith('/api/')){
    const user=session(req);if(!user)throw new Failure(401,'登录已过期，请重新使用'+label+'登录。');
    if(await handleDirectory({db,user,path,req,respond,res,body,writeGuard}))return;
    if(path==='/api/me'&&req.method==='GET')return respond(res,200,{user:{name:user.name,provider,id:hash(user.tenant+'\n'+user.owner).slice(0,24)},csrf:user.csrf});
    if(path==='/api/sync-status'&&req.method==='GET')return respond(res,200,sync?sync.status(user.owner):{enabled:false,url:'',pending:0,retrying:0});
    if(path==='/api/team-records'&&req.method==='GET'){
     const date=url.searchParams.get('date')||'',name=url.searchParams.get('name')||'',offsetText=url.searchParams.get('offset')||'0';
     if(date&&(!/^\d{4}-\d{2}-\d{2}$/.test(date)||!Number.isFinite(Date.parse(date+'T00:00:00Z'))||new Date(date+'T00:00:00Z').toISOString().slice(0,10)!==date))throw new Failure(400,'筛选日期无效。');
     if(name.length>80||!/^\d{1,7}$/.test(offsetText))throw new Failure(400,'筛选参数无效。');
     const offset=Number(offsetText),where="tenant=? AND json_extract(payload,'$.status')='done' AND (?='' OR date=?) AND instr(lower(json_extract(payload,'$.name')),lower(?))>0";
     const parameters=[user.tenant,date,date,name.trim()];
     const rows=db.prepare(`SELECT owner,payload FROM records WHERE ${where} ORDER BY date DESC,json_extract(payload,'$.updatedAt') DESC,id LIMIT 50 OFFSET ?`).all(...parameters,offset);
     const total=db.prepare(`SELECT COUNT(*) AS n FROM records WHERE ${where}`).get(...parameters).n;
     return respond(res,200,{records:rows.map(r=>({...JSON.parse(r.payload),mine:r.owner===user.owner})),total,hasMore:offset+rows.length<total});
    }
    if(path==='/api/logout'&&req.method==='POST'){writeGuard(req,user);db.prepare('DELETE FROM sessions WHERE token=?').run(user.token);return respond(res,200,{ok:true},{'Set-Cookie':cookie('workroom_session','',0)});}
    if(path==='/api/records'&&req.method==='GET'){const rows=db.prepare('SELECT payload FROM records WHERE tenant=? AND owner=? ORDER BY date DESC').all(user.tenant,user.owner);return respond(res,200,{records:rows.map(r=>JSON.parse(r.payload))});}
    if(path.startsWith('/api/records/')&&req.method==='DELETE'){
     writeGuard(req,user);const id=path.slice('/api/records/'.length),input=await body(req);
     if(!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id))throw new Failure(400,'记录编号无效。');
     const old=db.prepare('SELECT version FROM records WHERE tenant=? AND owner=? AND id=?').get(user.tenant,user.owner,id);
     if(!old)throw new Failure(404,'记录不存在或不属于当前账号。');
     if(input?.version!==old.version)throw new Failure(409,'这份记录已更新，请刷新后核对再删除。');
     mutate(()=>db.prepare('DELETE FROM records WHERE tenant=? AND owner=? AND id=?').run(user.tenant,user.owner,id),user,id);
     return respond(res,200,{ok:true});
    }
    if(path==='/api/records'&&req.method==='POST'){
     writeGuard(req,user);const input=await body(req),clean=validateRecord(input,user);
     if(input.id&&!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(input.id))throw new Failure(400,'记录编号无效。');
     const id=input.id||randomUUID();const old=db.prepare('SELECT version FROM records WHERE tenant=? AND owner=? AND id=?').get(user.tenant,user.owner,id);
     if(!old&&input.version!==undefined&&input.version!==null)throw new Failure(404,'记录不存在或不属于当前账号。');
     if(old&&input.version!==old.version)throw new Failure(409,'这份记录已在其他页面更新，请保留填写内容并刷新后核对。');
     const duplicate=db.prepare('SELECT id FROM records WHERE tenant=? AND owner=? AND date=? AND id<>?').get(user.tenant,user.owner,clean.date,id);if(duplicate)throw new Failure(409,'当天已有记录，请在历史中打开并修改。');
     const record={...clean,id,version:(old?.version||0)+1,updatedAt:new Date().toISOString()};
     mutate(()=>db.prepare('INSERT INTO records VALUES(?,?,?,?,?,?) ON CONFLICT(tenant,owner,id) DO UPDATE SET date=excluded.date, version=excluded.version, payload=excluded.payload').run(user.tenant,user.owner,id,clean.date,record.version,JSON.stringify(record)),user,id);
     return respond(res,200,{record});
    }
   }
   throw new Failure(404,'页面不存在。');
  }catch(e){const status=e.status||500,message=e.status?e.message:'服务暂时不可用，填写内容不会被清空，请稍后重试。';if(!e.status)console.error('Request failed:',e.name);if(path.startsWith('/auth/'))return page(res,status,'暂时无法登录',message);return respond(res,status,{error:message});}
 });
 server.requestTimeout=30000;server.headersTimeout=10000;
 return {server,db,sync,close:()=>{clearInterval(timer);clearInterval(syncTimer);if(sync)return sync.stop().then(()=>db.close());db.close();}};
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
 const app=createWorkbench({origin:process.env.PUBLIC_ORIGIN,authProvider:process.env.AUTH_PROVIDER,corpId:process.env.WECOM_CORP_ID,agentId:process.env.WECOM_AGENT_ID,wecomSecret:process.env.WECOM_APP_SECRET,recordTenant:process.env.RECORD_TENANT,appId:process.env.FEISHU_APP_ID,appSecret:process.env.FEISHU_APP_SECRET,tenantKey:process.env.FEISHU_TENANT_KEY||'',dbPath:process.env.DB_PATH||'/data/workroom.sqlite'});
 app.server.listen(Number(process.env.PORT||3000),'0.0.0.0',()=>console.log('Workbench service started'));
 for(const signal of ['SIGTERM','SIGINT'])process.on(signal,()=>app.server.close(async()=>{await app.close();process.exit(0);}));
}
