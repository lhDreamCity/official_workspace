// Responsive presentation only. Records and identity stay with the existing app.
(()=>{
 const symbols={home:'<path d="m3 10 9-7 9 7v10H5V10m4 10v-7h6v7"/>',today:'<rect x="5" y="4" width="14" height="17" rx="2"/><path d="M9 3v3m6-3v3M9 11h6m-6 4h4"/>',team:'<circle cx="9" cy="8" r="3"/><path d="M3 20v-2a6 6 0 0 1 12 0v2m2-15a3 3 0 0 1 0 6m1 3a5 5 0 0 1 3 4v2"/>',history:'<path d="M3 11a9 9 0 1 1 2 7M3 5v6h6m3-5v6l4 2"/>',more:'<circle cx="5" cy="12" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/>',materials:'<path d="M4 4h6l2 3h8v13H4V4Zm4 8h8m-8 4h5"/>',data:'<path d="M4 20h16M7 16v-4m5 4V5m5 11V9"/>',organization:'<circle cx="12" cy="5" r="3"/><circle cx="5" cy="19" r="3"/><circle cx="19" cy="19" r="3"/><path d="M12 8v5M5 16v-3h14v3"/>',apps:'<rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/>',settings:'<path d="M4 6h16M4 12h16M4 18h16"/><circle cx="8" cy="6" r="2"/><circle cx="16" cy="12" r="2"/><circle cx="9" cy="18" r="2"/>',connection:'<path d="m9 15 6-6m-8 4-2 2a4 4 0 0 0 6 6l3-3m-4-12 3-3a4 4 0 0 1 6 6l-2 2"/>'};
 const icon=id=>`<svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">${symbols[id]}</svg>`;
 const primary=[['home','首页'],['today','今日记录'],['team','团队记录'],['history','我的历史']];
 const secondary=[['materials','资料','文档与知识库'],['data','数据','我的工作概览'],['organization','组织','团队联系入口'],['apps','应用','常用工具'],['settings','管理','名称与入口配置'],['connection','企业微信连接','同步状态与智能表格']];
 const profile=document.createElement('div');profile.className='mobile-profile';
 const name=document.createElement('strong');name.textContent=window.Workroom.user.name;
 const status=document.createElement('span');status.textContent='企业微信已连接';profile.append(name,status);document.querySelector('.sidebar').append(profile);
 const bottom=document.createElement('nav');bottom.className='mobile-nav';bottom.setAttribute('aria-label','手机工作台导航');
 bottom.innerHTML=primary.map(([id,label])=>`<a href="#${id}" data-page="${id}">${icon(id)}<span>${label}</span></a>`).join('')+`<button type="button" id="mobile-more" aria-haspopup="dialog" aria-controls="mobile-menu" aria-expanded="false">${icon('more')}<span>更多</span></button>`;
 const menu=document.createElement('dialog');menu.id='mobile-menu';menu.setAttribute('aria-labelledby','mobile-menu-title');
 menu.innerHTML=`<div class="mobile-menu-head"><div><p>梦之城 · 工作间</p><h2 id="mobile-menu-title">更多入口</h2></div><button type="button" class="mobile-menu-close" aria-label="关闭更多入口">×</button></div><nav aria-label="更多工作台入口">${secondary.map(([id,label,description])=>`<a href="#${id}" data-page="${id}">${icon(id)}<div><strong>${label}</strong><small>${description}</small></div><span aria-hidden="true">↗</span></a>`).join('')}</nav>`;
 document.body.append(bottom,menu);
 const trigger=bottom.querySelector('button');
 trigger.onclick=()=>{menu.showModal();trigger.setAttribute('aria-expanded','true');};
 menu.querySelector('button').onclick=()=>menu.close();
 menu.addEventListener('close',()=>{trigger.setAttribute('aria-expanded','false');trigger.focus({preventScroll:true});});
 menu.addEventListener('click',event=>{if(event.target===menu)menu.close();});
 menu.querySelectorAll('a').forEach(link=>link.addEventListener('click',()=>menu.close()));
 const syncNav=()=>{
  const page=document.body.dataset.page;
  bottom.querySelectorAll('a').forEach(link=>{const active=link.dataset.page===page;link.classList.toggle('active',active);if(active)link.setAttribute('aria-current','page');else link.removeAttribute('aria-current');});
  trigger.classList.toggle('active',secondary.some(([id])=>id===page));
  if(menu.open)menu.close();
 };
 window.addEventListener('hashchange',syncNav);syncNav();
 const hero=document.querySelector('.hero-mark');hero.innerHTML='<img src="logo.png?v=1a40910e5d71" alt="" width="112" height="112">';
 const teamLink=document.createElement('a');teamLink.className='button secondary mobile-team-link';teamLink.href='#team';teamLink.innerHTML=`${icon('team')}<span>看看团队</span>`;document.querySelector('.home-hero .primary').after(teamLink);
 const grid=document.getElementById('home-shortcuts'),heading=grid.previousElementSibling,details=document.createElement('details');details.className='mobile-shortcuts';
 const summary=document.createElement('summary');summary.innerHTML='<div><strong>办事与常用入口</strong><span>请假、报销、出差与审批</span></div><b aria-hidden="true">＋</b>';
 grid.before(details);details.append(summary,heading,grid);
 document.getElementById('home-stats').previousElementSibling.classList.add('mobile-overview-heading');
 const mobile=matchMedia('(max-width: 760px)');const resize=()=>{details.open=!mobile.matches;if(!mobile.matches&&menu.open)menu.close();};mobile.addEventListener('change',resize);resize();
})();
