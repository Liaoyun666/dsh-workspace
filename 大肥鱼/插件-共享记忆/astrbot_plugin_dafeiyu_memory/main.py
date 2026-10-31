# -*- coding: utf-8 -*-
"""大肥鱼共享记忆 —— 让 QQ 里的大肥鱼和刷 B 站的那条鱼共用一颗脑子。

干三件事：
1. 记忆注入：每次要回话前，把「跟这句话有关」的记忆作为临时片段塞给模型；
2. 自己学：群聊 / 私聊攒够一段，就让模型提炼值得记住的事实存进去；
3. 共享：刷 B 站插件通过同一个记忆库读写（刷到啥、发了啥动态，都记下来）。

存储：data/plugin_data/astrbot_plugin_dafeiyu_memory/memories.json
"""

from __future__ import annotations

import asyncio
import json
import re
import time
from pathlib import Path

import astrbot.api.star as star
from astrbot.api import logger
from astrbot.api.event import AstrMessageEvent, filter
from astrbot.core.agent.message import TextPart
from astrbot.core.config.astrbot_config import AstrBotConfig

from .store import configure, store

# 其他插件（比如刷B站）通过 sys.modules["dafeiyu_mem_store"] 拿到同一个记忆库
import sys as _sys
from . import store as _store_mod

_sys.modules.setdefault("dafeiyu_mem_store", _store_mod)

EXTRACT_SYS = (
    "你是「大肥鱼」的记忆整理员。只输出 JSON 数组，不要解释、不要 Markdown 代码块。"
)

EXTRACT_TPL = """下面是大肥鱼最近看到的一段{kind}记录。请挑出**以后还用得上**的事实，整理成记忆。

值得记：主人（用户）的喜好/身份/近况/安排、群友的名字与特征、约定和承诺、发生的重要事件、大肥鱼自己说过的重要的话。
不值得记：一次性的寒暄、随口吐槽、表情、重复内容、没有信息量的短句。

要求：
1. 每条一句话，20~60 字，主语明确（写「主人」「某某」「本鱼」，不要写「他/她」）；
2. 最多 {max_n} 条，宁缺毋滥；
3. 输出格式：[{{"text": "……", "tags": ["关键词1", "关键词2"], "imp": 0.7}}]
4. imp 是重要度 0~1：日常喜好 0.4~0.6，重要约定/身份/近况 0.7~0.9；
5. 没有值得记的就输出 []。

记录：
{log}
"""

_SRC_LABEL = (("b站", "刷B站"), ("bili", "刷B站"), ("qq群", "群聊"), ("qq私聊", "私聊"), ("qq", "聊天"))


