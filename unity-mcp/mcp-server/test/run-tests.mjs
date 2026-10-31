#!/usr/bin/env node
/**
 * mcp-server 端到端测试。
 *
 * 做法：起一个 mock Unity 桥（mock-bridge.mjs，随机端口），再 spawn server.mjs，
 * 通过 stdin/stdout 用换行分隔的 JSON-RPC 逐条断言。不依赖任何第三方包。
 *
 * 运行：node mcp-server/test/run-tests.mjs
 * 退出码：0 = 全部通过，1 = 有失败。
 */

import net from "node:net";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { startMockBridge } from "./mock-bridge.mjs";

const NODE = process.execPath;
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const SERVER = path.join(ROOT, "server.mjs");
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "unity-dsh-test-"));
const STARTED_AT = Date.now();

const EXPECTED_TOOLS = [
  "status",
  "launch",
  "project_info",
  "scene_info",
  "execute_code",
  "create_primitive",
  "create_empty",
  "set_transform",
  "delete_object",
  "duplicate_object",
  "add_component",
  "create_material",
  "assign_material",
  "import_asset",
  "instantiate_prefab",
  "screenshot",
  "save_scene",
  "open_scene",
  "new_scene",
  "menu",
  "logs",
  "clear_logs",
  "selection",
  "select",
  "undo",
  "redo",
  "play_mode",
  "asset_search",
  "import_package",
];

/* ------------------------------------------------------------------ */
/* 断言与工具函数                                                       */
/* ------------------------------------------------------------------ */

function assert(cond, message) {
  if (!cond) throw new Error(message);
}

function assertEqual(actual, expected, what) {
  if (actual !== expected) {
    throw new Error(what + "：期望 " + JSON.stringify(expected) + "，实际 " + JSON.stringify(actual));
  }
}

function assertDeepEqual(actual, expected, what) {
  const a = JSON.stringify(actual);
  const b = JSON.stringify(expected);
  if (a !== b) throw new Error(what + "：期望 " + b + "，实际 " + a);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function envFor(overrides, drops) {
  const env = { ...process.env };
  for (const key of drops || []) delete env[key];
  return { ...env, ...(overrides || {}) };
}

/** 取回一个当前空闲（已关闭）的端口，用来模拟「桥没开」 */
async function reserveClosedPort() {
  const srv = net.createServer();
  await new Promise((resolve, reject) => {
    srv.once("error", reject);
    srv.listen(0, "127.0.0.1", resolve);
  });
  const port = srv.address().port;
  await new Promise((resolve) => srv.close(resolve));
  return port;
}

/* ------------------------------------------------------------------ */
/* 最小 MCP stdio 客户端                                                */
/* ------------------------------------------------------------------ */

class McpClient {
  constructor(env) {
    this.child = spawn(NODE, [SERVER], {
      cwd: ROOT,
      env: env || envFor({}),
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    this.nextId = 0;
    this.pending = new Map();
    this.received = [];
    this.rawLines = [];
    this.parseErrors = [];
    this.stderr = "";
    this.closed = false;
    this.exitInfo = null;

    this.exitPromise = new Promise((resolve) => {
      this.child.once("exit", (code, signal) => {
        this.exitInfo = { code: code, signal: signal };
        for (const entry of this.pending.values()) {
          clearTimeout(entry.timer);
          entry.reject(new Error("MCP server 进程已退出（code=" + code + "）\n" + this.stderrTail()));
        }
        this.pending.clear();
        resolve(this.exitInfo);
      });
    });

    this.rl = readline.createInterface({ input: this.child.stdout, crlfDelay: Infinity });
    this.rl.on("line", (line) => {
      this.rawLines.push(line);
      if (!line.trim()) return;
      let msg;
      try {
        msg = JSON.parse(line);
      } catch (err) {
        this.parseErrors.push({ line: line, error: String(err && err.message) });
        return;
      }
      this.received.push(msg);
      if (msg && msg.id !== undefined && msg.id !== null && this.pending.has(msg.id)) {
        const entry = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        clearTimeout(entry.timer);
        entry.resolve(msg);
      }
    });

    this.child.stderr.on("data", (chunk) => {
      this.stderr += chunk.toString();
      if (this.stderr.length > 40000) this.stderr = this.stderr.slice(-40000);
    });
    this.child.on("error", (err) => {
      this.stderr += "\n[spawn error] " + err.message;
    });
  }

  stderrTail() {
    const lines = this.stderr.trim().split("\n");
    return lines.slice(-15).join("\n");
  }

  send(obj) {
    this.child.stdin.write(JSON.stringify(obj) + "\n");
  }

  sendRaw(text) {
    this.child.stdin.write(text + "\n");
  }

  request(method, params, timeoutMs) {
    const id = ++this.nextId;
    const msg = { jsonrpc: "2.0", id: id, method: method };
    if (params !== undefined) msg.params = params;
    this.send(msg);
    const limit = typeof timeoutMs === "number" ? timeoutMs : 15000;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error("请求超时：" + method + "（id=" + id + "），stderr 末尾：\n" + this.stderrTail()));
      }, limit);
      this.pending.set(id, { resolve: resolve, reject: reject, timer: timer });
    });
  }

  notify(method, params) {
    const msg = { jsonrpc: "2.0", method: method };
    if (params !== undefined) msg.params = params;
    this.send(msg);
  }

  async close(timeoutMs) {
    if (this.closed) return this.exitInfo || { code: null, signal: null };
    this.closed = true;
    try {
      this.child.stdin.end();
    } catch {
      /* ignore */
    }
    try {
      this.rl.close();
    } catch {
      /* ignore */
    }
    const limit = typeof timeoutMs === "number" ? timeoutMs : 4000;
    let timer;
    const timeout = new Promise((resolve) => {
      timer = setTimeout(() => resolve({ code: "timeout", signal: null }), limit);
    });
    const info = await Promise.race([this.exitPromise, timeout]);
    clearTimeout(timer);
    if (info && info.code === "timeout") {
      try {
        this.child.kill("SIGKILL");
      } catch {
        /* ignore */
      }
      await this.exitPromise;
    }
    return info;
  }

  kill() {
    try {
      this.child.kill("SIGKILL");
    } catch {
      /* ignore */
    }
  }
}

