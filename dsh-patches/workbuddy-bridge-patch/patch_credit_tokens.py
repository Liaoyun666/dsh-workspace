#!/usr/bin/env python3
"""Patch dsh-workbuddy-bridge's client bundle:

1. Show an estimated affordable token count next to the remaining credit, derived
   from the currently selected WorkBuddy model's multiplier.
2. De-duplicate the status route reads that made the composer janky: one shared
   cache + in-flight reuse across the probe control, the balance, the settings
   card and the per-message credit hook, plus a debounced/throttled window-focus
   refresh.

Only lib/client.js is touched (client-hmr picks up the mtime change and hot
reloads it, no DSH restart needed).

Usage:
    py patch_credit_tokens.py            # apply (idempotent)
    py patch_credit_tokens.py --check    # report state, change nothing
    py patch_credit_tokens.py --restore  # restore newest .bak-tokens-* backup
"""

from __future__ import annotations

import argparse
import re
import shutil
import sys
import time
from pathlib import Path

CLIENT = Path(
    r"C:/Users/user\.dsh\profiles\desktop\node_modules\dsh-workbuddy-bridge\lib\client.js"
)
MARKER = "readStatusShared"


# ----------------------------------------------------------------- literal maps
# Each entry: (label, old literal, new literal). Exactly one occurrence required.
LITERALS: list[tuple[str, str, str]] = [
    # --- VariantProbe: read through the shared reader (forced when manual)
    (
        "VariantProbe refresh",
        """			const refresh = (0, react.useCallback)(async (signal) => {
				const seq = ++readSeq.current;
				const response = await fetch(card.statusPath, {
					credentials: "same-origin",
					headers: { accept: "application/json" },
					...signal === void 0 ? {} : { signal }
				});
				if (!response.ok) throw new Error(`HTTP ${response.status}`);
				const value = await response.json().catch(() => void 0);
				if (!isWorkBuddyWebStatus(value)) throw new Error(t("statusResponseInvalid"));
				if (mounted.current && signal?.aborted !== true && seq === readSeq.current) setStatus(value);
			}, [card.statusPath, t]);""",
        """			const refresh = (0, react.useCallback)(async (signal) => {
				const seq = ++readSeq.current;
				const value = await readStatusShared(card.statusPath, {
					force: signal === void 0,
					invalidMessage: t("statusResponseInvalid")
				});
				if (mounted.current && signal?.aborted !== true && seq === readSeq.current) setStatus(value);
			}, [card.statusPath, t]);""",
    ),
    # --- VariantProbe effect: fold the focus listener into the shared subscriber
    (
        "VariantProbe focus",
        """				const timer = window.setInterval(load, RECONCILE_MS);
				window.addEventListener("focus", load);
				return () => {
					mounted.current = false;
					controller.abort();
					window.clearInterval(timer);
					window.removeEventListener("focus", load);
				};""",
        """				const timer = window.setInterval(load, RECONCILE_MS);
				const unsubscribeFocus = subscribeFocusRefresh(load);
				return () => {
					mounted.current = false;
					controller.abort();
					window.clearInterval(timer);
					unsubscribeFocus();
				};""",
    ),
    # --- useWorkBuddyStatus: read through the shared reader (force after a write)
    (
        "useWorkBuddyStatus read fetch",
        """				try {
					const response = await fetch(variant.statusPath, {
						headers: { accept: "application/json" },
						credentials: "same-origin",
						...signal === void 0 ? {} : { signal }
					});
					const value = await response.json().catch(() => void 0);
					if (!response.ok) throw new Error(`HTTP ${response.status}`);
					if (!isWorkBuddyWebStatus(value)) throw new Error(t("statusResponseInvalid"));""",
        """				try {
					const value = await readStatusShared(variant.statusPath, {
						force,
						invalidMessage: t("statusResponseInvalid")
					});""",
    ),
    # --- useWorkBuddySessionCredits: one poll per (route, session), not per message
    (
        "session credits hook",
        """		function useWorkBuddySessionCredits(path, sessionId, enabled) {
			const [credits, setCredits] = (0, react.useState)();
			const mounted = (0, react.useRef)(true);
			/** Number of the newest read allowed to write; assigned when a read starts. */
			const readSeq = (0, react.useRef)(0);
			const read = (0, react.useCallback)(async (signal) => {
				if (sessionId === void 0 || sessionId === "") return;
				const seq = ++readSeq.current;
				try {
					const response = await fetch(`${path}?sessionId=${encodeURIComponent(sessionId)}`, {
						credentials: "same-origin",
						headers: { accept: "application/json" },
						signal
					});
					if (!response.ok) return;
					const value = await response.json().catch(() => void 0);
					if (!isWorkBuddySessionCredits(value)) return;
					if (!mounted.current || signal.aborted || seq !== readSeq.current) return;
					setCredits(value.credits);
				} catch {}
			}, [path, sessionId]);
			(0, react.useEffect)(() => {
				mounted.current = true;
				if (!enabled || sessionId === void 0 || sessionId === "") return;
				const controller = new AbortController();
				read(controller.signal);
				const timer = window.setInterval(() => {
					read(controller.signal);
				}, POLL_INTERVAL_MS$1);
				const onFocus = () => {
					read(controller.signal);
				};
				window.addEventListener("focus", onFocus);
				return () => {
					mounted.current = false;
					controller.abort();
					window.clearInterval(timer);
					window.removeEventListener("focus", onFocus);
				};
			}, [
				enabled,
				read,
				sessionId
			]);
			return { credits };
		}""",
        """		function useWorkBuddySessionCredits(path, sessionId, enabled) {
			const active = enabled === true && sessionId !== void 0 && sessionId !== "";
			const [credits, setCredits] = (0, react.useState)();
			(0, react.useEffect)(() => {
				if (!active) {
					setCredits(void 0);
					return;
				}
				const store = openSessionCreditStore(path, sessionId);
				const listener = () => {
					setCredits(store.credits);
				};
				store.listeners.add(listener);
				store.refs += 1;
				setCredits(store.credits);
				store.start();
				return () => {
					store.listeners.delete(listener);
					store.refs -= 1;
					if (store.refs <= 0) {
						store.stop();
						sessionCreditStores.delete(store.key);
					}
				};
			}, [
				active,
				path,
				sessionId
			]);
			return { credits };
		}""",
    ),
    # --- credit-balance effect: shared, debounced focus
    (
        "balance focus",
        """				const onFocus = () => {
					read();
				};
				window.addEventListener("focus", onFocus);
				return () => {
					mounted.current = false;
					controller.abort();
					window.clearInterval(timer);
					window.removeEventListener("focus", onFocus);
				};""",
        """				const unsubscribeFocus = subscribeFocusRefresh(() => {
					read();
				});
				return () => {
					mounted.current = false;
					controller.abort();
					window.clearInterval(timer);
					unsubscribeFocus();
				};""",
    ),
    # --- readBalance: shared reader, and keep the per-model multipliers
    (
        "readBalance fetch",
        """			try {
				const response = await fetch(card.statusPath, {
					credentials: "same-origin",
					headers: { accept: "application/json" },
					signal
				});
				if (!response.ok) return { kind: "unknown" };
				const value = await response.json().catch(() => void 0);
				if (!isWorkBuddyWebStatus(value) || value.status !== "signed-in") return { kind: "unknown" };""",
        """			try {
				const value = await readStatusShared(card.statusPath, {
					invalidMessage: "invalid status response"
				});
				if (!isWorkBuddyWebStatus(value) || value.status !== "signed-in") return { kind: "unknown" };""",
    ),
    (
        "readBalance models",
        """				return credits.unlimited === true ? { kind: "unlimited" } : {
					kind: "total",
					total: credits.total
				};""",
        """				return credits.unlimited === true ? { kind: "unlimited" } : {
					kind: "total",
					total: credits.total,
					models: value.models
				};""",
    ),
    # --- the rendered dock row: credit, multiplier, token estimate
    (
        "balance render",
        """			const figure = balance.kind === "unlimited" ? t("creditRemainingUnlimited") : formatCredit(balance.total);
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
				className: credit_balance_module_css_default.readout,
				title: t("creditBalanceTitle", { product: card.appName }),
				children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)(CoinGlyph, {}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
					className: credit_balance_module_css_default.amount,
					children: figure
				})]
			});""",
        """			const figure = balance.kind === "unlimited" ? t("creditRemainingUnlimited") : formatCredit(balance.total);
			const modelId = selection === null ? void 0 : selection.model;
			const rate = balance.kind === "total" ? parseCreditRate(balance.models, modelId) : void 0;
			const tokens = balance.kind === "total" ? estimateTokensFromCredits(balance.total, rate, modelId) : void 0;
			const items = [/* @__PURE__ */ (0, react_jsx_runtime.jsx)(CoinGlyph, {}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
				className: credit_balance_module_css_default.amount,
				children: figure
			})];
			if (rate !== void 0) items.push(/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
				className: credit_balance_module_css_default.rate,
				children: t("tokenEstimateRate", { rate: formatCredit(rate) })
			}));
			if (tokens !== void 0) items.push(/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
				className: credit_balance_module_css_default.estimate,
				children: Number.isFinite(tokens) ? t("tokenEstimate", { tokens: formatTokenEstimate(tokens) }) : t("tokenEstimateFree")
			}));
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
				className: credit_balance_module_css_default.dock,
				title: t("tokenEstimateTitle", {
					model: modelNameFor(balance.models, modelId),
					product: card.appName
				}),
				children: items
			});""",
    ),
    # --- move the balance out of the compact row and above the composer
    (
        "dock seat const",
        """		const BALANCE_SEAT_ID = "workbuddy-credit-balance";""",
        """		const BALANCE_SEAT_ID = "workbuddy-credit-balance";
		/**
		* The full-width seat above the composer card.
		*
		* A `list` seat owned by the conversation, so the credit readout gets a whole
		* row to itself and the model picker keeps its compact row for the probe icon.
		*/
		const DOCK_SEAT = "conversation.input.dock";""",
    ),
    (
        "dock seat registration",
        """			ctx.inject(["modelDirectories"], (scope) => {
				scope.slots.inject(PROBE_SEAT, () => {
					const releaseProbe = scope.slots.register({
						name: PROBE_SEAT,
						id: PROBE_SEAT_ID,
						inject: (sessionId) => ({
							directory: scope.modelDirectories.directoryFor(sessionId).store,
							t
						})
					}, WorkBuddyProbeControl);
					const releaseBalance = scope.slots.register({
						name: PROBE_SEAT,
						id: BALANCE_SEAT_ID,
						order: -10,
						inject: (sessionId) => ({
							directory: scope.modelDirectories.directoryFor(sessionId).store,
							t
						})
					}, WorkBuddyCreditBalance);
					return () => {
						releaseBalance();
						releaseProbe();
					};
				});
			});""",
        """			ctx.inject(["modelDirectories"], (scope) => scope.slots.inject(PROBE_SEAT, () => scope.slots.register({
				name: PROBE_SEAT,
				id: PROBE_SEAT_ID,
				inject: (sessionId) => ({
					directory: scope.modelDirectories.directoryFor(sessionId).store,
					t
				})
			}, WorkBuddyProbeControl)));
			ctx.inject(["modelDirectories"], (scope) => scope.slots.inject(DOCK_SEAT, () => scope.slots.register({
				name: DOCK_SEAT,
				id: BALANCE_SEAT_ID,
				order: 4,
				inject: (sessionId) => ({
					directory: scope.modelDirectories.directoryFor(sessionId).store,
					t
				})
			}, WorkBuddyCreditBalance)));""",
    ),
    # --- locale keys
    (
        "en locale",
        """			creditBalanceTitle: "Remaining credit on your {product} account",""",
        """			creditBalanceTitle: "Remaining credit on your {product} account",
			tokenEstimate: "≈ {tokens} tokens",
			tokenEstimateRate: "×{rate}",
			tokenEstimateTitle: "{model} · {product} credit left, times this model's multiplier, converted into the tokens it still pays for (rough estimate; cached input is not billed)",
			tokenEstimateFree: "free model — spends no credit",""",
    ),
    (
        "zh locale",
        """			creditBalanceTitle: "{product} 账号剩余积分",""",
        """			creditBalanceTitle: "{product} 账号剩余积分",
			tokenEstimate: "≈ {tokens} tokens",
			tokenEstimateRate: "×{rate}",
			tokenEstimateTitle: "{model} · {product} 剩余积分乘当前模型倍率后，大约还能跑多少 token（粗估；命中缓存的输入不计费）",
			tokenEstimateFree: "免费模型，不消耗积分",""",
    ),
    # --- CSS: the dock row (appended to the existing module rule block)
    (
        "css rule",
        '.Rbiksq_amount{font-size:calc(var(--dsh-content-font-size-secondary,13px) - 1px);font-variant-numeric:tabular-nums;line-height:1}";',
        '.Rbiksq_amount{font-size:calc(var(--dsh-content-font-size-secondary,13px) - 1px);font-variant-numeric:tabular-nums;line-height:1}'
        '.Rbiksq_dock{display:flex;align-items:center;justify-content:flex-end;gap:6px;'
        'width:100%;max-width:var(--dsh-chat-content-width,720px);margin:0 auto;box-sizing:border-box;'
        'min-width:0;overflow:hidden;'
        'padding:0 calc(var(--dsh-composer-side-clearance,0px) + 16px) 4px;'
        'font-size:calc(var(--dsh-content-font-size-secondary,13px) - 2px);'
        'line-height:1.2;color:var(--dsw-alias-label-tertiary);white-space:nowrap;'
        'font-variant-numeric:tabular-nums}'
        '.Rbiksq_rate{opacity:.85}'
        '.Rbiksq_estimate{opacity:.75}'
        '@media (max-width:640px){.Rbiksq_rate{display:none}}";',
    ),
    (
        "css class export",
        """			"amount": "Rbiksq_amount",
			"readout": "Rbiksq_readout"
		};""",
        """			"amount": "Rbiksq_amount",
			"dock": "Rbiksq_dock",
			"estimate": "Rbiksq_estimate",
			"rate": "Rbiksq_rate",
			"readout": "Rbiksq_readout"
		};""",
    ),
]


