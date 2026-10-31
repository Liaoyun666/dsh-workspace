# -*- coding: utf-8 -*-
"""大肥鱼的记忆库（共享模块）。

被两个插件同时使用，所以：
  * 不 import astrbot —— 任何插件都能直接加载；
  * 只认一个文件 memories.json，谁先配置谁定路径，之后共用；
  * 全部读写走同一把线程锁 + 原子替换，避免两个插件同时写坏文件。

条目结构：
    {"id": "m3f9a1c2e", "text": "主人喜欢喝冰美式", "tags": ["主人", "咖啡"],
     "src": "qq群:1109339326", "imp": 0.7, "at": 1761750000.0, "used": 3}
"""

from __future__ import annotations

import json
import math
import os
import re
import tempfile
import threading
import time
import uuid

_LOCK = threading.RLock()
_INSTANCE = {"s": None}

# 记忆文件默认同目录
_FILE_NAME = "memories.json"

_STOP = set(
    "的 了 是 我 你 他 她 它 吗 呢 啊 呀 哦 嗯 哈 就 都 也 和 跟 在 有 没 不 很 太 这 那 个 一 上 下 去 来 "
    "说 要 想 会 能 把 被 给 让 还 又 再 才 但 而 只 里 吧 啦 嘛 么 谁 哪 什么 怎么 这样 那样 一下 现在 "
    "我们 你们 他们 自己 时候 什么 可以 应该 因为 所以 但是 如果 就是 还是 已经 一个 这个 那个".split()
)
_WORD = re.compile(r"[A-Za-z0-9_]{2,}")
_CJK = re.compile(r"[\u4e00-\u9fff]+")


def tokens(text: str) -> set:
    """粗分词：英文/数字按词，中文按二元组（bigram）。够用且不用装分词库。"""
    t = (text or "").lower()
    out = set()
    for w in _WORD.findall(t):
        out.add(w)
    for seg in _CJK.findall(t):
        if len(seg) == 1:
            if seg not in _STOP:
                out.add(seg)
            continue
        for i in range(len(seg) - 1):
            bg = seg[i : i + 2]
            if bg not in _STOP:
                out.add(bg)
    return out


def _now() -> float:
    return time.time()


def _short_id() -> str:
    return "m" + uuid.uuid4().hex[:9]


