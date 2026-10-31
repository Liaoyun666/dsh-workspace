# -*- coding: utf-8 -*-
"""sub.py — PIL 字幕 / 标题卡 / 角标渲染（一套样式，别每条视频现调）。

要点：
  · 中文字体用微软雅黑 msyh.ttc + 加粗 msyhbd.ttc（系统自带，别下载字体）
  · 统一描边 + 投影，保证任何画面上都看得清
  · 所有尺寸按 720x1280 设计，1080p 传 scale=1.5 等比放大（见 STYLE.md）
  · 字幕永远在安全区里、离底部留白，别贴边（B 站播放器底下有进度条）

用法：
    py -3 -X utf8 sub.py --demo demo/shots        # 生成几张样张 PNG，肉眼验样式
    py -3 -X utf8 sub.py --text "这行字会带描边" --out demo/shot.png
"""

import argparse
import os
import sys

from PIL import Image, ImageDraw, ImageFont

# ------------------------------------------------------------------ 样式表
STYLE = {
    "size": (720, 1280),
    "fps": 24,
    "safe": 56,              # 左右安全边距
    "bottom_reserve": 210,   # 底部这块只放字幕, 别放别的
    "colors": {
        "bg": "#0E1116",       # 墨底
        "ink": "#F2F5F7",      # 主字
        "gold": "#FFD166",     # 强调/高亮
        "cyan": "#4CC9F0",     # 次强调/进度条
        "shadow": "#000000",
    },
    "fonts": {
        "title": ("C:/Windows/Fonts/msyhbd.ttc", 92),
        "h2": ("C:/Windows/Fonts/msyhbd.ttc", 62),
        "body": ("C:/Windows/Fonts/msyh.ttc", 46),
        "sub": ("C:/Windows/Fonts/msyhbd.ttc", 52),
        "badge": ("C:/Windows/Fonts/msyhbd.ttc", 38),
        "footer": ("C:/Windows/Fonts/msyh.ttc", 32),
    },
    "stroke": 4,
    "shadow_offset": (0, 5),
    "line_gap": 1.28,
}

_FONT_CACHE = {}


def hex2rgb(h):
    h = h.lstrip("#")
    return tuple(int(h[i:i + 2], 16) for i in (0, 2, 4))


def font(role, scale=1.0):
    """role: title/h2/body/sub/badge/footer；scale: 1080p 用 1.5。"""
    path, size = STYLE["fonts"][role]
    key = (path, int(round(size * scale)))
    if key not in _FONT_CACHE:
        _FONT_CACHE[key] = ImageFont.truetype(path, key[1])
    return _FONT_CACHE[key]


def text_w(text, f):
    box = f.getbbox(text)
    return box[2] - box[0]


def wrap(text, f, max_w):
    """按像素宽度折行（中文按字折，英文按词折）。"""
    lines, cur = [], ""
    for ch in text:
        if ch == "\n":
            lines.append(cur)
            cur = ""
            continue
        trial = cur + ch
        if text_w(trial, f) <= max_w or not cur:
            cur = trial
        else:
            lines.append(cur)
            cur = ch
    if cur:
        lines.append(cur)
    return lines


def draw_stroked(draw, xy, text, f, fill, anchor="la", stroke=None, shadow=True, scale=1.0):
    """描边 + 投影的文字。xy 是 anchor 指定的锚点。"""
    col = hex2rgb(fill)
    st = hex2rgb(STYLE["colors"]["bg"])
    if stroke is None:
        stroke = int(round(STYLE["stroke"] * scale))
    if shadow:
        off = (int(STYLE["shadow_offset"][0] * scale), int(STYLE["shadow_offset"][1] * scale))
        draw.text((xy[0] + off[0], xy[1] + off[1]), text, font=f, fill=(0, 0, 0),
                  anchor=anchor, stroke_width=stroke, stroke_fill=(0, 0, 0))
    draw.text(xy, text, font=f, fill=col, anchor=anchor,
              stroke_width=stroke, stroke_fill=st)


def bg_image(size=None, top=None, bottom=None, noise=0.035):
    """竖直渐变的底，比纯色有质感；默认深墨 -> 近黑。

    noise: 叠一层极淡的颗粒。深色大面积渐变在 8bit H.264 里很容易出"色带"
    (一条条横纹, 肉眼看像画坏了), 撒点颗粒就压住了 —— 这是修过才知道的细节。
    """
    w, h = size or STYLE["size"]
    top = hex2rgb(top or "#151A21")
    bottom = hex2rgb(bottom or "#0A0D11")
    img = Image.new("RGB", (w, h), bottom)
    d = ImageDraw.Draw(img)
    for y in range(h):
        k = y / max(1, h - 1)
        d.line([(0, y), (w, y)], fill=tuple(int(top[i] + (bottom[i] - top[i]) * k) for i in range(3)))
    if noise:
        grain = Image.effect_noise((w, h), 12).convert("RGB")
        img = Image.blend(img, grain, noise)
    return img


