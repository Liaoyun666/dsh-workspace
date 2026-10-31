// 用无头 Edge 通过 CDP 打开 DSH 网页，按指定手机/平板尺寸截图或跑一段 JS。
//
// 为什么不用 msedge --headless --screenshot：那样直接打 DSH 页面会 renderer 崩溃 / 超时。
//
// 用法：
//   ELECTRON_RUN_AS_NODE=1 "<node>" tools/shot.mjs <url> <宽> <高> <输出.png> [模式] [截图路径]
//   模式：shot（默认，只截图）/ eval（跑 <输出.png> 位置上的 JS 文件并打印 EVAL:）/ dump（打印带类名元素的位置）
//
// 环境变量：
//   EDGE_PATH   浏览器 exe（默认 Edge）
//   PROFILE_DIR 浏览器用户目录（默认 C:/Temp/dsh-ui-profile，会被清 cookie）
//   BOOT        页面加载前注入的脚本（tools/inject-boot.mjs 生成的 boot-plugin.js）
//
// 拿带 token 的地址：
//   TOKEN=$(curl -s http://127.0.0.1:<端口>/relay/api/enter | grep -o 'token=[A-Za-z0-9_-]*' | head -1 | cut -d= -f2)
//   url="http://127.0.0.1:<端口>/?token=$TOKEN"
import { spawn } from "node:child_process";
import { writeFileSync, mkdirSync, readFileSync } from "node:fs";

const EDGE = process.env.EDGE_PATH || "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe";
const PROFILE = process.env.PROFILE_DIR || "C:/Temp/dsh-ui-profile";
const PORT = Number(process.env.CDP_PORT || 9333);
const [, , url, w, h, out, mode, shotOut] = process.argv;
if (!url) {
  console.log("usage: shot.mjs <url> <width> <height> <out> [eval|dump] [shotOut]");
  process.exit(2);
}
const width = Number(w || 390);
const height = Number(h || 844);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

mkdirSync(PROFILE, { recursive: true });
const child = spawn(EDGE, [
  "--headless=new", "--disable-gpu", "--no-sandbox", "--no-first-run",
  "--remote-debugging-port=" + PORT,
  "--user-data-dir=" + PROFILE,
  "--window-size=" + width + "," + height,
  "about:blank",
], { stdio: "ignore" });

let version = null;
for (let i = 0; i < 60; i++) {
  await sleep(500);
  try { version = await (await fetch("http://127.0.0.1:" + PORT + "/json/version")).json(); break; } catch {}
}
if (!version) { console.log("EDGE_NOT_READY"); child.kill(); process.exit(1); }
console.log("browser:", version.Browser);

const tgt = await (await fetch("http://127.0.0.1:" + PORT + "/json/new?about:blank", { method: "PUT" })).json();
const ws = new WebSocket(tgt.webSocketDebuggerUrl);
let id = 0;
const pending = new Map();
ws.addEventListener("message", (ev) => {
  const msg = JSON.parse(ev.data);
  if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); }
});
await new Promise((r) => ws.addEventListener("open", r, { once: true }));
const send = (method, params) => new Promise((resolve) => {
  const mid = ++id;
  pending.set(mid, resolve);
  ws.send(JSON.stringify({ id: mid, method, params: params || {} }));
});

await send("Page.enable");
await send("Runtime.enable");
await send("Network.enable");
// 持久 profile 里的旧 cookie 会让页面直接返回纯文本「dsh web authentication required」
await send("Network.clearBrowserCookies");
await send("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 2, mobile: width < 700 });

const bootPath = process.env.BOOT;
if (bootPath) {
  const boot = readFileSync(bootPath, "utf8");
  await send("Page.addScriptToEvaluateOnNewDocument", { source: boot });
  console.log("injected boot:", bootPath, boot.length, "bytes");
}
await send("Page.navigate", { url });

const readyExpr = "!!document.querySelector(" + JSON.stringify('[class*="_sidebarCol"]') + ")";
let ready = false;
for (let i = 0; i < 40; i++) {
  await sleep(500);
  const r = await send("Runtime.evaluate", { expression: readyExpr, returnByValue: true });
  if (r.result && r.result.result && r.result.result.value === true) { ready = true; break; }
}
console.log("frame ready:", ready);
await sleep(2500);

const capture = async () => {
  const s = await send("Page.captureScreenshot", { format: "png", captureBeyondViewport: false });
  writeFileSync(shotOut || out, Buffer.from(s.result.data, "base64"));
  console.log("saved", shotOut || out);
};

if (mode === "eval") {
  const src = readFileSync(out, "utf8");
  const r = await send("Runtime.evaluate", { expression: src, awaitPromise: true, returnByValue: true });
  console.log("EVAL:" + JSON.stringify(r.result));
  if (shotOut) { await sleep(600); await capture(); }
} else if (mode === "dump") {
  const dumpExpr = "JSON.stringify(Array.from(document.querySelectorAll('[class]')).map(function(e){var c=(typeof e.className==='string'?e.className:'');var b=e.getBoundingClientRect();return {t:e.tagName,c:c.split(' ').filter(function(x){return x.indexOf('_')>=0}).join(' '),x:Math.round(b.x),y:Math.round(b.y),w:Math.round(b.width),h:Math.round(b.height)}}).filter(function(o){return o.c && o.w>0}).slice(0,120))";
  const r = await send("Runtime.evaluate", { expression: dumpExpr, returnByValue: true });
  console.log("DUMP:" + (r.result && r.result.result ? r.result.result.value : "null"));
} else {
  await capture();
}

ws.close();
child.kill();
await sleep(500);
process.exit(0);
