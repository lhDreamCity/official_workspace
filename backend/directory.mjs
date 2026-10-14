import {randomUUID} from 'node:crypto';

const fail=(status,message)=>Object.assign(new Error(message),{status});
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export function validateEntry(input){
 if(!input||typeof input!=='object'||Array.isArray(input))throw fail(400,'入口格式无效。');
 const read=(key,max,required=false)=>{const value=input[key]??'';if(typeof value!=='string'||value.length>max||(required&&!value.trim()))throw fail(400,'入口内容为空或超过长度限制。');return value.trim();};
 const kind=read('kind',20,true);if(!['app','material','skill','approval','contact'].includes(kind))throw fail(400,'入口类别无效。');
 const url=read('url',2048,true);let parsed;try{parsed=new URL(url);}catch{throw fail(400,'请填写完整的 HTTP / HTTPS 地址。');}
 if(!['http:','https:'].includes(parsed.protocol)||parsed.username||parsed.password)throw fail(400,'地址须为不含账号密码的 HTTP / HTTPS 链接。');
 return {kind,name:read('name',80,true),url:parsed.href,note:read('note',200),instructions:read('instructions',4000)};
}
export function initDirectory(db){db.exec('CREATE TABLE IF NOT EXISTS directory_entries (tenant TEXT NOT NULL, id TEXT NOT NULL, owner TEXT NOT NULL, name TEXT NOT NULL, version INTEGER NOT NULL, payload TEXT NOT NULL, PRIMARY KEY(tenant,id))');}
export async function handleDirectory({db,user,path,req,respond,res,body,writeGuard}){
 if(path!=='/api/directory'&&!path.startsWith('/api/directory/'))return false;
 const expose=row=>({...JSON.parse(row.payload),createdBy:row.name,mine:row.owner===user.owner,version:row.version});
 if(path==='/api/directory'&&req.method==='GET'){
  const entries=db.prepare('SELECT * FROM directory_entries WHERE tenant=? ORDER BY name,id').all(user.tenant).map(expose);respond(res,200,{entries});return true;
 }
 if(req.method!=='POST'&&req.method!=='DELETE')throw fail(405,'不支持的操作。');
 writeGuard(req,user);const input=await body(req);
 const id=req.method==='DELETE'?path.slice('/api/directory/'.length):input?.id||randomUUID();
 if(!uuid.test(id))throw fail(400,'入口编号无效。');
 const old=db.prepare('SELECT * FROM directory_entries WHERE tenant=? AND id=?').get(user.tenant,id);
 if(old&&old.owner!==user.owner)throw fail(403,'只有登记人可以修改或移除此入口。');
 if((req.method==='DELETE'||input?.id)&&!old)throw fail(404,'入口不存在。');
 if(old&&input?.version!==old.version)throw fail(409,'入口已被其他页面更新，请刷新列表后再操作。');
 if(req.method==='DELETE'){
  if(path==='/api/directory')throw fail(400,'请选择要删除的入口。');
  db.prepare('DELETE FROM directory_entries WHERE tenant=? AND id=? AND version=?').run(user.tenant,id,old.version);respond(res,200,{ok:true});return true;
 }
 if(path!=='/api/directory')throw fail(404,'入口地址无效。');
 const clean=validateEntry(input),entry={...clean,id,updatedAt:new Date().toISOString()},version=(old?.version||0)+1;
 if(!old&&db.prepare('SELECT COUNT(*) AS n FROM directory_entries WHERE tenant=?').get(user.tenant).n>=2000)throw fail(400,'公司入口数量已达到上限。');
 db.prepare('INSERT INTO directory_entries VALUES(?,?,?,?,?,?) ON CONFLICT(tenant,id) DO UPDATE SET version=excluded.version,payload=excluded.payload').run(user.tenant,id,user.owner,old?.name||user.name,version,JSON.stringify(entry));
 respond(res,200,{entry:{...entry,createdBy:old?.name||user.name,mine:true,version}});return true;
}