def title_card(title, subtitle="", badge="", size=None, scale=1.0, bg=None):
    """片头/章节卡：大标题 + 副标题 + 左上角角标。"""
    img = (bg or bg_image(size)).convert("RGB")
    w, h = img.size
    d = ImageDraw.Draw(img)
    margin = int(STYLE["safe"] * scale)
    f_title = font("title", scale)
    lines = wrap(title, f_title, w - margin * 2)
    lh = int(f_title.size * STYLE["line_gap"])
    y = h // 2 - lh * len(lines) // 2
    for line in lines:
        draw_stroked(d, (w // 2, y), line, f_title, STYLE["colors"]["ink"],
                     anchor="ma", scale=scale)
        y += lh
    if subtitle:
        f_sub = font("body", scale)
        y += int(18 * scale)
        for line in wrap(subtitle, f_sub, w - margin * 2):
            draw_stroked(d, (w // 2, y), line, f_sub, STYLE["colors"]["gold"],
                         anchor="ma", shadow=False, scale=scale)
            y += int(f_sub.size * STYLE["line_gap"])
    if badge:
        badge_chip(img, badge, scale=scale)
    return img


def badge_chip(img, text, scale=1.0, pos=None):
    """左上角的胶囊角标。"""
    d = ImageDraw.Draw(img)
    f = font("badge", scale)
    margin = int(STYLE["safe"] * scale)
    tw = text_w(text, f)
    pad_x, pad_y = int(20 * scale), int(10 * scale)
    x0, y0 = (margin, margin) if pos is None else pos
    x1, y1 = x0 + tw + pad_x * 2, y0 + f.size + pad_y * 2
    d.rounded_rectangle([x0, y0, x1, y1], radius=int(20 * scale),
                        fill=hex2rgb(STYLE["colors"]["gold"]))
    d.text(((x0 + x1) // 2, (y0 + y1) // 2 - int(2 * scale)), text, font=f,
           fill=hex2rgb(STYLE["colors"]["bg"]), anchor="mm")
    return img


def draw_subtitle(img, text, scale=1.0, emphasis=False, bottom=None):
    """底部字幕（最多两行，超了自动缩字号）。emphasis=True 用金色。"""
    if not text:
        return img
    d = ImageDraw.Draw(img)
    w, h = img.size
    margin = int(STYLE["safe"] * scale)
    max_w = w - margin * 2
    f = font("sub", scale)
    lines = wrap(text, f, max_w)
    while len(lines) > 2 and f.size > 30:
        f = ImageFont.truetype(STYLE["fonts"]["sub"][0], f.size - 4)
        lines = wrap(text, f, max_w)
    lh = int(f.size * STYLE["line_gap"])
    base = h - (bottom if bottom is not None else STYLE["bottom_reserve"])
    y = base - lh * len(lines)
    for line in lines:
        draw_stroked(d, (w // 2, y), line, f,
                     STYLE["colors"]["gold"] if emphasis else STYLE["colors"]["ink"],
                     anchor="ma", scale=scale)
        y += lh
    return img


def draw_caption(img, text, scale=1.0):
    """中部说明（信息卡/要点），金色竖条 + 白字。"""
    d = ImageDraw.Draw(img)
    w, h = img.size
    margin = int(STYLE["safe"] * scale)
    f = font("body", scale)
    lines = wrap(text, f, w - margin * 2 - int(40 * scale))
    lh = int(f.size * STYLE["line_gap"])
    y = h // 2 - lh * len(lines) // 2
    d.rectangle([margin, y, margin + int(8 * scale), y + lh * len(lines) - int(10 * scale)],
                fill=hex2rgb(STYLE["colors"]["cyan"]))
    for line in lines:
        draw_stroked(d, (margin + int(28 * scale), y), line, f,
                     STYLE["colors"]["ink"], scale=scale)
        y += lh
    return img


def draw_footer(img, text, scale=1.0):
    """右下角水印/@ 或者一句尾巴。"""
    d = ImageDraw.Draw(img)
    w, h = img.size
    f = font("footer", scale)
    margin = int(STYLE["safe"] * scale)
    d.text((w - margin, h - int(110 * scale)), text, font=f,
           fill=hex2rgb(STYLE["colors"]["cyan"]), anchor="ra")
    return img


def _demo(outdir):
    os.makedirs(outdir, exist_ok=True)
    shots = []
    shots.append(("01_title.png", title_card("偷吃 token 被抓包", "大肥鱼今日份翻车实录", badge="EP.01")))
    shots.append(("02_subtitle.png", draw_subtitle(
        title_card("第 2 个镜头说点正事", "", badge="EP.01"),
        "这句话就是典型的两行字幕，底部留白，描边贴底也不糊。", emphasis=True)))
    shots.append(("03_caption.png", draw_caption(
        title_card("信息卡", "", badge="EP.01"), "要点三条：说人话、有画面、结尾要互动。")))
    for name, img in shots:
        p = os.path.join(outdir, name)
        img.save(p)
        print("OK  %s  %dx%d" % (p, img.size[0], img.size[1]))
    return 0


def main():
    ap = argparse.ArgumentParser(description="字幕/标题卡渲染")
    ap.add_argument("--demo", help="输出一组样张的目录")
    ap.add_argument("--text", help="单张字幕样张的文字")
    ap.add_argument("--out", help="单张字幕样张的输出路径")
    args = ap.parse_args()
    if args.demo:
        return _demo(args.demo)
    if args.text and args.out:
        img = draw_subtitle(bg_image(), args.text)
        os.makedirs(os.path.dirname(os.path.abspath(args.out)), exist_ok=True)
        img.save(args.out)
        print("OK  %s" % args.out)
        return 0
    ap.print_help()
    return 1


if __name__ == "__main__":
    sys.exit(main())
