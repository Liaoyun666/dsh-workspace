# -*- coding: utf-8 -*-
"""demo.py — toolkit 自检样片：voice + sub + fx + encode 串起来出一条 10 秒竖屏片。

它的作用有两个：
  1) 证明 toolkit 四个模块在本机能真跑（不是纸上文档）；
  2) 当"最小可用模板"：出片任务照这个骨架改台词/画面就行。

用法：
    cd E:/工作区/肥鱼之家/toolkit
    PYTHONPATH=E:/工作区/肥鱼之家/.vendor/py py -3 -X utf8 demo.py
    # 出 demo/out.mp4 + demo/frames/ + demo/voice.mp3/.json
"""

import argparse
import os
import shutil
import sys

import encode
import fx
import sub
import voice

LINES = [
    "大家好，我是大肥鱼。",
    "这是工作箱的自检样片。",
    "配音、字幕、动效、编码，一条龙。",
]


def render(outdir, fps=24, size="720p", voice_name=voice.VOICE, rate="+8%"):
    os.makedirs(outdir, exist_ok=True)
    frames_dir = os.path.join(outdir, "frames")
    if os.path.isdir(frames_dir):
        shutil.rmtree(frames_dir)
    os.makedirs(frames_dir)

    mp3 = os.path.join(outdir, "voice.mp3")
    info = voice.synthesize(LINES, mp3, voice=voice_name, rate=rate)
    cues = info["cues"]
    total = info["duration"] + 0.5

    w, h = encode.SIZES[size]
    scale = w / 720.0
    n = int(total * fps)
    bg = sub.bg_image((w, h))
    title = "大肥鱼的工作箱"
    badge = "EP.01"

    for i in range(n):
        t = i / float(fps)
        img = bg.copy()
        if t < 1.2:
            # 片头：标题卡 + 打字机
            img = sub.title_card(title, "toolkit 自检 · 十秒样片", badge=badge,
                                 size=(w, h), scale=scale, bg=img)
            typed = fx.typewriter(title, t, start=0.05, cps=7)
            if typed != title:
                img = sub.title_card(typed + ("▌" if int(t * 8) % 2 == 0 else ""),
                                     "", badge=badge, size=(w, h), scale=scale, bg=bg.copy())
        else:
            # 正片：角标 + 中部信息卡 + 底部字幕
            img = sub.draw_caption(img, "voice · sub · fx · encode", scale=scale)
            img = fx.chapter_badge(img, "01", "工具链", scale=scale)
            cur = None
            for c in cues:
                if c["start"] / 1000.0 <= t <= c["end"] / 1000.0 + 0.25:
                    cur = c
                    break
            if cur:
                local = t - cur["start"] / 1000.0
                shown = fx.typewriter(cur["text"], local, start=0.0, cps=22)
                img = sub.draw_subtitle(img, shown, scale=scale, emphasis=True)
        img = fx.bottom_scrim(img, int(h * 0.36))
        img = fx.push(img, t, total, amount=0.05)
        img = fx.progress_bar(img, t / total, thickness=int(10 * scale),
                              margin=int(24 * scale))
        img = fx.fade(img, fx.fade_envelope(t, total, fin=0.3, fout=0.45))
        img.save(os.path.join(frames_dir, "%05d.png" % i))

    out_mp4 = os.path.join(outdir, "out.mp4")
    ok, cmd, tail = encode.encode(frames_dir, out_mp4, audio=mp3,
                                  size=size, fps=fps)
    if not ok:
        print("编码失败:\n" + tail)
        return 1, None
    rep = encode.probe(out_mp4)
    print("OK  %s" % out_mp4)
    print("    %d 帧 / %.2fs / %s %s / %dx%d / %.2f MB" % (
        n, rep["duration"], rep["vcodec"], rep["acodec"],
        rep["size"][0], rep["size"][1], rep["bytes"] / 1048576.0))
    return 0, rep


def main():
    ap = argparse.ArgumentParser(description="toolkit 自检样片")
    ap.add_argument("--out", default=os.path.join(os.path.dirname(os.path.abspath(__file__)), "demo"))
    ap.add_argument("--size", default="720p", choices=list(encode.SIZES))
    ap.add_argument("--fps", type=int, default=24)
    args = ap.parse_args()
    rc, _rep = render(args.out, fps=args.fps, size=args.size)
    return rc


if __name__ == "__main__":
    sys.exit(main())
