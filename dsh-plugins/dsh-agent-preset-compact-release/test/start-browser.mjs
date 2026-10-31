import {spawn} from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
export async function startBrowser(){
 const profile=fs.mkdtempSync(path.join(os.tmpdir(),'apc-fixture-empty-'));
 const child=spawn(process.env.APC_EDGE||'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',['--headless=new','--disable-gpu','--no-first-run','--no-default-browser-check','--disable-extensions','--disable-background-networking','--remote-debugging-port=0',`--user-data-dir=${profile}`,'about:blank'],{stdio:'ignore'});
 let failure;child.on('error',error=>{failure=error;});
 const deadline=Date.now()+15000;
 try{
  while(Date.now()<deadline){if(failure)throw failure;const active=path.join(profile,'DevToolsActivePort');if(fs.existsSync(active)){const [port]=fs.readFileSync(active,'utf8').trim().split('\n');return {endpoint:`http://127.0.0.1:${port}`,profile,pid:child.pid,stop:async()=>{child.kill();await Promise.race([new Promise(r=>child.once('exit',r)),new Promise(r=>setTimeout(r,2000))]);}};}await new Promise(r=>setTimeout(r,60));}
  throw Error('Headless Edge startup timeout (15000ms)');
 }catch(error){child.kill();throw error;}
}