/** 从 tools/call 的响应里取出 JSON（并校验不是错误） */
function toolData(res) {
  assert(res && res.result && Array.isArray(res.result.content), "tools/call 响应缺少 result.content");
  assertEqual(Boolean(res.result.isError), false, "tools/call 意外返回了 isError");
  const textBlock = res.result.content.find((c) => c && c.type === "text");
  assert(textBlock, "tools/call 响应缺少 text content");
  const data = JSON.parse(textBlock.text);
  return data;
}

async function toolErrorText(res) {
  assert(res && res.result, "缺少 result");
  assertEqual(res.result.isError, true, "期望 isError=true");
  const textBlock = res.result.content.find((c) => c && c.type === "text");
  assert(textBlock, "错误响应缺少 text content");
  return textBlock.text;
}

/* ------------------------------------------------------------------ */
/* 极简测试运行器                                                       */
/* ------------------------------------------------------------------ */

const results = [];

async function test(name, fn) {
  const t0 = Date.now();
  try {
    await fn();
    const ms = Date.now() - t0;
    results.push({ name: name, ok: true, ms: ms });
    console.log("  PASS  " + name + "  (" + ms + "ms)");
  } catch (err) {
    const ms = Date.now() - t0;
    const detail = String((err && err.message) || err);
    results.push({ name: name, ok: false, ms: ms, error: detail });
    console.log("  FAIL  " + name + "  (" + ms + "ms)");
    console.log(
      detail
        .split("\n")
        .map((line) => "        " + line)
        .join("\n"),
    );
  }
}

/* ------------------------------------------------------------------ */
/* 主流程                                                              */
/* ------------------------------------------------------------------ */

let bridge = null;
let client = null;
const extraClients = new Set();

