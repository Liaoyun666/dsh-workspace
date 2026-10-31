#!/usr/bin/env node
// 给 dsh-dream-skin 的 trustedAuthorities(ctx) 打「合并 connection 服务 trustedHosts」补丁。
// 幂等；打之前备份到 backup/。用法见同目录 README.md。
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const TARGET = process.env.DSH_DREAM_SKIN_INDEX ||
  "C:/Users/user\\.dsh\\profiles\\desktop\\node_modules\\dsh-dream-skin\\lib\\index.js";
const MARKER = "function trustedAuthorities(ctx) {";

const PATCHED = [
  "function trustedAuthorities(ctx) {",
  "	const hosts = [];",
  "	const startup = ctx.get(\"webStartup\");",
  "	if (startup !== undefined && startup !== null) hosts.push(...(startup.trustedHosts ?? []));",
  "	const runtime = ctx.get(\"webRuntime\");",
  "	if (runtime !== undefined && runtime !== null) hosts.push(...(runtime.trustedHosts ?? []));",
  "	// The connection service is the authority that fences the /api gateway, and its",
  "	// list also carries the authorities declared on that plugin itself (the desktop",
  "	// profile's cordis.patch.yml), which neither service above reports. Without this",
  "	// a deployment reached through a reverse proxy or tunnel 403s on every call here",
  "	// while the rest of the UI works (the same wiring dsh-market uses).",
  "	const connection = ctx.get(\"connection\");",
  "	if (connection !== undefined && connection !== null && Array.isArray(connection.trustedHosts)) {",
  "		hosts.push(...connection.trustedHosts.filter((entry) => typeof entry === \"string\"));",
  "	}",
  "	return [...new Set(hosts)];",
  "}",
].join("\n");

function findBlock(text) {
  const start = text.indexOf(MARKER);
  if (start < 0) return null;
  let i = text.indexOf("{", start);
  let depth = 0;
  for (; i < text.length; i += 1) {
    const ch = text[i];
    if (ch === "{") depth += 1;
    else if (ch === "}") {
      depth -= 1;
      if (depth === 0) return { start, end: i + 1 };
    }
  }
  return null;
}

function smokeTest(patchText) {
  const body = patchText.slice(patchText.indexOf("{") + 1, patchText.lastIndexOf("}"));
  const fn = new Function("ctx", body);
  const ctx = { get: (k) => ({ connection: { trustedHosts: ["h1", 7, "h2"] }, webStartup: { trustedHosts: ["h1"] } })[k] };
  const out = fn(ctx);
  if (JSON.stringify(out) !== JSON.stringify(["h1", "h2"])) throw new Error("smoke test failed: " + JSON.stringify(out));
  return out;
}

const check = process.argv.includes("--check");
const text = fs.readFileSync(TARGET, "utf8");
const block = findBlock(text);
if (block === null) {
  console.error("[x] 找不到 " + MARKER + " —— 插件结构变了，手工看 " + TARGET);
  process.exit(2);
}
const current = text.slice(block.start, block.end);
if (current.includes("ctx.get(\"connection\")")) {
  console.log("[ok] already patched: " + TARGET);
  process.exit(0);
}
if (check) {
  console.log("[!] NOT patched: " + TARGET);
  process.exit(1);
}
smokeTest(PATCHED);
fs.mkdirSync(path.join(HERE, "backup"), { recursive: true });
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const backup = path.join(HERE, "backup", "index.js." + stamp + ".bak");
fs.writeFileSync(backup, text);
fs.writeFileSync(TARGET, text.slice(0, block.start) + PATCHED + text.slice(block.end));
console.log("[+] patched: " + TARGET);
console.log("    backup: " + backup);
console.log("    重启 Desktop 后生效。");