import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';
import {operate,packageName,pluginDir,body} from '../tools/install.mjs';
const base=path.join(path.dirname(fileURLToPath(import.meta.url)),'install-fixtures');
fs.mkdirSync(base,{recursive:true});
const patch=p=>path.join(p,'cordis.patch.yml');
const receipt=p=>path.join(p,`.${packageName}.json`);
const link=p=>path.join(p,'node_modules',packageName);
const read=p=>fs.readFileSync(patch(p),'utf8');
function fixture(text='- insert:\r\n    - name: keep-me\r\n      config: { secret: fixture-only }\r\n') {
  const p=fs.mkdtempSync(path.join(base,'profile-'));
  fs.writeFileSync(path.join(p,'package.json'),'{}');
  if(text!==null)fs.writeFileSync(patch(p),text);
  return p;
}
function tree(p){const out={};for(const name of fs.readdirSync(p).sort()){const q=path.join(p,name),s=fs.lstatSync(q);out[name]=s.isSymbolicLink()?fs.readlinkSync(q):s.isDirectory()?tree(q):fs.readFileSync(q).toString('base64');}return out;}
function refuseAll(p,pattern){for(const action of ['status','install','uninstall']){const before=tree(p);assert.throws(()=>operate(p,action),pattern);assert.deepEqual(tree(p),before);}}
function mutateReceipt(p,fn){const q=receipt(p),r=JSON.parse(fs.readFileSync(q,'utf8'));fn(r);fs.writeFileSync(q,JSON.stringify(r));}