class MemoryStore:
    def __init__(self, path=None, max_items: int = 800):
        self.path = path or _FILE_NAME
        self.max_items = int(max_items or 800)

    # ---------- 文件 ----------
    def _load(self) -> dict:
        try:
            with open(self.path, "r", encoding="utf-8") as f:
                d = json.load(f)
            if isinstance(d, dict) and isinstance(d.get("items"), list):
                return d
        except FileNotFoundError:
            pass
        except Exception:
            pass
        return {"version": 1, "items": []}

    def _save(self, d: dict) -> None:
        folder = os.path.dirname(os.path.abspath(self.path))
        if folder and not os.path.isdir(folder):
            os.makedirs(folder, exist_ok=True)
        fd, tmp = tempfile.mkstemp(dir=folder or ".", prefix=".mem-", suffix=".tmp")
        try:
            with os.fdopen(fd, "w", encoding="utf-8") as f:
                json.dump(d, f, ensure_ascii=False, indent=1)
            os.replace(tmp, self.path)
        except Exception:
            try:
                os.unlink(tmp)
            except Exception:
                pass
            raise

    # ---------- 写 ----------
    def add(self, text: str, tags=None, src: str = "qq", imp: float = 0.5, key: str = "") -> dict:
        """记一条。重复（同 text 或同 key）就把旧条目的重要度抬上去、刷新时间。"""
        text = re.sub(r"\s+", " ", (text or "")).strip()
        if len(text) < 4:
            return {}
        tags = [str(t).strip() for t in (tags or []) if str(t).strip()][:8]
        imp = max(0.0, min(1.0, float(imp if imp is not None else 0.5)))
        with _LOCK:
            d = self._load()
            items = d["items"]
            norm = text.lower()
            for it in items:
                if (key and it.get("key") == key) or (it.get("text") or "").lower() == norm:
                    it["imp"] = max(float(it.get("imp") or 0.5), imp)
                    it["at"] = _now()
                    if tags:
                        it["tags"] = list(dict.fromkeys((it.get("tags") or []) + tags))[:8]
                    self._save(d)
                    return it
            it = {
                "id": _short_id(),
                "text": text,
                "tags": tags,
                "src": src,
                "imp": imp,
                "at": _now(),
                "used": 0,
            }
            if key:
                it["key"] = key
            items.append(it)
            self._prune(d)
            self._save(d)
            return it

    def _prune(self, d: dict) -> None:
        items = d["items"]
        if len(items) <= self.max_items:
            return
        now = _now()

        def keep_score(it):
            age = max(0.0, (now - float(it.get("at") or now)) / 86400.0)
            return 0.55 * float(it.get("imp") or 0.5) + 0.45 * math.exp(-age / 60.0)

        items.sort(key=keep_score, reverse=True)
        del items[self.max_items :]

    # ---------- 读 ----------
    def all(self) -> list:
        with _LOCK:
            return list(self._load()["items"])

    def count(self) -> int:
        return len(self.all())

    def search(self, query: str, k: int = 5, min_score: float = 0.08) -> list:
        qt = tokens(query)
        if not qt:
            return self.recent(k)
        now = _now()
        scored = []
        for it in self.all():
            mt = tokens((it.get("text") or "") + " " + " ".join(it.get("tags") or []))
            if not mt:
                continue
            inter = len(qt & mt)
            if not inter:
                continue
            cover = inter / max(1, len(qt))
            dice = 2.0 * inter / (len(qt) + len(mt))
            age = max(0.0, (now - float(it.get("at") or now)) / 86400.0)
            rec = math.exp(-age / 45.0)
            imp = float(it.get("imp") or 0.5)
            used = min(1.0, math.log1p(float(it.get("used") or 0)) / 3.0)
            s = 0.62 * (0.6 * cover + 0.4 * dice) + 0.16 * rec + 0.14 * imp + 0.08 * used
            if s >= min_score:
                scored.append((s, it))
        scored.sort(key=lambda x: x[0], reverse=True)
        out = []
        for s, it in scored[: max(1, int(k))]:
            it = dict(it)
            it["_score"] = round(s, 3)
            out.append(it)
        return out

    def recent(self, k: int = 8) -> list:
        items = sorted(self.all(), key=lambda x: float(x.get("at") or 0), reverse=True)
        return items[: max(1, int(k))]

    def bump(self, ids) -> None:
        ids = set(ids or [])
        if not ids:
            return
        with _LOCK:
            d = self._load()
            hit = False
            for it in d["items"]:
                if it.get("id") in ids:
                    it["used"] = int(it.get("used") or 0) + 1
                    hit = True
            if hit:
                self._save(d)

    def forget(self, mid: str) -> bool:
        mid = (mid or "").strip()
        with _LOCK:
            d = self._load()
            before = len(d["items"])
            d["items"] = [it for it in d["items"] if it.get("id") != mid]
            if len(d["items"]) == before:
                return False
            self._save(d)
            return True


# ---------- 单例 ----------
def configure(path=None, max_items: int = 800) -> MemoryStore:
    """由第一个加载的插件调用；之后再调用不换路径（避免两个插件指向不同文件）。"""
    with _LOCK:
        cur = _INSTANCE["s"]
        if cur is None:
            cur = MemoryStore(path=path, max_items=max_items)
            _INSTANCE["s"] = cur
        elif path and cur.path in ("", _FILE_NAME):
            cur.path = path
        return cur


def store() -> MemoryStore:
    with _LOCK:
        if _INSTANCE["s"] is None:
            _INSTANCE["s"] = MemoryStore()
        return _INSTANCE["s"]
