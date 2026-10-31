# -*- coding: utf-8 -*-
"""voice.py — edge-tts 配音封装（逐句时间对齐，供字幕用）。

为什么逐句合成：只有一句一文件才能拿到「每句真实时长」→ 字幕能和声音对齐；
整段合成虽然更自然，但拿不到句级边界。我们选「逐句 + 小间隔」，对短视频口播足够。

用法（在 E:/工作区/肥鱼之家/toolkit 下）：
    py -3 -X utf8 voice.py --lines "第一句|第二句|第三句" --out demo/voice.mp3
    py -3 -X utf8 voice.py --script script.txt --out demo/voice.mp3 --rate "+10%"

输出：
    <out>.mp3      —— 配音成品（24kHz 单声道，方便和 48k 视频轨混）
    <out>.json     —— 逐句 [{text,start,end,dur}]，单位毫秒，直接喂 sub.py
    <out>.srt      —— 顺手给一份标准字幕（有些播放器/平台用得上）

依赖：edge-tts 7.3.1 已预装（PYTHONPATH=E:/工作区/肥鱼之家/.vendor/py），ffmpeg/ffprobe 在 PATH。
绝不要在这里 pip install（会卡网络十几分钟，踩过坑）。
"""

import argparse
import asyncio
import json
import os
import subprocess
import sys
import tempfile

VOICE = "zh-CN-XiaoyiNeural"   # 小艺，女声，年轻，口播感好
GAP = 0.12                     # 句间静音（秒），太小会粘、太大会拖


def ffprobe_duration(path):
    """返回秒数；失败返回 0.0。"""
    try:
        out = subprocess.run(
            ["ffprobe", "-v", "error", "-show_entries", "format=duration",
             "-of", "default=nw=1:nk=1", path],
            capture_output=True, text=True, timeout=120)
        return float(out.stdout.strip() or 0)
    except Exception:
        return 0.0


async def _save_one(text, path, voice, rate, pitch, volume):
    import edge_tts
    comm = edge_tts.Communicate(text, voice, rate=rate, pitch=pitch, volume=volume)
    await comm.save(path)


def _tts_all(items, voice, rate, pitch, volume):
    """一个事件循环跑完所有句子。
    Windows 上逐句 asyncio.run() 会留下半关的 proactor 连接, 退出时刷一屏
    "RuntimeError: Event loop is closed"(不影响结果, 但很吓人), 所以合成放在一起跑。
    另外用 SelectorEventLoop: 这个场景不需要 proactor 的命名管道支持。
    """
    if sys.platform == "win32":
        asyncio.set_event_loop_policy(asyncio.WindowsSelectorEventLoopPolicy())

    async def runner():
        for text, path in items:
            await _save_one(text, path, voice, rate, pitch, volume)

    asyncio.run(runner())


