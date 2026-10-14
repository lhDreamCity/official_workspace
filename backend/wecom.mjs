export class WecomError extends Error {
 constructor(message,code=0){super(message);this.name='WecomError';this.status=502;this.code=code;}
}
export function createWecomClient({corpId,agentId,secret,fetch:fetcher=fetch,now=Date.now}){
 if(!/^ww[a-zA-Z0-9]{16}$/.test(corpId||'')||!/^\d+$/.test(String(agentId||''))||!secret)throw new Error('请先配置企业微信企业 ID、AgentId 和应用 Secret。');
 let cached=null,pending=null;
 async function request(url,options={}){
  let res,data;
  try{res=await fetcher(url,{...options,signal:AbortSignal.timeout(15000)});if(!res.ok)throw Error();data=await res.json();}catch{throw new WecomError('企业微信接口暂时不可用，请稍后重试。');}
  if(data.errcode!==0){const code=Number(data.errcode)||0;throw new WecomError(code===60020?'请在企业微信应用中配置服务器的企业可信 IP。':code===48002?'应用暂无接口权限，请检查可见范围或文档 API 授权。':`企业微信接口返回错误（${code||'未知'}），请检查应用配置。`,code);}
  return data;
 }
 async function token(){
  if(cached&&cached.expires>now())return cached.value;
  if(!pending)pending=(async()=>{const url=new URL('https://qyapi.weixin.qq.com/cgi-bin/gettoken');url.search=new URLSearchParams({corpid:corpId,corpsecret:secret}).toString();const data=await request(url);if(typeof data.access_token!=='string'||!Number.isFinite(data.expires_in)||data.expires_in<=0)throw new WecomError('企业微信未返回有效凭证。');cached={value:data.access_token,expires:now()+Math.max(0,data.expires_in-60)*1000};return cached.value;})().finally(()=>pending=null);
  return pending;
 }
 async function call(path,{query={},body}={},retry=true){
  const value=await token(),url=new URL('https://qyapi.weixin.qq.com/cgi-bin/'+path);url.search=new URLSearchParams({access_token:value,...query}).toString();
  try{return await request(url,body===undefined?{}:{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});}catch(e){if(retry&&[40014,42001].includes(e.code)){if(cached?.value===value)cached=null;return call(path,{query,body},false);}throw e;}
 }
 function loginUrl(callback,state,inside){
  const url=new URL(inside?'https://open.weixin.qq.com/connect/oauth2/authorize':'https://login.work.weixin.qq.com/wwlogin/sso/login');
  url.search=new URLSearchParams(inside?{appid:corpId,agentid:String(agentId),redirect_uri:callback,response_type:'code',scope:'snsapi_base',state}:{login_type:'CorpApp',appid:corpId,agentid:String(agentId),redirect_uri:callback,state}).toString();
  if(inside)url.hash='wechat_redirect';return url.href;
 }
 async function member(code){
  const identity=await call('auth/getuserinfo',{query:{code}}),userid=identity.userid||identity.UserId;
  if(typeof userid!=='string'||!userid||userid.includes('/')||Buffer.byteLength(userid)>64){const e=new WecomError('此工作台只允许本公司企业微信成员登录。');e.status=403;throw e;}
  const profile=await call('user/get',{query:{userid}});
  if(typeof profile.userid!=='string'||profile.userid.toLowerCase()!==userid.toLowerCase()||typeof profile.name!=='string'||!profile.name.trim()||(profile.status!==undefined&&profile.status!==1)){const e=new WecomError('无法确认已启用的员工身份，请检查应用可见范围和成员状态。');e.status=403;throw e;}
  return {userid:userid.toLowerCase(),name:profile.name.trim().slice(0,80)};
 }
 return {call,member,loginUrl,corpId,checkCredentials:async()=>{await token();}};
}
