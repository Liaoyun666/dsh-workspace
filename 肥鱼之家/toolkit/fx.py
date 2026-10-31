# -*- coding: utf-8 -*-
"""fx.py — 可复用的镜头/动效小函数（纯 PIL，逐帧算，不依赖任何视频库）。

为什么逐帧：headless 环境里没有 AE/剪映，PIL 逐帧 + ffmpeg 编码是最稳的路子；
一条 30~60 秒 720p 片子约 700~1500 帧，纯 PIL 画得动（别忘了用固定字体缓存）。

约定：本模块 fx.* 一律"不改原图、返回新图"；sub.draw_* 是"就地画"(逐帧场景省一次拷贝)，
要在同一张底图上画多套效果时记得先 .copy()。

用法：
    py -3 -X utf8 fx.py --demo demo/fx     # 生成一张动效对照表 PNG
"""

import argparse
import math
import os
import sys

from PIL import Image, ImageDraw

import sub


def _rgb(img):
    return img if img.mode == "RGB" else img.convert("RGB")


def fade(img, k):
    """整帧乘黑：k=0 全黑, 1 原样。做淡入淡出。"""
    k = max(0.0, min(1.0, k))
    img = _rgb(img)
    black = Image.new("RGB", img.size, (0, 0, 0))
    return Image.blend(black, img, k)


def fade_envelope(t, dur, fin=0.4, fout=0.5):
    """淡入淡出包络: 返回 0~1 的亮度系数。t/dur 单位秒。"""
    if fin > 0 and t < fin:
        return max(0.0, t / fin)
    if fout > 0 and t > dur - fout:
        return max(0.0, (dur - t) / fout)
    return 1.0


def zoom(img, scale):
    """推拉镜头：scale>1 靠近(推)，<1 拉远。中心裁切再缩放，不糊边。"""
    img = _rgb(img)
    w, h = img.size
    scale = max(0.2, scale)
    cw, ch = int(w / scale), int(h / scale)
    cw, ch = min(cw, w), min(ch, h)
    x0, y0 = (w - cw) // 2, (h - ch) // 2
    return img.crop((x0, y0, x0 + cw, y0 + ch)).resize((w, h), Image.LANCZOS)


def push(img, t, dur, amount=0.08):
    """慢推：整段从 1.0 推到 1+amount，看着有呼吸感。"""
    k = 1.0 + amount * max(0.0, min(1.0, t / max(0.001, dur)))
    return zoom(img, k)


def pan(img, dx=0.0, dy=0.0, scale=1.06):
    """平移（配合 zoom 稍微放大，避免露出边）。dx/dy 是 -1~1 的相对量。"""
    img = zoom(img, scale)
    w, h = img.size
    ox, oy = int(dx * w * 0.04), int(dy * h * 0.04)
    return img.crop((max(0, ox), max(0, oy), w - max(0, -ox), h - max(0, -oy))).resize((w, h), Image.LANCZOS)


def typewriter(text, t, start=0.0, cps=14.0):
    """打字机：t 秒时应该显示到第几个字（按字/秒）。"""
    if t <= start:
        return ""
    n = int((t - start) * cps)
    return text[:max(0, n)]


def progress_bar(img, frac, color=None, thickness=10, margin=24):
    """底部细进度条（B 站竖屏很吃这一套，观众知道还剩多久）。"""
    img = _rgb(img).copy()
    d = ImageDraw.Draw(img)
    w, h = img.size
    frac = max(0.0, min(1.0, frac))
    y = h - margin - thickness
    d.rectangle([margin, y, w - margin, y + thickness], fill=(255, 255, 255, 40))
    d.rectangle([margin, y, margin + int((w - margin * 2) * frac), y + thickness],
                fill=sub.hex2rgb(color or sub.STYLE["colors"]["cyan"]))
    return img


