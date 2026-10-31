# -*- coding: utf-8 -*-
"""encode.py — ffmpeg 统一编码封装（一条命令出 B 站能吃的片子）。

固定参数（都踩过坑才定下来的）：
  · 竖屏 720x1280 或 1080x1920，H.264 yuv420p（不转 pixel format 手机端会黑屏）
  · AAC 48kHz 128k；-movflags +faststart（网页秒开，B 站转码也更快）
  · 响度 loudnorm I=-16 LUFS / TP=-1.5 / LRA=11 —— B 站推荐 -16 LUFS，声音不忽大忽小
  · -shortest：音画长度不一时以短的为准，别出静音尾巴

用法：
    py -3 -X utf8 encode.py --frames demo/frames --audio demo/voice.mp3 --out demo/out.mp4
    py -3 -X utf8 encode.py --probe demo/out.mp4
"""

import argparse
import json
import os
import shutil
import subprocess
import sys

FFMPEG_FALLBACK = "C:/Users/user/AppData/Local/ffmpeg/bin/ffmpeg.exe"
SIZES = {"720p": (720, 1280), "1080p": (1080, 1920)}


def ffmpeg_exe():
    return shutil.which("ffmpeg") or FFMPEG_FALLBACK


def ffprobe_exe():
    p = shutil.which("ffprobe")
    if p:
        return p
    return os.path.join(os.path.dirname(FFMPEG_FALLBACK), "ffprobe.exe")


def encode(frames_dir, out_path, audio=None, size="720p", fps=24, crf=20,
           preset="medium", loudnorm=True, pattern="%05d.png", start_number=0,
           duration=None, extra_vf="", quiet=True):
    """把 <frames_dir>/00000.png... 编成 mp4。返回 (ok, 命令, ffmpeg 输出尾部)。"""
    w, h = SIZES[size] if isinstance(size, str) else tuple(size)
    out_path = os.path.abspath(out_path)
    os.makedirs(os.path.dirname(out_path) or ".", exist_ok=True)
    cmd = [ffmpeg_exe(), "-y", "-hide_banner",
           "-framerate", str(fps), "-start_number", str(start_number),
           "-i", os.path.join(os.path.abspath(frames_dir), pattern)]
    if audio:
        cmd += ["-i", os.path.abspath(audio)]
        if duration:
            cmd += ["-t", "%.3f" % duration]
    vf = "scale=%d:%d:flags=lanczos,format=yuv420p" % (w, h)
    if extra_vf:
        vf = extra_vf + "," + vf
    cmd += ["-vf", vf, "-c:v", "libx264", "-preset", preset, "-crf", str(crf),
            "-pix_fmt", "yuv420p", "-r", str(fps)]
    if audio:
        if loudnorm:
            cmd += ["-af", "loudnorm=I=-16:TP=-1.5:LRA=11,aresample=48000"]
        cmd += ["-c:a", "aac", "-ar", "48000", "-b:a", "128k", "-shortest"]
    cmd += ["-movflags", "+faststart", out_path]
    proc = subprocess.run(cmd, capture_output=quiet, text=True)
    tail = ((proc.stdout or "") + (proc.stderr or "")).strip()[-1200:]
    return proc.returncode == 0, cmd, tail


def probe(path):
    """读回真实参数：{"video":是否有视频流,"audio":是否有音频流,"duration":秒,"vcodec","acodec","size":(w,h)}。"""
    cmd = [ffprobe_exe(), "-v", "error", "-show_entries",
           "stream=codec_type,codec_name,width,height:format=duration,size",
           "-of", "json", path]
    proc = subprocess.run(cmd, capture_output=True, text=True)
    if proc.returncode != 0:
        raise RuntimeError("ffprobe 失败: " + (proc.stderr or "")[-400:])
    data = json.loads(proc.stdout or "{}")
    streams = data.get("streams", [])
    fmt = data.get("format", {})
    v = next((s for s in streams if s.get("codec_type") == "video"), None)
    a = next((s for s in streams if s.get("codec_type") == "audio"), None)
    return {"video": v is not None, "audio": a is not None,
            "vcodec": (v or {}).get("codec_name", ""),
            "acodec": (a or {}).get("codec_name", ""),
            "size": ((v or {}).get("width"), (v or {}).get("height")),
            "duration": float(fmt.get("duration") or 0),
            "bytes": int(fmt.get("size") or 0)}


def main():
    ap = argparse.ArgumentParser(description="ffmpeg 统一编码")
    ap.add_argument("--frames", help="PNG 序列目录")
    ap.add_argument("--audio", help="音轨（mp3/wav）")
    ap.add_argument("--out", help="输出 mp4")
    ap.add_argument("--size", default="720p", choices=list(SIZES))
    ap.add_argument("--fps", type=int, default=24)
    ap.add_argument("--crf", type=int, default=20)
    ap.add_argument("--probe", help="只读参数: 给一个 mp4/音频路径")
    args = ap.parse_args()

    if args.probe:
        info = probe(args.probe)
        print(json.dumps(info, ensure_ascii=False, indent=2))
        return 0
    if not (args.frames and args.out):
        ap.error("要 --frames 和 --out")
    ok, cmd, tail = encode(args.frames, args.out, audio=args.audio,
                          size=args.size, fps=args.fps, crf=args.crf)
    print("命令: " + " ".join(cmd) if not ok else "OK  %s" % os.path.abspath(args.out))
    if not ok:
        print("ffmpeg 失败输出尾部:\n" + tail)
        return 1
    info = probe(args.out)
    print("    %dx%d %s+%s %.2fs %.2f MB" % (
        info["size"][0], info["size"][1], info["vcodec"], info["acodec"],
        info["duration"], info["bytes"] / 1048576.0))
    return 0


if __name__ == "__main__":
    sys.exit(main())
