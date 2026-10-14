// Presentation only: retain existing record nodes, actions, data and permissions.
(()=>{
 const home=document.getElementById('home'),heading=home.querySelector('.hub-heading'),today=home.querySelector('.hub-today');
 const hero=document.createElement('section');hero.className='workspace-hero';hero.setAttribute('aria-label','梦之城品牌海报');
 hero.innerHTML='<img class="workspace-hero-art" src="hero-banner.png?v=bef35c4ac969" alt="" fetchpriority="high"><div class="workspace-hero-content"><span class="workspace-hero-eyebrow">GC DREAM CITY · 梦之城工作间</span><h2>让每一份努力，<br>走向更大的可能。</h2><p class="workspace-hero-description">记录今天的进展，一起抵达下一座城。</p><div class="workspace-hero-footer"></div></div>';
 heading.after(hero);hero.querySelector('.workspace-hero-footer').append(today);
 heading.querySelector('.hub-subtitle').hidden=true;
 function compact(list,kind){
  if(!list)return;let previousDate='';
  [...list.querySelectorAll(':scope>.history-card')].forEach((card,index)=>{
   if(card.dataset.journalCompact)return;card.dataset.journalCompact='true';card.classList.add('journal-entry');
   const id=card.querySelector('[data-id]')?.dataset.id;
   const record=kind==='history'?records.find(record=>record.id===id):(typeof teamRows==='undefined'?null:teamRows[index]);
   const head=card.querySelector('.history-head'),title=head?.querySelector('h2'),meta=head?.querySelector('small'),actions=head?.querySelector('.history-actions'),status=head?.querySelector(':scope>.status-pill');
   const date=record?.date||meta?.textContent.slice(0,10)||'';
   if(date&&date!==previousDate){const label=document.createElement('h3');label.className='journal-date';label.textContent=/^\d{4}-\d{2}-\d{2}$/.test(date)?`${date.slice(0,4)}年${Number(date.slice(5,7))}月${Number(date.slice(8,10))}日`:date;card.before(label);previousDate=date;}
   const details=document.createElement('details');details.className='record-disclosure';
   const summary=document.createElement('summary'),top=document.createElement('div'),excerpt=document.createElement('p'),bottom=document.createElement('div');top.className='journal-meta';excerpt.className='journal-excerpt';bottom.className='journal-bottom';
   if(title){if(kind==='history'&&record&&title.firstChild?.nodeType===Node.TEXT_NODE)title.firstChild.textContent=record.name+' ';top.append(title);}if(status)top.append(status);
   const query=kind==='history'?document.getElementById('search').value.trim().toLowerCase():'';
   const matches=query&&record?[...record.items.flatMap(item=>[item.text,item.blocker]),record.blockers,record.next].filter(text=>text&&text.toLowerCase().includes(query)):[];
   excerpt.textContent=matches.length?matches.slice(0,2).join(' · '):(record?.items?.slice(0,2).map(item=>item.text).join(' · ')||card.querySelector('.history-row>span')?.firstChild?.textContent||'查看这份工作记录的详情。');
   const information=document.createElement('span');information.className='journal-information';information.textContent=record?recordSummary(record):(meta?.textContent||'');
   const cue=document.createElement('span');cue.className='journal-toggle';cue.innerHTML='<span class="when-closed">展开详情</span><span class="when-open">收起详情</span><svg viewBox="0 0 24 24" aria-hidden="true"><path d="m6 9 6 6 6-6"/></svg>';
   bottom.append(information,cue);summary.append(top,excerpt,bottom);
   const body=document.createElement('div');body.className='journal-detail';
   head?.remove();while(card.firstChild)body.append(card.firstChild);
   if(actions){actions.classList.add('journal-actions');body.append(actions);}
   details.append(summary,body);card.append(details);
  });
 }
 const beforeRender=render;render=function(){beforeRender();compact(document.getElementById('history-list'),'history');};
 document.getElementById('search').oninput=render;
 if(typeof renderTeam==='function'){const beforeTeamRender=renderTeam;renderTeam=function(){beforeTeamRender();compact(document.getElementById('team-list'),'team');};}
 const beforeRoute=route;window.removeEventListener('hashchange',beforeRoute);route=function(){beforeRoute();compact(document.getElementById('history-list'),'history');};window.addEventListener('hashchange',route);
 compact(document.getElementById('history-list'),'history');if(typeof teamRows!=='undefined')compact(document.getElementById('team-list'),'team');
})();
