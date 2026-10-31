#!/usr/bin/env node
// Guard against the v4 session-format refusal
// "format v4 message requires a producer-owned source kind".
//
// DSH >= 0.1.7-rc.2 persists format v4 and refuses any durable message whose
// source.kind is the bare string "plugin". Run this after every plugin upgrade:
//
//   node verify_v4_source_kind.mjs          # exit 1 if a stale site comes back
//
// It scans the installed desktop profile for the retired literal and checks the
// three sites this patch repairs emit canonical producer kinds.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const PROFILE = path.join(os.homedir(), ".dsh", "profiles", "desktop", "node_modules");
const RETIRED = /kind\s*:\s*['"]plugin['"]\s*[,}]/g;
const SKIP_DIRS = new Set([".pnpm", "node_modules", "tests", "install-fixtures"]);

const hits = [];
function walk(dir) {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) walk(full);
    } else if (/\.(js|mjs|cjs)$/.test(entry.name)) {
      const text = fs.readFileSync(full, "utf8");
      RETIRED.lastIndex = 0;
      let match;
      while ((match = RETIRED.exec(text)) !== null) {
        const line = text.slice(0, match.index).split("\n").length;
        hits.push(path.relative(PROFILE, full) + ":" + line);
      }
    }
  }
}

walk(PROFILE);

const expectations = [
  ["dsh-cron/index.js", "plugin:dsh-cron"],
  ["dsh-work-components/lib/channel-telegram.mjs", "ptc-mode"],
  ["dsh-work-components/lib/channel-telegram.mjs", "model-selection"],
];
const missing = expectations.filter(([rel, kind]) => {
  const file = path.join(PROFILE, ...rel.split("/"));
  if (!fs.existsSync(file)) return true;
  const text = fs.readFileSync(file, "utf8");
  return !text.includes('kind: "' + kind + '"') && !text.includes("kind: '" + kind + "'");
});

if (hits.length === 0 && missing.length === 0) {
  console.log("PASS: no retired source kind in the installed profile.");
  process.exit(0);
}
for (const hit of hits) console.log("STALE source kind: " + hit);
for (const [rel, kind] of missing) console.log("MISSING canonical kind " + kind + " in " + rel);
console.log("FAIL: run patch_v4_source_kind.py, then restart DSH.");
process.exit(1);
