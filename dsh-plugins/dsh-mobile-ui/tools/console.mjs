// 采集控制台错误与异常
import { spawn } from "node:child_process";
import { mkdirSync } from "node:fs";

const EDGE = process.env.EDGE_PATH || "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe";
const PROFILE = "C:/Temp/dsh-ui-profile-err";
const PORT = 9334;
const [, , url] = process.argv;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
mkdirSync(PROFILE, { recursive: true });
const child = spawn(EDGE, ["--headless=new","--disable-gpu","--no-sandbox","--no-first-run","--remote-debugging-port="+PORT,"--user-data-dir="+PROFILE,"--window-size=1440,900","about:blank"], { stdio: "ignore" });
let version = null;
for (let i = 0; i < 60; i++) { await sleep(500); try { version = await (await fetch("http://127.0.0.1:"+PORT+"/json/version")).json(); break; } catch {} }
const tgt = await (await fetch("http://127.0.0.1:"+PORT+"/json/new?about:blank", { method: "PUT" })).json();
const ws = new WebSocket(tgt.webSocketDebuggerUrl);
let id = 0; const pending = new Map();
const logs = [];
ws.addEventListener("message", (ev) => {
  const msg = JSON.parse(ev.data);
  if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); return; }
  if (msg.method === "Runtime.consoleAPICalled") {
    const t = msg.params.type;
    if (t === "error" || t === "warning" || t === "warn") {
      logs.push("console." + t + ": " + msg.params.args.map(a => a.value ?? a.description ?? a.type).join(" ").slice(0, 600));
    }
  }
  if (msg.method === "Runtime.exceptionThrown") {
    const d = msg.params.exceptionDetails;
    logs.push("EXCEPTION: " + ((d.exception && (d.exception.description || d.exception.value)) || d.text) + " @" + (d.url || "") + ":" + d.lineNumber);
  }
});
await new Promise((r) => ws.addEventListener("open", r, { once: true }));
const send = (method, params) => new Promise((resolve) => { const mid = ++id; pending.set(mid, resolve); ws.send(JSON.stringify({ id: mid, method, params: params || {} })); });
await send("Page.enable"); await send("Runtime.enable"); await send("Network.enable");
await send("Network.clearBrowserCookies");
await send("Emulation.setDeviceMetricsOverride", { width: 1440, height: 900, deviceScaleFactor: 2, mobile: false });
await send("Page.navigate", { url });
await sleep(9000);
console.log("LOGS:" + JSON.stringify(logs));
ws.close(); child.kill(); await sleep(300); process.exit(0);
