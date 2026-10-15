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
 <div class="lib-head-actions">
  <label class="lib-sign" title="上传时给文件贴的署名标签">署名 <select id="lib-sign"></select></label>
  <button class="button secondary" id="lib-mkdir">＋ 新建文件夹</button>
  <button class="button secondary" id="lib-refresh">↻ 刷新</button>
  <button class="button primary" id="lib-upload-btn">⬆ 上传文件</button>
 </div></div>
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
   <div class="lib-head" id="lib-head"><span></span><span>名称</span><span class="lib-author">作者</span><span class="lib-date">日期</span><span class="lib-size">大小</span><span>来源</span><span></span></div>
   <div class="lib-list" id="lib-list"></div>
  </div>
 </div>
 <div class="lib-preview" id="lib-preview" hidden><div class="lib-preview-card card">
  <div class="lib-preview-head"><div><strong id="lib-preview-name"></strong><div class="lib-preview-meta" id="lib-preview-meta"></div></div><button class="button secondary" id="lib-preview-close">关闭</button></div>
  <div class="lib-preview-body" id="lib-preview-body"></div></div></div>
 <div class="lib-menu" id="lib-menu" hidden></div>
 <div class="lib-prompt" id="lib-prompt" hidden><div class="lib-prompt-card card">
  <div class="lib-preview-head"><strong id="lib-prompt-title"></strong></div>
  <div class="lib-prompt-body"><label id="lib-prompt-label">名称</label><input id="lib-prompt-input" autocomplete="off"><p class="lib-hint" id="lib-prompt-hint"></p></div>
  <div class="lib-prompt-actions"><button class="button secondary" id="lib-prompt-cancel">取消</button><button class="button primary" id="lib-prompt-ok">确定</button></div>
 </div></div>
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
 const tagOf=p=>data.labels?.[p]?.tag||data.meta?.[p]?.author||''; // 署名标签：登记表优先，manifest 兜底

 async function reload(){
  try{data=await api('/api/library/tree');}catch(e){toast(e.message);return;}
  renderSign();renderStats();renderTree();renderMain();
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
 return `<div class="lib-row lib-row-dir${fresh.has(d.path)?' is-new':''}" data-open="${esc(d.path)}"><span class="lib-ico">${ICON.dir}</span><span class="lib-name">${esc(d.name)}/${fresh.has(d.path)?'<b class="lib-new-tag">新</b>':''}</span><span class="lib-author">—</span><span class="lib-date">${dirCount(d.path)} 项</span><span class="lib-size">—</span><span class="lib-src">目录</span><button class="lib-more" data-more="${esc(d.path)}" data-dir="1" type="button" title="操作">⋯</button></div>`;
}
 function rowFile(f){
  const k=kindOf(f.name),tag=tagOf(f.path);
  return `<div class="lib-row${fresh.has(f.path)?' is-new':''}" data-preview="${esc(f.path)}" title="${esc(f.path)}">
   <span class="lib-ico">${ICON[k]}</span>
   <span class="lib-name">${esc(f.name)}${fresh.has(f.path)?'<b class="lib-new-tag">新</b>':''}<small>${esc(parentOf(f.path)||'/')}</small></span>
   <span class="lib-author">${tag?`<b class="lib-tag">${esc(tag)}</b>`:'<span class="lib-notag">未署名</span>'}</span>
   <span class="lib-date">${esc(fileDate(f))}</span>
   <span class="lib-size">${fmtSize(f.size||0)}</span>
   <span class="lib-src">Gitee</span>
   <button class="lib-more" data-more="${esc(f.path)}" type="button" title="操作">⋯</button></div>`;
 }
 function rowCos(e){
  const st=e.status==='pending'?'<b class="lib-pending">待传</b>':'';
  const tag=e.author?authorName(e.author):'';
  return `<div class="lib-row${fresh.has(e.name)?' is-new':''}" data-cos="${esc(e.cos)}" title="${esc(e.cos)}">
   <span class="lib-ico">${ICON.cos}</span>
   <span class="lib-name">${esc(e.name)}${st}<small>云端 · ${esc(e.date||'')}</small></span>
   <span class="lib-author">${tag?`<b class="lib-tag lib-tag-cos">${esc(tag)}</b>`:'<span class="lib-notag">未署名</span>'}</span>
   <span class="lib-date">${esc(e.date||'')}</span>
   <span class="lib-size">${e.size_mb&&e.size_mb!=='0.0'?esc(e.size_mb)+' MB':'—'}</span>
   <span class="lib-src lib-src-cos">COS ↗</span>
   <span class="lib-more lib-more-off">·</span></div>`;
 }
 function bindRows(){
  document.querySelectorAll('#lib-list [data-more]').forEach(el=>el.onclick=e=>{
   e.stopPropagation();openMenu(el,el.dataset.more,el.dataset.dir==='1');
  });
  document.querySelectorAll('#lib-list [data-open]').forEach(el=>el.onclick=e=>{
   if(e.target.closest('[data-more]'))return;
   pane=el.dataset.open;expanded.add(pane);renderTree();renderMain();
  });
  document.querySelectorAll('#lib-list [data-cos]').forEach(el=>el.onclick=e=>{if(e.target.closest('[data-more]'))return;window.open(el.dataset.cos,'_blank','noopener');});
  document.querySelectorAll('#lib-list [data-preview]').forEach(el=>el.onclick=e=>{if(e.target.closest('[data-more]'))return;preview(el.dataset.preview);});
 }

 // ---- 文件操作：新建文件夹 / 重命名 / 移动 / 贴署名（按要求不做删除） ----
 const post=async(url,payload)=>{
  const r=await fetch(url,{method:'POST',headers:{'Content-Type':'application/json','X-CSRF-Token':csrf},body:JSON.stringify(payload)});
  const d=await r.json().catch(()=>({}));
  if(!r.ok)throw Error(d.error||'操作失败，请稍后重试。');
  return d;
 };
 let menuTarget=null;
 function openMenu(btn,rel,isDir){
  const m=$id('lib-menu'),tag=isDir?'':tagOf(rel);
  const items=[`<button data-act="rename">重命名</button>`,`<button data-act="move">移动到…</button>`];
  if(!isDir){
   items.push('<div class="lib-menu-sep"></div>');
   if(tag)items.push(`<div class="lib-menu-note">已署名「${esc(tag)}」，不可修改</div>`);
   else items.push(`<div class="lib-menu-note">贴署名（选定后不可修改）</div>`,
    ...(data.tags||[]).map(t=>`<button data-act="tag" data-tag="${esc(t.label)}">署名 ${esc(t.label)}</button>`));
  }
  m.innerHTML=items.join('');
  m.hidden=false;
  const r=btn.getBoundingClientRect();
  m.style.top=Math.min(r.bottom+6,window.innerHeight-260)+'px';
  m.style.left=Math.max(12,Math.min(r.right-186,window.innerWidth-198))+'px';
  menuTarget=rel;
  m.querySelectorAll('button[data-act]').forEach(b=>b.onclick=async()=>{
   m.hidden=true;const act=b.dataset.act;
   if(act==='rename')askRename(rel,isDir);
   else if(act==='move')askMove(rel);
   else if(act==='tag'){
    try{await post('/api/library/tag',{path:rel,tag:b.dataset.tag});toast(`已署名 ${b.dataset.tag}`);await reload();}
    catch(e){toast(e.message);}
   }
  });
 }
 document.addEventListener('click',e=>{
  const m=$id('lib-menu');
  if(m&&!m.hidden&&!m.contains(e.target)&&!e.target.classList.contains('lib-more'))m.hidden=true;
 });
 let promptOk=null;
 function askText(title,label,value,hint,ok){
  $id('lib-prompt-title').textContent=title;
  $id('lib-prompt-label').textContent=label;
  $id('lib-prompt-input').value=value||'';
  $id('lib-prompt-hint').textContent=hint||'';
  $id('lib-prompt').hidden=false;promptOk=ok;
  setTimeout(()=>{$id('lib-prompt-input').focus();$id('lib-prompt-input').select?.();},30);
 }
 $id('lib-prompt-cancel').onclick=()=>{$id('lib-prompt').hidden=true;promptOk=null;};
 $id('lib-prompt').onclick=e=>{if(e.target.id==='lib-prompt')$id('lib-prompt-cancel').click();};
 $id('lib-prompt-ok').onclick=async()=>{
  const v=$id('lib-prompt-input').value.trim();if(!promptOk)return;
  const fn=promptOk;promptOk=null;$id('lib-prompt').hidden=true;await fn(v);
 };
 $id('lib-prompt-input').onkeydown=e=>{if(e.key==='Enter')$id('lib-prompt-ok').click();if(e.key==='Escape')$id('lib-prompt-cancel').click();};
 const curDir=()=>(pane.startsWith('@')||pane==='all'||pane==='recent')?'knowledge':pane;
