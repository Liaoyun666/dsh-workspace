# -*- coding: utf-8 -*-
"""离线验证 send_intermediates 开关 (不花任何 token, 不连云端).

跑法: py -3 -X utf8 tests/test_outputs_filter.py
"""
import os
import shutil
import sys
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.dirname(HERE))
import worker  # noqa: E402

FAILS = []


def check(cond, msg):
    if not cond:
        FAILS.append(msg)


def make_job(workdir, files):
    out = os.path.join(workdir, "out")
    os.makedirs(out)
    for name, data in files.items():
        with open(os.path.join(out, name), "wb") as fh:
            fh.write(data)
    return workdir


def run_case(send_extra):
    root = tempfile.mkdtemp(prefix="bridge_out_")
    try:
        wd = make_job(os.path.join(root, "j20261031-000000-aaaa"), {
            "answer.md": b"# hello\n" * 20,
            "meta.json": b'{"title":"t"}',
            "make.py": b"print(1)\n",
            "voice.mp3": b"ID3" + b"\0" * 100,
            "voice.json": b"{}",
            "answer_backup.txt": b"old",       # junk 名字, 任何时候都不传
        })
        cfg = {"send_intermediates": send_extra, "ffmpeg_bin": "C:/nonexistent"}
        job = {"id": "j20261031-000000-aaaa", "kind": "text",
               "want": ["answer.md"], "prompt": "x"}
        dsh = {"timed_out": False, "final_text": "done"}
        ok, err, files, found = worker.collect_outputs(cfg, job, wd, dsh)
        return ok, err, [f["name"] for f in files], sorted(os.listdir(os.path.join(wd, "_pkg")))
    finally:
        shutil.rmtree(root, ignore_errors=True)


# 1) 默认(false): 只有 want + meta.json, 中间件一个都不许进 _pkg
ok, err, names, pkg = run_case(False)
check(ok, "默认情况应当 ok, 实际 err=%r" % err)
check("answer.md" in names, "默认情况丢了 want 里的 answer.md")
check("meta.json" in names, "默认情况丢了 meta.json")
for bad in ("make.py", "voice.mp3", "voice.json", "answer_backup.txt"):
    check(bad not in names, "默认情况不该回传 %s, 但有: %s" % (bad, names))
    check(bad not in pkg, "默认情况 _pkg 里不该有 %s" % bad)
check(names == pkg, "files 清单与 _pkg 内容不一致: %s vs %s" % (names, pkg))

# 2) 打开开关: 除了 junk, 其余都传
ok2, err2, names2, pkg2 = run_case(True)
check(ok2, "send_intermediates=true 应当 ok, 实际 err=%r" % err2)
for want in ("answer.md", "meta.json", "make.py", "voice.mp3", "voice.json"):
    check(want in names2, "开关打开时漏了 %s" % want)
check("answer_backup.txt" not in names2, "junk 名字即使打开开关也不该传")

if FAILS:
    print("FAIL")
    for f in FAILS:
        print("  - " + f)
    sys.exit(1)
print("PASS  send_intermediates 过滤 全部断言通过 (默认只传 want+meta.json, 开关打开才传中间件, junk 永不传)")