test('normal/idempotent status read-only and uninstall preserves later user edits',()=>{
  const p=fixture(),original=read(p),before=tree(p);
  assert.equal(operate(p).installed,false);assert.deepEqual(tree(p),before);
  assert.equal(operate(p,'install').changed,true);assert.equal(operate(p).installed,true);
  const once=tree(p);assert.equal(operate(p,'install').changed,false);assert.deepEqual(tree(p),once);
  fs.appendFileSync(patch(p),'# later user edit\n');
  assert.equal(operate(p,'uninstall').changed,true);assert.equal(read(p),original+'# later user edit\n');
  assert.equal(operate(p,'uninstall').changed,false);assert.equal(fs.existsSync(link(p)),false);
  assert.ok(fs.readdirSync(p).some(n=>n.includes('.bak-')));
});
test('[] missing comment no-final-newline CRLF and inert !!js round-trip bytes',()=>{
  for(const original of ['[]\n','[]','\uFEFF[]\r\n','\uFEFF- insert:\n    - name: bom-other\n','  [] # keep comment\r\n','# before\r\n[]\r\n# after\r\n',null,'','# comment','# comment\r\n','- insert:\n    - name: other','- insert:\r\n    - name: other\r\n','- insert:\n    - name: other\n      config:\n        bool: !!js true\n        code: !!js >-\n          (() => { throw new Error("NEVER EXECUTE"); })()\n']) {
    const p=fixture(original);operate(p,'install');assert.equal(operate(p).installed,true);operate(p,'uninstall');
    if(original===null)assert.equal(fs.existsSync(patch(p)),false);else assert.equal(read(p),original);
  }
});
test('same-target preexisting link survives uninstall',()=>{
  const p=fixture();fs.mkdirSync(path.dirname(link(p)));fs.symlinkSync(pluginDir,link(p),'junction');
  const ino=fs.lstatSync(link(p)).ino;operate(p,'install');operate(p,'uninstall');assert.equal(fs.lstatSync(link(p)).ino,ino);
});
test('entities foreign links node_modules aliases rejected',()=>{
  for(const kind of ['entity','foreign','modules-alias']){
    const p=fixture();if(kind==='modules-alias')fs.symlinkSync(base,path.dirname(link(p)),'junction');
    else {fs.mkdirSync(path.dirname(link(p)));if(kind==='entity')fs.mkdirSync(link(p));else fs.symlinkSync(base,link(p),'junction');}
    // Avoid recursively walking a modules alias: inspection itself must not follow it.
    refuseAll(p,/Refusing/);
  }
});
test('malformed YAML mappings boundaries multidoc invalid end and unsupported executable tags rejected',()=>{
  for(const text of ['{ mapping: true }\n','\uFEFF---\n[]\n','- insert: [\n','---\n[]\n---\n[]\n','[]\n...\n','[]\n... invalid\n','- config: !!js/function function () {}\n','null\n','[ ] # unsupported empty spelling\n']){
    const p=fixture(text);const before=tree(p);assert.throws(()=>operate(p,'install'),/YAML|sequence|placeholder/);assert.deepEqual(tree(p),before);
  }
});
test('foreign id/name checked in patch before and AFTER managed installation',()=>{
  for(const registration of ['- insert:\n    - name: dsh-agent-preset-compact\n','- insert:\n    - id: agent-preset-compact\n']) {
    refuseAll(fixture(registration),/unmanaged/);
    const p=fixture();operate(p,'install');fs.appendFileSync(patch(p),registration);refuseAll(p,/outside owned block/);
  }
});
test('manifest dependencies and supported bundles checked before and after install',()=>{
  const manifests=[...['dependencies','devDependencies','optionalDependencies','peerDependencies'].map(k=>({[k]:{[packageName]:'file:foreign'}})),
    {dsh:{profile:{bundles:[packageName]}}},{dsh:{profile:{bundles:{[packageName]:{}}}}},{dsh:{bundles:[packageName]}},{bundles:[{name:packageName}]}];
  for(const m of manifests)for(const installed of [false,true]){const p=fixture();if(installed)operate(p,'install');fs.writeFileSync(path.join(p,'package.json'),JSON.stringify(m));refuseAll(p,/external manifest/);}
});
test('modified duplicate inline and unowned markers rejected',()=>{
  for(const change of [s=>s.replace('id: agent-preset-compact','id: changed'),s=>s+body,s=>s.replace('# BEGIN','prefix # BEGIN'),s=>s.replace('# END',' # END')]) {
    const p=fixture();operate(p,'install');fs.writeFileSync(patch(p),change(read(p)));refuseAll(p,/modified or unowned/);
  }
  refuseAll(fixture(body),/unowned/);
});
test('receipt strict schema prevents block expansion replace abuse and boolean type coercion',()=>{
  for(const mutate of [r=>r.block='user content\n'+r.block,r=>r.block+='user content\n',r=>r.replace='- insert:\n    - name: attacker\n',r=>r.linkCreated='false',r=>r.patchExisted='true',r=>r.patchExisted=1,r=>r.extra=true,r=>r.original.identity.ino=123,r=>r.plugin=base,r=>delete r.linkIdentity]){
    const p=fixture();operate(p,'install');mutateReceipt(p,mutate);refuseAll(p,/Invalid ownership receipt/);
  }
});
test('lock contention does not clear foreign lock; status does not create/touch lock',()=>{
  const p=fixture(),lock=path.join(p,`.${packageName}.lock`);fs.writeFileSync(lock,'{"pid":1,"token":"foreign"}\n');const before=tree(p);
  assert.equal(operate(p).installed,false);assert.deepEqual(tree(p),before);
  assert.throws(()=>operate(p,'install'),/lock exists/);assert.deepEqual(tree(p),before);
  assert.throws(()=>operate(p,'uninstall'),/lock exists/);assert.deepEqual(tree(p),before);
});
test('unknown actions/relative path and invalid CLI flags reject without writes',()=>{
  assert.throws(()=>operate('relative','install'),/absolute/);const p=fixture(),before=tree(p);assert.throws(()=>operate(p,'other'),/Unknown action/);assert.deepEqual(tree(p),before);
  for(const args of [['--profile-dir',p,'--evil'],['--profile-dir',p,'--install','--status'],['--install']]){
    const result=spawnSync(process.execPath,[path.join(pluginDir,'tools/install.mjs'),...args],{encoding:'utf8'});assert.equal(result.status,1);assert.match(result.stderr,/Invalid arguments|Usage/);assert.deepEqual(tree(p),before);
  }
});
test('changed snapshot before install preserves later editor content and refuses overwrite',()=>{
  const p=fixture();assert.throws(()=>operate(p,'install',{at(stage){if(stage==='after-snapshot')fs.appendFileSync(patch(p),'# concurrent edit\n');}}),/Concurrent change/);
  assert.ok(read(p).endsWith('# concurrent edit\n'));assert.equal(fs.existsSync(receipt(p)),false);
});
test('same bytes but new identity rejected',()=>{
  const p=fixture();assert.throws(()=>operate(p,'install',{at(stage){if(stage==='after-snapshot'){const temp=patch(p)+'.replacement';fs.writeFileSync(temp,read(p));fs.renameSync(temp,patch(p));}}}),/Concurrent change/);
  assert.equal(fs.existsSync(receipt(p)),false);
});
test('install injected failures roll back own writes and safely retry',()=>{
  for(const fail of ['before-link','before-receipt-link','before-patch','before-receipt-final']){
    const p=fixture(),original=read(p);assert.throws(()=>operate(p,'install',{at(stage){if(stage===fail)throw Error('injected failure');}}),/injected failure/);
    assert.equal(read(p),original);assert.equal(fs.existsSync(receipt(p)),false);assert.equal(fs.existsSync(link(p)),false);
    operate(p,'install');operate(p,'uninstall');assert.equal(read(p),original);
  }
});
test('uninstall injected failures restore own data/link and retry',()=>{
  for(const fail of ['before-patch','before-link-unlink','before-receipt-unlink']){
    const p=fixture();operate(p,'install');const installed=read(p);
    assert.throws(()=>operate(p,'uninstall',{at(stage){if(stage===fail)throw Error('injected failure');}}),/injected failure/);
    assert.equal(read(p),installed);assert.equal(operate(p).installed,true);operate(p,'uninstall');
  }
});
test('rollback never overwrites later patch edits',()=>{
  const p=fixture();assert.throws(()=>operate(p,'install',{at(stage){if(stage==='before-receipt-final'){fs.appendFileSync(patch(p),'# foreign later write\n');throw Error('injected failure');}}}),/later edit preserved/);
  assert.ok(read(p).endsWith('# foreign later write\n'));assert.throws(()=>operate(p,'install'),/unowned/);
});
test('replacement link is not removed; unknown ownership refused',()=>{
  const p=fixture();operate(p,'install');const tmp=path.join(p,'replacement-junction');fs.symlinkSync(pluginDir,tmp,'junction');fs.unlinkSync(link(p));fs.renameSync(tmp,link(p));
  refuseAll(p,/ownership unknown/);
});
test('interrupted pending receipt explicitly refuses and supplies actionable recovery',()=>{
  const p=fixture();operate(p,'install');mutateReceipt(p,r=>r.state='pending-install');refuseAll(p,/Interrupted pending-install.*Recovery:/);
});
test('CLI default status is strictly read-only',()=>{
  const p=fixture(),before=tree(p);
  const result=spawnSync(process.execPath,[path.join(pluginDir,'tools/install.mjs'),'--profile-dir',p],{encoding:'utf8'});
  assert.equal(result.status,0);assert.equal(JSON.parse(result.stdout).action,'status');assert.deepEqual(tree(p),before);
});
test('absent patch rollback/retry and user additions survive uninstall',()=>{
  const p=fixture(null);
  assert.throws(()=>operate(p,'install',{at(stage){if(stage==='before-receipt-final')throw Error('injected failure');}}),/injected failure/);
  assert.equal(fs.existsSync(patch(p)),false);assert.equal(fs.existsSync(receipt(p)),false);
  operate(p,'install');fs.appendFileSync(patch(p),'# new user comment\n');operate(p,'uninstall');assert.equal(read(p),'# new user comment\n');
});
test('concurrent receipt edits preserved; pending receipt fails closed',()=>{
  const p=fixture();assert.throws(()=>operate(p,'install',{at(stage){if(stage==='before-receipt-final'){
    const r=JSON.parse(fs.readFileSync(receipt(p),'utf8'));r.state='pending-uninstall';fs.writeFileSync(receipt(p),JSON.stringify(r));
  }}}),/Concurrent change.*later edit preserved/);
  assert.equal(JSON.parse(fs.readFileSync(receipt(p),'utf8')).state,'pending-uninstall');
  assert.throws(()=>operate(p),/Interrupted pending-uninstall/);
});
test('changed link immediately before unlink is preserved',()=>{
  const p=fixture();operate(p,'install');
  assert.throws(()=>operate(p,'uninstall',{at(stage){if(stage==='before-link-unlink'){
    const temp=path.join(p,'replacement-link');fs.symlinkSync(pluginDir,temp,'junction');fs.unlinkSync(link(p));fs.renameSync(temp,link(p));
  }}}),/Concurrent change/);
  assert.ok(fs.lstatSync(link(p)).isSymbolicLink());assert.throws(()=>operate(p),/ownership unknown/);
});
