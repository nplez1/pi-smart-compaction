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

/**
 * Idle thresholds for providers whose server-side prompt cache outlives the
 * 5-minute fallback. Keyed by provider id, in milliseconds.
 *
 * DeepSeek caches every prompt on disk by default and keeps a cached prefix
 * until it has gone unused for "a few hours to a few days"
 * (https://api-docs.deepseek.com/guides/kv_cache/). Its cache-hit rate is about
 * 1/50 of the miss rate and cache writes are free, so a resume ten minutes
 * later is an ordinary cheap cache read. Treating that as a miss pays a
 * full-price summary *and* throws the cached prefix away, because the summary
 * starts a fresh prefix. 24h is a deliberately conservative reading of "hours
 * to days": it still compacts genuinely cold sessions, but never a same-day
 * one. OpenAI's prompt cache lifetime is 30 minutes. Per-model overrides are
 * available via `idleThresholdByModel`.
 */
export const PROVIDER_TTL_MS: Readonly<Record<string, number>> = {
	deepseek: 24 * 60 * 60 * 1000,
	openai: 30 * 60 * 1000,
};

/**
 * Built-in model policies for providers that multiplex models from different
 * vendors. GitHub Copilot exposes OpenAI models as `github-copilot/gpt-*`, but
 * also exposes Claude, Gemini, Grok, and other model families, so the provider
 * alone is not specific enough for an OpenAI cache policy.
 */
export const MODEL_TTL_MS: Readonly<Record<string, number>> = {
	"github-copilot/gpt-*": 30 * 60 * 1000,
};

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

/** The parts of a pi model this module needs; all optional so tests stay small. */
export interface CacheModelLike {
	id?: string;
	provider?: string;
	promptCache?: PromptCacheLike;
}

/** Where the idle threshold came from, for the status line and `/smart-compaction`. */
export type TtlSource =
	| "configured"
	| "model-override"
	| "model-declared"
	| "model-policy"
	| "provider-policy"
	| "default";

export interface TtlResolution {
	ms: number;
	source: TtlSource;
}

export interface TtlOptions {
	/** Global override (`idleThresholdMs`). */
	configuredMs?: number;
	/** Per-model overrides (`idleThresholdByModel`), keyed by pattern. */
	byModel?: Readonly<Record<string, number>>;
}

function positiveMs(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined;
}

/** Glob match where `*` is the only wildcard, case-insensitive. */
function matchesPattern(pattern: string, value: string): boolean {
	const escaped = pattern.toLowerCase().replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
	return new RegExp(`^${escaped}$`).test(value);
}

/** Characters a pattern pins down; used to make "most specific wins" order-independent. */
function specificity(pattern: string): number {
	return pattern.replace(/\*/g, "").length;
}

/**
 * Resolve a per-model override against `provider/modelId`, the bare model id, or
 * the provider id. The most specific matching pattern wins, so config key order
 * does not matter.
 */
function matchModelTtl(
	model: CacheModelLike | undefined,
	byModel: Readonly<Record<string, number>> | undefined,
): number | undefined {
	if (!model || !byModel) return undefined;
	const keys = new Set<string>();
	const id = model.id?.trim();
	const provider = model.provider?.trim();
	if (provider && id) keys.add(`${provider}/${id}`);
	if (id) keys.add(id);
	if (provider) keys.add(provider);
	if (keys.size === 0) return undefined;
	const entries = Object.entries(byModel)
		.map(([pattern, ms]) => [pattern, positiveMs(ms)] as const)
		.filter((entry): entry is readonly [string, number] => entry[1] !== undefined)
		.sort(([a], [b]) => specificity(b) - specificity(a));
	for (const [pattern, ms] of entries) {
		for (const key of keys) {
			if (matchesPattern(pattern, key)) return ms;
		}
	}
	return undefined;
}

/**
 * Resolve the idle threshold, most authoritative source first:
 *
 * 1. the global `idleThresholdMs` override;
 * 2. a matching `idleThresholdByModel` override;
 * 3. the model's declared `promptCache.short` (seconds);
 * 4. a built-in model policy (`MODEL_TTL_MS`, e.g. GitHub Copilot's `gpt-*` models: 30m);
 * 5. a built-in provider policy (`PROVIDER_TTL_MS`, e.g. DeepSeek 24h or OpenAI 30m);
 * 6. the 5-minute default that matches pi's own cache-stats assumption.
 *
 * The provider policy sits below the model declaration because a catalog that
 * states its cache lifetime is more current than this table.
 */
export function resolveCacheTtl(model: CacheModelLike | undefined, options: TtlOptions = {}): TtlResolution {
	const configured = positiveMs(options.configuredMs);
	if (configured !== undefined) return { ms: configured, source: "configured" };

	const override = matchModelTtl(model, options.byModel);
	if (override !== undefined) return { ms: override, source: "model-override" };

	const declaredSeconds = positiveMs(model?.promptCache?.short);
	if (declaredSeconds !== undefined) return { ms: declaredSeconds * 1000, source: "model-declared" };

	const modelPolicy = matchModelTtl(model, MODEL_TTL_MS);
	if (modelPolicy !== undefined) return { ms: modelPolicy, source: "model-policy" };

	const provider = model?.provider?.trim().toLowerCase();
	const policy = provider ? positiveMs(PROVIDER_TTL_MS[provider]) : undefined;
	if (policy !== undefined) return { ms: policy, source: "provider-policy" };

	return { ms: DEFAULT_TTL_MS, source: "default" };
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
