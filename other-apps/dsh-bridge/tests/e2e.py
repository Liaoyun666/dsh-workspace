#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""端到端自测: 往云端 inbox 丢一个 job, 等 result.json, 断言产物 + 回传顺序。

    py -3 -X utf8 tests/e2e.py text
    py -3 -X utf8 tests/e2e.py video

主机/私钥/队列根目录都从 ../config.json 读 (worker.load_config())。
用 jTEST-<时间戳> 作 id, 跑完不自动删 (交给 tests/cleanup.py), 方便看现场。

video 用 4~6 秒的极简片子, 只为验证链路, 不浪费模型额度。

顺序断言 (lead m00299): outbox/<id>/ 里 result.json 必须最后落地 ——
插件一见 result.json 就把目录搬去 done/, 成品没到齐就会被判"视频没找着"。
"""

import io
import json
import os
import subprocess
import sys
import time
from datetime import datetime, timezone, timedelta

CST = timezone(timedelta(hours=8))
HERE = os.path.dirname(os.path.abspath(__file__))
BRIDGE = os.path.dirname(HERE)
sys.path.insert(0, BRIDGE)

from worker import load_config, ssh as _wssh, SCP_EXE, SUBMIT_MARKER  # noqa: E402

CFG = load_config()
HOST = CFG["ssh_host"]
KEY = CFG["ssh_key"]
ROOT = CFG["remote_root"]
PULL = os.path.join(os.path.dirname(CFG["jobs_root"].replace("/", "\\")), "_e2e")


def ssh(cmd, timeout=90):
    return _wssh(CFG, cmd, timeout)


def make_fake_job_dir(bytes_mb=1.5):
    """给 kind=cleanup 造一个「合法的旧任务目录」，里面放一个像样的成品。"""
    jobs_root = CFG["jobs_root"].replace("/", "\\")
    jid = "j" + datetime.now(CST).strftime("%Y%m%d-%H%M%S") + "-" + os.urandom(2).hex()
    d = os.path.join(jobs_root, jid)
    os.makedirs(os.path.join(d, "out"), exist_ok=True)
    payload = os.urandom(int(bytes_mb * 1024 * 1024))
    with open(os.path.join(d, "out", "video.mp4"), "wb") as f:
        f.write(payload)
    with io.open(os.path.join(d, "out", "meta.json"), "w", encoding="utf-8") as f:
        json.dump({"title": "假的测试成品"}, f, ensure_ascii=False)
    return jid, d, len(payload)


def make_job(kind, extra=None):
    jid = "jTEST-" + datetime.now(CST).strftime("%Y%m%d-%H%M%S")
    if kind == "video":
        prompt = ("做一条 4~6 秒的极简测试视频：画面就用大字写「测试通过」，"
                  "配一句中文语音「测试通过」，再写 meta.json。")
        want = ["video.mp4", "meta.json"]
    elif kind == "cleanup":
        prompt = "回收测试"
        want = ["meta.json"]
    else:
        prompt = ("写一篇 300 字左右的短文，主题是：一条胖鱼在海边捡到一枚会发光的贝壳。"
                  "用中文，分三段，标题自拟。")
        want = ["answer.md"]
    job = {"id": jid, "kind": kind, "prompt": prompt,
           "created": datetime.now(CST).isoformat(timespec="seconds"),
           "want": want}
    if extra:
        job.update(extra)
    return job


def push_job(job):
    tmp = os.path.join(PULL, job["id"] + ".json")
    os.makedirs(PULL, exist_ok=True)
    with io.open(tmp, "w", encoding="utf-8") as f:
        json.dump(job, f, ensure_ascii=False, indent=2)
    err = ""
    for attempt in (1, 2, 3):
        p = subprocess.run([SCP_EXE, "-i", KEY, "-o", "StrictHostKeyChecking=no",
                            "-o", "LogLevel=ERROR", tmp,
                            "%s:%s/inbox/%s.json" % (HOST, ROOT, job["id"])],
                           capture_output=True, text=True, encoding="utf-8",
                           errors="replace", timeout=120)
        if p.returncode == 0:
            print("已投递 job: %s (kind=%s)" % (job["id"], job["kind"]))
            return
        err = (p.stderr or p.stdout).strip()
        print("  scp 第 %d 次失败: %s" % (attempt, err[:160]))
        time.sleep(3 * attempt)
    raise RuntimeError("scp 丢 job 失败: %s" % err)


def remote_listing(jid):
    """outbox/<id>/ 的 ns 时间戳 + 字节数 + 文件名, 作为落地顺序证据。"""
    rc, out, _ = ssh("cd '%s/outbox/%s' 2>/dev/null && "
                     "stat -c '%%.9Y %%s %%n' * 2>/dev/null" % (ROOT, jid))
    rows = []
    for line in out.splitlines():
        parts = line.split(" ", 2)
        if len(parts) == 3 and parts[1].isdigit():
            try:
                mt = float(parts[0])
            except ValueError:
                continue
            rows.append({"mtime": mt, "bytes": int(parts[1]), "name": parts[2]})
    return rows


def pull_dir(src_dir, dest):
    p = subprocess.run([SCP_EXE, "-i", KEY, "-o", "StrictHostKeyChecking=no",
                        "-o", "LogLevel=ERROR", "-r",
                        "%s:%s/." % (HOST, src_dir), dest],
                       capture_output=True, text=True, encoding="utf-8",
                       errors="replace", timeout=300)
    return p.returncode == 0, (p.stderr or p.stdout)


def wait_result(jid, limit=1500):
    dest = os.path.join(PULL, jid)
    os.makedirs(dest, exist_ok=True)
    t0 = time.time()
    while time.time() - t0 < limit:
        time.sleep(5)
        elapsed = int(time.time() - t0)
        hb = ssh("cat '%s/worker.heartbeat'" % ROOT)[1].strip()
        ready = ssh("test -f '%s/outbox/%s/result.json' && echo YES" % (ROOT, jid))[1].strip()
        print("  [%4ds] heartbeat=%s result?=%s" % (elapsed, hb, "yes" if ready else "no"))
        if not ready:
            continue
        # 先立刻抓一份目录快照 (插件可能在 20 秒内把整个目录搬走)
        listing = remote_listing(jid)
        ok, err = pull_dir("%s/outbox/%s" % (ROOT, jid), dest)
        if not ok:
            print("  从 outbox 拉失败(%s), 试 done/" % err.strip()[:160])
            ok, err = pull_dir("%s/done/%s" % (ROOT, jid), dest)
        if not ok:
            raise RuntimeError("scp 拉成品失败: %s" % err)
        with io.open(os.path.join(dest, SUBMIT_MARKER), encoding="utf-8") as f:
            return json.load(f), dest, listing
    raise RuntimeError("等 result.json 超时 (%ss)" % limit)


def ffprobe(path):
    probe = os.path.join(CFG["ffmpeg_bin"].replace("/", "\\"), "ffprobe.exe")
    p = subprocess.run([probe, "-v", "error", "-show_entries",
                        "stream=codec_type,codec_name:format=duration,size",
                        "-of", "json", path],
                       capture_output=True, text=True, encoding="utf-8",
                       errors="replace", timeout=120)
    return json.loads(p.stdout or "{}")


def main():
    kind = (sys.argv[1] if len(sys.argv) > 1 else "text").lower()
    fake = None
    extra = None
    if kind == "cleanup":
        fake_id, fake_dir, fake_bytes = make_fake_job_dir()
        fake = {"id": fake_id, "dir": fake_dir, "bytes": fake_bytes}
        extra = {"target": fake_id}
        print("已造一个待回收的假任务目录: %s (%d B)" % (fake_dir, fake_bytes))
    job = make_job(kind, extra)
    push_job(job)
    result, dest, listing = wait_result(job["id"], limit=(600 if kind == "cleanup" else 1500))

    print("\n=== result.json 原文 ===")
    print(io.open(os.path.join(dest, SUBMIT_MARKER), encoding="utf-8").read())

    print("\n=== 远端落地顺序 (ns mtime / bytes / name) ===")
    for row in listing:
        print("  %.3f  %10d  %s" % (row["mtime"], row["bytes"], row["name"]))

    failures = []
    if not result.get("ok"):
        failures.append("ok != true (error: %s)" % result.get("error"))
    if not (result.get("text") or "").strip():
        failures.append("text 为空")
    if kind != "cleanup" and not result.get("session_id"):
        failures.append("session_id 为空")
    got = [f["name"] for f in result.get("files", [])]
    for want in job["want"]:
        if want not in got:
            failures.append("result.files 里没有 %s" % want)
        if not os.path.exists(os.path.join(dest, want)):
            failures.append("本地没拉到 %s" % want)
    # send_intermediates=false(默认): 只允许 want + meta.json, make.py/voice.* 之类不许回传
    extra = [n for n in got if n not in set(job["want"]) | {"meta.json"}]
    if extra:
        failures.append("回传了 want 之外的中间件: %s" % ", ".join(sorted(extra)))

    # --- 顺序断言: result.json 必须最后落地, 且落地时成品都在 ---
    names = [r["name"] for r in listing]
    if names:
        if SUBMIT_MARKER not in names:
            failures.append("目录快照里没有 %s (抓晚了?)" % SUBMIT_MARKER)
        else:
            marker_t = [r for r in listing if r["name"] == SUBMIT_MARKER][0]["mtime"]
            arts = [r for r in listing if r["name"] != SUBMIT_MARKER]
            for want in job["want"]:
                if want not in names:
                    failures.append("顺序断言: result.json 落地时 %s 还不在目录里" % want)
            for r in arts:
                if r["mtime"] > marker_t:
                    failures.append("顺序断言: %s 比 result.json 更晚落地" % r["name"])
            print("顺序断言: result.json mtime=%.3f >= 其它最大 %.3f ... %s"
                  % (marker_t, max([r["mtime"] for r in arts] or [0]),
                     "OK" if not any("顺序断言" in f for f in failures) else "FAIL"))
    else:
        print("顺序断言: 没抓到 outbox 快照(可能已被插件搬走), 只能看日志里的回传顺序")

    # 字节数一致
    for row in listing:
        local = os.path.join(dest, row["name"])
        if os.path.exists(local):
            n = os.path.getsize(local)
            if n != row["bytes"]:
                failures.append("字节数不一致: %s 远端=%d 本地=%d" % (row["name"], row["bytes"], n))

    if kind == "video" and os.path.exists(os.path.join(dest, "video.mp4")):
        info = ffprobe(os.path.join(dest, "video.mp4"))
        types = [s.get("codec_type") for s in info.get("streams", [])]
        dur = float(info.get("format", {}).get("duration") or 0)
        print("\n=== ffprobe ===")
        print(json.dumps(info, ensure_ascii=False, indent=2)[:1500])
        if "video" not in types:
            failures.append("没有视频流")
        if "audio" not in types:
            failures.append("没有音频流")
        if dur < 3:
            failures.append("时长 %.2fs < 3s" % dur)
        if os.path.exists(os.path.join(dest, "meta.json")):
            meta = json.load(io.open(os.path.join(dest, "meta.json"), encoding="utf-8"))
            print("meta:", json.dumps(meta, ensure_ascii=False)[:400])
            if not (meta.get("title") or "").strip():
                failures.append("meta.title 为空")
    elif kind == "text" and os.path.exists(os.path.join(dest, "answer.md")):
        body = io.open(os.path.join(dest, "answer.md"), encoding="utf-8").read()
        print("\n=== answer.md (%d 字) ===\n%s" % (len(body), body[:600]))
    elif kind == "cleanup":
        txt = (result.get("text") or "")
        print("\n=== cleanup 回执 ===\n%s" % txt)
        if "已删除本地任务目录 " + fake["id"] not in txt:
            failures.append("回执里没有「已删除本地任务目录 %s」" % fake["id"])
        if os.path.exists(fake["dir"]):
            failures.append("假任务目录还在, 没删掉: %s" % fake["dir"])
        meta_path = os.path.join(dest, "meta.json")
        if not os.path.exists(meta_path):
            failures.append("没拉到 meta.json")
        else:
            meta = json.load(io.open(meta_path, encoding="utf-8"))
            print("\n=== cleanup meta.json ===")
            print(json.dumps(meta, ensure_ascii=False, indent=2)[:1200])
            if fake["id"] not in (meta.get("removed") or []):
                failures.append("meta.removed 里没有 %s" % fake["id"])
            if int(meta.get("freed_bytes") or 0) < fake["bytes"]:
                failures.append("meta.freed_bytes=%s < 假文件 %d B"
                                % (meta.get("freed_bytes"), fake["bytes"]))

    rc, out, _ = ssh("ls -1 '%s/done/%s.json' 2>/dev/null" % (ROOT, job["id"]))
    if not out.strip():
        failures.append("done/ 里没有 %s.json (没归档)" % job["id"])

    print("\n=== 判定 ===")
    if failures:
        for f in failures:
            print("FAIL:", f)
        return 1
    print("PASS  job=%s  本地成品目录=%s" % (job["id"], dest))
    return 0


if __name__ == "__main__":
    sys.exit(main())
