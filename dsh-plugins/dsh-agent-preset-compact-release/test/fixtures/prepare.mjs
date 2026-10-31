import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {fileURLToPath} from 'node:url';
// 开发副本与发布根是同级的兄弟目录；默认按此相对定位，可用环境变量覆盖。
const here=path.dirname(fileURLToPath(import.meta.url));
const source=process.env.PRESET_COMPACT_FIXTURE_SOURCE
  ?? path.resolve(here,'../../../dsh-agent-preset-compact/test/fixtures/local');
const dest=path.resolve('test/fixtures/local');
const files=['frontend.css','seed-test.js','vendor-DcuzkuQH.js','dsh-client-ui-agent-preset/lib/client.js','dsh-client-ui-agent-preset/package.json','dsh-package.json'];
const hash=data=>crypto.createHash('sha256').update(data).digest('hex');
const manifest={source,fixture:true,files:[]};
for(const name of files){const bytes=fs.readFileSync(path.join(source,name)),to=path.join(dest,name);fs.mkdirSync(path.dirname(to),{recursive:true});fs.writeFileSync(to,bytes);manifest.files.push({name,source:path.join(source,name),sha256:hash(bytes),bytes:bytes.length});}
const official=fs.readFileSync(path.join(source,'frontend.js'),'utf8'),seed=fs.readFileSync(path.join(dest,'seed-test.js'),'utf8');
let common=0;while(common<official.length&&official[common]===seed[common])common++;
manifest.seed={officialSource:path.join(source,'frontend.js'),officialSha256:hash(official),commonPrefixCharacters:common,officialSuffix:official.slice(common),fixtureSuffix:seed.slice(common)};
fs.writeFileSync('test/fixtures/provenance.json',JSON.stringify(manifest,null,2));
console.log('FIXTURE_COPIED',files.length,'SEED_UNCHANGED_PREFIX',common,'PROVENANCE_SHA256',hash(fs.readFileSync('test/fixtures/provenance.json')));
