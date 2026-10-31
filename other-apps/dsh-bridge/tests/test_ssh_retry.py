#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""离线单测: ssh() 的轻量重试 (不连云端, monkeypatch worker.run)。

    py -3 -X utf8 tests/test_ssh_retry.py

规则: 只在连接层失败(rc 255 / 超时 -9 / 起不来 -1)上重试;
命令真跑过(rc 0 或业务错误 rc 2)不重试; retries=1 时行为与以前完全一致。
"""

import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.dirname(HERE))

import worker  # noqa: E402

CFG = dict(worker.DEFAULT_CONFIG)
CFG["ssh_timeout"] = 5


def with_fake_run(results):
    """按顺序返回预置结果, 返回被调用的次数列表。"""
    calls = []

    def fake_run(cmd, timeout, cwd=None, env=None):
        calls.append(cmd)
        idx = min(len(calls), len(results)) - 1
        return results[idx]

    worker.run = fake_run
    return calls


def main():
    fails = []

    # 1) 前两次连接失败, 第三次成功 => 应当重试到成功
    calls = with_fake_run([(255, "", "ssh: Connection closed"),
                           (255, "", "ssh: Connection closed"),
                           (0, "OK\n", "")])
    rc, out, _ = worker.ssh(CFG, "ls -1 x", retries=3, backoff=0.01)
    if (rc, out) != (0, "OK\n") or len(calls) != 3:
        fails.append("连接失败重试: rc=%s out=%r calls=%d" % (rc, out, len(calls)))

    # 2) 业务错误 (命令跑了, rc=2) 不重试
    calls = with_fake_run([(2, "", "ls: no such file")])
    rc, _, _ = worker.ssh(CFG, "ls -1 x", retries=3, backoff=0.01)
    if rc != 2 or len(calls) != 1:
        fails.append("业务错误不该重试: rc=%s calls=%d" % (rc, len(calls)))

    # 3) 一直连不上 => 重试 3 次后返回最后一次的失败
    calls = with_fake_run([(255, "", "Connection closed")])
    rc, _, err = worker.ssh(CFG, "ls -1 x", retries=3, backoff=0.01)
    if rc != 255 or len(calls) != 3:
        fails.append("重试次数: rc=%s calls=%d" % (rc, len(calls)))

    # 4) retries 默认 1: 老行为, 不重试
    calls = with_fake_run([(255, "", "Connection closed")])
    rc, _, _ = worker.ssh(CFG, "ls -1 x")
    if rc != 255 or len(calls) != 1:
        fails.append("默认不重试: rc=%s calls=%d" % (rc, len(calls)))

    # 5) 超时 (-9) 也算连接层失败
    calls = with_fake_run([(-9, "", "[TIMEOUT]"), (0, "OK", "")])
    rc, _, _ = worker.ssh(CFG, "stat x", retries=2, backoff=0.01)
    if rc != 0 or len(calls) != 2:
        fails.append("超时后重试: rc=%s calls=%d" % (rc, len(calls)))

    if fails:
        for f in fails:
            print("FAIL:", f)
        return 1
    print("PASS  ssh 轻量重试 5 项断言全过")
    return 0


if __name__ == "__main__":
    sys.exit(main())
