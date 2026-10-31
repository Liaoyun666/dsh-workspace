import fs from 'node:fs';
const s=fs.readFileSync('test/fixtures/local/frontend.js','utf8');
fs.writeFileSync('test/fixtures/local/seed-tail.txt',s.slice(-16000).replaceAll(';',';\n'));
console.log([...s.matchAll(/import[^;]{0,800};/g)].slice(0,5).map(x=>x[0]));
const at=s.indexOf('const Ne='); console.log('Ne',at); console.log(s.slice(s.indexOf('"_viewport'),s.indexOf('"_viewport')+120));
