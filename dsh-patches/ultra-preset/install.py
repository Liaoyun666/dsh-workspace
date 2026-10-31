#!/usr/bin/env python3
"""把「超频（Ultra）」Agent 预设写进 DSH profile 的 cordis.patch.yml。

做法：在 profile 补丁末尾维护一个受管块（`# ── preset-ultra … ──` / `# ── /preset-ultra ──`），
块内容来自同目录的 ultra.patch.block.yml。profile 补丁是热重载的，但只影响**之后创建**的
Agent：已经开着的会话保持旧组合，要新开会话才看得到「超频」。

用法：
  py install.py            # 写入（先备份，重复运行会替换受管块）
  py install.py --check    # 只比对：0=一致，1=未安装，2=内容过期
  py install.py --remove   # 删除受管块（先备份）
  py install.py --print    # 打印将要写入的块
"""

import argparse
import datetime as _dt
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
BLOCK_FILE = os.path.join(HERE, "ultra.patch.block.yml")
START = "# ── preset-ultra（超频模式；由 dsh-patches/ultra-preset/install.py 维护，勿手改） ──"
END = "# ── /preset-ultra ──"
PRESET_ID = "ultra"


def profile_patch() -> str:
    home = os.environ.get("DSH_HOME") or os.path.expanduser("~/.dsh")
    return os.path.join(home, "profiles", "desktop", "cordis.patch.yml")


def read_text(path: str) -> str:
    with open(path, encoding="utf-8") as f:
        return f.read()


def write_text(path: str, text: str) -> None:
    with open(path, "w", encoding="utf-8", newline="\n") as f:
        f.write(text)


def strip_block(text: str) -> tuple[str, bool]:
    """去掉受管块；返回 (剩余文本, 是否找到过块)。块不完整时报错。"""
    out, found, skipping = [], False, False
    for line in text.splitlines(keepends=True):
        bare = line.rstrip("\r\n")
        if bare == START:
            if skipping:
                raise SystemExit("补丁里出现了两个块起始标记，先手动清理")
            found, skipping = True, True
            continue
        if skipping:
            if bare == END:
                skipping = False
            continue
        out.append(line)
    if skipping:
        raise SystemExit("块起始标记没有对应的结束标记，先手动清理")
    return "".join(out), found


def validate_yaml(text: str) -> None:
    try:
        import yaml
    except ImportError:
        print("[warn] 没装 PyYAML，跳过语法校验", file=sys.stderr)
        return

    class Loader(yaml.SafeLoader):
        pass

    # cordis 用 !!js 标量做 Loader 表达式，SafeLoader 默认不认这个 tag
    Loader.add_multi_constructor(
        "tag:yaml.org,2002:js",
        lambda loader, suffix, node: loader.construct_scalar(node),
    )

    try:
        docs = list(yaml.load_all(text, Loader=Loader))
    except yaml.YAMLError as exc:
        raise SystemExit(f"YAML 解析失败：{exc}")
    rows = docs[0] if docs else []
    if not isinstance(rows, list):
        raise SystemExit("profile 补丁顶层不是列表")

    hits = []

    def walk(node):
        if isinstance(node, dict):
            if node.get("id") == f"preset-{PRESET_ID}":
                hits.append(node)
            for value in node.values():
                walk(value)
        elif isinstance(node, list):
            for value in node:
                walk(value)

    walk(rows)
    if len(hits) != 1:
        raise SystemExit(f"期望恰好一个 preset-{PRESET_ID} 声明，实际 {len(hits)} 个")
    config = hits[0].get("config") or {}
    if config.get("id") != PRESET_ID or not config.get("plugins"):
        raise SystemExit("preset-ultra 的 config.id / config.plugins 不完整")


def main() -> int:
    ap = argparse.ArgumentParser(description="安装 / 卸载超频（Ultra）Agent 预设")
    ap.add_argument("--check", action="store_true", help="只比对，不写")
    ap.add_argument("--remove", action="store_true", help="删除受管块")
    ap.add_argument("--print", dest="show", action="store_true", help="打印块内容")
    ap.add_argument("--profile-patch", default=None, help="覆盖 profile 补丁路径")
    args = ap.parse_args()

    block = read_text(BLOCK_FILE).replace("\r\n", "\n")
    if not block.endswith("\n"):
        block += "\n"
    if args.show:
        sys.stdout.write(block)
        return 0

    patch = args.profile_patch or profile_patch()
    if not os.path.isfile(patch):
        raise SystemExit(f"找不到 profile 补丁：{patch}")
    text = read_text(patch)
    rest, installed = strip_block(text)

    if args.check:
        if not installed:
            print(f"未安装：{patch}")
            return 1
        if block in text:
            print(f"已安装且一致：{patch}")
            return 0
        print(f"已安装但内容过期（块与 {os.path.basename(BLOCK_FILE)} 不一致）：{patch}")
        return 2

    stamp = _dt.datetime.now().strftime("%Y%m%d-%H%M%S")
    backup = f"{patch}.bak-ultra-{stamp}"
    with open(patch, "rb") as src, open(backup, "wb") as dst:
        dst.write(src.read())

    if args.remove:
        write_text(patch, rest)
        validate_yaml(rest)
        print(f"已删除受管块，备份：{backup}")
        return 0

    new_text = rest
    if new_text and not new_text.endswith("\n"):
        new_text += "\n"
    new_text += "\n" + block
    validate_yaml(new_text)
    write_text(patch, new_text)
    print(f"已写入 preset-{PRESET_ID}，备份：{backup}")
    print("提示：profile 补丁热重载只影响之后新建的会话；开着的会话要新开一个才看得到「超频」。")
    return 0


if __name__ == "__main__":
    sys.exit(main())
