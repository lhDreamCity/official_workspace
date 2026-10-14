import {readFileSync,writeFileSync,renameSync} from 'node:fs';
import {pathToFileURL} from 'node:url';
import {createWecomClient} from './wecom.mjs';

export async function configureWecom({path,secret,fetch}){
 const corpId='ww1bcea02e0201c476',agentId='1000002';
 if(!/^[A-Za-z0-9_-]{32,128}$/.test(secret))throw Error('Secret 格式不正确，请重新复制该应用的 Secret。');
 const existing=readFileSync(path,'utf8'),entries=new Map();
 for(const line of existing.split(/\r?\n/)){if(!line.trim()||line.trimStart().startsWith('#'))continue;const match=line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);if(!match)throw Error('现有环境文件格式异常，未修改配置。');entries.set(match[1],match[2]);}
 if(entries.has('WECOM_CORP_ID')&&entries.get('WECOM_CORP_ID')!==corpId)throw Error('现有配置属于其他企业，未修改配置。');
 const client=createWecomClient({corpId,agentId,secret,fetch});await client.checkCredentials();
 const tenant=entries.get('RECORD_TENANT')||entries.get('FEISHU_TENANT_KEY')||corpId;
 for(const key of [...entries.keys()])if(key.startsWith('FEISHU_'))entries.delete(key);
 for(const [key,value] of Object.entries({PUBLIC_ORIGIN:'https://work.lhdreamcity.com',AUTH_PROVIDER:'wecom',WECOM_CORP_ID:corpId,WECOM_AGENT_ID:agentId,WECOM_APP_SECRET:secret,RECORD_TENANT:tenant}))entries.set(key,value);
 const target=path+'.wecom-new';writeFileSync(target,[...entries].map(([key,value])=>key+'='+value).join('\n')+'\n',{mode:0o600});renameSync(target,path);
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
 try{let input='';for await(const chunk of process.stdin){input+=chunk;if(input.length>256)throw Error('Secret 长度异常。');}await configureWecom({path:'/deployment/app.env',secret:input.trim()});console.log('企业微信凭证验证通过，已切换登录配置。');}catch(e){console.error(e.status?e.message:e.message==='fetch failed'?'企业微信接口暂不可用，现有配置未修改。':e.message);process.exitCode=1;}
}
