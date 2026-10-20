// 「库」页面：Finder 式公司资产仓库（左树 + 右文件表 + 拖拽入库 + 预览 + 搜索）。
// 数据来自 library 服务：Gitee 克隆仓目录树 与 media/manifest.yaml 的 COS 条目，合并成一个视图。
(()=>{
 const api=window.Workroom?.api,csrf=window.Workroom?.csrf;
 if(!api)return; // 未登录不挂载
 pageNames.library='资料库';
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
 // 登记型栏目（资料/应用/组织/Skill）不再各自成页，改为「资料库」内的固定分组；
 // 条目仍是数据库记录（/api/directory），渲染复用 portal.js 的 entryCard。
 const ENTRY_GROUPS=[['material','公司资料','▤'],['app','应用','▦'],['contact','组织','♧'],['skill','Skill','✧']];
 const ENTRY_LABEL=Object.fromEntries(ENTRY_GROUPS.map(([k,l])=>[k,l]));
 const ENTRY_HINT={material:'文档、知识库与业务表格链接',app:'团队在用的系统与网页工具',contact:'部门与关键联系人入口',skill:'工作方法、提示词与 Skill 入口'};

 // ---- 页面挂载（左侧导航项与移动端入口由 portal.js / mobile-ui.js 统一生成，这里不再重复插入） ----

 document.querySelector('.content').insertAdjacentHTML('beforeend',`
<section id="library" class="page" hidden>
 <div class="heading"><div><div class="eyebrow">COMPANY LIBRARY</div><h1>资料库</h1><p>公司文件与登记入口的唯一入口。拖文件或整个文件夹进来即入库：正文存 Gitee 仓库，视频与超大文件存云端。</p></div>
 <div class="lib-head-actions">
  <label class="lib-sign" title="上传时给文件贴的署名标签">署名 <select id="lib-sign"></select></label>
  <button class="button secondary" id="lib-dir-btn" title="上传整个文件夹，保留目录层级">⬆ 上传文件夹</button>
  <button class="button primary" id="lib-upload-btn">⬆ 上传文件</button>
 </div></div>
 <input id="lib-file-input" type="file" multiple hidden>
 <input id="lib-dir-input" type="file" webkitdirectory directory multiple hidden>
  <div class="lib-toolbar">
  <div class="lib-crumb" id="lib-crumb">资料库</div>
  <label class="search lib-search"><span>⌕</span><input id="lib-search" type="search" placeholder="搜索文件名或登记入口" aria-label="搜索资料库"></label>
  <div class="lib-toolbar-right">
   <button class="button secondary lib-minor" id="lib-jobs" hidden>⬇ 已打包</button>
   <button class="button secondary lib-minor" id="lib-dl" hidden>⬇ 下载</button>
   <button class="button secondary lib-minor" id="lib-copy" hidden>⧉ 复制</button>
   <button class="button secondary lib-minor" id="lib-cut" hidden>✂ 剪切</button>
   <button class="button secondary lib-minor" id="lib-paste" hidden>⇩ 粘贴</button>
   <button class="button secondary lib-minor" id="lib-mkdir">＋ 新建文件夹</button>
   <button class="button secondary lib-minor lib-minor-icon" id="lib-refresh" title="刷新列表" aria-label="刷新列表">↻</button>
   <div class="lib-toggle" id="lib-toggle"><button data-view="list" class="active">☰ 列表</button><button data-view="grid">▦ 图标</button></div>
  </div>
 </div>
 <div class="lib-stats" id="lib-stats"></div>
 <div class="lib-layout" id="lib-layout">
  <nav class="lib-tree" id="lib-tree" aria-label="资料库侧栏"></nav>
  <div class="lib-main">
   <div class="lib-drop" id="lib-drop"><strong>拖拽文件或整个文件夹到这里入库</strong><span>文件夹会连层级一起建好；文档/图片进 Gitee 仓库并自动署名，视频与大于 50MB 的文件直传云端存储</span></div>
   <div class="lib-progress" id="lib-progress" hidden><div class="lib-progress-bar" id="lib-progress-bar"></div><span id="lib-progress-text"></span></div>
   <div class="lib-head" id="lib-head"><span></span><span>名称</span><span class="lib-author">作者</span><span class="lib-date">日期</span><span class="lib-size">大小</span><span>来源</span><span></span></div>
   <div class="lib-list" id="lib-list"></div>
  </div>
  <aside class="lib-preview" id="lib-preview" hidden><div class="lib-preview-card card">
  <div class="lib-preview-head"><div><strong id="lib-preview-name"></strong><div class="lib-preview-meta" id="lib-preview-meta"></div></div><div class="lib-preview-tools"><button class="button secondary" id="lib-preview-dl" hidden>⬇ 下载</button><a class="button secondary" id="lib-preview-open" hidden target="_blank" rel="noopener">新窗口打开 ↗</a><button class="button secondary" id="lib-preview-close">关闭</button></div></div>
  <div class="lib-preview-body" id="lib-preview-body"></div></div></aside>
 </div>
 <div class="lib-menu" id="lib-menu" hidden></div>
 <div class="lib-prompt" id="lib-dlbox" hidden><div class="lib-prompt-card card">
  <div class="lib-preview-head"><strong id="lib-dl-title">下载</strong></div>
  <div class="lib-dl-body" id="lib-dl-body"></div>
  <div class="lib-prompt-actions"><button class="button secondary" id="lib-dl-cancel">取消</button><button class="button primary" id="lib-dl-ok">开始下载</button></div>
 </div></div>
 <div class="lib-prompt" id="lib-prompt" hidden><div class="lib-prompt-card card">
  <div class="lib-preview-head"><strong id="lib-prompt-title"></strong></div>
  <div class="lib-prompt-body" id="lib-prompt-loc-wrap" hidden><label for="lib-prompt-loc">创建位置</label><select id="lib-prompt-loc"></select></div>
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
 // 每个署名固定一个颜色，让「谁上传的」在侧栏与列表里一眼可辨（Finder 标签观感）
 const TAG_COLORS=['#2f7bd8','#2f9e5f','#c77d1a','#8b5cf6','#d6497a','#0f9b9b'];
 const tagColor=t=>{const i=(data.tags||[]).findIndex(x=>x.label===t);return i<0?'#8a929f':TAG_COLORS[i%TAG_COLORS.length];};
 // 目录/文件署名了就在树里点一个颜色点，与「署名标签」同色
 const treeDot=p=>{const t=tagOf(p);return t?`<span class="lib-tree-tagdot" style="background:${tagColor(t)}" title="署名：${esc(t)}"></span>`:'';};

 // ---- 选中与剪贴板 ----
 // 选择语义对齐常规文件系统：单击选中，Ctrl/⌘ 点击加选（Mac 用 ⌘），Shift 点击范围选。
 // 剪贴板只存在内存里（刷新即清空），落在服务端的是粘贴那一刻的真实复制/移动。
 let selSet=new Set(),anchor='',lastPane='';   // 选中集合 / Shift 区间锚点 / 上一次所在位置
 let clip={mode:'',items:[]};          // {mode:'copy'|'cut',items:[{path,name}]}
 const IS_MAC=/Mac|iPhone|iPad|iPod/.test(navigator.platform||navigator.userAgent||'');
 const combo=k=>IS_MAC?`⌘${k}`:`Ctrl+${k}`;   // 快捷键提示：Mac 显示 ⌘C，其他显示 Ctrl+C
 const rowPath=el=>el.dataset.open||el.dataset.preview||''; // 可选择的只有真实仓库文件与目录
 const isCut=p=>clip.mode==='cut'&&clip.items.some(i=>i.path===p);
 const rowState=p=>`${selSet.has(p)?' is-sel':''}${isCut(p)?' is-cut':''}`;
 const rowsInView=()=>[...document.querySelectorAll('#lib-list .lib-row')].filter(el=>rowPath(el));
 // 粘贴落点：只有在真实目录里才能粘；虚拟视角（全库/最近/云端/登记/署名）没有落点
 const pasteTarget=()=>cwdIsRoot()?null:pane;
 const clearSel=()=>{selSet=new Set();anchor='';};

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

// 侧栏三段：位置 → 入库登记 → 署名标签 → 目录（真实文件树）。
// 库根的一级目录 = 仓库里真实存在的同级目录（projects / knowledge / workflows / media 是默认四项，
// 其余由「新建文件夹 → 库根目录」创建）。界面只做中文标签映射，不动磁盘结构。
// 空分组不占位：计数为 0 的行直接不渲染（0 个徽标也一并省掉），避免整列被「全是 0」撑满而显得挤。
function renderTree(){
 const rows=[],links=portal.links||[];
 const paneItem=(key,icon,label,count,cls='')=>`<div class="lib-tree-item${cls?' '+cls:''}${pane===key?' active':''}" data-pane="${esc(key)}"><span class="lib-tree-ico">${icon}</span><span class="lib-tree-name">${esc(label)}</span>${count?'<span class="lib-count">'+count+'</span>':''}</div>`;
 const dirItem=(key,label,count,depth,isRoot)=>{
   const open=expanded.has(key);
   return `<div class="lib-tree-item${isRoot?' lib-tree-root':''}${pane===key?' active':''}" style="padding-left:${12+depth*14}px" data-path="${esc(key)}"><span class="lib-tree-ico">${open?'▾':'▸'}</span>${treeDot(key)}<span class="lib-tree-name">${esc(label)}</span><span class="lib-count">${count}</span></div>`;
  };
  rows.push('<div class="lib-tree-group">位置</div>');
  rows.push(paneItem('all','▤','全部文件',allFiles().length,'lib-tree-sys'));
  rows.push(paneItem('recent','◷','最近上传',allFiles().length+data.cos.length,'lib-tree-sys'));
  if(data.cos.length)rows.push(paneItem('@cos','☁','云端大文件',data.cos.length,'lib-tree-sys lib-tree-cos'));
  // 入库登记：只列「有货」的分组；四条全空时压成一行引导，不再摆四个 0
  rows.push('<div class="lib-tree-group">入库登记</div>');
  const hitKinds=ENTRY_GROUPS.filter(([kind])=>links.some(l=>l.kind===kind));
  if(hitKinds.length)for(const [kind,label,icon] of hitKinds)rows.push(paneItem('@entries:'+kind,icon,label,links.filter(l=>l.kind===kind).length,'lib-tree-entry'));
  else rows.push('<div class="lib-tree-item lib-tree-add" data-goto="#settings"><span class="lib-tree-ico">＋</span><span class="lib-tree-name">登记第一个入口</span></div>');
  // 署名标签：只列真的挂着内容的署名（文件 + 目录 + 云端）
  const tagN=label=>allFiles().filter(f=>tagOf(f.path)===label).length+allDirs().filter(d=>tagOf(d.path)===label).length+data.cos.filter(c=>authorName(c.author)===label).length;
  const tags=(data.tags||[]).map(t=>({label:t.label,n:tagN(t.label)})).filter(t=>t.n);
  if(tags.length){
   rows.push('<div class="lib-tree-group">署名标签</div>');
   for(const t of tags){
    rows.push(`<div class="lib-tree-item${pane==='@tag:'+t.label?' active':''}" data-pane="${esc('@tag:'+t.label)}"><span class="lib-tree-ico lib-tree-tagdot" style="background:${tagColor(t.label)}"></span><span class="lib-tree-name">${esc(t.label)}</span><span class="lib-count">${t.n}</span></div>`);
   }
  }
  rows.push('<div class="lib-tree-group">目录</div>');
  const roots=data.roots?.length?data.roots:['projects','knowledge','workflows','media'];
  for(const r of roots){
   rows.push(dirItem(r,ROOT_LABEL[r]||r,dirCount(r),0,true));
   if(expanded.has(r))walk(r,1,rows);
  }
  $id('lib-tree').innerHTML=rows.join('');
  $id('lib-tree').querySelectorAll('[data-pane]').forEach(el=>el.onclick=()=>{pane=el.dataset.pane;renderTree();renderMain();});
  $id('lib-tree').querySelectorAll('[data-goto]').forEach(el=>el.onclick=()=>{location.hash=el.dataset.goto;});
  $id('lib-tree').querySelectorAll('[data-path]').forEach(el=>el.onclick=e=>{
   const p=el.dataset.path;
   if(e.target.closest('.lib-count')||pane===p){expanded.has(p)?expanded.delete(p):expanded.add(p);}
   else{expanded.add(p);}
   pane=p;renderTree();renderMain();
  });
 }
 function walk(p,depth,rows){
  for(const d of childDirs(p).sort((a,b)=>a.name.localeCompare(b.name,'zh'))){
   const open=expanded.has(d.path);
   rows.push(`<div class="lib-tree-item${pane===d.path?' active':''}" style="padding-left:${12+depth*14}px" data-path="${esc(d.path)}"><span class="lib-tree-ico">${open?'▾':'▸'}</span>${treeDot(d.path)}<span class="lib-tree-name">${esc(d.name)}</span><span class="lib-count">${dirCount(d.path)}</span></div>`);
   if(open)walk(d.path,depth+1,rows);
  }
 }

 function renderMain(){
  const crumb=$id('lib-crumb'),list=$id('lib-list');
  if(pane!==lastPane){lastPane=pane;clearSel();} // 换位置就清选择（剪贴板不受影响）
  const crumbOf=()=>{
   if(pane==='@cos')return['位置','云端大文件'];
   if(pane==='recent')return['位置','最近上传'];
   if(pane==='all')return['位置','全部文件'];
   if(pane.startsWith('@entries:'))return['入库登记',ENTRY_LABEL[pane.slice(9)]||''];
   if(pane.startsWith('@tag:'))return['署名标签',pane.slice(5)];
   return['目录',pane.replaceAll('/',' / ')];
  };
  const [crumbGroup,crumbName]=crumbOf();
  crumb.innerHTML=`资料库 <span class="lib-crumb-sep">›</span> <b>${esc(crumbGroup)}</b> <span class="lib-crumb-sep">›</span> ${esc(crumbName)}`;
  list.className='lib-list'+(view==='grid'?' lib-list-grid':'');
  $id('lib-head').style.display=view==='list'?'':'none';
  const hideHead=()=>{$id('lib-head').style.display='none';};

  if(query){ // 搜索覆盖全库：登记入口 + 仓库文件 + 云端条目
   const q=query.toLowerCase();
   const hits=allFiles().filter(e=>e.name.toLowerCase().includes(q));
   const cosHits=data.cos.filter(e=>e.name.toLowerCase().includes(q));
   const entryHits=(portal.links||[]).filter(l=>`${l.name} ${l.note||''} ${l.instructions||''}`.toLowerCase().includes(q));
   const total=hits.length+cosHits.length+entryHits.length;
   list.innerHTML=total
    ? `<div class="lib-section-label">搜索「${esc(query)}」：${total} 个结果</div>`+entryHits.map(rowEntry).join('')+hits.map(rowFile).join('')+cosHits.map(rowCos).join('')
    : `<div class="lib-empty">没有匹配「${esc(query)}」的内容。<br><span class="lib-hint">换个关键词，或把文件拖进来入库。</span></div>`;
   bindRows();wirePortalActions();
   return;
  }
  if(pane.startsWith('@entries:')){ // 登记型栏目：复用 portal.js 的入口卡片，数据仍是 /api/directory
   const kind=pane.slice(9),links=(portal.links||[]).filter(l=>l.kind===kind);
   hideHead();
   list.innerHTML=`<div class="lib-section-label">${esc(ENTRY_LABEL[kind]||kind)} · ${esc(ENTRY_HINT[kind]||'已登记的入口')}<b>${links.length}</b></div>`+
    (links.length
     ? `<div class="lib-entry-grid">${links.map(entryCard).join('')}</div>`
     : `<div class="lib-empty">这一类还没有登记入口。<br><span class="lib-hint">到「入口管理」登记后，会自动出现在这里。</span></div><div class="lib-empty-action"><a class="button secondary" href="#settings">去登记 ↗</a></div>`);
   wirePortalActions();renderClipUI();
   return;
  }
  if(pane.startsWith('@tag:')){ // 署名标签：按人筛选目录、仓库文件与云端条目
   const tag=pane.slice(5);
   const ds=allDirs().filter(d=>tagOf(d.path)===tag);
   const fs_=allFiles().filter(f=>tagOf(f.path)===tag);
   const cs=data.cos.filter(c=>authorName(c.author)===tag);
   const n=ds.length+fs_.length+cs.length;
   list.innerHTML=`<div class="lib-section-label">署名「${esc(tag)}」：${n} 项<b>${n}</b></div>`+
    (n
     ? ds.map(rowDir).join('')+fs_.map(rowFile).join('')+cs.map(rowCos).join('')
     : `<div class="lib-empty">还没有署名为「${esc(tag)}」的内容。<br><span class="lib-hint">上传时在顶栏选署名，或用行尾的 ⋯ 菜单给文件或目录补署名。</span></div>`);
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
  if(pane==='all'){ // 全库总览：按一级目录分组，一屏看得到所有东西
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
   const links=portal.links||[]; // 登记型栏目也列进总览，保持「一个入口看全部」
   if(links.length){
    html+=`<div class="lib-section-label">入库登记 · 已登记的入口<b>${links.length}</b></div>`;
    for(const [kind,label,icon] of ENTRY_GROUPS){
     const n=links.filter(l=>l.kind===kind).length;
     if(n)html+=`<div class="lib-row lib-row-dir" data-pane-open="${esc('@entries:'+kind)}"><span class="lib-ico">${icon}</span><span class="lib-name">${esc(label)}/<small>${esc(ENTRY_HINT[kind]||'')}</small></span><span class="lib-author">—</span><span class="lib-date">${n} 项</span><span class="lib-size">—</span><span class="lib-src">登记</span><span class="lib-more lib-more-off">·</span></div>`;
    }
   }
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
 const tag=tagOf(d.path);
 return `<div class="lib-row lib-row-dir${fresh.has(d.path)?' is-new':''}${rowState(d.path)}" data-open="${esc(d.path)}"><span class="lib-ico">${ICON.dir}</span><span class="lib-name">${esc(d.name)}/${fresh.has(d.path)?'<b class="lib-new-tag">新</b>':''}</span><span class="lib-author">${tag?`<b class="lib-tag" style="--c:${tagColor(tag)}">${esc(tag)}</b>`:'<span class="lib-notag">—</span>'}</span><span class="lib-date">${dirCount(d.path)} 项</span><span class="lib-size">—</span><span class="lib-src">目录</span><button class="lib-more" data-more="${esc(d.path)}" data-dir="1" type="button" title="操作">⋯</button></div>`;
}
 function rowFile(f){
  const k=kindOf(f.name),tag=tagOf(f.path);
  return `<div class="lib-row${fresh.has(f.path)?' is-new':''}${rowState(f.path)}" data-preview="${esc(f.path)}" title="${esc(f.path)}">
   <span class="lib-ico">${ICON[k]}</span>
   <span class="lib-name">${esc(f.name)}${fresh.has(f.path)?'<b class="lib-new-tag">新</b>':''}<small>${esc(parentOf(f.path)||'/')}</small></span>
   <span class="lib-author">${tag?`<b class="lib-tag" style="--c:${tagColor(tag)}">${esc(tag)}</b>`:'<span class="lib-notag">未署名</span>'}</span>
   <span class="lib-date">${esc(fileDate(f))}</span>
   <span class="lib-size">${fmtSize(f.size||0)}</span>
   <span class="lib-src">Gitee</span>
   <button class="lib-more" data-more="${esc(f.path)}" type="button" title="操作">⋯</button></div>`;
 }
 function rowCos(e){
  const st=e.status==='pending'?'<b class="lib-pending">待传</b>':'';
  const tag=e.author?authorName(e.author):'';
  return `<div class="lib-row${fresh.has(e.name)?' is-new':''}" data-coskey="${esc(e.key||'')}" data-cos="${esc(e.cos||'')}" title="${esc(e.cos||e.key||'')}">
   <span class="lib-ico">${ICON.cos}</span>
   <span class="lib-name">${esc(e.name)}${st}<small>云端 · ${esc(e.date||'')}</small></span>
   <span class="lib-author">${tag?`<b class="lib-tag lib-tag-cos" style="--c:${tagColor(tag)}">${esc(tag)}</b>`:'<span class="lib-notag">未署名</span>'}</span>
   <span class="lib-date">${esc(e.date||'')}</span>
   <span class="lib-size">${e.size_mb&&e.size_mb!=='0.0'?esc(e.size_mb)+' MB':'—'}</span>
   <span class="lib-src lib-src-cos">COS ↗</span>
   <button class="lib-more" data-cosmore="${esc(e.key||'')}" type="button" title="操作">⋯</button></div>`;
 }
 function rowEntry(l){ // 搜索结果里的登记入口行（点击直接打开原链接）
  const icon=(ENTRY_GROUPS.find(g=>g[0]===l.kind)||[,'','▤'])[2];
  const href=(typeof safeURL==='function'&&safeURL(l.url))||'';
  return `<div class="lib-row lib-row-entry" data-entry-url="${esc(href)}" title="${esc(l.url||'')}">
   <span class="lib-ico">${icon}</span>
   <span class="lib-name">${esc(l.name)}<small>${esc(ENTRY_LABEL[l.kind]||'入口')}</small></span>
   <span class="lib-author">${esc(l.createdBy||'本机登记')}</span>
   <span class="lib-date">—</span>
   <span class="lib-size">—</span>
   <span class="lib-src">登记</span>
   <span class="lib-more lib-more-off">·</span></div>`;
 }
 function bindRows(){
  document.querySelectorAll('#lib-list [data-more]').forEach(el=>el.onclick=e=>{
   e.stopPropagation();const p=el.dataset.more;
   if(!selSet.has(p)){selSet=new Set([p]);anchor=p;refreshSelUI();} // 菜单只作用于选中项，先把它选上
   openMenu(el,p,el.dataset.dir==='1');
  });
  // 目录与文件共用一套点击语义：单击 = 选中并打开/预览；Ctrl(⌘)+点击 = 加选；Shift+点击 = 范围选
  document.querySelectorAll('#lib-list [data-open],#lib-list [data-preview]').forEach(el=>{
   const p=rowPath(el);
   el.onclick=e=>{
    if(e.target.closest('[data-more]'))return;
    if(e.shiftKey){rangeSelect(p);return;}
    if(e.metaKey||e.ctrlKey){toggleSel(p);return;}
    selSet=new Set([p]);anchor=p;refreshSelUI();
    if(el.dataset.open){pane=p;expanded.add(p);renderTree();renderMain();}
    else preview(p);
   };
   el.oncontextmenu=e=>{ // 右键：先选中（多选时保持整组），再出菜单
    e.preventDefault();
    const dir=el.dataset.open?'1':'';
    if(!selSet.has(p)){selSet=new Set([p]);anchor=p;refreshSelUI();}
    openMenu({x:e.clientX,y:e.clientY},p,dir==='1');
   };
  });
  document.querySelectorAll('#lib-list [data-coskey]').forEach(el=>el.onclick=e=>{
   if(e.target.closest('[data-cosmore]'))return;
   clearSel();refreshSelUI(); // 云端对象不支持复制/剪切，点到它就把选择清掉
   if(el.dataset.coskey)previewCos(el.dataset.coskey);           // 站内预览（视频可以直接播）
   else if(el.dataset.cos)window.open(el.dataset.cos,'_blank','noopener'); // 解析不出对象键时退回原链接
   else toast('这条记录没有云端定位信息。');
  });
  document.querySelectorAll('#lib-list [data-cosmore]').forEach(el=>el.onclick=e=>{
   e.stopPropagation();
   if(el.dataset.cosmore)openCosMenu(el,el.dataset.cosmore);
  });
  document.querySelectorAll('#lib-list [data-entry-url]').forEach(el=>el.onclick=()=>{clearSel();refreshSelUI();if(el.dataset.entryUrl)window.open(el.dataset.entryUrl,'_blank','noopener');});
  document.querySelectorAll('#lib-list [data-pane-open]').forEach(el=>el.onclick=()=>{clearSel();pane=el.dataset.paneOpen;renderTree();renderMain();});
  renderClipUI();
 }

 // ---- 选择操作 ----
 function toggleSel(p){
  if(selSet.has(p))selSet.delete(p);else selSet.add(p);
  anchor=p;refreshSelUI();
 }
 function rangeSelect(p){ // 以锚点为起点按当前列表顺序取区间（Finder 的 Shift 点击）
  const all=rowsInView().map(rowPath);
  const i=all.indexOf(anchor),j=all.indexOf(p);
  if(i<0||j<0){selSet=new Set([p]);anchor=p;}
  else{const[a,b]=i<j?[i,j]:[j,i];selSet=new Set(all.slice(a,b+1));}
  refreshSelUI();
 }
 function selectAllRows(){
  const all=rowsInView().map(rowPath);
  selSet=new Set(all);anchor=all[all.length-1]||'';
  refreshSelUI();
  toast(all.length?`已选中 ${all.length} 项`:'这个视图里没有可复制的项');
 }
 function refreshSelUI(){ // 只动 class，不重建列表（重建会丢掉滚动位置与预览）
  document.querySelectorAll('#lib-list .lib-row').forEach(el=>{
   const p=rowPath(el);if(!p)return;
   el.classList.toggle('is-sel',selSet.has(p));
   el.classList.toggle('is-cut',isCut(p));
  });
  renderClipUI();
 }
function renderClipUI(){ // 工具条上的「下载 / 复制 / 剪切 / 粘贴」按状态显隐；粘贴按钮显示目标与件数
 const n=selSet.size,has=clip.items.length>0;
 const dl=$id('lib-dl'),cp=$id('lib-copy'),ct=$id('lib-cut'),pt=$id('lib-paste');
 dl.hidden=!n;dl.textContent=`⬇ 下载${n>1?` (${n})`:''}`;
 dl.title=`下载选中项（${combo('S')}）：文件直下，文件夹自动打包`;
 cp.hidden=!n;ct.hidden=!n;pt.hidden=!has;
  cp.title=`复制选中项（${combo('C')}）`;
  ct.title=`剪切选中项（${combo('X')}）`;
  if(!has)return;
  const tgt=pasteTarget();
  pt.textContent=`⇩ 粘贴 (${clip.items.length})`;
  pt.disabled=!tgt;
  pt.title=tgt?`粘贴到 ${tgt}（${combo('V')}）`:`已${clip.mode==='cut'?'剪切':'复制'} ${clip.items.length} 项；先进入一个文件夹再粘贴`;
 }

 // ---- 文件操作：新建文件夹 / 重命名 / 移动 / 贴署名（按要求不做删除） ----
 const post=async(url,payload)=>{
  const r=await fetch(url,{method:'POST',headers:{'Content-Type':'application/json','X-CSRF-Token':csrf},body:JSON.stringify(payload)});
  const d=await r.json().catch(()=>({}));
  if(!r.ok)throw Error(d.error||'操作失败，请稍后重试。');
  return d;
 };
// ---- 复制 / 剪切 / 粘贴（剪贴板只在浏览器内存里；不提供删除） ----
function setClip(mode){
 const items=[...selSet].map(p=>({path:p,name:p.split('/').pop()}));
 if(!items.length){toast(`先选中要${mode==='cut'?'剪切':'复制'}的文件或目录。`);return;}
 clip={mode,items};
 refreshSelUI();
 const tip=`已${mode==='cut'?'剪切':'复制'} ${items.length} 项`;
 toast(mode==='cut'?`${tip}（原处会变淡，粘贴成功后消失）。进入目标文件夹按 ${combo('V')} 粘贴。`:`${tip}。进入目标文件夹按 ${combo('V')} 粘贴。`);
}
let pasting=false; // 粘贴要过一遍 git（pull + 复制/移动 + commit + push），期间挡住重复触发
async function doPaste(to){
 if(pasting){toast('上一次粘贴还在进行，稍等一下。');return;}
 if(!clip.items.length){toast('剪贴板是空的，先复制或剪切。');return;}
 const dest=to===undefined?pasteTarget():to;   // to 传进来 = 某目录行的「粘贴到此目录」
 if(dest===null){toast('请先进入一个文件夹，再粘贴。');return;}
 const mode=clip.mode,paths=clip.items.map(i=>i.path);
 pasting=true;
 const pt=$id('lib-paste'),old=pt.textContent;pt.disabled=true;pt.textContent='正在粘贴…';
 try{
  const r=await post('/api/library/paste',{mode,items:paths,to:dest||''});
  if(mode==='cut')clip={mode:'',items:[]}; // 剪切是一次性的；复制保留，可以重复粘
  const n=r.items?.length||0;
  fresh=new Set(r.items||[]);
  clearSel();
  if(dest){pane=dest;expanded.add(dest);}
  await reload();
  toast(`${mode==='cut'?'已移动':'已复制'} ${n} 项到 ${dest||'库根'}`);
  $id('lib-list').querySelector('.is-new')?.scrollIntoView({block:'nearest',behavior:'smooth'});
 }catch(e){toast(e.message);}
 finally{pasting=false;renderClipUI();}
}
let menuTarget=null;
// anchor 可以是元素（⋯ 按钮）或 {x,y}（右键位置）。rel 是这一行的路径，菜单里的单项操作都作用于它。
function openMenu(anchor,rel,isDir){
 const m=$id('lib-menu'),tag=tagOf(rel); // 目录与文件一样可以署名
 const n=selSet.size,multi=n>1;
 const items=[];
 if(multi)items.push(`<div class="lib-menu-note">已选中 ${n} 项，复制 / 剪切作用于整组</div>`);
 items.push(`<button data-act="copy">复制${multi?` ${n} 项`:''}<kbd>${combo('C')}</kbd></button>`,
  `<button data-act="cut">剪切${multi?` ${n} 项`:''}<kbd>${combo('X')}</kbd></button>`);
 if(isDir)items.push(`<button data-act="paste"${clip.items.length?'':' disabled'}>粘贴到此目录<kbd>${combo('V')}</kbd></button>`);
 items.push('<div class="lib-menu-sep"></div>');
 items.push(`<button data-act="download">${isDir?'下载文件夹（zip）':'下载'}<kbd>${combo('S')}</kbd></button>`);
 items.push('<button data-act="rename">重命名</button>','<button data-act="move">移动到…</button>');
 items.push('<div class="lib-menu-sep"></div>');
 if(tag)items.push(`<div class="lib-menu-note">已署名「${esc(tag)}」，不可修改</div>`);
 else items.push(`<div class="lib-menu-note">${isDir?'给这个目录署名':'贴署名'}（选定后不可修改）</div>`,
  ...(data.tags||[]).map(t=>`<button data-act="tag" data-tag="${esc(t.label)}">署名 ${esc(t.label)}</button>`));
 paintMenu(m,items,anchor);
 menuTarget=rel;
 m.querySelectorAll('button[data-act]').forEach(b=>b.onclick=async()=>{
  if(b.disabled)return;
  m.hidden=true;const act=b.dataset.act;
  if(act==='copy')setClip('copy');
  else if(act==='cut')setClip('cut');
  else if(act==='paste')doPaste(rel);
  else if(act==='download')downloadSelected();
  else if(act==='rename')askRename(rel,isDir);
  else if(act==='move')askMove(rel);
  else if(act==='tag'){
   try{await post('/api/library/tag',{path:rel,tag:b.dataset.tag});toast(`已署名 ${b.dataset.tag}`);await reload();}
   catch(e){toast(e.message);}
  }
 });
 }
// 列表空白处右键：粘贴到当前目录 / 全选 / 取消选择
function openBlankMenu(x,y){
 const m=$id('lib-menu'),tgt=pasteTarget(),canPaste=clip.items.length>0&&tgt!==null;
 const inDir=!cwdIsRoot();
 const pasteBtn=canPaste
  ? `<button data-act="paste">${tgt?`粘贴到「${esc(tgt)}」`:'粘贴'}（${clip.items.length} 项）<kbd>${combo('V')}</kbd></button>`
  : `<button data-act="paste" disabled>${tgt?`粘贴到「${esc(tgt)}」`:'粘贴（先进入一个文件夹）'} <kbd>${combo('V')}</kbd></button>`;
 const items=[];
 if(inDir)items.push(`<button data-act="dl-dir">下载当前文件夹（zip）</button>`,'<div class="lib-menu-sep"></div>');
 items.push(pasteBtn,'<div class="lib-menu-sep"></div>',
  `<button data-act="selall">全选<kbd>${combo('A')}</kbd></button>`,
  `<button data-act="selnone"${selSet.size?'':' disabled'}>取消选择<kbd>Esc</kbd></button>`);
 paintMenu(m,items,{x,y});
 m.querySelectorAll('button[data-act]').forEach(b=>b.onclick=()=>{
  if(b.disabled)return;
  m.hidden=true;
  if(b.dataset.act==='paste')doPaste();
  else if(b.dataset.act==='dl-dir')downloadGit([{path:pane,name:pane.split('/').pop()}]);
  else if(b.dataset.act==='selall')selectAllRows();
  else if(b.dataset.act==='selnone'){clearSel();refreshSelUI();}
 });
}
// ---- 下载：同步 / 异步两条通道，按「谁掏带宽」选路 ----
// 2026-10-20 实测：本站出口 0.68 MB/s（6 Mbps 打满），往 COS 传也是 0.66 MB/s，
// COS 直连 6.27 MB/s（≈52 Mbps）。所以：
//   · 云端大文件 → 签名直链，浏览器直连 COS，不碰本站带宽；
//   · 仓库里的小文件 → 本站直接吐；
//   · 文件夹 / 多选 → 按体积分流：小包直接下，大包走「后台打包 → 传云 → 给直链」。
//     异步第一次要多花一趟上传，但同一份内容 7 天内再下是秒级（服务端按内容指纹复用）。
const DL_SPEED={server:0.68,cos:6.3,up:0.66}; // MB/s，仅用于估算
const DL_ASYNC_MB=8; // 超过这个体积默认走云端打包
const fmtDur=s=>!s||s<1?'不到 1 秒':s<60?`约 ${Math.ceil(s)} 秒`:s<3600?`约 ${Math.round(s/60)} 分钟`:`约 ${(s/3600).toFixed(1)} 小时`;
const isDirPath=p=>(data.entries||[]).some(e=>e.path===p&&e.type==='dir');
const jobLive=j=>['queued','packing','uploading'].includes(j.status);
const jobText=j=>({queued:'排队中',packing:'正在打包…',uploading:'正在上传到云存储…',ready:'已完成',error:'失败'})[j.status]||j.status;
let previewCur=null,dlOk=null,dlJobId=null,dlTimer=null,panelTimer=null,jobCache=[];

function dlClose(){
 if(dlTimer){clearInterval(dlTimer);dlTimer=null;}
 if(panelTimer){clearTimeout(panelTimer);panelTimer=null;}
 dlJobId=null;dlOk=null;$id('lib-dlbox').hidden=true;
}
function showDl(title,html,{okText='',ok=null,cancel='取消'}={}){
 $id('lib-dl-title').textContent=title;
 $id('lib-dl-body').innerHTML=html;
 const b=$id('lib-dl-ok');
 b.textContent=okText;b.hidden=!okText;
 $id('lib-dl-cancel').textContent=cancel;
 dlOk=ok;
 $id('lib-dlbox').hidden=false;
}

function downloadCos(items){ // 云端：直连 COS；多选时逐个触发，间隔 600ms 免得被浏览器判成弹窗拦截
 const mb=items.reduce((s,i)=>s+(Number(i.size_mb)||0),0);
 const list=items.filter(i=>i.key);
 if(!list.length){toast('这条记录没有云端定位信息。');return;}
 toast(mb?`正在从云端直连下载 ${list.length} 个文件（${mb.toFixed(1)} MB，约 ${fmtDur(mb/DL_SPEED.cos)}）`:`正在从云端直连下载 ${list.length} 个文件`);
 (async()=>{
  for(const it of list){
   try{
    const r=await fetch('/api/library/cos?dl=1&key='+encodeURIComponent(it.key));
    const d=await r.json().catch(()=>({}));
    if(!r.ok)throw Error(d.error||'取下载链接失败');
    const a=document.createElement('a');
    a.href=d.url;a.download=d.name||it.name||'';a.rel='noopener';
    document.body.appendChild(a);a.click();a.remove();
    if(list.length>1)await new Promise(z=>setTimeout(z,600));
   }catch(e){toast(e.message);return;}
  }
 })();
}

function downloadGit(items){
 if(!items.length)return;
 if(items.length===1&&!isDirPath(items[0].path)){
  const it=items[0],size=Number(it.size)||0;
  toast(`开始下载 ${it.name}${size?`（${fmtSize(size)}，本站通道约 ${fmtDur(size/1048576/DL_SPEED.server)}）`:''}`);
  location.href='/api/library/download?path='+encodeURIComponent(it.path);
  return;
 }
 planZip(items);
}

async function planZip(items){ // 先问服务端要体积预估，再让人选「直接下」还是「云端打包」
 const qs=items.map(i=>'path='+encodeURIComponent(i.path)).join('&');
 const paths=items.map(i=>i.path);
 let plan;
 try{
  const r=await fetch('/api/library/zip?'+qs+'&plan=1');
  plan=await r.json().catch(()=>({}));
  if(!r.ok)throw Error(plan.error||'无法打包');
 }catch(e){toast(e.message);return;}
 const dirs=items.filter(i=>isDirPath(i.path)).length,files=items.length-dirs;
 const mb=plan.bytes/1048576;
 const direct=mb/DL_SPEED.server, first=mb/DL_SPEED.up+mb/DL_SPEED.cos, again=mb/DL_SPEED.cos;
 const pick=mb>=DL_ASYNC_MB?'cloud':'direct';
 showDl('下载',
  `<div class="lib-dl-row"><span>范围</span><b>${[dirs?`${dirs} 个文件夹`:'',files?`${files} 个文件`:''].filter(Boolean).join(' + ')}</b></div>`+
  `<div class="lib-dl-row"><span>包内文件</span><b>${plan.files} 个${plan.dirs?`（含 ${plan.dirs} 个空目录）`:''}</b></div>`+
  `<div class="lib-dl-row"><span>打包体积</span><b>约 ${fmtSize(plan.bytes)}</b></div>`+
  `<div class="lib-dl-mode" id="lib-dl-mode">`+
   `<label class="lib-dl-opt${pick==='direct'?' on':''}" data-mode="direct"><input type="radio" name="lib-dlmode" value="direct"${pick==='direct'?' checked':''}>`+
    `<span><b>直接下载</b><small>边打包边传，本站实测 ${DL_SPEED.server} MB/s · ${fmtDur(direct)}</small></span></label>`+
   `<label class="lib-dl-opt${pick==='cloud'?' on':''}" data-mode="cloud"><input type="radio" name="lib-dlmode" value="cloud"${pick==='cloud'?' checked':''}>`+
    `<span><b>云端打包，给直链${pick==='cloud'?'（推荐）':''}</b><small>后台打包并上传，首次 ${fmtDur(first)}（含上传）；之后同内容 ${fmtDur(again)} · 7 天内可复用</small></span></label>`+
  `</div>`+
  `<p class="lib-hint">云端直连实测 ${DL_SPEED.cos} MB/s，本站出口只有 ${DL_SPEED.server} MB/s。上传同样吃本站出口，所以第一次会比「直接下载」慢一点，换来的是再下秒开、且不占本站带宽。云端大文件不打进包，单独下载走 COS 直链。</p>`,
  {okText:'开始下载',ok:()=>{
   const mode=document.querySelector('input[name="lib-dlmode"]:checked')?.value||'direct';
   if(mode==='cloud')startJob(paths);else startZip(qs,plan);
  }});
 $id('lib-dl-mode').querySelectorAll('.lib-dl-opt').forEach(el=>el.onclick=()=>{
  $id('lib-dl-mode').querySelectorAll('.lib-dl-opt').forEach(x=>x.classList.toggle('on',x===el));
  const r=el.querySelector('input');if(r)r.checked=true;
 });
}

// ---- 异步打包任务：打包 → 传 COS → 给直链 ----
async function startJob(paths){
 showDl('云端打包',`<div class="lib-dl-pline">正在提交任务…</div><p class="lib-hint">打包与上传在服务端进行，可以关掉这个窗口，稍后从工具条的「已打包」回来取链接。</p>`,{cancel:'关闭'});
 try{
  const r=await fetch('/api/library/zipjob',{method:'POST',headers:{'Content-Type':'application/json','X-CSRF-Token':csrf},body:JSON.stringify({paths})});
  const d=await r.json().catch(()=>({}));
  if(!r.ok)throw Error(d.error||'无法创建任务');
  dlJobId=d.job.id;
  paintJob(d.job);
  if(d.hit)toast(d.job.status==='ready'?'这份内容之前已经打过包，直接复用云端链接。':'这份内容已经在打包队列里，接着等它跑完就行。');
  if(jobLive(d.job))pollJob();
  refreshJobChip();
 }catch(e){
  showDl('打包失败',`<p class="lib-hint">${esc(e.message)}</p>`,{cancel:'关闭'});
 }
}

function paintJob(j){
 if(!dlJobId)return;
 const live=jobLive(j),pct=Math.max(2,Math.min(100,j.pct||0));
 let extra='';
 if(j.status==='ready'){
  const until=new Date(j.expiresAt||Date.now()).toLocaleDateString('zh-CN');
  extra=`<div class="lib-dl-row"><span>云端文件</span><b>${fmtSize(j.size)} · 链接有效至 ${until}</b></div>`+
   `<div class="lib-dl-actions"><a class="button primary" href="${esc(j.url)}" download="${esc(j.name)}" rel="noopener">⬇ 立即下载</a><button class="button secondary" id="lib-dl-copy">复制直链</button></div>`+
   `<p class="lib-hint">浏览器直连 COS（实测 ${DL_SPEED.cos} MB/s），不占本站带宽。同一份内容 7 天内再下不必重打。</p>`;
 }else if(j.status==='error'){
  extra=`<p class="lib-hint">${esc(j.error||'任务失败')}　可以重选「直接下载」。</p>`;
 }
 const line=live||j.status==='ready'
  ?`<div class="lib-dl-progress"><div class="lib-dl-bar" style="width:${pct}%"></div></div>`+
   `<div class="lib-dl-pline">${jobText(j)}${j.status==='packing'?` · 已打 ${fmtSize(j.packed)} / ${fmtSize(j.bytes)}`:''}${j.status==='uploading'?` · 已传 ${fmtSize(j.uploaded)} / ${fmtSize(j.bytes)}`:''}</div>`
  :`<div class="lib-dl-pline">${jobText(j)}</div>`;
 showDl(j.status==='ready'?'云端打包 · 已就绪':'云端打包',
  `<div class="lib-dl-row"><span>范围</span><b>${esc(j.name)}</b></div>`+
  `<div class="lib-dl-row"><span>包内文件</span><b>${j.files} 个${j.dirs?`（含 ${j.dirs} 个空目录）`:''}</b></div>`+
  `<div class="lib-dl-row"><span>打包体积</span><b>约 ${fmtSize(j.bytes)}</b></div>`+line+extra,
  {cancel:'关闭'});
 const cp=$id('lib-dl-copy');
 if(cp)cp.onclick=async()=>{try{await navigator.clipboard.writeText(j.url);toast('直链已复制，7 天内有效。');}catch{toast('复制失败，请手动选中链接。');}};
}

function pollJob(){
 if(dlTimer)clearInterval(dlTimer);
 dlTimer=setInterval(async()=>{
  if(!dlJobId)return;
  try{
   const r=await fetch('/api/library/zipjob?id='+encodeURIComponent(dlJobId));
   const j=await r.json().catch(()=>({}));
   if(!r.ok)throw Error(j.error||'任务已失效');
   paintJob(j);
   if(!jobLive(j)){
    clearInterval(dlTimer);dlTimer=null;
    refreshJobChip();
    if(j.status==='ready')toast('打包完成，可以下载了。');
   }
  }catch(e){clearInterval(dlTimer);dlTimer=null;toast(e.message);}
 },900);
}

async function openJobs(){ // 工具条「已打包」：刷新页面后也能找回打好的包
 let jobs=[];
 try{const r=await fetch('/api/library/zipjobs');jobs=(await r.json()).jobs||[];}
 catch{toast('取任务列表失败。');return;}
 if(!jobs.length){toast('还没有后台打包任务。');refreshJobChip();return;}
 const rows=jobs.map(j=>{
  const live=jobLive(j),act=j.status==='ready'
   ?`<a class="button secondary" href="${esc(j.url)}" download="${esc(j.name)}" rel="noopener">⬇ 下载</a>`
   :live?`<span class="lib-dl-wait">进行中 ${j.pct}%</span>`
   :`<span class="lib-dl-fail">失败</span>`;
  const sub=j.status==='ready'?`${fmtSize(j.size)} · 有效至 ${new Date(j.expiresAt).toLocaleDateString('zh-CN')}`
   :live?jobText(j):`${jobText(j)} · ${(j.error||'未知错误').slice(0,48)}`;
  return `<div class="lib-dl-job"><div class="lib-dl-jobmain"><b>${esc(j.name)}</b><small title="${esc(j.error||'')}">${esc(sub)}</small></div><div class="lib-dl-jobact">${act}</div></div>`;
 }).join('');
 showDl('后台打包任务',`<div class="lib-dl-jobs-list">${rows}</div><p class="lib-hint">任务在服务端跑，关掉页面也会继续；直链 7 天内有效，同一份内容再下不会重打。</p>`,{cancel:'关闭'});
 if(panelTimer){clearTimeout(panelTimer);panelTimer=null;}
 if(jobs.some(jobLive))panelTimer=setTimeout(()=>{if(!$id('lib-dlbox').hidden)openJobs();},1500);
}

async function refreshJobChip(){
 const btn=$id('lib-jobs');if(!btn)return;
 try{const r=await fetch('/api/library/zipjobs');jobCache=(await r.json()).jobs||[];}catch{return;}
 const live=jobCache.filter(jobLive).length,ready=jobCache.filter(j=>j.status==='ready').length;
 btn.hidden=!live&&!ready;
 btn.textContent=live?`⏳ 打包中 ${live}`:`⬇ 已打包 ${ready}`;
 btn.title=live?'后台打包进行中，点开看进度':'云端已打好包，点开取直链（7 天内有效）';
}

async function startZip(qs,plan){
 const prog=$id('lib-progress'),bar=$id('lib-progress-bar'),text=$id('lib-progress-text');
 const total=Number(plan.bytes)||0,url='/api/library/zip?'+qs;
 if(total>80*1048576){ // 超过 80MB 不往内存里堆，交给浏览器原生下载（有下载栏进度）
  location.href=url;
  toast(`${plan.name} 已交给浏览器下载（${fmtSize(total)}，${fmtDur(plan.est.seconds)}），进度见下载栏。`);
  return;
 }
 prog.hidden=false;bar.style.width='0%';text.textContent='正在打包…';
 const t0=performance.now();let got=0;
 try{
  const r=await fetch(url);
  if(!r.ok){const d=await r.json().catch(()=>({}));throw Error(d.error||'打包失败');}
  const reader=r.body.getReader(),chunks=[];
  for(;;){
   const{done,value}=await reader.read();
   if(done)break;
   chunks.push(value);got+=value.length;
   const pct=total?Math.min(99,Math.round(got/total*100)):99;
   bar.style.width=pct+'%';
   text.textContent=`打包下载 ${pct}% · ${fmtSize(got)} / ${fmtSize(total||got)} · ${(got/1048576/((performance.now()-t0)/1000)).toFixed(2)} MB/s`;
  }
  const blob=new Blob(chunks,{type:'application/zip'});
  const a=document.createElement('a');
  a.href=URL.createObjectURL(blob);a.download=plan.name;
  document.body.appendChild(a);a.click();a.remove();
  setTimeout(()=>URL.revokeObjectURL(a.href),120000);
  bar.style.width='100%';text.textContent=`${plan.name} · ${fmtSize(got)} · 完成`;
  toast(`已下载 ${plan.name}（${plan.files} 个文件，${fmtSize(got)}）`);
 }catch(e){toast(e.message);}
 finally{setTimeout(()=>{prog.hidden=true;},2000);}
}

const downloadSelected=()=>downloadGit([...selSet].map(p=>({path:p,name:p.split('/').pop(),size:(allFiles().find(f=>f.path===p)||{}).size})));
$id('lib-dl-ok').onclick=()=>{const fn=dlOk;dlOk=null;$id('lib-dlbox').hidden=true;if(fn)fn();};
$id('lib-dl-cancel').onclick=()=>dlClose();
$id('lib-dlbox').onclick=e=>{if(e.target.id==='lib-dlbox')dlClose();};

// 云端行（☁）的菜单：只给「下载 / 预览」，不进剪贴板（对象不在仓库里）
function openCosMenu(anchor,key){
 const m=$id('lib-menu'),e=(data.cos||[]).find(c=>c.key===key)||{};
 const mb=Number(e.size_mb)||0;
 paintMenu(m,[
  `<div class="lib-menu-note">${esc(e.name||key)}${mb?` · ${esc(e.size_mb)} MB · 直连${fmtDur(mb/DL_SPEED.cos)}`:' · 云端直连，不计入本站带宽'}</div>`,
  '<button data-act="dl">下载到本机</button>',
  '<button data-act="preview">站内预览</button>',
 ],anchor);
 m.querySelectorAll('button[data-act]').forEach(b=>b.onclick=()=>{
  m.hidden=true;
  if(b.dataset.act==='dl')downloadCos([{key,name:e.name,size_mb:e.size_mb}]);
  else previewCos(key);
 });
}
function paintMenu(m,items,anchor){
 m.innerHTML=items.join('');
 m.hidden=false;
 const w=m.offsetWidth,h=m.offsetHeight;
 if(anchor.x!==undefined){ // 右键：贴着鼠标，但不越出视口
  m.style.top=Math.max(8,Math.min(anchor.y,window.innerHeight-h-12))+'px';
  m.style.left=Math.max(8,Math.min(anchor.x,window.innerWidth-w-12))+'px';
 }else{
  const r=anchor.getBoundingClientRect();
  m.style.top=Math.max(8,Math.min(r.bottom+6,window.innerHeight-h-12))+'px';
  m.style.left=Math.max(12,Math.min(r.right-w,window.innerWidth-w-12))+'px';
 }
}
 document.addEventListener('click',e=>{
  const m=$id('lib-menu');
  if(m&&!m.hidden&&!m.contains(e.target)&&!e.target.classList.contains('lib-more'))m.hidden=true;
 });
let promptOk=null;
function askText(title,label,value,hint,ok,opts={}){
 $id('lib-prompt-title').textContent=title;
 $id('lib-prompt-label').textContent=label;
 $id('lib-prompt-input').value=value||'';
 $id('lib-prompt-hint').textContent=hint||'';
 const loc=$id('lib-prompt-loc'),wrap=$id('lib-prompt-loc-wrap');
 const list=opts.locations||[];
 if(list.length){ // 「创建位置」下拉：库根 + 各一级目录 + 当前目录
  loc.innerHTML=list.map(o=>`<option value="${esc(o.value)}">${esc(o.label)}</option>`).join('');
  loc.value=list.some(o=>o.value===opts.locValue)?opts.locValue:list[0].value;
  wrap.hidden=false;
 }else{wrap.hidden=true;loc.innerHTML='';}
 $id('lib-prompt').hidden=false;promptOk=ok;
 setTimeout(()=>{$id('lib-prompt-input').focus();$id('lib-prompt-input').select?.();},30);
}
$id('lib-prompt-cancel').onclick=()=>{$id('lib-prompt').hidden=true;promptOk=null;};
$id('lib-prompt').onclick=e=>{if(e.target.id==='lib-prompt')$id('lib-prompt-cancel').click();};
$id('lib-prompt-ok').onclick=async()=>{
 const v=$id('lib-prompt-input').value.trim();if(!promptOk)return;
 const loc=$id('lib-prompt-loc-wrap').hidden?'':$id('lib-prompt-loc').value;
 const fn=promptOk;promptOk=null;$id('lib-prompt').hidden=true;await fn(v,loc);
};
 $id('lib-prompt-input').onkeydown=e=>{if(e.key==='Enter')$id('lib-prompt-ok').click();if(e.key==='Escape')$id('lib-prompt-cancel').click();};
// 新建文件夹：位置可选 —— 「库根目录」= 新建一个一级目录，其余选项建在所选目录（含当前所在目录）里。
$id('lib-mkdir').onclick=()=>{
 const roots=data.roots?.length?data.roots:[];
 const inDir=!cwdIsRoot();
 const locs=[{value:'',label:'库根目录（新建一级目录）'},...roots.map(r=>({value:r,label:'　'+(ROOT_LABEL[r]||r)}))];
 if(inDir&&!roots.includes(pane))locs.push({value:pane,label:'　当前目录：'+pane});
 askText('新建文件夹','文件夹名称','','选「库根目录」会在库根新建一个一级目录；选其他项则建在该目录里。',
  async(name,loc)=>{
   if(!name)return;
   if(name.includes('/')){toast('名称里不能带「/」；要建子目录，先在左侧选中它的上级目录。');return;}
   const rel=loc?`${loc}/${name}`:name;
   try{const d=await post('/api/library/mkdir',{path:rel});
    const parent=parentOf(d.path);
    pane=parent||d.path; // 库里没有「根」的列表视图，建在根时直接进新目录，否则留在原处高亮
    expanded.add(d.path);
    if(parent)expanded.add(parent);
    fresh=new Set([d.path]);
    await reload();toast((parent?'已新建文件夹 ':'已新建一级目录 ')+d.path);
    $id('lib-list').querySelector('.is-new')?.scrollIntoView({block:'nearest',behavior:'smooth'});}
   catch(e){toast(e.message);}
  },{locations:locs,locValue:inDir?pane:''});
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
 askText('移动到','目标目录（可填子路径）',parentOf(rel)||'knowledge','留空不改；可填一级目录（projects、knowledge、workflows、media 或自建的一级目录），也可填子路径，如 knowledge/产品',async to=>{
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
   closePreview();renderMain();
  });
 }
 // ---- 预览（Finder 第三栏：宽屏常驻右栏，窄屏回落为覆盖层） ----
 const layout=$id('lib-layout');
const openPreview=()=>{$id('lib-preview').hidden=false;layout.classList.add('has-preview');};
const closePreview=()=>{$id('lib-preview').hidden=true;layout.classList.remove('has-preview');layout.classList.remove('is-media');setPreviewOpen('');setPreviewDownload(null);};
// 头部「新窗口打开」只在拿到可打开的链接时才出现（云端文件才有）
function setPreviewOpen(u){
 const a=$id('lib-preview-open');
 if(u){a.href=u;a.hidden=false;}else{a.removeAttribute('href');a.hidden=true;}
}
// 预览面板的「下载」：文件直下 / 云端走直链；目录不进预览，所以这里只有文件
function setPreviewDownload(cur){
 previewCur=cur||null;
 const b=$id('lib-preview-dl');
 if(!cur){b.hidden=true;return;}
 b.hidden=false;
 b.textContent=cur.kind==='cos'?'⬇ 下载（云端直连）':(cur.isDir?'⬇ 打包下载':'⬇ 下载');
}
$id('lib-preview-dl').onclick=()=>{
 if(!previewCur)return;
 if(previewCur.kind==='cos')downloadCos([previewCur]);
 else downloadGit([previewCur]);
};
async function preview(rel){
 const name=rel.split('/').pop(),k=kindOf(name);
 setPreviewOpen('');
 setPreviewDownload({kind:'git',path:rel,name,size:(allFiles().find(x=>x.path===rel)||{}).size});
 layout.classList.toggle('is-media',k==='image'); // 图片放宽预览栏，视频/PDF 在各自分支里设置
  $id('lib-preview-name').textContent=name;
  $id('lib-preview-meta').textContent=`${rel}　·　${data.meta[rel]?.author?authorName(data.meta[rel].author)+'　·　':''}${data.meta[rel]?.date||''}`;
  const body=$id('lib-preview-body');body.innerHTML='加载中…';openPreview();
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
// ---- 云端（COS）文件预览：视频/音频/图片/PDF 直接内联，其他给「新窗口打开」 ----
const COS_VIDEO=['.mp4','.m4v','.mov','.webm','.mkv','.avi'];
const COS_AUDIO=['.mp3','.m4a','.wav','.aac','.ogg'];
const COS_IMAGE=['.png','.jpg','.jpeg','.gif','.webp','.bmp','.heic'];
const extOf=n=>('.'+String(n||'').split('.').pop()).toLowerCase();
async function previewCos(key){
 const e=(data.cos||[]).find(c=>c.key===key)||{};
 const name=e.name||decodeURIComponent(String(key).split('/').pop()||'云端文件');
 const ext=extOf(name);
 $id('lib-preview-name').textContent=name;
 $id('lib-preview-meta').textContent=['云端 COS　·　'+(e.date||''),e.author?authorName(e.author):'',e.size_mb&&e.size_mb!=='0.0'?e.size_mb+' MB':''].filter(Boolean).join('　·　');
 setPreviewDownload({kind:'cos',key,name,size_mb:e.size_mb});
 const body=$id('lib-preview-body');body.innerHTML='正在取云端链接…';openPreview();
 try{
  const r=await fetch('/api/library/cos?key='+encodeURIComponent(key));
  const d=await r.json().catch(()=>({}));
  if(!r.ok)throw Error(d.error||'取云端链接失败');
  setPreviewOpen(d.url);
  layout.classList.toggle('is-media',COS_VIDEO.includes(ext)||COS_IMAGE.includes(ext)||ext==='.pdf');
  if(COS_VIDEO.includes(ext))body.innerHTML=`<video class="lib-video" controls playsinline preload="metadata" src="${esc(d.url)}"></video>`;
  else if(COS_AUDIO.includes(ext))body.innerHTML=`<audio class="lib-audio" controls src="${esc(d.url)}"></audio>`;
  else if(COS_IMAGE.includes(ext))body.innerHTML=`<img class="lib-image" src="${esc(d.url)}" alt="${esc(name)}">`;
  else if(ext==='.pdf')body.innerHTML=`<iframe class="lib-frame" src="${esc(d.url)}" title="${esc(name)}"></iframe>`;
  else body.innerHTML='<div class="lib-empty">这个类型不便于内联预览。<br><span class="lib-hint">链接已生成，点右上角「新窗口打开 ↗」即可。</span></div>';
 }catch(err){body.innerHTML=`<div class="lib-empty">${esc(err.message)}</div>`;}
}
$id('lib-preview-close').onclick=closePreview;
$id('lib-preview').onclick=e=>{if(e.target.id==='lib-preview')closePreview();};

// ---- 上传（文件 + 文件夹：保留目录层级，空目录也建） ----
const MAX_FILES=200;   // 与后端上限一致
const MAX_DIRS=2000;
const relOfFile=f=>(f.webkitRelativePath||'').replace(/\\/g,'/')||f.name; // 目录选择器会给 webkitRelativePath
async function walkEntry(entry,prefix,files,dirs,depth=0){ // 拖入目录时浏览器只给 entry 句柄，必须递归展开
 if(entry.isFile){
  const file=await new Promise(res=>entry.file(res,()=>res(null)));
  if(file)files.push({file,rel:prefix+entry.name});
  return;
 }
 if(depth>8)return; // 防止异常嵌套把浏览器拖死
 const reader=entry.createReader(),kids=[];
 for(;;){
  const batch=await new Promise(res=>reader.readEntries(res,()=>res([])));
  if(!batch.length)break;
  kids.push(...batch);
 }
 const self=prefix+entry.name;
 if(!kids.length){dirs.push(self);return;} // 空目录不会产生文件条目，单独登记
 for(const k of kids)await walkEntry(k,self+'/',files,dirs,depth+1);
}
async function collectFromDrop(dt){
 const roots=(dt.items?[...dt.items]:[]).map(it=>it.webkitGetAsEntry?.()).filter(Boolean); // 必须同步取，事件结束后句柄失效
 if(!roots.length)return{files:[...dt.files].map(f=>({file:f,rel:f.name})),dirs:[]};
 const files=[],dirs=[];
 for(const r of roots)await walkEntry(r,'',files,dirs);
 return{files,dirs};
}
function upload(entries,dirs){
 if(!entries.length&&!dirs.length){toast('没有可上传的内容。');return;}
 const overflow=Math.max(0,entries.length-MAX_FILES);
 if(overflow)entries=entries.slice(0,MAX_FILES);
 if(cwdIsRoot())pane='knowledge'; // 总览视角下上传，默认进知识库并跳过去，方便立刻看到结果
 const target=pane.startsWith('@')||pane==='all'||pane==='recent'?'knowledge':pane;
 const fd=new FormData();
 fd.append('path',target);
 fd.append('tag',$id('lib-sign')?.value||''); // 署名标签（空 = 不署名）
 if(dirs.length)fd.append('dirs',dirs.slice(0,MAX_DIRS).join('\n'));
 for(const e of entries)fd.append('files',e.file,e.rel||e.file.name); // 第三个参数是 multipart 里的 filename，目录层级就靠它带过去
 const xhr=new XMLHttpRequest();
 const prog=$id('lib-progress'),bar=$id('lib-progress-bar'),text=$id('lib-progress-text');
 prog.hidden=false;bar.style.width='0%';
 text.textContent=`上传 ${entries.length} 个文件${dirs.length?` + ${dirs.length} 个空文件夹`:''}…`;
 xhr.upload.onprogress=e=>{if(e.lengthComputable)bar.style.width=Math.round(e.loaded/e.total*100)+'%';};
 xhr.onload=async()=>{
  prog.hidden=true;
  let res;try{res=JSON.parse(xhr.responseText);}catch{res={error:'服务返回异常。'};}
  if(xhr.status!==200){toast(res.error||'上传失败，请稍后重试。');return;}
  fresh=new Set(res.results.map(r=>r.path||r.name));
  pane=target;
  await reload();
  const cnt=k=>res.results.filter(r=>r.route===k).length;
  const parts=[];
  if(cnt('dir'))parts.push(`${cnt('dir')} 个文件夹`);
  if(cnt('git'))parts.push(`${cnt('git')} 个文件入 Gitee`);
  if(cnt('cos'))parts.push(`${cnt('cos')} 个大文件入云端`);
  toast(`入库完成（署名 ${res.tag||'不署名'}）：${parts.join(' + ')||'无变化'}${res.skipped?`；跳过 ${res.skipped} 个隐藏项（. 或 _ 开头）`:''}${overflow?`；超出 ${MAX_FILES} 个上限，跳过 ${overflow} 个`:''}`);
  $id('lib-list').querySelector('.is-new')?.scrollIntoView({block:'nearest',behavior:'smooth'});
 };
 xhr.onerror=()=>{prog.hidden=true;toast('网络请求失败，请稍后重试。');};
 xhr.open('POST','/api/upload');
 xhr.setRequestHeader('X-CSRF-Token',csrf);
 xhr.send(fd);
}
const cwdIsRoot=()=>['all','recent','@cos'].includes(pane)||pane.startsWith('@');
$id('lib-upload-btn').onclick=()=>$id('lib-file-input').click();
$id('lib-dir-btn').onclick=()=>$id('lib-dir-input').click();
$id('lib-file-input').onchange=e=>{upload([...e.target.files].map(f=>({file:f,rel:f.name})),[]);e.target.value='';};
$id('lib-dir-input').onchange=e=>{upload([...e.target.files].map(f=>({file:f,rel:relOfFile(f)})),[]);e.target.value='';};
$id('lib-refresh').onclick=()=>reload().then(()=>toast('已刷新。'));
$id('lib-dl').onclick=()=>downloadSelected();
$id('lib-jobs').onclick=()=>openJobs();
$id('lib-copy').onclick=()=>setClip('copy');
$id('lib-cut').onclick=()=>setClip('cut');
$id('lib-paste').onclick=()=>doPaste();
$id('lib-list').addEventListener('contextmenu',e=>{ // 空白处右键：粘贴 / 全选 / 取消选择
 if(e.target.closest('.lib-row'))return;
 e.preventDefault();
 openBlankMenu(e.clientX,e.clientY);
});
// 键盘快捷键：与系统一致（Mac 用 ⌘，Windows / Linux 用 Ctrl）。只在库页可见、焦点不在输入框时接管。
window.addEventListener('keydown',e=>{
 const page=$id('library');
 if(!page||page.hidden||location.hash!=='#library')return;
 const menu=$id('lib-menu'),prompt=$id('lib-prompt');
 const box=$id('lib-dlbox');
 if(!prompt.hidden||!menu.hidden||!box.hidden){ // 弹窗/菜单开着时不抢键，只让 Esc 收摊
  if(e.key==='Escape'){prompt.hidden=true;menu.hidden=true;dlClose();promptOk=null;}
  return;
 }
 const a=document.activeElement,tag=a?.tagName;
 if(tag==='INPUT'||tag==='TEXTAREA'||tag==='SELECT'||a?.isContentEditable)return;
 if(e.altKey||e.shiftKey)return;
 const mod=IS_MAC?e.metaKey:e.ctrlKey,k=e.key.toLowerCase();
 if(mod){
  if(k==='c'||k==='x'){
   if(window.getSelection?.()?.toString())return; // 用户真的选中了文本，让浏览器复制文本
   e.preventDefault();setClip(k==='c'?'copy':'cut');
  }else if(k==='v'){e.preventDefault();doPaste();}
  else if(k==='a'){e.preventDefault();selectAllRows();}
  else if(k==='s'){ // 保存 = 下载：有选中下选中，否则下当前文件夹
   e.preventDefault();
   if(selSet.size)downloadSelected();
   else if(!cwdIsRoot())downloadGit([{path:pane,name:pane.split('/').pop()}]);
   else toast('先选中要下载的文件或文件夹，或进入一个目录。');
  }
  return;
 }
 if(e.key==='Escape'){clearSel();refreshSelUI();closePreview();}
});
const drop=$id('lib-drop');
['dragenter','dragover'].forEach(ev=>drop.addEventListener(ev,e=>{e.preventDefault();drop.classList.add('over');}));
['dragleave','drop'].forEach(ev=>drop.addEventListener(ev,e=>{e.preventDefault();drop.classList.remove('over');}));
drop.addEventListener('drop',async e=>{
 e.preventDefault();
 try{const{files,dirs}=await collectFromDrop(e.dataTransfer);upload(files,dirs);}
 catch{toast('读取拖入内容失败，请改用「上传文件夹」按钮。');}
});
 $id('lib-search').oninput=e=>{query=e.target.value.trim().toLowerCase();renderMain();};
 $id('lib-toggle').querySelectorAll('button').forEach(b=>b.onclick=()=>{
  view=b.dataset.view;
  $id('lib-toggle').querySelectorAll('button').forEach(x=>x.classList.toggle('active',x===b));
  renderMain();
 });

 window.addEventListener('hashchange',()=>{if(location.hash==='#library')reload();});
 document.addEventListener('workroom:directory',()=>{ // 登记条目异步到位后，同步左栏计数与分组视图
  if(!$id('lib-tree'))return;
  renderTree();
  if(pane.startsWith('@entries:'))renderMain();
 });
  reload();
refreshJobChip(); // 有后台任务 / 已打好的包时，工具条上出「打包中 / 已打包」入口
setInterval(()=>{ // 只在库页可见时轻量轮询：跑着的任务刷进度，跑完了入口自动出现
 if($id('library')&&!$id('library').hidden&&document.visibilityState==='visible')refreshJobChip();
},15000);
 // route() 在本文件挂载前已跑过一次，那时 #library 页还不存在；
 // 直接用 #library 打开（刷新 / 收藏链接）时要补跑一次，否则页面停在 hidden。
 if(location.hash==='#library')route();
})();
