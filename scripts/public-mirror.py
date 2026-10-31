#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
把本工作区导出成**公开镜像**并推送到 GitHub 上的公有仓库。

用法（在工作区根目录）：
    py -3 -X utf8 scripts/public-mirror.py --check     # 只导出并在本地体检，不推送
    py -3 -X utf8 scripts/public-mirror.py             # 导出 + 提交 + 强推

做什么：
1. 只用 git ls-files 的清单（= 已进私有仓的文件），复制到 tmp/public-export；
2. 文本文件跑一遍脱敏替换；
3. 跳过不该公开的文件（大视频、含令牌/登录二维码的截图、以及规则文件本身）；
4. README.md 换成公仓版（scripts/public-README.md）；
5. 在导出目录 git init，一条 squash 提交，强推到公有仓（镜像只保留一条历史）。

**个人信息与服务器地址都写在 scripts/public-mirror.rules.json 里，脚本本身不含任何私货**，
所以脚本能直接进公开镜像；规则文件不进（它列着要抹掉的东西，本身就是地图）。
规则文件的字段（照 public-mirror.rules.example.json 抄）：
    owner       GitHub 账号
    repo        公有仓名
    skip_names  不导出的文件名（按 basename 匹配）
    residue     导出后不该再出现的字符串，命中就 exit 1
    rules       [[正则, 替换串], ...]；替换串里的反斜杠按字面理解，不用转义

