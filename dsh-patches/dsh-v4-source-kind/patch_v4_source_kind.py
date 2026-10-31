#!/usr/bin/env python3
"""Fix retired v4 message source kinds in installed DSH plugins.

DSH >= 0.1.7-rc.2 persists session format v4 and refuses any message whose
source.kind is the bare string "plugin" ("format v4 message requires a
producer-owned source kind"). Three local plugin builds still emit that shape,
so the injected turn dies. This script rewrites them to canonical producer kinds.

  python patch_v4_source_kind.py            # apply patch  (before -> after)
  python patch_v4_source_kind.py --check    # report only; exit 1 when stale
  python patch_v4_source_kind.py --restore  # revert       (after  -> before)
"""
import sys, pathlib

PROFILE = pathlib.Path.home() / ".dsh" / "profiles" / "desktop" / "node_modules"
CRON = PROFILE / "dsh-cron" / "index.js"
TG = PROFILE / "dsh-work-components" / "lib" / "channel-telegram.mjs"

# (file, before, after)
SITES = [
    (CRON,
     "source: { kind: 'plugin', plugin: 'cron' },",
     "source: { kind: 'plugin:dsh-cron' },"),
    (TG,
     'kind: "plugin",\n                  plugin: "tools-ptc"',
     'kind: "ptc-mode"'),
    (TG,
     'kind: "plugin",\n      plugin: "model-selection",',
     'kind: "model-selection",'),
]


def main(argv):
    check = "--check" in argv
    restore = "--restore" in argv
    pending = 0
    for path, before, after in SITES:
        want, have = (before, after) if restore else (after, before)
        label = "restore" if restore else "patch"
        if not path.exists():
            print(f"[skip] missing file: {path}")
            continue
        src = path.read_text(encoding="utf-8")
        if want in src:
            print(f"[ok]    {path.name}: already {label}ed")
            continue
        if have not in src:
            print(f"[warn]  {path}: neither {label}ed nor original text found")
            pending += 1
            continue
        pending += 1
        if check:
            print(f"[stale] {path}: needs {label}")
            continue
        path.write_text(src.replace(have, want, 1), encoding="utf-8")
        print(f"[done]  {path}  ({label})")
    if check:
        print("STALE" if pending else "CLEAN")
        return 1 if pending else 0
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
