import { test } from "node:test";
import assert from "node:assert/strict";
import {
	DEFAULT_CONTEXT_FLOOR_TOKENS,
	DEFAULT_TTL_MS,
	MODEL_TTL_MS,
	PROVIDER_TTL_MS,
	evaluateGate,
	formatIdle,
	formatTokens,
	resolveCacheTtl,
	resolveFloor,
} from "../decision.ts";
import { normalizeConfig, DEFAULT_CONFIG } from "../config.ts";

const base = {
	enabled: true,
	contextTokens: 200_000,
	idleMs: 60 * 60 * 1000,
	ttlMs: DEFAULT_TTL_MS,
	floorTokens: DEFAULT_CONTEXT_FLOOR_TOKENS,
};

test("compacts a large context resumed after the cache expired", () => {
	assert.deepEqual(evaluateGate(base), { compact: true, reason: "compact" });
});

test("skips when the cache is probably still warm", () => {
	const d = evaluateGate({ ...base, idleMs: DEFAULT_TTL_MS - 1 });
	assert.equal(d.compact, false);
	assert.equal(d.reason, "not-idle-enough");
});

test("skips when the context is below the floor even if idle for days", () => {
	const d = evaluateGate({ ...base, contextTokens: 10_000, idleMs: 5 * 24 * 3600_000 });
	assert.equal(d.compact, false);
	assert.equal(d.reason, "below-floor");
});

test("skips when the context estimate is unknown (right after a compaction)", () => {
	for (const tokens of [null, undefined, Number.NaN]) {
		const d = evaluateGate({ ...base, contextTokens: tokens });
		assert.equal(d.compact, false);
		assert.equal(d.reason, "no-context");
	}
});

test("skips when unknown idle (fresh session with no prior request)", () => {
	const d = evaluateGate({ ...base, idleMs: null });
	assert.equal(d.compact, false);
	assert.equal(d.reason, "not-idle-enough");
});

test("respects the master switch", () => {
	const d = evaluateGate({ ...base, enabled: false });
	assert.equal(d.compact, false);
	assert.equal(d.reason, "disabled");
});

test("floor boundary is inclusive", () => {
	assert.equal(evaluateGate({ ...base, contextTokens: base.floorTokens }).compact, true);
	assert.equal(evaluateGate({ ...base, contextTokens: base.floorTokens - 1 }).compact, false);
});

test("resolveCacheTtl: explicit config wins over everything", () => {
	const model = { provider: "deepseek", id: "deepseek-flash", promptCache: { short: 3600 } };
	assert.deepEqual(
		resolveCacheTtl(model, { configuredMs: 60_000, byModel: { "deepseek/*": 12 * 3600_000 } }),
		{ ms: 60_000, source: "configured" },
	);
});

test("resolveCacheTtl: a per-model override beats the provider policy", () => {
	const model = { provider: "deepseek", id: "deepseek-v4-pro" };
	assert.deepEqual(
		resolveCacheTtl(model, { byModel: { "deepseek/deepseek-v4-pro": 3 * 3600_000 } }),
		{ ms: 3 * 3600_000, source: "model-override" },
	);
	// Bare id and provider keys match too.
	assert.deepEqual(resolveCacheTtl(model, { byModel: { "deepseek-v4-pro": 7_200_000 } }), {
		ms: 7_200_000,
		source: "model-override",
	});
	assert.deepEqual(resolveCacheTtl(model, { byModel: { deepseek: 7_200_000 } }), {
		ms: 7_200_000,
		source: "model-override",
	});
});

test("resolveCacheTtl: the most specific override wins regardless of key order", () => {
	const model = { provider: "deepseek", id: "deepseek-flash" };
	for (const byModel of [
		{ "*": 60_000, "deepseek/*": 12 * 3600_000, "deepseek/deepseek-flash": 3 * 3600_000 },
		{ "deepseek/deepseek-flash": 3 * 3600_000, "deepseek/*": 12 * 3600_000, "*": 60_000 },
	]) {
		assert.equal(resolveCacheTtl(model, { byModel }).ms, 3 * 3600_000);
	}
});

test("resolveCacheTtl: a declared model lifetime beats the provider policy", () => {
	const model = { provider: "deepseek", id: "deepseek-flash", promptCache: { short: 300 } };
	assert.deepEqual(resolveCacheTtl(model), { ms: 300_000, source: "model-declared" });
});

test("resolveCacheTtl: DeepSeek waits a day by default", () => {
	const model = { provider: "deepseek", id: "deepseek-flash" };
	assert.equal(PROVIDER_TTL_MS.deepseek, 24 * 3600_000);
	assert.deepEqual(resolveCacheTtl(model), { ms: 24 * 3600_000, source: "provider-policy" });
});

test("resolveCacheTtl: OpenAI waits 30 minutes by default", () => {
	const model = { provider: "OpenAI", id: "gpt-4.1" };
	assert.equal(PROVIDER_TTL_MS.openai, 30 * 60_000);
	assert.deepEqual(resolveCacheTtl(model), { ms: 30 * 60_000, source: "provider-policy" });
});

