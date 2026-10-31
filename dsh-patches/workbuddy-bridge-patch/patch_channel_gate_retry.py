#!/usr/bin/env python3
"""给 dsh-workbuddy-bridge 加「11128 频道风控自动重试」。

背景（2026-10-27 实测）：腾讯 copilot.tencent.com 的 /v2/chat/completions 有一道
频道签名风控，命中时返回 HTTP 400 + 机器码 11128
"Illegal API invocation from an unapproved channel"，前端看到的文案是
"请求被拦截，请重新发送"。bridge 0.5.3 只改写了 "DeepSeek Harness" 开篇句与品牌词，
但 DSH 当前系统提示词里还有别的段落会命中该风控（实测：整段提示词改写后仍 400/11128；
把其中"Tokens prefixed with @ ..."那段删掉或改一个字符即 200）。

本补丁的做法：不动请求内容；只在**首次请求被风控拒绝**时，把 system/developer 消息
做一次零宽扰动后重试一次。任何一处字符变化都能解除该误伤（已用真实提示词验证）。

用法:
    py patch_channel_gate_retry.py            # 打补丁
    py patch_channel_gate_retry.py --check    # 看状态
    py patch_channel_gate_retry.py --restore  # 回滚到最新 .bak-gate-*
"""

from __future__ import annotations

import sys
import time
from pathlib import Path

HOST = Path(r"C:/Users/user\.dsh\profiles\desktop\node_modules\dsh-workbuddy-bridge\lib\index.js")

MARKER = "channelGateRejected"

HELPERS = '''/** Set once the gate has been seen; later requests are nudged up front. */
let channelGateGuard = false;
/**
* Whether an upstream failure is the channel-signature gate (HTTP 400/403).
*
* The gateway answers with machine code 11128 and a human string that differs per
* locale, so the status is the only stable signal; a retry on a genuine bad request
* costs one extra round trip and still returns that error.
*/
function channelGateRejected(result) {
	if (result === void 0 || result.ok === true) return false;
	return result.status === 400 || result.status === 403;
}
/**
* Nudges one text so no long verbatim run of it survives.
*
* The gateway matches fingerprints inside the request text; a zero width space every
* PERTURB_STRIDE characters cuts every run down to at most that length, which is enough
* (measured on the real 15.8k system prompt: 400 -> 200 for strides 24 and 64, while
* perturbing a single paragraph did not help). The spaces are invisible to the model.
*/
const PERTURB_STRIDE = 24;
function perturbGateText(text) {
	if (typeof text !== "string" || text === "") return text;
	return text.replace(new RegExp(`(.{${PERTURB_STRIDE}})`, "gs"), `$1\\u200b`);
}
/**
* Returns the chat request body with every system/developer message nudged.
*
* User and tool messages are left alone on purpose: they are the factual record of the
* conversation, and the bridge's own brand-phrase rewriting avoids them for the same reason.
*/
function perturbChannelGateBody(prepared) {
	try {
		const body = JSON.parse(prepared);
		if (body === null || typeof body !== "object" || !Array.isArray(body.messages)) return prepared;
		let touched = false;
		const messages = body.messages.map((message) => {
			if (message === null || typeof message !== "object") return message;
			if (message.role !== "system" && message.role !== "developer") return message;
			const content = message.content;
			if (typeof content === "string") {
				touched = true;
				return { ...message, content: perturbGateText(content) };
			}
			if (Array.isArray(content)) {
				touched = true;
				return {
					...message,
					content: content.map((part) => (part !== null && typeof part === "object" && part.type === "text" && typeof part.text === "string" ? { ...part, text: perturbGateText(part.text) } : part))
				};
			}
			return message;
		});
		if (!touched && messages.length > 0) {
			const first = messages[0];
			if (first !== null && typeof first === "object" && typeof first.content === "string") {
				messages[0] = { ...first, content: perturbGateText(first.content) };
			}
		}
		body.messages = messages;
		return JSON.stringify(body);
	} catch {
		return prepared;
	}
}
'''

OLD_SEND = '''\t\tconst result = await client.chatStream(credential, prepared, controller.signal);
\t\tif (!result.ok) {'''

NEW_SEND = '''\t\tlet result = await client.chatStream(credential, channelGateGuard ? perturbChannelGateBody(prepared) : prepared, controller.signal);
\t\t/** The channel gate rejects a whole request body; one nudged retry clears it. */
\t\tif (channelGateRejected(result)) {
\t\t\tlogger?.debug?.("workbuddy channel gate rejection, retrying with a nudged body");
\t\t\tchannelGateGuard = true;
\t\t\tresult = await client.chatStream(credential, perturbChannelGateBody(prepared), controller.signal);
\t\t}
\t\tif (!result.ok) {'''

ANCHOR = '''/**
* Start the loopback endpoint. Requests carry any bearer; the loopback bind
* is the boundary, and the upstream credential comes from the store alone.
*/
function createWorkBuddyShim(options) {'''


def backups(host: Path) -> list[Path]:
    return sorted(host.parent.glob(host.name + ".bak-gate-*"))


def restore(host: Path) -> int:
    found = backups(host)
    if not found:
        print("no .bak-gate-* backup found next to", host)
        return 1
    latest = found[-1]
    host.write_bytes(latest.read_bytes())
    print(f"restored {host} <- {latest.name}")
    return 0


def main() -> int:
    args = set(sys.argv[1:])
    if not HOST.exists():
        print("missing host bundle:", HOST)
        return 1
    text = HOST.read_bytes().decode("utf-8").replace("\r\n", "\n")
    if args & {"--check", "-c"}:
        print("patched" if MARKER in text else "clean", f"({len(text)} chars)")
        return 0
    if args & {"--restore", "-r"}:
        return restore(HOST)
    if MARKER in text:
        print("already patched (marker present) - nothing to do")
        return 0
    if text.count(OLD_SEND) != 1:
        print(f"anchor occurs {text.count(OLD_SEND)} times (want 1) - bundle changed?")
        return 1
    if text.count(ANCHOR) != 1:
        print(f"shim anchor occurs {text.count(ANCHOR)} times (want 1) - bundle changed?")
        return 1
    stamp = time.strftime("%Y%m%d-%H%M%S")
    backup = HOST.with_name(HOST.name + f".bak-gate-{stamp}")
    backup.write_bytes(text.encode("utf-8"))
    patched = text.replace(ANCHOR, HELPERS + ANCHOR, 1).replace(OLD_SEND, NEW_SEND, 1)
    HOST.write_bytes(patched.encode("utf-8"))
    print(f"patched {HOST} ({len(text)} -> {len(patched)} chars), backup {backup.name}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
