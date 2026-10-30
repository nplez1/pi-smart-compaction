/**
 * pi-smart-compaction — cache-aware compaction at resume.
 *
 * Problem: sessions kept open for hours or days are resumed with a large
 * context whose prompt cache has long expired. The first turn of the resumed
 * burst re-reads the whole context at full price, and — because the burst has
 * to live with that inherited context — so does every later turn, at cache-read
 * rates. Compacting before the resumed turn trades one full-price read (the
 * summary) for a permanently smaller context.
 *
 * Trigger: only when the session is idle at the moment new input arrives, the
 * previous request is older than the model's prompt-cache lifetime, and the
 * projected context is at or above a token floor. This is deliberately
 * *reactive*: pi's summarization request uses its own system prompt and disables
 * cache retention, so it cannot hit the conversation cache — compacting while
 * the cache is warm buys nothing over compacting at resume, and would waste a
 * summary on sessions that are never resumed.
 *
 * The idle threshold is model-aware: a declared `promptCache.short` wins,
 * built-in model policies identify OpenAI `gpt-*` models served by GitHub
 * Copilot (30m), providers with known cache lifetimes (DeepSeek, 24h; OpenAI,
 * 30m) use those policies, and everything else falls back to 5 minutes. See
 * decision.ts.
 *
 * Summarization itself is left to pi's default compaction path; this extension
 * only decides *when* to invoke it.
 *
 * Config: ~/.config/pi-smart-compaction/config.json (optional).
 * Command: /smart-compaction [force]
 */

import { Text } from "@earendil-works/pi-tui";
import type {
	ExtensionAPI,
	ExtensionContext,
	SessionEntry,
} from "@earendil-works/pi-coding-agent";
import { configPath, loadConfig, type SmartCompactionConfig } from "./config.js";
import {
	evaluateGate,
	formatIdle,
	formatTokens,
	resolveCacheTtl,
	resolveFloor,
	type FloorResolution,
	type TtlResolution,
	type TtlSource,
} from "./decision.js";

const ENTRY_TYPE = "smart-compaction";
const STATUS_KEY = "smart-compaction";

interface CompactionNotice {
	tokensBefore: number;
	tokensAfter?: number;
	idleMs: number;
	timestamp: number;
}

/** Timestamp (ms) of the last model request on the branch, for idle measurement. */
let lastActivityAt: number | null = null;
/** Guards against re-entering compaction from a second input event. */
let compacting = false;

function entryMs(entry: SessionEntry): number {
	const parsed = Date.parse(entry.timestamp);
	return Number.isFinite(parsed) ? parsed : 0;
}

/**
 * Reconstruct the last-request time when a session is resumed in a fresh
 * process, so an already-idle session is recognised on the very first input.
 */
function bootstrapLastActivity(ctx: ExtensionContext): void {
	let latest = 0;
	for (const entry of ctx.sessionManager.getBranch()) {
		if (entry.type === "message") {
			if (entry.message.role === "assistant") latest = Math.max(latest, entryMs(entry));
		} else if (entry.type === "usage") {
			latest = Math.max(latest, entryMs(entry));
		}
	}
	lastActivityAt = latest > 0 ? latest : null;
}

function setStatus(ctx: ExtensionContext, config: SmartCompactionConfig, text: string | undefined): void {
	if (config.status && ctx.mode === "tui") {
		ctx.ui.setStatus(STATUS_KEY, text);
	}
}

/** Resolve the idle threshold for the session's current model and config. */
function idleThreshold(ctx: ExtensionContext, config: SmartCompactionConfig): TtlResolution {
	return resolveCacheTtl(ctx.model, {
		configuredMs: config.idleThresholdMs,
		byModel: config.idleThresholdByModel,
	});
}

function ttlSourceLabel(ttl: TtlResolution, ctx: ExtensionContext): string {
	const labels: Record<TtlSource, string> = {
		configured: "configured idleThresholdMs",
		"model-override": "idleThresholdByModel",
		"model-declared": "model promptCache",
		"model-policy": "built-in model cache policy",
		"provider-policy": `${ctx.model?.provider ?? "provider"} cache policy`,
		default: "default (no declared cache lifetime)",
	};
	return labels[ttl.source];
}

function armedStatus(ctx: ExtensionContext, config: SmartCompactionConfig): string {
	const ttl = idleThreshold(ctx, config);
	return `armed · ≥${floorLabel(floorFor(ctx, config))} · idle≥${formatIdle(ttl.ms)}`;
}

/** Resolve the token floor for the session's current model and config. */
function floorFor(ctx: ExtensionContext, config: SmartCompactionConfig): FloorResolution {
	return resolveFloor({
		percent: config.contextFloorPercent,
		floorTokens: config.contextFloorTokens,
		// The window pi resolved for the active model — the same one /context and
		// the footer percentage use. `ctx.model` is the fallback for a session that
		// cannot report usage yet.
		contextWindow: ctx.getContextUsage()?.contextWindow ?? ctx.model?.contextWindow,
	});
}

/** `157k (15% of 1.0M)` for a window-relative floor, `60k` for a flat one. */
function floorLabel(floor: FloorResolution): string {
	if (floor.percent === undefined || floor.contextWindow === undefined) {
		return `${formatTokens(floor.tokens)}`;
	}
	return `${formatTokens(floor.tokens)} (${floor.percent}% of ${formatTokens(floor.contextWindow)})`;
}

