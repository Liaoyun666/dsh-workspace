#!/usr/bin/env node
/**
 * unity-mcp -- Unity DSH 的 Node 侧 MCP server
 *
 * 传输：MCP stdio，换行分隔的 JSON-RPC 2.0（每行一个 JSON 对象，不是 LSP 的 Content-Length 头）。
 * 日志：全部写 stderr，stdout 只允许出现 JSON-RPC 报文。
 * 依赖：零第三方依赖，Node 22 ESM。
 *
 * 与 Unity 编辑器里的 C# 桥通过本机 TCP 通信，协议见 ../docs/PROTOCOL.md：
 *   请求 {"id","command","params"} / 成功 {"id","status":"ok","result"} / 失败 {"id","status":"error","error"}
 */

import net from "node:net";
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const SERVER_NAME = "unity-dsh";
const SERVER_VERSION = "0.1.0";
const DEFAULT_PROTOCOL_VERSION = "2024-11-05";

/** 默认配置（可被 config.json 与环境变量覆盖） */
const DEFAULTS = {
  host: "127.0.0.1",
  port: 6401,
  projectPath: "E:\\Unity\\DSHProject",
  unityExe: "E:\\Unity\\2019.4.15f1\\Editor\\Unity.exe",
  timeoutMs: 180000, // 单条桥命令超时
  launchTimeoutMs: 120000, // launch 等待桥上线的最长时间
};

