(async()=>{
 const safe=s=>String(s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
 let auth={provider:'wecom',label:'企业微信'};
 function showLogin(message=`使用公司${auth.label}账号，开始记录今天的工作。`){
  document.body.classList.add('auth-loading');let panel=document.getElementById('login-panel');if(!panel){panel=document.createElement('section');panel.id='login-panel';document.body.append(panel);}panel.innerHTML=`<div class="auth-card"><div class="auth-symbol"><img src="logo.png?v=1a40910e5d71" alt="梦之城" width="56" height="56"></div><p class="auth-eyebrow">梦之城 · 工作间</p><h1>每一天的进展，<br>都值得留下。</h1><p>${safe(message)}</p><a class="button primary" href="/auth/${auth.provider}/login">使用${safe(auth.label)}登录 ↗</a><small>员工姓名由${safe(auth.label)}确认 · 工作记录保存到公司服务器</small></div>`;
 }
 const api=async(path,options={})=>{let res;try{res=await fetch(path,{...options,headers:{'Content-Type':'application/json','X-CSRF-Token':window.Workroom?.csrf||'',...options.headers},signal:AbortSignal.timeout(20000)});}catch{throw Error('网络请求失败，请稍后重试。填写内容仍保留。');}let data;try{data=await res.json();}catch{throw Error('服务返回异常，请稍后重试。');}if(!res.ok)throw Error(data.error||'请求失败，请稍后重试。');return data;};
 try{
  auth=await api('/api/auth-config');if(!['wecom','feishu'].includes(auth.provider))throw Error('登录配置异常，请联系管理员。');
  const identity=await api('/api/me');window.Workroom={...identity,api,records:(await api('/api/records')).records};
  for(const name of ['deletion.js','app.js','portal.js','team.js','mobile-ui.js?v=0c8d352ffeb1','hub.js?v=f73814ff3933','journal-ui.js?v=768059897bf3','vendor/marked.js?v=4d0ddeac021f','vendor/purify.js?v=52abf5cb41ad','vendor/highlight.js?v=662960b539f7','vendor/hljs-langs.js?v=f0b754a7d072','library-ui.js?v=3c611faa28cc'])await new Promise((resolve,reject)=>{const script=document.createElement('script');script.src=name;script.onload=resolve;script.onerror=()=>reject(Error('页面资源未加载，请刷新后重试。'));document.body.append(script);});
  document.querySelector('.identity').innerHTML=`<span class="avatar">${safe(identity.user.name.slice(0,1))}</span><div>${safe(identity.user.name)}<small>${safe(auth.label)}身份 · 服务器保存</small></div>`;
  document.querySelector('.local-badge').innerHTML=`<i></i> ${safe(auth.label)}已连接 · 个人工作记录`;document.querySelector('.workspace-label span').textContent='公司记录';
  let refreshing=false;
  window.Workroom.refreshSync=async()=>{if(refreshing)return;refreshing=true;try{const status=await api('/api/sync-status'),hint=document.getElementById('sheet-sync-status'),link=document.getElementById('sheet-link');if(hint)hint.textContent=!status.enabled?'智能表格尚未启用；记录已保存到公司服务器。':status.pending?`记录已在服务器保存；${status.pending} 条正在等待表格同步${status.retrying?'，接口恢复后会自动重试':''}。`:'我的记录已同步；草稿仅保存在服务器。';if(link){link.hidden=!status.enabled;if(status.enabled){const url=new URL(status.url);if(url.protocol==='https:'&&/(^|\.)weixin\.qq\.com$/.test(url.hostname))link.href=url.href;else link.hidden=true;}}}catch{const hint=document.getElementById('sheet-sync-status');if(hint)hint.textContent='同步状态暂时无法读取，请稍后刷新。';}finally{refreshing=false;}};
  await window.Workroom.refreshSync();setInterval(()=>{if(!document.hidden)window.Workroom.refreshSync();},15000);
  document.getElementById('logout').onclick=async()=>{if(!confirm('确定退出？未保存的填写内容不会保存。'))return;try{await api('/api/logout',{method:'POST',body:'{}'});location.reload();}catch(e){alert(e.message);}};
  document.body.classList.remove('auth-loading');
 }catch(e){showLogin(e.message.includes('登录已过期')?undefined:e.message);}
})();
