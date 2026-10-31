import fs from 'node:fs';
const s=fs.readFileSync('test/fixtures/local/frontend.js','utf8');
const at=s.indexOf('role:"menuitem"');
fs.writeFileSync('test/fixtures/local/menu-excerpt.txt',s.slice(at-15000,at+7000).replaceAll(';',';\n'));
console.log('menu offset',at,'head',s.slice(0,250),'tail',s.slice(-400));
