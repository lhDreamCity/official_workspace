import {createHash} from 'node:crypto';

export const sheetFields=[
 {field_title:'同步标识',field_type:'FIELD_TYPE_TEXT'},
 {field_title:'记录编号',field_type:'FIELD_TYPE_TEXT'},
 {field_title:'姓名',field_type:'FIELD_TYPE_TEXT'},
 {field_title:'记录日期',field_type:'FIELD_TYPE_DATE_TIME',property_date_time:{format:'yyyy-mm-dd',auto_fill:false}},
 {field_title:'总工时',field_type:'FIELD_TYPE_NUMBER',property_number:{decimal_places:2,use_separate:false}},
 ...['工作事项','阻碍说明','下一步','更新时间'].map(field_title=>({field_title,field_type:'FIELD_TYPE_TEXT'}))
];
export function initSync(db){db.exec(`
 CREATE TABLE IF NOT EXISTS sync_config (key TEXT PRIMARY KEY,value TEXT NOT NULL);
 CREATE TABLE IF NOT EXISTS sync_jobs (tenant TEXT NOT NULL,owner TEXT NOT NULL,id TEXT NOT NULL,revision INTEGER NOT NULL DEFAULT 1,attempts INTEGER NOT NULL DEFAULT 0,next_at INTEGER NOT NULL DEFAULT 0,error TEXT NOT NULL DEFAULT '',PRIMARY KEY(tenant,owner,id));
 CREATE TABLE IF NOT EXISTS sync_rows (tenant TEXT NOT NULL,owner TEXT NOT NULL,id TEXT NOT NULL,remote_id TEXT NOT NULL,version INTEGER NOT NULL,PRIMARY KEY(tenant,owner,id));`);}
export const getConfig=db=>JSON.parse(db.prepare("SELECT value FROM sync_config WHERE key='sheet'").get()?.value||'null');
export const saveConfig=(db,config)=>db.prepare("INSERT INTO sync_config VALUES('sheet',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(JSON.stringify(config));
const identifier=job=>createHash('sha256').update(job.tenant+'\0'+job.owner+'\0'+job.id).digest('hex');
export function queueSync(db,tenant,owner,id){db.prepare('INSERT INTO sync_jobs(tenant,owner,id) VALUES(?,?,?) ON CONFLICT(tenant,owner,id) DO UPDATE SET revision=revision+1,attempts=0,next_at=0,error=\'\'').run(tenant,owner,id);}
function values(record,key){const cell=text=>[{type:'text',text}];return {
 '同步标识':cell(key),'记录编号':cell(record.id),'姓名':cell(record.name),
 '记录日期':String(Date.parse(record.date+'T00:00:00+08:00')),'总工时':record.items.reduce((n,item)=>n+Number(item.hours||0),0),
 '工作事项':cell(record.items.map((item,i)=>`${i+1}. ${item.text}\n进度：${item.progress}；耗时：${item.hours===''?'未填写':item.hours+' 小时'}${item.blocker?'\n阻碍：'+item.blocker:''}`).join('\n\n')),
 '阻碍说明':cell(record.blockers||''),'下一步':cell(record.next||''),'更新时间':cell(record.updatedAt)
};}
export function createSheetSync({db,client,tenant,now=Date.now}){
 initSync(db);let running=null,stopped=false;
 function status(owner){const config=getConfig(db),enabled=!!config?.ready&&config.corpId===client.corpId;return {enabled,url:enabled?config.url:'',pending:db.prepare('SELECT COUNT(*) AS n FROM sync_jobs WHERE tenant=? AND owner=?').get(tenant,owner).n,retrying:db.prepare("SELECT COUNT(*) AS n FROM sync_jobs WHERE tenant=? AND owner=? AND error<>''").get(tenant,owner).n};}
 async function findRows(config,key){
  let offset=0,rows=[];
  do{const data=await client.call('wedoc/smartsheet/get_records',{body:{docid:config.docid,sheet_id:config.sheet_id,key_type:'CELL_VALUE_KEY_TYPE_FIELD_TITLE',field_titles:['同步标识'],limit:100,offset,filter_spec:{conjunction:'CONJUNCTION_AND',conditions:[{field_id:config.fields['同步标识'],field_type:'FIELD_TYPE_TEXT',operator:'OPERATOR_CONTAINS',string_value:{value:[key]}}]}}});
   if(!Array.isArray(data.records))throw Error('表格未返回有效记录列表。');
   rows.push(...data.records.filter(row=>row.values?.['同步标识']?.map(value=>value.text||'').join('')===key));
   if(!data.has_more)return rows;if(!Number.isInteger(data.next)||data.next<=offset||data.next>=40000)throw Error('表格分页返回异常。');offset=data.next;
  }while(true);
 }
 async function process(job,config){
  const args=[job.tenant,job.owner,job.id],stored=db.prepare('SELECT payload FROM records WHERE tenant=? AND owner=? AND id=?').get(...args),record=stored?JSON.parse(stored.payload):null;
  const body={docid:config.docid,sheet_id:config.sheet_id},rows=await findRows(config,identifier(job));
  if(!record||record.status!=='done'){
   if(rows.length)await client.call('wedoc/smartsheet/delete_records',{body:{...body,record_ids:rows.map(row=>row.record_id)}});
   db.prepare('DELETE FROM sync_rows WHERE tenant=? AND owner=? AND id=?').run(...args);
  }else{
   let remoteId=rows[0]?.record_id;
   const input={...body,key_type:'CELL_VALUE_KEY_TYPE_FIELD_TITLE',records:[{...(remoteId?{record_id:remoteId}:{}),values:values(record,identifier(job))}]};
   const data=await client.call('wedoc/smartsheet/'+(remoteId?'update_records':'add_records'),{body:input});
   remoteId=remoteId||data.records?.[0]?.record_id;if(!remoteId)throw Error('表格未返回记录编号，稍后重新核对。');
   db.prepare('INSERT INTO sync_rows VALUES(?,?,?,?,?) ON CONFLICT(tenant,owner,id) DO UPDATE SET remote_id=excluded.remote_id,version=excluded.version').run(...args,remoteId,record.version);
   if(rows.length>1)await client.call('wedoc/smartsheet/delete_records',{body:{...body,record_ids:rows.slice(1).map(row=>row.record_id)}});
  }
  db.prepare('DELETE FROM sync_jobs WHERE tenant=? AND owner=? AND id=? AND revision=?').run(...args,job.revision);
 }
 async function drain(){
  if(stopped)return;if(running)return running;
  running=(async()=>{const config=getConfig(db);if(!config?.ready||config.corpId!==client.corpId)return;
   const jobs=db.prepare('SELECT * FROM sync_jobs WHERE tenant=? AND next_at<=? ORDER BY next_at LIMIT 20').all(tenant,now());
   for(const job of jobs){if(stopped)break;try{await process(job,config);}catch(e){const attempts=job.attempts+1;db.prepare('UPDATE sync_jobs SET attempts=?,next_at=?,error=? WHERE tenant=? AND owner=? AND id=? AND revision=?').run(attempts,now()+Math.min(300000,5000*2**Math.min(attempts,6)),e.code?'企微错误码 '+e.code:'接口暂未完成同步',job.tenant,job.owner,job.id,job.revision);}}
  })().finally(()=>running=null);return running;
 }
 async function stop(){stopped=true;await running;}
 return {drain,status,stop};
}
