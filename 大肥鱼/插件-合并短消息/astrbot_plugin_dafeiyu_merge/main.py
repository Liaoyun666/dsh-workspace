# -*- coding: utf-8 -*-
"""大肥鱼消息合并 —— 把连发的碎句（一个字一条、半句一条）攒成一句再交给她回。

主人发「你」「是」「看」「一」「句」……一条条蹦，她就会一条条懵着接。
这里在流水线最开始拦一下：同一个会话（私聊 / 被叫到的群聊）里连续到达的短消息，
先攒着，等对方停手 debounce_seconds 秒，合成一句话再让最后那条继续走完整流程，
于是只触发一次模型、只回一次。

实现方式：占位等待（不重注入队列）
- handler 用较高 priority 抢在别的插件之前；
- 每条消息记进缓冲区后 await sleep(debounce)；
- 醒来发现缓冲区里已经有更晚的片段 → 自己 stop_event() 让位；
- 最后一条醒来时缓冲区不再变 → 把 event.message_str 改成合并文本，正常往下走。
"""

from __future__ import annotations

import asyncio
import time

import astrbot.api.star as star
from astrbot.api import logger
from astrbot.api.event import AstrMessageEvent, filter
from astrbot.core.config.astrbot_config import AstrBotConfig

ENDPUNCT = ("。", "．", ".", "!", "！", "?", "？", "…", "~", "～")
SOFT_PUNCT = ("，", ",", "、", "：", ":", "；", ";", "—")
CMD_PREFIX = ("/", "／", "!", "！", "#", "＃")


def merge_parts(parts: list[str], direct_chars: int = 2) -> str:
    """把碎片拼成一句。

    - 每段都很短（<= direct_chars）且上一段不是句末标点 → 直接粘起来（还原「你是看一句回一句吗」）；
    - 上一段以逗号之类收尾 → 同一行接下去；
    - 否则另起一行（她自己说是一句一条）。
    """
    items = [p.strip() for p in parts if p and p.strip()]
    if not items:
        return ""
    if len(items) == 1:
        return items[0]
    # 整条消息都是碎渣（每条一两个字）—— 直接粘回去，还原原句
    if all(len(p) <= direct_chars for p in items):
        return "".join(items)
    out = items[0]
    prev = items[0]
    for p in items[1:]:
        if out.endswith(SOFT_PUNCT):
            out += p
        elif out.endswith(ENDPUNCT):
            out += "\n" + p
        elif len(prev) <= direct_chars and len(p) <= direct_chars:
            out += p
        else:
            out += "\n" + p
        prev = p
    return out


class DafeiyuMerge(star.Star):
    def __init__(self, context: star.Context, config: AstrBotConfig = None):
        super().__init__(context)
        self.context = context
        self.conf = config if config is not None else {}
        self._buf: dict[str, dict] = {}
        self._load()
        logger.info(
            "[消息合并] 已加载：防抖 %.1f 秒 · 最多攒 %d 条 · 私聊%s · 群聊%s"
            % (
                self.debounce,
                self.max_parts,
                "开" if self.merge_private else "关",
                "开" if self.merge_group else "关",
            )
        )

    # ---------- 配置 ----------
    def _load(self) -> None:
        c = self.conf

        def g(key, default):
            try:
                v = c.get(key, default)
            except Exception:
                return default
            return default if v is None else v

        self.enabled = bool(g("enabled", True))
        self.debounce = max(0.2, min(6.0, float(g("debounce_seconds", 1.0))))
        self.reset_after = max(3.0, float(g("reset_after_seconds", 15.0)))
        self.max_parts = max(1, int(g("max_parts", 12)))
        self.merge_private = bool(g("merge_private", True))
        self.merge_group = bool(g("merge_group", True))
        self.direct_chars = max(0, int(g("direct_chars", 2)))

    # ---------- 入口 ----------
    @filter.event_message_type(filter.EventMessageType.ALL, priority=100)
    async def on_any_message(self, event: AstrMessageEvent):
        try:
            await self._handle(event)
        except Exception as e:  # 不因为合并插件出错把整条消息搞挂
            logger.warning("[消息合并] 处理出错：%r" % (e,))

    async def _handle(self, event: AstrMessageEvent) -> None:
        if not self.enabled:
            return
        if event.get_extra("dafeiyu_merge_done"):
            return

        text = (event.message_str or "").strip()
        if not text:
            return

        is_private = bool(event.is_private_chat())
        if is_private:
            if not self.merge_private:
                return
        else:
            if not self.merge_group:
                return
            if not event.is_at_or_wake_command:
                return  # 群里没叫她，走唤醒窗口那套，不掺和

        key = "%s|%s" % (event.unified_msg_origin, event.get_sender_id())

        # 指令不攒：原样交给后面处理（wake_prefix 已被啃掉，所以看 message_obj 上的原文）
        raw = ""
        try:
            raw = (getattr(event.message_obj, "message_str", "") or "").strip()
        except Exception:
            raw = ""
        if text.startswith(CMD_PREFIX) or raw.startswith(CMD_PREFIX):
            self._buf.pop(key, None)
            return

        now = time.time()
        st = self._buf.get(key)
        if st is None or now - st["last"] > self.reset_after:
            st = {"parts": [], "last": now, "seq": 0}
            self._buf[key] = st
        st["parts"].append(text)
        st["last"] = now
        st["seq"] += 1
        mine = st["seq"]
        if len(st["parts"]) > self.max_parts:
            st["parts"] = st["parts"][-self.max_parts :]

        await asyncio.sleep(self.debounce)

        cur = self._buf.get(key)
        if cur is not st or st["seq"] != mine:
            # 后面还有新的碎片，这条让位，交给最后那条
            event.stop_event()
            return

        self._buf.pop(key, None)
        parts = st["parts"]
        if len(parts) <= 1:
            event.set_extra("dafeiyu_merge_done", True)
            return

        merged = merge_parts(parts, self.direct_chars)
        event.message_str = merged
        try:
            event.message_obj.message_str = merged
        except Exception:
            pass
        event.set_extra("dafeiyu_merge_done", True)
        logger.info(
            "[消息合并] 攒了 %d 条 → %s" % (len(parts), merged.replace("\n", " ⏎ "))
        )
