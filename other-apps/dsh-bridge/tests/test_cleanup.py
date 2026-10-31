#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""离线单测: kind=cleanup 的白名单与删除行为 (不连云端)。

    py -3 -X utf8 tests/test_cleanup.py

重点验安全: 绝对路径 / .. / 非法 id / 自己的 id 必须拒;
只要有一个 target 不合法, 整个任务一个目录都不许删(fail closed)。
"""

import os
import sys
import tempfile
import time

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.dirname(HERE))

import worker  # noqa: E402

OWN = "j20261030-235959-abcd"


def mk_job(root, name, files):
    base = os.path.join(root, name)
    for rel, size in files.items():
        p = os.path.join(base, rel)
        os.makedirs(os.path.dirname(p), exist_ok=True)
        with open(p, "wb") as f:
            f.write(b"x" * size)
    return base


def main():
    fails = []

    def check(cond, msg):
        if not cond:
            fails.append(msg)

    tmp = tempfile.mkdtemp(prefix="dsh-cleanup-")
    cfg = dict(worker.DEFAULT_CONFIG)
    cfg["jobs_root"] = os.path.join(tmp, "jobs")
    root = cfg["jobs_root"]
    os.makedirs(root)

    # ---- 1) 白名单: 该拒的一律拒
    bad = [
        ("E:/工作区/肥鱼之家/jobs/j20261030-222317-3e68", "绝对路径"),
        ("C:\\工作区\\肥鱼之家\\jobs\\j20261030-222317-3e68", "反斜杠绝对路径"),
        ("/opt/dafeiyu/j20261030-222317-3e68", "POSIX 绝对路径"),
        ("\\\\server\\share", "UNC 路径"),
        ("../j20261030-222317-3e68", ".. 开头"),
        ("j20261030-222317-3e68/../../etc", "夹 .. "),
        ("sub/j20261030-222317-3e68", "不在 jobs_root 下的子路径"),
        ("not-a-job", "不是 job id"),
        ("j20261030-222317-3E68", "hex 大写"),
        ("j2026103-222317-3e68", "日期位数不对"),
        ("", "空字符串"),
        ("   ", "空白"),
        (123, "不是字符串"),
        (None, "None"),
        (OWN, "cleanup 自己的目录"),
    ]
    for raw, why in bad:
        got, reason = worker.resolve_cleanup_target(cfg, raw, OWN)
        check(got is None, "本该拒绝却通过了: %s (%s)" % (raw, why))
        check(bool(reason), "拒绝时没给原因: %s" % (raw,))

    # ---- 2) 该过的一个都不许拦
    ok_names = ["j20261030-222317-3e68", "j20261030-232144-f00d", "j20261001-000000-dead"]
    for name in ok_names:
        got, reason = worker.resolve_cleanup_target(cfg, "  %s  " % name, OWN)
        check(got is not None, "合法的被拒了: %s (%s)" % (name, reason))
        if got:
            check(got[0] == name, "解析出的名字不对: %r" % (got[0],))
            check(os.path.dirname(got[1]) == os.path.abspath(root), "路径不在 jobs_root 下: %s" % got[1])

    # ---- 3) 真删: 1MB 成品 + 一个 8 天前的旧目录
    mb = 1024 * 1024
    vdir = mk_job(root, "j20261030-222317-3e68", {"out/video.mp4": mb, "out/meta.json": 300})
    tdir = mk_job(root, "j20261030-222608-cf86", {"out/answer.md": 900})
    odir = mk_job(root, "j20261001-000000-dead", {"out/video.mp4": 4096})
    old = time.time() - 8 * 86400
    os.utime(odir, (old, old))

    ok, text, err, meta = worker.cleanup_dirs(cfg, {"kind": "cleanup", "target": "j20261030-222317-3e68"}, OWN)
    check(ok is True, "正常 cleanup 该 ok: %s / %s" % (ok, err))
    check(not err, "正常 cleanup 不该有 error: %s" % err)
    check(not os.path.exists(vdir), "目标目录没删掉")
    check(os.path.isdir(tdir), "不该动别人的目录")
    check(not os.path.exists(odir), "8 天前的旧目录没顺手清掉")
    check(meta["freed_bytes"] >= mb, "释放字节数不对: %s" % meta["freed_bytes"])
    check("已删除本地任务目录 j20261030-222317-3e68（释放" in text, "回执文案不对: %s" % text)
    check(any(x["name"] == "j20261001-000000-dead" for x in meta["swept_old"]), "旧目录没记进 swept_old")
    check(OWN not in [x for x in meta["removed"]], "不该记自己")

    # ---- 4) 一个合法一个非法 => 整体拒绝, 合法的也不能删
    keep = mk_job(root, "j20261030-223000-beef", {"out/answer.md": 100})
    ok, text, err, meta = worker.cleanup_dirs(
        cfg, {"kind": "cleanup", "paths": ["j20261030-223000-beef", "../evil"]}, OWN)
    check(ok is False, "有非法 target 时该 ok=false")
    check("拒绝执行" in err, "拒绝原因文案不对: %s" % err)
    check(os.path.isdir(keep), "有非法 target 时不该删任何东西(fail closed)")

    # ---- 5) 不存在 / 空任务
    ok, text, err, _m = worker.cleanup_dirs(cfg, {"kind": "cleanup", "target": "j20200101-000000-aaaa"}, OWN)
    check(ok is True and "已不存在" in text, "已删除的目录该算成功: %s / %s" % (text, err))
    ok, text, err, _m = worker.cleanup_dirs(cfg, {"kind": "cleanup"}, OWN)
    check(ok is False and "target" in err, "空任务该报错: %s" % err)

    # ---- 6) 只读文件也能删掉(Windows 只读位)
    ro = mk_job(root, "j20261030-224000-cafe", {"out/video.mp4": 128})
    f = os.path.join(ro, "out", "video.mp4")
    os.chmod(f, 0o444)
    ok2, left, err2 = worker.remove_tree(ro)
    check(ok2 and not os.path.exists(ro), "只读文件目录删不掉: left=%s %s" % (left, err2))

    # ---- 7) expected_files: cleanup 默认要 meta.json
    check(worker.expected_files({"kind": "cleanup"}) == ["meta.json"], "cleanup 的 want 不对")

    if fails:
        for f in fails:
            print("FAIL:", f)
        return 1
    print("PASS  cleanup 白名单 + 删除行为 全部断言通过")
    return 0


if __name__ == "__main__":
    sys.exit(main())
