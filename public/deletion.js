// Loaded before the editor so its initial render can wire deletion controls.
function wireRecordDeletion(){document.querySelectorAll('[data-delete-record]').forEach(button=>button.onclick=()=>{const record=records.find(r=>r.id===button.dataset.deleteRecord);if(record)deleteOwnRecord(record);});}
async function deleteOwnRecord(record){
 if(saving){toast('正在保存，请稍候。');return;}
 const prompt=`删除 ${record.date} 的工作记录？\n删除后无法在页面恢复，团队中也将不再显示。${editingId===record.id&&dirty?'\n当前未保存的修改也会丢弃。':''}`;
 if(!confirm(prompt))return;
 const controls=[...$('record-form').querySelectorAll('input,textarea,select,button'),...document.querySelectorAll('[data-delete-record]')],disabled=controls.map(c=>c.disabled);saving=true;controls.forEach(c=>c.disabled=true);
 try{
  await window.Workroom.api('/api/records/'+encodeURIComponent(record.id),{method:'DELETE',body:JSON.stringify({version:record.version})});
  records=records.filter(r=>r.id!==record.id);saving=false;
  if(editingId===record.id){dirty=false;openRecord(null);}render();if(document.body.dataset.page==='team')loadTeam();toast('记录已删除。');window.Workroom.refreshSync?.();
 }catch(e){toast(e.message);}finally{saving=false;controls.forEach((c,i)=>c.disabled=disabled[i]);}
}