HELPERS = r'''		/**
		* One shared reader for a variant's status document.
		*
		* The composer mounts several consumers of the same route - the probe control,
		* the balance, the per-message credit label and the settings card - and every
		* read costs one real upstream billing request. They share one read now: the
		* first caller fetches, everyone else inside the TTL reuses the result, and a
		* read already in flight is reused rather than duplicated.
		*/
		const SHARED_STATUS_TTL_MS = 6e4;
		let sharedStatusPath = "";
		let sharedStatusValue = void 0;
		let sharedStatusAt = 0;
		let sharedStatusInflight = void 0;
		function readStatusShared(path, options = {}) {
			const invalidMessage = options.invalidMessage ?? "invalid status response";
			if (sharedStatusPath !== path) {
				sharedStatusPath = path;
				sharedStatusValue = void 0;
				sharedStatusAt = 0;
				sharedStatusInflight = void 0;
			}
			const force = options.force === true;
			if (!force) {
				if (sharedStatusInflight !== void 0) return sharedStatusInflight;
				if (sharedStatusValue !== void 0 && Date.now() - sharedStatusAt < SHARED_STATUS_TTL_MS) return Promise.resolve(sharedStatusValue);
			}
			const promise = fetch(path, {
				credentials: "same-origin",
				headers: { accept: "application/json" }
			}).then(async (response) => {
				if (!response.ok) throw new Error(`HTTP ${response.status}`);
				const value = await response.json().catch(() => void 0);
				if (!isWorkBuddyWebStatus(value)) throw new Error(invalidMessage);
				if (sharedStatusPath === path) {
					sharedStatusValue = value;
					sharedStatusAt = Date.now();
				}
				return value;
			}).finally(() => {
				if (sharedStatusInflight === promise) sharedStatusInflight = void 0;
			});
			if (!force) sharedStatusInflight = promise;
			return promise;
		}
		/**
		* Coalesce the window-focus refreshes of every consumer into one read.
		*
		* One alt-tab used to fire an upstream read per consumer at the same moment.
		* This waits out the focus storm and drops repeats inside a short window.
		*/
		const FOCUS_DEBOUNCE_MS = 2e2;
		const FOCUS_MIN_GAP_MS = 5e3;
		function subscribeFocusRefresh(callback) {
			let timer = 0;
			let lastRun = 0;
			const onFocus = () => {
				window.clearTimeout(timer);
				timer = window.setTimeout(() => {
					const now = Date.now();
					if (now - lastRun < FOCUS_MIN_GAP_MS) return;
					lastRun = now;
					callback();
				}, FOCUS_DEBOUNCE_MS);
			};
			window.addEventListener("focus", onFocus);
			return () => {
				window.clearTimeout(timer);
				window.removeEventListener("focus", onFocus);
			};
		}
		/**
		* What WorkBuddy charges, measured per model on this machine.
		*
		* Every model has its own price, so the credit multiplier alone cannot be
		* turned into tokens: kimi-k3-1 charges ~2.2x more per token than its x1.62
		* multiplier suggests, while the cheap GLM/DeepSeek tiers cost far less.
		*
		* The charge law, verified on three probes per model (worst residual 4.5%):
		*
		*   credit = rate * (a * output + b * freshInput + c * cachedInput)
		*
		* where `rate` is the multiplier the model picker shows and c = CACHE_FACTOR * b.
		* Coefficients were fitted from real replies by differencing an input-heavy and
		* an output-heavy probe, under least squares over three probes per model.
		*
		* Cross-checks against data the fit never saw:
		*   - the datapoint documented in this bundle's source (glm-5.3, 900 output
		*     tokens -> credit 0.51): predicted 0.504, off by 1.1%.
		*   - 19 real replies already in this conversation: 2.40 credit charged,
		*     2.45 predicted, off by 2%.
		*/
		const MODEL_CHARGE = {
			"hy4-preview": { a: 0.000984246, b: 0.000492917 },
			"hy3-x": { a: 0.00199484, b: 0.00034237 },
			"space-bunny": { a: 0.000735159, b: 0.000187341 },
			"deepseek-v4.1-flash": { a: 0.000532081, b: 0.000129795 },
			"glm-5.3": { a: 0.000811883, b: 0.000232374 },
			"glm-5.3-flash": { a: 0.000631008, b: 0.00018474 },
			"glm-5.2": { a: 0.0007075, b: 0.000201728 },
			/**
			* glm-5.1 rejected every probe with `code 11133` (parameters rejected by
			* the model provider), so it inherits the coefficients of its x0.79 sibling.
			*/
			"glm-5.1": { a: 0.0007075, b: 0.000201728 },
			"glm-5v-turbo": { a: 0.000789865, b: 0.000211431 },
			"minimax-m3.1-flash": { a: 0.00141848, b: 0.00035517 },
			"minimax-m3": { a: 0.000918264, b: 0.000236911 },
			"minimax-m2.7": { a: 0.000946343, b: 0.000238845 },
			"kimi-k3.1-pro": { a: 0.00169888, b: 0.000324821 },
			"kimi-k3-1": { a: 0.00149528, b: 0.000300946 },
			"kimi-k2.8-preview": { a: 0.000848385, b: 0.000204803 },
			"deepseek-v4-pro": { a: 0.000754692, b: 0.000251997 },
			"mimo-v2.6-pro": { a: 0.00132426, b: 0.000659022 }
		};
		/**
		* Coefficients used for a model missing from the table above.
		*
		* The median of the measured models, so a model added upstream tomorrow still
		* gets a sane order of magnitude instead of no estimate at all.
		*/
		const DEFAULT_CHARGE = { a: 0.0008833245, b: 0.000237878 };
		/** Output share of the billed (non-cached) tokens actually observed here. */
		const BILLED_OUTPUT_SHARE = 0.4163;
		/** Cached prompt reads observed per billed token. */
		const CACHE_READ_PER_BILLED = 23.28;
		/** A cached prompt read costs this fraction of a fresh input token. */
		const CACHE_FACTOR = 0.02;
		/**
		* Read the selected model's multiplier out of the status document.
		*
		* The selector hands over the catalog id, which is normally the id the status
		* document uses; the id/name fallbacks only cover a catalog that drifted.
		*/
		function parseCreditRate(models, modelId) {
			if (!Array.isArray(models) || typeof modelId !== "string") return void 0;
			const wanted = modelId.trim().toLowerCase();
			if (wanted === "") return void 0;
			const rateOf = (entry) => {
				const credits = entry?.credits;
				if (typeof credits !== "string") return void 0;
				const rate = Number.parseFloat(credits.replace(/^x/i, "").trim());
				return Number.isFinite(rate) ? rate : void 0;
			};
			const exact = models.find((candidate) => candidate?.id === modelId);
			const byId = exact ?? models.find((candidate) => typeof candidate?.id === "string" && candidate.id.trim().toLowerCase() === wanted);
			const byName = byId ?? models.find((candidate) => typeof candidate?.name === "string" && candidate.name.trim().toLowerCase() === wanted);
			const byPrefix = byName ?? models.find((candidate) => typeof candidate?.id === "string" && candidate.id.trim().toLowerCase().startsWith(`${wanted}-`));
			return rateOf(byPrefix);
		}
		/** Charge coefficients for a catalog id, falling back to the median model. */
		function chargeFor(modelId) {
			if (typeof modelId !== "string") return DEFAULT_CHARGE;
			const wanted = modelId.trim().toLowerCase();
			if (wanted === "") return DEFAULT_CHARGE;
			const exact = MODEL_CHARGE[wanted];
			if (exact !== void 0) return exact;
			const key = Object.keys(MODEL_CHARGE).find((candidate) => candidate.startsWith(wanted) || wanted.startsWith(candidate));
			return key === void 0 ? DEFAULT_CHARGE : MODEL_CHARGE[key];
		}
		/**
		* Credits one token costs, mixing cached and fresh input the way this machine
		* actually uses the models (58% input, 42% output, 23 cached reads per token).
		*/
		function creditsPerToken(rate, modelId) {
			const charge = chargeFor(modelId);
			return rate * (charge.a * BILLED_OUTPUT_SHARE
				+ charge.b * (1 - BILLED_OUTPUT_SHARE)
				+ CACHE_FACTOR * charge.b * CACHE_READ_PER_BILLED);
		}
		function estimateTokensFromCredits(total, rate, modelId) {
			if (!Number.isFinite(total) || rate === void 0) return void 0;
			if (rate <= 0) return Number.POSITIVE_INFINITY;
			return total / creditsPerToken(rate, modelId);
		}
		const tokenEstimateFormat = new Intl.NumberFormat(void 0, {
			notation: "compact",
			maximumFractionDigits: 1
		});
		function formatTokenEstimate(tokens) {
			if (!Number.isFinite(tokens)) return "\u221E";
			return tokenEstimateFormat.format(Math.max(0, Math.round(tokens)));
		}
		function modelNameFor(models, modelId) {
			if (!Array.isArray(models) || typeof modelId !== "string") return "WorkBuddy";
			const entry = models.find((candidate) => candidate?.id === modelId);
			return typeof entry?.name === "string" ? entry.name : modelId;
		}
		/**
		* One poll per (route, session) shared by every message row in the transcript.
		*
		* The per-message credit label used to own a timer each: a conversation with
		* forty answers kept forty intervals alive, all hitting the same route every
		* thirty seconds and all reading it again on every window focus. The rows only
		* ever want the same map, so they subscribe to one store instead. The store
		* stops polling when the last subscriber unmounts.
		*/
		const sessionCreditStores = /* @__PURE__ */ new Map();
		function openSessionCreditStore(path, sessionId) {
			const key = `${path}\u0000${sessionId}`;
			const existing = sessionCreditStores.get(key);
			if (existing !== void 0) return existing;
			const store = {
				key,
				credits: void 0,
				listeners: /* @__PURE__ */ new Set(),
				refs: 0,
				abort: void 0,
				timer: 0,
				unsubscribeFocus: void 0,
				readSeq: 0,
				read() {
					const seq = ++store.readSeq;
					const controller = store.abort;
					if (controller === void 0) return;
					fetch(`${path}?sessionId=${encodeURIComponent(sessionId)}`, {
						credentials: "same-origin",
						headers: { accept: "application/json" },
						signal: controller.signal
					}).then(async (response) => {
						if (!response.ok) return;
						const value = await response.json().catch(() => void 0);
						if (!isWorkBuddySessionCredits(value)) return;
						if (controller.signal.aborted || seq !== store.readSeq) return;
						store.credits = value.credits;
						for (const listener of store.listeners) listener();
					}).catch(() => {});
				},
				start() {
					if (store.abort !== void 0) return;
					store.abort = new AbortController();
					store.read();
					store.timer = window.setInterval(() => {
						store.read();
					}, POLL_INTERVAL_MS$1);
					store.unsubscribeFocus = subscribeFocusRefresh(() => {
						store.read();
					});
				},
				stop() {
					const controller = store.abort;
					store.abort = void 0;
					if (controller !== void 0) controller.abort();
					window.clearInterval(store.timer);
					store.timer = 0;
					if (store.unsubscribeFocus !== void 0) {
						store.unsubscribeFocus();
						store.unsubscribeFocus = void 0;
					}
					store.readSeq += 1;
				}
			};
			sessionCreditStores.set(key, store);
			return store;
		}
'''


