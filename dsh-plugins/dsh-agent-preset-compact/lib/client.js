window.__ModuleLoader__.load({
  id: 'dsh-agent-preset-compact',
  factory: (require) => {
    const React = require('react');
    const states = new WeakMap();
    const marker = 'data-apc';
    const provenance = '@deepseek-ai/dsh-client-ui-agent-preset/AgentPresetSeat.module.css';
    const css = `
/* shell: 页面外壳固定，滚轮/触控到边界不再拖动整个页面；消息列表/侧栏/弹窗等内部容器仍各自滚动 */
html,body,#root{height:100%;overflow:hidden;overscroll-behavior:none}
[data-apc="menu"]{box-sizing:border-box;width:min(420px,calc(100vw - 24px));min-width:0;max-width:min(420px,calc(100vw - 24px));--apc-top:max(12px,calc(var(--dsh-frame-top-clearance,0px) + 20px));max-height:min(320px,calc(100dvh - var(--apc-top) - 12px));overflow:hidden}
html[data-fullscreen] [data-apc="menu"]{--apc-top:20px}
[data-apc="viewport"]{box-sizing:border-box;display:grid;grid-template-columns:repeat(2,minmax(0,1fr));grid-auto-flow:row;gap:4px;min-width:0;max-height:min(308px,calc(100dvh - var(--apc-top) - 24px));overflow-y:auto;overflow-x:hidden;overscroll-behavior:contain}
[data-apc="wrap"]{min-width:0}
[data-apc="row"]{box-sizing:border-box;width:100%;min-width:0;padding:8px;gap:4px;border-radius:var(--dsw-radius-sm,6px);text-align:left;align-items:center}
[data-apc="row"][data-apc-current="true"]{background:var(--dsw-alias-bg-module-platform,var(--dsw-alias-interactive-bg-hover))}
[data-apc="row"]:not(:disabled):hover{background:var(--dsw-alias-interactive-bg-hover)}
[data-apc="row"]:focus-visible{background:var(--dsw-alias-interactive-bg-hover);outline:2px solid var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary));outline-offset:-2px}
[data-apc="label"],[data-apc="item"]{min-width:0;max-width:none;flex:1;overflow:hidden}
[data-apc="item"]{display:flex;flex-direction:column;gap:2px}
[data-apc="name"]{min-width:0;font-size:13px;font-weight:600;line-height:20px;color:var(--dsw-alias-label-primary);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
[data-apc="desc"]{min-width:0;font-size:12px;line-height:16px;color:var(--dsw-alias-label-caption);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
@media(max-width:559.98px){[data-apc="viewport"]{grid-template-columns:minmax(0,1fr)}}
`;
    // Class family comes only from the installed official module's style provenance,
    // never a translated label or a pinned build hash. Unknown builds fail closed.
    function family(doc) {
      const tag = [...doc.querySelectorAll('style[data-plugin-css]')].find(x => x.getAttribute('data-plugin-css') === provenance);
      const prefix = tag?.textContent.match(/\.([A-Za-z0-9_-]+)_menuAnchor\b/)?.[1];
      if (!prefix) return null;
      const names = ['menuAnchor', 'seat', 'item', 'itemName', 'itemDesc'];
      if (!names.every(n => tag.textContent.includes(`.${prefix}_${n}`))) return null;
      return Object.fromEntries(names.map(n => [n, `${prefix}_${n}`]));
    }
    function identify(menu, f) {
      if (!f || menu?.getAttribute('role') !== 'menu') return null;
      const viewport = [...menu.children].find(x => x.getAttribute('role') === 'presentation');
      if (!viewport || !viewport.children.length) return null;
      const rows = [];
      for (const wrap of viewport.children) {
        if (wrap.tagName !== 'DIV' || wrap.children.length !== 1) return null;
        const row = wrap.firstElementChild;
        if (row.tagName !== 'BUTTON' || row.getAttribute('role') !== 'menuitem' || row.hasAttribute('aria-haspopup')) return null;
        const label = [...row.children].find(x => x.tagName === 'SPAN' && x.children.length === 1 && x.firstElementChild.classList.contains(f.item));
        const item = label?.firstElementChild;
        if (!item || item.children.length !== 2) return null;
        const [name, desc] = item.children;
        if (name.tagName !== 'SPAN' || desc.tagName !== 'SPAN' || !name.classList.contains(f.itemName) || !desc.classList.contains(f.itemDesc)) return null;
        rows.push({wrap, row, label, item, name, desc});
      }
      return {menu, viewport, rows};
    }
    function mount(doc = document) {
      let released=false;
      let state = states.get(doc);
      if (state) { state.refs++; return release; }
      state = {refs:1, alive:true, records:new Map(), menus:new Set(), pending:new Set(), queued:false, batches:0, scans:0};
      states.set(doc,state);
      const style = doc.createElement('style'); style.setAttribute('data-apc-style',''); style.textContent=css; doc.head.append(style);
      function own(el, key, value) {
        let attrs=state.records.get(el); if(!attrs){attrs=new Map();state.records.set(el,attrs)}
        let record=attrs.get(key); if(!record){record={before:el.getAttribute(key),value};attrs.set(key,record)}
        // Do not take over a title supplied/changed by another component.
        if(key==='title' && record.before!==null) return;
        if(key==='title' && el.hasAttribute(key) && el.getAttribute(key)!==record.value) {record.before=el.getAttribute(key);return;}
        record.value=value; if(el.getAttribute(key)!==value)el.setAttribute(key,value);
      }
      function restore(el) {
        const attrs=state.records.get(el);if(!attrs)return;
        for(const [key,r] of attrs)if(el.getAttribute(key)===r.value){if(r.before===null)el.removeAttribute(key);else el.setAttribute(key,r.before)}
        state.records.delete(el);
      }
      function enhance(menu) {
        state.scans++;
        const match=identify(menu,family(doc));
        if(!match){if(state.menus.has(menu)){for(const el of [...state.records.keys()])if(el===menu||menu.contains(el))restore(el);state.menus.delete(menu)}return;}
        state.menus.add(menu);
        const live = new Set([menu,match.viewport]);
        own(menu,marker,'menu');own(match.viewport,marker,'viewport');
        for(const parts of match.rows){
          for(const key of ['wrap','row','label','item','name','desc']){live.add(parts[key]);own(parts[key],marker,key)}
          own(parts.name,'title',parts.name.textContent);own(parts.desc,'title',parts.desc.textContent);
          const current=[...parts.row.children].some(x=>x.tagName.toLowerCase()==='svg' && [...x.classList].some(c=>/^_check_/.test(c)));
          own(parts.row,'data-apc-current',String(current));
        }
        for(const el of [...state.records.keys()])if(menu.contains(el)&&!live.has(el))restore(el);
      }
      function queue(menu){if(!menu)return;state.pending.add(menu);if(state.queued)return;state.queued=true;doc.defaultView.queueMicrotask(flush)}
      function flush(){state.queued=false;if(!state.alive)return;state.batches++;const pending=[...state.pending];state.pending.clear();for(const menu of pending)if(menu.isConnected)enhance(menu);for(const el of [...state.records.keys()])if(!el.isConnected)restore(el);for(const menu of state.menus)if(!menu.isConnected)state.menus.delete(menu)}
      function added(node) {
        if(node.nodeType!==1)return;
        if(node.getAttribute('role')==='menu')queue(node);
        // This build portals the menu directly into body. Do not descend into
        // arbitrary added chat/app trees; descendants of a menu are handled above.
      }
      const observer=new doc.defaultView.MutationObserver(changes=>{
        for(const change of changes){
          const el=change.target.nodeType===1?change.target:change.target.parentElement;
          const menu=el?.closest('[role="menu"]');if(menu)queue(menu);
          if(change.type==='childList')for(const node of change.addedNodes)added(node);
        }
      });
      observer.observe(doc.body,{childList:true,subtree:true,characterData:true,attributes:true,attributeFilter:['class']});
      // One initial menu-only discovery is necessary when enabled while a menu is open.
      for(const menu of doc.querySelectorAll('[role="menu"]'))enhance(menu);
      state.dispose=()=>{state.alive=false;observer.disconnect();state.pending.clear();for(const el of [...state.records.keys()])restore(el);state.menus.clear();style.remove();states.delete(doc)};
      return release;
      function release(){if(released)return;released=true;if(--state.refs===0)state.dispose()}
    }
    function Overlay(){React.useEffect(()=>mount(),[]);return null}
    function apply(ctx){const slots=ctx.get('slots');if(!slots)return;slots.inject('shell.overlay',()=>slots.register({name:'shell.overlay',id:'agent-preset-compact',order:21},Overlay))}
    return {inject:['slots'],apply,__test:{mount,identify,family,css,stats:doc=>{const s=states.get(doc);return s?{refs:s.refs,batches:s.batches,scans:s.scans,menus:s.menus.size,records:s.records.size}:null}}};
  },
});