function log() {
  // 所有日志只走 stderr，绝不能污染 stdout 的 JSON-RPC 流
  const parts = [];
  for (let i = 0; i < arguments.length; i += 1) {
    const a = arguments[i];
    parts.push(typeof a === "string" ? a : JSON.stringify(a));
  }
  process.stderr.write("[unity-dsh] " + parts.join(" ") + "\n");
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** 读取配置：环境变量 > config.json > 内置默认值 */
function loadConfig() {
  const cfg = { ...DEFAULTS };
  const configPath = process.env.UNITY_DSH_CONFIG || path.resolve(__dirname, "..", "config.json");

  try {
    if (fs.existsSync(configPath)) {
      const raw = JSON.parse(fs.readFileSync(configPath, "utf8"));
      const keys = ["host", "port", "projectPath", "unityExe", "timeoutMs", "launchTimeoutMs"];
      for (const key of keys) {
        if (raw && raw[key] !== undefined && raw[key] !== null && raw[key] !== "") cfg[key] = raw[key];
      }
    }
  } catch (err) {
    log("读取配置失败（" + configPath + "）：" + err.message + "，改用默认值/环境变量");
  }

  const envPort = process.env.UNITY_DSH_PORT;
  const envTimeout = process.env.UNITY_DSH_TIMEOUT_MS;
  const envLaunchTimeout = process.env.UNITY_DSH_LAUNCH_TIMEOUT_MS;

  if (envPort !== undefined && envPort !== "") cfg.port = Number(envPort);
  if (process.env.UNITY_DSH_HOST) cfg.host = process.env.UNITY_DSH_HOST;
  if (process.env.UNITY_DSH_PROJECT) cfg.projectPath = process.env.UNITY_DSH_PROJECT;
  if (process.env.UNITY_DSH_UNITY_EXE) cfg.unityExe = process.env.UNITY_DSH_UNITY_EXE;
  if (envTimeout !== undefined && envTimeout !== "") cfg.timeoutMs = Number(envTimeout);
  if (envLaunchTimeout !== undefined && envLaunchTimeout !== "") cfg.launchTimeoutMs = Number(envLaunchTimeout);

  if (!Number.isInteger(cfg.port) || cfg.port <= 0 || cfg.port > 65535) {
    log("端口配置非法（" + cfg.port + "），回退到 " + DEFAULTS.port);
    cfg.port = DEFAULTS.port;
  }
  if (!Number.isFinite(cfg.timeoutMs) || cfg.timeoutMs <= 0) cfg.timeoutMs = DEFAULTS.timeoutMs;
  if (!Number.isFinite(cfg.launchTimeoutMs) || cfg.launchTimeoutMs <= 0) cfg.launchTimeoutMs = DEFAULTS.launchTimeoutMs;
  return cfg;
}

const CONFIG = loadConfig();

/* ------------------------------------------------------------------ */
/* 桥客户端                                                            */
/* ------------------------------------------------------------------ */

class BridgeError extends Error {
  constructor(message, code) {
    super(message);
    this.name = "BridgeError";
    this.code = code || "BRIDGE_ERROR";
  }
}

function connectionErrorMessage(err) {
  const code = err && err.code ? "（" + err.code + "）" : "";
  return (
    "无法连接 Unity 桥 " + CONFIG.host + ":" + CONFIG.port + code + "：Unity 未启动，或 DSH Bridge 未加载。" +
    "请先启动 Unity 编辑器，并在菜单 DSH/Unity Bridge 打开桥监听；也可以调用 launch 工具自动启动 Unity。"
  );
}

/** 探测 TCP 端口是否可连（launch / 状态判断用），永不抛错 */
function probeTcp(host, port, timeoutMs) {
  const limit = typeof timeoutMs === "number" ? timeoutMs : 1500;
  return new Promise((resolve) => {
    let settled = false;
    const socket = net.connect({ host, port });
    const finish = (ok) => {
      if (settled) return;
      settled = true;
      try {
        socket.destroy();
      } catch {
        /* ignore */
      }
      resolve(ok);
    };
    socket.setTimeout(limit, () => finish(false));
    socket.once("connect", () => finish(true));
    socket.once("error", () => finish(false));
  });
}

let requestSeq = 0;

/**
 * 向 Unity 桥发一条命令：新建连接 -> 写一行 JSON -> 读一行响应 -> 关闭。
 * 成功 resolve(result)，失败 reject(BridgeError)。
 */
function bridgeRequest(command, params) {
  const id = "dsh-" + (++requestSeq) + "-" + Date.now().toString(36);
  const payload = JSON.stringify({ id: id, command: command, params: params || {} }) + "\n";
  const timeoutMs = CONFIG.timeoutMs;

  return new Promise((resolve, reject) => {
    const socket = net.connect({ host: CONFIG.host, port: CONFIG.port });
    socket.setEncoding("utf8");

    let settled = false;
    let buffer = "";

    const finish = (err, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        socket.destroy();
      } catch {
        /* ignore */
      }
      if (err) reject(err);
      else resolve(value);
    };

    const timer = setTimeout(() => {
      finish(
        new BridgeError(
          "Unity 桥在 " + Math.round(timeoutMs / 1000) + " 秒内没有响应（命令 " + command +
            "）。编辑器可能正在编译、进入播放模式或卡住。",
          "BRIDGE_TIMEOUT",
        ),
      );
    }, timeoutMs);

    socket.once("connect", () => socket.write(payload));

    socket.on("data", (chunk) => {
      buffer += chunk;
      const nl = buffer.indexOf("\n");
      if (nl < 0) return; // 还没收完一行
      const line = buffer.slice(0, nl).trim();
      if (!line) return;
      let resp;
      try {
        resp = JSON.parse(line);
      } catch {
        finish(new BridgeError("Unity 桥返回了无法解析的响应：" + line.slice(0, 400), "BRIDGE_BAD_RESPONSE"));
        return;
      }
      if (resp && resp.status === "ok") {
        finish(null, resp.result);
      } else {
        const msg = (resp && resp.error) || "Unity 桥返回了未知错误";
        const err = new BridgeError(msg, "BRIDGE_ERROR");
        if (resp && resp.stack) err.stackFromBridge = resp.stack;
        finish(err);
      }
    });

    socket.once("error", (err) => finish(new BridgeError(connectionErrorMessage(err), err.code || "BRIDGE_UNREACHABLE")));
    socket.once("close", () => {
      if (!settled) finish(new BridgeError("Unity 桥在响应命令 " + command + " 之前关闭了连接。", "BRIDGE_CLOSED"));
    });
  });
}

/* ------------------------------------------------------------------ */
/* 工具定义（inputSchema 严格按 docs/PROTOCOL.md 的命令参数）            */
/* ------------------------------------------------------------------ */