def synthesize(lines, out_mp3, voice=VOICE, rate="+0%", pitch="+0Hz",
               volume="+0%", gap=GAP, backend="edge"):
    """逐句合成再拼起来，返回 {"mp3":..., "cues":[{text,start,end,dur}], "duration":秒}。

    所有时间单位都是毫秒（除了返回里的 duration 秒）。
    """
    lines = [x.strip() for x in lines if x and x.strip()]
    if not lines:
        raise ValueError("没有可合成的句子")
    out_mp3 = os.path.abspath(out_mp3)
    outdir = os.path.dirname(out_mp3)
    if outdir:
        os.makedirs(outdir, exist_ok=True)

    tmpdir = tempfile.mkdtemp(prefix="voice-")
    parts, cues, cursor = [], [], 0.0
    try:
        todo = [(line, os.path.join(tmpdir, "l%03d.mp3" % i))
                for i, line in enumerate(lines)]
        _tts_all(todo, voice, rate, pitch, volume)
        for i, (line, p) in enumerate(todo):
            d = ffprobe_duration(p)
            if d <= 0:
                raise RuntimeError("第 %d 句合成出来是空的: %r" % (i + 1, line))
            cues.append({"text": line,
                         "start": int(round(cursor * 1000)),
                         "end": int(round((cursor + d) * 1000)),
                         "dur": int(round(d * 1000))})
            parts.append(p)
            cursor += d + gap

        # 句间静音：生成一段 24k 单声道静音，然后 concat 全部
        silence = os.path.join(tmpdir, "gap.mp3")
        subprocess.run(["ffmpeg", "-y", "-v", "error", "-f", "lavfi",
                        "-i", "anullsrc=r=24000:cl=mono", "-t", "%.3f" % gap,
                        "-c:a", "libmp3lame", "-b:a", "48k", silence],
                       check=True, capture_output=True)
        listfile = os.path.join(tmpdir, "list.txt")
        with open(listfile, "w", encoding="utf-8") as f:
            for i, p in enumerate(parts):
                f.write("file '%s'\n" % p.replace("\\", "/"))
                if i < len(parts) - 1:
                    f.write("file '%s'\n" % silence.replace("\\", "/"))
        subprocess.run(["ffmpeg", "-y", "-v", "error", "-f", "concat", "-safe", "0",
                        "-i", listfile, "-c:a", "libmp3lame", "-ar", "24000",
                        "-ac", "1", "-b:a", "64k", out_mp3],
                       check=True, capture_output=True)
    finally:
        for p in os.listdir(tmpdir):
            try:
                os.remove(os.path.join(tmpdir, p))
            except OSError:
                pass
        try:
            os.rmdir(tmpdir)
        except OSError:
            pass

    total = ffprobe_duration(out_mp3)
    info = {"mp3": out_mp3, "cues": cues, "duration": total,
            "voice": voice, "rate": rate}
    with open(os.path.splitext(out_mp3)[0] + ".json", "w", encoding="utf-8") as f:
        json.dump(info, f, ensure_ascii=False, indent=2)
    write_srt(cues, os.path.splitext(out_mp3)[0] + ".srt")
    return info


def write_srt(cues, path):
    def ts(ms):
        h, ms = divmod(int(ms), 3600000)
        m, ms = divmod(ms, 60000)
        s, ms = divmod(ms, 1000)
        return "%02d:%02d:%02d,%03d" % (h, m, s, ms)

    with open(path, "w", encoding="utf-8") as f:
        for i, c in enumerate(cues, 1):
            f.write("%d\n%s --> %s\n%s\n\n" % (i, ts(c["start"]), ts(c["end"]), c["text"]))


def load_cues(path):
    """给 sub.py / demo.py 用：读回 <out>.json 里的逐句时间。"""
    with open(path, encoding="utf-8") as f:
        return json.load(f)["cues"]


def main():
    ap = argparse.ArgumentParser(description="edge-tts 逐句配音 + 时间对齐")
    ap.add_argument("--lines", help="用 | 分隔的句子，一次说完")
    ap.add_argument("--script", help="从文件读句子（一行一句）")
    ap.add_argument("--out", required=True, help="输出的 mp3 路径，如 demo/voice.mp3")
    ap.add_argument("--voice", default=VOICE)
    ap.add_argument("--rate", default="+0%", help="语速，如 +10% / -5%")
    ap.add_argument("--pitch", default="+0Hz")
    ap.add_argument("--volume", default="+0%")
    ap.add_argument("--gap", type=float, default=GAP, help="句间静音秒数")
    args = ap.parse_args()

    if args.script:
        with open(args.script, encoding="utf-8") as f:
            lines = [x.strip() for x in f if x.strip()]
    elif args.lines:
        lines = args.lines.split("|")
    else:
        ap.error("要么 --lines 要么 --script")

    info = synthesize(lines, args.out, voice=args.voice, rate=args.rate,
                      pitch=args.pitch, volume=args.volume, gap=args.gap)
    print("OK  %s" % info["mp3"])
    print("    时长 %.2fs, %d 句" % (info["duration"], len(info["cues"])))
    for c in info["cues"]:
        print("    [%5d-%5d] %s" % (c["start"], c["end"], c["text"]))
    return 0


if __name__ == "__main__":
    sys.exit(main())
