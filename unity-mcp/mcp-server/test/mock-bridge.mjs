#!/usr/bin/env node
/**
 * 测试用 mock Unity 桥：在本机随机端口监听 TCP，
 * 按 docs/PROTOCOL.md 的「一行一个 JSON」格式响应一组固定命令。
 * 只用于 mcp-server/test/run-tests.mjs，不参与生产运行。
 */

import net from "node:net";
import fs from "node:fs";
import path from "node:path";

/** 1x1 PNG，用于验证 screenshot 工具的 image content */
const PNG_1PX =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

export class MockBridge {
  constructor(options) {
    const opts = options || {};
    this.screenshotDir = opts.screenshotDir || process.cwd();
    this.requests = [];
    this.connections = 0;
    this.shotSeq = 0;
    this.server = null;
    this.port = 0;
  }

  /** 起 TCP 服务；port 省略或 0 时由系统分配，返回实际端口 */
  async start(port) {
    const wanted = typeof port === "number" ? port : 0;
    this.server = net.createServer((socket) => {
      this.connections += 1;
      socket.setEncoding("utf8");
      let buffer = "";
      socket.on("data", (chunk) => {
        buffer += chunk;
        let nl = buffer.indexOf("\n");
        while (nl >= 0) {
          const line = buffer.slice(0, nl).trim();
          buffer = buffer.slice(nl + 1);
          if (line) socket.write(JSON.stringify(this.respondSafe(line)) + "\n");
          nl = buffer.indexOf("\n");
        }
      });
      socket.on("error", () => {
        /* 客户端提前断开属正常 */
      });
    });

    await new Promise((resolve, reject) => {
      const onError = (err) => reject(err);
      this.server.once("error", onError);
      this.server.listen(wanted, "127.0.0.1", () => {
        this.server.removeListener("error", onError);
        resolve();
      });
    });

    this.port = this.server.address().port;
    return this.port;
  }

  async stop() {
    const server = this.server;
    if (!server) return;
    this.server = null;
    if (typeof server.closeAllConnections === "function") server.closeAllConnections();
    await new Promise((resolve) => server.close(() => resolve()));
  }

  reset() {
    this.requests = [];
  }

  /** 按行取最近一次某命令的请求 */
  lastRequest(command) {
    for (let i = this.requests.length - 1; i >= 0; i -= 1) {
      if (this.requests[i].command === command) return this.requests[i];
    }
    return null;
  }

  respondSafe(line) {
    let req;
    try {
      req = JSON.parse(line);
    } catch (err) {
      return { id: null, status: "error", error: "mock: 请求不是合法 JSON（" + err.message + "）" };
    }
    return this.respond(req);
  }

  respond(req) {
    const id = req && Object.prototype.hasOwnProperty.call(req, "id") ? req.id : null;
    const command = req && typeof req.command === "string" ? req.command : "";
    const params = (req && req.params) || {};
    this.requests.push({ command: command, params: params, id: id });

    try {
      return { id: id, status: "ok", result: this.dispatch(command, params) };
    } catch (err) {
      return { id: id, status: "error", error: err.message, stack: "mock-bridge\n  at " + command };
    }
  }

  dispatch(command, params) {
    switch (command) {
      case "ping":
        return {
          pong: true,
          unityVersion: "2019.4.15f1",
          projectPath: "E:/Unity/DSHProject",
          platform: "WindowsEditor",
          isPlaying: false,
          isCompiling: false,
          scene: "SampleScene",
          time: new Date().toISOString(),
        };

      case "project_info":
        return {
          projectPath: "E:/Unity/DSHProject",
          unityVersion: "2019.4.15f1",
          productName: "DSHProject",
          companyName: "DefaultCompany",
          renderPipeline: "Built-in",
          scenePath: "Assets/Scenes/SampleScene.unity",
          sceneName: "SampleScene",
          objectCount: 3,
          assetCount: 42,
        };

      case "get_scene_info": {
        const all = [
          {
            name: "Cube",
            path: "Cube",
            type: "GameObject",
            instanceId: -1234,
            active: true,
            position: [0, 0.5, 0],
            rotation: [0, 0, 0],
            scale: [1, 1, 1],
            children: 1,
            tag: "Untagged",
            layer: 0,
            components: ["Transform", "MeshFilter", "MeshRenderer", "BoxCollider"],
          },
          {
            name: "Child",
            path: "Cube/Child",
            type: "GameObject",
            instanceId: -1235,
            active: false,
            position: [0, 1, 0],
            rotation: [0, 0, 0],
            scale: [1, 1, 1],
            children: 0,
            tag: "Untagged",
            layer: 0,
            components: ["Transform"],
          },
        ];
        const limit = Number.isInteger(params.limit) && params.limit > 0 ? params.limit : 500;
        const objects = all.slice(0, limit);
        return {
          scene: "SampleScene",
          path: "Assets/Scenes/SampleScene.unity",
          rootCount: 1,
          truncated: objects.length < all.length,
          objects: objects,
        };
      }

      case "execute_code": {
        if (typeof params.code !== "string") throw new Error("execute_code 缺少 code 参数");
        return {
          compiled: true,
          result: { code: params.code, length: params.code.length },
          logs: [{ type: "Log", message: "mock executed", stackTrace: "" }],
          durationMs: 4,
        };
      }

      case "screenshot": {
        fs.mkdirSync(this.screenshotDir, { recursive: true });
        this.shotSeq += 1;
        const file = path.join(this.screenshotDir, "shot-" + this.shotSeq + ".png");
        fs.writeFileSync(file, Buffer.from(PNG_1PX, "base64"));
        return {
          path: file,
          width: Number.isInteger(params.width) ? params.width : 1280,
          height: Number.isInteger(params.height) ? params.height : 720,
          camera: "Main Camera",
        };
      }

      case "get_logs": {
        const count = Number.isInteger(params.count) && params.count > 0 ? params.count : 50;
        const entries = [];
        for (let i = 0; i < Math.min(count, 3); i += 1) {
          entries.push({ type: "Log", message: "mock log " + i, stackTrace: "", time: "2026-10-29T04:00:0" + i + "Z" });
        }
        return { entries: entries };
      }

      case "get_selection":
        return { objects: [{ name: "Cube", path: "Cube", instanceId: -1234 }] };

      case "set_play_mode":
        return { isPlaying: params.action ? params.action === "play" : params.playing === true, isPaused: params.action === "pause" };

      default:
        throw new Error("Unknown command: " + command);
    }
  }
}

/** 便捷入口：startMockBridge({screenshotDir}) -> 已监听的 MockBridge（bridge.port 可用） */
export async function startMockBridge(options) {
  const bridge = new MockBridge(options);
  await bridge.start();
  return bridge;
}