function schema(properties, required, extra) {
  const out = { type: "object", properties: properties || {} };
  if (required && required.length > 0) out.required = required;
  if (extra) {
    for (const key of Object.keys(extra)) out[key] = extra[key];
  }
  return out;
}

/** Vector3 / 欧拉角：长度 3 的数字数组 */
function vec3(description) {
  return { type: "array", items: { type: "number" }, minItems: 3, maxItems: 3, description: description };
}

/** GameObject 定位：层级路径 / 唯一名称 / instanceId */
const TARGET_PROP = {
  anyOf: [{ type: "string" }, { type: "integer" }],
  description: "场景对象：层级路径 \"Parent/Child\"、唯一名称 \"Cube\"，或 instanceId 数字",
};

const TOOLS = [
  {
    name: "status",
    description: "查看与 Unity 编辑器的连接状态（桥命令 ping）。连不上时返回 {connected:false,error}，不报错。",
    inputSchema: schema({}),
    async invoke() {
      try {
        const r = await bridgeRequest("ping", {});
        const value = { connected: true, host: CONFIG.host, port: CONFIG.port };
        if (r && typeof r === "object") {
          for (const key of Object.keys(r)) value[key] = r[key];
        }
        return { value: value };
      } catch (err) {
        return { value: { connected: false, host: CONFIG.host, port: CONFIG.port, error: errorText(err) } };
      }
    },
  },
  {
    name: "launch",
    description: "启动 Unity 编辑器（带 -projectPath）并等待 DSH Bridge 上线；若桥已可连则直接返回 alreadyRunning。",
    inputSchema: schema({}),
    async invoke() {
      return { value: await launchUnity() };
    },
  },
  {
    name: "project_info",
    description: "获取工程信息：工程路径、Unity 版本、产品名、渲染管线、当前场景、对象与资源数量。",
    inputSchema: schema({}),
    command: "project_info",
  },
  {
    name: "scene_info",
    description: "获取当前场景的对象树（深度优先扁平列表），含位置/旋转/缩放、激活状态与组件列表。",
    inputSchema: schema({
      limit: { type: "integer", minimum: 1, description: "最多返回多少个对象，默认 500" },
      includeInactive: { type: "boolean", description: "是否包含未激活对象，默认 true" },
    }),
    command: "get_scene_info",
  },
  {
    name: "execute_code",
    description:
      "在 Unity 主线程编译并执行一段 C# 方法体（等价于 object Run() { <code>; return null; }），返回执行结果与日志。要返回值就写 return。",
    inputSchema: schema(
      {
        code: {
          type: "string",
          description:
            "C# 方法体源码。可用命名空间：System、System.Collections.Generic、System.Linq、UnityEngine、UnityEditor、UnityEngine.SceneManagement",
        },
      },
      ["code"],
    ),
    command: "execute_code",
  },
  {
    name: "create_primitive",
    description: "创建 Unity 内置基本体（Cube/Sphere/Cylinder/Capsule/Plane/Quad），可指定位置、旋转、缩放、父对象与材质。",
    inputSchema: schema(
      {
        type: { type: "string", enum: ["Cube", "Sphere", "Cylinder", "Capsule", "Plane", "Quad"], description: "基本体类型" },
        name: { type: "string", description: "对象名称，省略时用 Unity 默认名" },
        position: vec3("世界坐标位置 [x,y,z]"),
        rotation: vec3("欧拉角旋转 [x,y,z]（度）"),
        scale: vec3("缩放 [x,y,z]"),
        parent: { type: "string", description: "父对象层级路径，如 \"Root/Child\"" },
        material: { type: "string", description: "材质资源路径，如 \"Assets/DSH/Materials/Red.mat\"" },
      },
      ["type"],
    ),
    command: "create_primitive",
  },
  {
    name: "create_empty",
    description: "创建空 GameObject（可作分组容器），可指定名称、位置与父对象。",
    inputSchema: schema({
      name: { type: "string", description: "对象名称，如 Group" },
      position: vec3("世界坐标位置 [x,y,z]"),
      parent: { type: "string", description: "父对象层级路径，如 \"Root/Child\"" },
    }),
    command: "create_empty",
  },
  {
    name: "set_transform",
    description: "设置对象的变换（位置/旋转/缩放至少给一个），可选择世界坐标或本地坐标。",
    inputSchema: schema(
      {
        target: TARGET_PROP,
        position: vec3("位置 [x,y,z]"),
        rotation: vec3("欧拉角旋转 [x,y,z]（度）"),
        scale: vec3("缩放 [x,y,z]"),
        worldSpace: { type: "boolean", description: "true 用世界坐标（默认），false 用本地坐标" },
      },
      ["target"],
    ),
    command: "set_transform",
  },
  {
    name: "delete_object",
    description: "从场景中删除一个对象（默认连同子对象）。",
    inputSchema: schema({ target: TARGET_PROP }, ["target"]),
    command: "delete_object",
  },
  {
    name: "duplicate_object",
    description: "复制一个对象（连同子对象与组件），可指定副本名称。",
    inputSchema: schema({ target: TARGET_PROP, name: { type: "string", description: "副本名称，如 \"Cube (2)\"" } }, ["target"]),
    command: "duplicate_object",
  },
  {
    name: "add_component",
    description: "给对象添加组件（如 Rigidbody/BoxCollider/自定义脚本），可同时设置属性。",
    inputSchema: schema(
      {
        target: TARGET_PROP,
        component: { type: "string", description: "组件名，如 \"Rigidbody\" 或脚本类名" },
        properties: {
          type: "object",
          description: "要设置的属性：float/int/bool/string/数组（Vector3 或 Color），枚举用字符串名",
          additionalProperties: true,
        },
      },
      ["target", "component"],
    ),
    command: "add_component",
  },
  {
    name: "create_material",
    description: "创建（或覆盖）一个 Standard 材质资源并保存到工程，可设置颜色、金属度、光滑度与自发光。",
    inputSchema: schema(
      {
        name: { type: "string", description: "材质名，如 \"Red\"" },
        color: { type: "string", description: "基础色 \"#RRGGBB\"" },
        metallic: { type: "number", minimum: 0, maximum: 1, description: "金属度 0-1" },
        smoothness: { type: "number", minimum: 0, maximum: 1, description: "光滑度 0-1" },
        emission: { type: "string", description: "自发光颜色 \"#RRGGBB\"" },
        savePath: {
          type: "string",
          description: "保存路径，如 \"Assets/DSH/Materials/Red.mat\"，省略则为 Assets/DSH/Materials/<name>.mat",
        },
      },
      ["name"],
    ),
    command: "create_material",
  },
  {
    name: "assign_material",
    description: "把工程里的材质资源赋给对象的全部渲染器。",
    inputSchema: schema(
      {
        target: TARGET_PROP,
        material: { type: "string", description: "材质资源路径，如 \"Assets/DSH/Materials/Red.mat\"" },
      },
      ["target", "material"],
    ),
    command: "assign_material",
  },
  {
    name: "import_asset",
    description: "把外部文件（如 .fbx/.png）复制进工程并导入 AssetDatabase，可选是否实例化到场景。",
    inputSchema: schema(
      {
        sourcePath: { type: "string", description: "外部文件绝对路径，如 E:/models/ship.fbx" },
        destinationFolder: { type: "string", description: "工程内目标目录，如 \"Assets/DSH/Models\"" },
        instantiate: { type: "boolean", description: "是否把导入的模型/预制体实例化到场景" },
        name: { type: "string", description: "实例化后的对象名" },
      },
      ["sourcePath"],
    ),
    command: "import_asset",
  },
  {
    name: "instantiate_prefab",
    description: "把工程内的预制体/模型资源实例化到场景，可指定位置与名称。",
    inputSchema: schema(
      {
        assetPath: { type: "string", description: "资源路径，如 \"Assets/DSH/Models/ship.fbx\"" },
        position: vec3("世界坐标位置 [x,y,z]"),
        name: { type: "string", description: "实例对象名" },
      },
      ["assetPath"],
    ),
    command: "instantiate_prefab",
  },
  {
    name: "screenshot",
    description: "截图并保存为 PNG，返回文件路径；文件存在时把图片本身一并返回（image content）。",
    inputSchema: schema(
      {
        path: { type: "string", description: "PNG 输出绝对路径" },
        width: { type: "integer", minimum: 1, description: "宽度像素，默认 1280" },
        height: { type: "integer", minimum: 1, description: "高度像素，默认 720" },
        view: { type: "string", enum: ["auto", "game", "scene"], description: "auto=游戏相机（默认），game=游戏视图，scene=SceneView 相机" },
        target: TARGET_PROP,
      },
      ["path"],
    ),
    command: "screenshot",
    async invoke(params) {
      const result = await bridgeRequest("screenshot", params);
      const images = [];
      const file = result && typeof result.path === "string" ? result.path : null;
      let note;
      if (file && fs.existsSync(file)) {
        try {
          images.push({ type: "image", data: fs.readFileSync(file).toString("base64"), mimeType: "image/png" });
        } catch (err) {
          note = "（截图已生成但读取失败：" + err.message + "）";
        }
      } else if (file) {
        note = "（截图文件不存在：" + file + "）";
      }
      return { value: result, images: images, note: note };
    },
  },
  {
    name: "save_scene",
    description: "保存当前场景；给了 path 则另存到该路径（Assets/ 下）。",
    inputSchema: schema({ path: { type: "string", description: "场景路径，如 \"Assets/Scenes/Demo.unity\"" } }),
    command: "save_scene",
  },
  {
    name: "open_scene",
    description: "打开工程内的场景文件。",
    inputSchema: schema({ path: { type: "string", description: "场景路径，如 \"Assets/Scenes/Demo.unity\"" } }, ["path"]),
    command: "open_scene",
  },
  {
    name: "new_scene",
    description: "新建空场景；setup=true 时自动加 Directional Light 与 Main Camera。",
    inputSchema: schema({ setup: { type: "boolean", description: "是否自动搭建灯光与主相机" } }),
    command: "new_scene",
  },
  {
    name: "menu",
    description: "以菜单路径触发 Unity 编辑器菜单项，如 \"GameObject/3D Object/Cube\"。",
    inputSchema: schema({ path: { type: "string", description: "菜单路径，如 \"GameObject/3D Object/Cube\"" } }, ["path"]),
    command: "menu",
  },
  {
    name: "logs",
    description: "读取 Unity 控制台日志（对应桥命令 get_logs）。",
    inputSchema: schema({ count: { type: "integer", minimum: 1, description: "最多返回多少条，默认 50" } }),
    command: "get_logs",
  },
  {
    name: "clear_logs",
    description: "清空 Unity 控制台日志。",
    inputSchema: schema({}),
    command: "clear_logs",
  },
  {
    name: "selection",
    description: "获取当前编辑器选中对象（对应桥命令 get_selection）。",
    inputSchema: schema({}),
    command: "get_selection",
  },
  {
    name: "select",
    description: "在编辑器里选中一个对象。",
    inputSchema: schema({ target: TARGET_PROP }, ["target"]),
    command: "select",
  },
  {
    name: "undo",
    description: "撤销上一步编辑器操作（Undo.PerformUndo）。",
    inputSchema: schema({}),
    command: "undo",
  },
  {
    name: "redo",
    description: "重做上一步编辑器操作（Undo.PerformRedo）。",
    inputSchema: schema({}),
    command: "redo",
  },
  {
    name: "play_mode",
    description: "进入/退出/暂停播放模式（对应桥命令 set_play_mode）：给 playing=true/false，或 action=\"play|stop|pause\"。",
    inputSchema: schema(
      {
        playing: { type: "boolean", description: "true 进入播放，false 退出播放" },
        action: { type: "string", enum: ["play", "stop", "pause"], description: "播放动作，与 playing 二选一" },
      },
      [],
      { anyOf: [{ required: ["playing"] }, { required: ["action"] }] },
    ),
    command: "set_play_mode",
  },
  {
    name: "asset_search",
    description: "按关键字在工程里搜索资源（模型/预制体/材质/贴图/场景）。",
    inputSchema: schema(
      {
        query: { type: "string", description: "搜索关键字，如 ship" },
        type: { type: "string", enum: ["Model", "Prefab", "Material", "Texture", "Scene"], description: "资源类型过滤" },
        limit: { type: "integer", minimum: 1, description: "最多返回多少条，默认 50" },
      },
      ["query"],
    ),
    command: "asset_search",
  },
  {
    name: "import_package",
    description: "导入 UnityPackage（.unitypackage 文件绝对路径）。",
    inputSchema: schema({ path: { type: "string", description: "unitypackage 文件绝对路径" } }, ["path"]),
    command: "import_package",
  },
];

