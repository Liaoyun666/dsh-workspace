# -*- coding: utf-8 -*-
"""大肥鱼唤醒窗口 + 接话 + 分段节奏。

三件事：
1. 群里 @ 本鱼一次，之后 N 秒内同一个人说的话都当成在跟它说；
2. 没 @ 的时候也会按概率随机接话（有冷却，不会刷屏）；
3. 回复不再固定几条，随机拆成 1~8 条短消息，一条一条发出来。
"""

from __future__ import annotations

import asyncio
import random
import re
import time
from datetime import datetime

from astrbot.api import logger
from astrbot.api.event import AstrMessageEvent, filter
from astrbot.api.star import Context, Star, register
from astrbot.core.config.astrbot_config import AstrBotConfig
from astrbot.core.message.components import At, Plain
from astrbot.core.message.message_event_result import MessageChain
from astrbot.core.star.filter.custom_filter import CustomFilter

CFG: dict = {
    "seconds": 180,
    "groups": [],
    "extend_on_message": False,
    "ambient_enable": True,
    "ambient_probability": 0.08,
    "ambient_probability_max": 0.35,
    "ambient_activity_window": 600,
    "ambient_activity_full": 20,
    "ambient_cooldown": 120,
    "ambient_min_len": 2,
    "split_enable": True,
    "split_min": 1,
    "split_max": 8,
    "split_delay_min": 1.0,
    "split_delay_max": 2.8,
    "split_max_chars": 80,
    "sleep_start": 0,
    "sleep_end": 8,
}
WINDOWS: dict = {}   # chat_key -> expire_ts
COOLDOWN: dict = {}  # group_key -> 下次可以接话的时间戳

SENT_RE = re.compile(r"[^。！？!?~…\n]+[。！？!?~…]*\n?")


def _now() -> float:
    return time.time()


def _sleep_hit(hour: int) -> bool:
    """hour 点是否落在睡眠时段里（左闭右开，支持跨零点，如 23–7）。"""
    try:
        ss = int(CFG.get("sleep_start", 0) or 0)
        se = int(CFG.get("sleep_end", 8) or 8)
    except Exception:
        ss, se = 0, 8
    ss = max(0, min(23, ss))
    se = max(0, min(24, se if se else 24))
    if ss == se:
        return False
    if ss < se:
        return ss <= hour < se
    return hour >= ss or hour < se


def _in_sleep() -> bool:
    """现在是不是睡眠时段（睡着的时候不主动说话）。"""
    try:
        from zoneinfo import ZoneInfo

        hour = datetime.now(ZoneInfo("Asia/Shanghai")).hour
    except Exception:
        hour = time.localtime().tm_hour
    return _sleep_hit(hour)


# 群活跃度：group_key -> 最近消息时间戳队列（不含本鱼自己发的）
ACTIVITY: dict = {}


def _note_activity(event) -> None:
    """记一条群消息（本鱼自己发的不算），用来判断群里有多热闹。"""
    try:
        if str(event.get_sender_id()) == str(event.get_self_id()):
            return
    except Exception:
        pass
    try:
        win = max(30, int(CFG.get("ambient_activity_window", 600) or 600))
    except Exception:
        win = 600
    gk = _group_key(event)
    lst = ACTIVITY.setdefault(gk, [])
    now = _now()
    cutoff = now - win
    while lst and lst[0] < cutoff:
        lst.pop(0)
    lst.append(now)
    if len(lst) > 300:
        del lst[: len(lst) - 300]


def _activity_count(gk: str) -> int:
    """窗口内这个群有多少条人说的话（顺手清掉过期的）。"""
    try:
        win = max(30, int(CFG.get("ambient_activity_window", 600) or 600))
    except Exception:
        win = 600
    lst = ACTIVITY.get(gk) or []
    cutoff = _now() - win
    while lst and lst[0] < cutoff:
        lst.pop(0)
    return len(lst)


def _ambient_prob(gk: str) -> float:
    """群里越热闹，插话概率越高：冷清时=base，热闹到 ambient_activity_full 条=peak。"""
    try:
        base = float(CFG.get("ambient_probability", 0.08))
    except Exception:
        base = 0.08
    try:
        peak = float(CFG.get("ambient_probability_max", 0.35))
    except Exception:
        peak = 0.35
    try:
        full = max(1, int(CFG.get("ambient_activity_full", 20) or 20))
    except Exception:
        full = 20
    if peak < base:
        base, peak = peak, base
    n = _activity_count(gk)
    ratio = min(1.0, n / float(full))
    # 0.7 次方：中等热闹的时候也能明显提一点，不至于非得刷屏才开口
    p = base + (peak - base) * (ratio ** 0.7)
    return max(0.0, min(1.0, p))


