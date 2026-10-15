// 「库」页面：Finder 式公司资产仓库（左树 + 右文件表 + 拖拽入库 + 预览 + 搜索）。
// 数据来自 library 服务：Gitee 克隆仓目录树 与 media/manifest.yaml 的 COS 条目，合并成一个视图。
(()=>{
 const api=window.Workroom?.api,csrf=window.Workroom?.csrf;
 if(!api)return; // 未登录不挂载
 pageNames.library='库';
 const $id=id=>document.getElementById(id);
 const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
 const toast=m=>{const t=$id('toast');if(t){t.textContent=m;t.classList.add('show');clearTimeout(t._tm);t._tm=setTimeout(()=>t.classList.remove('show'),5000);}};
 const fmtSize=n=>!n?'—':n>=1048576?(n/1048576).toFixed(1)+' MB':n>=1024?(n/1024).toFixed(0)+' KB':n+' B';
 const kindOf=name=>{const e=(name.match(/\.[^.]+$/)||[''])[0].toLowerCase();
  if(['.mp4','.mov','.avi','.mkv','.webm','.m4v'].includes(e))return'video';
  if(['.png','.jpg','.jpeg','.gif','.webp','.svg'].includes(e))return'image';
  if(['.md','.markdown','.txt'].includes(e))return'doc';
  if(['.pdf','.doc','.docx','.xls','.xlsx','.ppt','.pptx'].includes(e))return'office';
  if(['.zip','.rar','.7z'].includes(e))return'archive';
  return'file';};
 const ICON={dir:'▸',doc:'▤',image:'◫',video:'▶',office:'▦',archive:'⧉',file:'□',cos:'☁'};
 const ROOT_LABEL={projects:'projects · 项目',knowledge:'knowledge · 知识库',workflows:'workflows · 流程',media:'media · 素材'};

 // ---- 挂载导航与页面（照 hub.js 的 Skill 库模式） ----
 const navItem=Object.assign(document.createElement('a'),{href:'#library',innerHTML:'<span>▤</span>库'});
 navItem.dataset.page='library';
 const anchor=document.querySelector('.sidebar nav [data-page="materials"]')||document.querySelector('.sidebar nav [data-page="skills"]');
 anchor?anchor.after(navItem):document.querySelector('.sidebar nav').append(navItem);
 const more=document.querySelector('#mobile-menu nav');
 more?.insertAdjacentHTML('beforeend','<a href="#library" data-page="library">▤<div><strong>库</strong><small>公司资产仓库 · 拖拽入库</small></div><span>↗</span></a>');
 more?.querySelector('[data-page="library"]')?.addEventListener('click',()=>document.getElementById('mobile-menu').close());

 document.querySelector('.content').insertAdjacentHTML('beforeend',`
<section id="library" class="page" hidden>
 <div class="heading"><div><div class="eyebrow">COMPANY LIBRARY</div><h1>库</h1><p>公司的文档、素材与视频都在这里。拖文件进来即入库，正文存 Gitee 仓库，视频存云端。</p></div>
 <div class="lib-head-actions"><button class="button secondary" id="lib-refresh">↻ 刷新</button><button class="button primary" id="lib-upload-btn">⬆ 上传文件</button></div></div>
 <input id="lib-file-input" type="file" multiple hidden>
 <div class="lib-toolbar">
  <div class="lib-crumb" id="lib-crumb">库</div>
  <div class="lib-toolbar-right">
   <div class="lib-toggle" id="lib-toggle"><button data-view="list" class="active">☰ 列表</button><button data-view="grid">▦ 图标</button></div>
   <label class="search lib-search"><span>⌕</span><input id="lib-search" type="search" placeholder="搜索全库文件名" aria-label="搜索库"></label>
  </div>
 </div>
 <div class="lib-stats" id="lib-stats"></div>
 <div class="lib-layout">
  <nav class="lib-tree" id="lib-tree" aria-label="库目录"></nav>
  <div class="lib-main">
   <div class="lib-drop" id="lib-drop"><strong>拖拽文件到这里入库</strong><span>文档/图片进 Gitee 仓库并自动署名；视频与大于 50MB 的文件直传云端存储</span></div>
   <div class="lib-progress" id="lib-progress" hidden><div class="lib-progress-bar" id="lib-progress-bar"></div><span id="lib-progress-text"></span></div>
   <div class="lib-head" id="lib-head"><span></span><span>名称</span><span class="lib-author">作者</span><span class="lib-date">日期</span><span class="lib-size">大小</span><span>来源</span></div>
   <div class="lib-list" id="lib-list"></div>
  </div>
 </div>
 <div class="lib-preview" id="lib-preview" hidden><div class="lib-preview-card card">
  <div class="lib-preview-head"><div><strong id="lib-preview-name"></strong><div class="lib-preview-meta" id="lib-preview-meta"></div></div><button class="button secondary" id="lib-preview-close">关闭</button></div>
  <div class="lib-preview-body" id="lib-preview-body"></div></div></div>
</section>`);

 // ---- 状态 ----
 let data={entries:[],cos:[],meta:{},roots:[],stats:{}},pane='all',expanded=new Set(['projects','knowledge','workflows','media']),query='',view='list',fresh=new Set();

 const parentOf=p=>p.includes('/')?p.slice(0,p.lastIndexOf('/')):'';
 const allDirs=()=>data.entries.filter(e=>e.type==='dir');
 const allFiles=()=>data.entries.filter(e=>e.type==='file');
 const childDirs=p=>allDirs().filter(e=>parentOf(e.path)===p);
 const filesIn=p=>allFiles().filter(e=>parentOf(e.path)===p);
 const dirCount=p=>filesIn(p).length+childDirs(p).reduce((s,d)=>s+dirCount(d.path),0);
 const fileDate=f=>(data.meta[f.path]?.date)||f.mtime||'';
 const fileAuthor=f=>data.meta[f.path]?.author||'';
 const authorName=id=>!id?'—':(data.roster?.[id]||id);

 async function reload(){
  try{data=await api('/api/library/tree');}catch(e){toast(e.message);return;}
  renderStats();renderTree();renderMain();
 }

 function renderStats(){
  const s=data.stats||{};
  const parts=[`${s.files||0} 个文件`,`${s.dirs||0} 个目录`,s.cloud?`${s.cloud} 个云端文件`:''];
  if(s.bytes)parts.push('本地合计 '+fmtSize(s.bytes));
  if(s.updated)parts.push('最近更新 '+s.updated);
  $id('lib-stats').innerHTML=parts.filter(Boolean).map((t,i)=>`<span class="lib-stat${i===0?' strong':''}">${esc(t)}</span>`).join('<i>·</i>');
 }

 function renderTree(){
  const rows=[];
  rows.push(`<div class="lib-tree-item lib-tree-sys${pane==='all'?' active':''}" data-pane="all">▤ 全部文件<span class="lib-count">${allFiles().length}</span></div>`);
  rows.push(`<div class="lib-tree-item lib-tree-sys${pane==='recent'?' active':''}" data-pane="recent">◷ 最近上传<span class="lib-count">${allFiles().length+data.cos.length}</span></div>`);
  rows.push(`<div class="lib-tree-item lib-tree-sys lib-tree-cos${pane==='@cos'?' active':''}" data-pane="@cos">☁ 云端大文件<span class="lib-count">${data.cos.length}</span></div>`);
  rows.push('<div class="lib-tree-sep"></div>');
  const roots=data.roots?.length?data.roots:['projects','knowledge','workflows','media'];
  for(const r of roots){
   const open=expanded.has(r);
   rows.push(`<div class="lib-tree-item lib-tree-root${pane===r?' active':''}" data-path="${esc(r)}">${open?'▾':'▸'} ${esc(ROOT_LABEL[r]||r)}<span class="lib-count">${dirCount(r)}</span></div>`);
   if(open)walk(r,1,rows);
  }
  $id('lib-tree').innerHTML=rows.join('');
  $id('lib-tree').querySelectorAll('[data-pane]').forEach(el=>el.onclick=()=>{pane=el.dataset.pane;renderTree();renderMain();});
  $id('lib-tree').querySelectorAll('[data-path]').forEach(el=>el.onclick=e=>{
   const p=el.dataset.path;
   if(e.target.classList.contains('lib-count')||pane===p){expanded.has(p)?expanded.delete(p):expanded.add(p);}
   else{expanded.add(p);}
   pane=p;renderTree();renderMain();
  });
 }
 function walk(p,depth,rows){
  for(const d of childDirs(p).sort((a,b)=>a.name.localeCompare(b.name,'zh'))){
   const open=expanded.has(d.path);
   rows.push(`<div class="lib-tree-item${pane===d.path?' active':''}" style="padding-left:${12+depth*14}px" data-path="${esc(d.path)}">${open?'▾':'▸'} ${esc(d.name)}<span class="lib-count">${dirCount(d.path)}</span></div>`);
   if(open)walk(d.path,depth+1,rows);
  }
 }

 function renderMain(){
  const crumb=$id('lib-crumb');
  crumb.innerHTML=pane==='@cos'?'库 / 云端大文件':pane==='recent'?'库 / 最近上传':pane==='all'?'库 / 全部文件':`库 / ${esc(pane.replaceAll('/',' / '))}`;
  $id('lib-head').style.display=view==='list'?'':'none';
  const list=$id('lib-list');
  list.className='lib-list'+(view==='grid'?' lib-list-grid':'');

  if(query){
   const q=query.toLowerCase();
   const hits=allFiles().filter(e=>e.name.toLowerCase().includes(q));
   const cosHits=data.cos.filter(e=>e.name.toLowerCase().includes(q));
   list.innerHTML=hits.length+cosHits.length
    ? `<div class="lib-section-label">搜索「${esc(query)}」：${hits.length+cosHits.length} 个结果</div>`+hits.map(rowFile).join('')+cosHits.map(rowCos).join('')
    : `<div class="lib-empty">没有匹配「${esc(query)}」的文件。<br><span class="lib-hint">换个关键词，或把文件拖进来入库。</span></div>`;
   return bindRows();
  }
  if(pane==='@cos'){
   list.innerHTML=`<div class="lib-section-label">云端大文件 · 视频与大于 50MB 的文件，本体在腾讯云对象存储，点击即可打开</div>`+
    (data.cos.length?data.cos.map(rowCos).join(''):'<div class="lib-empty">还没有云端文件。<br><span class="lib-hint">把视频拖到上方区域即可直传云端。</span></div>');
   return bindRows();
  }
  if(pane==='recent'){ // 按日期倒序，git 文件与云端条目混排
   const rows=[...allFiles().map(f=>({t:fileDate(f)||'0000-00-00',html:rowFile(f)})),
    ...data.cos.map(c=>({t:c.date||'0000-00-00',html:rowCos(c)}))]
    .sort((a,b)=>b.t.localeCompare(a.t)).slice(0,80);
   list.innerHTML=rows.length?`<div class="lib-section-label">最近上传（按日期倒序，含云端）</div>`+rows.map(r=>r.html).join('')
    :`<div class="lib-empty">还没有内容。<br><span class="lib-hint">把文件拖到上方区域即可入库。</span></div>`;
   return bindRows();
  }
  if(pane==='all'){ // 全库总览：按分区分组，一屏看得到所有东西
   const roots=data.roots?.length?data.roots:['projects','knowledge','workflows','media'];
   let html='';
   for(const r of roots){
    const fs_=filesIn(r).sort((a,b)=>(fileDate(b)||'').localeCompare(fileDate(a)||'')||a.name.localeCompare(b.name,'zh'));
    const ds=childDirs(r);
    if(!fs_.length&&!ds.length)continue;
    html+=`<div class="lib-section-label">${esc(ROOT_LABEL[r]||r)}<b>${fs_.length+ds.length}</b></div>`;
    html+=ds.map(d=>rowDir(d)).join('')+fs_.map(rowFile).join('');
   }
   html+=`<div class="lib-section-label">云端大文件 · COS<b>${data.cos.length}</b></div>`;
   html+=data.cos.length?data.cos.map(rowCos).join(''):'<div class="lib-empty lib-empty-inline">暂无云端文件。</div>';
   list.innerHTML=html;
   return bindRows();
  }
  // 普通目录
  const subs=childDirs(pane),files=filesIn(pane).sort((a,b)=>a.name.localeCompare(b.name,'zh'));
  list.innerHTML=(!subs.length&&!files.length)
   ?`<div class="lib-empty">这个目录还是空的。<br><span class="lib-hint">把文件拖到上方区域，或点右上角「上传文件」。</span></div>`
   :`<div class="lib-section-label">${esc(pane)}<b>${subs.length+files.length}</b></div>`+subs.map(d=>rowDir(d)).join('')+files.map(rowFile).join('');
  bindRows();
 }

 function rowDir(d){
  return `<div class="lib-row lib-row-dir" data-open="${esc(d.path)}"><span class="lib-ico">${ICON.dir}</span><span class="lib-name">${esc(d.name)}/</span><span class="lib-author">—</span><span class="lib-date">${dirCount(d.path)} 项</span><span class="lib-size">—</span><span class="lib-src">目录</span></div>`;
 }
 function rowFile(f){
  const k=kindOf(f.name),a=fileAuthor(f),owner=authorName(a);
  return `<div class="lib-row${fresh.has(f.path)?' is-new':''}" data-preview="${esc(f.path)}" title="${esc(f.path)}">
   <span class="lib-ico">${ICON[k]}</span>
   <span class="lib-name">${esc(f.name)}${fresh.has(f.path)?'<b class="lib-new-tag">新</b>':''}<small>${esc(parentOf(f.path)||'/')}</small></span>
   <span class="lib-author">${esc(owner)}</span>
   <span class="lib-date">${esc(fileDate(f))}</span>
   <span class="lib-size">${fmtSize(f.size||0)}</span>
   <span class="lib-src">Gitee</span></div>`;
 }
 function rowCos(e){
  const st=e.status==='pending'?'<b class="lib-pending">待传</b>':'';
  return `<div class="lib-row${fresh.has(e.name)?' is-new':''}" data-cos="${esc(e.cos)}" title="${esc(e.cos)}">
   <span class="lib-ico">${ICON.cos}</span>
   <span class="lib-name">${esc(e.name)}${st}<small>云端 · ${esc(e.date||'')}</small></span>
   <span class="lib-author">${esc(authorName(e.author))}</span>
   <span class="lib-date">${esc(e.date||'')}</span>
   <span class="lib-size">${e.size_mb&&e.size_mb!=='0.0'?esc(e.size_mb)+' MB':'—'}</span>
   <span class="lib-src lib-src-cos">COS ↗</span></div>`;
 }
 function bindRows(){
  document.querySelectorAll('#lib-list [data-open]').forEach(el=>el.onclick=()=>{pane=el.dataset.open;expanded.add(pane);renderTree();renderMain();});
  document.querySelectorAll('#lib-list [data-cos]').forEach(el=>el.onclick=()=>window.open(el.dataset.cos,'_blank','noopener'));
  document.querySelectorAll('#lib-list [data-preview]').forEach(el=>el.onclick=()=>preview(el.dataset.preview));
 }

 // ---- 预览 ----
 async function preview(rel){
  const name=rel.split('/').pop(),k=kindOf(name);
  $id('lib-preview-name').textContent=name;
  $id('lib-preview-meta').textContent=`${rel}　·　${data.meta[rel]?.author?authorName(data.meta[rel].author)+'　·　':''}${data.meta[rel]?.date||''}`;
  const body=$id('lib-preview-body');body.innerHTML='加载中…';$id('lib-preview').hidden=false;
  try{
   if(k==='image')body.innerHTML=`<img src="/api/library/file?path=${encodeURIComponent(rel)}" alt="${esc(name)}" style="max-width:100%;border-radius:8px">`;
   else if(k==='doc'||k==='file'){
    const r=await fetch('/api/library/file?path='+encodeURIComponent(rel));
    if(!r.ok)throw Error((await r.json().catch(()=>({}))).error||'预览失败');
    body.innerHTML=`<pre class="lib-pre">${esc(await r.text())}</pre>`;
   }else body.innerHTML='<div class="lib-empty">该类型暂不支持在线预览。<br><span class="lib-hint">可以下载后用本机软件打开。</span></div>';
  }catch(e){body.innerHTML=`<div class="lib-empty">${esc(e.message)}</div>`;}
 }
 $id('lib-preview-close').onclick=()=>$id('lib-preview').hidden=true;
 $id('lib-preview').onclick=e=>{if(e.target.id==='lib-preview')$id('lib-preview').hidden=true;};

 // ---- 上传 ----
 function upload(files){
  if(!files.length)return;
  if(cwdIsRoot())pane='knowledge'; // 总览视角下上传，默认进知识库并跳过去，方便立刻看到结果
  const target=pane.startsWith('@')||pane==='all'||pane==='recent'?'knowledge':pane;
  const fd=new FormData();
  fd.append('path',target);
  for(const f of files)fd.append('files',f,f.name);
  const xhr=new XMLHttpRequest();
  const prog=$id('lib-progress'),bar=$id('lib-progress-bar'),text=$id('lib-progress-text');
  prog.hidden=false;bar.style.width='0%';text.textContent=`上传 ${files.length} 个文件…`;
  xhr.upload.onprogress=e=>{if(e.lengthComputable)bar.style.width=Math.round(e.loaded/e.total*100)+'%';};
  xhr.onload=async()=>{
   prog.hidden=true;
   let res;try{res=JSON.parse(xhr.responseText);}catch{res={error:'服务返回异常。'};}
   if(xhr.status!==200){toast(res.error||'上传失败，请稍后重试。');return;}
   fresh=new Set(res.results.map(r=>r.path||r.name));
   pane=target;
   await reload();
   toast(`入库完成（署名 ${res.author}）：`+res.results.map(r=>`${r.name} → ${r.route==='cos'?'云端存储':'Gitee 仓库'}`).join('；'));
   $id('lib-list').querySelector('.is-new')?.scrollIntoView({block:'nearest',behavior:'smooth'});
  };
  xhr.onerror=()=>{prog.hidden=true;toast('网络请求失败，请稍后重试。');};
  xhr.open('POST','/api/upload');
  xhr.setRequestHeader('X-CSRF-Token',csrf);
  xhr.send(fd);
 }
 const cwdIsRoot=()=>['all','recent','@cos'].includes(pane);
 $id('lib-upload-btn').onclick=()=>$id('lib-file-input').click();
 $id('lib-file-input').onchange=e=>{upload([...e.target.files]);e.target.value='';};
 $id('lib-refresh').onclick=()=>reload().then(()=>toast('已刷新。'));
 const drop=$id('lib-drop');
 ['dragenter','dragover'].forEach(ev=>drop.addEventListener(ev,e=>{e.preventDefault();drop.classList.add('over');}));
 ['dragleave','drop'].forEach(ev=>drop.addEventListener(ev,e=>{e.preventDefault();drop.classList.remove('over');}));
 drop.addEventListener('drop',e=>upload([...e.dataTransfer.files]));
 $id('lib-search').oninput=e=>{query=e.target.value.trim().toLowerCase();renderMain();};
 $id('lib-toggle').querySelectorAll('button').forEach(b=>b.onclick=()=>{
  view=b.dataset.view;
  $id('lib-toggle').querySelectorAll('button').forEach(x=>x.classList.toggle('active',x===b));
  renderMain();
 });

 window.addEventListener('hashchange',()=>{if(location.hash==='#library')reload();});
 reload();
})();