const TOOL_MAP = new Map(TOOLS.map((tool) => [tool.name, tool]));

function errorText(err) {
  if (err && typeof err.message === "string") return err.message;
  return String(err);
}

/* ------------------------------------------------------------------ */
/* launch                                                              */
/* ------------------------------------------------------------------ */

async function launchUnity() {
  const host = CONFIG.host;
  const port = CONFIG.port;
  const unityExe = CONFIG.unityExe;
  const projectPath = CONFIG.projectPath;
  const launchTimeoutMs = CONFIG.launchTimeoutMs;

  if (await probeTcp(host, port, 1500)) {
    return {
      launched: false,
      connected: true,
      alreadyRunning: true,
      pid: null,
      waitedMs: 0,
      projectPath: projectPath,
      message: "Unity 桥已在 " + host + ":" + port + " 上运行，无需重复启动。",
    };
  }

  if (!fs.existsSync(unityExe)) {
    throw new BridgeError(
      "找不到 Unity 可执行文件：" + unityExe +
        "。请用 config.json 的 unityExe，或环境变量 UNITY_DSH_UNITY_EXE 指定正确的路径。",
      "UNITY_EXE_MISSING",
    );
  }

  let spawnError = null;
  const child = spawn(unityExe, ["-projectPath", projectPath], {
    detached: true,
    stdio: "ignore",
    windowsHide: false,
  });
  child.on("error", (err) => {
    spawnError = err;
  });
  child.unref();
  const pid = typeof child.pid === "number" ? child.pid : null;

  await sleep(300);
  if (spawnError) {
    throw new BridgeError("启动 Unity 失败（" + unityExe + "）：" + spawnError.message, "UNITY_SPAWN_FAILED");
  }

  const startedAt = Date.now();
  while (Date.now() - startedAt < launchTimeoutMs) {
    await sleep(2000);
    if (await probeTcp(host, port, 2000)) {
      return {
        launched: true,
        connected: true,
        alreadyRunning: false,
        pid: pid,
        waitedMs: Date.now() - startedAt,
        projectPath: projectPath,
        message: "Unity 已启动并连上桥（工程 " + projectPath + "）。",
      };
    }
  }

  return {
    launched: true,
    connected: false,
    alreadyRunning: false,
    pid: pid,
    waitedMs: Date.now() - startedAt,
    projectPath: projectPath,
    message:
      "Unity 进程已拉起（pid " + pid + "），但 " + Math.round(launchTimeoutMs / 1000) + " 秒内桥未上线。" +
      "常见原因：首次打开工程较慢、编辑器里没有加载 DSH Bridge、或桥端口不是 " + port + "。",
  };
}