test("resolveCacheTtl: GitHub Copilot OpenAI models use 30 minutes", () => {
	assert.equal(MODEL_TTL_MS["github-copilot/gpt-*"], 30 * 60_000);
	assert.deepEqual(resolveCacheTtl({ provider: "github-copilot", id: "gpt-5.4" }), {
		ms: 30 * 60_000,
		source: "model-policy",
	});
	assert.deepEqual(resolveCacheTtl({ provider: "github-copilot", id: "gpt-5.3-codex" }), {
		ms: 30 * 60_000,
		source: "model-policy",
	});
});

test("resolveCacheTtl: GitHub Copilot non-OpenAI models do not use OpenAI policy", () => {
	assert.deepEqual(resolveCacheTtl({ provider: "github-copilot", id: "claude-opus-4.8" }), {
		ms: DEFAULT_TTL_MS,
		source: "default",
	});
});

test("resolveCacheTtl: unknown providers and models fall back to 5 minutes", () => {
	assert.deepEqual(resolveCacheTtl({ provider: "fireworks", id: "glm" }), {
		ms: DEFAULT_TTL_MS,
		source: "default",
	});
	assert.deepEqual(resolveCacheTtl(undefined), { ms: DEFAULT_TTL_MS, source: "default" });
});

test("resolveCacheTtl: ignores invalid overrides", () => {
	const model = { provider: "fireworks", id: "glm" };
	assert.deepEqual(resolveCacheTtl(model, { configuredMs: 0, byModel: { "*": Number.NaN } }), {
		ms: DEFAULT_TTL_MS,
		source: "default",
	});
});

test("normalizeConfig drops invalid fields and keeps valid ones", () => {
	const cfg = normalizeConfig({
		enabled: false,
		contextFloorTokens: -5,
		idleThresholdMs: "soon",
		notify: "yes",
		status: false,
	});
	assert.deepEqual(cfg, {
		enabled: false,
		contextFloorPercent: undefined,
		contextFloorTokens: DEFAULT_CONFIG.contextFloorTokens,
		idleThresholdMs: undefined,
		idleThresholdByModel: undefined,
		notify: DEFAULT_CONFIG.notify,
		status: false,
	});
});

test("normalizeConfig keeps a sane percentage and drops an impossible one", () => {
	assert.equal(normalizeConfig({ contextFloorPercent: 15 }).contextFloorPercent, 15);
	assert.equal(normalizeConfig({ contextFloorPercent: 100 }).contextFloorPercent, 100);
	for (const bad of [0, -3, 101, Number.NaN, Number.POSITIVE_INFINITY, "15", null]) {
		assert.equal(normalizeConfig({ contextFloorPercent: bad }).contextFloorPercent, undefined);
	}
});

test("resolveFloor: a percentage is a share of the model's window", () => {
	assert.deepEqual(resolveFloor({ percent: 15, floorTokens: 60_000, contextWindow: 1_048_576 }), {
		tokens: 157_286,
		percent: 15,
		contextWindow: 1_048_576,
	});
	// The same percentage, a different window: 15% of 200k is stricter than the flat floor.
	assert.equal(resolveFloor({ percent: 15, floorTokens: 60_000, contextWindow: 200_000 }).tokens, 30_000);
	assert.equal(resolveFloor({ percent: 15, floorTokens: 60_000, contextWindow: 512_000 }).tokens, 76_800);
});

test("resolveFloor: falls back to the flat floor without a percentage or a window", () => {
	const flat = { tokens: 60_000, percent: undefined, contextWindow: undefined };
	assert.deepEqual(resolveFloor({ floorTokens: 60_000, contextWindow: 1_048_576 }), flat);
	for (const contextWindow of [undefined, null, 0, -1, Number.NaN]) {
		assert.deepEqual(resolveFloor({ percent: 15, floorTokens: 60_000, contextWindow }), flat);
	}
});

test("normalizeConfig keeps valid per-model thresholds and drops the rest", () => {
	const cfg = normalizeConfig({
		idleThresholdByModel: { " deepseek/* ": 86400000, xiaomi: -1, "": 5, fireworks: "glm" },
	});
	assert.deepEqual(cfg.idleThresholdByModel, { "deepseek/*": 86400000 });
	assert.equal(normalizeConfig({ idleThresholdByModel: [] }).idleThresholdByModel, undefined);
	assert.equal(normalizeConfig({ idleThresholdByModel: {} }).idleThresholdByModel, undefined);
});

test("normalizeConfig tolerates non-objects", () => {
	assert.deepEqual(normalizeConfig(null), { ...DEFAULT_CONFIG });
	assert.deepEqual(normalizeConfig("nope"), { ...DEFAULT_CONFIG });
	assert.deepEqual(normalizeConfig([]), { ...DEFAULT_CONFIG });
});

test("formatters", () => {
	assert.equal(formatIdle(45_000), "45s");
	assert.equal(formatIdle(12 * 60_000), "12m");
	assert.equal(formatIdle(4 * 3600_000), "4.0h");
	assert.equal(formatTokens(950), "950");
	assert.equal(formatTokens(312_400), "312k");
	assert.equal(formatTokens(1_200_000), "1.2M");
});
