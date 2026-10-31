// End-to-end smoke test: drives the real Unity editor through mcp-server/server.mjs.
// Usage: node mcp-server/test/smoke.mjs [--keep]
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SERVER = path.resolve(HERE, '..', 'server.mjs');
const ROOT = path.resolve(HERE, '..');
const SHOTS = path.resolve(HERE, '..', '..', 'screenshots');
fs.mkdirSync(SHOTS, { recursive: true });
const KEEP = process.argv.includes('--keep');

const child = spawn(process.execPath, [SERVER], { cwd: ROOT, stdio: ['pipe', 'pipe', 'pipe'] });
const rl = readline.createInterface({ input: child.stdout });
const pending = new Map();
let nextId = 1;
const protocolErrors = [];

rl.on('line', (line) => {
  let msg;
  try { msg = JSON.parse(line); } catch { protocolErrors.push('non-JSON on stdout: ' + line.slice(0, 200)); return; }
  if (msg.id === undefined || msg.id === null) return;
  const p = pending.get(msg.id);
  if (!p) return;
  pending.delete(msg.id);
  if (msg.error) p.reject(new Error(msg.error.message + ' (code ' + msg.error.code + ')'));
  else p.resolve(msg.result);
});
child.stderr.on('data', (b) => process.stderr.write('[server stderr] ' + b));
child.on('exit', (code) => {
  for (const p of pending.values()) p.reject(new Error('server exited with code ' + code));
});

function rpc(method, params) {
  const id = nextId++;
  const payload = JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n';
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    child.stdin.write(payload);
    setTimeout(() => { if (pending.delete(id)) reject(new Error('timeout: ' + method)); }, 180000);
  });
}
function call(name, args = {}) { return rpc('tools/call', { name, arguments: args }); }
function text(result) {
  const c = result?.content ?? [];
  return c.filter((x) => x.type === 'text').map((x) => x.text).join('\n');
}
let failures = 0;
function check(label, ok, detail = '') {
  console.log((ok ? 'PASS ' : 'FAIL ') + label + (detail ? ' — ' + detail : ''));
  if (!ok) failures++;
}

try {
  const init = await rpc('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'dsh-smoke', version: '0.1.0' } });
  check('initialize', !!init?.serverInfo);
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');

  const list = await rpc('tools/list', {});
  check('tools/list', Array.isArray(list.tools) && list.tools.length >= 20, (list.tools?.length ?? 0) + ' tools');

  const status = await call('status');
  const statusText = text(status);
  console.log('status: ' + statusText.slice(0, 300));
  check('status sees Unity bridge', !status.isError && !/unreachable|ECONNREFUSED/i.test(statusText));

  const info = await call('project_info');
  console.log('project: ' + text(info).slice(0, 300));

  const scene = await call('new_scene', { setup: true });
  check('new_scene', !scene.isError, text(scene).slice(0, 120));

  const cube = await call('create_primitive', { type: 'Cube', name: 'DSH_Cube', position: [0, 0.5, 0] });
  check('create_primitive', !cube.isError, text(cube).slice(0, 160));

  const mat = await call('create_material', { name: 'DSH_Red', color: '#CC3322' });
  check('create_material', !mat.isError, text(mat).slice(0, 160));

  const sceneInfo = await call('scene_info');
  const sceneText = text(sceneInfo);
  check('scene_info lists the cube', /DSH_Cube/.test(sceneText), (sceneText.match(/DSH_Cube/g) || []).length + ' hit(s)');

  const shotPath = path.join(SHOTS, 'smoke.png');
  try { fs.rmSync(shotPath, { force: true }); } catch {}
  const shot = await call('screenshot', { path: shotPath, width: 1280, height: 720, view: 'auto' });
  check('screenshot', !shot.isError && fs.existsSync(shotPath) && fs.statSync(shotPath).size > 5000, fs.existsSync(shotPath) ? fs.statSync(shotPath).size + ' bytes' : 'missing');
  check('screenshot returns image content', (shot.content ?? []).some((x) => x.type === 'image'));

  const exec = await call('execute_code', { code: 'return "cube=" + GameObject.Find("DSH_Cube").name;' });
  const execText = text(exec);
  check('execute_code', !exec.isError && /cube=DSH_Cube/.test(execText), execText.slice(0, 160));

  fs.mkdirSync('E:\\Unity\\DSHProject\\Assets\\Scenes', { recursive: true });
  const save = await call('save_scene', { path: 'Assets/Scenes/Smoke.unity' });
  check('save_scene', !save.isError, text(save).slice(0, 160));

  if (!KEEP) {
    const del = await call('delete_object', { target: 'DSH_Cube' });
    console.log('cleanup delete: ' + text(del).slice(0, 120));
  }

  check('stdout protocol clean', protocolErrors.length === 0, protocolErrors.join(' | '));
} catch (err) {
  console.log('FATAL ' + err.message);
  failures++;
} finally {
  child.stdin.end();
  setTimeout(() => { try { child.kill(); } catch {} }, 500);
}
console.log(failures === 0 ? 'SMOKE OK' : 'SMOKE FAILED (' + failures + ')');
process.exitCode = failures === 0 ? 0 : 1;
