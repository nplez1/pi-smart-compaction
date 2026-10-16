/**
 * Pure decision logic for the smart-compaction gate.
 *
 * The gate answers one question at the moment a user submits input to an idle
 * session: *should we compact before this turn starts?*
 *
 * Rationale (see README "Why"): pi's summarization request uses a different
 * system prompt and disables cache retention, so compaction can never hit the
 * conversation's prompt cache. Compacting therefore substitutes one full-price
 * read of the context (the summary) for the full-price read the resumed turn
 * would otherwise pay — and in exchange, every later turn of the resumed burst
 * stops re-reading the inherited context at cache-read rates. That is net
 * positive only when the context is large and the previous turn is no longer in
 * cache.
 *
 * Keeping this module free of pi imports makes the boundaries testable.
 */

/** Default context floor, in tokens. Below this a resume burst rarely repays a summary. */
export const DEFAULT_CONTEXT_FLOOR_TOKENS = 60_000;

/** Fallback idle threshold when the model declares no prompt-cache lifetime. */
export const DEFAULT_TTL_MS = 5 * 60 * 1000;

export type GateReason =
	| "disabled"
	| "no-context"
	| "below-floor"
	| "not-idle-enough"
	| "compact";

export interface GateDecision {
	compact: boolean;
	reason: GateReason;
}

export interface GateInput {
	enabled: boolean;
	/** Estimated projection tokens for the active model, or null/undefined when unknown. */
	contextTokens: number | null | undefined;
	/** Milliseconds since the last model request on this branch, or null when unknown. */
	idleMs: number | null | undefined;
	/** Idle threshold: the model's prompt-cache lifetime, or a configured value. */
	ttlMs: number;
	/** Minimum context size worth compacting. */
	floorTokens: number;
}

export function evaluateGate(input: GateInput): GateDecision {
	if (!input.enabled) {
		return { compact: false, reason: "disabled" };
	}
	const tokens = input.contextTokens;
	if (tokens === null || tokens === undefined || !Number.isFinite(tokens)) {
		// Right after a compaction (or before the first response) the estimate is
		// unknown; compacting again would be both unnecessary and possibly recursive.
		return { compact: false, reason: "no-context" };
	}
	if (tokens < input.floorTokens) {
		return { compact: false, reason: "below-floor" };
	}
	const idle = input.idleMs;
	if (idle === null || idle === undefined || !Number.isFinite(idle) || idle < input.ttlMs) {
		// Cache is probably still warm: a compaction summary would cost more than
		// the cache-read it replaces.
		return { compact: false, reason: "not-idle-enough" };
	}
	return { compact: true, reason: "compact" };
}

export interface PromptCacheLike {
	/** Prompt-cache lifetime in seconds for the short (default) retention tier. */
	short?: number;
	long?: number;
}

/**
 * Resolve the idle threshold. An explicit configured value always wins; otherwise
 * use the model's declared short-tier cache lifetime; otherwise the 5-minute
 * default that matches pi's own cache-stats assumption.
 */
export function resolveTtlMs(promptCache: PromptCacheLike | undefined, configuredMs?: number): number {
	if (typeof configuredMs === "number" && Number.isFinite(configuredMs) && configuredMs > 0) {
		return configuredMs;
	}
	const short = promptCache?.short;
	if (typeof short === "number" && Number.isFinite(short) && short > 0) {
		return short * 1000;
	}
	return DEFAULT_TTL_MS;
}

/** Human-readable idle duration, e.g. `3.4h`, `12m`, `45s`. */
export function formatIdle(ms: number): string {
	const seconds = Math.max(0, Math.round(ms / 1000));
	if (seconds < 60) return `${seconds}s`;
	const minutes = Math.round(seconds / 60);
	if (minutes < 60) return `${minutes}m`;
	const hours = seconds / 3600;
	if (hours < 48) return `${hours.toFixed(1)}h`;
	return `${(hours / 24).toFixed(1)}d`;
}

/** Compact token count, e.g. `312k`, `1.2M`. */
export function formatTokens(tokens: number): string {
	if (tokens < 1000) return String(Math.round(tokens));
	if (tokens < 1_000_000) return `${Math.round(tokens / 1000)}k`;
	return `${(tokens / 1_000_000).toFixed(1)}M`;
}
