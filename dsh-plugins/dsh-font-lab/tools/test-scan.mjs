import { scanFonts } from '../lib/scan.js'
const t0 = Date.now()
const data = scanFonts()
const ms = Date.now() - t0
const cats = new Map()
for (const f of data.families) cats.set(f.category, (cats.get(f.category) || 0) + 1)
console.log(JSON.stringify({
  ms, files: data.files, parsed: data.parsed, failed: data.failed, families: data.families.length,
  dirs: data.dirs,
  cats: [...cats.entries()].sort((a,b)=>b[1]-a[1]),
  cjk: data.families.filter(f=>f.cjk).length,
  multi: data.families.filter(f=>f.weights.length>1).length,
  sample: data.families.slice(0,4),
}, null, 1))
