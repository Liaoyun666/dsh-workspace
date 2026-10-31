window.__ModuleLoader__.load({
 id:'dsh-agent-preset-compact',
 factory:require=>{
 const React=require('react'),states=new WeakMap(),provenance='@deepseek-ai/dsh-client-ui-agent-preset/AgentPresetSeat.module.css';
 const css=`
[role=menu][data-menu-material][data-apc=menu]{box-sizing:border-box;width:min(420px,calc(100vw - 24px));min-width:0;max-width:min(420px,calc(100vw - 24px));--apc-top:max(12px,calc(var(--dsh-frame-top-clearance,0px) + 20px));max-height:min(320px,calc(100dvh - var(--apc-top) - 12px));overflow:hidden}
html[data-fullscreen] [role=menu][data-apc=menu]{--apc-top:20px}
[role=menu][data-apc=menu]>[data-apc=viewport]{box-sizing:border-box;display:grid;grid-template-columns:repeat(2,minmax(0,1fr));grid-auto-flow:row;gap:4px;min-width:0;max-height:min(308px,calc(100dvh - var(--apc-top) - 24px));overflow-y:auto;overflow-x:hidden;overscroll-behavior:contain}
[data-apc=menu] [data-apc=wrap]{min-width:0}
[data-apc=menu] [data-apc=row]{box-sizing:border-box;width:100%;min-width:0;padding:8px;gap:4px;border-radius:var(--dsw-radius-sm,6px);text-align:left;align-items:center}
[data-apc=menu] [data-apc=row][data-apc-current=true]{background:var(--dsw-alias-bg-module-platform,var(--dsw-alias-interactive-bg-hover))}
[data-apc=menu] [data-apc=row]:not(:disabled):hover{background:var(--dsw-alias-interactive-bg-hover)}
[data-apc=menu] [data-apc=row]:focus-visible{background:var(--dsw-alias-interactive-bg-hover);outline:2px solid var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary));outline-offset:-2px}
[data-apc=menu] [data-apc=label],[data-apc=menu] [data-apc=item]{min-width:0;max-width:none;flex:1;overflow:hidden}
[data-apc=menu] [data-apc=item]{display:flex;flex-direction:column;gap:2px}
[data-apc=menu] [data-apc=name]{min-width:0;font-size:13px;font-weight:600;line-height:20px;color:var(--dsw-alias-label-primary);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
[data-apc=menu] [data-apc=desc]{min-width:0;font-size:12px;line-height:16px;color:var(--dsw-alias-label-caption);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
@media(max-width:559.98px){[role=menu][data-apc=menu]>[data-apc=viewport]{grid-template-columns:minmax(0,1fr)}}
@media(prefers-reduced-motion:reduce){[data-apc=menu] [data-apc=row]{transition:none;animation:none}}
`;
 function family(doc){
  const tag=[...doc.querySelectorAll('style[data-plugin-css]')].find(el=>el.getAttribute('data-plugin-css')===provenance),text=tag?.textContent||'',prefix=text.match(/\.([A-Za-z0-9_-]+)_menuAnchor\b/)?.[1],names=['menuAnchor','seat','item','itemName','itemDesc'];
  if(!prefix||!names.every(n=>text.includes(`.${prefix}_${n}`)))return null;
  return Object.fromEntries(names.map(n=>[n,`${prefix}_${n}`]));
 }
 function identify(menu,f){
  if(!f||menu?.getAttribute('role')!=='menu'||!menu.hasAttribute('data-menu-material'))return null;
  const content=[...menu.children].filter(el=>el.getAttribute('aria-hidden')!=='true');
  if(content.length!==1)return null;
  const viewport=content[0],rows=[];
  if(viewport.tagName!=='DIV'||viewport.getAttribute('role')!=='presentation'||!viewport.children.length)return null;
  for(const wrap of viewport.children){
   if(wrap.tagName!=='DIV'||wrap.children.length!==1)return null;
   const row=wrap.firstElementChild;
   if(row.tagName!=='BUTTON'||row.getAttribute('role')!=='menuitem'||row.hasAttribute('aria-haspopup'))return null;
   const labels=[...row.children].filter(el=>el.tagName==='SPAN'&&el.children.length===1&&el.firstElementChild.classList.contains(f.item));
   if(labels.length!==1)return null;
   const label=labels[0],item=label.firstElementChild;
   if(item.tagName!=='SPAN'||item.children.length!==2)return null;
   const [name,desc]=item.children;
   if(name.tagName!=='SPAN'||desc.tagName!=='SPAN'||name.children.length||desc.children.length||!name.classList.contains(f.itemName)||!desc.classList.contains(f.itemDesc))return null;
   const extras=[...row.children].filter(el=>el!==label);
   // Native Menu.module.css check family, verified in local production bundle.
   if(extras.length>1||extras.some(el=>el.tagName.toLowerCase()!=='svg'||el.getAttribute('aria-hidden')!=='true'||![...el.classList].some(c=>/^_check_[A-Za-z0-9_]+$/.test(c))))return null;
   rows.push({wrap,row,label,item,name,desc,current:extras.length===1});
  }
  return {menu,viewport,rows};
 }
 function mount(doc=document){
  let released=false,state=states.get(doc);
  if(state){state.refs++;return release;}
  state={refs:1,alive:true,menus:new Map(),records:new Map(),pending:new Set(),queued:false,batches:0,scans:0,familyReads:0};states.set(doc,state);
  const View=doc.defaultView,style=doc.createElement('style');style.setAttribute('data-apc-style','');style.textContent=css;doc.head.append(style);
  let cachedFamily,dirtyFamily=true;
  const getFamily=()=>{if(dirtyFamily){cachedFamily=family(doc);state.familyReads++;dirtyFamily=false;}return cachedFamily;};
  function own(el,key,value,menuRecord){
   let attrs=state.records.get(el);if(!attrs){attrs=new Map();state.records.set(el,attrs);}
   let r=attrs.get(key);if(!r){r={before:el.getAttribute(key),value:null,yielded:key==='title'&&(el.hasAttribute(key)||menuRecord?.yieldedTitles.has(el))};attrs.set(key,r);}
   if(key==='title'&&r.value!==null&&el.getAttribute(key)!==r.value)r.yielded=true;
   if(r.yielded){menuRecord?.yieldedTitles.add(el);return;}r.value=value;if(el.getAttribute(key)!==value)el.setAttribute(key,value);
  }
  function restore(el){const attrs=state.records.get(el);if(!attrs)return;for(const [key,r]of attrs)if(!r.yielded&&el.getAttribute(key)===r.value){if(r.before===null)el.removeAttribute(key);else el.setAttribute(key,r.before);}state.records.delete(el);}
  function drop(menu){const r=state.menus.get(menu);if(!r)return;r.observer.disconnect();for(const el of r.owned)restore(el);r.owned.clear();state.menus.delete(menu);state.pending.delete(menu);}
  function enhance(menu){
   state.scans++;const match=identify(menu,getFamily());if(!match){drop(menu);return;}
   let record=state.menus.get(menu);
   if(!record){
    const observer=new View.MutationObserver(changes=>{
     let relevant=false;
     for(const change of changes){if(change.type==='attributes'&&change.attributeName==='title'){const r=state.records.get(change.target)?.get('title');if(r&&!r.yielded&&change.target.getAttribute('title')!==r.value){r.yielded=true;record.yieldedTitles.add(change.target);relevant=true;}}else relevant=true;}
     if(relevant)queue(menu);
    });
    record={owned:new Set(),yieldedTitles:new WeakSet(),observer};state.menus.set(menu,record);
    observer.observe(menu,{subtree:true,childList:true,characterData:true,attributes:true,attributeFilter:['class','title']});
   }
   const live=new Set([menu,match.viewport]);own(menu,'data-apc','menu');own(match.viewport,'data-apc','viewport');
   for(const parts of match.rows){for(const key of ['wrap','row','label','item','name','desc']){live.add(parts[key]);own(parts[key],'data-apc',key);}own(parts.name,'title',parts.name.textContent,record);own(parts.desc,'title',parts.desc.textContent,record);own(parts.row,'data-apc-current',String(parts.current));}
   for(const el of record.owned)if(!live.has(el))restore(el);record.owned=live;
  }
  function queue(menu){if(!state.alive)return;state.pending.add(menu);if(state.queued)return;state.queued=true;View.queueMicrotask(flush);}
  function flush(){state.queued=false;if(!state.alive)return;state.batches++;const pending=[...state.pending];state.pending.clear();for(const menu of pending){if(menu.isConnected)enhance(menu);else drop(menu);}}
  const bodyObserver=new View.MutationObserver(changes=>{
   // Direct native portals only. No chat/app descendant observation.
   for(const menu of state.menus.keys())if(!menu.isConnected)drop(menu);
   for(const change of changes)for(const node of change.addedNodes)if(node.nodeType===1&&node.getAttribute('role')==='menu')queue(node);
  });bodyObserver.observe(doc.body,{childList:true});
  const sourceObservers=new Map();
  function invalidate(){dirtyFamily=true;for(const menu of state.menus.keys())queue(menu);}
  function watchSources(){
   const tags=new Set([...doc.head.children].filter(el=>el.tagName==='STYLE'&&el.getAttribute('data-plugin-css')===provenance));let changed=false;
   for(const [tag,observer]of sourceObservers)if(!tags.has(tag)){observer.disconnect();sourceObservers.delete(tag);changed=true;}
   for(const tag of tags)if(!sourceObservers.has(tag)){const observer=new View.MutationObserver(invalidate);observer.observe(tag,{childList:true,subtree:true,characterData:true,attributes:true,attributeFilter:['data-plugin-css']});sourceObservers.set(tag,observer);changed=true;}
   if(changed)invalidate();
  }
  const headObserver=new View.MutationObserver(watchSources);headObserver.observe(doc.head,{childList:true});watchSources();
  for(const menu of doc.body.children)if(menu.getAttribute('role')==='menu')enhance(menu);
  state.dispose=()=>{state.alive=false;bodyObserver.disconnect();headObserver.disconnect();for(const observer of sourceObservers.values())observer.disconnect();sourceObservers.clear();state.pending.clear();for(const menu of [...state.menus.keys()])drop(menu);for(const el of [...state.records.keys()])restore(el);cachedFamily=null;style.remove();states.delete(doc);};
  return release;
  function release(){if(released)return;released=true;if(--state.refs===0)state.dispose();}
 }
 function Overlay(){React.useEffect(()=>mount(),[]);return null;}
 function apply(ctx){const slots=ctx.get('slots');if(!slots)return;slots.inject('shell.overlay',()=>slots.register({name:'shell.overlay',id:'agent-preset-compact',order:21},Overlay));}
 return {inject:['slots'],apply,__test:{mount,identify,family,css,stats:doc=>{const s=states.get(doc);return s?{refs:s.refs,batches:s.batches,scans:s.scans,familyReads:s.familyReads,menus:s.menus.size,records:s.records.size}:null;}}};
 },
});