def _chat_key(event) -> str:
    try:
        plat = event.get_platform_id()
    except Exception:
        plat = "unknown"
    try:
        chat = event.get_group_id() or event.get_session_id()
    except Exception:
        chat = "?"
    try:
        sender = event.get_sender_id()
    except Exception:
        sender = "?"
    return f"{plat}|{chat}|{sender}"


def _group_key(event) -> str:
    try:
        plat = event.get_platform_id()
    except Exception:
        plat = "unknown"
    try:
        gid = event.get_group_id() or event.get_session_id()
    except Exception:
        gid = "?"
    return f"{plat}|{gid}"


def _self_id(event) -> str:
    try:
        return str(event.get_self_id())
    except Exception:
        return ""


def _has_at_self(event) -> bool:
    sid = _self_id(event)
    if not sid:
        return False
    try:
        messages = event.get_messages()
    except Exception:
        return False
    for comp in messages:
        if isinstance(comp, At) and str(getattr(comp, "qq", "")) == sid:
            return True
    return False


def _group_allowed(event) -> bool:
    groups = CFG.get("groups") or []
    if not groups:
        return True
    try:
        gid = str(event.get_group_id())
    except Exception:
        return False
    return gid in [str(g) for g in groups]


def _expire_windows() -> None:
    now = _now()
    for k in [k for k, v in WINDOWS.items() if v <= now]:
        WINDOWS.pop(k, None)


# ---------------- 分段：一句一条，句子绝不切开 ----------------
SOFT_PUNCT = "，,、；;：:—"


def sentence_units(text: str) -> list:
    """按句末标点/换行切成整句（逗号、顿号、省略号都不断）。"""
    units = [u.strip() for u in SENT_RE.findall(text or "") if u.strip()]
    if not units:
        t = (text or "").strip()
        return [t] if t else []
    return units


def _cut_long(unit: str, max_chars: int) -> list:
    """一句长得离谱时，只在逗号/顿号后面下刀；实在没标点才硬切，
    免得一条消息把人憋死。正常长度的句子原样返回。"""
    if len(unit) <= max_chars:
        return [unit]
    soft_at = max(8, int(max_chars * 0.6))
    pieces, buf = [], ""
    for ch in unit:
        buf += ch
        if len(buf) >= soft_at and ch in SOFT_PUNCT:
            pieces.append(buf.strip())
            buf = ""
    if buf.strip():
        pieces.append(buf.strip())
    out = []
    for p in pieces:
        limit = int(max_chars * 1.5)
        while len(p) > limit:
            out.append(p[:max_chars].strip())
            p = p[max_chars:].strip()
        if p:
            out.append(p)
    return out or [unit]


def natural_split(text: str, max_n: int = 8, max_chars: int = 80) -> list:
    """把回复拆成一条一句话。

    规矩：
    1. 她自己在行里写的换行、句号问号感叹号就是断点，一句一条，不再二次合并；
    2. 句子绝不从中间切开（逗号、顿号、省略号都不是断点）；
    3. 只有一句超过 max_chars 才在逗号后补救一下；
    4. 条数超过 max_n 时，多出来的并进最后一条（用换行隔开），不丢字。
    """
    text = (text or "").strip()
    if not text:
        return []
    units = []
    for line in text.splitlines():
        line = line.strip()
        if not line:
            continue
        for u in sentence_units(line):
            units.extend(_cut_long(u, max_chars))
    if not units:
        return [text]
    max_n = max(1, int(max_n or 1))
    if len(units) > max_n:
        units = units[: max_n - 1] + ["\n".join(units[max_n - 1:])]
    return units


# ---------------- 过滤器 ----------------
class AtSelfOpener(CustomFilter):
    """群聊里 @ 到本鱼的消息 —— 用它把窗口打开。"""

    def filter(self, event: AstrMessageEvent, cfg: AstrBotConfig) -> bool:
        if event.is_private_chat():
            return False
        if not _group_allowed(event):
            return False
        return _has_at_self(event)


class InWindow(CustomFilter):
    """@ 之后窗口期内、同一个人、同一个群发的消息 —— 一律当成在跟本鱼说话。"""

    def filter(self, event: AstrMessageEvent, cfg: AstrBotConfig) -> bool:
        if event.is_private_chat():
            return False
        if not _group_allowed(event):
            return False
        key = _chat_key(event)
        exp = WINDOWS.get(key, 0)
        if not exp:
            return False
        if exp <= _now():
            WINDOWS.pop(key, None)
            return False
        return True


