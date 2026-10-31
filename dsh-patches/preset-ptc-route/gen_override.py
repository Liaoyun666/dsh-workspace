#!/usr/bin/env python3
"""为内置预设（默认 ptc）生成 profile 覆盖补丁，钉死子 agent 的默认 LLM 路由。

背景：预设里 `tool-subagent` 若只写 modelSelectionSettings、不写 agentOptions，
子 agent 会继承父会话的路由（dsh-subagent 的 resolveChildAgentOptions），
而子智能体白名单只管「模型显式选路由」的情形，继承不受约束。

做法：从安装的 app.asar 读出 `@deepseek-ai/dsh-web-app/presets/<preset>.patch.yml`，
把它的 plugins 列表原样搬进 profile 的 cordis.patch.yml，写成按行 id 覆盖的
`- id: preset-<preset>`（官方 README 所说「按该行 id 写覆盖补丁」），
在 delegation 组的 tool-subagent 上补 agentOptions。

DSH 升级后内置预设会变，重跑本脚本即可重新生成（带 --check 可先比对）。

用法：
  py gen_override.py                                  # 生成并写入 profile 补丁
  py gen_override.py --check                          # 只比对，不写
  py gen_override.py --provider deepseek-account --model deepseek-flash
  py gen_override.py --preset standard --provider deepseek-account --model deepseek-flash
  py gen_override.py --profile-patch "D:/x/cordis.patch.yml"
"""

import argparse
import json
import os
import struct
import sys

ASAR = r"E:/Deepseek/resources/app.asar"
PRESET_FILE = "dsh/node_modules/@deepseek-ai/dsh-web-app/presets/{preset}.patch.yml"
DEFAULT_PROFILE_PATCH = os.path.expanduser(
    os.path.join(os.environ.get("DSH_HOME", os.path.expanduser("~/.dsh")),
                 "profiles", "desktop", "cordis.patch.yml"))

BLOCK_START = "# ── preset-{preset} override（由 dsh-patches/preset-ptc-route/gen_override.py 生成，勿手改） ──"
BLOCK_END = "# ── /preset-{preset} override ──"


# ── asar 读取（不需要 node） ──────────────────────────────────────────────
def read_asar_text(path):
    with open(ASAR, "rb") as f:
        u = struct.unpack("<4I", f.read(16))
        f.seek(16)
        raw = f.read(u[2])
        header, _ = json.JSONDecoder().raw_decode(raw.decode("utf-8", errors="replace"))
        data_start = 8 + u[1]
        node = header
        for part in path.split("/"):
            node = node["files"][part]
        f.seek(data_start + int(node["offset"]))
        return f.read(int(node["size"])).decode("utf-8")


# ── 从预设补丁里取 plugins 列表 ──────────────────────────────────────────
def extract_plugins(text, preset):
    lines = text.splitlines()
    start = None
    for i, line in enumerate(lines):
        if line.strip() == "plugins:" and start is None:
            start = i
            break
    if start is None:
        raise SystemExit(f"预设 {preset} 里找不到 plugins: 列表")
    block = lines[start + 1:]
    while block and not block[0].startswith(" " * 4 + "- ") and block[0].strip() == "":
        block.pop(0)
    if not block or not block[0].lstrip().startswith("- "):
        raise SystemExit(f"预设 {preset} 的 plugins 列表为空")
    item_indent = len(block[0]) - len(block[0].lstrip())
    if item_indent < 8:
        raise SystemExit(f"预设 {preset} 的 plugins 缩进异常: {item_indent}")
    return block, item_indent


def indent_of(line):
    return len(line) - len(line.lstrip())


