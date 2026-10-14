import {DatabaseSync} from 'node:sqlite';
import {pathToFileURL} from 'node:url';
import {createWecomClient} from './wecom.mjs';
import {initSync,getConfig,saveConfig,sheetFields,queueSync} from './smartsheet.mjs';

export async function setupSmartSheet({db,client,tenant}){
 initSync(db);let config=getConfig(db)||{corpId:client.corpId,ready:false};
 if(config.corpId!==client.corpId)throw Error('已有表格属于其他企业，已停止。');
 config.ready=false;saveConfig(db,config);
 if(!config.docid){
  if(config.creating)throw Error('上次创建表格的响应未确认。请先在企业微信文档中核对，避免重复创建；工作台记录仍正常保存在服务器。');
  config.creating=true;saveConfig(db,config);
  let document;
  try{document=await client.call('wedoc/create_doc',{body:{doc_type:10,doc_name:'梦之城工作记录'}});}catch(e){if(e.code){config.creating=false;saveConfig(db,config);}throw e;}
  if(typeof document.docid!=='string'||typeof document.url!=='string'||!document.docid)throw Error('表格创建响应不完整，请先核对企业微信文档。');
  const link=new URL(document.url);if(link.protocol!=='https:'||!/(^|\.)weixin\.qq\.com$/.test(link.hostname))throw Error('表格返回地址异常，请核对。');
  config={...config,creating:false,docid:document.docid,url:link.href};saveConfig(db,config);
 }
 if(!config.sheet_id){
  const existing=await client.call('wedoc/smartsheet/get_sheet',{body:{docid:config.docid}});
  const sheet=existing.sheet_list?.find(sheet=>sheet.title==='已完成记录');
  config.sheet_id=sheet?.sheet_id||(await client.call('wedoc/smartsheet/add_sheet',{body:{docid:config.docid,properties:{title:'已完成记录'}}})).properties?.sheet_id;
  if(!config.sheet_id)throw Error('未取得工作表编号。');saveConfig(db,config);
 }
 const base={docid:config.docid,sheet_id:config.sheet_id};
 let fields=(await client.call('wedoc/smartsheet/get_fields',{body:{...base,offset:0,limit:1000}})).fields;
 if(!Array.isArray(fields))throw Error('未取得表格字段。');
 const missing=sheetFields.filter(field=>!fields.some(existing=>existing.field_title===field.field_title));
 if(missing.length){await client.call('wedoc/smartsheet/add_fields',{body:{...base,fields:missing}});fields=(await client.call('wedoc/smartsheet/get_fields',{body:{...base,offset:0,limit:1000}})).fields;}
 config.fields={};
 for(const expected of sheetFields){const field=fields?.find(field=>field.field_title===expected.field_title);if(!field?.field_id||field.field_type!==expected.field_type)throw Error('表格字段类型不匹配：'+expected.field_title);config.fields[expected.field_title]=field.field_id;}
 saveConfig(db,config);
 await client.call('wedoc/mod_doc_join_rule',{body:{docid:config.docid,enable_corp_internal:true,corp_internal_auth:1,enable_corp_external:false,ban_share_external:true,corp_internal_approve_only_by_admin:false,update_co_auth_list:true,co_auth_list:[]}});
 await client.call('wedoc/smartsheet/content_priv/update_sheet_priv',{body:{docid:config.docid,type:1,priv_list:[{sheet_id:config.sheet_id,priv:3,record_priv:{record_range_type:1},field_priv:{field_range_type:1}}]}});
 const permissions=await client.call('wedoc/doc_get_auth',{body:{docid:config.docid}}),rule=permissions.access_rule;
 if(!rule?.enable_corp_internal||Number(rule.corp_internal_auth)!==1||rule.enable_corp_external||!rule.ban_share_external||permissions.doc_member_list?.some(member=>[2,7].includes(Number(member.auth)))||permissions.co_auth_list?.some(member=>Number(member.auth)!==1))throw Error('表格未确认只读权限，尚未启用同步。请移除文档中的员工编辑或管理员权限后重新运行。');
 const content=await client.call('wedoc/smartsheet/content_priv/get_sheet_priv',{body:{docid:config.docid,type:1}});
 const privilege=content.rule_list?.flatMap(rule=>rule.priv_list||[]).find(rule=>rule.sheet_id===config.sheet_id);
 if(Number(privilege?.priv)!==3)throw Error('未确认智能表格只读权限，尚未启用同步。');
 db.exec('BEGIN IMMEDIATE');try{
  config.ready=true;saveConfig(db,config);
  for(const row of db.prepare("SELECT tenant,owner,id FROM records WHERE tenant=? AND json_extract(payload,'$.status')='done'").all(tenant))queueSync(db,row.tenant,row.owner,row.id);
  db.exec('COMMIT');
 }catch(e){db.exec('ROLLBACK');throw e;}
 return config;
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
 const db=new DatabaseSync(process.env.DB_PATH||'/data/workroom.sqlite');db.exec('PRAGMA busy_timeout=5000');
 try{if(process.env.AUTH_PROVIDER!=='wecom')throw Error('请先完成企业微信登录更新。');const client=createWecomClient({corpId:process.env.WECOM_CORP_ID,agentId:process.env.WECOM_AGENT_ID,secret:process.env.WECOM_APP_SECRET});const config=await setupSmartSheet({db,client,tenant:process.env.RECORD_TENANT||process.env.WECOM_CORP_ID});console.log('智能表格已创建并确认只读权限：\n'+config.url+'\n已完成记录将自动同步；草稿只保存在服务器。');}catch(e){console.error(e.code?'企业微信接口未完成配置，错误码：'+e.code:e.message);process.exitCode=1;}finally{db.close();}
}
