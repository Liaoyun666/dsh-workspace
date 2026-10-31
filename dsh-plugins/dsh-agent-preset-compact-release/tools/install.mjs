import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {randomUUID} from 'node:crypto';
import {TextDecoder} from 'node:util';
import {loadAll, DEFAULT_SCHEMA, Type} from './vendor/js-yaml.mjs';

export const packageName = 'dsh-agent-preset-compact';
export const pluginDir = fs.realpathSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'));
const id = 'agent-preset-compact';
const begin = `# BEGIN ${packageName} managed v1`;
const end = `# END ${packageName} managed v1`;
export const body = `${begin}\n- insert:\n    - id: ${id}\n      name: ${packageName}\n${end}\n`;
// !!js is DATA, never eval/Function. Unknown tags (including !!js/function) fail closed.
const schema = DEFAULT_SCHEMA.extend([new Type('tag:yaml.org,2002:js', {
  kind: 'scalar', resolve: () => true, construct: value => value,
})]);
const decoder = new TextDecoder('utf-8', {fatal: true, ignoreBOM: true});
const identity = s => ({dev: String(s.dev), ino: String(s.ino), birthtimeNs: String(s.birthtimeNs)});
const equal = (a, b) => JSON.stringify(a) === JSON.stringify(b);
function lstat(p) {try {return fs.lstatSync(p, {bigint: true});} catch (e) {if (e.code === 'ENOENT') return null; throw e;}}
function snapshot(p, required = false) {
  const s = lstat(p);
  if (!s) {if (required) throw Error(`Missing file: ${p}`); return null;}
  if (!s.isFile() || s.isSymbolicLink()) throw Error(`Refusing non-regular file: ${p}`);
  const fd = fs.openSync(p, 'r');
  try {
    if (!equal(identity(s), identity(fs.fstatSync(fd, {bigint: true})))) throw Error(`Concurrent change: ${p}`);
    const content = decoder.decode(fs.readFileSync(fd));
    if (!equal(identity(s), identity(lstat(p) ?? {}))) throw Error(`Concurrent change: ${p}`);
    return {identity: identity(s), content};
  } finally {fs.closeSync(fd);}
}
function directory(p, required = false) {
  const s = lstat(p);
  if (!s) {if (required) throw Error(`Missing directory: ${p}`); return null;}
  if (!s.isDirectory() || s.isSymbolicLink()) throw Error(`Refusing directory alias/entity: ${p}`);
  return identity(s);
}
function linkState(p) {
  const s = lstat(p); if (!s) return null;
  if (!s.isSymbolicLink()) throw Error(`Refusing entity: ${p}`);
  const target = path.resolve(path.dirname(p), fs.readlinkSync(p));
  if (target !== pluginDir) throw Error(`Refusing foreign link: ${p}`);
  return {identity: identity(s), target};
}
function parsePatch(text) {
  // Explicit document boundaries are disallowed, even a single document. This
  // avoids appending beyond ... or accidentally creating a second document.
  if (/^\uFEFF?(?:---|\.\.\.)(?:[ \t#\r]|$)/m.test(text)) throw Error('Refusing YAML document boundary');
  let docs;
  try {docs = loadAll(text, undefined, {schema});} catch {throw Error('Invalid YAML patch (parser rejected input; configuration not printed)');}
  if (docs.length > 1) throw Error('Refusing multiple YAML documents');
  const value = docs[0];
  if (value == null && text.split(/\r?\n/).every(x => !x.trim() || x.trimStart().startsWith('#'))) return [];
  if (!Array.isArray(value)) throw Error('YAML patch must be a top-level sequence');
  return value;
}
function foreignPatch(value, seen = new Set()) {
  if (!value || typeof value !== 'object' || seen.has(value)) return false;
  seen.add(value);
  if (!Array.isArray(value) && (value.id === id || value.name === packageName)) return true;
  return Object.values(value).some(v => foreignPatch(v, seen));
}
function manifestCheck(text) {
  let m; try {m = JSON.parse(text);} catch {throw Error('Invalid profile package manifest');}
  if (!m || typeof m !== 'object' || Array.isArray(m)) throw Error('Invalid profile package manifest');
  for (const key of ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies']) {
    if (m[key] != null && (typeof m[key] !== 'object' || Array.isArray(m[key]))) throw Error('Invalid manifest dependency map');
    if (m[key] && Object.hasOwn(m[key], packageName)) throw Error('Refusing external manifest dependency registration');
  }
  // DSH profile bundles are supported at dsh.profile.bundles; also reject the
  // older dsh.bundles/top-level bundles forms rather than assume ownership.
  for (const bundles of [m.dsh?.profile?.bundles, m.dsh?.bundles, m.bundles]) {
    if (bundles == null) continue;
    if (!Array.isArray(bundles) && (typeof bundles !== 'object')) throw Error('Invalid manifest bundles');
    if (JSON.stringify(bundles).includes(packageName) || JSON.stringify(bundles).includes(id)) throw Error('Refusing external manifest bundle registration');
  }
}
function strictKeys(o, keys) {return o && typeof o === 'object' && !Array.isArray(o) && equal(Object.keys(o).sort(), [...keys].sort());}
function validIdentity(o) {return strictKeys(o, ['dev','ino','birthtimeNs']) && Object.values(o).every(v => typeof v === 'string' && /^\d+$/.test(v));}
function validSnapshot(o) {return o === null || (strictKeys(o, ['identity','content']) && validIdentity(o.identity) && typeof o.content === 'string');}
function plan(text) {
  const base = text ?? ''; const parsed = parsePatch(base);
  const match = /^\uFEFF?[ \t]*\[\][ \t]*(?:#[^\r\n]*)?(?:\r?\n|$)/m.exec(base);
  if (parsed.length === 0 && match) {
    const replace = match[0]; const block = body;
    return {block, replace, next: base.slice(0,match.index) + block + base.slice(match.index+replace.length)};
  }
  if (parsed.length === 0 && base.split(/\r?\n/).some(x => x.trim() && !x.trimStart().startsWith('#'))) throw Error('Empty sequence must use an explicit [] placeholder');
  const block = (base && !base.endsWith('\n') ? '\n' : '') + body;
  return {block, replace: '', next: base + block};
}
function receiptParse(s) {
  if (!s) return null;
  let r; try {r = JSON.parse(s.content);} catch {throw Error('Invalid ownership receipt');}
  const keys = ['schema','plugin','state','block','replace','patchExisted','linkCreated','original','linkIdentity'];
  if (!strictKeys(r, keys) || r.schema !== 1 || r.plugin !== pluginDir || !['installed','pending-install','pending-uninstall'].includes(r.state) ||
      ![body, '\n'+body].includes(r.block) || typeof r.replace !== 'string' || typeof r.patchExisted !== 'boolean' || typeof r.linkCreated !== 'boolean' ||
      !validSnapshot(r.original) || r.patchExisted !== (r.original !== null) || !(r.linkIdentity === null || validIdentity(r.linkIdentity))) throw Error('Invalid ownership receipt');
  let expected; try {expected = plan(r.original?.content ?? null);} catch {throw Error('Invalid ownership receipt original');}
  if (expected.block !== r.block || expected.replace !== r.replace || (r.replace !== '' && !/^\uFEFF?[ \t]*\[\][ \t]*(?:#[^\r\n]*)?(?:\r?\n|$)$/.test(r.replace))) throw Error('Invalid ownership receipt block/replace');
  if (r.state === 'installed' && r.linkCreated && !r.linkIdentity) throw Error('Invalid ownership receipt link identity');
  return r;
}
function unmanaged(text, r) {
  const source = text ?? '';
  const b = source.split(begin).length - 1, e = source.split(end).length - 1;
  if (!r && (b || e)) throw Error('Refusing modified or unowned managed block; recovery: see docs/install.md, then rerun --status');
  if (r && r.state === 'installed') {
    const at = source.indexOf(r.block);
    if (b !== 1 || e !== 1 || at < 0 || (r.block === body && at > 0 && source[at-1] !== '\n') || source.indexOf(r.block,at+1) !== -1) throw Error('Refusing modified or unowned managed block');
    const outside = source.slice(0,at) + r.replace + source.slice(at+r.block.length);
    if (foreignPatch(parsePatch(outside))) throw Error('Refusing unmanaged patch registration outside owned block');
    parsePatch(source);
    return outside;
  }
  if (foreignPatch(parsePatch(source))) throw Error('Refusing unmanaged patch registration');
  return source;
}
function recoveryError(r, profile) {
  return Error(`Interrupted ${r.state}; no automatic ownership inference. Recovery: inspect backups and receipt as described in docs/install.md; run node tools/install.mjs --profile-dir "${profile}" --status after manual reconciliation. Do not delete a lock belonging to a live PID.`);
}

// Hooks are import-only failure/race injection for isolated tests, not CLI flags.
export function operate(profileDir, action = 'status', hooks = {}) {
  if (!['status','install','uninstall'].includes(action)) throw Error('Unknown action');
  if (typeof profileDir !== 'string' || !path.isAbsolute(profileDir)) throw Error('--profile-dir must be absolute');
  const profile = fs.realpathSync(profileDir);
  directory(profile, true);
  const patch = path.join(profile,'cordis.patch.yml'), receiptPath = path.join(profile,`.${packageName}.json`);
  const modules = path.join(profile,'node_modules'), link = path.join(modules,packageName);
  const manifestPath = path.join(profile,'package.json'), lockPath = path.join(profile,`.${packageName}.lock`);
  let lock = null, lockFd = null;
  if (action !== 'status') {
    try {lockFd = fs.openSync(lockPath,'wx');} catch (e) {if (e.code === 'EEXIST') throw Error(`Installer lock exists: ${lockPath}; inspect its PID manually (docs/install.md)`); throw e;}
    fs.writeFileSync(lockFd,JSON.stringify({pid:process.pid,action,token:randomUUID()})+'\n');
    lock = snapshot(lockPath);
  }
  const changes = [];
  let state;
  const tick = stage => hooks.at?.(stage,{profile,patch,receiptPath,link,lockPath});
  const guard = () => {
    if (!equal(snapshot(patch),state.patch) || !equal(snapshot(receiptPath),state.receipt) || !equal(linkState(link),state.link) ||
        !equal(directory(modules),state.modules) || !equal(snapshot(manifestPath,true),state.manifest)) throw Error('Concurrent change: snapshot/identity mismatch; no overwrite');
  };
  function atomic(p, old, content, key, stage) {
    const temp = `${p}.tmp-${randomUUID()}`;
    fs.writeFileSync(temp,content,{flag:'wx'});
    const ownTemp = snapshot(temp);
    try {
      tick(stage); guard();
      if (!equal(snapshot(p),old)) throw Error(`Concurrent change: ${p}`);
      fs.renameSync(temp,p);
      const after = {identity:ownTemp.identity,content};
      state[key] = after; changes.push({kind:'file',p,key,before:old,after});
    } finally {if (equal(snapshot(temp),ownTemp)) fs.unlinkSync(temp);}
  }
  function removeFile(p, old, key, stage) {
    tick(stage); guard();
    if (!equal(snapshot(p),old)) throw Error(`Concurrent change: ${p}`);
    fs.unlinkSync(p); state[key] = null; changes.push({kind:'file',p,key,before:old,after:null});
  }
  function receiptWrite(r, stage) {atomic(receiptPath,state.receipt,JSON.stringify(r,null,2)+'\n','receipt',stage);}
  function backup() {
    if (!state.patch) return null;
    const out = `${patch}.bak-${packageName}-${randomUUID()}`;
    guard();fs.writeFileSync(out,state.patch.content,{flag:'wx'});return out;
  }
  try {
    state = {patch:snapshot(patch),receipt:snapshot(receiptPath),link:linkState(link),modules:directory(modules),manifest:snapshot(manifestPath,true)};
    const r = receiptParse(state.receipt);
    manifestCheck(state.manifest.content);
    // Always detect external conflicts, including after installation; never
    // early-return just because a receipt exists.
    if (r && r.state !== 'installed') {
      const source = state.patch?.content ?? '';
      const count = source.split(r.block).length-1;
      const outside = count === 1 ? source.replace(r.block,r.replace) : source;
      if (foreignPatch(parsePatch(outside))) throw Error('Refusing unmanaged patch registration during interrupted transaction');
      throw recoveryError(r,profile);
    }
    const outside = unmanaged(state.patch?.content,r);
    if (r && (!state.link || (r.linkCreated && !equal(state.link.identity,r.linkIdentity)))) throw Error('Managed link missing/replaced; ownership unknown; recovery: see docs/install.md');
    guard();
    if (action === 'status') return {action,profile,installed:!!r,link:state.link?.target ?? null,patchManaged:!!r};
    tick('after-snapshot');guard();
    if (action === 'install' && r) return {action,profile,changed:false};
    if (action === 'uninstall' && !r) return {action,profile,changed:false};
    const planned = action === 'install' ? plan(state.patch?.content ?? null) : null;
    if (planned) parsePatch(planned.next);
    const bak = backup();
    if (action === 'install') {
      const record = {schema:1,plugin:pluginDir,state:'pending-install',block:planned.block,replace:planned.replace,
        patchExisted:state.patch!==null,linkCreated:state.link===null,original:state.patch,linkIdentity:state.link?.identity ?? null};
      receiptWrite(record,'before-receipt-pending');
      if (!state.modules) {
        tick('before-modules');guard();fs.mkdirSync(modules);state.modules=directory(modules);
        // Retain an empty node_modules on rollback: never remove an unrelated directory.
      }
      if (!state.link) {
        tick('before-link');guard();fs.symlinkSync(pluginDir,link,process.platform==='win32'?'junction':'dir');
        state.link=linkState(link);changes.push({kind:'link-create',p:link,after:state.link});
        record.linkIdentity=state.link.identity;receiptWrite(record,'before-receipt-link');
      }
      atomic(patch,state.patch,planned.next,'patch','before-patch');
      record.state='installed';receiptWrite(record,'before-receipt-final');
    } else {
      receiptWrite({...r,state:'pending-uninstall'},'before-receipt-pending');
      parsePatch(outside);
      if (!r.patchExisted && outside === '') removeFile(patch,state.patch,'patch','before-patch-unlink');
      else atomic(patch,state.patch,outside,'patch','before-patch');
      if (r.linkCreated) {
        tick('before-link-unlink');guard();
        if (!equal(linkState(link),state.link) || !equal(state.link.identity,r.linkIdentity)) throw Error('Managed link replaced; refusing unlink');
        const before=state.link;fs.unlinkSync(link);state.link=null;changes.push({kind:'link-remove',p:link,before});
      }
      removeFile(receiptPath,state.receipt,'receipt','before-receipt-unlink');
    }
    return {action,profile,changed:true,backup:bak};
  } catch (e) {
    const issues=[];
    for (const c of changes.reverse()) {
      try {
        if (c.kind === 'file') {
          if (!equal(snapshot(c.p),c.after)) {issues.push(`later edit preserved: ${c.p}`);continue;}
          if (c.before === null) {if (!equal(snapshot(c.p),c.after)) throw Error('rollback identity changed');fs.unlinkSync(c.p);}
          else {
            const temp=`${c.p}.tmp-${randomUUID()}`;fs.writeFileSync(temp,c.before.content,{flag:'wx'});
            const ownTemp=snapshot(temp);
            try {
              if (!equal(snapshot(c.p),c.after)) {issues.push(`later edit preserved: ${c.p}`);continue;}
              fs.renameSync(temp,c.p);
            } finally {if (equal(snapshot(temp),ownTemp)) fs.unlinkSync(temp);}
          }
          // Earlier receipt writes refer to old inode identities. Rebind only
          // rollback entries whose bytes match our just-restored owned value.
          const now=snapshot(c.p);
          for (const prev of changes) if (prev!==c && prev.kind==='file' && prev.p===c.p && equal(prev.after,c.before)) prev.after=now;
        } else if (c.kind === 'link-create') {
          if (equal(linkState(c.p),c.after)) fs.unlinkSync(c.p);else issues.push(`later link preserved: ${c.p}`);
        } else {
          // Cannot recreate the deleted inode and still claim old receipt
          // ownership. Restore availability, but flag receipt reconciliation.
          if (lstat(c.p) === null) {fs.symlinkSync(pluginDir,c.p,process.platform==='win32'?'junction':'dir');
            const newIdentity=linkState(c.p).identity;
            for (const prev of changes) if (prev.kind==='file' && prev.p===receiptPath && prev.before) {
              const data=JSON.parse(prev.before.content);data.linkIdentity=newIdentity;prev.before={...prev.before,content:JSON.stringify(data,null,2)+'\n'};
            }
          } else issues.push(`later link preserved: ${c.p}`);
        }
      } catch (rollback) {issues.push(`rollback refused/failed: ${rollback.message}`);}
    }
    if (issues.length) e.message += `; ${issues.join('; ')}; recovery: docs/install.md`;
    throw e;
  } finally {
    if (lockFd !== null) fs.closeSync(lockFd);
    if (lock && equal(snapshot(lockPath),lock)) fs.unlinkSync(lockPath);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const args=process.argv.slice(2), index=args.indexOf('--profile-dir');
    if (index<0 || !args[index+1] || args.filter(v=>v==='--profile-dir').length!==1) throw Error('Usage: node tools/install.mjs --profile-dir ABSOLUTE_PATH [--install|--uninstall|--status]');
    const modes=args.filter(v=>['--install','--uninstall','--status'].includes(v));
    if (modes.length>1 || args.some((v,i)=>i!==index && i!==index+1 && !modes.includes(v))) throw Error('Invalid arguments');
    console.log(JSON.stringify(operate(args[index+1],(modes[0]??'--status').slice(2)),null,2));
  } catch (e) {console.error(e.message);process.exitCode=1;}
}