try {
  bridge = await startMockBridge({ screenshotDir: TMP });
  const mockPort = bridge.port;
  const closedPort = await reserveClosedPort();
  const bogusExe = path.join(TMP, "no-such-unity.exe");
  const absentConfig = path.join(TMP, "absent-config.json");

  console.log("mock Unity 桥：" + "127.0.0.1:" + mockPort);
  console.log("server.mjs：" + SERVER);
  console.log("node：" + NODE + "（" + process.version + "）");
  console.log("临时目录：" + TMP);
  console.log("");

  client = new McpClient(
    envFor(
      {
        UNITY_DSH_PORT: String(mockPort),
        UNITY_DSH_PROJECT: "E:\\Unity\\DSHProject",
        UNITY_DSH_UNITY_EXE: bogusExe,
        UNITY_DSH_CONFIG: absentConfig,
        UNITY_DSH_TIMEOUT_MS: "8000",
      },
      [],
    ),
  );

  /* ---------- 握手 ---------- */

  let listResult = null;

  await test("initialize 回显客户端协议版本并返回 serverInfo", async () => {
    const res = await client.request("initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "run-tests", version: "0.0.0" },
    });
    assert(res.result, "initialize 缺少 result");
    assertEqual(res.result.protocolVersion, "2025-06-18", "protocolVersion");
    assert(res.result.capabilities && typeof res.result.capabilities.tools === "object", "capabilities.tools 缺失");
    assertEqual(res.result.serverInfo && res.result.serverInfo.name, "unity-dsh", "serverInfo.name");
    assertEqual(res.result.serverInfo && res.result.serverInfo.version, "0.1.0", "serverInfo.version");
    assert(res.id === 1, "响应 id 未原样回传");
  });

  await test("notifications/initialized 不回包", async () => {
    const before = client.received.length;
    client.notify("notifications/initialized");
    await sleep(250);
    assertEqual(client.received.length, before, "收到多余回包");
  });

  await test("ping 返回空对象 {}", async () => {
    const res = await client.request("ping");
    assertDeepEqual(res.result, {}, "ping result");
  });

  /* ---------- tools/list ---------- */

  await test("tools/list 返回 29 个工具且名称齐全", async () => {
    const res = await client.request("tools/list", {});
    listResult = res.result;
    assert(listResult && Array.isArray(listResult.tools), "缺少 result.tools");
    const names = listResult.tools.map((t) => t.name);
    assertEqual(names.length, 29, "工具数量");
    assertDeepEqual(names.slice().sort(), EXPECTED_TOOLS.slice().sort(), "工具名称集合");
  });

  await test("每个工具都有中文 description 与 object inputSchema", async () => {
    for (const tool of listResult.tools) {
      assert(typeof tool.description === "string" && tool.description.length > 0, tool.name + " 缺少 description");
      assert(/[\u4e00-\u9fa5]/.test(tool.description), tool.name + " 的 description 不是中文");
      assert(tool.inputSchema, tool.name + " 缺少 inputSchema");
      assertEqual(tool.inputSchema.type, "object", tool.name + " inputSchema.type");
      assert(typeof tool.inputSchema.properties === "object" && tool.inputSchema.properties !== null, tool.name + " 缺少 properties");
    }
  });

  await test("关键工具的 inputSchema 与 PROTOCOL.md 一致", async () => {
    const byName = new Map(listResult.tools.map((t) => [t.name, t]));

    const cp = byName.get("create_primitive").inputSchema;
    assertDeepEqual(cp.required, ["type"], "create_primitive.required");
    assertDeepEqual(cp.properties.type.enum, ["Cube", "Sphere", "Cylinder", "Capsule", "Plane", "Quad"], "create_primitive.type.enum");
    assertDeepEqual(cp.properties.position.minItems, 3, "create_primitive.position 应为长度 3 数组");
    assertDeepEqual(cp.properties.position.maxItems, 3, "create_primitive.position 应为长度 3 数组");
    assertEqual(cp.properties.material.type, "string", "create_primitive.material.type");

    const ec = byName.get("execute_code").inputSchema;
    assertDeepEqual(ec.required, ["code"], "execute_code.required");
    assertEqual(ec.properties.code.type, "string", "execute_code.code.type");

    const st = byName.get("set_transform").inputSchema;
    assertDeepEqual(st.required, ["target"], "set_transform.required");
    assertEqual(st.properties.target.anyOf.length, 2, "set_transform.target 应支持字符串与整数");
    assertEqual(st.properties.position.minItems, 3, "set_transform.position");
    assertEqual(st.properties.worldSpace.type, "boolean", "set_transform.worldSpace.type");

    const pm = byName.get("play_mode").inputSchema;
    assertDeepEqual(pm.properties.action.enum, ["play", "stop", "pause"], "play_mode.action.enum");
    assertEqual(pm.properties.playing.type, "boolean", "play_mode.playing.type");
    assert(Array.isArray(pm.anyOf) && pm.anyOf.length === 2, "play_mode 应要求 playing 或 action 之一");

    const ss = byName.get("screenshot").inputSchema;
    assertDeepEqual(ss.required, ["path"], "screenshot.required");
    assertDeepEqual(ss.properties.view.enum, ["auto", "game", "scene"], "screenshot.view.enum");

    const as = byName.get("asset_search").inputSchema;
    assertDeepEqual(as.required, ["query"], "asset_search.required");
    assertDeepEqual(as.properties.type.enum, ["Model", "Prefab", "Material", "Texture", "Scene"], "asset_search.type.enum");

    const ac = byName.get("add_component").inputSchema;
    assertDeepEqual(ac.required, ["target", "component"], "add_component.required");
    assertEqual(ac.properties.properties.type, "object", "add_component.properties.type");

    const dl = byName.get("delete_object").inputSchema;
    assertDeepEqual(dl.required, ["target"], "delete_object.required");
  });

  /* ---------- tools/call：正常路径 ---------- */

  await test("status 连上桥时返回 connected:true 与 pong", async () => {
    const res = await client.request("tools/call", { name: "status", arguments: {} });
    const data = toolData(res);
    assertEqual(data.connected, true, "connected");
    assertEqual(data.pong, true, "pong");
    assertEqual(data.unityVersion, "2019.4.15f1", "unityVersion");
    assertEqual(data.port, mockPort, "status 返回的端口");
    const text = res.result.content[0].text;
    assert(text.includes("\n  \""), "成功结果应是 2 空格美化 JSON");
  });

  await test("scene_info 透传参数并返回 mock 场景树", async () => {
    const res = await client.request("tools/call", { name: "scene_info", arguments: { limit: 5, includeInactive: true } });
    const data = toolData(res);
    assertEqual(data.scene, "SampleScene", "scene");
    assertEqual(data.rootCount, 1, "rootCount");
    assertEqual(data.objects.length, 2, "objects 数量");
    assertEqual(data.objects[0].name, "Cube", "objects[0].name");
    assertEqual(data.objects[0].position[1], 0.5, "objects[0].position[1]");
    const hit = bridge.lastRequest("get_scene_info");
    assert(hit, "mock 桥没有收到 get_scene_info");
    assertEqual(hit.params.limit, 5, "透传 limit");
    assertEqual(hit.params.includeInactive, true, "透传 includeInactive");
  });

  await test("execute_code 透传多行代码并返回执行结果", async () => {
    const code = "var go = GameObject.CreatePrimitive(PrimitiveType.Cube);\nreturn go.name;";
    const res = await client.request("tools/call", { name: "execute_code", arguments: { code: code } });
    const data = toolData(res);
    assertEqual(data.compiled, true, "compiled");
    assertEqual(data.result.code, code, "返回的代码应与入参一致（换行不能丢）");
    const hit = bridge.lastRequest("execute_code");
    assertEqual(hit.params.code, code, "桥收到的 code");
  });

  await test("logs → get_logs、selection → get_selection 映射正确", async () => {
    const logsRes = await client.request("tools/call", { name: "logs", arguments: { count: 2 } });
    const logsData = toolData(logsRes);
    assert(Array.isArray(logsData.entries), "entries 应为数组");
    const logsHit = bridge.lastRequest("get_logs");
    assert(logsHit, "mock 桥没有收到 get_logs（logs 未映射）");
    assertEqual(logsHit.params.count, 2, "透传 count");

    const selRes = await client.request("tools/call", { name: "selection", arguments: {} });
    const selData = toolData(selRes);
    assert(Array.isArray(selData.objects), "selection.objects 应为数组");
    assert(bridge.lastRequest("get_selection"), "mock 桥没有收到 get_selection（selection 未映射）");
  });

  await test("play_mode → set_play_mode 映射正确", async () => {
    const res = await client.request("tools/call", { name: "play_mode", arguments: { action: "play" } });
    const data = toolData(res);
    assertEqual(data.isPlaying, true, "isPlaying");
    const hit = bridge.lastRequest("set_play_mode");
    assert(hit, "mock 桥没有收到 set_play_mode（play_mode 未映射）");
    assertEqual(hit.params.action, "play", "透传 action");
  });

  await test("screenshot 成功时追加 image content（base64 PNG）", async () => {
    const outPath = path.join(TMP, "client-requested.png");
    const res = await client.request("tools/call", { name: "screenshot", arguments: { path: outPath, width: 800, height: 600 } });
    assertEqual(Boolean(res.result.isError), false, "screenshot 不应失败");
    const textBlock = res.result.content.find((c) => c.type === "text");
    const imageBlock = res.result.content.find((c) => c.type === "image");
    assert(textBlock, "缺少 text content");
    assert(imageBlock, "缺少 image content");
    assertEqual(imageBlock.mimeType, "image/png", "mimeType");
    const buf = Buffer.from(imageBlock.data, "base64");
    assert(buf.length > 8, "图片数据为空");
    assertEqual(buf[0], 0x89, "PNG 魔数首字节");
    assertEqual(buf.toString("ascii", 1, 4), "PNG", "PNG 魔数");
    const data = JSON.parse(textBlock.text);
    assertEqual(data.width, 800, "截图宽度");
  });

  /* ---------- 错误路径 ---------- */

  await test("未知工具返回 isError 而不是抛错", async () => {
    const res = await client.request("tools/call", { name: "no_such_tool", arguments: {} });
    const text = await toolErrorText(res);
    assert(text.includes("未知工具"), "错误文案应说明未知工具，实际：" + text);
  });

  await test("未知方法返回 -32601", async () => {
    const res = await client.request("resources/list", {});
    assert(res.error, "应返回 error 对象");
    assertEqual(res.error.code, -32601, "error.code");
  });

  await test("无法解析的请求行返回 -32700", async () => {
    const before = client.received.length;
    client.sendRaw("{ this is not json ");
    for (let i = 0; i < 100 && client.received.length === before; i += 1) await sleep(25);
    assert(client.received.length > before, "没有收到 parse error 响应");
    const msg = client.received[client.received.length - 1];
    assertEqual(msg.error && msg.error.code, -32700, "error.code");
  });

  await test("launch 在桥已连通时返回 alreadyRunning", async () => {
    const res = await client.request("tools/call", { name: "launch", arguments: {} });
    const data = toolData(res);
    assertEqual(data.alreadyRunning, true, "alreadyRunning");
    assertEqual(data.launched, false, "launched");
    assertEqual(data.connected, true, "connected");
  });

  /* ---------- 配置优先级 ---------- */

  await test("config.json 的 port 生效（无环境变量覆盖）", async () => {
    const cfgPath = path.join(TMP, "config-ok.json");
    fs.writeFileSync(
      cfgPath,
      JSON.stringify({ port: mockPort, projectPath: "E:\\Unity\\DSHProject", unityExe: bogusExe }),
      "utf8",
    );
    const c = new McpClient(
      envFor({ UNITY_DSH_CONFIG: cfgPath, UNITY_DSH_TIMEOUT_MS: "8000" }, [
        "UNITY_DSH_PORT",
        "UNITY_DSH_PROJECT",
        "UNITY_DSH_UNITY_EXE",
      ]),
    );
    extraClients.add(c);
    try {
      await c.request("initialize", { protocolVersion: "2024-11-05" });
      const res = await c.request("tools/call", { name: "status", arguments: {} });
      const data = toolData(res);
      assertEqual(data.connected, true, "应通过 config.json 的端口连上 mock 桥");
      assertEqual(data.port, mockPort, "端口");
    } finally {
      extraClients.delete(c);
      await c.close();
    }
  });

  await test("环境变量端口优先于 config.json", async () => {
    const cfgPath = path.join(TMP, "config-wrong-port.json");
    fs.writeFileSync(
      cfgPath,
      JSON.stringify({ port: closedPort, projectPath: "E:\\WrongProject", unityExe: bogusExe }),
      "utf8",
    );
    const c = new McpClient(
      envFor({ UNITY_DSH_CONFIG: cfgPath, UNITY_DSH_PORT: String(mockPort), UNITY_DSH_TIMEOUT_MS: "8000" }, []),
    );
    extraClients.add(c);
    try {
      await c.request("initialize", { protocolVersion: "2024-11-05" });
      const res = await c.request("tools/call", { name: "status", arguments: {} });
      const data = toolData(res);
      assertEqual(data.port, mockPort, "应采用环境变量里的端口");
      assertEqual(data.connected, true, "connected");
    } finally {
      extraClients.delete(c);
      await c.close();
    }
  });

  await test("initialize 缺省协议版本回退到 2024-11-05", async () => {
    const c = new McpClient(
      envFor({ UNITY_DSH_PORT: String(mockPort), UNITY_DSH_CONFIG: absentConfig, UNITY_DSH_UNITY_EXE: bogusExe }, []),
    );
    extraClients.add(c);
    try {
      const res = await c.request("initialize");
      assertEqual(res.result.protocolVersion, "2024-11-05", "protocolVersion");
    } finally {
      extraClients.delete(c);
      await c.close();
    }
  });

  /* ---------- 桥断开 ---------- */

  await bridge.stop();
  bridge = null;

  await test("桥断开：scene_info 返回 isError 与中文提示", async () => {
    const res = await client.request("tools/call", { name: "scene_info", arguments: {} });
    const text = await toolErrorText(res);
    assert(text.includes("Unity"), "错误文案应提到 Unity，实际：" + text);
    assert(text.includes(String(mockPort)), "错误文案应带端口 " + mockPort + "，实际：" + text);
    assert(text.includes("桥"), "错误文案应提到桥，实际：" + text);
  });

  await test("桥断开：status 返回结构化 {connected:false,error} 且不 isError", async () => {
    const res = await client.request("tools/call", { name: "status", arguments: {} });
    const data = toolData(res);
    assertEqual(data.connected, false, "connected");
    assert(typeof data.error === "string" && data.error.length > 0, "缺少 error 字段");
    assertEqual(data.port, mockPort, "端口");
  });

  await test("launch 指向不存在的 Unity exe 时给出明确错误", async () => {
    const res = await client.request("tools/call", { name: "launch", arguments: {} });
    const text = await toolErrorText(res);
    assert(text.includes("找不到 Unity 可执行文件"), "错误文案不对：" + text);
    assert(text.includes("UNITY_DSH_UNITY_EXE"), "错误文案应提示如何配置路径，实际：" + text);
  });

  await test("launch 等待桥超时：launched=true / connected=false / 有 pid 与 waitedMs", async () => {
    const c = new McpClient(
      envFor(
        {
          UNITY_DSH_PORT: String(mockPort),
          UNITY_DSH_CONFIG: absentConfig,
          UNITY_DSH_UNITY_EXE: process.execPath,
          UNITY_DSH_LAUNCH_TIMEOUT_MS: "2500",
          UNITY_DSH_TIMEOUT_MS: "8000",
        },
        [],
      ),
    );
    extraClients.add(c);
    try {
      await c.request("initialize", { protocolVersion: "2024-11-05" });
      const res = await c.request("tools/call", { name: "launch", arguments: {} }, 40000);
      const data = toolData(res);
      assertEqual(data.launched, true, "launched");
      assertEqual(data.connected, false, "connected");
      assert(typeof data.pid === "number", "pid 应为数字，实际 " + JSON.stringify(data.pid));
      assert(data.waitedMs >= 2000, "waitedMs 应 >= 2000，实际 " + data.waitedMs);
      assert(typeof data.message === "string" && data.message.length > 0, "缺少 message");
    } finally {
      extraClients.delete(c);
      await c.close();
    }
  });

  /* ---------- stdout 纯净性与退出 ---------- */

  await test("stdout 只包含合法 JSON-RPC 行，日志在 stderr", async () => {
    assertEqual(client.parseErrors.length, 0, "stdout 出现非 JSON 行：" + JSON.stringify(client.parseErrors.slice(0, 3)));
    assert(client.rawLines.length > 10, "stdout 行数异常：" + client.rawLines.length);
    for (const msg of client.received) {
      assertEqual(msg.jsonrpc, "2.0", "JSON-RPC 版本字段");
    }
    assert(client.stderr.includes("[unity-dsh]"), "stderr 里应有 [unity-dsh] 日志");
  });

  await test("stdin 关闭后 server 以退出码 0 正常退出", async () => {
    const c = client;
    client = null;
    const info = await c.close(5000);
    assertEqual(info.code, 0, "退出码");
  });
} catch (err) {
  console.log("\n测试运行器异常：" + ((err && err.stack) || err));
  results.push({ name: "测试运行器自身", ok: false, ms: 0, error: String((err && err.message) || err) });
} finally {
  if (client) await client.close(1500).catch(() => {});
  for (const c of extraClients) await c.close(1500).catch(() => {});
  if (bridge) await bridge.stop().catch(() => {});
  try {
    fs.rmSync(TMP, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
}

/* ------------------------------------------------------------------ */
/* 汇总                                                                */
/* ------------------------------------------------------------------ */

const passed = results.filter((r) => r.ok).length;
const failed = results.length - passed;
const elapsed = ((Date.now() - STARTED_AT) / 1000).toFixed(1);

console.log("");
console.log("================ unity-dsh mcp-server 测试 ================");
for (const r of results) {
  console.log((r.ok ? "PASS  " : "FAIL  ") + r.name + (r.ok ? "" : "  <-- " + String(r.error).split("\n")[0]));
}
console.log("----------------------------------------------------------");
console.log("共 " + results.length + " 项：PASS " + passed + "，FAIL " + failed + "，用时 " + elapsed + "s");
console.log(failed === 0 ? "结果：ALL PASS" : "结果：FAILED");

process.exit(failed === 0 ? 0 : 1);
