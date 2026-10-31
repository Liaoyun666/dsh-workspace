import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
const archive = 'E:/Deepseek/resources/app.asar';
const fd = fs.openSync(archive, 'r');
const head = Buffer.alloc(8); fs.readSync(fd, head, 0, 8, 0);
const size = head.readUInt32LE(4), header = Buffer.alloc(size);
fs.readSync(fd, header, 0, size, 8);
const tree = JSON.parse(header.subarray(8, 8 + header.readUInt32LE(4)).toString());
function entry(p) { let n = tree; for (const part of p.split('/')) { n = n.files?.[part]; if (!n) throw Error(`Missing ${p}`); } return n; }
function read(p) { const e = entry(p); if (e.link) return read(e.link); const b = Buffer.alloc(e.size); if (e.unpacked) return fs.readFileSync(`${archive}.unpacked/${p}`); fs.readSync(fd, b, 0, e.size, 8 + size + Number(e.offset)); return b; }
const names = ['dsh-client-ui-agent-preset', 'dsh-client-ui-primitives', 'dsh-client-ui-slots', 'dsh-client-modules', 'dsh-client-ui-renderer'];
const base = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../test/fixtures/local');
for (const name of names) for (const file of ['package.json', 'lib/client.js']) {
 const p = `dsh/node_modules/@deepseek-ai/${name}/${file}`;
 try { const data = read(p); const out = path.join(base, name, file); fs.mkdirSync(path.dirname(out), {recursive:true}); fs.writeFileSync(out, data); console.log(name, file, data.length, createHash('sha256').update(data).digest('hex')); } catch (e) { console.log(e.message); }
}
fs.writeFileSync(path.join(base,'dsh-package.json'),read('dsh/package.json'));
const frontend = 'dsh/node_modules/@deepseek-ai/dsh-web-frontend/dist/assets/index-CN7NIWNw.js';
fs.writeFileSync(path.join(base,'frontend.js'),read(frontend));
for (const file of ['vendor-DcuzkuQH.js','index-V2.css']) { try { fs.writeFileSync(path.join(base,file),read(frontend.replace(/[^/]+$/,file))); } catch {} }
const seed=read(frontend).toString();
fs.writeFileSync(path.join(base,'seed-test.js'),seed.slice(0,seed.lastIndexOf('try{'))+';window.__TEST_SEEDS__=SZ();');
function scan(n,p='') { for(const [k,v] of Object.entries(n.files||{})) { const q=p?`${p}/${k}`:k;if(v.files)scan(v,q);else if(q.includes('dsh-web-frontend/dist/assets/')&&q.endsWith('.css')) { fs.writeFileSync(path.join(base,'frontend.css'),read(q)); console.log('CSS',q); } } }
for(const [k,v] of Object.entries(entry(frontend.replace(/\/[^/]+$/,'' )).files))if(k.endsWith('.css')) {fs.writeFileSync(path.join(base,k),read(frontend.replace(/[^/]+$/,k)));if(k.startsWith('index-'))fs.writeFileSync(path.join(base,'frontend.css'),read(frontend.replace(/[^/]+$/,k)));}
fs.closeSync(fd);
