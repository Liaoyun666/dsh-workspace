import net from "node:net";
import fs from "node:fs";
const [,, file, modeArg] = process.argv;
const code = fs.readFileSync(file, "utf8");
const mode = modeArg || "code";
const params = mode === "code" ? { code } : { code, args: JSON.parse(modeArg) };
const payload = JSON.stringify({ id: 1, command: "execute_code", params }) + "\n";
const sock = net.createConnection({ host: "127.0.0.1", port: 6401 });
let buf = "";
sock.setEncoding("utf8");
sock.on("connect", () => sock.write(payload));
sock.on("data", d => {
  buf += d;
  const i = buf.indexOf("\n");
  if (i < 0) return;
  sock.end();
  const line = buf.slice(0, i);
  fs.writeFileSync(file + ".resp.json", line);
  let j;
  try { j = JSON.parse(line); } catch (e) { console.log("BADJSON " + line.slice(0, 400)); process.exit(3); }
  if (j.status !== "ok") { console.log("STATUS=" + j.status + " err=" + JSON.stringify(j.error)); process.exit(1); }
  const r = j.result || {};
  console.log("compiled=" + r.compiled + " durationMs=" + r.durationMs);
  if (r.result !== undefined && r.result !== null) console.log(typeof r.result === "string" ? r.result : JSON.stringify(r.result));
  for (const l of (r.logs || [])) console.log("[" + l.type + "] " + (l.message || "").slice(0, 400));
  process.exit(0);
});
sock.on("error", e => { console.log("ERR " + e.message); process.exit(1); });
setTimeout(() => { console.log("TIMEOUT " + buf.slice(0, 300)); process.exit(2); }, 600000);