token 从 ~/.git-credentials 读，绝不写进脚本。
"""
import os, re, sys, json, stat, time, shutil, subprocess, collections

HERE = os.path.dirname(os.path.abspath(__file__))
SRC = os.path.dirname(HERE)
DST = os.path.join(SRC, "tmp", "public-export")
RULES_FILE = os.path.join(HERE, "public-mirror.rules.json")
README_SRC = os.path.join(HERE, "public-README.md")
SKIP_ALWAYS = {"public-mirror.rules.json"}
BS = chr(92)


def load_rules():
    if not os.path.isfile(RULES_FILE):
        sys.exit("缺少 %s —— 照 scripts/public-mirror.rules.example.json 建一份"
                 % os.path.relpath(RULES_FILE, SRC).replace(BS, "/"))
    with open(RULES_FILE, encoding="utf-8") as fh:
        cfg = json.load(fh)
    for key in ("owner", "repo", "rules"):
        if not cfg.get(key):
            sys.exit("规则文件缺字段：%s" % key)
    cfg.setdefault("skip_names", [])
    cfg.setdefault("residue", [])
    return cfg


def tracked_files():
    out = subprocess.run(["git", "ls-files", "-z"], cwd=SRC, capture_output=True)
    return [f for f in out.stdout.decode("utf-8", "replace").split("\0") if f]


def token():
    path = os.path.join(os.path.expanduser("~"), ".git-credentials")
    with open(path, encoding="utf-8", errors="replace") as fh:
        m = re.search(r"ghp_[A-Za-z0-9]+", fh.read())
    if not m:
        sys.exit("~/.git-credentials 里找不到 ghp_ token")
    return m.group(0)


def rmtree(path):
    """Windows 上 git 的对象文件是只读的，shutil.rmtree 会 PermissionError。先改成可写再删。"""
    def on_error(func, p, exc):
        try:
            os.chmod(p, stat.S_IWRITE)
            func(p)
        except FileNotFoundError:
            pass
    if not os.path.isdir(path):
        return
    for root, dirs, names in os.walk(path):
        for n in dirs + names:
            try:
                os.chmod(os.path.join(root, n), stat.S_IWRITE)
            except OSError:
                pass
    shutil.rmtree(path, onerror=on_error)


def main():
    check_only = "--check" in sys.argv
    cfg = load_rules()
    owner, repo = cfg["owner"], cfg["repo"]
    skip_names = set(cfg["skip_names"]) | SKIP_ALWAYS
    compiled = [(re.compile(p), rep) for p, rep in cfg["rules"]]

    rmtree(DST)
    files = tracked_files()
    copied = skipped = 0
    for f in files:
        if os.path.basename(f) in skip_names:
            skipped += 1
            continue
        s, d = os.path.join(SRC, f), os.path.join(DST, f)
        os.makedirs(os.path.dirname(d), exist_ok=True)
        shutil.copy2(s, d)
        copied += 1

    counts, changed = collections.Counter(), []
    for root, _, names in os.walk(DST):
        for n in names:
            p = os.path.join(root, n)
            raw = open(p, "rb").read()
            if b"\0" in raw[:8000]:
                continue                     # 二进制，跳过
            try:
                text = raw.decode("utf-8")
            except UnicodeDecodeError:
                continue
            new = text
            for rx, rep in compiled:
                # 用 lambda 当替换串：替换内容里可能有反斜杠（如 Windows 路径），
                # 直接传字符串会被 re 当成转义序列（bad escape \u）。
                new, k = rx.subn(lambda m, r=rep: r, new)
                if k:
                    counts[rx.pattern] += k
            if new != text:
                open(p, "w", encoding="utf-8", newline="").write(new)
                changed.append(os.path.relpath(p, DST).replace(BS, "/"))

    # README 公仓版：私有仓那份写的是「私有仓 remote」，公仓不能用它
    if os.path.isfile(README_SRC):
        shutil.copy2(README_SRC, os.path.join(DST, "README.md"))
        print("README.md 换成了公仓版（scripts/public-README.md）")

    print("导出 %d 个文件（跳过 %d 个）→ %s" % (copied, skipped, DST))
    print("脱敏改了 %d 个文件：" % len(changed))
    for pat, k in counts.most_common():
        print("   %-40s %d 处" % (pat, k))

    # 残留体检：不该再出现的东西
    hits = []
    for root, _, names in os.walk(DST):
        for n in names:
            p = os.path.join(root, n)
            raw = open(p, "rb").read()
            if b"\0" in raw[:8000]:
                continue
            try:
                text = raw.decode("utf-8")
            except UnicodeDecodeError:
                continue
            for w in cfg["residue"]:
                if w in text:
                    hits.append((os.path.relpath(p, DST).replace(BS, "/"), w))
    if hits:
        print("\n!! 还有残留：")
        for f, w in hits[:40]:
            # 只报命中位置，不回显命中的原文（免得日志里又留一份）
            print("   %s  <- 第 %d 条残留规则" % (f, cfg["residue"].index(w) + 1))
        sys.exit(1)
    print("残留体检通过：没有本机路径 / 服务器地址 / 账号 / 令牌")

    if check_only:
        print("--check：不提交、不推送。")
        return

    env = dict(os.environ, GIT_AUTHOR_NAME="public-mirror", GIT_AUTHOR_EMAIL="you@example.com",
               GIT_COMMITTER_NAME="public-mirror", GIT_COMMITTER_EMAIL="you@example.com")
    run = lambda *a: subprocess.run(a, cwd=DST, env=env, check=True)

    if not os.path.isdir(os.path.join(DST, ".git")):
        run("git", "init", "-q", "-b", "main")
    run("git", "add", "-A")
    msg = "dsh-workspace: DSH 插件与配套框架公开镜像（脱敏）"
    if subprocess.run(["git", "diff", "--cached", "--quiet"], cwd=DST).returncode != 0:
        run("git", "commit", "-q", "-m", msg)
    else:
        print("没有变化，跳过提交")

    url = "https://%s:%s@github.com/%s/%s.git" % (owner, token(), owner, repo)
    # 镜像只保留一条 squash 历史，所以强推。
    # GitHub 连接时好时坏，重试三次；失败时不要把带 token 的 url 打进异常里。
    for attempt in range(3):
        p = subprocess.run(["git", "push", "--force", url, "main"], cwd=DST,
                           capture_output=True, text=True)
        if p.returncode == 0:
            print("已推送到 https://github.com/%s/%s" % (owner, repo))
            return
        sys.stderr.write("push 第 %d 次失败：%s\n" % (attempt + 1, (p.stderr or "").strip()[:400]))
        time.sleep(5)
    sys.exit("推不上去（GitHub 连不上？），导出目录留着：%s"
             % os.path.relpath(DST, SRC).replace(BS, "/"))


if __name__ == "__main__":
    main()
