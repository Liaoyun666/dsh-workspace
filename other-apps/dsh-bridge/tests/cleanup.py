#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""清掉测试残留: 云端 inbox/working/outbox/done 里的 jTEST-* , 本地 _e2e 与 job 目录。"""

import os
import shutil
import subprocess
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.dirname(HERE))
from worker import load_config  # noqa: E402

CFG = load_config()
SSH = r"C:/Windows/System32/OpenSSH/ssh.exe"
KEY = CFG["ssh_key"]
HOST = CFG["ssh_host"]
ROOT = CFG["remote_root"]

remote = ("cd '{r}' && "
          "rm -f inbox/jTEST-*.json working/jTEST-*.json done/jTEST-*.json && "
          "for d in outbox/jTEST-*; do [ -e \"$d\" ] && rm -rf \"$d\"; done; "
          "echo '--inbox--'; ls -1 inbox/; echo '--working--'; ls -1 working/; "
          "echo '--outbox--'; ls -1 outbox/; echo '--done--'; ls -1 done/").format(r=ROOT)

p = subprocess.run([SSH, "-i", KEY, "-o", "StrictHostKeyChecking=no",
                    "-o", "LogLevel=ERROR", HOST, remote],
                   capture_output=True, text=True, encoding="utf-8",
                   errors="replace", timeout=120)
print(p.stdout or p.stderr)

for path in (r"E:/工作区/肥鱼之家/_e2e", r"E:/工作区/肥鱼之家/_testout"):
    shutil.rmtree(path, ignore_errors=True)
jobs = r"E:/工作区/肥鱼之家/jobs"
if os.path.isdir(jobs):
    for d in os.listdir(jobs):
        if d.startswith("jTEST-") or d.startswith("probe"):
            shutil.rmtree(os.path.join(jobs, d), ignore_errors=True)
print("本地测试目录已清理 (jobs 里保留最近的正式 job)")
