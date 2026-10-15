// 「库」页面：Finder 式公司资产仓库（左树右表 + 拖拽入库 + 轻预览 + 搜索）。
// 数据来自 library 服务（Gitee 克隆仓目录 + media/manifest.yaml 里的 COS 条目合并视图）。
(()=>{
 const api=window.Workroom?.api,csrf=window.Workroom?.csrf;
 if(!api)return; // 未登录不挂载
 pageNames.library='库';
 const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
 const toast=m=>{const t=$('toast');if(t){t.textContent=m;t.classList.add('show');clearTimeout(t._tm);t._tm=setTimeout(()=>t.classList.remove('show'),3500);}};
 const fmtSize=n=>n>=1048576?(n/1048576).toFixed(1)+' MB':n>=1024?(n/1024).toFixed(0)+' KB':n+' B';
 const kindOf=name=>{const e=(name.match(/\.[^.]+$/)||[''])[0].toLowerCase();
  if(['.mp4','.mov','.avi','.mkv','.webm','.m4v'].includes(e))return'video';
  if(['.png','.jpg','.jpeg','.gif','.webp','.svg'].includes(e))return'image';
  if(['.md','.markdown','.txt'].includes(e))return'doc';
  return'file';};
 const ICON={dir:'▸',doc:'✎',image:'◫',video:'▶',file:'□',cos:'☁'};

 // ---- 挂载导航与页面（照 hub.js 的 Skill 库模式） ----
 const navItem=Object.assign(document.createElement('a'),{href:'#library',innerHTML:'<span>🗄</span>库'});
 navItem.dataset.page='library';
 const anchor=document.querySelector('.sidebar nav [data-page="materials"]')||document.querySelector('.sidebar nav [data-page="skills"]');
 anchor?anchor.after(navItem):document.querySelector('.sidebar nav').append(navItem);
 const more=document.querySelector('#mobile-menu nav');
 more?.insertAdjacentHTML('beforeend','<a href="#library" data-page="library">🗄<div><strong>库</strong><small>公司资产仓库 · 拖拽入库</small></div><span>↗</span></a>');
 more?.querySelector('[data-page="library"]').addEventListener('click',()=>document.getElementById('mobile-menu').close());

 document.querySelector('.content').insertAdjacentHTML('beforeend',`
<section id="library" class="page" hidden>
 <div class="heading"><div><div class="eyebrow">COMPANY LIBRARY</div><h1>库</h1><p>公司的文档、素材与视频，都在这里。拖文件进来即入库。</p></div>
 <button class="button primary" id="lib-upload-btn">⬆ 上传文件</button></div>
 <input id="lib-file-input" type="file" multiple hidden>
 <div class="lib-toolbar"><span class="lib-crumb" id="lib-crumb">库</span>
 <label class="search lib-search"><span>⌕</span><input id="lib-search" type="search" placeholder="搜索全库文件名" aria-label="搜索库"></label></div>
 <div class="lib-layout">
  <nav class="lib-tree" id="lib-tree" aria-label="库目录"></nav>
  <div class="lib-main">
   <div class="lib-drop" id="lib-drop"><strong>拖拽文件到这里</strong><span>入库到当前目录 · 文档进 Gitee 仓库，视频/大文件进云端存储</span></div>
   <div class="lib-progress" id="lib-progress" hidden><div class="lib-progress-bar" id="lib-progress-bar"></div><span id="lib-progress-text"></span></div>
   <div class="lib-list" id="lib-list"></div>
  </div>
 </div>
 <div class="lib-preview" id="lib-preview" hidden><div class="lib-preview-card card">
  <div class="lib-preview-head"><strong id="lib-preview-name"></strong><button class="button secondary" id="lib-preview-close">关闭</button></div>
  <div class="lib-preview-body" id="lib-preview-body"></div></div></div>
</section>`);

 // ---- 状态 ----
 let data={entries:[],cos:[],meta:{}},cwd='',expanded=new Set(['projects','knowledge','workflows','media']),query='';
 const dirs=()=>data.entries.filter(e=>e.type==='dir');
 const filesIn=p=>data.entries.filter(e=>e.type==='file'&&e.path.slice(0,e.path.length-e.name.length-1)===p);
 const childDirs=p=>dirs().filter(e=>{const parent=e.path.slice(0,e.path.length-e.name.length-1);return parent===p;});

 async function reload(){
  try{data=await api('/api/library/tree');}catch(e){toast(e.message);return;}
  renderTree();renderMain();
 }
 function renderTree(){
  const rows=[`<div class="lib-tree-root${cwd===''?' active':''}" data-path="">🗄 库</div>`,
   `<div class="lib-tree-root lib-tree-cos${cwd==='@cos'?' active':''}" data-path="@cos">☁ 云端大文件<span class="lib-badge">COS</span></div>`];
  const walk=(p,depth)=>{
   for(const d of childDirs(p).sort((a,b)=>a.name.localeCompare(b.name,'zh'))){
    const open=expanded.has(d.path);
    rows.push(`<div class="lib-tree-item${cwd===d.path?' active':''}" style="padding-left:${12+depth*16}px" data-path="${esc(d.path)}">${open?'▾':'▸'} ${esc(d.name)}</div>`);
    if(open)walk(d.path,depth+1);
   }};
  walk('',0);
  $('lib-tree').innerHTML=rows.join('');
  $('lib-tree').querySelectorAll('[data-path]').forEach(el=>el.onclick=()=>{
   const p=el.dataset.path;
   if(p&&p!=='@cos'){expanded.has(p)?expanded.delete(p):expanded.add(p);if(cwd!==p){cwd=p;expanded.add(p);}}
   else cwd=p;
   renderTree();renderMain();
  });
 }
 function renderMain(){
  $('lib-crumb').textContent=cwd==='@cos'?'库 / 云端大文件':cwd?`库 / ${cwd.replaceAll('/',' / ')}`:'库';
  const list=$('lib-list');
  if(query){
   const hits=data.entries.filter(e=>e.type==='file'&&e.name.toLowerCase().includes(query));
   const cosHits=data.cos.filter(e=>e.name.toLowerCase().includes(query));
   list.innerHTML=`<div class="lib-section-label">搜索「${esc(query)}」：${hits.length+cosHits.length} 个结果</div>`+
    hits.map(rowFile).join('')+cosHits.map(rowCos).join('')||'<div class="lib-empty">没有匹配的文件。</div>';
  }else if(cwd==='@cos'){
   list.innerHTML=`<div class="lib-section-label">云端大文件（视频与 >50MB 文件，本体在腾讯云 COS）</div>`+
    (data.cos.length?data.cos.map(rowCos).join(''):'<div class="lib-empty">还没有云端文件。把视频拖进来试试。</div>');
  }else{
   const files=filesIn(cwd).sort((a,b)=>a.name.localeCompare(b.name,'zh'));
   const sub=childDirs(cwd);
   list.innerHTML=(cwd===''?'<div class="lib-empty">从左侧选择一个分区，或直接把文件拖进来（默认进 knowledge）。</div>':'')+
    sub.map(d=>`<div class="lib-row lib-row-dir" data-open="${esc(d.path)}"><span class="lib-ico">${ICON.dir}</span><span class="lib-name">${esc(d.name)}/</span><span></span><span></span><span class="lib-src">目录</span></div>`).join('')+
    files.map(rowFile).join('')+
    (!files.length&&!sub.length&&cwd?'<div class="lib-empty">这个目录是空的。</div>':'');
  }
  bindRows();
 }
 function rowFile(f){
  const meta=data.meta[f.path]||{},k=kindOf(f.name);
  return `<div class="lib-row" data-preview="${esc(f.path)}"><span class="lib-ico">${ICON[k]}</span><span class="lib-name">${esc(f.name)}</span><span class="lib-author">${esc(meta.author||'')}</span><span class="lib-date">${esc(meta.date||f.mtime||'')}</span><span class="lib-size">${fmtSize(f.size||0)}</span><span class="lib-src">git</span></div>`;
 }
 function rowCos(e){
  return `<div class="lib-row" data-cos="${esc(e.cos)}"><span class="lib-ico">${ICON.cos}</span><span class="lib-name">${esc(e.name)}</span><span class="lib-author">${esc(e.author||'')}</span><span class="lib-date">${esc(e.date||'')}</span><span class="lib-size">${esc(e.size_mb||'?')} MB</span><span class="lib-src lib-src-cos">COS ↗</span></div>`;
 }
 function bindRows(){
  document.querySelectorAll('#lib-list [data-open]').forEach(el=>el.onclick=()=>{cwd=el.dataset.open;expanded.add(cwd);renderTree();renderMain();});
  document.querySelectorAll('#lib-list [data-cos]').forEach(el=>el.onclick=()=>window.open(el.dataset.cos,'_blank','noopener'));
  document.querySelectorAll('#lib-list [data-preview]').forEach(el=>el.onclick=()=>preview(el.dataset.preview));
 }
 async function preview(rel){
  const name=rel.split('/').pop(),k=kindOf(name);
  const box=$('lib-preview');$('lib-preview-name').textContent=name;
  const body=$('lib-preview-body');body.innerHTML='加载中…';box.hidden=false;
  try{
   if(k==='image'){body.innerHTML=`<img src="/api/library/file?path=${encodeURIComponent(rel)}" alt="${esc(name)}" style="max-width:100%;border-radius:8px">`;}
   else if(k==='doc'||k==='file'){
    const r=await fetch('/api/library/file?path='+encodeURIComponent(rel));
    if(!r.ok)throw Error((await r.json().catch(()=>({}))).error||'预览失败');
    body.innerHTML=`<pre class="lib-pre">${esc(await r.text())}</pre>`;
   }else{body.innerHTML='<div class="lib-empty">该类型暂不支持预览。</div>';}
  }catch(e){body.innerHTML=`<div class="lib-empty">${esc(e.message)}</div>`;}
 }
 $('lib-preview-close').onclick=()=>$('lib-preview').hidden=true;
 $('lib-preview').onclick=e=>{if(e.target.id==='lib-preview')$('lib-preview').hidden=true;};

 // ---- 上传 ----
 function upload(files){
  if(!files.length)return;
  if(cwd==='@cos')toast('云端大文件会按类型自动归档。');
  const fd=new FormData();
  fd.append('path',cwd&&cwd!=='@cos'?cwd:'knowledge');
  for(const f of files)fd.append('files',f,f.name);
  const xhr=new XMLHttpRequest();
  const prog=$('lib-progress'),bar=$('lib-progress-bar'),text=$('lib-progress-text');
  prog.hidden=false;bar.style.width='0%';text.textContent=`上传 ${files.length} 个文件…`;
  xhr.upload.onprogress=e=>{if(e.lengthComputable){bar.style.width=Math.round(e.loaded/e.total*100)+'%';}};
  xhr.onload=()=>{
   prog.hidden=true;
   let res;try{res=JSON.parse(xhr.responseText);}catch{res={error:'服务返回异常。'};}
   if(xhr.status!==200){toast(res.error||'上传失败，请稍后重试。');return;}
   const ok=res.results.map(r=>`${r.name} → ${r.route==='cos'?'云端存储':'Gitee 仓库'}`).join('；');
   toast(`入库完成（署名 ${res.author}）：${ok}`);
   reload();
  };
  xhr.onerror=()=>{prog.hidden=true;toast('网络请求失败，请稍后重试。');};
  xhr.open('POST','/api/upload');
  xhr.setRequestHeader('X-CSRF-Token',csrf);
  xhr.send(fd);
 }
 $('lib-upload-btn').onclick=()=>$('lib-file-input').click();
 $('lib-file-input').onchange=e=>{upload([...e.target.files]);e.target.value='';};
 const drop=$('lib-drop');
 ['dragenter','dragover'].forEach(ev=>drop.addEventListener(ev,e=>{e.preventDefault();drop.classList.add('over');}));
 ['dragleave','drop'].forEach(ev=>drop.addEventListener(ev,e=>{e.preventDefault();drop.classList.remove('over');}));
 drop.addEventListener('drop',e=>upload([...e.dataTransfer.files]));
 $('lib-search').oninput=e=>{query=e.target.value.trim().toLowerCase();renderMain();};

 // 每次切到本页刷新一次
 window.addEventListener('hashchange',()=>{if(location.hash==='#library')reload();});
 reload();
})();
