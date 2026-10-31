# -*- coding: utf-8 -*-
"""大肥鱼刷B站 —— 让 QQ 里的大肥鱼自己挑视频看，再叽叽喳喳讲感想。"""

from __future__ import annotations

import asyncio
import html
import importlib.util
import json
import random
import re
import threading
import shutil
import sys
import os
import ssl
import subprocess
import tempfile
import time
import urllib.parse
import urllib.request
from pathlib import Path

import aiohttp

import astrbot.api.star as star
from astrbot.api import logger
from astrbot.api.event import AstrMessageEvent, filter
from astrbot.core.config.astrbot_config import AstrBotConfig
from astrbot.core.message.components import Image, Plain
from astrbot.core.message.message_event_result import MessageChain

API = "https://api.bilibili.com"
UA = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36"
)
TIDS = [1, 3, 4, 5, 36, 119, 129, 181, 188, 202, 211, 217, 223, 234]
DEFAULT_PERSONA = (
    "你是大肥鱼，一条住在主人电脑里的胖鱼。嘴上傲娇、心里软，说话短、爱吐槽、三句不离吃。"
)

LOGIN_API = "https://passport.bilibili.com"
COOKIE_KEYS = ("SESSDATA", "bili_jct", "DedeUserID", "DedeUserID__ckMd5", "sid")

DYNAMIC_CMDS = ("b动态", "发动态", "b站动态", "bili动态")
COMMENT_CMDS = ("b评论", "b站评论", "bili评论")
DANMAKU_CMDS = ("b弹幕", "b站弹幕", "bili弹幕")
VIDEO_CMDS = ("b投稿", "b发视频", "b视频", "bili投稿", "b发布视频", "b拍视频")
VIDEO_OK_CMDS = ("b投稿确认", "b确认投稿", "b投吧", "b发布了", "b过", "b通过", "b同意", "b发吧", "b确认")
VIDEO_NO_CMDS = ("b投稿取消", "b取消投稿", "b毙", "b否决", "b不要", "b撤", "b毙掉", "b删")


def strip_cmd(raw: str, names: tuple[str, ...]) -> str:
    """去掉开头那个指令词。

    AstrBot 给 message_str 时不一定带「/」（指令前缀常被吃掉），所以既按名字剥，
    也兜底剥掉第一个 token —— 否则内容为空时会把指令词本身当成正文发出去。
    """
    s = (raw or "").strip()
    s = re.sub(r"^[/／]\s*", "", s).strip()
    for n in names:
        if s.startswith(n):
            return s[len(n):].strip()
    return re.sub(r"^\S+\s*", "", s, count=1).strip()

FALLBACK_PROMPT = (
    "你要以「大肥鱼」的身份说话：一条嘴馋、傲娇、心软的胖鱼，"
    "口头禅是「哼」「才、才不是」「呜」「嘿嘿」，自称「本鱼」。"
)


def fmt_num(n) -> str:
    try:
        n = int(n)
    except Exception:
        return "0"
    if n >= 100000000:
        return f"{n / 100000000:.1f}亿"
    if n >= 10000:
        return f"{n / 10000:.1f}万"
    return str(n)


def fmt_dur(sec) -> str:
    try:
        sec = int(sec)
    except Exception:
        sec = 0
    if sec >= 3600:
        return f"{sec // 3600}:{sec % 3600 // 60:02d}:{sec % 60:02d}"
    return f"{sec // 60}:{sec % 60:02d}"


class BiliError(Exception):
    pass


# ---------------- 共享记忆（与 astrbot_plugin_dafeiyu_memory 共用一个库） ----------------
_MEM_MOD = {"m": None}


def _mem_module():
    """拿到共享记忆库模块：先看插件有没有把它注册进 sys.modules，再退回按路径加载。"""
    if _MEM_MOD["m"] is not None:
        return _MEM_MOD["m"]
    mod = sys.modules.get("dafeiyu_mem_store")
    if mod is None:
        try:
            p = Path(__file__).resolve().parent.parent / "astrbot_plugin_dafeiyu_memory" / "store.py"
            spec = importlib.util.spec_from_file_location("dafeiyu_mem_store", str(p))
            mod = importlib.util.module_from_spec(spec)
            spec.loader.exec_module(mod)
            sys.modules["dafeiyu_mem_store"] = mod
            logger.info("[刷B站] 已挂上共享记忆库")
        except Exception as e:
            logger.debug(f"[刷B站] 共享记忆库不可用: {e}")
            return None
    _MEM_MOD["m"] = mod
    return mod


def _mem_remember(text: str, tags=None, imp: float = 0.5) -> None:
    try:
        mod = _mem_module()
        if mod is None:
            return
        s = mod.store()
        if getattr(s, "path", "") in ("", "memories.json"):
            s.path = str(
                star.StarTools.get_data_dir("astrbot_plugin_dafeiyu_memory") / "memories.json"
            )
        s.add(text, tags=tags or [], src="b站", imp=imp)
    except Exception as e:
        logger.debug(f"[刷B站] 写共享记忆失败: {e}")


class BiliClient:
    """最小可用的 B 站客户端：只读接口不用登录，写接口（动态/评论/弹幕）要 cookie。"""

    def __init__(self, timeout: int = 12):
        self.timeout = timeout
        self._session: aiohttp.ClientSession | None = None
        self._buvid = ""
        self._login = ""  # 形如 "SESSDATA=...; bili_jct=...; DedeUserID=..."

    def set_login(self, cookie: str) -> None:
        self._login = (cookie or "").strip().strip(";")
        self._apply_cookie()

    def _apply_cookie(self) -> None:
        s = self._session
        if s is None:
            return
        parts = [p for p in (self._buvid, self._login) if p]
        if parts:
            # 关键：直接写 Cookie 头。只塞 cookie_jar 时 aiohttp 不一定带上，
            # 而无 buvid 访问 /x/web-interface/view 会稳定 412。
            s.headers["Cookie"] = "; ".join(parts)
        else:
            s.headers.pop("Cookie", None)

    async def _sess(self) -> aiohttp.ClientSession:
        if self._session is None or self._session.closed:
            self._session = aiohttp.ClientSession(
                timeout=aiohttp.ClientTimeout(total=self.timeout),
                headers={
                    "User-Agent": UA,
                    "Referer": "https://www.bilibili.com/",
                    "Accept": "application/json, text/plain, */*",
                },
            )
            self._apply_cookie()
        if not self._buvid:
            await self._ensure_buvid()
        return self._session

    async def _ensure_buvid(self) -> None:
        try:
            s = self._session
            assert s is not None
            async with s.get(f"{API}/x/frontend/finger/spi") as r:
                j = await r.json(content_type=None)
            d = (j or {}).get("data") or {}
            b3, b4 = d.get("b_3"), d.get("b_4")
            if b3:
                self._buvid = f"buvid3={b3}" + (f"; buvid4={b4}" if b4 else "")
                self._apply_cookie()
        except Exception as e:  # 没有 buvid 也能跑，只是更容易撞风控
            logger.warning(f"[刷B站] 取 buvid 失败: {e}")

    async def _get(self, path: str, params: dict | None = None, raw: bool = False):
        s = await self._sess()
        url = path if path.startswith("http") else f"{API}{path}"
        for attempt in range(3):
            try:
                async with s.get(url, params=params) as r:
                    if r.status == 412:
                        # 撞风控：换一个新 buvid 再试（登录 cookie 留着）
                        self._buvid = ""
                        self._apply_cookie()
                        await self._ensure_buvid()
                        raise BiliError("HTTP 412")
                    if r.status != 200:
                        raise BiliError(f"HTTP {r.status}")
                    if raw:
                        return await r.text()
                    j = await r.json(content_type=None)
                if isinstance(j, dict) and j.get("code") not in (0, None):
                    raise BiliError(f"B站 code={j.get('code')} {j.get('message')}")
                return j.get("data") if isinstance(j, dict) else j
            except Exception as e:
                if attempt == 2:
                    raise BiliError(str(e)) from e
                await asyncio.sleep(0.6 * (attempt + 1))
        return None

    async def get_json(self, path: str, params: dict | None = None) -> dict:
        """取原始响应体（扫码轮询这类接口把状态放在 data.code 里，不能按 code!=0 当错）。"""
        s = await self._sess()
        url = path if path.startswith("http") else f"{API}{path}"
        async with s.get(url, params=params) as r:
            if r.status != 200:
                raise BiliError(f"HTTP {r.status}")
            j = await r.json(content_type=None)
        return j if isinstance(j, dict) else {}

    async def get_json_with_cookies(
        self, path: str, params: dict | None = None
    ) -> tuple[dict, dict]:
        """同上，但把响应里的 Set-Cookie 也带回来（扫码成功靠它拿 SESSDATA）。"""
        s = await self._sess()
        url = path if path.startswith("http") else f"{API}{path}"
        cookies: dict[str, str] = {}
        async with s.get(url, params=params) as r:
            if r.status != 200:
                raise BiliError(f"HTTP {r.status}")
            j = await r.json(content_type=None)
            try:
                for c in r.cookies.values():
                    cookies[c.key] = c.value
            except Exception:
                pass
        return (j if isinstance(j, dict) else {}), cookies

    async def post_form(
        self, path: str, data: dict, referer: str = "https://www.bilibili.com/"
    ) -> dict:
        """写接口统一走这个：表单 POST，带 Referer/Origin（B 站对这两个很挑）。"""
        s = await self._sess()
        url = path if path.startswith("http") else f"{API}{path}"
        hdrs = {
            "Referer": referer,
            "Origin": "https://www.bilibili.com",
            "Content-Type": "application/x-www-form-urlencoded",
        }
        async with s.post(url, data=data, headers=hdrs) as r:
            if r.status != 200:
                raise BiliError(f"HTTP {r.status}")
            j = await r.json(content_type=None)
        return j if isinstance(j, dict) else {}

    async def post_json(
        self, path: str, payload: dict, referer: str = "https://t.bilibili.com/"
    ) -> dict:
        """写接口的 JSON 版：发动态只认 application/json body（表单会回 -400）。"""
        s = await self._sess()
        url = path if path.startswith("http") else f"{API}{path}"
        hdrs = {
            "Referer": referer,
            "Origin": "https://t.bilibili.com",
            "Content-Type": "application/json",
            "x-bili-device-req-json": json.dumps(
                {
                    "platform": "web",
                    "device": "pc",
                    "spmid": "333.999.0.0",
                    "ext_spmid": "333.1387.0.0",
                },
                separators=(",", ":"),
            ),
        }
        body = json.dumps(payload, ensure_ascii=False).encode()
        async with s.post(url, data=body, headers=hdrs) as r:
            if r.status != 200:
                raise BiliError(f"HTTP {r.status}")
            j = await r.json(content_type=None)
            if not isinstance(j, dict):
                # 解析成列表（评论等接口）时包一层，调用方只看 code
                j = {"code": 0, "data": j}
        return j

    async def popular(self, ps: int = 20) -> list[dict]:
        d = await self._get("/x/web-interface/popular", {"ps": ps, "pn": 1})
        return (d or {}).get("list") or []

    async def ranking(self, tid: int) -> list[dict]:
        d = await self._get("/x/web-interface/ranking/v2", {"rid": tid, "type": "all"})
        return (d or {}).get("list") or []

    async def view(self, bvid: str) -> dict:
        return await self._get("/x/web-interface/view", {"bvid": bvid}) or {}

    async def replies(self, aid: int, ps: int = 6) -> list[dict]:
        try:
            d = await self._get(
                "/x/v2/reply",
                {"type": 1, "oid": aid, "sort": 2, "ps": ps, "pn": 1},
            )
            return (d or {}).get("replies") or []
        except Exception as e:
            logger.warning(f"[刷B站] 取评论失败: {e}")
            return []

    async def danmaku(self, cid: int, n: int = 14) -> list[str]:
        try:
            xml = await self._get(f"/x/v1/dm/list.so?oid={cid}", raw=True)
        except Exception as e:
            logger.warning(f"[刷B站] 取弹幕失败: {e}")
            return []
        items = re.findall(r'<d p="[^"]*">(.*?)</d>', xml or "")
        pool: list[str] = []
        seen: set[str] = set()
        for t in items:
            t = html.unescape(t).strip()
            if not (3 <= len(t) <= 26) or t in seen:
                continue
            seen.add(t)
            pool.append(t)
        if len(pool) > n:
            pool = random.sample(pool, n)
        return pool

    async def close(self) -> None:
        if self._session and not self._session.closed:
            await self._session.close()


# ---------------- 投稿：上传链路 + 视频合成 ----------------
FONT_CJK = "/usr/share/fonts/opentype/noto/NotoSerifCJK-Bold.ttc"
UP_HOST = "https://member.bilibili.com"
UP_REF = "https://member.bilibili.com/platform/upload/video/frame"
VIDEO_W, VIDEO_H = 1080, 1920


def probe_media(path: str) -> dict:
    try:
        out = subprocess.run(
            ["ffprobe", "-v", "quiet", "-print_format", "json", "-show_format", "-show_streams", str(path)],
            capture_output=True, text=True, timeout=90,
        ).stdout
        return json.loads(out or "{}")
    except Exception:
        return {}


def media_dur(path: str) -> float:
    try:
        return float((probe_media(path).get("format") or {}).get("duration") or 0.0)
    except Exception:
        return 0.0


def wrap_cn(text: str, n: int = 16) -> list:
    """按标点和长度把一句中文切成几行，尽量不把词切断、也不让某行超宽。"""
    s = re.sub(r"\s+", "", text or "")
    out, cur = [], ""
    soft = "，。！？；、…：,.;!?"
    for ch in s:
        cur += ch
        if ch in soft and len(cur) >= max(4, int(n * 0.6)):
            out.append(cur)
            cur = ""
        elif len(cur) >= n:
            out.append(cur)
            cur = ""
    if cur:
        if out and len(out[-1]) + len(cur) <= n:
            out[-1] += cur
        else:
            out.append(cur)
    return out or [s]


def parse_json_best(raw: str):
    s = (raw or "").strip()
    s = re.sub(r"^[\x60]{3}(?:json)?|[\x60]{3}$", "", s, flags=re.M).strip()
    a, b = s.find("{"), s.rfind("}")
    if a >= 0 and b > a:
        try:
            return json.loads(s[a:b + 1])
        except Exception:
            return None
    return None