class AmbientTalk(CustomFilter):
    """没 @ 本鱼时，按概率随机插一句（有冷却，避免刷屏）。"""

    def filter(self, event: AstrMessageEvent, cfg: AstrBotConfig) -> bool:
        if event.is_private_chat():
            return False
        # 先记账：这条消息让群热闹度 +1（本鱼自己发的不算）
        _note_activity(event)
        if not CFG.get("ambient_enable", True):
            return False
        if _in_sleep():
            return False
        if not _group_allowed(event):
            return False
        if _has_at_self(event):
            return False
        # 已经在窗口里的消息交给 InWindow，别重复算
        if WINDOWS.get(_chat_key(event), 0) > _now():
            return False
        msg = (getattr(event, "message_str", "") or "").strip()
        if len(msg) < int(CFG.get("ambient_min_len", 2) or 2):
            return False
        if msg.startswith(("/", "!", "！", "#")):
            return False
        gk = _group_key(event)
        if _now() < COOLDOWN.get(gk, 0):
            return False
        # 群里越活跃概率越高（base → peak 之间按热度插值）
        return random.random() < _ambient_prob(gk)


@register(
    "astrbot_plugin_dafeiyu_wakewindow",
    "大肥鱼",
    "群里 @ 一次管 N 秒；没 @ 也会随机接话；回复随机拆成 1~8 条",
    "1.1.0",
)
class DafeiyuWakeWindow(Star):
    def __init__(self, context: Context, config: AstrBotConfig | None = None):
        super().__init__(context)
        self.config = config or {}
        for k, dv in (
            ("window_seconds", 180),
            ("groups", []),
            ("extend_on_message", False),
            ("ambient_enable", True),
            ("ambient_probability", 0.08),
            ("ambient_probability_max", 0.35),
            ("ambient_activity_window", 600),
            ("ambient_activity_full", 20),
            ("ambient_cooldown", 120),
            ("ambient_min_len", 2),
            ("split_enable", True),
            ("split_min", 1),
            ("split_max", 8),
            ("split_delay_min", 1.0),
            ("split_delay_max", 2.8),
            ("split_max_chars", 80),
            ("sleep_start", 0),
            ("sleep_end", 8),
        ):
            CFG[k] = self.config.get(k, dv)
        CFG["seconds"] = max(10, min(3600, int(CFG.get("window_seconds", 180) or 180)))
        CFG["groups"] = self.config.get("groups", []) or []
        CFG["extend_on_message"] = bool(CFG.get("extend_on_message", False))
        CFG["ambient_enable"] = bool(CFG.get("ambient_enable", True))
        try:
            CFG["ambient_probability"] = float(CFG.get("ambient_probability", 0.08))
        except Exception:
            CFG["ambient_probability"] = 0.08
        try:
            CFG["ambient_probability_max"] = float(CFG.get("ambient_probability_max", 0.35))
        except Exception:
            CFG["ambient_probability_max"] = 0.35
        CFG["ambient_probability"] = max(0.0, min(1.0, CFG["ambient_probability"]))
        CFG["ambient_probability_max"] = max(
            CFG["ambient_probability"], min(1.0, CFG["ambient_probability_max"])
        )
        try:
            CFG["ambient_activity_window"] = max(
                30, int(CFG.get("ambient_activity_window", 600) or 600)
            )
        except Exception:
            CFG["ambient_activity_window"] = 600
        try:
            CFG["ambient_activity_full"] = max(
                1, int(CFG.get("ambient_activity_full", 20) or 20)
            )
        except Exception:
            CFG["ambient_activity_full"] = 20
        try:
            CFG["ambient_cooldown"] = int(CFG.get("ambient_cooldown", 120) or 120)
        except Exception:
            CFG["ambient_cooldown"] = 120
        CFG["split_enable"] = bool(CFG.get("split_enable", True))
        try:
            CFG["split_min"] = max(1, int(CFG.get("split_min", 1) or 1))
            CFG["split_max"] = max(1, int(CFG.get("split_max", 8) or 8))
        except Exception:
            CFG["split_min"], CFG["split_max"] = 1, 8
        if CFG["split_max"] < CFG["split_min"]:
            CFG["split_min"], CFG["split_max"] = CFG["split_max"], CFG["split_min"]
        logger.info(
            f"[唤醒窗口] 已加载：窗口 {CFG['seconds']} 秒 · 群 {CFG['groups'] or '全部'} · "
            f"接话 {'开' if CFG['ambient_enable'] else '关'} "
            f"{CFG['ambient_probability']:.2f}→{CFG['ambient_probability_max']:.2f}"
            f"（{CFG['ambient_activity_window'] // 60} 分钟内 {CFG['ambient_activity_full']} 条顶满）/"
            f"冷却 {CFG['ambient_cooldown']} 秒 · 分段 一句一条（最多 {CFG['split_max']} 条，单句超 "
            f"{CFG.get('split_max_chars', 80)} 字才切） · 睡眠 {CFG['sleep_start']}–{CFG['sleep_end']} 点"
            f"（{'现在在睡' if _in_sleep() else '醒着'}）"
        )

    # ---------- 被 @ → 开窗口 ----------
    @filter.custom_filter(AtSelfOpener)
    @filter.event_message_type(filter.EventMessageType.GROUP_MESSAGE, priority=0)
    async def on_mentioned(self, event: AstrMessageEvent):
        _expire_windows()
        WINDOWS[_chat_key(event)] = _now() + CFG["seconds"]
        logger.info(
            f"[唤醒窗口] {event.get_sender_name() or event.get_sender_id()} 在群 "
            f"{event.get_group_id()} @ 了本鱼，窗口开到 {CFG['seconds']} 秒后"
        )

    # ---------- 窗口内 → 正常回答 ----------
    @filter.custom_filter(InWindow)
    @filter.event_message_type(filter.EventMessageType.GROUP_MESSAGE, priority=0)
    async def on_window_message(self, event: AstrMessageEvent):
        # process_stage 的默认 LLM 分支要求 is_at_or_wake_command 为真，
        # 只置 is_wake 是不够的（会走不到大模型）。
        event.call_llm = False
        event.is_wake = True
        event.is_at_or_wake_command = True
        if CFG.get("extend_on_message"):
            WINDOWS[_chat_key(event)] = _now() + CFG["seconds"]

    # ---------- 没 @ 也随机接话 ----------
    @filter.custom_filter(AmbientTalk)
    @filter.event_message_type(filter.EventMessageType.GROUP_MESSAGE, priority=0)
    async def on_ambient(self, event: AstrMessageEvent):
        event.call_llm = False
        event.is_wake = True
        event.is_at_or_wake_command = True
        COOLDOWN[_group_key(event)] = _now() + max(0, CFG["ambient_cooldown"])
        gk = _group_key(event)
        logger.info(
            f"[唤醒窗口] 随机接话：群 {event.get_group_id()} "
            f"{event.get_sender_name() or event.get_sender_id()}："
            f"{(getattr(event, 'message_str', '') or '')[:40]}"
            f"（{CFG['ambient_activity_window'] // 60} 分钟内 {_activity_count(gk)} 条，"
            f"本次概率 {_ambient_prob(gk):.2f}）"
        )

    # ---------- 回复随机拆成 N 条 ----------
    @filter.on_decorating_result()
    async def reshape_reply(self, event: AstrMessageEvent):
        if not CFG.get("split_enable", True):
            return
        result = event.get_result()
        if result is None:
            return
        try:
            if not result.is_model_result():
                return
        except Exception:
            pass
        chain = getattr(result, "chain", None) or []
        if not chain:
            return
        texts = []
        for comp in chain:
            if isinstance(comp, Plain):
                texts.append(comp.text or "")
            else:
                # 带图片/语音/At 的消息不拆，免得拆坏
                return
        text = "".join(texts).strip()
        if not text:
            return
        max_n = max(1, int(CFG.get("split_max", 8) or 8))
        max_chars = max(20, int(CFG.get("split_max_chars", 80) or 80))
        parts = natural_split(text, max_n, max_chars)
        if len(parts) <= 1:
            return
        result.chain = []
        delay_lo = float(CFG.get("split_delay_min", 1.0) or 1.0)
        delay_hi = float(CFG.get("split_delay_max", 2.8) or 2.8)
        if delay_hi < delay_lo:
            delay_lo, delay_hi = delay_hi, delay_lo
        logger.info(f"[唤醒窗口] 回复拆成 {len(parts)} 条：{[len(p) for p in parts]}")
        for i, part in enumerate(parts):
            if i:
                # 短的一句就快发，长的稍微喘口气，像人打字
                gap = 0.35 + 0.02 * len(part) + random.uniform(0.15, 0.75)
                await asyncio.sleep(max(delay_lo, min(delay_hi, gap)))
            try:
                await event.send(MessageChain(chain=[Plain(part)]))
            except Exception as e:
                logger.warning(
                    f"[唤醒窗口] 分段发送失败({i + 1}/{len(parts)}): "
                    f"{type(e).__name__}: {e!r}"
                )
                try:
                    await event.send(MessageChain(chain=[Plain(text)]))
                except Exception as e2:
                    logger.warning(
                        f"[唤醒窗口] 整段补发也失败: {type(e2).__name__}: {e2!r}"
                    )
                return
