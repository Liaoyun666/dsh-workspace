import fs from 'node:fs';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
const url='https://download.unity3d.com/download_unity/fbf367ac14e9/Windows64EditorInstaller/UnitySetup64-2019.4.15f1.exe';
const out='E:\\Unity\\downloads\\UnitySetup64-2019.4.15f1.fresh.exe';
const log=(m)=>{const line=new Date().toISOString()+' '+m;fs.appendFileSync(out+'.log',line+'\n');console.log(line)};
let attempt=0;
while(true){
  attempt++;
  let have=fs.existsSync(out)?fs.statSync(out).size:0;
  try{
    const headers=have>0?{Range:'bytes='+have+'-'}:{};
    const res=await fetch(url,{headers});
    if(!res.ok&&res.status!==206) throw new Error('HTTP '+res.status);
    const total=Number((res.headers.get('content-range')||'').split('/')[1]||res.headers.get('content-length'));
    log('attempt '+attempt+' start have='+have+' total='+total+' status='+res.status);
    await pipeline(Readable.fromWeb(res.body), fs.createWriteStream(out,{flags:have>0?'a':'w'}));
    const size=fs.statSync(out).size;
    log('done size='+size+' total='+total);
    if(total && size===total){log('OK');break;}
    if(total && size>total){log('oversize, restart');fs.unlinkSync(out);continue;}
  }catch(e){log('attempt '+attempt+' error: '+e.message);await new Promise(r=>setTimeout(r,3000));}
  if(attempt>40){log('GIVEUP');process.exit(1);}
}