$id('lib-mkdir').onclick=()=>{
 const base=curDir();
 askText('新建文件夹','文件夹名称','','将创建在：'+base,async name=>{
  if(!name)return;
  try{const d=await post('/api/library/mkdir',{path:`${base}/${name}`});
   pane=base;expanded.add(base);fresh=new Set([d.path]); // 留在原处，让新建的文件夹高亮可见
   await reload();toast('已新建文件夹 '+d.path);
   $id('lib-list').querySelector('.is-new')?.scrollIntoView({block:'nearest',behavior:'smooth'});}
  catch(e){toast(e.message);}
 });
};
function askRename(rel,isDir){
 const old=rel.split('/').pop();
 askText('重命名',isDir?'文件夹名称':'文件名称',old,'',async name=>{
  if(!name||name===old)return;
  const parent=parentOf(rel),to=parent?`${parent}/${name}`:name;
  try{const d=await post('/api/library/move',{from:rel,to});
   if(pane===rel||pane.startsWith(rel+'/'))pane=d.to+(pane===rel?'':pane.slice(rel.length)); // 正待在被改名的目录里，跟着挪
   fresh=new Set([d.to]);await reload();toast('已重命名');}
  catch(e){toast(e.message);}
 });
}
function askMove(rel){
 askText('移动到','目标目录（可填子路径）',parentOf(rel)||'knowledge','留空不改；分区：projects、knowledge、workflows、media，也可直接填子路径，如 knowledge/产品',async to=>{
   if(!to)return;
   const name=rel.split('/').pop(),dest=to.replace(/\/+$/,'');
   try{const d=await post('/api/library/move',{from:rel,to:`${dest}/${name}`});
    pane=dest;fresh=new Set([d.to]);toast('已移动到 '+dest);await reload();}
   catch(e){toast(e.message);}
  });
 }
 function renderSign(){
  const sel=$id('lib-sign');if(!sel||sel.dataset.ready)return;
  const tags=data.tags||[];
  sel.innerHTML='<option value="">不署名</option>'+tags.map(t=>`<option value="${esc(t.label)}">${esc(t.label)}</option>`).join('');
  const mine=data.me?.label; // 默认选中登录人对应的标签
  sel.value=mine&&tags.some(t=>t.label===mine)?mine:'';
  sel.dataset.ready='1';
 }

 // ---- Markdown 渲染（贴近 Obsidian 阅读视图） ----
 const isMd=n=>/\.(md|markdown)$/i.test(n);
 const FM_LABEL={title:'标题',author:'作者',date:'日期',updated:'更新',tags:'标签',tag:'标签',source:'来源',summary:'摘要'};
 function splitFm(text){ // 剥离 frontmatter，渲染成属性面板（Obsidian 的 properties）
  if(!text.startsWith('---'))return{meta:null,body:text};
  const end=text.indexOf('\n---',3);
  if(end===-1)return{meta:null,body:text};
  const raw=text.slice(3,end).trim(),nl=text.indexOf('\n',end+1);
  const meta={};
  for(const line of raw.split('\n')){
   const m=line.match(/^([A-Za-z0-9_-]+)\s*:\s*(.*)$/);
   if(m)meta[m[1].toLowerCase()]=m[2].trim().replace(/^["']|["']$/g,'');
  }
  return{meta:Object.keys(meta).length?meta:null,body:nl===-1?'':text.slice(nl+1)};
 }
 const obsidian=text=>text
  .replace(/%%[\s\S]*?%%/g,'')                                   // Obsidian 注释：不显示
  .replace(/\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g,(m,t,l)=>          // 双链 [[目标|别名]]
   `<span class="md-wikilink" data-wiki="${esc(t.trim())}">${esc((l||t).trim())}</span>`)
  .replace(/==([^=\n]+)==/g,'<mark>$1</mark>');                   // 高亮 ==文字==
 function renderMd(raw){
  const{meta,body}=splitFm(raw);
  const html=window.marked?window.marked.parse(obsidian(body),{gfm:true,breaks:true})
   :`<pre class="lib-pre">${esc(body)}</pre>`;
  const clean=window.DOMPurify?window.DOMPurify.sanitize(html,{ADD_ATTR:['data-wiki','align','disabled','checked'],ADD_TAGS:['mark','input']}):html;
  const props=meta?`<div class="md-props">${Object.entries(meta).map(([k,v])=>
   `<div class="md-prop"><span>${esc(FM_LABEL[k]||k)}</span><b>${esc(v)}</b></div>`).join('')}</div>`:'';
  return `<div class="lib-md">${props}${clean}</div>`;
 }
 function decorateMd(body){ // 渲染后处理：代码高亮、标签样式、双链跳转
  if(window.hljs)body.querySelectorAll('pre code').forEach(el=>{try{window.hljs.highlightElement(el);}catch{/* 未知语言忽略 */}});
  const walker=document.createTreeWalker(body,NodeFilter.SHOW_TEXT,{acceptNode:n=>
   /#[\w\u4e00-\u9fa5\/-]+/.test(n.nodeValue)&&!n.parentElement.closest('pre,code,a,.md-tag')?NodeFilter.FILTER_ACCEPT:NodeFilter.FILTER_REJECT});
  const nodes=[];while(walker.nextNode())nodes.push(walker.currentNode);
  for(const n of nodes){ // #标签 → 圆角标签（Obsidian 特征）
   const frag=document.createDocumentFragment();let last=0,text=n.nodeValue,m;
   const re=/(^|\s)(#[\w\u4e00-\u9fa5\/-]+)/g;
   while((m=re.exec(text))){frag.append(text.slice(last,m.index)+m[1]);
    const sp=document.createElement('span');sp.className='md-tag';sp.textContent=m[2];frag.append(sp);last=m.index+m[0].length;}
   if(last){frag.append(text.slice(last));n.replaceWith(frag);}
  }
  body.querySelectorAll('.md-wikilink').forEach(el=>el.onclick=()=>{ // 点击双链 → 全库搜索该名称
   const t=el.dataset.wiki;$id('lib-search').value=t;query=t.toLowerCase();
   $id('lib-preview').hidden=true;renderMain();
  });
 }
 // ---- 预览 ----
 async function preview(rel){
  const name=rel.split('/').pop(),k=kindOf(name);
  $id('lib-preview-name').textContent=name;
  $id('lib-preview-meta').textContent=`${rel}　·　${data.meta[rel]?.author?authorName(data.meta[rel].author)+'　·　':''}${data.meta[rel]?.date||''}`;
  const body=$id('lib-preview-body');body.innerHTML='加载中…';$id('lib-preview').hidden=false;
  try{
   if(k==='image')body.innerHTML=`<img src="/api/library/file?path=${encodeURIComponent(rel)}" alt="${esc(name)}" style="max-width:100%;border-radius:8px">`;
   else if(isMd(name)){
    const r=await fetch('/api/library/file?path='+encodeURIComponent(rel));
    if(!r.ok)throw Error((await r.json().catch(()=>({}))).error||'预览失败');
    body.innerHTML=renderMd(await r.text());
    decorateMd(body);
   }
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
  fd.append('tag',$id('lib-sign')?.value||''); // 署名标签（空 = 不署名）
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