def chapter_badge(img, idx, label="", scale=1.0):
    """左上角章节角标：01 / 02 ... 可带一句标签。"""
    img = _rgb(img).copy()
    text = str(idx) if not label else "%s  %s" % (idx, label)
    return sub.badge_chip(img, text, scale=scale)


def crossfade(a, b, k):
    """转场：两张同尺寸图按 k 淡入淡出。"""
    a, b = _rgb(a), _rgb(b)
    if a.size != b.size:
        b = b.resize(a.size, Image.LANCZOS)
    return Image.blend(a, b, max(0.0, min(1.0, k)))


def wipe(a, b, k, direction="left"):
    """擦除转场：k=0 全是 a, k=1 全是 b。"""
    a, b = _rgb(a), _rgb(b)
    if a.size != b.size:
        b = b.resize(a.size, Image.LANCZOS)
    w, h = a.size
    out = a.copy()
    edge = int(w * max(0.0, min(1.0, k)))
    if direction == "left":
        out.paste(b.crop((0, 0, edge, h)), (0, 0))
    else:
        out.paste(b.crop((w - edge, 0, w, h)), (w - edge, 0))
    return out


def shake(img, t, amp=6, freq=9.0):
    """轻微抖动，配合"被吓到"的台词。别超过 8px，晃多了像坏视频。"""
    img = _rgb(img)
    w, h = img.size
    dx = int(math.sin(t * freq) * amp)
    dy = int(math.cos(t * freq * 0.8) * amp * 0.6)
    return img.transform(img.size, Image.AFFINE, (1, 0, -dx, 0, 1, -dy), resample=Image.BILINEAR)


def bottom_scrim(img, height=420, strength=0.75):
    """底部压暗，让白字幕在任何画面上都读得清。"""
    img = _rgb(img).copy()
    w, h = img.size
    scrim = Image.new("L", (1, height))
    for y in range(height):
        scrim.putpixel((0, y), int(255 * strength * (y / max(1, height - 1)) ** 1.4))
    scrim = scrim.resize((w, height))
    black = Image.new("RGB", (w, height), (0, 0, 0))
    img.paste(Image.composite(black, img.crop((0, h - height, w, h)), scrim),
              (0, h - height))
    return img


def _demo(outdir):
    os.makedirs(outdir, exist_ok=True)
    base = sub.title_card("动效对照表", "同一镜头, 六种处理", badge="FX")
    cells = []
    cells.append(("fade 0.5", fade(base, 0.5)))
    cells.append(("zoom x1.25", zoom(base, 1.25)))
    # 注意: sub 里的 draw_* 是"就地画"(逐帧管线里少一次拷贝最快), 所以要传副本
    cells.append(("typewriter", sub.draw_subtitle(base.copy(), "打字机：一句一句往外蹦", emphasis=True)))
    cells.append(("progress 60%", progress_bar(base, 0.6)))
    cells.append(("badge 02", chapter_badge(base, "02", "章节"))
    )
    cells.append(("scrim", bottom_scrim(base)))
    tw, th = 300, 534
    sheet = Image.new("RGB", (tw * 3, th * 2), (10, 10, 10))
    for i, (label, img) in enumerate(cells):
        cell = img.resize((tw, th), Image.LANCZOS)
        d = ImageDraw.Draw(cell)
        d.text((10, 10), label, font=sub.font("footer", 0.6), fill=(255, 255, 255))
        sheet.paste(cell, ((i % 3) * tw, (i // 3) * th))
    p = os.path.join(outdir, "fx_sheet.png")
    sheet.save(p)
    print("OK  %s  %dx%d" % (p, sheet.size[0], sheet.size[1]))
    return 0


def main():
    ap = argparse.ArgumentParser(description="镜头/动效小函数")
    ap.add_argument("--demo", help="输出动效对照表的目录")
    args = ap.parse_args()
    if args.demo:
        return _demo(args.demo)
    ap.print_help()
    return 1


if __name__ == "__main__":
    sys.exit(main())