function notify(ctx: ExtensionContext, config: SmartCompactionConfig, message: string, type: "info" | "warning" | "error"): void {
	if (config.notify && ctx.hasUI) {
		ctx.ui.notify(message, type);
	}
}

/** Run pi's default compaction and resolve once it completes or fails. */
function compactNow(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	config: SmartCompactionConfig,
	idleMs: number,
): Promise<void> {
	if (compacting) return Promise.resolve();
	compacting = true;
	return new Promise<void>((resolve) => {
		const finish = () => {
			compacting = false;
			resolve();
		};
		try {
			ctx.compact({
				onComplete: (result) => {
					const notice: CompactionNotice = {
						tokensBefore: result.tokensBefore,
						tokensAfter: result.estimatedTokensAfter,
						idleMs,
						timestamp: Date.now(),
					};
					const after = notice.tokensAfter !== undefined ? `→${formatTokens(notice.tokensAfter)}` : "";
					const line = `Smart compaction after ${formatIdle(idleMs)} idle: ${formatTokens(notice.tokensBefore)}${after} tokens`;
					notify(ctx, config, line, "info");
					if (config.notify) {
						try {
							pi.appendEntry<CompactionNotice>(ENTRY_TYPE, notice);
						} catch {
							// A failed bookkeeping append must not affect the run.
						}
					}
					setStatus(ctx, config, `compacted ${formatTokens(notice.tokensBefore)}${after}`);
					finish();
				},
				onError: (error) => {
					// "Nothing to compact" / "Already compacted" are expected races, not faults.
					const expected = /nothing to compact|already compacted/i.test(error.message);
					if (!expected) {
						notify(ctx, config, `Smart compaction skipped: ${error.message}`, "warning");
					}
					setStatus(ctx, config, armedStatus(ctx, config));
					finish();
				},
			});
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			notify(ctx, config, `Smart compaction failed: ${message}`, "error");
			finish();
		}
	});
}

export default function (pi: ExtensionAPI) {
	pi.registerEntryRenderer<CompactionNotice>(ENTRY_TYPE, (entry, _options, theme) => {
		const data = entry.data;
		if (!data) return undefined;
		const after = data.tokensAfter !== undefined ? `→${formatTokens(data.tokensAfter)}` : "";
		const line = `${theme.fg("accent", "[smart-compaction]")} idle ${formatIdle(data.idleMs)} · ${formatTokens(data.tokensBefore)}${after} tokens`;
		return new Text(line, 1, 0);
	});

	pi.on("session_start", (_event, ctx) => {
		bootstrapLastActivity(ctx);
		const config = loadConfig();
		setStatus(ctx, config, config.enabled ? armedStatus(ctx, config) : "off");
	});

	pi.on("message_end", (event) => {
		if (event.message.role === "assistant") {
			lastActivityAt = Date.now();
		}
	});

	// A settled run is also "activity": the request that just finished refreshed
	// (or wrote) the cache, so idle is measured from here even if no assistant
	// message was recorded.
	pi.on("agent_settled", () => {
		lastActivityAt = Date.now();
	});

	pi.on("input", async (event, ctx) => {
		const config = loadConfig();
		if (!config.enabled || event.source === "extension" || event.streamingBehavior !== undefined || !ctx.isIdle() || compacting) {
			return { action: "continue" };
		}
		const ttlMs = idleThreshold(ctx, config).ms;
		const idleMs = lastActivityAt === null ? null : Date.now() - lastActivityAt;
		const decision = evaluateGate({
			enabled: config.enabled,
			contextTokens: ctx.getContextUsage()?.tokens,
			idleMs,
			ttlMs,
			floorTokens: floorFor(ctx, config).tokens,
		});
		if (!decision.compact) {
			return { action: "continue" };
		}
		await compactNow(pi, ctx, config, idleMs ?? 0);
		return { action: "continue" };
	});

	pi.registerCommand("smart-compaction", {
		description: "Show cache-aware compaction status, or force a compaction now",
		handler: async (args, ctx) => {
			const config = loadConfig();
			if (args.trim().toLowerCase() === "force") {
				const idleMs = lastActivityAt === null ? 0 : Date.now() - lastActivityAt;
				await compactNow(pi, ctx, config, idleMs);
				return;
			}
			const ttl = idleThreshold(ctx, config);
			const usage = ctx.getContextUsage();
			const idleMs = lastActivityAt === null ? null : Date.now() - lastActivityAt;
			const lines = [
				`pi-smart-compaction: ${config.enabled ? "enabled" : "disabled"}`,
				`model: ${ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : "unknown"}`,
				`floor: ${floorLabel(floorFor(ctx, config))} tokens · idle threshold: ${formatIdle(ttl.ms)} (${ttlSourceLabel(ttl, ctx)})`,
				`context: ${usage?.tokens !== undefined && usage?.tokens !== null ? `${formatTokens(usage.tokens)} tokens` : "unknown"}`,
				`idle: ${idleMs === null ? "unknown" : formatIdle(idleMs)}`,
				`config: ${configPath()} · /smart-compaction force to compact now`,
			];
			if (ctx.hasUI) ctx.ui.notify(lines.join("\n"), "info");
		},
	});

	// Clear the footer status on reload/quit so a stale line does not survive the runtime swap.
	pi.on("session_shutdown", (_event, ctx) => {
		if (ctx.mode === "tui") ctx.ui.setStatus(STATUS_KEY, undefined);
	});
}