/* ------------------------------------------------------------------ */
/* MCP 层                                                              */
/* ------------------------------------------------------------------ */

function send(obj) {
  try {
    process.stdout.write(JSON.stringify(obj) + "\n");
  } catch (err) {
    log("写 stdout 失败：" + (err && err.message));
  }
}

function sendResult(id, result) {
  send({ jsonrpc: "2.0", id: id, result: result });
}

function sendError(id, code, message, data) {
  const error = { code: code, message: message };
  if (data !== undefined) error.data = data;
  send({ jsonrpc: "2.0", id: id === undefined ? null : id, error: error });
}

function toolListPayload() {
  return {
    tools: TOOLS.map((tool) => ({
      name: tool.name,
      description: tool.description,
      inputSchema: tool.inputSchema,
    })),
  };
}

async function invokeTool(tool, args) {
  const params = {};
  for (const key of Object.keys(args || {})) {
    if (args[key] !== undefined) params[key] = args[key];
  }
  if (tool.invoke) return await tool.invoke(params);
  const value = await bridgeRequest(tool.command, params);
  return { value: value };
}

async function handleToolsCall(id, params) {
  const name = params && typeof params.name === "string" ? params.name : "";
  const rawArgs = params && params.arguments;
  const args = rawArgs && typeof rawArgs === "object" && !Array.isArray(rawArgs) ? rawArgs : {};

  const tool = TOOL_MAP.get(name);
  if (!tool) {
    sendResult(id, {
      content: [{ type: "text", text: "未知工具：" + (name || "(空)") + "。请用 tools/list 查看可用工具。" }],
      isError: true,
    });
    return;
  }

  try {
    const out = await invokeTool(tool, args);
    const value = out && Object.prototype.hasOwnProperty.call(out, "value") ? out.value : out;
    const content = [{ type: "text", text: JSON.stringify(value === undefined ? null : value, null, 2) }];
    if (out && Array.isArray(out.images)) {
      for (const img of out.images) content.push(img);
    }
    if (out && out.note) content.push({ type: "text", text: out.note });
    sendResult(id, { content: content });
  } catch (err) {
    log("工具 " + name + " 失败：" + errorText(err));
    sendResult(id, { content: [{ type: "text", text: errorText(err) }], isError: true });
  }
}

