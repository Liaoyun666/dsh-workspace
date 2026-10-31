// DSH local component: Unity modelling bridge.
// Drop-in at %USERPROFILE%\.dsh\data\dsh-work-components\local-components\unity-dsh\index.mjs
// Registers MCP server "unity" (tools mcp__unity__*) backed by mcp-server/server.mjs,
// which talks to the C# editor bridge inside Unity (127.0.0.1:6401).
import fs from 'node:fs';
import path from 'node:path';
import { stdio, OFF, appRunning, noAppFor, result, tcpOpen } from 'dsh-work-components/sdk';

export const id = 'unity-dsh';

export const meta = {
  id,
  title: 'Unity（DSH 建模桥）',
  group: '游戏引擎',
  serverName: 'unity',
  summary: '在 Unity 编辑器里直接建模：读取场景、创建物体与材质、跑 C# 片段、截图。需要 Unity 打开着并加载 DSH 桥包（菜单 DSH/Unity Bridge）。工程与 Unity 路径写在 E:\\工作区\\unity-mcp\\config.json。'
};

export const app = {
  name: 'Unity',
  exe: 'Unity.exe',
  match: /^unity$/
};

const ROOT = 'E:\\工作区\\unity-mcp';
const SERVER = path.join(ROOT, 'mcp-server', 'server.mjs');
const CONFIG = path.join(ROOT, 'config.json');
const DEFAULT_NODE = 'C:/Users/user\\.dsh\\dsh-runtimes\\dsh-primary-runtime\\dependencies\\node\\bin\\node.exe';

function readConfig() {
  try { return JSON.parse(fs.readFileSync(CONFIG, 'utf8')); } catch { return {}; }
}

function nodeExe() {
  if (fs.existsSync(DEFAULT_NODE)) return { command: DEFAULT_NODE, env: {} };
  const systemNode = 'C:\\Program Files\\nodejs\\node.exe';
  if (fs.existsSync(systemNode)) return { command: systemNode, env: {} };
  // Fall back to the host executable; ELECTRON_RUN_AS_NODE makes an Electron binary behave as Node.
  const env = /node\.exe$/i.test(process.execPath) ? {} : { ELECTRON_RUN_AS_NODE: '1' };
  return { command: process.execPath, env };
}

export async function probe(ctx) {
  const procs = await ctx.procs();
  if (!appRunning(procs, app)) return noAppFor(app);
  const cfg = readConfig();
  const port = Number(cfg.port) || 6401;
  if (!(await tcpOpen('127.0.0.1', port))) {
    return result('unreachable', 'Unity 正在运行，但 DSH 桥未监听 ' + port + '：在 Unity 菜单打开 DSH/Unity Bridge 并点「启动」', 'socket');
  }
  return result('connected', '桥已连接 127.0.0.1:' + port, 'socket');
}

export const component = {
  id,
  label: meta.title,
  serverName: meta.serverName,
  summary: meta.summary,
  // Only <id>Enabled is persisted by the host for local components; everything else lives in config.json.
  keys: ['unity-dshEnabled'],

  installed() {
    return fs.existsSync(SERVER);
  },

  launch(cfg) {
    if (cfg['unity-dshEnabled'] !== true) return OFF;
    if (!fs.existsSync(SERVER)) return { ok: false, reason: '缺少 MCP server：' + SERVER, missing: [SERVER] };
    const conf = readConfig();
    const node = nodeExe();
    return stdio(meta.serverName, node.command, [SERVER], {
      cwd: ROOT,
      env: {
        ...node.env,
        UNITY_DSH_CONFIG: CONFIG,
        UNITY_DSH_PORT: String(conf.port || 6401),
        UNITY_DSH_PROJECT: conf.projectPath || '',
        UNITY_DSH_UNITY_EXE: conf.unityExe || ''
      }
    });
  }
};

export default component;
