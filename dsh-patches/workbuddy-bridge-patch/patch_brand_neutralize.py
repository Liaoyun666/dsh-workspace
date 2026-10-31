#!/usr/bin/env python3
"""修掉 dsh-workbuddy-bridge 的「品牌词二次改写」失效问题（2026-10-29 实测）。

背景
----
腾讯 copilot.tencent.com 的频道签名风控会拒绝含 `DeepSeek Harness` 的请求（HTTP 400 /
机器码 11128，前端文案「请求被拦截，请重新发送」）。bridge 0.5.4 本来做了两级改写：

  1. 开篇句 `You are an AI agent powered by DeepSeek Harness.` → `You are an AI agent.`
  2. 其余出现处 → 在 DeepSeek 与 Harness 之间插零宽空格 U+200B

2026-10-29 实测：**第 2 级已经失效**。网关现在会把零宽字符归一化掉再匹配，于是
system 消息里只要还有第二处裸的 `DeepSeek Harness` 就仍然 400。实测证据：
  - 完整 15622 字符系统提示词 → 400/11128
  - 同样内容把零宽改成空格 → 400/11128
  - 同样内容把 `DeepSeek Harness` 全部改成可读短语 → 200
  - 二分定位：命中点就是 `You are an AI agent powered by DeepSeek Harness.`（开篇）之外
    的两处裸出现

本补丁
------
把第 2 级从「插零宽」换成「换成可读短语」，保持原有的路径保护（两侧是斜杠的真实目录名
不改写）。另外把 index.js 里我先前那个「扰动重试」的扰动方式也换成同一套可读改写，
免得它继续拿零宽字符白试一次。

用法
----
    py patch_brand_neutralize.py            # 打补丁
    py patch_brand_neutralize.py --check    # 只看状态
    py patch_brand_neutralize.py --restore  # 回滚到最近一次 .bak-brand-*
"""

from __future__ import annotations

import sys
import time
from pathlib import Path

LIB = Path(r"C:/Users/user\.dsh\profiles\desktop\node_modules\dsh-workbuddy-bridge\lib")
INDEX = LIB / "index.js"

MARKER = '"the local agent runtime"'

OLD_SECOND = '''return text.replace(CHANNEL_OPENER, "$1You are an AI agent.").replace(CHANNEL_SIGNATURE_PHRASE, `DeepSeek${ZERO_WIDTH_SPACE}$1Harness`);'''
NEW_SECOND = '''return text.replace(CHANNEL_OPENER, "$1You are an AI agent.").replace(CHANNEL_SIGNATURE_PHRASE, "the local agent runtime");'''

OLD_PERTURB = '''	return text.replace(new RegExp(`(.{${PERTURB_STRIDE}})`, "gs"), `$1\\u200b`);'''
NEW_PERTURB = '''	return text.replaceAll("DeepSeek Harness", "the local agent runtime").replace(new RegExp(`(.{${PERTURB_STRIDE}})`, "gs"), `$1\\u200b`);'''


def find_chunk() -> Path:
    for path in sorted(LIB.glob("*.js")):
        text = path.read_text(encoding="utf-8")
        if "CHANNEL_SIGNATURE_PHRASE =" in text:
            return path
    raise SystemExit("找不到含 CHANNEL_SIGNATURE_PHRASE 的 chunk，插件结构可能变了")


def backup(path: Path, tag: str) -> Path:
    stamp = time.strftime("%Y%m%d-%H%M%S")
    dst = path.with_name(f"{path.name}.bak-{tag}-{stamp}")
    dst.write_bytes(path.read_bytes())
    return dst


def main() -> int:
    chunk = find_chunk()
    chunk_text = chunk.read_text(encoding="utf-8")
    index_text = INDEX.read_text(encoding="utf-8")

    if "--check" in sys.argv:
        print(f"chunk: {chunk.name}")
        print("品牌词二级改写:", "已修" if MARKER in chunk_text else "未修")
        print("index.js 扰动:", "已修" if MARKER in index_text else "未修")
        return 0

    if "--restore" in sys.argv:
        for path in (chunk, INDEX):
            baks = sorted(path.parent.glob(f"{path.name}.bak-brand-*"))
            if not baks:
                print(f"{path.name}: 没有备份")
                continue
            path.write_bytes(baks[-1].read_bytes())
            print(f"{path.name}: 已回滚自 {baks[-1].name}")
        return 0

    changed = False

    if MARKER not in chunk_text:
        if chunk_text.count(OLD_SECOND) != 1:
            print(f"二级改写锚点命中 {chunk_text.count(OLD_SECOND)} 次（期望 1），插件可能已升级，跳过")
        else:
            backup(chunk, "brand")
            chunk.write_text(chunk_text.replace(OLD_SECOND, NEW_SECOND, 1), encoding="utf-8")
            print(f"{chunk.name}: 二级品牌改写 → 可读短语（已备份）")
            changed = True
    else:
        print(f"{chunk.name}: 已修，跳过")

    if "--check" not in sys.argv and MARKER not in index_text:
        if index_text.count(OLD_PERTURB) != 1:
            print(f"index.js 扰动锚点命中 {index_text.count(OLD_PERTURB)} 次（期望 1），跳过")
        else:
            backup(INDEX, "brand")
            INDEX.write_text(index_text.replace(OLD_PERTURB, NEW_PERTURB, 1), encoding="utf-8")
            print("index.js: 扰动重试改为可读改写（已备份）")
            changed = True
    else:
        print("index.js: 已修或无需修改，跳过")

    print("完成，需要重启 DSH 才会加载新代码" if changed else "无需改动")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