def inject_agent_options(block, _item_indent, provider, model, preset):
    """在 `- id: tool-subagent` 这一项的 config 里补 agentOptions。

    tool-subagent 可能嵌在 delegation 组里（缩进比顶层 plugin 深），
    所以按它自己的缩进定位键和项边界，不能假定顶层缩进。
    """
    out = []
    i = 0
    injected = False
    while i < len(block):
        line = block[i]
        out.append(line)
        if line.strip() == "- id: tool-subagent":
            target_indent = indent_of(line)
            key_indent = target_indent + 4         # config 下的键
            # 找到这一项的结束位置：下一行缩进 <= 本项缩进（空行跳过）
            j = i + 1
            while j < len(block) and (block[j].strip() == "" or indent_of(block[j]) > target_indent):
                j += 1
            item = block[i:j]
            if any(l.strip().startswith("agentOptions:") for l in item):
                i = j
                out.extend(item[1:])
                continue
            anchor = None
            for k, l in enumerate(item):
                if len(l) - len(l.lstrip()) == key_indent and l.strip() == "modelSelectionSettings: true":
                    anchor = k
            if anchor is None:
                for k, l in enumerate(item):
                    if len(l) - len(l.lstrip()) == key_indent and l.strip().startswith("toolName:"):
                        anchor = k
            if anchor is None:
                raise SystemExit(f"预设 {preset}: tool-subagent 的 config 里找不到插入点")
            pad = " " * key_indent
            extra = [
                pad + "agentOptions:",
                pad + "  provider: " + provider,
                pad + "  model: " + model,
            ]
            out.extend(item[1:anchor + 1])
            out.extend(extra)
            out.extend(item[anchor + 1:])
            injected = True
            i = j
            continue
        i += 1
    if not injected:
        raise SystemExit(f"预设 {preset}: 未注入 agentOptions（可能没有 tool-subagent 行）")
    return out


def build_block(preset, provider, model):
    text = read_asar_text(PRESET_FILE.format(preset=preset))
    block, item_indent = extract_plugins(text, preset)
    dedent = item_indent - 6
    if dedent < 0:
        raise SystemExit("plugins 缩进小于覆盖块要求")
    block = [l[dedent:] if len(l) >= dedent else l for l in block]
    block = inject_agent_options(block, 6, provider, model, preset)

    order = None
    for line in text.splitlines():
        s = line.strip()
        if s.startswith("order:") and not s.startswith("-"):
            order = s.split(":", 1)[1].strip()
            break

    header = BLOCK_START.format(preset=preset)
    footer = BLOCK_END.format(preset=preset)
    lines = [
        header,
        f"- id: preset-{preset}",
        "  name: '@deepseek-ai/dsh-agent-preset'",
        "  config:",
        f"    id: {preset}",
    ]
    if order is not None:
        lines.append(f"    order: {order}")
    lines.append("    plugins:")
    lines += block + [footer]
    return "\n".join(lines) + "\n", len(block)


def splice(profile_text, new_block, preset):
    """把覆盖块写进 profile 补丁（已有则替换，没有则追加到末尾）。"""
    start = BLOCK_START.format(preset=preset)
    end = BLOCK_END.format(preset=preset)
    if start in profile_text and end in profile_text:
        head, rest = profile_text.split(start, 1)
        _, tail = rest.split(end, 1)
        tail = tail.lstrip("\n")
        return head + new_block + tail
    body = profile_text.rstrip("\n")
    return body + "\n\n" + new_block


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--preset", default="ptc")
    ap.add_argument("--provider", default="deepseek-account")
    ap.add_argument("--model", default="deepseek-flash")
    ap.add_argument("--profile-patch", default=DEFAULT_PROFILE_PATCH)
    ap.add_argument("--check", action="store_true")
    args = ap.parse_args()

    new_block, n_lines = build_block(args.preset, args.provider, args.model)
    with open(args.profile_patch, "r", encoding="utf-8") as f:
        current = f.read()

    start = BLOCK_START.format(preset=args.preset)
    in_patch = start in current
    if args.check:
        if not in_patch:
            print(f"[missing] {args.profile_patch} 里没有 preset-{args.preset} 覆盖块")
            return 1
        existing = current.split(start, 1)[1].split(BLOCK_END.format(preset=args.preset), 1)[0]
        same = existing.strip() == new_block.split(start, 1)[1].split(
            BLOCK_END.format(preset=args.preset), 1)[0].strip()
        print(f"[{'ok' if same else 'stale'}] preset-{args.preset}: plugins={n_lines} 行, "
              f"provider={args.provider}, model={args.model}")
        return 0 if same else 2

    updated = splice(current, new_block, args.preset)
    if updated == current:
        print(f"[unchanged] preset-{args.preset}: plugins={n_lines} 行")
        return 0
    with open(args.profile_patch, "w", encoding="utf-8", newline="\n") as f:
        f.write(updated)
    print(f"[written] {args.profile_patch}: preset-{args.preset} 覆盖块 {n_lines} 行 plugins, "
          f"子 agent 默认路由 {args.provider}/{args.model}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