async function handle(message) {
  if (!message || typeof message !== "object" || Array.isArray(message)) {
    sendError(null, -32600, "Invalid Request");
    return;
  }

  const hasId = Object.prototype.hasOwnProperty.call(message, "id");
  const id = hasId ? message.id : null;
  const method = typeof message.method === "string" ? message.method : "";

  if (!hasId) {
    // 通知一律不回包（notifications/initialized、notifications/cancelled 等）
    return;
  }

  switch (method) {
    case "initialize": {
      const requested =
        message.params && typeof message.params.protocolVersion === "string" ? message.params.protocolVersion.trim() : "";
      sendResult(id, {
        protocolVersion: requested || DEFAULT_PROTOCOL_VERSION,
        capabilities: { tools: {} },
        serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
        instructions:
          "Unity DSH 桥。用 status 检查连接，launch 启动 Unity，scene_info / execute_code 等工具直接操作当前场景。",
      });
      return;
    }
    case "ping":
      sendResult(id, {});
      return;
    case "tools/list":
      sendResult(id, toolListPayload());
      return;
    case "tools/call":
      await handleToolsCall(id, message.params);
      return;
    default:
      sendError(id, -32601, "Method not found: " + (method || "(empty)"));
  }
}

const pending = new Set();

function dispatchLine(line) {
  const text = line.trim();
  if (!text) return;
  let message;
  try {
    message = JSON.parse(text);
  } catch (err) {
    sendError(null, -32700, "Parse error: " + err.message);
    return;
  }
  const task = handle(message)
    .catch((err) => {
      log("处理消息出错：" + (err && err.stack ? err.stack : err));
      const id = message && Object.prototype.hasOwnProperty.call(message, "id") ? message.id : null;
      if (message && Object.prototype.hasOwnProperty.call(message, "id")) sendError(id, -32603, "Internal error: " + errorText(err));
    })
    .finally(() => pending.delete(task));
  pending.add(task);
}

function shutdown() {
  if (pending.size === 0) {
    process.exit(0);
    return;
  }
  Promise.allSettled([...pending]).finally(() => process.exit(0));
}

function main() {
  log(
    "启动 MCP server " + SERVER_NAME + "/" + SERVER_VERSION + "，stdin/stdout 用换行分隔 JSON-RPC；桥 " +
      CONFIG.host + ":" + CONFIG.port + "，工程 " + CONFIG.projectPath,
  );

  const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity, terminal: false });
  rl.on("line", dispatchLine);
  rl.on("close", () => {
    log("stdin 已关闭，等待进行中的请求后退出");
    shutdown();
  });

  process.on("SIGINT", () => process.exit(0));
  process.on("SIGTERM", () => process.exit(0));
  process.stdout.on("error", () => process.exit(0));
}

main();
