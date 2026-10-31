import fs from 'node:fs';
import crypto from 'node:crypto';
const result=JSON.parse(fs.readFileSync('test/artifacts/browser-result.json','utf8'));
for(const [key,m]of Object.entries(result.measurements))console.log('DIMENSION',key,JSON.stringify({width:m.width,height:m.height,top:m.top,right:m.right,bottom:m.bottom,columns:m.columns,horizontal:m.horizontal,menuHorizontal:m.menuHorizontal}));
console.log('CLOSED_STATS',JSON.stringify(result.closedStats));
for(const name of ['lib/client.js','test/fixtures/provenance.json'])console.log('SHA256',name,crypto.createHash('sha256').update(fs.readFileSync(name)).digest('hex'));
try{process.kill(result.browser.pid,0);console.log('BROWSER_PID_STILL_EXISTS',result.browser.pid);process.exitCode=1;}catch(e){if(e.code!=='ESRCH')throw e;console.log('BROWSER_CLOSED',result.browser.pid);}