def replace_literal(text: str, old: str, new: str, label: str) -> str:
    count = text.count(old)
    if count != 1:
        raise SystemExit(f"anchor {label!r} occurs {count} times (want 1) - bundle changed?")
    return text.replace(old, new, 1)


def patch(text: str) -> str:
    for label, old, new in LITERALS:
        text = replace_literal(text, old, new, label)

    # helper block, immediately before the balance poll interval
    anchor = "\t\tconst POLL_INTERVAL_MS = 12e4;\n"
    text = replace_literal(text, anchor, HELPERS + anchor, "helpers")

    # the status hook's read() gains a `force` flag (used after a write)
    text = replace_literal(
        text,
        """			const read = (0, react.useCallback)(async (signal) => {
				const seq = ++readSeq.current;
				const current = () => mounted.current && signal?.aborted !== true && seq === readSeq.current;""",
        """			const read = (0, react.useCallback)(async (signal, force) => {
				const seq = ++readSeq.current;
				const current = () => mounted.current && signal?.aborted !== true && seq === readSeq.current;""",
        "read signature",
    )

    # every post-write re-read must bypass the shared cache
    for old, new, label in [
        (
            """						if (fieldOf(value, "state") === "stale-account") {
							await read(controller.signal);""",
            """						if (fieldOf(value, "state") === "stale-account") {
							await read(controller.signal, true);""",
            "stale-account read",
        ),
        (
            """					await read(controller.signal);
				} catch (error) {
					if (mounted.current && controller.signal.aborted !== true) setReadFailure(""",
            """					await read(controller.signal, true);
				} catch (error) {
					if (mounted.current && controller.signal.aborted !== true) setReadFailure(""",
            "control read",
        ),
        (
            """				try {
					await read(controller.signal);
				} finally {
					inFlight.current.delete(controller);
					if (mounted.current) setBusy(false);""",
            """				try {
					await read(controller.signal, true);
				} finally {
					inFlight.current.delete(controller);
					if (mounted.current) setBusy(false);""",
            "hook refresh read",
        ),
    ]:
        text = replace_literal(text, old, new, label)

    return text


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--check", action="store_true")
    parser.add_argument("--restore", action="store_true")
    args = parser.parse_args()

    if not CLIENT.is_file():
        print(f"missing: {CLIENT}")
        return 2

    if args.restore:
        backups = sorted(CLIENT.parent.glob("client.js.bak-tokens-*"))
        if not backups:
            print("no backup to restore")
            return 1
        shutil.copy2(backups[-1], CLIENT)
        print(f"restored {CLIENT.name} from {backups[-1].name}")
        return 0

    original = CLIENT.read_text(encoding="utf-8")
    if MARKER in original:
        print("already patched (marker present) - nothing to do")
        return 0
    if args.check:
        print("not patched")
        return 0

    patched = patch(original)
    stamp = time.strftime("%Y%m%d-%H%M%S")
    backup = CLIENT.with_name(f"{CLIENT.name}.bak-tokens-{stamp}")
    shutil.copy2(CLIENT, backup)
    CLIENT.write_text(patched, encoding="utf-8", newline="\n")
    print(f"patched {CLIENT}")
    print(f"  {len(original)} -> {len(patched)} bytes")
    print(f"  backup: {backup}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
