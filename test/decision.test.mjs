import { test } from "node:test";
import assert from "node:assert/strict";
import {
	DEFAULT_CONTEXT_FLOOR_TOKENS,
	DEFAULT_TTL_MS,
	evaluateGate,
	formatIdle,
	formatTokens,
	resolveTtlMs,
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

test("resolveTtlMs: explicit config wins", () => {
	assert.equal(resolveTtlMs({ short: 3600 }, 60_000), 60_000);
});

test("resolveTtlMs: model short tier in seconds, else the default", () => {
	assert.equal(resolveTtlMs({ short: 300 }), 300_000);
	assert.equal(resolveTtlMs({}), DEFAULT_TTL_MS);
	assert.equal(resolveTtlMs(undefined), DEFAULT_TTL_MS);
	assert.equal(resolveTtlMs({ long: 3600 }), DEFAULT_TTL_MS);
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
		contextFloorTokens: DEFAULT_CONFIG.contextFloorTokens,
		idleThresholdMs: undefined,
		notify: DEFAULT_CONFIG.notify,
		status: false,
	});
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