class DafeiyuMemory(star.Star):
    def __init__(self, context: star.Context, config: AstrBotConfig = None):
        super().__init__(context)
        self.context = context
        self.cfg = config or {}
        self.data_dir: Path = star.StarTools.get_data_dir("astrbot_plugin_dafeiyu_memory")
        self.mem = configure(str(self.data_dir / "memories.json"), int(self._c("max_items", 800)))
        self.buf: dict[str, list] = {}
        self.last_learn: dict[str, float] = {}
        self.busy: set = set()
        logger.info(
            f"[共享记忆] 已加载：{self.mem.count()} 条记忆 · 注入 {self._c('inject_k', 5)} 条 · "
            f"学习 {self._c('learn_every_n', 25)} 句/轮"
        )

    # ------------------------------------------------------------------ 工具
    def _c(self, name, default):
        try:
            v = self.cfg.get(name, default)
        except Exception:
            v = default
        return default if v is None else v

    @staticmethod
    def _label(src: str) -> str:
        s = (src or "").lower()
        for k, v in _SRC_LABEL:
            if s.startswith(k):
                return v
        return src or "记忆"

    def _collect(self, event: AstrMessageEvent, umo: str, src: str) -> None:
        """把消息塞进缓冲区，够了就提炼。"""
        text = (event.message_str or "").strip()
        if len(text) < 2 or text.startswith(("/", "!", "！", "#")):
            return
        try:
            name = event.get_sender_name() or str(event.get_sender_id())
        except Exception:
            name = "某人"
        buf = self.buf.setdefault(umo, [])
        buf.append((name, text[:300]))
        if len(buf) > 120:
            del buf[: len(buf) - 120]

        n = int(self._c("learn_every_n", 25))
        gap = float(self._c("learn_min_minutes", 10)) * 60.0
        hot = len(buf) >= max(3, n) or (
            len(buf) >= 5 and time.time() - self.last_learn.get(umo, 0) >= gap
        )
        if hot and umo not in self.busy:
            logger.info(f"[共享记忆] {umo} 攒了 {len(buf)} 条，开始提炼")
            asyncio.create_task(self._learn(umo, src))

    # ------------------------------------------------------------------ 学习
    @filter.event_message_type(filter.EventMessageType.GROUP_MESSAGE, priority=-10)
    async def on_group_msg(self, event: AstrMessageEvent):
        if not self._c("learn_enable", True) or not self._c("learn_in_group", True):
            return
        umo = event.unified_msg_origin
        src = f"qq群:{event.get_group_id()}"
        self._collect(event, umo, src)

    @filter.event_message_type(filter.EventMessageType.PRIVATE_MESSAGE, priority=-10)
    async def on_private_msg(self, event: AstrMessageEvent):
        if not self._c("learn_enable", True) or not self._c("learn_in_private", True):
            return
        umo = event.unified_msg_origin
        self._collect(event, umo, "qq私聊")

    async def _learn(self, umo: str, src: str) -> None:
        self.busy.add(umo)
        try:
            msgs = self.buf.pop(umo, [])
            if len(msgs) < 3:
                logger.info(f"[共享记忆] {umo} 只有 {len(msgs)} 条，跳过这轮")
                return
            log = "\n".join(f"{n}: {t}" for n, t in msgs[-40:])
            kind = "群聊" if src.startswith("qq群") else "私聊"
            max_n = int(self._c("learn_max_per_round", 3))
            prompt = EXTRACT_TPL.format(kind=kind, max_n=max_n, log=log)
            prov = await self.context.get_using_provider_async(umo)
            if prov is None:
                logger.warning(f"[共享记忆] {umo} 没拿到 LLM provider，这轮放弃")
                return
            t0 = time.time()
            resp = await prov.text_chat(prompt=prompt, system_prompt=EXTRACT_SYS)
            raw = (getattr(resp, "completion_text", "") or "").strip()
            facts = self._parse(raw)
            logger.info(
                f"[共享记忆] 模型 {time.time() - t0:.1f}s 返回 {len(raw)} 字，解析出 {len(facts)} 条"
            )
            if not facts:
                logger.warning(f"[共享记忆] 解析不到条目，原文：{raw[:300]}")
            got = 0
            for f in facts[:max_n]:
                txt = str(f.get("text") or "").strip()
                if len(txt) < 6:
                    continue
                self.mem.add(txt, tags=f.get("tags"), src=src, imp=float(f.get("imp") or 0.5))
                got += 1
            if got:
                logger.info(f"[共享记忆] 从 {src} 学到了 {got} 条：{[f['text'][:18] for f in facts[:got]]}")
        except Exception as e:
            logger.warning(f"[共享记忆] 学习失败（{src}）：{e}")
        finally:
            self.busy.discard(umo)
            self.last_learn[umo] = time.time()

    @staticmethod
    def _parse(raw: str) -> list:
        if not raw:
            return []
        t = (raw or "").strip()
        if not t:
            return []
        # 只取第一个 [ 到最后一个 ] 之间——代码块围栏、前后解释文字都会被自动剥掉
        i, j = t.find("["), t.rfind("]")
        if i < 0 or j <= i:
            return []
        t = t[i : j + 1]
        try:
            d = json.loads(t)
        except Exception:
            return []
        if isinstance(d, dict):
            d = d.get("memories") or d.get("items") or []
        return [x for x in d if isinstance(x, dict)] if isinstance(d, list) else []

    # ------------------------------------------------------------------ 注入
    @filter.on_llm_request()
    async def inject_memory(self, event: AstrMessageEvent, req):
        if not self._c("inject_enable", True):
            return
        q = getattr(req, "prompt", "") or ""
        if not isinstance(q, str) or not q.strip():
            q = (getattr(event, "message_str", "") or "").strip()
        k = int(self._c("inject_k", 5))
        try:
            mems = self.mem.search(q, k=k, min_score=float(self._c("inject_min_score", 0.08)))
        except Exception as e:
            logger.warning(f"[共享记忆] 检索失败：{e}")
            return
        if not mems:
            mems = self.mem.recent(min(2, k))
        if not mems:
            return
        lines = ["【你记着的事】(这些是你自己攒下的记忆，不是别人刚说的；自然地用，别照抄清单、别说「我记得」)"]
        for m in mems:
            lines.append(f"- [{self._label(m.get('src'))}] {m.get('text')}")
        try:
            req.extra_user_content_parts.append(TextPart(text="\n".join(lines)).mark_as_temp())
        except Exception:
            req.system_prompt = (getattr(req, "system_prompt", "") or "") + "\n\n" + "\n".join(lines)
        self.mem.bump([m.get("id") for m in mems])
        logger.info(f"[共享记忆] 注入 {len(mems)} 条 -> {event.unified_msg_origin}")

    # ------------------------------------------------------------------ 指令
    @filter.command("记忆")
    async def cmd_memory(self, event: AstrMessageEvent):
        """看最近攒下的记忆 / 记住 / 忘掉"""
        raw = (event.message_str or "").strip()
        parts = raw.split(maxsplit=1)
        sub = parts[1].strip() if len(parts) > 1 else ""

        if sub.startswith("记住") or sub.startswith("记下"):
            text = sub[2:].strip() if sub.startswith("记住") else sub[2:].strip()
            if len(text) < 4:
                yield event.plain_result("要记啥？说清楚点嘛，比如：/记忆 记住 主人喜欢喝冰美式")
                return
            it = self.mem.add(text, tags=[], src=f"qq:{event.get_sender_id()}", imp=0.8)
            yield event.plain_result(f"记住了（{it.get('id')}）：{it.get('text')}  ……才、才不是特意记的")
            return

        if sub.startswith("忘掉") or sub.startswith("忘记"):
            key = sub[2:].strip()
            if not key:
                yield event.plain_result("忘掉哪条？给编号，或者给个关键词让我找。")
                return
            if self.mem.forget(key):
                yield event.plain_result(f"……{key} 这条，忘了。")
                return
            hits = self.mem.search(key, k=3, min_score=0.05)
            if not hits:
                yield event.plain_result("没找到跟这个有关的记忆。")
                return
            yield event.plain_result(
                "是这几条里的哪条？用 /记忆 忘掉 编号\n"
                + "\n".join(f"{h['id']}  {h['text']}" for h in hits)
            )
            return

        if sub.startswith("找") or sub.startswith("搜"):
            key = sub[1:].strip()
            hits = self.mem.search(key, k=8, min_score=0.05) if key else []
            if not hits:
                yield event.plain_result("脑子里没找到相关的事。")
                return
            yield event.plain_result(
                "想起来这些：\n" + "\n".join(f"{h['id']}  {h['text']}" for h in hits)
            )
            return

        items = self.mem.recent(10)
        if not items:
            yield event.plain_result("脑子里还是空的…… /记忆 记住 一句话 就能塞一条进来。")
            return
        lines = [f"一共 {self.mem.count()} 条，最近的："]
        for it in items:
            lines.append(f"{it['id']}  [{self._label(it.get('src'))}] {it['text']}")
        lines.append("（/记忆 记住 内容 来记；/记忆 忘掉 编号 来删；/记忆 找 关键词 来搜）")
        yield event.plain_result("\n".join(lines))

    async def terminate(self):
        logger.info("[共享记忆] 已卸载")
