const seeds=window.__TEST_SEEDS__,React=seeds.react,{createRoot}=seeds['react-dom/client'],{Menu}=seeds['@deepseek-ai/dsh-client-ui-primitives'];
if(!Menu)throw Error('Installed native Menu export missing');
window.__ModuleLoader__={load:({factory})=>{window.__APC__=factory(name=>{if(name==='react')return React;throw Error(`Unexpected dependency ${name}`);});}};
const root=createRoot(document.getElementById('root')),family=window.__PRESET_FAMILY__;
const defaults={count:18,open:true,selected:'2',target:true};let config={...defaults},controller;
function App(){
 const [open,setOpen]=React.useState(config.open),[selected,setSelected]=React.useState(config.selected),[count,setCount]=React.useState(config.count);controller={setOpen,setSelected,setCount};
 const items=Array.from({length:count},(_,i)=>({id:String(i),label:config.target?React.createElement('span',{className:family.item},React.createElement('span',{className:family.itemName},i===0?'超长预设名称完整保留 '+ 'LONG-NAME-'.repeat(8):`预设 ${i+1} · Agent ${i+1}`),React.createElement('span',{className:family.itemDesc},'完整说明：原生行为与权限不变。'+ '长文本验证单行省略与辅助技术完整保留。'.repeat(5))):React.createElement('span',{},`工作区 / 模型 ${i+1}`)}));
 // Matches official AgentPresetSeat: anchor, not Menu children.
 return React.createElement(Menu,{open,portal:true,align:'start',items,selectedId:selected,className:family.menuAnchor,anchor:React.createElement('button',{id:'anchor',type:'button',onClick:()=>setOpen(x=>!x)},'Agent preset · native Menu fixture'),onSelect:id=>{window.__chosen.push(id);setSelected(id);setOpen(false);},onClose:()=>setOpen(false)});
}
window.__chosen=[];
window.renderMenu=async options=>{config={...defaults,...options};root.render(React.createElement(App,{key:String(Math.random())}));await new Promise(r=>setTimeout(r,90));};
window.setMenu=async(key,value)=>{controller[key](value);await new Promise(r=>setTimeout(r,90));};
window.__fixtureReady=true;
