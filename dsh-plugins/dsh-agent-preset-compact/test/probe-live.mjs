import {connect} from './cdp.mjs';
import fs from 'node:fs';
const c=await connect();
try {
 await c.send('Page.enable');await c.send('Page.navigate',{url:'http://127.0.0.1:55968'});
 let facts; for(let i=0;i<60;i++){facts=await c.evaluate(`({ready:!!document.querySelector('[data-composer-card]'),buttons:[...document.querySelectorAll('button[aria-haspopup="menu"]')].map(x=>({class:x.className,text:x.textContent})),loader:typeof window.__ModuleLoader__})`);if(facts.ready)break;await new Promise(r=>setTimeout(r,500))}
 console.log(JSON.stringify(facts,null,2));
 console.log(await c.evaluate(`Object.keys(window.__ModuleLoader__||{})`));
 await c.evaluate(`document.querySelector('button[class$="_seat"]')?.click()`);
 await new Promise(r=>setTimeout(r,300));
 console.log(await c.evaluate(`JSON.stringify([...document.querySelectorAll('[role="menu"]')].map(x=>({html:x.outerHTML,rect:x.getBoundingClientRect().toJSON()})))`));
 fs.writeFileSync('test/artifacts/live-before.png',Buffer.from((await c.send('Page.captureScreenshot')).data,'base64'));
} finally {await c.close()}
