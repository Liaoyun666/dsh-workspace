#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""DshFishBridge - 云端 AstrBot 插件 <-> 本机 DSH 的主机端 worker.

拉取式队列: 每 POLL_INTERVAL 秒 ssh 到云端列一次 inbox/ 并写心跳,
有活就认领 -> 跑 DSH headless -> 把成品 scp 回 outbox/<id>/ -> 归档到 done/.

只依赖标准库. 见 README.md 了解契约.
"""

import ctypes
import io
import json
import logging
import logging.handlers
import os
import re
import shutil
import socket
import subprocess
import sys
import threading
import time
import traceback
from datetime import datetime, timezone, timedelta

# ---------------------------------------------------------------- 常量 / 路径
BRIDGE_DIR = os.path.dirname(os.path.abspath(__file__))
LOG_DIR = os.path.join(BRIDGE_DIR, "logs")
CONFIG_PATH = os.path.join(BRIDGE_DIR, "config.json")

CST = timezone(timedelta(hours=8))  # 云端与本机都在 +08:00

DEFAULT_CONFIG = {
    "ssh_key": "C:/Users/user/.ssh/id_ed25519",
    "ssh_host": "root@203.0.113.10",
    "remote_root": "/opt/dafeiyu/astrbot-data/data/dsh-jobs",
    "jobs_root": "E:/工作区/肥鱼之家/jobs",
    "dsh_exe": "E:/Deepseek/DeepSeek Harness.exe",
    "dsh_cli_js": "E:/Deepseek/resources/app.asar/dsh/node_modules/"
                  "@deepseek-ai/dsh-desktop-host/lib/cli.js",
    "credentials": "C:/Users/user/.dsh/.credentials.yaml",
    "api_key_name": "DEEPSEEK_API_KEY",
    "ffmpeg_bin": "C:/Users/user/AppData/Local/ffmpeg/bin",
    "poll_interval": 15,
    "heartbeat_interval": 20,
    "job_timeout": 3300,
    "text_job_timeout": 900,
    "vendor_py": "E:/工作区/肥鱼之家/.vendor/py",
    "toolkit_dir": "E:/工作区/肥鱼之家/toolkit",
    "ssh_timeout": 60,
    "keep_job_dirs": 20,
    # 是否把 out/ 里的中间件 (make.py / voice.mp3 / 临时图 …) 一起回传。
    # false: 只传 want 点名的成品 + meta.json + result.json, done/ 里保持干净。
    "send_intermediates": False,
}

SSH_EXE = "C:/Windows/System32/OpenSSH/ssh.exe"
SCP_EXE = "C:/Windows/System32/OpenSSH/scp.exe"

MUTEX_NAME = "Global\\DshFishBridge-Worker"

# Windows: 子进程默认会新建一个可见控制台窗口(本机默认终端是 Windows Terminal,
# 每 15~20 秒一次的 ssh.exe 就会闪一个 "Terminal" 窗)。所有子进程一律隐藏。
CREATE_NO_WINDOW = getattr(subprocess, "CREATE_NO_WINDOW", 0x08000000)

log = logging.getLogger("bridge")


# ---------------------------------------------------------------- 基础设施
def now_iso():
    return datetime.now(CST).isoformat(timespec="seconds")


def setup_logging():
    os.makedirs(LOG_DIR, exist_ok=True)
    handler = logging.handlers.RotatingFileHandler(
        os.path.join(LOG_DIR, "worker.log"),
        maxBytes=5 * 1024 * 1024, backupCount=3, encoding="utf-8")
    handler.setFormatter(logging.Formatter(
        "%(asctime)s %(levelname)-7s %(message)s", "%Y-%m-%dT%H:%M:%S%z"))
    log.addHandler(handler)
    log.setLevel(logging.INFO)
    if sys.stderr is not None and sys.stderr.isatty():
        sh = logging.StreamHandler(sys.stderr)
        sh.setFormatter(handler.formatter)
        log.addHandler(sh)


def load_config():
    cfg = dict(DEFAULT_CONFIG)
    if os.path.exists(CONFIG_PATH):
        try:
            with io.open(CONFIG_PATH, encoding="utf-8") as f:
                cfg.update(json.load(f) or {})
        except Exception as exc:
            print("config.json 读取失败, 用默认值: %r" % (exc,), file=sys.stderr)
    return cfg


def single_instance_guard():
    """Windows 命名互斥体: 第二个实例静默退出 (计划任务每 5 分钟拉起也不会叠)。"""
    try:
        kernel32 = ctypes.windll.kernel32
        handle = kernel32.CreateMutexW(None, False, MUTEX_NAME)
        ERROR_ALREADY_EXISTS = 183
        if kernel32.GetLastError() == ERROR_ALREADY_EXISTS:
            return None
        return handle
    except Exception:
        return True


def read_api_key(cfg):
    """从 .credentials.yaml 的 refs: 段读 DEEPSEEK_API_KEY, 绝不打印明文。"""
    name = cfg["api_key_name"]
    path = cfg["credentials"]
    with io.open(path, encoding="utf-8") as f:
        text = f.read()
    in_refs = False
    for line in text.splitlines():
        if re.match(r"^\S", line):
            in_refs = line.strip().lower().startswith("refs:")
            continue
        if in_refs:
            m = re.match(r"^\s+" + re.escape(name) + r"\s*:\s*(.+?)\s*$", line)
            if m:
                val = m.group(1).strip().strip("\"'")
                if val:
                    return val
    raise RuntimeError("credentials 里找不到 refs.%s" % name)


def ssh_base(cfg):
    return [SSH_EXE, "-i", cfg["ssh_key"], "-o", "StrictHostKeyChecking=no",
            "-o", "BatchMode=yes", "-o", "ConnectTimeout=20",
            "-o", "LogLevel=ERROR", cfg["ssh_host"]]


def run(cmd, timeout, cwd=None, env=None):
    """跑一条命令, 返回 (rc, stdout, stderr)。永不抛异常。"""
    try:
        p = subprocess.run(cmd, cwd=cwd, env=env, capture_output=True,
                           text=True, encoding="utf-8", errors="replace",
                           timeout=timeout, creationflags=CREATE_NO_WINDOW)
        return p.returncode, p.stdout, p.stderr
    except subprocess.TimeoutExpired as exc:
        out = exc.stdout or ""
        err = exc.stderr or ""
        if isinstance(out, bytes):
            out = out.decode("utf-8", "replace")
        if isinstance(err, bytes):
            err = err.decode("utf-8", "replace")
        return -9, out, err + "\n[TIMEOUT after %ss]" % timeout
    except Exception as exc:
        return -1, "", "%r" % (exc,)


def ssh(cfg, remote_cmd, timeout=None, retries=1, backoff=1.5):
    """跑一条远端命令, 返回 (rc, stdout, stderr)。

    retries>1 时只在**连接层失败**(rc 255/超时)上重试, 命令真跑过(有 stdout 或
    rc 是普通业务错误)不重试。云机 ssh 偶发 "Connection closed", 重试一次基本就过。

    **只给幂等命令用**: ls / stat / mkdir -p / cat / 心跳覆盖写 / mv -f / ln 认领。
    scp 传大文件别走这里 —— 那是 push_results 的 3 次重试 + flush_pending 补传的活。
    """
    tries = max(1, int(retries))
    rc, out, err = 0, "", ""
    for attempt in range(1, tries + 1):
        rc, out, err = run(ssh_base(cfg) + [remote_cmd],
                           timeout or cfg["ssh_timeout"])
        err = "\n".join(l for l in err.splitlines()
                        if "post-quantum" not in l and "store now" not in l
                        and "openssh.com/pq" not in l).strip()
        if rc == 0 or rc not in (255, -9, -1):
            return rc, out, err
        if attempt >= tries:
            break
        log.warning("ssh 第 %d/%d 次连不上, %.1fs 后重试: %s",
                    attempt, tries, backoff * attempt, (err or out).strip()[:200])
        time.sleep(backoff * attempt)
    return rc, out, err


# ---------------------------------------------------------------- 队列操作
def heartbeat_once(cfg):
    """单独写一次远端心跳: 一行 ISO 时间 + 本机 pid, 覆盖写保持只有最新一行。"""
    root = cfg["remote_root"]
    remote = ("printf '%%s pid=%%s\\n' \"$(date -Is)\" %d > '%s/worker.heartbeat'"
              % (os.getpid(), root))
    rc, out, err = ssh(cfg, remote, retries=2, backoff=1.0)
    return rc == 0


class HeartbeatThread(threading.Thread):
    """后台心跳: 长任务跑着的时候也每 heartbeat_interval 秒报一次到。

    云端插件用 worker.heartbeat 的 mtime 判断本机在不在线 (>300s 判掉线),
    所以不能只在轮询时写 —— 一个视频任务跑 15 分钟, 期间必须持续报到。
    poll() 里也顺带写一次, 两边内容格式相同, 谁写都行。
    """

    def __init__(self, cfg):
        threading.Thread.__init__(self, name="heartbeat", daemon=True)
        self.cfg = cfg
        self.stop_flag = threading.Event()

    def run(self):
        interval = max(5, int(self.cfg.get("heartbeat_interval", 20)))
        while not self.stop_flag.is_set():
            try:
                if not heartbeat_once(self.cfg):
                    log.warning("heartbeat 写失败 (ssh 不通?)")
            except Exception:
                log.warning("heartbeat 异常: %s",
                            traceback.format_exc().strip().splitlines()[-1])
            self.stop_flag.wait(interval)


def poll(cfg):
    """一趟 ssh 同时写心跳 + 列 inbox, 返回 (jobs:[id...], ok:bool)。"""
    root = cfg["remote_root"]
    remote = ("printf '%%s pid=%%s\\n' \"$(date -Is)\" %d > '%s/worker.heartbeat' 2>/dev/null; "
              "ls -1 '%s/inbox/' 2>/dev/null" % (os.getpid(), root, root))
    rc, out, err = ssh(cfg, remote, retries=3, backoff=1.5)
    if rc != 0:
        log.warning("poll 失败 rc=%s: %s", rc, (err or out).strip()[:400])
        return [], False
    jobs = []
    for line in out.splitlines():
        line = line.strip()
        if line.endswith(".json"):
            jobs.append(line[:-5])
    return sorted(jobs), True


def claim(cfg, job_id):
    """hardlink + rm 实现原子认领, 抢不到就跳过。

    写成**幂等**的, 才能安全重试: 连接在 ln+rm 之后、echo 回来之前断掉时,
    重跑会看到 working 已有、inbox 已空 —— 那本来就是"我认领成功了",
    直接当 CLAIMED; 否则 job 会永远卡在 working/ 里没人处理
    (顺便也能顺手捞回上一个 worker 崩掉时留在 working/ 的孤儿 job)。
    """
    root = cfg["remote_root"]
    remote = ("cd '{root}' && "
              "if [ -f 'working/{jid}.json' ] && [ ! -f 'inbox/{jid}.json' ]; then "
              "echo CLAIMED; "
              "elif ln 'inbox/{jid}.json' 'working/{jid}.json' 2>/dev/null; then "
              "rm -f 'inbox/{jid}.json'; echo CLAIMED; "
              "else echo SKIP; fi"
              ).format(root=root, jid=job_id)
    rc, out, err = ssh(cfg, remote, retries=3, backoff=1.5)
    return rc == 0 and "CLAIMED" in out


def fetch_job(cfg, job_id):
    root = cfg["remote_root"]
    rc, out, err = ssh(cfg, "cat '%s/working/%s.json' 2>/dev/null"
                            % (root, job_id), retries=3, backoff=1.5)
    if rc != 0 or not out.strip():
        raise RuntimeError("读取 job 失败: %s" % (err or "空内容"))
    return json.loads(out)


def archive_job(cfg, job_id):
    root = cfg["remote_root"]
    # mv 也写成幂等的 (源文件已不在就什么都不做), 这样连接断了重跑不会误报失败
    rc, out, err = ssh(cfg, "cd '%s' && { [ -f 'working/%s.json' ] && "
                            "mv -f 'working/%s.json' 'done/%s.json'; true; }"
                            % (root, job_id, job_id, job_id),
                       retries=3, backoff=1.5)
    if rc != 0:
        log.warning("[%s] 归档 working->done 失败: %s", job_id, err[:300])


SUBMIT_MARKER = "result.json"
WANT_FILE = "_want.json"   # 放在 workdir 根: 本 job 的主成品清单, 决定上传顺序


def remote_file_sizes(cfg, rdir, names):
    """返回 {name: 远端字节数}; 远端不存在的记 -1。"""
    if not names:
        return {}
    quoted = " ".join("'%s'" % n.replace("'", "'\\''") for n in names)
    cmd = ("cd '" + rdir + "' || exit 3; for f in " + quoted + "; do "
           "printf '%s\\t%s\\n' \"$f\" "
           "\"$(stat -c %s \"$f\" 2>/dev/null || echo -1)\"; done")
    rc, out, err = ssh(cfg, cmd, retries=3, backoff=1.5)
    if rc != 0:
        raise RuntimeError("远端 stat 失败: %s" % (err or out).strip()[:300])
    sizes = {}
    for line in out.splitlines():
        if "\t" not in line:
            continue
        name, _, num = line.rpartition("\t")
        num = num.strip()
        if num.lstrip("-").isdigit():
            sizes[name.strip()] = int(num)
    return sizes


def push_results(cfg, job_id, local_dir, want=()):
    """把本地 <job>/_pkg 里的文件传进 outbox/<id>/。

    顺序铁律 (lead m00299): 先传成品 (want 里的 video.mp4 / answer.md) → 再传
    meta.json 等其余文件 → 校验远端字节数全部一致 → 最后才传 result.json。
    result.json 是"提交标记": 云端插件一看到它就会把整个 outbox/<id>/ 搬去
    done/, 所以它必须是最后一个落地的文件, 否则插件会报"说做完了但视频没找着"。

    注意: Windows 版 OpenSSH 的 scp 走 SFTP, 目标目录不存在会直接报
    "path canonicalization failed", 所以先 mkdir -p, 再逐个文件传。
    """
    root = cfg["remote_root"]
    rdir = "%s/outbox/%s" % (root, job_id)
    rc, out, err = ssh(cfg, "mkdir -p '%s'" % rdir, retries=3, backoff=1.5)
    if rc != 0:
        raise RuntimeError("云端 mkdir outbox 失败: %s" % (err or out).strip()[:300])

    names = [n for n in sorted(os.listdir(local_dir))
             if os.path.isfile(os.path.join(local_dir, n))]
    if not names:
        raise RuntimeError("本地 _pkg 为空, 没有可回传的东西")

    artifacts = [n for n in names if n != SUBMIT_MARKER]
    marker = [n for n in names if n == SUBMIT_MARKER]
    first = [n for n in want if n in artifacts]   # 按 want 的顺序: 先主成品再 meta
    payload = first + [n for n in artifacts if n not in first]
    order = payload + marker
    if not marker:
        log.warning("[%s] _pkg 里没有 result.json, 云端不会认这条 job 完成", job_id)
    log.info("[%s] 回传顺序: %s", job_id, " -> ".join(order))

    def scp_one(name):
        src = os.path.join(local_dir, name)
        cmd = [SCP_EXE, "-i", cfg["ssh_key"], "-o", "StrictHostKeyChecking=no",
               "-o", "BatchMode=yes", "-o", "LogLevel=ERROR",
               "-o", "ConnectTimeout=20",
               "--", src, "%s:%s/%s" % (cfg["ssh_host"], rdir, name)]
        rc, out, err = run(cmd, 600)
        if rc != 0:
            raise RuntimeError("scp %s 失败: %s" % (name, (err or out).strip()[:300]))

    # 1) 先生成成品 + meta.json 等附件 (按 payload 顺序: 主成品最前)
    for name in payload:
        scp_one(name)

    # 2) 校验远端字节数, 差一个字节都不往下走 (校验失败 => 抛异常 => 重试)
    sizes = remote_file_sizes(cfg, rdir, payload)
    bad = []
    for name in payload:
        local_bytes = os.path.getsize(os.path.join(local_dir, name))
        if sizes.get(name) != local_bytes:
            bad.append("%s 本地=%d 远端=%s" % (name, local_bytes, sizes.get(name)))
    if bad:
        raise RuntimeError("远端字节数校验不一致: " + "; ".join(bad))
    log.info("[%s] 远端字节数校验通过: %s", job_id,
             ", ".join("%s=%d" % (n, sizes[n]) for n in payload))

    # 3) 最后才落 result.json —— 它是提交标记, 必须最后到
    for name in marker:
        scp_one(name)
    if marker:
        local_bytes = os.path.getsize(os.path.join(local_dir, SUBMIT_MARKER))
        sizes = remote_file_sizes(cfg, rdir, marker)
        if sizes.get(SUBMIT_MARKER) != local_bytes:
            raise RuntimeError("result.json 校验不一致: 本地=%d 远端=%s"
                               % (local_bytes, sizes.get(SUBMIT_MARKER)))
        log.info("[%s] result.json 最后落地 (%d B), 云端可以取件了",
                 job_id, local_bytes)

    rc, out, err = ssh(cfg, "ls -la --time-style=full-iso '%s'" % rdir,
                       retries=2, backoff=1.0)
    log.info("[%s] outbox 内容:\n%s", job_id, out.strip())


# ---------------------------------------------------------------- 提示词
PROMPT_HEAD = (
    "你是大肥鱼的工作室助理，在 DSH 环境里干活。"
    "当前目录就是你的工作区，所有产物只写进 ./out/。\n"
    "（任务描述里如果提到「当前目录」「当前目录下」，一律理解为 ./out/ —— "
    "所有成品都放进 out/ 里，不要留在工作区根目录。）\n\n"
    "任务：{prompt}\n\n"
)

PROMPT_VIDEO = (
    "要求（kind=video）：必须产出 ./out/video.mp4"
    "（H.264 视频 + AAC 音频，竖屏 720x1280 或 1080x1920，"
    "时长以任务说明为准，没说明就 40~90 秒，允许范围 30~180 秒，"
    "必须有声音、必须有中文字幕）"
    "和 ./out/meta.json（字段：title<=40字、desc<=200字、"
    "tag 3~5 个逗号分隔、lines 是口播/字幕逐句数组）。\n"
    "\n【环境已经准备好的东西，别重复装】"
    "ffmpeg / ffprobe 已在 PATH 里（{ffmpeg_bin}）；python 用 py -3；"
    "edge_tts 7.3.1 已经预装好（PYTHONPATH 里），直接 import edge_tts 就能配音，"
    "中文女声用 voice=\"zh-CN-XiaoyiNeural\" 或 \"zh-CN-XiaoxiaoNeural\"。"
    "**绝对不要 pip install**：pip 在这个环境里会卡在网络上十几分钟，"
    "缺什么就去用已经装好的，别再装东西。\n"
    "【先看工具箱，别现造轮子】E:/工作区/肥鱼之家/toolkit/ 里已经有出片四件套，"
    "PYTHONPATH 里也加了，直接 import 就能用："
    "voice.py（edge-tts 逐句配音+时间对齐）、sub.py（中文字幕/标题卡/角标，"
    "描边+投影+安全区都调好了）、fx.py（淡入淡出/推拉/打字机/进度条/章节角标）、"
    "encode.py（h264 yuv420p + aac 48k + faststart + 响度 -16 LUFS 一把过）；"
    "美术规范和节奏要求看 E:/工作区/肥鱼之家/toolkit/STYLE.md，"
    "demo.py 是最小可用模板（约 10 秒样片，改台词就能用）。"
    "能复用就复用，别从零写渲染代码 —— 时间省下来花在内容上。\n"
    "【自己画也行】用 PIL 逐帧画 720x1280、24fps："
    "背景渐变 + 圆角对话框 + 大字里的鱼 + 字幕直接画进帧里（PIL 写字，"
    "不要跟 ffmpeg drawtext 的转义较劲）；"
    "先用 edge_tts 按分句合成整段中文语音拿到每句时长，再按时间轴渲染帧，"
    "最后 ffmpeg 把帧序列 + 音频合成 video.mp4（-c:v libx264 -pix_fmt yuv420p "
    "-c:a aac -shortest）。目标是 8~15 分钟内出片。\n"
    "【节奏要求】任何一步超过 3 分钟没结果，就换成更简单的做法继续 —— "
    "画面朴素也必须把 video.mp4 做出来，不要死磕特效。"
    "先把 video.mp4 落盘，再补 meta.json。\n"
    "【收工自检】ffprobe 确认 video.mp4 有 video 和 audio 两条流、时长达到要求，"
    "再写 meta.json 收工。\n\n"
)

PROMPT_TEXT = (
    "要求（kind=text）：把成品正文写进 ./out/answer.md（Markdown，中文，"
    "内容完整可直接发布，不要只写提纲）。\n\n"
)

PROMPT_TAIL = (
    "做完用一两句中文说明你做了什么。不要写当前目录以外的文件。"
)


def build_prompt(cfg, job):
    kind = (job.get("kind") or "text").strip().lower()
    body = PROMPT_VIDEO.format(ffmpeg_bin=cfg["ffmpeg_bin"]) if kind == "video" \
        else PROMPT_TEXT
    return PROMPT_HEAD.format(prompt=(job.get("prompt") or "").strip()) + body + PROMPT_TAIL


# ---------------------------------------------------------------- DSH 调用
def kill_tree(pid):
    run(["taskkill", "/F", "/T", "/PID", str(pid)], 60)


def parse_jsonl(stdout_text):
    """取 sessionId 和 final.text。"""
    session_id, final_text, texts = "", "", []
    for line in stdout_text.splitlines():
        line = line.strip()
        if not line.startswith("{"):
            continue
        try:
            obj = json.loads(line)
        except Exception:
            continue
        t = obj.get("type")
        if t == "session" and obj.get("sessionId"):
            session_id = obj["sessionId"]
        elif t == "text" and isinstance(obj.get("text"), str):
            texts.append(obj["text"])
        elif t == "final":
            final_text = obj.get("text") or ""
    if not final_text and texts:
        final_text = texts[-1]
    return session_id, final_text


def run_dsh(cfg, job, workdir, api_key):
    os.makedirs(os.path.join(workdir, "out"), exist_ok=True)
    env = dict(os.environ)
    env["DEEPSEEK_API_KEY"] = api_key
    env["ELECTRON_RUN_AS_NODE"] = "1"
    env["PYTHONUTF8"] = "1"
    env["PYTHONIOENCODING"] = "utf-8"
    env["PATH"] = cfg["ffmpeg_bin"].replace("/", "\\") + ";" + env.get("PATH", "")
    # 预装好的纯 Python 包 (edge_tts 及其依赖) + 出片工具箱, 让任务里直接
    # "import voice/sub/fx/encode" 就能用, 免得现造轮子、更免得 pip install 卡网络
    extra_paths = [cfg.get("vendor_py") or "", cfg.get("toolkit_dir") or ""]
    extra_paths = [p.replace("/", "\\") for p in extra_paths if p and os.path.isdir(p.replace("/", "\\"))]
    if extra_paths:
        env["PYTHONPATH"] = ";".join(extra_paths) + ";" + env.get("PYTHONPATH", "")

    prompt = build_prompt(cfg, job)
    cmd = [cfg["dsh_exe"], cfg["dsh_cli_js"], "headless", "--json", "--", prompt]
    log.info("[%s] DSH 启动 提示词 %d 字", job["id"], len(prompt))

    log_dir = os.path.join(workdir, "logs")
    os.makedirs(log_dir, exist_ok=True)
    out_path = os.path.join(log_dir, "dsh.stdout.jsonl")
    err_path = os.path.join(log_dir, "dsh.stderr.log")

    kind = (job.get("kind") or "text").strip().lower()
    timeout = int(cfg["job_timeout"] if kind == "video"
                  else cfg.get("text_job_timeout", 900))
    with io.open(out_path, "w", encoding="utf-8", errors="replace") as fo, \
            io.open(err_path, "w", encoding="utf-8", errors="replace") as fe:
        p = subprocess.Popen(
            cmd, cwd=workdir, env=env, stdout=fo, stderr=fe,
            creationflags=CREATE_NO_WINDOW | getattr(
                subprocess, "CREATE_NEW_PROCESS_GROUP", 0))
        try:
            rc = p.wait(timeout=timeout)
            timed_out = False
        except subprocess.TimeoutExpired:
            timed_out = True
            rc = -9
            log.error("[%s] 超时 %ss, 杀进程树", job["id"], timeout)
            kill_tree(p.pid)
            try:
                p.wait(timeout=60)
            except Exception:
                pass

    with io.open(out_path, encoding="utf-8", errors="replace") as f:
        stdout_text = f.read()
    session_id, final_text = parse_jsonl(stdout_text)
    if not timed_out and rc != 0:
        tail = ""
        if os.path.exists(err_path):
            with io.open(err_path, encoding="utf-8", errors="replace") as f:
                tail = "\n".join(f.read().splitlines()[-6:])
        log.warning("[%s] DSH 退出码 %s stderr尾部: %s", job["id"], rc, tail[:600])
    return {"rc": rc, "timed_out": timed_out, "session_id": session_id,
            "final_text": final_text}


# ---------------------------------------------------------------- 成品校验/收集
def expected_files(job):
    kind = (job.get("kind") or "text").strip().lower()
    want = job.get("want") or []
    if want:
        return list(want)
    if kind == CLEANUP_KIND:
        return ["meta.json"]
    return ["video.mp4", "meta.json"] if kind == "video" else ["answer.md"]


def ffprobe_streams(cfg, path):
    probe = os.path.join(cfg["ffmpeg_bin"].replace("/", "\\"), "ffprobe.exe")
    if not os.path.exists(probe):
        return None, None, None
    rc, out, err = run([probe, "-v", "error", "-show_entries",
                        "stream=codec_type:format=duration",
                        "-of", "json", path], 120)
    if rc != 0:
        return None, None, None
    try:
        data = json.loads(out)
    except Exception:
        return None, None, None
    types = [s.get("codec_type") for s in data.get("streams", [])]
    dur = data.get("format", {}).get("duration")
    return ("video" in types), ("audio" in types), (float(dur) if dur else None)


JUNK_PATTERNS = ("_backup", ".tmp", ".bak", ".swp", ".orig", "~$", ".DS_Store")


def is_junk(name):
    """模型偶尔会把中间稿 (meta_backup.txt 之类) 也丢进 out/, 别往云端传。"""
    low = name.lower()
    return any(p.lower() in low for p in JUNK_PATTERNS)


def collect_outputs(cfg, job, workdir, dsh):
    """整理 _pkg 目录, 返回 (ok, error, files, found)。"""
    out_dir = os.path.join(workdir, "out")
    pkg = os.path.join(workdir, "_pkg")
    if os.path.isdir(pkg):
        shutil.rmtree(pkg, ignore_errors=True)
    os.makedirs(pkg)

    # send_intermediates=false(默认): 只回传 want 里的成品 + meta.json。
    # 插件投完/毙完就把整个 outbox/<id>/ 删掉, 中间件留档没有任何意义,
    # 只会污染 done/ 和 result.files。
    send_extra = cfg.get("send_intermediates", False)
    allowed = set(expected_files(job)) | {"meta.json"}

    found, files = [], []
    if os.path.isdir(out_dir):
        for name in sorted(os.listdir(out_dir)):
            src = os.path.join(out_dir, name)
            if not os.path.isfile(src):
                continue
            if is_junk(name):
                log.info("[%s] 跳过中间稿 %s", job["id"], name)
                continue
            if not send_extra and name not in allowed:
                log.info("[%s] 跳过中间件 %s (send_intermediates=false)", job["id"], name)
                continue
            shutil.copy2(src, os.path.join(pkg, name))
            size = os.path.getsize(src)
            files.append({"name": name, "bytes": size})
            found.append(name)
            log.info("[%s] 成品 %s %d bytes", job["id"], name, size)

    # 兜底: DSH 有时会照着任务原文把成品写在"当前目录"(工作区根)而不是 out/
    for name in expected_files(job):
        if name in found:
            continue
        src = os.path.join(workdir, name)
        if os.path.isfile(src):
            shutil.copy2(src, os.path.join(pkg, name))
            size = os.path.getsize(src)
            files.append({"name": name, "bytes": size})
            found.append(name)
            log.info("[%s] 成品从工作区根兜底捞到 %s %d bytes", job["id"], name, size)

    problems = []
    if dsh["timed_out"]:
        problems.append("超时被杀 (>%ss)" % cfg["job_timeout"])
    for need in expected_files(job):
        if need not in found:
            problems.append("缺少成品 %s" % need)

    if (job.get("kind") or "").lower() == "video" and "video.mp4" in found:
        has_v, has_a, dur = ffprobe_streams(cfg, os.path.join(pkg, "video.mp4"))
        if has_v is False:
            problems.append("video.mp4 没有视频流")
        if has_a is False:
            problems.append("video.mp4 没有音频流")
        if dur is not None and dur < 1:
            problems.append("video.mp4 时长异常 %.2fs" % dur)
        log.info("[%s] ffprobe video=%s audio=%s dur=%s",
                 job["id"], has_v, has_a, dur)

    error = "; ".join(problems)
    if not dsh["final_text"] and not error:
        error = "DSH 无 final 文本"
    return (error == ""), error, files, found


# ---------------------------------------------------------------- kind=cleanup
# 主人加的两条硬规则: ① 视频投稿前必须他确认; ② 投稿成功/被否决后, 本机上的视频原件必须删掉,
# 只留 B 站那一份. 所以插件会派 kind=cleanup 的回收任务过来:
#   {"kind":"cleanup","target":"j20261030-222317-3e68"}
#   {"kind":"cleanup","paths":["j20261030-222317-3e68","j20261030-222608-cf86"]}
# 安全边界(硬要求): 只删 <jobs_root> 的直接子目录, 名字必须是 job id 形状,
# 绝不接受绝对路径 / .. / 别的盘; 只要有一个 target 不合法, 整个任务一个都不删.

CLEANUP_KIND = "cleanup"
JOB_ID_RE = re.compile(r"^j[0-9]{8}-[0-9]{6}-[0-9a-f]{4}$")
OLD_JOB_DAYS = 7            # 顺手回收: 这么久没被碰过的旧 job 目录
RMTREE_TRIES = 3


def human_mb(n):
    mb = n / 1024.0 / 1024.0
    return ("%.1f MB" % mb) if mb >= 1 else ("%.2f MB" % mb)


def dir_size(path):
    total = 0
    for root, _dirs, files in os.walk(path):
        for name in files:
            try:
                total += os.path.getsize(os.path.join(root, name))
            except OSError:
                pass
    return total


def count_files(path):
    if not os.path.isdir(path):
        return 0
    n = 0
    for _root, _dirs, files in os.walk(path):
        n += len(files)
    return n


def _rmtree_onerror(func, path, exc_info):
    """Windows 上只读/被占用: 去掉只读位再试一次, 仍然不行就交给外层的重试。"""
    try:
        os.chmod(path, 0o700)
        func(path)
    except Exception:
        pass


def remove_tree(path):
    """删一个目录, 重试 3 次. 返回 (ok, 剩余文件数, 错误说明); 绝不抛异常。"""
    if not os.path.exists(path):
        return True, 0, ""
    for attempt in (1, 2, 3):
        try:
            shutil.rmtree(path, ignore_errors=False, onerror=_rmtree_onerror)
        except Exception as exc:
            log.warning("rmtree 第 %d/%d 次失败 %s: %r", attempt, RMTREE_TRIES, path, exc)
        if not os.path.exists(path):
            return True, 0, ""
        time.sleep(1.0 * attempt)
    left = count_files(path)
    return False, left, "删不掉(可能被别的程序占用), 还剩 %d 个文件" % left


def resolve_cleanup_target(cfg, raw, own_id):
    """把一个 target/paths 条目规整成 <jobs_root>/<job id>; 不合法返回 (None, 原因)。"""
    if not isinstance(raw, str):
        return None, "不是字符串: %r" % (raw,)
    name = raw.strip()
    if not name:
        return None, "空路径"
    if re.match(r"^[A-Za-z]:", name) or name.startswith("/") or name.startswith("\\"):
        return None, "拒绝绝对路径"
    parts = [p for p in re.split(r"[\\/]", name) if p not in ("", ".")]
    if ".." in parts:
        return None, "拒绝含 .. 的路径"
    if not parts:
        return None, "空路径"
    leaf = parts[-1]
    jobs_root = os.path.abspath(cfg["jobs_root"])
    if len(parts) > 1:
        parent = os.path.abspath(os.path.join(*parts[:-1]))
        if os.path.normcase(parent) != os.path.normcase(jobs_root):
            return None, "不在 %s 的直接子目录里" % cfg["jobs_root"]
    if not JOB_ID_RE.match(leaf):
        return None, "不是 job id 形状(jYYYYMMDD-HHMMSS-xxxx): %s" % leaf
    if leaf == own_id:
        return None, "拒绝删除当前 cleanup 任务自己的工作目录"
    path = os.path.join(jobs_root, leaf)
    if os.path.normcase(os.path.dirname(path)) != os.path.normcase(jobs_root):
        return None, "越界: %s" % path
    return (leaf, path), ""


def cleanup_dirs(cfg, job, own_id):
    """执行 kind=cleanup. 返回 (ok, text, error, meta)。"""
    meta = {"kind": CLEANUP_KIND, "own_id": own_id, "started": now_iso(),
            "removed": [], "missing": [], "swept_old": [], "rejected": [],
            "freed_bytes": 0, "freed": ""}
    raws = []
    if job.get("target"):
        raws.append(job["target"])
    for item in (job.get("paths") or []):
        raws.append(item)
    if not raws:
        return False, "", "cleanup 任务既没有 target 也没有 paths", meta

    # 第一步: 全部校验完再动手, 有一个不合法就整体拒绝(谁都不动)
    targets, rejected = [], []
    seen = set()
    for raw in raws:
        got, why = resolve_cleanup_target(cfg, raw, own_id)
        if got is None:
            rejected.append({"input": str(raw), "why": why})
        elif got[0] not in seen:
            seen.add(got[0])
            targets.append(got)
    if rejected:
        meta["rejected"] = rejected
        reason = "; ".join("%s -> %s" % (r["input"], r["why"]) for r in rejected)
        log.warning("[%s] cleanup 拒绝执行: %s", own_id, reason)
        return False, "", "拒绝执行(有不合法的 target, 一个都没删): " + reason, meta

    # 第二步: 删
    lines = []
    for name, path in targets:
        if not os.path.isdir(path):
            meta["missing"].append(name)
            lines.append("本地任务目录 %s 已不存在" % name)
            continue
        before = dir_size(path)
        ok, left, err = remove_tree(path)
        if not ok:
            log.error("[%s] cleanup 删除 %s 失败: %s", own_id, name, err)
            meta["freed"] = human_mb(meta["freed_bytes"])
            return False, " ".join(lines), "%s: %s" % (name, err), meta
        meta["removed"].append(name)
        meta["freed_bytes"] += before
        lines.append("已删除本地任务目录 %s（释放 %s）" % (name, human_mb(before)))
        log.info("[%s] cleanup 已删 %s, 释放 %s", own_id, name, human_mb(before))

    # 第三步: 顺手把 7 天以上没人碰过的旧 job 目录也清掉
    root = os.path.abspath(cfg["jobs_root"])
    cutoff = time.time() - OLD_JOB_DAYS * 86400
    done_set = set(name for name, _p in targets)
    try:
        entries = sorted(os.listdir(root))
    except OSError:
        entries = []
    for entry in entries:
        if entry == own_id or entry in done_set or not JOB_ID_RE.match(entry):
            continue
        path = os.path.join(root, entry)
        try:
            if not os.path.isdir(path):
                continue
            mtime = os.path.getmtime(path)
            if mtime > cutoff:
                continue
            age_days = int((time.time() - mtime) / 86400.0)
            before = dir_size(path)
            ok, _left, err = remove_tree(path)
            if not ok:
                log.warning("[%s] 旧目录 %s 没清掉: %s", own_id, entry, err)
                continue
            meta["swept_old"].append({"name": entry, "bytes": before, "age_days": age_days})
            meta["freed_bytes"] += before
            lines.append("顺手清掉 %d 天前的旧目录 %s（释放 %s）" % (age_days, entry, human_mb(before)))
            log.info("[%s] cleanup 顺手清掉旧目录 %s (%.1f 天)", own_id, entry, age_days)
        except Exception:
            log.warning("[%s] 清理旧目录 %s 时异常:\n%s", own_id, entry, traceback.format_exc())

    meta["freed"] = human_mb(meta["freed_bytes"])
    text = "; ".join(lines) if lines else "没有需要删除的本地目录"
    return True, text, "", meta


# ---------------------------------------------------------------- 单 job 流程
def handle_job(cfg, job_id, api_key):
    workdir = os.path.join(cfg["jobs_root"], job_id)
    result = {"id": job_id, "ok": False, "text": "", "error": "",
              "session_id": "", "started": now_iso(), "finished": "",
              "files": []}
    want = []
    cleanup_meta = None
    try:
        job = fetch_job(cfg, job_id)
        job["id"] = job.get("id") or job_id
        kind = (job.get("kind") or "text").strip().lower()
        job["kind"] = kind
        want = expected_files(job)
        log.info("[%s] 认领成功 kind=%s prompt=%d字", job_id,
                 kind, len(job.get("prompt") or ""))
        os.makedirs(os.path.join(workdir, "out"), exist_ok=True)

        if kind == CLEANUP_KIND:
            # 本机上的活, 不跑 DSH: 删目录 + 写回执
            ok, text, error, meta = cleanup_dirs(cfg, job, job_id)
            result["ok"] = ok
            result["text"] = text
            result["error"] = error
            cleanup_meta = meta
        else:
            dsh = run_dsh(cfg, job, workdir, api_key)
            result["session_id"] = dsh["session_id"]
            result["text"] = dsh["final_text"]
            ok, error, files, _found = collect_outputs(cfg, job, workdir, dsh)
            result["ok"] = ok
            result["error"] = error
            result["files"] = files
    except Exception:
        tb = traceback.format_exc()
        log.error("[%s] 处理异常:\n%s", job_id, tb)
        result["ok"] = False
        result["error"] = ("worker 异常: " + tb.strip().splitlines()[-1])[:500]

    result["finished"] = now_iso()

    pkg = os.path.join(workdir, "_pkg")
    os.makedirs(pkg, exist_ok=True)
    if cleanup_meta is not None:
        # cleanup 的回执: meta.json 里写清删了什么/释放多少, 云端留档用
        cleanup_meta["finished"] = now_iso()
        meta_path = os.path.join(pkg, "meta.json")
        with io.open(meta_path, "w", encoding="utf-8") as f:
            json.dump(cleanup_meta, f, ensure_ascii=False, indent=2)
        result["files"] = [{"name": "meta.json",
                            "bytes": os.path.getsize(meta_path)}]
    with io.open(os.path.join(pkg, "result.json"), "w", encoding="utf-8") as f:
        json.dump(result, f, ensure_ascii=False, indent=2)

    try:
        with io.open(os.path.join(workdir, WANT_FILE), "w", encoding="utf-8") as f:
            json.dump(list(want), f)
    except OSError:
        pass

    if upload_and_archive(cfg, job_id, workdir, want):
        log.info("[%s] 完成 ok=%s files=%s error=%r", job_id, result["ok"],
                 [x["name"] for x in result["files"]], result["error"])
    else:
        log.error("[%s] 回传失败, 已留待下轮重试 (marker=_pending_upload)", job_id)
    return result


def upload_and_archive(cfg, job_id, workdir, want=()):
    """把 <job>/_pkg 传上去并归档; 失败3次就留 marker 等下轮再传, 绝不丢结果。"""
    pkg = os.path.join(workdir, "_pkg")
    marker = os.path.join(workdir, "_pending_upload")
    if not want:
        try:
            with io.open(os.path.join(workdir, WANT_FILE), encoding="utf-8") as f:
                want = json.load(f) or []
        except Exception:
            want = []
    last_err = ""
    for attempt in (1, 2, 3):
        try:
            push_results(cfg, job_id, pkg, want)
            if os.path.exists(marker):
                try:
                    os.remove(marker)
                except OSError:
                    pass
            archive_job(cfg, job_id)
            return True
        except Exception as exc:
            last_err = "%r" % (exc,)
            log.warning("[%s] 第 %d 次回传失败: %s", job_id, attempt, last_err[:300])
            time.sleep(3 * attempt)
    try:
        with io.open(marker, "w", encoding="utf-8") as f:
            f.write("%s\n%s\n" % (now_iso(), last_err))
    except OSError:
        pass
    return False


def flush_pending(cfg):
    """上一轮没传成功的 job, 每轮开头先补传一次 (job 不重跑, 成品已在 _pkg)。"""
    root = cfg["jobs_root"]
    try:
        names = sorted(os.listdir(root))
    except OSError:
        return
    for name in names:
        workdir = os.path.join(root, name)
        marker = os.path.join(workdir, "_pending_upload")
        if not os.path.exists(marker):
            continue
        log.info("[%s] 发现待补传的成品, 重试回传", name)
        try:
            upload_and_archive(cfg, name, workdir)
        except Exception:
            log.error("[%s] 补传异常:\n%s", name, traceback.format_exc())


def prune_job_dirs(cfg):
    root = cfg["jobs_root"]
    try:
        dirs = [os.path.join(root, d) for d in os.listdir(root)]
        dirs = [d for d in dirs if os.path.isdir(d)]
        dirs.sort(key=lambda d: os.path.getmtime(d), reverse=True)
        for d in dirs[int(cfg["keep_job_dirs"]):]:
            shutil.rmtree(d, ignore_errors=True)
    except Exception:
        pass


# ---------------------------------------------------------------- 主循环
def main():
    setup_logging()
    cfg = load_config()
    guard = single_instance_guard()
    if guard is None:
        log.info("已有 worker 实例在跑, 本实例退出")
        return 0
    log.info("=== DshFishBridge worker 启动 pid=%s host=%s target=%s",
             os.getpid(), socket.gethostname(), cfg["ssh_host"])
    try:
        api_key = read_api_key(cfg)
        log.info("已载入 DEEPSEEK_API_KEY (len=%d)", len(api_key))
    except Exception as exc:
        log.error("拿不到 API key, 不启动: %r", exc)
        return 2

    # 后台心跳线程: 干活期间也持续报到 (云端 >300s 没心跳就判掉线)
    hb = HeartbeatThread(cfg)
    hb.start()
    log.info("心跳线程已启动, 每 %ss 写一次 %s/worker.heartbeat",
             cfg.get("heartbeat_interval", 20), cfg["remote_root"])

    last_prune = 0.0
    while True:
        try:
            flush_pending(cfg)
            jobs, polled = poll(cfg)
            if polled and jobs:
                log.info("inbox 有 %d 个 job: %s", len(jobs), jobs)
            for job_id in jobs:
                try:
                    if not claim(cfg, job_id):
                        log.info("[%s] 认领失败(被抢或已消失), 跳过", job_id)
                        continue
                    handle_job(cfg, job_id, api_key)
                except Exception:
                    log.error("[%s] job 外层异常:\n%s", job_id, traceback.format_exc())
            if polled and time.time() - last_prune > 3600:
                prune_job_dirs(cfg)
                last_prune = time.time()
        except Exception:
            log.error("主循环异常(继续跑):\n%s", traceback.format_exc())
        time.sleep(max(3, int(cfg["poll_interval"])))


def heartbeat_only():
    """只报到的独立进程: 手工/临时用, 抢不到互斥体时也能让云端看到"我在线"。"""
    setup_logging()
    cfg = load_config()
    log.info("=== heartbeat-only 进程启动 pid=%s target=%s", os.getpid(), cfg["ssh_host"])
    while True:
        try:
            if not heartbeat_once(cfg):
                log.warning("heartbeat 写失败")
        except Exception:
            log.warning("heartbeat 异常: %s", traceback.format_exc().strip().splitlines()[-1])
        time.sleep(max(5, int(cfg.get("heartbeat_interval", 20))))


if __name__ == "__main__":
    if "--heartbeat-only" in sys.argv[1:]:
        heartbeat_only()
    else:
        sys.exit(main() or 0)
