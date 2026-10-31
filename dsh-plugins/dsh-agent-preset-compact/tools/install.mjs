import * as fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {randomUUID} from 'node:crypto';
export const packageName='dsh-agent-preset-compact';
const pluginDir=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const begin=`# BEGIN ${packageName} managed v1`;
const end=`# END ${packageName} managed v1`;
const body=`${begin}\n- insert:\n    - id: agent-preset-compact\n      name: ${packageName}\n${end}\n`;
function stat(p){try{return fs.lstatSync(p)}catch(e){if(e.code==='ENOENT')return null;throw e}}
function regular(p,required=false){const s=stat(p);if(!s){if(required)throw Error(`Missing file: ${p}`);return null}if(!s.isFile()||s.isSymbolicLink())throw Error(`Refusing non-regular file: ${p}`);return fs.readFileSync(p,'utf8')}
function atomic(p,old,text){if(regular(p)!==old)throw Error(`Concurrent change: ${p}`);const temp=`${p}.tmp-${randomUUID()}`;fs.writeFileSync(temp,text,{flag:'wx'});try{fs.renameSync(temp,p)}finally{if(stat(temp))fs.unlinkSync(temp)}}
function backup(p,text){if(text===null)return null;const out=`${p}.bak-${packageName}-${randomUUID()}`;fs.writeFileSync(out,text,{flag:'wx'});return out}
export function operate(profileDir,action='status') {
 if(!path.isAbsolute(profileDir))throw Error('--profile-dir must be absolute');
 const profile=fs.realpathSync(profileDir), patch=path.join(profile,'cordis.patch.yml'), receiptPath=path.join(profile,`.${packageName}.json`), modules=path.join(profile,'node_modules'), link=path.join(modules,packageName);
 const manifest=JSON.parse(regular(path.join(profile,'package.json'),true));
 const text=regular(patch), receiptText=regular(receiptPath), receipt=receiptText===null?null:JSON.parse(receiptText);
 const ms=stat(modules);if(ms && (!ms.isDirectory()||ms.isSymbolicLink()))throw Error(`Refusing node_modules alias: ${modules}`);
 const ls=stat(link);let target=null;if(ls){if(!ls.isSymbolicLink())throw Error(`Refusing entity: ${link}`);target=path.resolve(modules,fs.readlinkSync(link));if(target!==fs.realpathSync(pluginDir))throw Error(`Refusing foreign link: ${link}`)}
 if(receipt && (receipt.schema!==1||receipt.plugin!==fs.realpathSync(pluginDir)||typeof receipt.block!=='string'||!receipt.block.includes(body)))throw Error('Invalid ownership receipt');
 const hasBlock=text?.includes(begin)||text?.includes(end);
 if(hasBlock && (!receipt||text.indexOf(receipt.block)<0||text.indexOf(begin)!==text.lastIndexOf(begin)||text.indexOf(end)!==text.lastIndexOf(end)))throw Error('Refusing modified or unowned managed block');
 if(receipt&&!hasBlock)throw Error('Receipt exists but managed block is missing');
 const external=manifest.dependencies?.[packageName]!==undefined||manifest.dsh?.profile?.bundles?.includes(packageName);
 if(external)throw Error('Refusing external bundle/dependency registration');
 if(action==='status')return {action,profile,installed:!!receipt,link:target,patchManaged:!!hasBlock};
 if(!['install','uninstall'].includes(action))throw Error('Unknown action');
 if(action==='install'){
  if(receipt){if(!ls)throw Error('Managed link missing; inspect before repair');return {action,changed:false,profile}}
  if(text?.includes(packageName)||text?.match(/\bid:\s*['"]?agent-preset-compact\b/))throw Error('Refusing unmanaged preset compact registration');
  const base=text??'';
  const lines=base.split(/\r?\n/).filter(x=>x.trim()&&!x.trim().startsWith('#'));
  const empty=lines.length===1&&lines[0].trim()==='[]';
  if(lines.length&&!empty&&!lines.every((line,index)=>index!==0||/^-\s/.test(line)))throw Error('Only block YAML lists or [] are supported; configuration left unchanged');
  let next,block,replace='';
  if(empty){const match=/^[ \t]*\[\][ \t]*(?:\r?\n|$)/m.exec(base);replace=match[0];block=body;next=base.slice(0,match.index)+body+base.slice(match.index+match[0].length)}
  else {block=(base&&!base.endsWith('\n')?'\n':'')+body;next=base+block}
  const record={schema:1,plugin:fs.realpathSync(pluginDir),block,replace,patchExisted:text!==null,linkCreated:!ls};
  const bak=backup(patch,text);if(!ms)fs.mkdirSync(modules);
  let created=false,wrote=false;
  try {if(!ls){fs.symlinkSync(record.plugin,link,process.platform==='win32'?'junction':'dir');created=true}atomic(patch,text,next);wrote=true;atomic(receiptPath,null,JSON.stringify(record,null,2)+'\n')}
  catch(e){if(wrote&&regular(patch)===next){if(text===null)fs.unlinkSync(patch);else atomic(patch,next,text)}if(created&&stat(link)?.isSymbolicLink()&&path.resolve(modules,fs.readlinkSync(link))===record.plugin)fs.unlinkSync(link);throw e}
  return {action,changed:true,profile,backup:bak};
 }
 if(!receipt)return {action,changed:false,profile};
 const next=text.replace(receipt.block,receipt.replace),bak=backup(patch,text);
 // The exact owned block is removed; all edits outside it survive. A user-added
 // same-target link is never removed unless this installer created it.
 if(!receipt.patchExisted&&next==='')fs.unlinkSync(patch);else atomic(patch,text,next);
 if(receipt.linkCreated&&ls)fs.unlinkSync(link);
 fs.unlinkSync(receiptPath);
 return {action,changed:true,profile,backup:bak};
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
 try {const args=process.argv.slice(2),i=args.indexOf('--profile-dir');
 if(i<0||!args[i+1]||args.filter(x=>x==='--profile-dir').length!==1)throw Error('Usage: node tools/install.mjs --profile-dir ABSOLUTE_PATH [--install|--uninstall|--status]');
 const modes=args.filter(x=>['--install','--uninstall','--status'].includes(x));
 if(modes.length>1||args.some((x,j)=>j!==i&&j!==i+1&&!modes.includes(x)))throw Error('Invalid arguments');
 const result=operate(args[i+1],(modes[0]??'--status').slice(2));console.log(JSON.stringify(result,null,2));
 }catch(e){console.error(e.message);process.exitCode=1}
}
