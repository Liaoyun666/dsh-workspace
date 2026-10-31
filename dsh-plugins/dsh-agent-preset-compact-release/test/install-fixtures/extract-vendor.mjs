import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
const archive='E:/Deepseek/resources/app.asar';
const fd=fs.openSync(archive,'r');
const head=Buffer.alloc(8);fs.readSync(fd,head,0,8,0);
const size=head.readUInt32LE(4),header=Buffer.alloc(size);fs.readSync(fd,header,0,size,8);
const tree=JSON.parse(header.subarray(8,8+header.readUInt32LE(4)).toString());
function read(p){let e=tree;for(const part of p.split('/')){e=e.files?.[part];if(!e)throw Error(`Missing ${p}`)}if(e.link)return read(e.link);if(e.unpacked)return fs.readFileSync(`${archive}.unpacked/${p}`);const b=Buffer.alloc(e.size);fs.readSync(fd,b,0,e.size,8+size+Number(e.offset));return b;}
const base='dsh/node_modules/js-yaml/';
const pkg=JSON.parse(read(base+'package.json'));console.log(JSON.stringify({name:pkg.name,version:pkg.version,module:pkg.module}));
const dest=path.resolve('tools/vendor');fs.mkdirSync(dest,{recursive:true});
for(const [src,name] of [['dist/js-yaml.mjs','js-yaml.mjs'],['LICENSE','js-yaml.LICENSE']]){const bytes=read(base+src);const out=path.join(dest,name);fs.writeFileSync(out,bytes,{flag:'wx'});console.log(name,bytes.length,createHash('sha256').update(bytes).digest('hex'));}
fs.closeSync(fd);