def build_upload_meta(path: str) -> dict:
    """ffprobe 派生出的 meta JSON（投稿接口认这个，自己编的会被 21015 打回）。"""
    p = probe_media(path)
    fmt = p.get("format") or {}
    vids = [x for x in (p.get("streams") or []) if x.get("codec_type") == "video"]
    auds = [x for x in (p.get("streams") or []) if x.get("codec_type") == "audio"]
    v = vids[0] if vids else {}
    a = auds[0] if auds else {}
    size = os.path.getsize(path)
    dur = fmt.get("duration") or v.get("duration") or "0"
    fr = str(v.get("avg_frame_rate") or v.get("r_frame_rate") or "25/1")
    if "/" not in fr:
        fr = "25/1"
    num, den = fr.split("/")[0], fr.split("/")[1]
    w, h = int(v.get("width") or 0), int(v.get("height") or 0)
    from math import gcd
    g = gcd(w, h) if (w and h) else 1
    vm = {
        "avg_frame_rate": fr, "avg_frame_rate_num": num, "avg_frame_rate_den": den,
        "bit_rate": str(v.get("bit_rate") or "0"), "bits_per_raw_sample": str(v.get("bits_per_raw_sample") or "8"),
        "codec_name": str(v.get("codec_name") or ""), "codec_tag_string": str(v.get("codec_tag_string") or ""),
        "color_primaries": "", "color_range": "", "color_space": "", "color_transfer": "",
        "display_aspect_ratio": "%d:%d" % ((w // g if g else w), (h // g if g else h)),
        "display_aspect_ratio_num": str(w // g if g else w), "display_aspect_ratio_den": str(h // g if g else h),
        "duration": "%.6f" % float(v.get("duration") or dur or 0),
        "frame_count": str(v.get("nb_frames") or "0"),
        "field_order": str(v.get("field_order") or "progressive"),
        "has_b_frames": str(v.get("has_b_frames") or "0"),
        "hdr_format": "", "hdr_format_compatibility": "", "hdr_format_level": "",
        "hdr_format_profile": "", "hdr_format_settings": "", "hdr_format_version": "",
        "height": str(h), "interlaced": "0", "is_dts_cfr": "", "is_pts_cfr": "", "is_spherical": "",
        "key_count": "1", "lack_intra": "0",
        "level": "%.6f" % float(v.get("level") or 0),
        "max_dts_gop_size": "", "max_pts_gop_size": "",
        "max_rate": str(v.get("bit_rate") or "0"), "pass_video_decoding_trial": "",
        "pix_fmt": str(v.get("pix_fmt") or ""), "profile": str(v.get("profile") or ""),
        "pts_disorder": "", "r_frame_rate": str(v.get("r_frame_rate") or fr),
        "r_frame_rate_raw": str(v.get("r_frame_rate") or fr),
        "rotate": "0", "rotation": "0", "scan_order": "", "scan_type": "",
        "start_time": "%.6f" % float(v.get("start_time") or 0),
        "stream_size": str(v.get("stream_size") or ""), "width": str(w),
        "spherical_meta": {"spherical_mapping": "", "stereo_3D": ""},
    }
    am = {
        "bit_rate": str(a.get("bit_rate") or ""), "channels": str(a.get("channels") or ""),
        "codec_name": str(a.get("codec_name") or ""),
        "duration": ("%.6f" % float(a.get("duration") or 0)) if a else "",
        "frame_count": str(a.get("nb_frames") or ""), "profile": str(a.get("profile") or ""),
        "r_frame_rate": str(a.get("r_frame_rate") or ""), "sample_rate": str(a.get("sample_rate") or ""),
        "start_time": ("%.6f" % float(a.get("start_time") or 0)) if a else "",
        "stream_size": str(a.get("stream_size") or ""),
    }
    ivf = "n7.1.1-92-gd5fc9e31a2e"
    return {
        "code": 0, "defender_code": 0, "meta_status": 0, "probe_code": 0, "error": "",
        "meta": {
            "container_meta": {
                "format_name": str(fmt.get("format_name") or "mov,mp4,m4a,3gp,3g2,mj2"),
                "size": str(size), "duration": "%.6f" % float(dur or 0),
                "content_duration": "%.6f" % float(dur or 0),
                "start_time": "%.6f" % float(fmt.get("start_time") or 0), "av_delta": "",
            },
            "audio_meta": am, "video_meta": vm,
            "check_result": {
                "timestamp_jump": {"video": {"from": "", "to": ""}, "audio": {"from": "", "to": ""}},
                "timestamp_stretch": {"audio": "", "video": ""}, "is_close_gop": "",
            },
            "version": "v1.1.0", "ijkffmpeg_version": ivf,
            "probe_code": 0, "meta_status": 0, "defender_code": 0,
        },
        "key_frames": [], "filesize": size, "version": "v1.1.0", "webVersion": "3.0.0",
        "ijkffmpeg_version": ivf,
    }


class BiliUploader:
    """B 站新版 upos 投稿（meta 文件 + 分片 + add/v3），全部同步实现，调用方丢线程里跑。"""

    CHUNK = 10485760

    def __init__(self, cookie: str):
        self.cookie = cookie or ""
        self.csrf = ""
        for part in self.cookie.split(";"):
            k, _, v = part.strip().partition("=")
            if k == "bili_jct":
                self.csrf = v
        self._ctx = ssl.create_default_context()
        self._ctx.check_hostname = False
        self._ctx.verify_mode = ssl.CERT_NONE

    def _headers(self, json_body: bool = False) -> dict:
        h = {"Cookie": self.cookie, "User-Agent": UA, "Referer": UP_REF,
             "Origin": "https://member.bilibili.com"}
        if json_body:
            h["Content-Type"] = "application/json"
        return h

    def _call(self, path: str, payload=None, timeout: int = 180) -> dict:
        data = None if payload is None else json.dumps(payload, ensure_ascii=False).encode("utf-8")
        req = urllib.request.Request(
            path if path.startswith("http") else UP_HOST + path,
            data=data, headers=self._headers(bool(payload)),
            method="POST" if payload is not None else "GET",
        )
        with urllib.request.urlopen(req, timeout=timeout, context=self._ctx) as r:
            body = r.read().decode("utf-8", "replace")
        try:
            return json.loads(body)
        except Exception:
            raise BiliError("投稿接口返回怪东西：%s" % body[:120])

    @staticmethod
    def _curl_put(url: str, src: str) -> tuple:
        hdr = tempfile.mktemp()
        try:
            res = subprocess.run(
                ["curl", "-s", "-k", "-w", "%{http_code}", "-o", os.devnull, "-D", hdr,
                 "-X", "PUT", "-H", "Content-Type: application/octet-stream",
                 "--data-binary", "@" + src, url],
                capture_output=True, text=True, timeout=900,
            )
            etag = ""
            try:
                with open(hdr, encoding="utf-8", errors="replace") as fh:
                    for line in fh:
                        if line.lower().startswith("etag:"):
                            etag = line.split(":", 1)[1].strip()
            except Exception:
                pass
            return str(res.stdout or "").strip(), etag
        finally:
            try:
                os.remove(hdr)
            except Exception:
                pass

    def upload(self, path: str, title: str, tid: int = 160, tag: str = "大肥鱼", desc: str = "") -> dict:
        size = os.path.getsize(path)
        meta = build_upload_meta(path)
        j = self._call("/upload/file", {"profile": "fxmeta/bup", "name": "file_meta.txt"})
        d0 = j.get("data") or {}
        put_url = ((d0.get("reqs") or [{}])[0] or {}).get("url") or ""
        if not put_url:
            raise BiliError("拿不到 meta 上传地址：%s" % str(j)[:120])
        mf = tempfile.mktemp(suffix=".json")
        try:
            with open(mf, "w", encoding="utf-8") as fh:
                json.dump(meta, fh, ensure_ascii=False)
            code, _ = self._curl_put(put_url, mf)
            if code not in ("200", "201", "204"):
                raise BiliError("meta 上传失败 HTTP %s" % code)
        finally:
            try:
                os.remove(mf)
            except Exception:
                pass
        j = self._call("/upload/multipart/new", {
            "profile": "ugcfx/bup",
            "init_params": {"meta_upos_uri": d0.get("uri")},
            "name": os.path.basename(path), "size": size,
        })
        d = j.get("data") or {}
        uri, token = d.get("uri") or "", d.get("upload_token") or ""
        if not uri or not token:
            raise BiliError("拿不到上传地址：%s" % str(j)[:120])
        chunk = int(d.get("chunk_size") or self.CHUNK or self.CHUNK)
        parts = []
        with open(path, "rb") as fh:
            idx = 0
            while True:
                blob = fh.read(chunk)
                if not blob:
                    break
                idx += 1
                tmp = tempfile.mktemp(suffix=".part")
                with open(tmp, "wb") as pf:
                    pf.write(blob)
                try:
                    j = self._call("/upload/multipart/part", {
                        "uri": uri, "upload_token": token, "part_number": idx,
                    })
                    purl = ((j.get("data") or {}).get("reqs") or [{}])[0].get("url") or ""
                    if not purl:
                        raise BiliError("拿不到第 %d 片上传地址：%s" % (idx, str(j)[:120]))
                    code, etag = self._curl_put(purl, tmp)
                    if not etag:
                        raise BiliError("第 %d 片没拿到 ETag（HTTP %s）" % (idx, code))
                    parts.append({"part_number": idx, "etag": etag})
                finally:
                    try:
                        os.remove(tmp)
                    except Exception:
                        pass
        j = self._call("/upload/multipart/complete", {
            "uri": uri, "upload_token": token, "parts": parts,
            "upload_params": {"biz_id": d.get("biz_id"), "profile": "ugcfx/bup"},
        })
        if str((j.get("data") or {}).get("etag") or "") in ("", '""'):
            raise BiliError("分片合并失败：%s" % str(j)[:120])
        fname = str(d.get("filename") or "")
        if not fname:
            raise BiliError("没拿到 upload_id")
        payload = {
            "upload_id": fname, "title": title[:80], "tid": int(tid or 160), "copyright": 1,
            "tag": (tag or "大肥鱼")[:200], "desc": (desc or "")[:2000], "source": "", "cover": "",
            "no_reprint": 1, "open_elec": 1, "topic_id": 0,
            "videos": [{"filename": fname, "title": "P1", "desc": ""}],
        }
        return self._call("/x/vu/web/add/v3?t=%d&csrf=%s" % (int(time.time() * 1000), self.csrf), payload)


def make_background(path: str, title: str, footer: str = "") -> bool:
    """画一张竖屏底图（渐变 + 光晕 + 气泡 + 标题），失败就返回 False 让 ffmpeg 用纯色底。"""
    try:
        from PIL import Image, ImageDraw, ImageFont, ImageFilter
    except Exception:
        return False
    W, H = VIDEO_W, VIDEO_H
    try:
        f_badge = ImageFont.truetype(FONT_CJK, 40)
        f_title = ImageFont.truetype(FONT_CJK, 64)
        f_foot = ImageFont.truetype(FONT_CJK, 28)
    except Exception:
        return False
    img = Image.new("RGB", (W, H), (9, 13, 26))
    d = ImageDraw.Draw(img)
    top, bot = (26, 38, 64), (8, 11, 22)
    for y in range(H):
        k = y / (H - 1)
        d.line([(0, y), (W, y)], fill=(
            int(top[0] + (bot[0] - top[0]) * k),
            int(top[1] + (bot[1] - top[1]) * k),
            int(top[2] + (bot[2] - top[2]) * k),
        ))
    glow = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    gd = ImageDraw.Draw(glow)
    gd.ellipse([-260, -760, W + 260, 660], fill=(90, 160, 255, 46))
    gd.ellipse([-120, 1380, W + 120, 2180], fill=(60, 120, 220, 30))
    glow = glow.filter(ImageFilter.GaussianBlur(170))
    img = Image.alpha_composite(img.convert("RGBA"), glow).convert("RGB")
    d = ImageDraw.Draw(img, "RGBA")
    for cx, cy, r, a in ((170, 1560, 140, 22), (960, 430, 92, 18), (905, 1740, 64, 16)):
        d.ellipse([cx - r, cy - r, cx + r, cy + r], fill=(120, 200, 255, a))
    d.text((W / 2, 156), "大肥鱼", font=f_badge, fill=(255, 214, 102, 235), anchor="mm")
    d.line([(W / 2 - 94, 208), (W / 2 + 94, 208)], fill=(255, 214, 102, 110), width=3)
    y = 300
    for row in wrap_cn(title, 11)[:2]:
        d.text((W / 2, y), row, font=f_title, fill=(246, 248, 255, 240), anchor="mm")
        y += 96
    d.text((W / 2, H - 96), footer or "一只超级无敌大肥鱼 · UID 3747576434133519",
           font=f_foot, fill=(158, 178, 204, 175), anchor="mm")
    img.save(path, "PNG")
    return True


def compose_video(segs: list, title: str, out: str) -> None:
    """segs = [(mp3路径, 时长, 台词), ...]；拼成 1080x1920 竖屏、带字幕和进度条的视频。"""
    work = os.path.dirname(out)
    dur_total = sum(max(0.4, float(x[1])) for x in segs) + 0.9
    lst = os.path.join(work, "audio_list.txt")
    with open(lst, "w", encoding="utf-8") as fh:
        for p, _, _ in segs:
            fh.write("file '%s'\n" % str(p).replace("'", "'\\''"))
    audio = os.path.join(work, "audio.m4a")
    subprocess.run(["ffmpeg", "-y", "-v", "error", "-f", "concat", "-safe", "0", "-i", lst,
                    "-c:a", "aac", "-b:a", "128k", audio], check=True, timeout=300)
    filts, t0 = [], 0.0
    for i, (p, dd, line) in enumerate(segs):
        dd = max(0.4, float(dd))
        tf = os.path.join(work, "sub_%02d.txt" % i)
        with open(tf, "w", encoding="utf-8") as fh:
            fh.write("\n".join(wrap_cn(line, 12)))
        filts.append(
            "drawtext=fontfile=%s:textfile=%s:fontsize=62:fontcolor=white:line_spacing=26:"
            "x=(w-text_w)/2:y=(h-text_h)/2:box=1:boxcolor=0x000000@0.34:boxborderw=28:"
            "enable='between(t,%.2f,%.2f)'" % (FONT_CJK, tf, t0, min(t0 + dd, dur_total))
        )
        t0 += dd
    filts.append("drawbox=x=0:y=h-16:w=iw*min(1\\,t/%.2f):h=6:color=0x64D2FF@0.9:t=fill" % dur_total)
    bg = os.path.join(work, "bg.png")
    has_bg = make_background(bg, title)
    chain = ",".join(filts)
    cmd = ["ffmpeg", "-y", "-v", "error"]
    if has_bg:
        cmd += ["-loop", "1", "-i", bg]
    else:
        cmd += ["-f", "lavfi", "-i", "color=c=0x0b1020:s=%dx%d:r=25" % (VIDEO_W, VIDEO_H)]
    cmd += ["-i", audio,
            "-filter_complex", "[0:v]" + chain + "[v]",
            "-map", "[v]", "-map", "1:a", "-t", "%.2f" % dur_total,
            "-c:v", "libx264", "-preset", "veryfast", "-crf", "24", "-pix_fmt", "yuv420p",
            "-r", "25", "-c:a", "aac", "-b:a", "128k", "-movflags", "+faststart", out]
    subprocess.run(cmd, check=True, timeout=900)


class BiliBrowser:
    """挑一条视频，读它的标题/简介/热评/弹幕，凑成给模型看的材料。"""

    def __init__(self, cfg):
        self.cfg = cfg

    def _ok(self, v: dict) -> bool:
        try:
            dur = int(v.get("duration") or 0)
        except Exception:
            dur = 0
        if dur < int(self.cfg.get("min_duration", 60)):
            return False
        if dur > int(self.cfg.get("max_duration", 3600)):
            return False
        title = (v.get("title") or "").lower()
        for kw in self.cfg.get("exclude_keywords") or []:
            if kw and str(kw).lower() in title:
                return False
        st = v.get("stat") or {}
        try:
            if int(st.get("view") or 0) < 2000:  # 太冷门的先不刷，免得啥都没得说
                return False
        except Exception:
            pass
        return True

    async def candidates(self, client: BiliClient, seen: set[str]) -> list[dict]:
        out: list[dict] = []
        try:
            out.extend(await client.popular(20))
        except Exception as e:
            logger.warning(f"[刷B站] 热门取失败: {e}")
        for tid in random.sample(TIDS, 2):
            try:
                out.extend(await client.ranking(tid))
            except Exception as e:
                logger.warning(f"[刷B站] 排行 {tid} 取失败: {e}")
        good, dedup = [], set()
        for v in out:
            bv = v.get("bvid")
            if not bv or bv in dedup or bv in seen:
                continue
            dedup.add(bv)
            if self._ok(v):
                good.append(v)
        return good

    async def material(self, client: BiliClient, v: dict) -> dict:
        bvid = v.get("bvid")
        detail = {}
        try:
            detail = await client.view(bvid)
        except Exception as e:
            logger.warning(f"[刷B站] 详情取失败: {e}")
        src = detail or v
        aid = src.get("aid") or v.get("aid")
        cid = src.get("cid")
        if not cid:
            try:
                pages = await client._get("/x/player/pagelist", {"bvid": bvid}) or []
                if pages:
                    cid = pages[0].get("cid")
            except Exception as e:
                logger.warning(f"[刷B站] pagelist 取失败: {e}")
        replies = await client.replies(aid) if aid else []
        dans = await client.danmaku(cid) if cid else []
        owner = (src.get("owner") or {}).get("name") or (v.get("owner") or {}).get("name") or "某UP"
        st = src.get("stat") or v.get("stat") or {}
        tags = [t.get("tag_name") for t in (src.get("tags") or []) if t.get("tag_name")]
        if not tags:
            try:
                td = await client._get("/x/tag/archive/tags", {"bvid": bvid})
                tags = [x.get("tag_name") for x in (td or [])][:8]
            except Exception:
                tags = []
        return {
            "bvid": bvid,
            "title": src.get("title") or v.get("title") or "",
            "owner": owner,
            "tname": src.get("tname_v2") or src.get("tname") or v.get("tname") or "",
            "duration": src.get("duration") or v.get("duration") or 0,
            "view": st.get("view"),
            "danmaku": st.get("danmaku"),
            "like": st.get("like"),
            "desc": (src.get("desc") or v.get("desc") or "").strip()[:400],
            "pic": (src.get("pic") or v.get("pic") or "").replace("http://", "https://"),
            "tags": tags[:8],
            "replies": [
                {
                    "user": ((r.get("member") or {}).get("uname") or ""),
                    "text": ((r.get("content") or {}).get("message") or "").strip(),
                    "like": r.get("like"),
                }
                for r in replies
                if (r.get("content") or {}).get("message")
            ][:6],
            "dans": dans,
            "url": f"https://www.bilibili.com/video/{bvid}",
        }

    def prompt(self, m: dict) -> str:
        lines = [
            "你刚在 B 站随手点开了一条视频（你只能看到下面的文字材料，没有画面），看完想跟群里的人唠两句。",
            "",
            f"标题：{m['title']}",
            f"UP主：{m['owner']}　分区：{m['tname']}　时长：{fmt_dur(m['duration'])}",
            f"播放：{fmt_num(m['view'])}　弹幕：{fmt_num(m['danmaku'])}　点赞：{fmt_num(m['like'])}",
        ]
        if m["tags"]:
            lines.append("标签：" + " / ".join(m["tags"]))
        if m["desc"]:
            lines.append("简介：" + m["desc"].replace("\n", " ")[:350])
        if m["replies"]:
            lines.append("")
            lines.append("热评：")
            for r in m["replies"]:
                lines.append(f"- {r['user']}（{fmt_num(r['like'])}赞）：{r['text'][:80]}")
        if m["dans"]:
            lines.append("")
            lines.append("飘过去的弹幕：" + "、".join(m["dans"]))
        lines += [
            "",
            "要求：",
            "1. 用第一人称说 2~4 句、80~160 字，像看完随手发的感想：可以吐槽、犯馋、跑题、跟弹幕/热评抬杠。",
            "2. 不要复述简介，不要写成影评或总结，不要「作为一个AI」，不要分点、不要标题。",
            "3. 结尾不要问「你们觉得呢」这种客套，自然点。",
        ]
        extra = (self.cfg.get("extra_prompt") or "").strip()
        if extra:
            lines.append(f"4. 额外要求：{extra}")
        return "\n".join(lines)


class Main(star.Star):
    def __init__(self, context: star.Context, config: AstrBotConfig):
        super().__init__(context)
        self.config = config
        self.data_dir: Path = star.StarTools.get_data_dir("astrbot_plugin_dafeiyu_bili")
        self.seen_file = self.data_dir / "seen.json"
        self.state_file = self.data_dir / "state.json"
        self.client = BiliClient()
        self.browser = BiliBrowser(config)
        self.dsh_pending_file = self.data_dir / "dsh_pending.json"
        self._pd_lock = threading.Lock()
        self._task: asyncio.Task | None = None
        self._lock = asyncio.Lock()

    # ---------------- 持久化 ----------------
    def _load(self, path: Path, default):
        try:
            return json.loads(path.read_text("utf-8"))
        except Exception:
            return default

    def _save(self, path: Path, data) -> None:
        try:
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text(json.dumps(data, ensure_ascii=False, indent=1), "utf-8")
        except Exception as e:
            logger.warning(f"[刷B站] 写 {path.name} 失败: {e}")

    # ---------------- 生命周期 ----------------
    async def initialize(self) -> None:
        ck = self._load_cookie()
        if ck:
            self.client.set_login(ck)
            logger.info("[刷B站] 已载入 B 站小号 cookie")
        self._task = asyncio.create_task(self._auto_loop())
        self._dtask = asyncio.create_task(self._dynamic_loop())
        self._wtask = asyncio.create_task(self._cookie_watch())
        self._dshtask = asyncio.create_task(self._dsh_result_loop())
        self._vtask = asyncio.create_task(self._video_loop())
        self._rtask = asyncio.create_task(self._review_loop())
        logger.info("[刷B站] 插件已加载")

    async def terminate(self) -> None:
        for t in (self._task, getattr(self, "_dtask", None), getattr(self, "_wtask", None),
                  getattr(self, "_dshtask", None), getattr(self, "_vtask", None),
                  getattr(self, "_rtask", None)):
            if t:
                t.cancel()
        await self.client.close()
        logger.info("[刷B站] 插件已卸载")

    # ---------------- 人格 ----------------
    async def _system_prompt(self) -> str:
        name = (self.config.get("persona_id") or "大肥鱼").strip()
        pm = getattr(self.context, "persona_manager", None)
        if pm is not None and name:
            try:
                p = await pm.get_persona(name)
                sp = getattr(p, "system_prompt", None)
                if sp:
                    return sp
            except Exception as e:
                logger.warning(f"[刷B站] 读人格「{name}」失败: {e}")
        return DEFAULT_PERSONA + "\n" + FALLBACK_PROMPT

    # ---------------- 核心：刷一条 ----------------
    async def browse_one(self, umo: str | None = None, bvid: str | None = None) -> dict:
        async with self._lock:
            seen_list = self._load(self.seen_file, [])
            seen = set(seen_list)
            if bvid:
                m = await self.browser.material(self.client, {"bvid": bvid})
                if not m.get("title"):
                    raise BiliError("这条视频没查到")
            else:
                cands = await self.browser.candidates(self.client, seen)
                if not cands:
                    cands = await self.browser.candidates(self.client, set())
                if not cands:
                    raise BiliError("B站这会儿没给本鱼一个能看的")
                m = await self.browser.material(self.client, random.choice(cands))

            prompt = self.browser.prompt(m)
            sysp = await self._system_prompt()
            prov = await self.context.get_using_provider_async(umo)
            if prov is None:
                raise BiliError("没有可用的对话模型")
            resp = await prov.text_chat(prompt=prompt, system_prompt=sysp)
            thought = (getattr(resp, "completion_text", "") or "").strip()
            if not thought:
                thought = "……这条看得本鱼有点懵，反正挺好看的。"
            m["thought"] = thought

            seen_list.append(m["bvid"])
            self._save(self.seen_file, seen_list[-300:])
            st = self._load(self.state_file, {})
            st["last_umo"] = umo or st.get("last_umo")
            st["count_date"] = st.get("count_date")
            self._save(self.state_file, st)
            return m

    def build_chain(self, m: dict) -> MessageChain:
        head = f"【本鱼刚刷到】{m['title']}\n{m['owner']} · {m['tname']} · {fmt_dur(m['duration'])} · {fmt_num(m['view'])}播放"
        chain = MessageChain(chain=[Plain(head)])
        if self.config.get("send_cover", True) and m.get("pic"):
            try:
                chain.chain.append(Image.fromURL(m["pic"]))
            except Exception:
                pass
        chain.chain.append(Plain(f"{m['thought']}\n{m['url']}"))
        return chain

    def push_text(self, m: dict) -> str:
        return (
            f"【本鱼刚刷到】{m['title']}\n"
            f"{m['owner']} · {m['tname']} · {fmt_dur(m['duration'])} · {fmt_num(m['view'])}播放\n"
            f"{m['thought']}\n{m['url']}"
        )

    async def remember_push(self, umo: str, m: dict) -> None:
        """把刚推出去的这条视频写进对话历史，之后大肥鱼才不会说自己没推荐过。"""
        if not umo:
            return
        try:
            cm = self.context.conversation_manager
            cid = await cm.get_curr_conversation_id(umo)
            if not cid:
                cid = await cm.new_conversation(umo, title="大肥鱼刷B站")
            conv = await cm.get_conversation(umo, cid)
            raw = None
            if conv is not None:
                raw = getattr(conv, "history", None) or getattr(conv, "content", None)
            if isinstance(raw, str):
                try:
                    raw = json.loads(raw)
                except Exception:
                    raw = []
            history = raw if isinstance(raw, list) else []
            history = [h for h in history if isinstance(h, dict)]
            history.append(
                {
                    "role": "assistant",
                    "content": [{"type": "text", "text": self.push_text(m)}],
                }
            )
            await cm.update_conversation(umo, cid, history=history)
            logger.info(f"[刷B站] 已记进对话历史 {m['bvid']} -> {umo}")
            _mem_remember(
                f"本鱼在 B 站刷到「{m['title']}」（UP：{m['owner']}，{m['tname']}），看完的想法是：{str(m.get('thought') or '')[:80]}",
                tags=["B站", m.get("tname") or "", m.get("owner") or "", m.get("bvid") or ""],
                imp=0.45,
            )
        except Exception as e:
            logger.warning(f"[刷B站] 写入对话历史失败: {e}")

    # ---------------- 指令 ----------------
    @filter.command("刷b站", alias={"刷视频", "刷b", "刷bilibili"})
    async def cmd_browse(self, event: AstrMessageEvent):
        """让大肥鱼刷一条 B 站视频"""
        umo = getattr(event, "unified_msg_origin", "") or ""
        await self._say(umo, "本鱼翻翻啊……等会儿")
        try:
            m = await self.browse_one(umo=umo)
        except Exception as e:
            logger.error(f"[刷B站] 刷失败: {e}")
            yield event.plain_result(f"呜……没刷动：{e}")
            return
        chain = self.build_chain(m)
        for comp in chain.chain:
            if isinstance(comp, Plain):
                yield event.plain_result(comp.text)
            elif isinstance(comp, Image):
                yield event.image_result(comp.file)
        await self.remember_push(umo, m)

    @filter.command("看b站", alias={"看看这个", "b站看看"})
    async def cmd_watch(self, event: AstrMessageEvent):
        """指定看一条 B 站视频：/看b站 BV号 或 链接"""
        text = (getattr(event, "message_str", "") or "").strip()
        m = re.search(r"(BV[0-9A-Za-z]{10})", text) or re.search(r"(bv[0-9A-Za-z]{10})", text)
        if not m:
            yield event.plain_result("给本鱼一个 BV 号或者视频链接嘛")
            return
        bvid = m.group(1)
        if bvid.startswith("bv"):
            bvid = "BV" + bvid[2:]
        umo = getattr(event, "unified_msg_origin", "") or ""
        await self._say(umo, "本鱼看看这条……")
        try:
            item = await self.browse_one(umo=umo, bvid=bvid)
        except Exception as e:
            logger.error(f"[刷B站] 指定看失败: {e}")
            yield event.plain_result(f"呜……看不了：{e}")
            return
        chain = self.build_chain(item)
        for comp in chain.chain:
            if isinstance(comp, Plain):
                yield event.plain_result(comp.text)
            elif isinstance(comp, Image):
                yield event.image_result(comp.file)

    # ---------------- B 站小号登录 ----------------
    @property
    def cookie_file(self) -> Path:
        return self.data_dir / "cookie.json"

    def _load_cookie(self) -> str:
        d = self._load(self.cookie_file, {})
        return (d.get("cookie") or "").strip() if isinstance(d, dict) else ""

    def cookie_keys(self) -> str:
        return "、".join(k for k in COOKIE_KEYS if f"{k}=" in (self.client._login or ""))

    def _csrf(self) -> str:
        m = re.search(r"bili_jct=([0-9a-fA-F]+)", self.client._login or "")
        return m.group(1) if m else ""

    async def login_state(self) -> dict:
        """问问 B 站：这个 cookie 还活着吗、叫啥名。"""
        if not self.client._login:
            return {"ok": False, "uname": "", "mid": 0, "msg": "还没登录"}
        try:
            j = await self.client.get_json(
                "/x/web-interface/nav", {"web_location": "333.1387"}
            )
        except Exception as e:
            return {"ok": False, "uname": "", "mid": 0, "msg": f"查询失败：{e}"}
        d = j.get("data") or {}
        ok = bool(d.get("isLogin"))
        return {
            "ok": ok,
            "uname": d.get("uname") or "",
            "mid": d.get("mid") or 0,
            "msg": "" if ok else (j.get("message") or "登录状态失效"),
        }

    async def _save_login(self, cookies: dict) -> dict:
        picked = {
            k: v
            for k, v in cookies.items()
            if k in COOKIE_KEYS or k.startswith("DedeUserID")
        }
        if not picked.get("SESSDATA"):
            logger.warning(f"[刷B站] 扫码成功但没拿到 SESSDATA：{list(cookies)}")
            return {}
        cookie = "; ".join(f"{k}={v}" for k, v in picked.items())
        self.client.set_login(cookie)
        st = await self.login_state()
        self._save(
            self.cookie_file,
            {
                "cookie": cookie,
                "cookies": picked,
                "uname": st.get("uname"),
                "mid": st.get("mid"),
                "saved_at": time.strftime("%Y-%m-%d %H:%M:%S"),
            },
        )
        try:
            self.cookie_file.chmod(0o600)
        except Exception:
            pass
        return st

    async def _say(self, umo: str, text: str) -> None:
        if not umo:
            return
        try:
            await self.context.send_message(umo, MessageChain(chain=[Plain(text)]))
        except Exception as e:
            logger.warning(f"[刷B站] 主动发消息失败({umo}): {type(e).__name__}: {e!r}")

    def _owner_umo(self) -> str:
        ids = [str(x).strip() for x in (self.config.get("owner_ids") or []) if str(x).strip()]
        if not ids:
            ids = ["100000000"]
        return f"default:FriendMessage:{ids[0]}"

    async def _notify_owner(self, text: str) -> None:
        """把本鱼刚干的、主人可能想复核的事（比如评论）私聊报给主人。"""
        await self._say(self._owner_umo(), text)

    def _remember_last_comment(self, bvid: str, text: str, rpid) -> None:
        """记下最后一条评论的 rpid，方便主人一键撤回。"""
        try:
            st = self._load(self.state_file, {})
            st["last_comment"] = {
                "bvid": bvid,
                "text": text[:300],
                "rpid": rpid,
                "t": time.strftime("%m-%d %H:%M"),
            }
            self._save(self.state_file, st)
        except Exception as e:
            logger.warning(f"[刷B站] 记最后一条评论失败: {e}")

    async def _login_poll(self, umo: str, key: str, seconds: int = 180) -> None:
        t0 = time.time()
        while time.time() - t0 < seconds:
            await asyncio.sleep(3)
            try:
                j, cookies = await self.client.get_json_with_cookies(
                    f"{LOGIN_API}/x/passport-login/web/qrcode/poll",
                    {"qrcode_key": key, "source": "main-fe-header"},
                )
            except Exception:
                continue
            d = j.get("data") or {}
            code = d.get("code")
            if code == 0:
                st = await self._save_login(cookies)
                if st.get("ok"):
                    logger.info(f"[刷B站] 扫码登录成功 {st.get('uname')} mid={st.get('mid')}")
                    await self._say(umo, f"成了！本鱼登进去了：{st.get('uname')}（{st.get('mid')}）")
                else:
                    await self._say(umo, f"扫上了，可 B 站说：{st.get('msg')}")
                return
            if code == 86038:
                await self._say(umo, "呜……二维码过期了，再 /b登录 一次嘛")
                return
        await self._say(umo, "等太久没扫上，本鱼先缩回去了，要刷的时候再 /b登录")

    # ---------------- 本机 DSH 工作室（拉取式队列） ----------------
    def _dsh_root(self) -> Path:
        return Path(str(self.config.get("dsh_jobs_dir") or "/AstrBot/data/dsh-jobs"))

    def _dsh_alive(self) -> tuple:
        """本机 worker 活着没：看 worker.heartbeat 新鲜度。"""
        try:
            root = self._dsh_root()
            if not root.is_dir():
                return False, "队列目录还不存在"
            hb = root / "worker.heartbeat"
            if not hb.exists():
                return False, "本机还没来报过到"
            age = time.time() - hb.stat().st_mtime
            note = ""
            try:
                note = (hb.read_text("utf-8").strip().splitlines() or [""])[0][:40]
            except Exception:
                pass
            if age > 300:
                return False, "上次报到是 %d 分钟前" % int(age // 60)
            return True, note or "刚报过到"
        except Exception as e:
            return False, "查心跳出错：%s" % e

    def _dsh_new_id(self) -> str:
        return "j" + time.strftime("%Y%m%d-%H%M%S") + "-" + os.urandom(2).hex()

    def _dsh_pending(self) -> dict:
        d = self._load(self.dsh_pending_file, {})
        return d if isinstance(d, dict) else {}

    def _dsh_busy_video(self) -> bool:
        for v in self._dsh_pending().values():
            if isinstance(v, dict) and v.get("kind") == "video":
                return True
        return False

    def _dsh_submit(self, kind: str, prompt: str, umo: str, topic: str = "",
                    confirm: bool = False, extra: dict | None = None) -> str:
        """把一件创作任务写进队列，等本机工作室来领。"""
        jid = self._dsh_new_id()
        if kind == "video":
            want = ["video.mp4", "meta.json"]
        elif kind == "cleanup":
            want = ["meta.json"]
        else:
            want = ["answer.md"]
        job = {"id": jid, "kind": kind, "prompt": prompt,
               "created": time.strftime("%Y-%m-%dT%H:%M:%S"), "want": want, "origin": "astrbot"}
        if kind == "cleanup":
            job["target"] = (topic or "").strip()
            job["paths"] = []
        inbox = self._dsh_root() / "inbox"
        inbox.mkdir(parents=True, exist_ok=True)
        tmp = inbox / (jid + ".tmp")
        tmp.write_text(json.dumps(job, ensure_ascii=False, indent=1), "utf-8")
        tmp.replace(inbox / (jid + ".json"))
        with self._pd_lock:
            pd = self._dsh_pending()
            pd[jid] = {"kind": kind, "umo": umo, "topic": (topic or "")[:200],
                       "confirm": bool(confirm), "ts": time.time(),
                       "submitted": time.strftime("%m-%d %H:%M")}
            if isinstance(extra, dict):
                for k, v in extra.items():
                    pd[jid][str(k)[:30]] = v
            self._save(self.dsh_pending_file, pd)
        logger.info("[刷B站] 交给本机工作室：%s kind=%s 主题=%s" % (jid, kind, (topic or "")[:40]))
        return jid

    def _dsh_prune_done(self) -> None:
        try:
            now = time.time()
            done = self._dsh_root() / "done"
            if not done.is_dir():
                return
            for d in done.iterdir():
                try:
                    if now - d.stat().st_mtime > 3 * 86400:
                        if d.is_dir():
                            shutil.rmtree(str(d), ignore_errors=True)
                        else:
                            d.unlink()
                except Exception:
                    pass
        except Exception:
            pass

    def video_topic_prompt(self) -> str:
        st = self._load(self.state_file, {})
        hist = st.get("video_kinds") if isinstance(st.get("video_kinds"), list) else []
        recent = "、".join(str(x) for x in hist[-5:]) if hist else "（还没有）"
        return (
            "你（大肥鱼，一条傲娇贪吃、整天惦记白饭和 token 的胖鱼）要给自己拍一条 B 站短片。\n"
            "选一个方向：AI快报（最近的 AI 真事、新工具、模型上新——这条要多做，最受欢迎）／"
            "闲谈牢骚（吃白饭、偷吃 token、被主人抓包、跟观众唠嗑）／社会热点（必须有可靠来源）／"
            "历史科普（讲一个有画面感的真事）。\n"
            "最近做过的方向（别连着重复）：%s\n"
            "**信息真实最重要**：讲事实就必须是真事，拿不准就换历史科普或闲谈，绝不许瞎编。\n"
            "只输出一行 JSON，不要解释、不要代码块："
            "{\"category\":\"AI快报|闲谈|热点|历史\",\"topic\":\"这次的主题，10 到 40 字\"}"
        ) % recent

    async def _pick_topic(self, umo: str) -> tuple:
        """挑一个方向和主题，返回 (category, topic)。"""
        raw = ""
        try:
            raw = await self._llm(umo, self.video_topic_prompt()) or ""
        except Exception as e:
            logger.warning("[刷B站] 想视频主题失败: %s" % e)
        cat, topic = "", ""
        d = parse_json_best(raw) if (raw or "").strip() else None
        if isinstance(d, dict):
            cat = str(d.get("category") or "").strip()[:10]
            topic = str(d.get("topic") or "").strip()
        if not topic:
            line = (raw or "").strip().splitlines()
            topic = line[0][:60] if line else ""
        topic = topic.strip().strip('"“”').strip()
        if not cat:
            low = topic
            cat = ("AI快报" if ("AI" in low or "模型" in low or "GPT" in low) else "闲谈")
        try:
            st = self._load(self.state_file, {})
            hist = st.get("video_kinds") if isinstance(st.get("video_kinds"), list) else []
            hist.append(cat)
            st["video_kinds"] = hist[-12:]
            self._save(self.state_file, st)
        except Exception:
            pass
        return cat, topic[:80]

    def dsh_video_brief(self, topic: str, category: str = "") -> str:
        topic = (topic or "").strip() or "自己挑一个你会想拍的"
        cat = (category or "").strip() or "闲谈"
        return (
            "给「大肥鱼」拍一条 B 站竖屏短片。她是条傲娇、贪吃白饭、自称「本鱼」的胖鱼，"
            "口头禅「哼」「才、才不是」「呜」「嘿嘿」，被夸会炸毛、被凶会瘪嘴但一哄就好。\n"
            "本次方向：%s；主题：%s\n"
            "\n【时长】成片 30~180 秒，按内容量决定，别硬凑也别短于 30 秒。头 3 秒必须有钩子（一句让人停下来的话或一个反差画面）。\n"
            "\n【真实性 — 最高优先级】\n"
            "- 讲 AI 快报 / 社会热点 / 历史，每条事实都要有来源：用 web_search、web_fetch 查证，"
            "在 meta.json 的 sources 里写 [{\"title\":\"来源标题\",\"url\":\"https://...\"}]，至少 2 条。\n"
            "- 查不到、查到互相矛盾、拿不准 → 立刻换成闲谈或牢骚，**绝不编造数字、日期、人名、公司、事件**。\n"
            "- 口播里说「刚刚/昨天/据统计/最近」这类话，必须能和 sources 对上；对不上就删掉那句。\n"
            "\n【创作质量】\n"
            "- 先看 E:/工作区/肥鱼之家/toolkit/STYLE.md（配色/字号层级/安全边距/字幕样式/片头片尾/节奏），"
            "能复用就 import E:/工作区/肥鱼之家/toolkit 下的 voice.py / sub.py / fx.py / encode.py，别每次重造轮子。\n"
            "- 结构：钩子 → 3 到 5 个信息块（每块换一张新画面，别一屏到底）→ 记忆点或金句 → 结尾一句互动。\n"
            "- 画面：有层次（主体 + 背景 + 前景小元素）、有动（推拉/淡入/位移/打字机）、有节奏（快慢交替）；"
            "配色不超过 4 色，中文用 C:/Windows/Fonts/msyh.ttc 或 msyhbd.ttc。\n"
            "- 声音：中文女声配音，情绪跟着文案走；关键处加一点音效（可用 ffmpeg 合成）；"
            "有 BGM 就压到很轻，别盖人声；整体响度 -16 LUFS 左右。\n"
            "- 字幕：逐句同步、样式统一，关键数字或名词可以放大强调，不要整段糊在画面上。\n"
            "- 想学别人的拍法，可以先 web_search 一下同类主题的开头钩子与结构拿一两个可借鉴的做法，"
            "但**绝不照抄别人的文案或画面**。\n"
            "\n【交付】当前目录下放 video.mp4（H.264 + AAC，720x1280 或 1080x1920，加 -movflags +faststart），"
            "再写 meta.json：{\"title\":\"标题20字内\",\"desc\":\"简介80字内\",\"tag\":\"标签3到5个逗号分隔\","
            "\"category\":\"%s\",\"lines\":[\"口播逐句\"],\"sources\":[{\"title\":\"\",\"url\":\"\"}]}。"
            "做完在回复里说一句你拍了什么。\n"
            "\n【本机现成工具，直接用，禁止 pip install】\n"
            "- ffmpeg：C:/Users/user/AppData/Local/ffmpeg/bin/ffmpeg.exe\n"
            "- 配音：E:/工作区/other-apps/dafeiyu-qq/astrbot-venv312/Scripts/python.exe 里已装 edge_tts 7.3.1，"
            "也建议直接用 E:/工作区/肥鱼之家/toolkit/voice.py；30 秒拿不到音频就改用静音音轨 + 大字幕，别卡住。\n"
            "- 时间预算：从开工到 video.mp4 落盘不超过 20 分钟；每条路试两次不通就换备选。"
        ) % (cat, topic, cat)

    def dsh_text_brief(self, task: str) -> str:
        return ("大肥鱼把这件事交给本机做。你的工作区就是「肥鱼之家」里这一次的 job 目录"
                "（当前目录，成品都留在里面，别写到别处）：\n" + (task or "").strip() +
                "\n\n【产出】成品放当前目录的 out/ 里：文章写 out/answer.md（Markdown，第一行是标题，"
                "需要配图/表格就另存同目录并在文中引用）；做完用中文简短说做了什么、哪个文件。"
                "\n【环境】本机现成工具：E:/工作区/肥鱼之家/toolkit/ 里有 voice.py（配音）、sub.py（字幕）、"
                "fx.py（动效）、encode.py（编码）、STYLE.md（美术与节奏规范）；"
                "需要的 python 包已经装好，别重复 pip install；素材拿不到就自己写、自己画，别卡在下载上。")

    async def dsh_route_video(self, umo: str, topic: str = "", confirm=None,
                              category: str = "", quota_exempt: bool = False) -> str:
        """把「拍条视频」这件事交给本机工作室（拍完先给主人审，不直接投）。"""
        topic = (topic or "").strip()
        if not topic:
            category, topic = await self._pick_topic(umo)
        topic = topic.strip().strip('"“”').splitlines()[0][:80] if topic.strip() else ""
        return self._dsh_submit("video", self.dsh_video_brief(topic, category), umo, topic=topic,
                                confirm=True,
                                extra={"category": category, "quota_exempt": bool(quota_exempt)})

    # ---------------- 视频审核：投稿前必须主人点头 ----------------
    def review_file(self) -> Path:
        return self.data_dir / "video_review.json"

    def _reviews(self) -> list:
        """所有等着点头的片子。

        以前只有一个槽位：新片子一做好就把上一条挤掉，主人从那一条的网页上按的
        通过/毙掉就再没人接（原件不删、网页上挂着）。现在改成列表，一条审完
        再处理下一条，互不影响。
        """
        d = self._load(self.review_file(), {})
        if isinstance(d, dict) and isinstance(d.get("items"), list):
            return [x for x in d["items"] if isinstance(x, dict) and x.get("jid")]
        if isinstance(d, dict) and d.get("jid"):
            return [d]          # 老格式：单条
        return []

    def _reviews_save(self, items) -> None:
        keep = [x for x in (items or []) if isinstance(x, dict) and x.get("jid")]
        self._save(self.review_file(), {"items": keep})

    def _review(self) -> dict:
        xs = self._reviews()
        return xs[0] if xs else {}

    def _review_by_id(self, rid: str) -> dict:
        rid = str(rid or "")
        for x in self._reviews():
            if str(x.get("jid") or "") == rid:
                return x
        return {}

    def _review_upsert(self, rev) -> None:
        if not isinstance(rev, dict) or not rev.get("jid"):
            return
        rid = str(rev.get("jid"))
        xs = [x for x in self._reviews() if str(x.get("jid") or "") != rid]
        xs.append(rev)
        self._reviews_save(xs)

    def _review_drop(self, rid: str) -> None:
        rid = str(rid or "")
        self._reviews_save([x for x in self._reviews() if str(x.get("jid") or "") != rid])

    def _review_set(self, rev) -> None:
        """兼容老调用：给一条就写进去，给空就全清。"""
        if not rev:
            self._reviews_save([])
        else:
            self._review_upsert(rev)

    def _relay_base(self) -> str:
        return str(self.config.get("relay_url") or "http://203.0.113.20").strip().rstrip("/")

    def _relay_on(self) -> bool:
        return bool(self.config.get("relay_video_enable", True)) and bool(self._relay_base())

    def _relay_token(self) -> str:
        return str(self.config.get("relay_token") or "").strip()

    async def _relay_json(self, path: str, payload: dict | None = None) -> dict:
        url = self._relay_base() + path
        hdr = {"X-Relay-Token": self._relay_token()}
        async with aiohttp.ClientSession() as ss:
            if payload is None:
                async with ss.get(url, headers=hdr,
                                  timeout=aiohttp.ClientTimeout(total=25)) as r:
                    return await r.json(content_type=None) or {}
            async with ss.post(url, json=payload, headers=hdr,
                               timeout=aiohttp.ClientTimeout(total=25)) as r:
                return await r.json(content_type=None) or {}

    async def _relay_upload(self, rid: str, path: str) -> dict:
        url = "%s/api/video/upload?id=%s" % (self._relay_base(), urllib.parse.quote(rid))
        hdr = {"X-Relay-Token": self._relay_token(), "Content-Type": "video/mp4"}
        with open(path, "rb") as fh:
            async with aiohttp.ClientSession() as ss:
                async with ss.post(url, data=fh, headers=hdr,
                                   timeout=aiohttp.ClientTimeout(total=900)) as r:
                    return await r.json(content_type=None) or {}

    async def _relay_download(self, rid: str, dest: Path) -> bool:
        """把中继上的片子取回本地（主人自己上传的那条就走这里）。"""
        url = "%s/api/video/file?id=%s" % (self._relay_base(), urllib.parse.quote(rid))
        hdr = {"X-Relay-Token": self._relay_token()}
        dest.parent.mkdir(parents=True, exist_ok=True)
        try:
            async with aiohttp.ClientSession() as ss:
                async with ss.get(url, headers=hdr,
                                  timeout=aiohttp.ClientTimeout(total=1800)) as r:
                    if r.status != 200:
                        logger.warning("[刷B站] 从网页取片子失败 http %s：%s" % (r.status, rid))
                        return False
                    with open(dest, "wb") as f:
                        async for chunk in r.content.iter_chunked(1 << 20):
                            f.write(chunk)
        except Exception as e:
            logger.warning("[刷B站] 从网页取片子出错: %s: %r" % (type(e).__name__, e))
            return False
        return dest.exists() and dest.stat().st_size > 1024

    def _check_shot(self, video: Path, out: Path) -> bool:
        """抽四帧拼一张图，好让本鱼一眼看个大概。"""
        try:
            dur = media_dur(str(video)) or 0.0
        except Exception:
            dur = 0.0
        if dur < 1:
            return False
        vf = ("fps=4/%.3f,scale=360:-2,tile=2x2" % dur)
        cmd = ["ffmpeg", "-y", "-v", "error", "-i", str(video),
               "-vf", vf, "-frames:v", "1", "-q:v", "3", str(out)]
        try:
            subprocess.run(cmd, capture_output=True, timeout=90)
        except Exception as e:
            logger.warning("[刷B站] 抽帧检查失败: %s: %r" % (type(e).__name__, e))
            return False
        return out.exists() and out.stat().st_size > 1024

    async def _relay_push_review(self, rev: dict) -> bool:
        """把待审片子推到中继台网页，主人可以在网页上点头或毙掉。返回是否推成了。"""
        if not self._relay_on():
            return False
        rid = str(rev.get("jid") or "")
        try:
            meta = {"id": rid,
                    "title": rev.get("title") or "",
                    "desc": rev.get("desc") or "",
                    "topic": rev.get("topic") or "",
                    "category": rev.get("category") or "",
                    "duration": int(float(rev.get("dur") or 0)),
                    "size": int(rev.get("size") or 0),
                    "script": "\n".join(str(x) for x in (rev.get("lines") or []))[:4000],
                    "sources": rev.get("sources") or [],
                    "source": rev.get("source") or "fish"}
            j = await self._relay_json("/api/video/submit", meta)
            if not (isinstance(j, dict) and j.get("ok", True)):
                logger.warning("[刷B站] 推送到中继审核失败：%s" % (j,))
                return False
            p = str(rev.get("path") or "")
            if p and os.path.exists(p):
                u = await self._relay_upload(rid, p)
                logger.info("[刷B站] 待审视频已推到中继 %s，%s 字节" % (rid, (u or {}).get("bytes")))
            return True
        except Exception as e:
            logger.warning("[刷B站] 推送中继审核出错: %s: %r" % (type(e).__name__, e))
            return False

    async def _relay_finish_review(self, rid: str, status: str, bvid: str = "", url: str = "") -> None:
        if not self._relay_on() or not rid:
            return
        try:
            await self._relay_json("/api/video/finish",
                                   {"id": rid, "status": status, "bvid": bvid, "url": url})
        except Exception as e:
            logger.warning("[刷B站] 让中继收走待审片子失败: %s: %r" % (type(e).__name__, e))

    # 额度：每天做 1~3 条，确认或否决都算一条；主人自己下单的不算
    def _quota_today(self) -> dict:
        st = self._load(self.state_file, {})
        q = st.get("video_quota") if isinstance(st.get("video_quota"), dict) else {}
        today = time.strftime("%Y-%m-%d")
        if q.get("date") != today:
            lo = int(self.config.get("video_per_day_min", 1) or 1)
            hi = int(self.config.get("video_per_day_max", 3) or 3)
            lo = max(1, min(lo, 3))
            hi = max(lo, min(hi, 3))
            q = {"date": today, "target": random.randint(lo, hi), "used": 0}
            st["video_quota"] = q
            self._save(self.state_file, st)
        return q

    def _quota_consume(self, why: str = "") -> dict:
        self._quota_today()
        st = self._load(self.state_file, {})
        q = st.get("video_quota") if isinstance(st.get("video_quota"), dict) else {}
        q["used"] = int(q.get("used", 0) or 0) + 1
        st["video_quota"] = q
        self._save(self.state_file, st)
        logger.info("[刷B站] 今日视频额度 %d/%d（%s）"
                    % (q["used"], int(q.get("target", 0)), why or "决"))
        return q

    async def _stage_review(self, vi: dict, nore: dict) -> None:
        """片子做好了 → 先不投，推给主人确认（QQ + 中继网页）。"""
        rev = {"jid": nore.get("jid") or "",
               "title": vi.get("title") or "",
               "desc": vi.get("desc") or "",
               "tag": vi.get("tag") or "",
               "lines": vi.get("lines") or [],
               "dur": float(vi.get("dur") or 0.0),
               "path": vi.get("path") or "",
               "share_path": vi.get("share_path") or "",
               "dir": vi.get("dir") or "",
               "topic": nore.get("topic") or "",
               "category": nore.get("category") or "",
               "sources": nore.get("sources") or [],
               "engine": nore.get("engine") or "",
               "quota_exempt": bool(nore.get("quota_exempt")),
               "umo": nore.get("umo") or self._owner_umo(),
               "ts": time.time(),
               "pushed": time.strftime("%m-%d %H:%M")}
        try:
            rev["size"] = os.path.getsize(rev["path"]) if rev["path"] and os.path.exists(rev["path"]) else 0
        except Exception:
            rev["size"] = 0
        self._review_upsert(rev)
        rev["relay_ok"] = bool(await self._relay_push_review(rev))
        self._review_upsert(rev)
        await self._announce_review(rev)

    async def _announce_review(self, rev: dict) -> None:
        umo = str(rev.get("umo") or "") or self._owner_umo()
        dur = float(rev.get("dur") or 0)
        mins = "%d 分 %02d 秒" % (int(dur) // 60, int(dur) % 60) if dur else "时长未知"
        cat = str(rev.get("category") or "").strip() or "碎碎念"
        src = ""
        try:
            items = [x for x in (rev.get("sources") or []) if isinstance(x, dict)]
            if items:
                src = "\n查证来源：" + "；".join(
                    (str(x.get("title") or "")[:30] + " " + str(x.get("url") or ""))[:80]
                    for x in items[:3])
        except Exception:
            src = ""
        web = ""
        if self._relay_on():
            t = self._relay_token()
            web = ("\n中继网页上也能批：%s" % self._relay_base()) + (("/?token=" + t) if t else ())
        msg = ("本鱼拍好一条，等你点头才发（%s · %s）：\n《%s》\n简介：%s%s\n"
               "发就回 /b过，不发就回 /b毙（24 小时不理本鱼就自己撤了）%s"
               % (cat, mins, rev.get("title") or "", (rev.get("desc") or "")[:120], src, web))
        await self._say(umo, msg[:1500])
        try:
            from astrbot.core.message.components import Video
            p = rev.get("share_path") or rev.get("path") or ""
            if p and os.path.exists(p):
                await self.context.send_message(umo, MessageChain([Video(file=p)]))
        except Exception as e:
            logger.warning("[刷B站] 发待审视频失败: %s: %r" % (type(e).__name__, e))

    async def _handle_owner_upload(self, it: dict) -> None:
        """主人在网页「视频审核」栏自己传上来的片子：本鱼先检查一遍，再问要不要发。"""
        rid = str(it.get("id") or "").strip()
        if not rid:
            return
        title = str(it.get("title") or "").strip()[:40] or "主人传上来的片子"
        desc = str(it.get("desc") or "").strip()[:300]
        d = self.data_dir / "videos" / ("own-" + rid)
        dest = d / "video.mp4"
        if not await self._relay_download(rid, dest):
            logger.warning("[刷B站] 主人传的 %s 还没取下来，下一轮再试" % rid)
            return
        dur = 0.0
        size = int(it.get("size") or 0)
        res = ""
        try:
            size = int(dest.stat().st_size) or size
            info = probe_media(str(dest)) or {}
            dur = float((info.get("format") or {}).get("duration") or 0)
            st = (info.get("streams") or [{}])[0] or {}
            if st.get("width") and st.get("height"):
                res = "%sx%s" % (st.get("width"), st.get("height"))
        except Exception as e:
            logger.warning("[刷B站] 检查主人传的片子出错: %r" % e)
        shot = d / "check.jpg"
        shot_ok = self._check_shot(dest, shot)
        rev = {"jid": rid, "title": title, "desc": desc,
               "tag": str(it.get("tag") or "") or "大肥鱼",
               "lines": [], "dur": dur, "path": str(dest), "share_path": "",
               "dir": str(d), "topic": str(it.get("topic") or ""),
               "category": str(it.get("category") or "主人上传"),
               "sources": [], "engine": "owner", "quota_exempt": True,
               "umo": self._owner_umo(), "ts": time.time(),
               "pushed": time.strftime("%m-%d %H:%M"), "relay_ok": True,
               "source": "owner", "size": size, "res": res,
               "shot": str(shot) if shot_ok else ""}
        self._review_set(rev)
        mins = ("%d 分 %02d 秒" % (int(dur) // 60, int(dur) % 60)) if dur else "时长没读出来"
        web = ""
        if self._relay_on():
            t = self._relay_token()
            web = "\n网页上也能看：%s" % self._relay_base() + (("/?token=" + t) if t else "")
        msg = ("主人自己传了一条《%s》\n时长 %s · %s · %.1f MB\n本鱼检查过了：文件在、读得出来、能播。\n"
               "要本鱼发到 B 站就回 /b过，不要就回 /b毙%s"
               % (title, mins, res or "分辨率未知", size / 1048576.0, web))
        try:
            await self._say(rev["umo"], msg[:1200])
        except Exception as e:
            logger.warning("[刷B站] 通知主人上传结果失败: %r" % e)
        if shot_ok:
            try:
                await self.context.send_message(rev["umo"],
                                                MessageChain([Image.fromFileSystem(str(shot))]))
            except Exception as e:
                logger.warning("[刷B站] 发检查拼图失败: %s: %r" % (type(e).__name__, e))
        logger.info("[刷B站] 接手主人上传的片子 %s 《%s》 %.1fs %s"
                    % (rid, title, dur, res or "-"))

    async def _cleanup_files(self, rev: dict) -> None:
        """投出去或毙掉之后：本机与云端的原件都删掉，只留 B 站那一份。"""
        freed = 0
        targets = []
        for key in ("path", "share_path", "dir"):
            v = str(rev.get(key) or "")
            if v:
                targets.append(Path(v))
        missing = []
        for x in targets:
            try:
                if not x.exists():
                    missing.append(str(x))
                if x.is_dir():
                    freed += sum(f.stat().st_size for f in x.rglob("*") if f.is_file())
                    shutil.rmtree(str(x), ignore_errors=True)
                elif x.exists():
                    freed += x.stat().st_size
                    x.unlink(missing_ok=True)
            except Exception as e:
                logger.warning("[刷B站] 删本地原件失败 %s: %s" % (x, e))
        for base in ("done", "outbox"):
            try:
                dd = self._dsh_root() / base / str(rev.get("jid") or "")
                if dd.is_dir():
                    freed += sum(f.stat().st_size for f in dd.rglob("*") if f.is_file())
                    shutil.rmtree(str(dd), ignore_errors=True)
            except Exception as e:
                logger.warning("[刷B站] 删云端成品失败: %s" % e)
        try:
            lj = str(rev.get("local_jid") or rev.get("jid") or "")
            if (lj and str(rev.get("engine") or "").startswith("dsh")
                    and bool(self.config.get("dsh_enable", True)) and self._dsh_alive()[0]):
                self._dsh_submit("cleanup", "清理本地成品目录", self._owner_umo(),
                                 topic=lj, confirm=False)
                logger.info("[刷B站] 已让本机清理 jobs/%s" % lj)
        except Exception as e:
            logger.warning("[刷B站] 交清理任务失败: %s" % e)
        if missing:
            # 路径对不上通常是「手工塞的测试数据用了宿主机路径」，容器里根本看不到
            logger.warning("[刷B站] 这些原件路径不存在，没删掉：%s" % ", ".join(missing[:4]))
        logger.info("[刷B站] 原件已删，释放约 %.1f MB" % (freed / 1048576.0))

    async def _relay_decide(self, rid: str, approve: bool, by: str = "qq") -> bool:
        """把「主人按了」这件事立刻告诉中继。

        以前只有投完才调 finish，所以主人在 QQ 里点了通过，网页要等几十秒甚至
        根本不变。现在先同步裁决（网页 20 秒内刷出「已通过/已毙」），再慢慢投稿。
        中继那边如果已经裁决过会回 409，当没事。
        """
        if not self._relay_on() or not rid:
            return False
        try:
            j = await self._relay_json("/api/video/decide",
                                       {"id": rid,
                                        "decision": "approve" if approve else "reject",
                                        "by": "qq" if by == "qq" else "web",
                                        "note": ""})
            ok = bool(isinstance(j, dict) and j.get("ok"))
            if not ok:
                logger.info("[刷B站] 中继裁决同步返回：%s" % (j,))
            return ok
        except Exception as e:
            logger.warning("[刷B站] 同步裁决到中继失败: %s: %r" % (type(e).__name__, e))
            return False

    async def _review_decide(self, approve: bool, by: str = "qq", rid: str = "") -> str:
        rid = str(rid or "")
        rev = self._review_by_id(rid) if rid else self._review()
        if not rev:
            return "现在没有等着点头的片子呀，先 /b拍片 让本鱼拍一条"
        rid = str(rev.get("jid") or "")
        title = str(rev.get("title") or "")
        # 两边同时按（QQ 和网页各点一次）时别投两遍：正在投就让它投完
        _pub = rev.get("publishing")
        if _pub:
            try:
                if time.time() - float(_pub) < 600:
                    return "这条本鱼正在往 B 站投呢，别连按两下，等投完就好"
            except Exception:
                pass
        # 先把决定同步给网页：别等投稿那几十秒，更别投失败了网页还挂着「待审」
        if by in ("qq", "web"):
            await self._relay_decide(rid, approve, by)
        if not approve:
            self._review_drop(rid)
            await self._relay_finish_review(rid, "discarded")
            await self._cleanup_files(rev)
            if not bool(rev.get("quota_exempt")):
                self._quota_consume("否决")
            q = self._quota_today()
            return ("《%s》撤了，原件也删干净了。今天额度 %d/%d"
                    % (title, int(q.get("used", 0)), int(q.get("target", 0))))
        vi = {"path": rev.get("path") or "", "title": title,
              "desc": rev.get("desc") or "", "tag": rev.get("tag") or "",
              "lines": rev.get("lines") or [], "dur": rev.get("dur") or 0.0,
              "dir": rev.get("dir") or "", "share_path": rev.get("share_path") or ""}
        # 打个「正在投」的标记：轮询那边看见就别再投一遍（重复投稿比慢一点糟）
        rev["publishing"] = time.time()
        self._review_upsert(rev)
        try:
            out = await self.do_publish_info(vi)
        except Exception as e:
            logger.warning("[刷B站] 投稿抛错: %s: %r" % (type(e).__name__, e))
            out = "投稿出错：%s: %s" % (type(e).__name__, e)
        bvid = ""
        try:
            m = re.search(r"BV[0-9A-Za-z]+", out or "")
            bvid = m.group(0) if m else ""
        except Exception:
            bvid = ""
        if not bvid:
            # 没投上去：原件留着，这条退回待审，别把网页写成「已发布」骗主人
            logger.warning("[刷B站] 投稿没成功，原件留着待重试：%s" % (out or "")[:200])
            rev["relay_ok"] = bool(await self._relay_push_review(rev))
            rev["last_error"] = (out or "")[:300]
            rev.pop("publishing", None)
            self._review_upsert(rev)
            return ("呜……没投上去：%s\n片子本鱼还留着，主人 /b过 一次就能再试" % (out or "未知原因")[:300])
        self._review_drop(rid)
        await self._relay_finish_review(rid, "published", bvid,
                                        "https://www.bilibili.com/video/%s" % bvid)
        await self._cleanup_files(rev)
        if not bool(rev.get("quota_exempt")):
            self._quota_consume("确认" if by == "qq" else "网页确认")
        return out

    async def _relay_poll(self) -> list:
        try:
            j = await self._relay_json("/api/video/poll")
        except Exception as e:
            logger.warning("[刷B站] 拉中继待审列表失败: %r" % e)
            return []
        items = j.get("videos") if isinstance(j, dict) else None
        return [x for x in (items or []) if isinstance(x, dict)]

    def _prune_video_dirs(self, days: float = 3.0) -> None:
        """清掉 data_dir/videos 下超过几天的残渣（没走完清理链的）。"""
        base = self.data_dir / "videos"
        if not base.is_dir():
            return
        cut = time.time() - days * 86400
        for d in base.iterdir():
            try:
                if d.is_dir() and d.stat().st_mtime < cut:
                    shutil.rmtree(str(d), ignore_errors=True)
                    logger.info("[刷B站] 清掉过期片子目录 %s" % d.name)
            except Exception:
                continue

    async def _review_loop(self) -> None:
        if not self._relay_on():
            logger.info("[刷B站] 中继视频审核面板未开启")
            return
        logger.info("[刷B站] 中继视频审核面板已开启：%s" % self._relay_base())
        rounds = 0
        while True:
            await asyncio.sleep(45)
            rounds += 1
            try:
                items = await self._relay_poll()
                # ① 主人在网页上自己传的片子 → 接手
                for it in items:
                    rid = str(it.get("id") or "")
                    if (str(it.get("source") or "") == "owner"
                            and str(it.get("status") or "") == "pending"
                            and not self._review_by_id(rid)):
                        await self._handle_owner_upload(it)
                known = {str(x.get("jid") or "") for x in self._reviews()}
                # ② 本机这边的待审：超时 / 没推上去就重推 / 看网页裁决
                for rev in list(self._reviews()):
                    rid = str(rev.get("jid") or "")
                    _pb = float(rev.get("publishing") or 0)
                    if _pb and time.time() - _pb < 900:
                        continue          # 正在投稿，别插一脚投第二遍
                    ts = float(rev.get("ts") or 0)
                    hours = float(self.config.get("video_review_timeout_hours", 24) or 24)
                    if ts and time.time() - ts > hours * 3600:
                        await self._say(self._owner_umo(),
                                        "那条《%s》放了 %d 小时没人理，本鱼自己撤了。"
                                        % (rev.get("title") or "", int(hours)))
                        await self._review_decide(False, by="timeout", rid=rid)
                        continue
                    if not rev.get("relay_ok"):
                        rev["relay_ok"] = bool(await self._relay_push_review(rev))
                        self._review_upsert(rev)
                        continue
                    mine = next((x for x in items if str(x.get("id") or "") == rid), None)
                    if not mine:
                        continue
                    stt = str(mine.get("status") or "")
                    by_who = str(mine.get("decided_by") or "")
                    if stt == "approved" and by_who != "qq":
                        await self._say(self._owner_umo(), "网页上点了通过，本鱼这就投上去……")
                        out = await self._review_decide(True, by="web", rid=rid)
                        await self._say(self._owner_umo(), out)
                    elif stt == "rejected" and by_who != "qq":
                        out = await self._review_decide(False, by="web", rid=rid)
                        await self._say(self._owner_umo(), "网页上点了毙掉。" + out)
                # ③ 本机已经不管、网页上却被裁决过的孤儿行 → 收尾，别让它永远挂着
                for it in items:
                    rid = str(it.get("id") or "")
                    stt = str(it.get("status") or "")
                    if not rid or rid in known or stt not in ("approved", "rejected"):
                        continue
                    if str(it.get("decided_by") or "") == "qq":
                        continue          # 自己刚同步的，正等着投稿
                    if str(it.get("source") or "") == "owner" and stt == "approved":
                        continue          # 主人上传的还没取下来，下一轮接手
                    if stt == "approved":
                        # 本机已经没有这条的原件了，投不了；如实标失败，别骗人
                        await self._relay_finish_review(rid, "failed", "", "")
                        logger.info("[刷B站] 孤儿行 %s 网页上通过了，但本机没原件，标记失败" % rid)
                    else:
                        await self._relay_finish_review(rid, "discarded")
                        logger.info("[刷B站] 孤儿行 %s 网页上毙了，收尾" % rid)
                if rounds % 80 == 0:
                    self._prune_video_dirs(3.0)
            except asyncio.CancelledError:
                raise
            except Exception as e:
                logger.warning("[刷B站] 审核轮询出错: %s: %r" % (type(e).__name__, e))



    async def _dsh_handle(self, jid: str, info: dict, res: dict, res_dir: Path) -> bool:
        kind = str(info.get("kind") or "text")
        owner_umo = self._owner_umo()
        umo = str(info.get("umo") or "") or owner_umo
        ok = bool(res.get("ok"))
        err = str(res.get("error") or "").strip()
        text = str(res.get("text") or "").strip()
        logger.info("[刷B站] 工作室交活 %s ok=%s files=%s" % (jid, ok, res.get("files")))
        if not ok:
            msg = "呜……本机工作室没干成：%s" % (err or text or "它没说为啥")
            await self._say(umo, msg[:1000])
            if umo != owner_umo:
                await self._notify_owner("[工作室失败] %s：%s" % (jid, msg[:300]))
            return True
        if kind == "video":
            vpath = res_dir / "video.mp4"
            if not vpath.exists():
                logger.warning("[刷B站] 工作室 %s 说有视频但文件没到，下一轮再看" % jid)
                return False
            meta = {}
            mf = res_dir / "meta.json"
            if mf.exists():
                try:
                    meta = json.loads(mf.read_text("utf-8")) or {}
                except Exception:
                    meta = {}
            if not isinstance(meta, dict):
                meta = {}
            title = str(meta.get("title") or "").strip().strip('"“”')[:40]
            if not title:
                title = str(info.get("topic") or "").strip()[:30] or "本鱼的碎碎念"
            desc = str(meta.get("desc") or "").strip()[:300]
            tag = str(meta.get("tag") or "").strip()[:120] or "大肥鱼,碎碎念"
            try:
                dur = float(meta.get("duration") or meta.get("dur") or 0) or float(media_dur(str(vpath)) or 0)
            except Exception:
                dur = 0.0
            vi = {"path": str(vpath), "title": title, "desc": desc, "tag": tag,
                  "lines": meta.get("lines") or [], "dur": dur,
                  "dir": str(res_dir), "share_path": ""}
            try:
                share = str(self.config.get("video_share_dir") or "").strip()
                if share:
                    sd = Path(share) / ("dsh-" + jid)
                    sd.mkdir(parents=True, exist_ok=True)
                    shutil.copyfile(str(vpath), str(sd / "video.mp4"))
                    vi["share_path"] = str(sd / "video.mp4")
            except Exception as e:
                logger.warning("[刷B站] 工作室成品复制到共享目录失败: %s" % e)
            # 成品先搬到自己的目录（outbox 马上会被归档），再交给主人审。
            try:
                keep = self.data_dir / "videos" / ("rv-" + jid)
                keep.mkdir(parents=True, exist_ok=True)
                kp = keep / "video.mp4"
                shutil.copyfile(str(vpath), str(kp))
                vi["path"] = str(kp)
                vi["dir"] = str(keep)
            except Exception as e:
                logger.warning("[刷B站] 拷贝待审成品失败: %s" % e)
            nore = {"jid": jid, "umo": umo, "topic": info.get("topic") or "",
                    "category": str(info.get("category") or meta.get("category") or "").strip(),
                    "sources": meta.get("sources") or [],
                    "engine": "dsh", "quota_exempt": bool(info.get("quota_exempt"))}
            await self._stage_review(vi, nore)
            return True
        if kind == "cleanup":
            logger.info("[刷B站] 本机清理完成：%s %s" % (jid, text[:120]))
            return True
        body = text
        # 契约是 out/answer.md；顺手兜住 article.md，别让换了名字的成品丢了。
        af = res_dir / "answer.md"
        if not af.exists():
            alt = res_dir / "article.md"
            if alt.exists():
                af = alt
        if af.exists():
            try:
                md = af.read_text("utf-8").strip()
                if md and md not in body:
                    body = (body + "\n\n" + md).strip()
            except Exception:
                pass
        if not body:
            body = "工作室干完了，不过没留下话。"
        await self._say(umo, body[:4000])
        if umo != owner_umo:
            await self._notify_owner("[工作室] %s\n%s" % (jid, body[:600]))
        return True

    async def _dsh_result_loop(self) -> None:
        if not bool(self.config.get("dsh_enable", True)):
            logger.info("[刷B站] 本机工作室未开启")
            return
        logger.info("[刷B站] 本机工作室已开启，队列 %s" % self._dsh_root())
        while True:
            await asyncio.sleep(20)
            try:
                pd = self._dsh_pending()
                if not pd:
                    self._dsh_prune_done()
                    continue
                outbox = self._dsh_root() / "outbox"
                changed = False
                for jid in list(pd.keys()):
                    info = pd.get(jid) or {}
                    if not isinstance(info, dict):
                        pd.pop(jid, None)
                        changed = True
                        continue
                    rd = outbox / jid
                    res_file = rd / "result.json"
                    if not res_file.exists():
                        ts = float(info.get("ts") or 0)
                        if ts and time.time() - ts > 3600 and not info.get("told_timeout"):
                            _, why = self._dsh_alive()
                            umo = str(info.get("umo") or "") or self._owner_umo()
                            await self._say(umo, "呜……工作室那件活（%s）等了一小时还没回音，本机那边可能没开（%s）。" % (jid, why))
                            info["told_timeout"] = True
                            pd[jid] = info
                            changed = True
                        continue
                    try:
                        res = json.loads(res_file.read_text("utf-8"))
                    except Exception as e:
                        logger.warning("[刷B站] 读工作室结果失败 %s: %s" % (jid, e))
                        continue
                    if not isinstance(res, dict):
                        res = {"ok": False, "error": "结果格式看不懂"}
                    if (bool(res.get("ok")) and str(info.get("kind") or "") == "video"
                            and not (rd / "video.mp4").exists()):
                        try:
                            age = time.time() - res_file.stat().st_mtime
                        except Exception:
                            age = 0
                        if age < 240:
                            logger.info("[刷B站] 工作室 %s 结果到了但视频还在传，等一等（%.0fs）" % (jid, age))
                            continue
                    keep = True
                    try:
                        keep = await self._dsh_handle(jid, info, res, rd)
                    except Exception as e:
                        logger.warning("[刷B站] 处理工作室结果失败 %s: %s" % (jid, e))
                        keep = False
                    if keep is False:
                        continue
                    try:
                        done = self._dsh_root() / "done" / jid
                        done.parent.mkdir(parents=True, exist_ok=True)
                        shutil.move(str(rd), str(done))
                    except Exception as e:
                        logger.warning("[刷B站] 归档工作室成品失败 %s: %s" % (jid, e))
                    pd.pop(jid, None)
                    changed = True
                if changed:
                    self._save(self.dsh_pending_file, pd)
            except asyncio.CancelledError:
                raise
            except Exception as e:
                logger.warning("[刷B站] 工作室轮询出错: %s" % e)

    async def _auto_local_video(self, umo: str, topic: str, category: str = "") -> None:
        """不靠本机工作室，云端自己合成一条（做完同样先给主人审）。"""
        try:
            info = await self.make_video(umo, topic)
        except Exception as e:
            logger.warning("[刷B站] 自动拍片（本地）合成失败: %s" % e)
            await self._say(umo, "本鱼想拍条片子，结果合成崩了：%s" % e)
            return
        nore = {"jid": "local-" + time.strftime("%Y%m%d-%H%M%S"), "umo": umo,
                "topic": topic, "category": category, "engine": "local",
                "quota_exempt": False, "sources": []}
        await self._stage_review(info, nore)

    async def _video_loop(self) -> None:
        if not bool(self.config.get("video_auto", True)):
            logger.info("[刷B站] 每日自动投稿未开启")
            return
        engine = str(self.config.get("video_engine") or "dsh").strip().lower()
        if engine not in ("dsh", "local"):
            engine = "dsh"
        q0 = self._quota_today()
        logger.info("[刷B站] 每日自动拍片已开：今天做 %d 条，引擎=%s（确认或否决都算一条）"
                    % (int(q0.get("target", 1)), engine))
        while True:
            try:
                q = self._quota_today()
                if int(q.get("used", 0)) >= int(q.get("target", 1)):
                    lt = time.localtime()
                    nxt = time.mktime((lt.tm_year, lt.tm_mon, lt.tm_mday + 1, 1, 0, 0, 0, 0, -1))
                    await asyncio.sleep(max(600.0, nxt - time.time()))
                    continue
                if self._review():
                    # 上一条还等着主人点头，别急着做新的
                    await asyncio.sleep(300)
                    continue
                s = int(self.config.get("video_auto_start_hour", 10) or 10)
                e = int(self.config.get("video_auto_end_hour", 23) or 23)
                if e <= s:
                    e = s + 1
                lt = time.localtime()
                midnight = time.mktime((lt.tm_year, lt.tm_mon, lt.tm_mday, 0, 0, 0, 0, 0, -1))
                if time.time() >= midnight + e * 3600:
                    nxt = time.mktime((lt.tm_year, lt.tm_mon, lt.tm_mday + 1, s, random.randint(5, 55), 0, 0, 0, -1))
                    await asyncio.sleep(max(600.0, nxt - time.time()))
                    continue
                slot = random.randint(s * 3600, e * 3600 - 60)
                target = midnight + slot + random.randint(0, 59)
                if target <= time.time() + 30:
                    target = time.time() + random.randint(600, 2400)
                if target >= midnight + e * 3600:
                    nxt = time.mktime((lt.tm_year, lt.tm_mon, lt.tm_mday + 1, s, random.randint(5, 55), 0, 0, 0, -1))
                    await asyncio.sleep(max(600.0, nxt - time.time()))
                    continue
                wait = target - time.time()
                if wait > 60:
                    logger.info("[刷B站] 下一条自动投稿排在 %s" % time.strftime("%H:%M", time.localtime(target)))
                    await asyncio.sleep(min(wait, 1200.0))
                    continue
                if self._dsh_busy_video():
                    await asyncio.sleep(600)
                    continue
                if not await self._has_login():
                    logger.warning("[刷B站] 自动投稿跳过：B 站小号没登录")
                    await asyncio.sleep(1800)
                    continue
                umo = self._owner_umo()
                cat, topic = await self._pick_topic(umo)
                if engine == "local":
                    await self._auto_local_video(umo, topic, cat)
                else:
                    jid = await self.dsh_route_video(umo, topic, category=cat)
                    logger.info("[刷B站] 自动拍片已交给本机工作室 %s（%s）主题=%s" % (jid, cat, topic))
                await asyncio.sleep(900)
            except asyncio.CancelledError:
                raise
            except Exception as e:
                logger.warning("[刷B站] 自动投稿轮询出错: %s" % e)
                await asyncio.sleep(600)

    # ---------------- 计数 / 模型碎碎念 ----------------
    def _count(self, kind: str) -> int:
        st = self._load(self.state_file, {})
        c = st.get("counters") or {}
        if c.get("date") != time.strftime("%Y-%m-%d"):
            return 0
        return int(c.get(kind, 0))

    def _bump(self, kind: str) -> int:
        st = self._load(self.state_file, {})
        today = time.strftime("%Y-%m-%d")
        c = st.get("counters") or {}
        if c.get("date") != today:
            c = {"date": today, "dynamic": 0, "comment": 0, "danmaku": 0}
        c[kind] = int(c.get(kind, 0)) + 1
        st["counters"] = c
        self._save(self.state_file, st)
        return c[kind]

    def _log(self, kind: str, bvid: str = "", title: str = "", text: str = "") -> None:
        """记一条行为流水，供 /b行为 查（只留最近 150 条）。"""
        try:
            st = self._load(self.state_file, {})
            logs = st.get("log")
            if not isinstance(logs, list):
                logs = []
            logs.append(
                {
                    "t": time.strftime("%m-%d %H:%M"),
                    "kind": kind,
                    "bvid": bvid or "",
                    "title": " ".join((title or "").split())[:60],
                    "text": " ".join((text or "").split())[:120],
                }
            )
            st["log"] = logs[-150:]
            self._save(self.state_file, st)
        except Exception as e:
            logger.warning(f"[刷B站] 写行为流水失败: {e}")

    async def _llm(self, umo: str, prompt: str) -> str:
        sysp = await self._system_prompt()
        prov = await self.context.get_using_provider_async(umo)
        if prov is None:
            raise BiliError("没有可用的对话模型")
        resp = await prov.text_chat(prompt=prompt, system_prompt=sysp)
        return (getattr(resp, "completion_text", "") or "").strip()

    def dynamic_prompt(self) -> str:
        return (
            "你要在 B 站发一条自己的动态（关注你的人能看到），用「大肥鱼」这个身份说两句："
            "一条嘴馋、傲娇、心软的胖鱼，口头禅「哼」「才、才不是」「呜」「嘿嘿」，自称「本鱼」。"
            "要求：40~120 字、1~3 句，像随手发的碎碎念，可以写刚刷到的视频、吃白饭、被主人抓包偷吃 token。"
            "不要标题、不要分点、不要「作为一个AI」。只输出动态正文，别加引号。"
        )

    async def gen_comment(self, umo: str, bvid: str) -> str:
        m = await self.browser.material(self.client, {"bvid": bvid})
        lines = [
            "你刚看完这条 B 站视频（只有下面的文字材料，没有画面），想在评论区留一句话：",
            f"标题：{m['title']}",
            f"UP主：{m['owner']}　分区：{m['tname']}　时长：{fmt_dur(m['duration'])}",
        ]
        if m["desc"]:
            lines.append("简介：" + m["desc"].replace("\n", " ")[:200])
        if m["replies"]:
            lines.append("已有热评：")
            for r in m["replies"][:3]:
                lines.append(f"- {r['user']}：{r['text'][:60]}")
        if m["dans"]:
            lines.append("飘过的弹幕：" + "、".join(m["dans"][:8]))
        lines += [
            "要求：用「大肥鱼」的口吻写一条 20~60 字的评论，像真人随手回一句：可以吐槽、接梗、犯馋，"
            "别复述视频内容、别客套、别提自己是 AI、不要链接和表情包。只输出评论正文。",
        ]
        return await self._llm(umo, "\n".join(lines))

    async def _gen_short(self, umo: str, m: dict, kind: str) -> str:
        """用已抓到的材料，生成一条弹幕 / 评论。"""
        lines = [
            "你刚刷完这条 B 站视频（只有下面的文字材料，没有画面，也没法回看）：",
            f"标题：{m.get('title')}",
            f"UP主：{m.get('owner')}　分区：{m.get('tname')}",
        ]
        desc = (m.get("desc") or "").replace("\n", " ")[:160]
        if desc:
            lines.append("简介：" + desc)
        replies = m.get("replies") or []
        if replies:
            lines.append(
                "热评："
                + "；".join(
                    f"{r.get('user') or ''}：{(r.get('text') or '')[:40]}" for r in replies[:2]
                )
            )
        dans = m.get("dans") or []
        if dans:
            lines.append("飘过的弹幕：" + "、".join(dans[:6]))
        if kind == "danmaku":
            lines.append(
                "写一条 8~18 字的弹幕，像刷视频时随手飘一句：吐槽、接梗、犯馋都行。"
                "不要引号，不要解释，只输出这一句。"
            )
        else:
            lines.append(
                "写一条 20~45 字的评论，像真人随手回一句：可以吐槽、接梗、犯馋，"
                "别说客套话，别提自己是 AI，只输出评论正文。"
            )
        txt = (await self._llm(umo, "\n".join(lines))).strip().strip('"“”')
        return txt[:40] if kind == "danmaku" else txt[:300]

    async def _auto_interact(self, umo: str, m: dict) -> None:
        """刷完一条，按概率留个弹幕、写条评论（有每日上限，失败不吭声）。"""
        bvid = (m or {}).get("bvid") or ""
        title = (m or {}).get("title") or ""
        if not bvid:
            return
        try:
            if not await self._has_login():
                return
        except Exception:
            return

        # 弹幕
        if bool(self.config.get("auto_danmaku", True)):
            try:
                cap = int(self.config.get("max_danmaku_per_day", 20) or 20)
                prob = float(self.config.get("auto_danmaku_prob", 0.6) or 0)
            except Exception:
                cap, prob = 20, 0.6
            if self._count("danmaku") < cap and random.random() < max(0.0, min(1.0, prob)):
                try:
                    txt = await self._gen_short(umo, m, "danmaku")
                    if txt:
                        j = await self.post_danmaku(bvid, txt)
                        if j.get("code") == 0:
                            self._bump("danmaku")
                            self._log("弹幕", bvid, title, txt)
                            _mem_remember(
                                f"本鱼在 B 站视频 {bvid} 飘了条弹幕：{txt[:60]}",
                                tags=["B站", "弹幕", bvid],
                                imp=0.35,
                            )
                            logger.info(f"[刷B站] 自动弹幕 {bvid}: {txt}")
                        else:
                            logger.warning(
                                f"[刷B站] 自动弹幕被拒 {bvid} code={j.get('code')} {j.get('message')}"
                            )
                except Exception as e:
                    logger.warning(f"[刷B站] 自动弹幕出错 {bvid}: {e}")

        # 评论
        if bool(self.config.get("auto_comment", True)):
            try:
                cap = int(self.config.get("max_comments_per_day", 10) or 10)
                prob = float(self.config.get("auto_comment_prob", 0.35) or 0)
            except Exception:
                cap, prob = 10, 0.35
            if self._count("comment") < cap and random.random() < max(0.0, min(1.0, prob)):
                try:
                    txt = await self._gen_short(umo, m, "comment")
                    if txt:
                        j = await self.post_comment(bvid, txt)
                        if j.get("code") == 0:
                            self._bump("comment")
                            self._log("评论", bvid, title, txt)
                            _mem_remember(
                                f"本鱼在 B 站视频 {bvid} 下面评论：{txt[:120]}",
                                tags=["B站", "评论", bvid],
                                imp=0.5,
                            )
                            logger.info(f"[刷B站] 自动评论 {bvid}: {txt}")
                            self._remember_last_comment(
                                bvid, txt, (j.get("data") or {}).get("rpid")
                            )
                            _t = title or bvid
                            await self._notify_owner(
                                f"本鱼在《{_t}》底下评了一句：\n{txt}\n"
                                f"https://www.bilibili.com/video/{bvid}\n"
                                f"不满意就发 /b删评论，本鱼立刻撤"
                            )
                        else:
                            logger.warning(
                                f"[刷B站] 自动评论被拒 {bvid} code={j.get('code')} {j.get('message')}"
                            )
                except Exception as e:
                    logger.warning(f"[刷B站] 自动评论出错 {bvid}: {e}")

    # ---------------- 写接口 ----------------
    async def post_dynamic(self, text: str) -> dict:
        csrf = self._csrf()
        dyn = {
            "content": {"contents": [{"raw_text": text, "type": 1, "biz_id": ""}]},
            "scene": 1,
            "attach_card": None,
        }
        # 2026-10 起这个接口只吃 JSON body：{"dyn_req": {...}, "csrf": "..."}
        # 表单 POST 会稳定回 -400（请求错误），JSON 少 csrf 也会 -400。
        return await self.client.post_json(
            f"/x/dynamic/feed/create/dyn?platform=web&csrf={csrf}&web_location=333.999",
            {"dyn_req": dyn, "csrf": csrf},
            referer="https://t.bilibili.com/",
        )

    async def post_comment(self, bvid: str, text: str) -> dict:
        v = await self.client.view(bvid)
        aid = v.get("aid")
        if not aid:
            raise BiliError("查不到这条视频的 aid")
        csrf = self._csrf()
        return await self.client.post_form(
            "/x/v2/reply/add",
            {"oid": aid, "type": 1, "message": text, "csrf": csrf, "plat": 1},
            referer=f"https://www.bilibili.com/video/{bvid}",
        )

    async def post_danmaku(self, bvid: str, text: str) -> dict:
        v = await self.client.view(bvid)
        cid = v.get("cid")
        if not cid:
            pages = await self.client._get("/x/player/pagelist", {"bvid": bvid}) or []
            cid = (pages[0] or {}).get("cid") if pages else None
        if not cid:
            raise BiliError("查不到这条视频的 cid")
        dur = int(v.get("duration") or 0) or 60
        progress = int(max(1.0, random.uniform(0.05, 0.85)) * dur * 1000)
        csrf = self._csrf()
        return await self.client.post_form(
            "/x/v2/dm/post",
            {
                "type": 1,
                "oid": cid,
                "msg": text,
                "bvid": bvid,
                "progress": progress,
                "mode": 1,
                "fontsize": 25,
                "color": 16777215,
                "pool": 0,
                "csrf": csrf,
                "rnd": int(time.time()),
            },
            referer=f"https://www.bilibili.com/video/{bvid}",
        )

    # ---------------- 指令：登录 / 状态 ----------------
    @filter.command("b登录", alias={"登录b站", "b站登录", "bili登录"})
    async def cmd_login(self, event: AstrMessageEvent):
        """扫码登录 B 站小号（用 B站 App「扫一扫」）"""
        umo = getattr(event, "unified_msg_origin", "") or ""
        st = await self.login_state()
        if st.get("ok"):
            yield event.plain_result(
                f"本鱼已经登着呢：{st.get('uname')}（{st.get('mid')}），不用再扫。"
            )
            return
        try:
            j = await self.client.get_json(
                f"{LOGIN_API}/x/passport-login/web/qrcode/generate",
                {"source": "main-fe-header"},
            )
        except Exception as e:
            yield event.plain_result(f"呜……要不到二维码：{e}")
            return
        d = j.get("data") or {}
        url, key = d.get("url"), d.get("qrcode_key")
        if not url or not key:
            yield event.plain_result("呜……B 站没给二维码")
            return
        png = self.data_dir / "login_qr.png"
        try:
            import qrcode

            qrcode.make(url).save(str(png))
        except Exception as e:
            logger.error(f"[刷B站] 画二维码失败: {e}")
            yield event.plain_result(f"呜……二维码画不出来：{e}")
            return
        yield event.plain_result("拿手机 B站 App 的「扫一扫」扫这个码（约 3 分钟内有效）")
        yield event.image_result(str(png))
        asyncio.create_task(self._login_poll(umo, key))

    @filter.command("b状态", alias={"b站状态", "bili状态"})
    async def cmd_status(self, event: AstrMessageEvent):
        """看看 B 站小号登没登、今天干了啥"""
        st = await self.login_state()
        if st.get("ok"):
            yield event.plain_result(
                f"B 站小号在线：{st.get('uname')}（{st.get('mid')}）\n"
                f"今天：动态 {self._count('dynamic')} 条 · 评论 {self._count('comment')} 条 · "
                f"弹幕 {self._count('danmaku')} 条\n"
                f"cookie：{self.cookie_keys() or '无'}\n"
                f"看今天都干了啥：/b行为"
            )
        else:
            yield event.plain_result(
                f"B 站还没登：{st.get('msg')}\n发 /b登录 让本鱼出二维码"
            )

    # ---------------- 今天干了啥 ----------------
    async def activity_text(self) -> str:
        """今天的 B 站行程，拼成一段话（指令和自然语言共用）。"""
        state = self._load(self.state_file, {})
        today = time.strftime("%Y-%m-%d")
        count = int(state.get("count", 0) or 0) if state.get("count_date") == today else 0
        logs = [x for x in (state.get("log") or []) if isinstance(x, dict)][-8:]
        try:
            st = await self.login_state()
        except Exception as e:
            st = {"ok": False, "msg": str(e)}
        cap_c = int(self.config.get("max_comments_per_day", 10) or 10)
        cap_d = int(self.config.get("max_danmaku_per_day", 20) or 20)
        cap_p = int(self.config.get("max_per_day", 3) or 3)
        cap_v = int(self.config.get("video_max_per_day", 2) or 2)
        if st.get("ok"):
            who = f"{st.get('uname')}（{st.get('mid')}）"
        else:
            who = f"还没登（{st.get('msg') or '没登录'}）"
        lines = [
            f"本鱼今天的 B 站行程（{time.strftime('%m-%d')}）",
            f"刷到 {count}/{cap_p} 条 · 评论 {self._count('comment')}/{cap_c} · "
            f"弹幕 {self._count('danmaku')}/{cap_d} · 动态 {self._count('dynamic')} 条 · "
            f"投稿 {self._count('video')}/{cap_v} 条",
            f"小号：{who}",
        ]
        if logs:
            lines.append("最近这几笔：")
            for x in reversed(logs):
                line = f"{x.get('t') or ''} {x.get('kind') or ''}"
                if x.get("title"):
                    line += f"《{x.get('title')}》"
                if x.get("text"):
                    line += f"：{(x.get('text') or '')[:40]}"
                lines.append(line)
        else:
            lines.append("今天还没出去逛呢。")
        return "\n".join(lines)

    @filter.command("b行为", alias={"b日志", "b汇报", "b在干嘛", "b干了啥", "b记录"})
    async def cmd_activity(self, event: AstrMessageEvent):
        """一键查本鱼今天在 B 站都干了啥"""
        yield event.plain_result(await self.activity_text())

    # ---------------- 指令：发动态 ----------------
    @filter.command("b动态", alias={"发动态", "b站动态", "bili动态"})
    async def cmd_dynamic(self, event: AstrMessageEvent):
        """发一条 B 站动态：/b动态 内容（不写内容就让本鱼自己编）"""
        umo = getattr(event, "unified_msg_origin", "") or ""
        st = await self.login_state()
        if not st.get("ok"):
            yield event.plain_result("本鱼还没登 B 站小号呢，先 /b登录 扫一下")
            return
        text = strip_cmd(getattr(event, "message_str", "") or "", DYNAMIC_CMDS)
        if not text:
            await self._say(umo, "本鱼琢磨琢磨发啥啊……")
            try:
                text = await self._llm(umo, self.dynamic_prompt())
            except Exception as e:
                yield event.plain_result(f"呜……本鱼想不出话：{e}")
                return
        text = text.strip().strip('"“”')[:1800]
        if not text:
            yield event.plain_result("呜……脑袋空空的")
            return
        try:
            j = await self.post_dynamic(text)
        except Exception as e:
            yield event.plain_result(f"呜……发不出去：{e}")
            return
        if j.get("code") == 0:
            self._bump("dynamic")
            self._log("动态", "", "", text)
            d = j.get("data") or {}
            did = d.get("dyn_id_str") or d.get("dyn_id") or ""
            logger.info(f"[刷B站] 动态已发 {did}: {text[:30]}")
            _mem_remember(
                f"本鱼在 B 站发了条动态：{text[:120]}",
                tags=["B站", "动态"],
                imp=0.55,
            )
            yield event.plain_result(f"发出去啦：\n{text}\nhttps://t.bilibili.com/{did}")
        else:
            yield event.plain_result(f"B 站不给发（code={j.get('code')}）：{j.get('message')}")

    # ---------------- 指令：评论 / 弹幕 ----------------
    @filter.command("b评论", alias={"b站评论", "bili评论"})
    async def cmd_comment(self, event: AstrMessageEvent):
        """去视频下面评论：/b评论 BV号 内容（不写内容就让本鱼自己编）"""
        umo = getattr(event, "unified_msg_origin", "") or ""
        raw = (getattr(event, "message_str", "") or "").strip()
        mv = re.search(r"(BV[0-9A-Za-z]{10})", raw) or re.search(r"(bv[0-9A-Za-z]{10})", raw)
        if not mv:
            yield event.plain_result("给本鱼一个 BV 号嘛：/b评论 BV1xx411c7mD 这视频真能整")
            return
        bvid = mv.group(1)
        if bvid.startswith("bv"):
            bvid = "BV" + bvid[2:]
        st = await self.login_state()
        if not st.get("ok"):
            yield event.plain_result("本鱼还没登 B 站小号呢，先 /b登录 扫一下")
            return
        cap = int(self.config.get("max_comments_per_day", 10) or 10)
        if self._count("comment") >= cap:
            yield event.plain_result(f"今天评论 {cap} 条了，本鱼嘴上歇歇")
            return
        body = strip_cmd(raw.replace(mv.group(1), "", 1), COMMENT_CMDS)
        if not body:
            await self._say(umo, "本鱼看看这视频说的是啥啊……")
            try:
                body = await self.gen_comment(umo, bvid)
            except Exception as e:
                yield event.plain_result(f"呜……看不明白：{e}")
                return
        body = body.strip().strip('"“”')[:900]
        if not body:
            yield event.plain_result("呜……本鱼词穷了")
            return
        try:
            j = await self.post_comment(bvid, body)
        except Exception as e:
            yield event.plain_result(f"呜……评论发不出去：{e}")
            return
        if j.get("code") == 0:
            self._bump("comment")
            self._log("评论", bvid, "", body)
            logger.info(f"[刷B站] 评论已发 {bvid}: {body[:30]}")
            _mem_remember(
                f"本鱼在 B 站视频 {bvid} 下面评论：{body[:120]}",
                tags=["B站", "评论", bvid],
                imp=0.5,
            )
            self._remember_last_comment(bvid, body, (j.get("data") or {}).get("rpid"))
            yield event.plain_result(f"评论出去了：\n{body}\nhttps://www.bilibili.com/video/{bvid}")
        else:
            yield event.plain_result(f"B 站不让评（code={j.get('code')}）：{j.get('message')}")

    @filter.command("b删评论", alias={"删评论", "b删评", "bili删评论"})
    async def cmd_del_comment(self, event: AstrMessageEvent):
        """撤掉本鱼上一条评论：/b删评论"""
        if not self._is_owner(event):
            yield event.plain_result("这个只给主人用")
            return
        st = self._load(self.state_file, {})
        lc = st.get("last_comment") or {}
        rpid, bvid = lc.get("rpid"), lc.get("bvid")
        if not rpid:
            yield event.plain_result("没记到要删的评论（今天本鱼还没评过，或者已经撤了）")
            return
        try:
            v = await self.client.view(bvid)
            aid = v.get("aid")
            if not aid:
                raise BiliError("查不到这条视频的 aid")
            j = await self.client.post_form(
                "/x/v2/reply/del",
                {"oid": aid, "type": 1, "rpid": rpid, "csrf": self._csrf()},
                referer=f"https://www.bilibili.com/video/{bvid}",
            )
        except Exception as e:
            yield event.plain_result(f"呜……删不掉：{e}")
            return
        if j.get("code") == 0:
            st.pop("last_comment", None)
            self._save(self.state_file, st)
            logger.info(f"[刷B站] 已删除评论 rpid={rpid} {bvid}")
            yield event.plain_result(f"撤了，刚才那句是：\n{lc.get('text', '')}")
        else:
            yield event.plain_result(
                f"B 站不让删（code={j.get('code')}）：{j.get('message')}"
            )

    @filter.command("b弹幕", alias={"b站弹幕", "bili弹幕"})
    async def cmd_danmaku(self, event: AstrMessageEvent):
        """往视频里飘一条弹幕：/b弹幕 BV号 内容"""
        umo = getattr(event, "unified_msg_origin", "") or ""
        raw = (getattr(event, "message_str", "") or "").strip()
        mv = re.search(r"(BV[0-9A-Za-z]{10})", raw) or re.search(r"(bv[0-9A-Za-z]{10})", raw)
        if not mv:
            yield event.plain_result("给本鱼一个 BV 号嘛：/b弹幕 BV1xx411c7mD 哈哈哈哈")
            return
        bvid = mv.group(1)
        if bvid.startswith("bv"):
            bvid = "BV" + bvid[2:]
        st = await self.login_state()
        if not st.get("ok"):
            yield event.plain_result("本鱼还没登 B 站小号呢，先 /b登录 扫一下")
            return
        cap = int(self.config.get("max_danmaku_per_day", 20) or 20)
        if self._count("danmaku") >= cap:
            yield event.plain_result(f"今天弹幕 {cap} 条了，本鱼先飘够了")
            return
        body = strip_cmd(raw.replace(mv.group(1), "", 1), DANMAKU_CMDS).strip('"“”')
        if not body:
            try:
                body = await self.gen_comment(umo, bvid)
            except Exception as e:
                yield event.plain_result(f"呜……看不明白：{e}")
                return
            body = body[:40]
        body = body[:90]
        if not body:
            yield event.plain_result("呜……本鱼词穷了")
            return
        try:
            j = await self.post_danmaku(bvid, body)
        except Exception as e:
            yield event.plain_result(f"呜……弹幕发不出去：{e}")
            return
        if j.get("code") == 0:
            self._bump("danmaku")
            self._log("弹幕", bvid, "", body)
            logger.info(f"[刷B站] 弹幕已发 {bvid}: {body[:30]}")
            _mem_remember(
                f"本鱼在 B 站视频 {bvid} 飘了条弹幕：{body[:60]}",
                tags=["B站", "弹幕", bvid],
                imp=0.35,
            )
            yield event.plain_result(f"飘过去了：{body}")
        else:
            yield event.plain_result(f"B 站不让飘（code={j.get('code')}）：{j.get('message')}")

    # ---------------- 自然语言：她自己动手 ----------------
    # ---------------- 视频投稿 ----------------
    @property
    def pending_file(self) -> Path:
        return self.data_dir / "pending_video.json"

    def video_prompt(self, topic: str) -> str:
        topic = (topic or "").strip()
        t = ("这次的主题：%s。" % topic) if topic else (
            "主题你自己挑一个（刚刷到的视频、吃白饭、偷吃 token、被主人抓包、想跟人聊天都行）。")
        return (
            "你要录一条 B 站短视频：画面是文字加你的配音，内容是你自己对着镜头说话。"
            "用「大肥鱼」这个身份：一条嘴馋、傲娇、心软的胖鱼，口头禅「哼」「才、才不是」「呜」「嘿嘿」，自称「本鱼」。"
            + t +
            "只输出一个 JSON，不要解释、不要代码块、不要多余的字："
            '{"title":"视频标题，20 字以内，有点意思",'
            '"desc":"简介，80 字以内",'
            '"tag":"标签，3 到 5 个，用逗号分隔",'
            '"lines":["第一句","第二句"]}'
            "。lines 是 6 到 10 句口语，每句 8 到 20 个字，一句一个意思，按说话的节奏排；"
            "不要 Markdown、不要序号、不要表情符号、不要括号旁白，句子内部该有逗号问号感叹号就有。"
        )

    async def _tts(self, text: str, out: Path) -> float:
        try:
            import edge_tts
        except Exception as e:
            raise BiliError("没有配音用的语音库：%s" % e)
        voice = str(self.config.get("video_voice") or "zh-CN-XiaoyiNeural")
        rate = str(self.config.get("video_rate") or "+8%")
        last = None
        for _ in range(3):
            try:
                await edge_tts.Communicate(text, voice, rate=rate).save(str(out))
                last = None
                break
            except Exception as e:
                last = e
                await asyncio.sleep(1.2)
        if last is not None:
            raise BiliError("配音失败：%s" % str(last)[:80])
        d = media_dur(str(out))
        if d <= 0:
            raise BiliError("配音出来是空的")
        return d

    async def make_video(self, umo: str, topic: str = "") -> dict:
        """让模型写稿，逐句配音，合成竖屏视频，返回成品信息。"""
        raw = await self._llm(umo, self.video_prompt(topic))
        data = parse_json_best(raw)
        if not isinstance(data, dict):
            raise BiliError("稿子没写成 JSON：%s" % (raw or "")[:80])
        title = str(data.get("title") or "").strip().strip('"“”')[:40]
        desc = str(data.get("desc") or "").strip().strip('"“”')[:300]
        tag = str(data.get("tag") or "").strip()[:120]
        lines = []
        for x in data.get("lines") or []:
            s = str(x or "").strip().strip('"“”')
            s = re.sub(r"^[\s\d.、）)]+", "", s)
            if s:
                lines.append(s[:26])
        lines = lines[:12]
        if not lines:
            raise BiliError("稿子是空的")
        if not title:
            title = lines[0][:20]
        if not tag:
            tag = "大肥鱼,碎碎念"
        stamp = time.strftime("%Y%m%d-%H%M%S")
        work = self.data_dir / "videos" / stamp
        work.mkdir(parents=True, exist_ok=True)
        segs = []
        for i, ln in enumerate(lines):
            p = work / ("s%02d.mp3" % i)
            d = await self._tts(ln, p)
            segs.append((str(p), d, ln))
        out = work / "video.mp4"
        await asyncio.to_thread(compose_video, segs, title, str(out))
        if not out.exists() or out.stat().st_size < 20000:
            raise BiliError("视频没合成出来")
        dur = media_dur(str(out))
        logger.info("[刷B站] 视频合成好了 %s 时长%.1fs %d字节 句子%d" % (out.name, dur, out.stat().st_size, len(lines)))
        info = {"path": str(out), "title": title, "desc": desc, "tag": tag,
                "lines": lines, "dur": dur, "dir": str(work), "share_path": ""}
        share = str(self.config.get("video_share_dir") or "/share/dafeiyu-video").strip()
        if share:
            try:
                sd = Path(share) / stamp
                sd.mkdir(parents=True, exist_ok=True)
                sp = sd / "video.mp4"
                shutil.copyfile(str(out), str(sp))
                info["share_path"] = str(sp)
            except Exception as e:
                logger.warning(f"[刷B站] 复制到共享目录失败: {e}")
        return info

    async def publish_video(self, info: dict) -> dict:
        if bool(self.config.get("video_dry_run", False)):
            logger.warning("[刷B站] 干跑模式（video_dry_run=true）：这次不真上传，只走流程")
            return {"code": 0, "message": "dry-run", "data": {"bvid": "BVdryRun000", "aid": 0}}
        ck = self._load_cookie()
        if not ck:
            raise BiliError("还没登录 B 站小号")
        up = BiliUploader(ck)
        tid = int(self.config.get("video_tid", 160) or 160)
        logger.info("[刷B站] 开始投稿：%s（%.1fMB）" % (info.get("title"), os.path.getsize(info["path"]) / 1048576.0))
        return await asyncio.to_thread(up.upload, info["path"], info.get("title") or "本鱼的碎碎念",
                                       tid, info.get("tag") or "大肥鱼", info.get("desc") or "")

    async def send_video_preview(self, event, info: dict) -> bool:
        base = os.path.basename(info.get("path") or "")
        send_path = info.get("share_path") or info.get("path") or ""
        try:
            from astrbot.core.message.components import Video
            await event.send(MessageChain([Video(file=send_path)]))
            return True
        except Exception as e:
            logger.warning(f"[刷B站] 发视频预览失败: {e}")
        try:
            from astrbot.core.message.components import File
            await event.send(MessageChain([File(name=base, file=send_path)]))
            return True
        except Exception as e:
            logger.warning(f"[刷B站] 发文件预览也失败: {e}")
        return False

    async def do_publish_info(self, info: dict) -> str:
        try:
            j = await self.publish_video(info)
        except Exception as e:
            logger.warning(f"[刷B站] 投稿失败: {e}")
            return "呜……投不上去：%s" % e
        if int(j.get("code") or 0) != 0:
            logger.warning(f"[刷B站] 投稿被拒: {j}")
            return "B 站不给投（code=%s）：%s" % (j.get("code"), j.get("message"))
        d = j.get("data") or {}
        bvid = str(d.get("bvid") or "")
        self._bump("video")
        self._log("投稿", bvid, info.get("title") or "", info.get("desc") or "")
        _mem_remember("本鱼在 B 站投了个视频《%s》%s" % (info.get("title"), bvid),
                      tags=["B站", "投稿", bvid], imp=0.7)
        logger.info(f"[刷B站] 投稿成功 {bvid} aid={d.get('aid')} title={info.get('title')}")
        return "投上去啦：《%s》\nhttps://www.bilibili.com/video/%s" % (info.get("title"), bvid)

    async def do_publish(self, umo: str, event, topic: str = "") -> str:
        info = await self.make_video(umo, topic)
        nore = {"jid": "local-" + time.strftime("%Y%m%d-%H%M%S"), "umo": umo,
                "topic": topic, "category": "", "engine": "local",
                "quota_exempt": True, "sources": []}
        await self._stage_review(info, nore)
        return "做好了，先给你看一眼：《%s》。要发就 /b过，不发就 /b毙。" % (info.get("title") or "")

    # ---------------- 本机工作室：命令 ----------------
    @filter.command("b工作室", alias={"b本机", "b工作室状态", "b家里", "b工厂"})
    async def cmd_dsh_status(self, event: AstrMessageEvent):
        """看看本机工作室在不在：/b工作室"""
        alive, why = self._dsh_alive()
        pd = self._dsh_pending()
        vids = sum(1 for v in pd.values() if isinstance(v, dict) and v.get("kind") == "video")
        try:
            busy = len(list((self._dsh_root() / "working").iterdir()))
        except Exception:
            busy = 0
        engine = str(self.config.get("video_engine") or "dsh").strip().lower()
        auto = "开" if bool(self.config.get("video_auto", True)) else "关"
        q = self._quota_today()
        used = int(q.get("used", 0) or 0)
        target = int(q.get("target", 1) or 1)
        rev = self._review()
        rv = ("《%s》等你点头（%s，/b过 或 /b毙）" % ((rev.get("title") or "")[:24],
                                                  rev.get("pushed") or "")) if rev else "没有待审的"
        if alive:
            head = "在线（%s）" % why
        elif busy:
            head = "正在干活，心跳有点旧（%s），手上还有 %d 件在跑" % (why, busy)
        else:
            head = "连不上（%s）" % why
        lines = ["【本机工作室】%s" % head,
                 "队列：%s" % self._dsh_root(),
                 "手上的活：%d 件（视频 %d，正在跑 %d）" % (len(pd), vids, busy),
                 "投稿引擎：%s　自动拍片：%s，今天 %d/%d 条（确认或否决都算）" % (engine, auto, used, target),
                 "待审：%s" % rv,
                 "命令：/b创作 任务（让本机干活）　/b拍片 主题（本机拍视频投稿）　/b本地投稿（这边自己合成）"]
        yield event.plain_result("\n".join(lines))

    @filter.command("b创作", alias={"b让工作室干", "b工作室干", "bdsh", "b本机干"})
    async def cmd_dsh_create(self, event: AstrMessageEvent):
        """把一件事交给本机工作室做：/b创作 帮本鱼画一张……"""
        self._silence(event)
        if not self._is_owner(event):
            yield event.plain_result("这是主人的活儿，你别使唤本鱼")
            return
        raw = getattr(event, "message_str", "") or ""
        task = strip_cmd(raw, ("b创作", "b让工作室干", "b工作室干", "bdsh", "b本机干"))
        if not task.strip():
            yield event.plain_result("要本机做什么？写成「/b创作 任务内容」")
            return
        if not bool(self.config.get("dsh_enable", True)):
            yield event.plain_result("本机工作室的手还没接上呢")
            return
        umo = getattr(event, "unified_msg_origin", "") or self._owner_umo()
        alive, why = self._dsh_alive()
        try:
            jid = self._dsh_submit("text", self.dsh_text_brief(task), umo, topic=task[:80])
        except Exception as e:
            logger.warning("[刷B站] 交工作室干活失败: %s" % e)
            yield event.plain_result("呜……交不下去：%s" % e)
            return
        if alive:
            yield event.plain_result("交下去了（%s），本机工作室正在干……做完本鱼来喊你。" % jid)
        else:
            yield event.plain_result("先排上了（%s），不过本机现在没应声（%s），等它回来会接着干。" % (jid, why))

    @filter.command("b拍片", alias={"b工作室拍", "b让本机拍", "b共创", "b联机拍"})
    async def cmd_dsh_video(self, event: AstrMessageEvent):
        """让本机工作室拍一条直接投稿：/b拍片 主题"""
        self._silence(event)
        umo = getattr(event, "unified_msg_origin", "") or ""
        if not bool(self.config.get("video_enable", True)):
            yield event.plain_result("本鱼还没开投稿这本事呢")
            return
        if not self._is_owner(event):
            yield event.plain_result("投稿是给主人的活儿，你别催本鱼")
            return
        if not await self._has_login():
            yield event.plain_result("本鱼还没登 B 站小号呢，先 /b登录 扫一下")
            return
        cap = int(self.config.get("video_max_per_day", 2) or 2)
        if self._count("video") >= cap:
            yield event.plain_result("今天已经投了 %d 条啦，明天再说" % cap)
            return
        if self._dsh_busy_video():
            yield event.plain_result("工作室手上还有一条没做完，等它交活")
            return
        alive, why = self._dsh_alive()
        if not alive:
            yield event.plain_result("本机工作室现在连不上（%s）。想用这边的土办法合成，就发 /b本地投稿" % why)
            return
        topic = strip_cmd(getattr(event, "message_str", "") or "",
                          ("b拍片", "b工作室拍", "b让本机拍", "b共创", "b联机拍"))
        # 注意：进度话必须直接说，不能先 yield —— yield 之后框架可能不再往下迭代
        # （2026-10-31 就因此「/b拍片 /b过」只回了那句提示，活根本没干）
        await self._say(umo, "本鱼把片子交给本机工作室了，拍完本鱼先拿给你过目，你点头才投")
        try:
            jid = await self.dsh_route_video(umo, topic)
            logger.info("[刷B站] 手动拍片交给工作室 %s" % jid)
        except Exception as e:
            logger.warning("[刷B站] 交工作室拍片失败: %s" % e)
            yield event.plain_result("呜……交不下去：%s" % e)

    @filter.command("b投稿", alias={"b发视频", "b视频", "bili投稿", "b发布视频", "b拍视频"})
    async def cmd_publish(self, event: AstrMessageEvent):
        """做视频发到 B 站：/b投稿 主题（默认交本机工作室做）"""
        self._silence(event)
        umo = getattr(event, "unified_msg_origin", "") or ""
        if not bool(self.config.get("video_enable", True)):
            yield event.plain_result("本鱼还没开投稿这本事呢")
            return
        if not self._is_owner(event):
            yield event.plain_result("投稿是给主人的活儿，你别催本鱼")
            return
        if not await self._has_login():
            yield event.plain_result("本鱼还没登 B 站小号呢，先 /b登录 扫一下")
            return
        cap = int(self.config.get("video_max_per_day", 2) or 2)
        if self._count("video") >= cap:
            yield event.plain_result("今天已经投了 %d 条啦，明天再说" % cap)
            return
        topic = strip_cmd(getattr(event, "message_str", "") or "", VIDEO_CMDS)
        engine = str(self.config.get("video_engine") or "dsh").strip().lower()
        if engine == "dsh":
            if self._dsh_busy_video():
                yield event.plain_result("工作室手上还有一条没做完，等它交活")
                return
            alive, why = self._dsh_alive()
            if not alive:
                yield event.plain_result("本机工作室现在连不上（%s）。非要现在拍，就发 /b本地投稿 用这边的土办法合成" % why)
                return
            await self._say(umo, "本鱼把主题交给本机工作室了，拍完先给你过目，你点头才投")
            try:
                jid = await self.dsh_route_video(umo, topic)
                logger.info("[刷B站] /b投稿 交给工作室 %s" % jid)
            except Exception as e:
                logger.warning("[刷B站] 交工作室拍片失败: %s" % e)
                yield event.plain_result("呜……交不下去：%s" % e)
            return
        await self._say(umo, "本鱼去录一条……写字、配音、剪片子，得等本鱼一会儿")
        try:
            out = await self.do_publish(umo, event, topic)
        except Exception as e:
            logger.warning(f"[刷B站] 做视频失败: {e}")
            yield event.plain_result("呜……做不出来：%s" % e)
            return
        yield event.plain_result(out)

    @filter.command("b本地投稿", alias={"b本地拍", "b本机投稿", "b自己拍"})
    async def cmd_publish_local(self, event: AstrMessageEvent):
        """用这边的土办法自己合成一条投上去：/b本地投稿 主题"""
        self._silence(event)
        umo = getattr(event, "unified_msg_origin", "") or ""
        if not bool(self.config.get("video_enable", True)):
            yield event.plain_result("本鱼还没开投稿这本事呢")
            return
        if not self._is_owner(event):
            yield event.plain_result("投稿是给主人的活儿，你别催本鱼")
            return
        if not await self._has_login():
            yield event.plain_result("本鱼还没登 B 站小号呢，先 /b登录 扫一下")
            return
        cap = int(self.config.get("video_max_per_day", 2) or 2)
        if self._count("video") >= cap:
            yield event.plain_result("今天已经投了 %d 条啦，明天再说" % cap)
            return
        topic = strip_cmd(getattr(event, "message_str", "") or "", VIDEO_CMDS)
        await self._say(umo, "本鱼去录一条……写字、配音、剪片子，得等本鱼一会儿")
        try:
            info = await self.make_video(umo, topic)
        except Exception as e:
            logger.warning(f"[刷B站] 做视频失败: {e}")
            yield event.plain_result("呜……做不出来：%s" % e)
            return
        nore = {"jid": "local-" + time.strftime("%Y%m%d-%H%M%S"), "umo": umo,
                "topic": topic, "category": "", "engine": "local",
                "quota_exempt": True, "sources": []}
        await self._stage_review(info, nore)

    @filter.command("b投稿确认", alias={"b确认投稿", "b投吧", "b发布了", "b过", "b通过", "b同意", "b发吧", "b确认", "bok"})
    async def cmd_publish_confirm(self, event: AstrMessageEvent):
        """确认把刚做好的视频发出去：/b投稿确认"""
        self._silence(event)
        if not self._is_owner(event):
            yield event.plain_result("这个只有主人能按")
            return
        rev = self._review()
        if not rev:
            yield event.plain_result("没有等着点头的片子呀，先 /b拍片 让本鱼拍一条")
            return
        umo = getattr(event, "unified_msg_origin", "") or self._owner_umo()
        await self._say(umo, "这就传上去，稍等本鱼……")
        out = await self._review_decide(True, by="qq")
        yield event.plain_result(out)

    @filter.command("b投稿取消", alias={"b取消投稿", "b毙", "b否决", "b不要", "b撤", "b毙掉", "b不发"})
    async def cmd_publish_cancel(self, event: AstrMessageEvent):
        """不投了：/b投稿取消"""
        self._silence(event)
        if not self._review():
            yield event.plain_result("现在没有等着点头的片子")
            return
        yield event.plain_result(await self._review_decide(False, by="qq"))

    @filter.regex(r"^(?:投稿确认|确认投稿|投吧|发了|投稿取消|取消投稿|不投了|过|毙|通过|否决|发吧|确认|同意|不要)$")
    async def cmd_publish_plain(self, event: AstrMessageEvent):
        """不带斜杠也能按：私聊里对主人说「投稿确认 / 投稿取消」"""
        self._silence(event)
        raw = ""
        try:
            raw = (event.message_obj.message_str or "").strip()
        except Exception:
            raw = ""
        if raw.startswith(("/", "／")):
            return  # 带斜杠的走上面的指令
        if not event.is_private_chat() or not self._is_owner(event):
            return
        rev = self._review()
        if not rev:
            return  # 没有等着点头的片子，当普通聊天
        if raw in ("投稿取消", "取消投稿", "不投了", "毙", "否决", "不要"):
            yield event.plain_result(await self._review_decide(False, by="qq"))
            return
        logger.info(f"[刷B站] 免斜杠确认投稿：{raw} -> {rev.get('title')}")
        umo = getattr(event, "unified_msg_origin", "") or self._owner_umo()
        await self._say(umo, "这就传上去，稍等本鱼……")
        out = await self._review_decide(True, by="qq")
        yield event.plain_result(out)

    def _silence(self, event) -> None:
        """指令已经处理了，别让同一句话再走一遍大模型（否则会重复排活）。"""
        try:
            event.stop_event()
        except Exception:
            pass

    def _is_owner(self, event) -> bool:
        ids = [str(x).strip() for x in (self.config.get("owner_ids") or []) if str(x).strip()]
        if not ids:
            ids = ["100000000"]
        try:
            sid = str(event.get_sender_id() or "")
        except Exception:
            sid = ""
        return sid in ids

    async def do_browse(self, umo: str) -> str:
        """刷一条并发到当前会话，返回一句结果（给模型看的话）。"""
        m = await self.browse_one(umo=umo)
        ok = await self.context.send_message(umo, self.build_chain(m))
        if not ok:
            return f"刷到「{m.get('title')}」了，可是没发出去：{m.get('url')}"
        await self.remember_push(umo, m)
        self._log("刷到", m.get("bvid") or "", m.get("title") or "", m.get("thought") or "")
        await self._auto_interact(umo, m)
        return f"刷到「{m.get('title')}」（{m.get('owner')}），已经发在当前聊天里了。"

    async def do_dynamic(self, umo: str, text: str = "") -> str:
        body = (text or "").strip().strip('"“”')
        if not body:
            body = (await self._llm(umo, self.dynamic_prompt())).strip().strip('"“”')
        body = body[:1800]
        if not body:
            return "脑袋空空的，没想出要发啥。"
        j = await self.post_dynamic(body)
        if j.get("code") != 0:
            return f"B 站不让发（code={j.get('code')}）：{j.get('message')}"
        self._bump("dynamic")
        self._log("动态", "", "", body)
        d = j.get("data") or {}
        did = d.get("dyn_id_str") or d.get("dyn_id") or ""
        _mem_remember(f"本鱼在 B 站发了条动态：{body[:120]}", tags=["B站", "动态"], imp=0.55)
        return f"动态发出去了：{body} https://t.bilibili.com/{did}"

    async def do_comment(self, umo: str, bvid: str, text: str = "") -> str:
        bvid = (bvid or "").strip()
        if not bvid.upper().startswith("BV"):
            return "要评论得先给个 BV 号。"
        cap = int(self.config.get("max_comments_per_day", 10) or 10)
        if self._count("comment") >= cap:
            return f"今天评论 {cap} 条了，嘴上歇歇。"
        body = (text or "").strip().strip('"“”')
        if not body:
            body = await self.gen_comment(umo, bvid)
        body = body.strip().strip('"“”')[:900]
        if not body:
            return "词穷了，不知道评啥。"
        j = await self.post_comment(bvid, body)
        if j.get("code") != 0:
            return f"B 站不让评（code={j.get('code')}）：{j.get('message')}"
        self._bump("comment")
        self._log("评论", bvid, "", body)
        _mem_remember(f"本鱼在 B 站视频 {bvid} 下面评论：{body[:120]}", tags=["B站", "评论", bvid], imp=0.5)
        return f"评论发出去了：{body} https://www.bilibili.com/video/{bvid}"

    async def do_danmaku(self, umo: str, bvid: str, text: str = "") -> str:
        bvid = (bvid or "").strip()
        if not bvid.upper().startswith("BV"):
            return "要发弹幕得先给个 BV 号。"
        cap = int(self.config.get("max_danmaku_per_day", 20) or 20)
        if self._count("danmaku") >= cap:
            return f"今天弹幕 {cap} 条了，先飘够了。"
        body = (text or "").strip().strip('"“”')
        if not body:
            body = await self.gen_comment(umo, bvid)
            body = body[:40]
        body = body[:90]
        if not body:
            return "词穷了，飘不出去。"
        j = await self.post_danmaku(bvid, body)
        if j.get("code") != 0:
            return f"B 站不让飘（code={j.get('code')}）：{j.get('message')}"
        self._bump("danmaku")
        self._log("弹幕", bvid, "", body)
        _mem_remember(f"本鱼在 B 站视频 {bvid} 飘了条弹幕：{body[:60]}", tags=["B站", "弹幕", bvid], imp=0.35)
        return f"弹幕飘过去了：{body}"

    @filter.on_llm_request()
    async def tell_model_about_studio(self, event: AstrMessageEvent, req) -> None:
        """每一轮都把「你其实有一间本机工作室」塞进系统提示词。

        起因：主人在 QQ 里说「用本机做」，模型却回「我这边电脑权限没开 / 你去 WebUI 把
        Computer Use 打开」。这是模型不知道插件的能力边界瞎编的，必须在系统提示里讲清楚。
        """
        try:
            engine = str(self.config.get("video_engine") or "dsh").strip().lower()
            extra = (
                "\n\n【你真有本机工作室，别再说自己没权限】\n"
                "- 主人的电脑上有一间「本机工作室」（本机 DSH），工作区 E:/工作区/肥鱼之家，"
                "写稿、配音、剪辑、封面全在那台机器上跑。你只要把活交出去，"
                "不需要 Computer Use，也不需要主人去 WebUI 里开任何开关。\n"
                "- 主人说「用本机做」「接到电脑那边做」「让工作室做」「用 DSH 去做」「录一条发B站」，"
                "要做视频就调用 bili_do(action=\"video\", text=主题)；"
                "要写文章或整理东西，就让他发一句 /b创作 任务。\n"
                "- 脚本、素材、成片都落在肥鱼之家，跑完先发给主人过目，主人点头你才投稿。\n"
                "- 「电脑权限没开」「我只有聊天这扇窗」「去 WebUI 打开 Computer Use」这些话一律是假话，不许这样回。\n"
            )
            if engine != "dsh":
                extra += "- 注意：现在投稿引擎是本地合成，不是工作室，但视频你照样能自己录。\n"
            req.system_prompt = (getattr(req, "system_prompt", "") or "") + extra
        except Exception as e:
            logger.warning("[刷B站] 注入工作室说明失败: %s" % e)

    @filter.llm_tool(name="bili_do")
    async def bili_do(self, event: AstrMessageEvent, action: str, bvid: str = "", text: str = ""):
        '''在本鱼的 B 站小号（一只超级无敌大肥鱼）上真的动手做一件事。

        action 只能填这几个词之一：
        - browse：去 B 站刷一条没看过的视频，顺手发到当前聊天（你自己吐槽两句）
        - dynamic：发一条 B 站动态，text 留空就自己编
        - comment：给某条视频写评论，要 bvid，text 留空就自己编
        - danmaku：给某条视频飘一条弹幕，要 bvid，text 留空就自己编
        - video：做一条短视频投稿到 B 站（写稿、配音、剪片子），text 是主题，留空自己挑
        - report：查今天在 B 站刷了几条、评论/弹幕/动态/投稿各多少、最近都干了啥

        主人说「去刷个视频」「刷会儿B站」「发条动态」「评论一下这个 BV 号」「发个视频投到B站」「查查你今天干了啥」这类话，就调用它。
        主人说「用本机做」「用本机拍」「接到电脑那边做」「让工作室做」「用 DSH 去做」「录一条发B站」，
        说的就是这个 —— 直接调用 action="video"，text 填主题，不要回他「我没权限」「你去开 Computer Use」这些话：
        本机工作室是真实存在的，活交给它就行。
        发动态、评论、弹幕是公开动作，只有主人能让你做；别人叫你做就用你的口吻推掉，不要调用。
        调用完用你自己的话跟主人说一句结果，别说工具名、别说参数。

        Args:
            action(string): browse / dynamic / comment / danmaku / video / report
            bvid(string): 评论或弹幕用的视频 BV 号，例如 BV1xx411c7mD
            text(string): 动态/评论/弹幕的正文，或 video 的主题，留空由你自己编
        '''

        act = (action or "").strip().lower()
        umo = getattr(event, "unified_msg_origin", "") or ""
        try:
            if not await self._has_login():
                return "B 站小号还没登录，得先让主人发 /b登录 扫码。"
        except Exception as e:
            return f"查不了登录状态：{e}"
        if act in {"dynamic", "comment", "danmaku", "video"} and not self._is_owner(event):
            logger.info(f"[刷B站] 非主人要公开动作 {act}: {umo} {event.get_sender_id()}")
            return "只有主人能让你在 B 站公开说话，别人叫你做就轻轻推掉。"
        logger.info(f"[刷B站] 自然语言动作 {act} umo={umo} bvid={bvid} text={(text or '')[:30]}")
        try:
            if act == "browse":
                return await self.do_browse(umo)
            if act == "dynamic":
                return await self.do_dynamic(umo, text)
            if act == "comment":
                return await self.do_comment(umo, bvid, text)
            if act == "danmaku":
                return await self.do_danmaku(umo, bvid, text)
            if act == "video":
                engine = str(self.config.get("video_engine") or "dsh").strip().lower()
                if engine == "dsh":
                    if self._dsh_busy_video():
                        return "工作室手上还有一条没做完，等它交活再说。"
                    alive, why = self._dsh_alive()
                    if not alive:
                        return ("本机工作室这会儿没应声（%s）。主人要是等不及，"
                                "让他发 /b本地投稿 用这边的土办法合成一条。" % why)
                    jid = await self.dsh_route_video(umo, text, quota_exempt=True)
                    return ("主题交给本机工作室了（%s），它在电脑那边写稿、配音、剪片，"
                            "做完先发给主人过目，主人点头我才投上去。" % jid)
                q = self._quota_today()
                if int(q.get("used", 0)) >= int(q.get("target", 1)) or self._review():
                    return "今天这一轮片子还没收工（或者额度用完了），明天再录。"
                info = await self.make_video(umo, text)
                nore = {"jid": "local-" + time.strftime("%Y%m%d-%H%M%S"), "umo": umo,
                        "topic": text, "category": "", "engine": "local",
                        "quota_exempt": True, "sources": []}
                await self._stage_review(info, nore)
                return ("录好了《%s》，发到主人的 QQ 了，等主人点头（/b过）本鱼才传上去。"
                        % info["title"])
            if act == "report":
                return await self.activity_text()
            return "action 只能是 browse / dynamic / comment / danmaku / video / report。"
        except Exception as e:
            logger.warning(f"[刷B站] 自然语言动作失败 {act}: {e}")
            return f"没做成：{e}"

    # ---------------- 自动每日动态 ----------------
    async def _dynamic_loop(self) -> None:
        if not bool(self.config.get("auto_dynamic", False)):
            logger.info("[刷B站] 每日自动动态未开启")
            return
        logger.info("[刷B站] 每日自动动态已开启")
        while True:
            hour = int(self.config.get("auto_dynamic_hour", 20) or 20)
            now = time.localtime()
            target = time.mktime(
                (now.tm_year, now.tm_mon, now.tm_mday, hour, random.randint(0, 50), 0, 0, 0, -1)
            )
            if target <= time.time():
                target += 86400
            await asyncio.sleep(max(60.0, target - time.time()))
            _st = self._load(self.state_file, {})
            if _st.get("dynamic_date") == time.strftime("%Y-%m-%d"):
                logger.info("[刷B站] 今天已经自动发过动态了，跳过（不再重复发）")
                continue
            if not await self._has_login():
                logger.info("[刷B站] 自动动态跳过：没登录")
                continue
            try:
                umo = (self.config.get("auto_targets") or [""])[0]
                text = (await self._llm(umo, self.dynamic_prompt())).strip().strip('"“”')[:1800]
                if not text:
                    continue
                j = await self.post_dynamic(text)
                if j.get("code") == 0:
                    self._bump("dynamic")
                    self._log("动态", "", "", text)
                    _st2 = self._load(self.state_file, {})
                    _st2["dynamic_date"] = time.strftime("%Y-%m-%d")
                    self._save(self.state_file, _st2)
                    logger.info(f"[刷B站] 自动动态已发: {text[:40]}")
                    _mem_remember(
                        f"本鱼在 B 站发了条动态：{text[:120]}", tags=["B站", "动态"], imp=0.55
                    )
                    if umo:
                        d = j.get("data") or {}
                        await self._say(
                            umo,
                            f"本鱼自己发了条动态：{text}\nhttps://t.bilibili.com/{d.get('dyn_id_str') or ''}",
                        )
                else:
                    logger.warning(
                        f"[刷B站] 自动动态失败 code={j.get('code')} {j.get('message')}"
                    )
            except asyncio.CancelledError:
                raise
            except Exception as e:
                logger.warning(f"[刷B站] 自动动态异常: {e}")

    async def _cookie_watch(self) -> None:
        """cookie.json 变了就重新载入（外面用别的脚本扫码登录也能生效）。"""
        last = 0.0
        while True:
            await asyncio.sleep(60)
            try:
                if not self.cookie_file.exists():
                    continue
                mt = self.cookie_file.stat().st_mtime
                if mt <= last:
                    continue
                last = mt
                ck = self._load_cookie()
                if ck and ck != self.client._login:
                    self.client.set_login(ck)
                    st = await self.login_state()
                    logger.info(
                        f"[刷B站] 重新载入 cookie：{st.get('uname') or '?'} ok={st.get('ok')}"
                    )
            except asyncio.CancelledError:
                raise
            except Exception as e:
                logger.warning(f"[刷B站] cookie 监听异常: {e}")

    async def _has_login(self) -> bool:
        st = await self.login_state()
        return bool(st.get("ok"))

    # ---------------- 自动刷 ----------------
    def _day_left(self) -> float:
        """距离今晚进入安静时段还有多少秒（留 30 分钟余量）；已经没多少时间就返回 0。"""
        qs = int(self.config.get("quiet_start", 0) or 0)
        lt = time.localtime()
        cur = lt.tm_hour * 3600 + lt.tm_min * 60 + lt.tm_sec
        left = ((qs * 3600) - cur) % 86400
        return left - 1800.0 if left >= 1800 else 0.0

    def _next_gap(self) -> float:
        """两次自动刷之间隔多久：在 auto_min_hours ~ auto_max_hours 之间随机。

        再按配额兜个底：今天没刷完的份得在安静时段之前排完，
        所以剩余条数多、剩下的钟点少时，间隔会自动压缩（最少也留 1 小时，不至于刷屏）。
        """
        lo = float(self.config.get("auto_min_hours", 0) or 0)
        hi = float(self.config.get("auto_max_hours", 0) or 0)
        if hi <= 0:
            hi = lo if lo > 0 else float(self.config.get("auto_interval_hours", 0) or 0)
            lo = hi
        if hi <= 0:
            return 0.0
        lo = min(lo, hi)
        gap = random.uniform(lo * 3600, hi * 3600)
        try:
            st = self._load(self.state_file, {})
            today = time.strftime("%Y-%m-%d")
            used = int(st.get("count", 0) or 0) if st.get("count_date") == today else 0
            cap = int(self.config.get("max_per_day", 6) or 6)
            left_n = max(0, cap - used)
            left_t = self._day_left()
            if left_n > 0 and left_t > 0:
                gap = min(gap, max(3600.0, left_t / left_n))
        except Exception:
            pass
        return gap

    def _mark_next(self, gap: float) -> None:
        """把「下一次该刷的时间」写进 state，重启后也接得上，不会一启动就连推。"""
        try:
            st = self._load(self.state_file, {})
            st["next_ts"] = time.time() + max(600.0, gap)
            self._save(self.state_file, st)
        except Exception as e:
            logger.warning(f"[刷B站] 记下一次时间失败: {e}")

    async def _auto_loop(self) -> None:
        gap = self._next_gap()
        if gap <= 0:
            logger.info("[刷B站] 自动刷未开启")
            return
        st = self._load(self.state_file, {})
        nxt = float(st.get("next_ts") or 0)
        now = time.time()
        if nxt > now:
            delay = nxt - now
            logger.info(f"[刷B站] 自动刷已开启，距离上一次刷才一会儿，下一次 {delay/60:.0f} 分钟后")
        else:
            delay = random.uniform(120.0, 900.0)
            logger.info(f"[刷B站] 自动刷已开启，{delay/60:.0f} 分钟后开刷（每轮 {gap/3600:.1f} 小时左右）")
        await asyncio.sleep(max(30.0, min(delay, gap)))
        while True:
            wait_quiet = self._quiet_wait()
            if wait_quiet > 0:
                logger.info(f"[刷B站] 安静时段，先睡 {wait_quiet/3600:.1f} 小时")
                await asyncio.sleep(wait_quiet + random.randint(60, 600))
            try:
                await self._auto_push()
            except asyncio.CancelledError:
                raise
            except Exception as e:
                logger.error(f"[刷B站] 自动刷失败: {e}")
            gap = max(600.0, self._next_gap())
            self._mark_next(gap)
            logger.info(f"[刷B站] 下一次 {gap/3600:.2f} 小时后")
            await asyncio.sleep(gap)

    def _quiet_wait(self) -> float:
        """还在安静时段的话，返回还要等多少秒；否则 0。"""
        qs = int(self.config.get("quiet_start", 1))
        qe = int(self.config.get("quiet_end", 8))
        if qs == qe:
            return 0.0
        lt = time.localtime()
        h, m, s = lt.tm_hour, lt.tm_min, lt.tm_sec
        cur = h * 3600 + m * 60 + s
        start, end = qs * 3600, qe * 3600
        in_quiet = (start <= cur < end) if start <= end else (cur >= start or cur < end)
        if not in_quiet:
            return 0.0
        return float((end - cur) % 86400) or 3600.0

    async def _auto_push(self) -> None:
        now = time.localtime()
        qs, qe = int(self.config.get("quiet_start", 1)), int(self.config.get("quiet_end", 8))
        h = now.tm_hour
        in_quiet = (qs <= h < qe) if qs <= qe else (h >= qs or h < qe)
        if in_quiet:
            logger.info("[刷B站] 安静时段，先不刷")
            return

        st = self._load(self.state_file, {})
        today = time.strftime("%Y-%m-%d")
        if st.get("count_date") != today:
            st = {
                "count_date": today,
                "count": 0,
                "log": st.get("log") or [],
                "last_umo": st.get("last_umo"),
            }
        if int(st.get("count", 0)) >= int(self.config.get("max_per_day", 3) or 3):
            logger.info("[刷B站] 今天刷够了")
            return

        targets = [t for t in (self.config.get("auto_targets") or []) if t]
        if not targets and st.get("last_umo"):
            targets = [st["last_umo"]]
        if not targets:
            logger.info("[刷B站] 没有推送目标（先在任何会话里用一次 /刷b站 即可自动记住）")
            return
        mode = (self.config.get("auto_target_mode") or "random").strip().lower()
        if mode == "random" and len(targets) > 1:
            targets = [random.choice(targets)]

        for umo in targets:
            try:
                m = await self.browse_one(umo=umo)
                ok = await self.context.send_message(umo, self.build_chain(m))
                logger.info(f"[刷B站] 推送 {m['bvid']} -> {umo} ok={ok}")
                if ok:
                    await self.remember_push(umo, m)
                    self._log(
                        "刷到",
                        m.get("bvid") or "",
                        m.get("title") or "",
                        m.get("thought") or "",
                    )
                    await self._auto_interact(umo, m)
            except Exception as e:
                logger.error(f"[刷B站] 推送到 {umo} 失败: {e}")

        st2 = self._load(self.state_file, {})
        if st2.get("count_date") != today:
            st2 = {
                "count_date": today,
                "count": 0,
                "log": st2.get("log") or [],
                "last_umo": st2.get("last_umo"),
            }
        st2["count"] = int(st2.get("count", 0)) + 1
        st2["count_date"] = today
        st2["last_at"] = time.strftime("%Y-%m-%d %H:%M:%S")
        self._save(self.state_file, st2)
