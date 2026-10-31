import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {operate,packageName} from '../tools/install.mjs';
const base=path.resolve('test/artifacts/install-fixtures');fs.mkdirSync(base,{recursive:true});
function fixture(config='- insert:\r\n    - name: keep-me\r\n      config: { secret: fixture-only }\r\n') {const dir=fs.mkdtempSync(path.join(base,'profile-'));fs.writeFileSync(path.join(dir,'package.json'),'{}');if(config!==null)fs.writeFileSync(path.join(dir,'cordis.patch.yml'),config);return dir}
const read=p=>fs.readFileSync(path.join(p,'cordis.patch.yml'),'utf8');
test('explicit profile, install/status/idempotent/uninstall preserve exact user config',()=>{
 assert.throws(()=>operate('relative','install'),/absolute/);
 const p=fixture(),before=read(p);assert.equal(operate(p).installed,false);
 assert.equal(operate(p,'install').changed,true);assert.equal(operate(p).installed,true);
 const once=read(p);assert.equal(operate(p,'install').changed,false);assert.equal(read(p),once);
 fs.appendFileSync(path.join(p,'cordis.patch.yml'),'# user edit after install\n');
 assert.equal(operate(p,'uninstall').changed,true);assert.equal(read(p),before+'# user edit after install\n');
 assert.equal(operate(p,'uninstall').changed,false);assert.ok(fs.readdirSync(p).some(x=>x.includes('.bak-')));
 assert.equal(fs.existsSync(path.join(p,'node_modules',packageName)),false);
});
test('[]/absent/no-final-newline configurations reversible',()=>{for(const original of ['[]\n',null,'# comment','- insert:\n    - name: other']){const p=fixture(original);operate(p,'install');operate(p,'uninstall');if(original===null)assert.equal(fs.existsSync(path.join(p,'cordis.patch.yml')),false);else assert.equal(read(p),original)}});
test('entity and foreign links rejected without editing',()=>{for(const kind of ['entity','foreign']){const p=fixture(),before=read(p),m=path.join(p,'node_modules');fs.mkdirSync(m);const link=path.join(m,packageName);if(kind==='entity')fs.mkdirSync(link);else fs.symlinkSync(base,link,'junction');assert.throws(()=>operate(p,'install'),/Refusing (entity|foreign link)/);assert.equal(read(p),before);assert.ok(fs.lstatSync(link));}});
test('same-target unowned link preserved; edited block and external registrations rejected',()=>{
 const p=fixture(),link=path.join(p,'node_modules',packageName);fs.mkdirSync(path.dirname(link));fs.symlinkSync(path.resolve('.'),link,'junction');operate(p,'install');operate(p,'uninstall');assert.ok(fs.lstatSync(link).isSymbolicLink());
 const q=fixture();operate(q,'install');fs.writeFileSync(path.join(q,'cordis.patch.yml'),read(q).replace('id: agent-preset-compact','id: changed'));const before=read(q);assert.throws(()=>operate(q,'uninstall'),/modified or unowned/);assert.equal(read(q),before);
 const r=fixture(`- insert:\n    - name: ${packageName}\n`);assert.throws(()=>operate(r,'install'),/unmanaged/);
 const s=fixture();fs.writeFileSync(path.join(s,'package.json'),JSON.stringify({dependencies:{[packageName]:'file:elsewhere'}}));assert.throws(()=>operate(s,'install'),/external/);
 const t=fixture('{ unsupported: mapping }\n');assert.throws(()=>operate(t,'install'),/Only block YAML/);
});
