import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
const dir=path.resolve('test/artifacts/edge-profile'); fs.mkdirSync(dir,{recursive:true});
const child=spawn('C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',['--headless=new','--disable-gpu','--no-first-run','--remote-debugging-port=59223',`--user-data-dir=${dir}`,'about:blank'],{stdio:'ignore'});
console.log('TEST_EDGE_PID',child.pid);
process.on('SIGTERM',()=>{child.kill();process.exit(0)});
child.on('exit',code=>process.exit(code||0));
