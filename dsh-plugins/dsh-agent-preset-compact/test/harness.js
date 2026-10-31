const seeds=window.__TEST_SEEDS__;
const React=seeds.react, {createRoot}=seeds['react-dom/client'], {Menu}=seeds['@deepseek-ai/dsh-client-ui-primitives'];
if(!Menu)throw Error('Installed native Menu export missing');
window.__ModuleLoader__={load:({factory})=>{window.__APC__=factory(name=>{if(name==='react')return React;throw Error(`Unexpected dependency ${name}`)})}};
const root=createRoot(document.getElementById('root'));
const family=window.__PRESET_FAMILY__;
const defaultConfig={count:18,open:true,selected:'2',target:true};
let config={...defaultConfig},controller;
function App(){
 const [open,setOpen]=React.useState(config.open),[selected,setSelected]=React.useState(config.selected),[count,setCount]=React.useState(config.count);
 controller={setOpen,setSelected,setCount};
 const items=Array.from({length:count},(_,index)=>({id:String(index),label:config.target?React.createElement('span',{className:family.item},React.createElement('span',{className:family.itemName},index===0?'超长智能体预设名称用于验证省略及完整文本保留 '+ 'LONG-NAME-'.repeat(8):`预设 ${index+1} · Agent ${index+1}`),React.createElement('span',{className:family.itemDesc},'完整说明：保留原生行为、工具权限和默认值。'+ '长文本用于测试单行省略与辅助技术保留。'.repeat(5))):React.createElement('span',{},`工作区 / 模型 ${index+1}`)}));
 return React.createElement(Menu,{open,portal:true,items,selectedId:selected,className:family.menuAnchor,anchor:React.createElement('button',{id:'anchor',type:'button',onClick:()=>setOpen(x=>!x)},'Agent preset · 原生 Menu fixture'),onSelect:id=>{window.__chosen.push(id);setSelected(id);setOpen(false)},onClose:()=>setOpen(false)});
}
window.__chosen=[];
window.renderMenu=async options=>{config={...defaultConfig,...options};root.render(React.createElement(App,{key:String(Math.random())}));await new Promise(r=>setTimeout(r,80))};
window.control=controller;
window.setMenu=async (key,value)=>{controller[key](value);await new Promise(r=>setTimeout(r,60))};
window.__fixtureReady=true;
