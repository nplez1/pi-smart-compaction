import { test } from "node:test";
import assert from "node:assert/strict";
import smartCompaction from "../index.ts";

/** Minimal fake of the ExtensionAPI surface this extension uses. */
function makeFakePi() {
	const handlers = new Map();
	const commands = new Map();
	const renderers = new Map();
	const entries = [];
	return {
		on(event, handler) {
			if (!handlers.has(event)) handlers.set(event, []);
			handlers.get(event).push(handler);
			return () => {};
		},
		registerCommand(name, options) {
			commands.set(name, options);
		},
		registerEntryRenderer(type, renderer) {
			renderers.set(type, renderer);
		},
		appendEntry(type, data) {
			entries.push({ type, data });
		},
		handlers,
		commands,
		renderers,
		entries,
	};
}

function makeCtx({
	tokens = 200_000,
	contextWindow = 200_000,
	idle = true,
	promptCache = { short: 300 },
	provider = "anthropic",
	id = "claude-sonnet-5",
} = {}) {
	const state = { compactCalls: 0, status: undefined, notifications: [] };
	const ctx = {
		mode: "tui",
		hasUI: true,
		isIdle: () => idle,
		model: { provider, id, promptCache },
		getContextUsage: () => ({ tokens, contextWindow, percent: null }),
		sessionManager: { getBranch: () => [] },
		ui: {
			notify(message) {
				state.notifications.push(message);
			},
			setStatus(_key, text) {
				state.status = text;
			},
		},
		compact(options) {
			state.compactCalls += 1;
			options.onComplete?.({ tokensBefore: tokens, estimatedTokensAfter: 20_000 });
		},
	};
	return { ctx, state };
}

async function fire(pi, event, ctx) {
	const list = pi.handlers.get(event) ?? [];
	for (const handler of list) await handler({ type: event }, ctx);
}

async function fireInput(pi, event, ctx) {
	const list = pi.handlers.get("input") ?? [];
	let result;
	for (const handler of list) result = await handler({ type: "input", ...event }, ctx);
	return result;
}

/** An assistant entry timestamped `ageMs` ago, so bootstrap computes a real idle gap. */
function oldAssistantBranch(ageMs) {
	return [
		{
			type: "message",
			timestamp: new Date(Date.now() - ageMs).toISOString(),
			message: { role: "assistant" },
		},
	];
}

test("registers its command and entry renderer", () => {
	const pi = makeFakePi();
	smartCompaction(pi);
	assert.ok(pi.commands.has("smart-compaction"));
	assert.ok(pi.renderers.has("smart-compaction"));
});

test("compacts a large context on resume after the cache expired", async () => {
	const pi = makeFakePi();
	smartCompaction(pi);
	const { ctx, state } = makeCtx({ tokens: 200_000 });

	// Resume: the branch's last assistant turn was an hour ago.
	ctx.sessionManager.getBranch = () => oldAssistantBranch(3600_000);
	await fire(pi, "session_start", ctx);

	const result = await fireInput(pi, { text: "fix the PR comment", source: "interactive" }, ctx);
	assert.deepEqual(result, { action: "continue" });
	assert.equal(state.compactCalls, 1, "expected compaction to be triggered");
	assert.equal(pi.entries.length, 1);
	assert.equal(pi.entries[0].type, "smart-compaction");
	assert.equal(pi.entries[0].data.tokensBefore, 200_000);
	assert.match(state.status, /compacted 200k→20k/);
});

test("does not compact while the cache is still warm", async () => {
	const pi = makeFakePi();
	smartCompaction(pi);
	const { ctx, state } = makeCtx({ tokens: 200_000 });

	ctx.sessionManager.getBranch = () => oldAssistantBranch(60_000); // 1 minute
	await fire(pi, "session_start", ctx);
	await fireInput(pi, { text: "carry on", source: "interactive" }, ctx);
	assert.equal(state.compactCalls, 0);
});

test("does not compact a small context even after days idle", async () => {
	const pi = makeFakePi();
	smartCompaction(pi);
	const { ctx, state } = makeCtx({ tokens: 12_000, promptCache: { short: 60 } });

	ctx.sessionManager.getBranch = () => oldAssistantBranch(3 * 24 * 3600_000);
	await fire(pi, "session_start", ctx);
	await fireInput(pi, { text: "quick question", source: "interactive" }, ctx);
	assert.equal(state.compactCalls, 0);
});

test("ignores steering input while streaming and extension-sourced input", async () => {
	const pi = makeFakePi();
	smartCompaction(pi);
	const { ctx, state } = makeCtx({ tokens: 200_000 });

	ctx.sessionManager.getBranch = () => oldAssistantBranch(3600_000);
	await fire(pi, "session_start", ctx);

	await fireInput(pi, { text: "steer", source: "interactive", streamingBehavior: "steer" }, ctx);
	await fireInput(pi, { text: "injected", source: "extension" }, ctx);
	assert.equal(state.compactCalls, 0);
});

test("the model's cache TTL is the default idle threshold, config overrides it", async () => {
	const pi = makeFakePi();
	smartCompaction(pi);
	// Model declares a 1-hour cache; a 10-minute gap should not trigger.
	const { ctx, state } = makeCtx({ tokens: 200_000, promptCache: { short: 3600 } });
	ctx.sessionManager.getBranch = () => oldAssistantBranch(600_000);
	await fire(pi, "session_start", ctx);
	await fireInput(pi, { text: "hi", source: "interactive" }, ctx);
	assert.equal(state.compactCalls, 0);
});

test("DeepSeek's long-lived cache keeps a 10-minute resume from compacting", async () => {
	const pi = makeFakePi();
	smartCompaction(pi);
	// DeepSeek declares no promptCache; its disk cache lives for hours-to-days.
	const { ctx, state } = makeCtx({
		tokens: 200_000,
		provider: "deepseek",
		id: "deepseek-flash",
		promptCache: null, // DeepSeek declares none
	});
	ctx.sessionManager.getBranch = () => oldAssistantBranch(11 * 60_000);
	await fire(pi, "session_start", ctx);

	await fireInput(pi, { text: "carry on", source: "interactive" }, ctx);
	assert.equal(state.compactCalls, 0, "a 11-minute gap is still a warm DeepSeek cache");
	assert.match(state.status, /idle≥24\.0h/);
});

test("GitHub Copilot's OpenAI cache keeps a 29-minute resume from compacting", async () => {
	const pi = makeFakePi();
	smartCompaction(pi);
	// Copilot multiplexes vendors; identify this as OpenAI by its gpt-* model ID.
	const { ctx, state } = makeCtx({
		tokens: 200_000,
		provider: "github-copilot",
		id: "gpt-5.4",
		promptCache: null,
	});
	ctx.sessionManager.getBranch = () => oldAssistantBranch(29 * 60_000);
	await fire(pi, "session_start", ctx);

	await fireInput(pi, { text: "carry on", source: "interactive" }, ctx);
	assert.equal(state.compactCalls, 0, "a 29-minute gap is still a warm OpenAI cache");
	assert.match(state.status, /idle≥30m/);
});

test("DeepSeek still compacts once its cache is genuinely cold", async () => {
	const pi = makeFakePi();
	smartCompaction(pi);
	const { ctx, state } = makeCtx({
		tokens: 200_000,
		provider: "deepseek",
		id: "deepseek-flash",
		promptCache: null, // DeepSeek declares none
	});
	ctx.sessionManager.getBranch = () => oldAssistantBranch(30 * 3600_000);
	await fire(pi, "session_start", ctx);

	await fireInput(pi, { text: "pick this back up", source: "interactive" }, ctx);
	assert.equal(state.compactCalls, 1);
	assert.match(state.notifications.at(-1), /after 30\.0h idle/);
});

test("idleThresholdByModel from the config file widens or narrows the gate", async (t) => {
	const { mkdtempSync, writeFileSync } = await import("node:fs");
	const { tmpdir } = await import("node:os");
	const { join } = await import("node:path");
	const dir = mkdtempSync(join(tmpdir(), "smart-compaction-"));
	const file = join(dir, "config.json");
	t.after(() => {
		delete process.env.PI_SMART_COMPACTION_CONFIG;
	});
	process.env.PI_SMART_COMPACTION_CONFIG = file;

	// Force a 2h threshold for DeepSeek: a 3h gap now compacts.
	writeFileSync(file, JSON.stringify({ idleThresholdByModel: { "deepseek/*": 2 * 3600_000 } }));
	const pi = makeFakePi();
	smartCompaction(pi);
	const { ctx, state } = makeCtx({
		tokens: 200_000,
		provider: "deepseek",
		id: "deepseek-flash",
		promptCache: null, // DeepSeek declares none
	});
	ctx.sessionManager.getBranch = () => oldAssistantBranch(3 * 3600_000);
	await fire(pi, "session_start", ctx);
	await fireInput(pi, { text: "go", source: "interactive" }, ctx);
	assert.equal(state.compactCalls, 1);
});

/** Write a config file for one test and restore the default path afterwards. */
async function withConfig(t, config) {
	const { mkdtempSync, writeFileSync } = await import("node:fs");
	const { tmpdir } = await import("node:os");
	const { join } = await import("node:path");
	const file = join(mkdtempSync(join(tmpdir(), "smart-compaction-")), "config.json");
	writeFileSync(file, JSON.stringify(config));
	t.after(() => {
		delete process.env.PI_SMART_COMPACTION_CONFIG;
	});
	process.env.PI_SMART_COMPACTION_CONFIG = file;
	return file;
}

test("contextFloorPercent makes the floor a share of the model's window", async (t) => {
	// 15% of a 200k window is a 30k floor: a 45k resume is worth compacting,
	// where the 60k token default would have skipped it.
	await withConfig(t, { contextFloorPercent: 15 });
	const pi = makeFakePi();
	smartCompaction(pi);
	const { ctx, state } = makeCtx({ tokens: 45_000, contextWindow: 200_000 });
	ctx.sessionManager.getBranch = () => oldAssistantBranch(3600_000);
	await fire(pi, "session_start", ctx);
	assert.match(state.status, /≥30k \(15% of 200k\)/);

	await fireInput(pi, { text: "resume", source: "interactive" }, ctx);
	assert.equal(state.compactCalls, 1);
});

test("the same percentage is stricter on a model with a larger window", async (t) => {
	// 15% of a 1M window is 157k, so the 100k context waits.
	await withConfig(t, { contextFloorPercent: 15 });
	const pi = makeFakePi();
	smartCompaction(pi);
	const { ctx, state } = makeCtx({ tokens: 100_000, contextWindow: 1_048_576 });
	ctx.sessionManager.getBranch = () => oldAssistantBranch(3600_000);
	await fire(pi, "session_start", ctx);

	await fireInput(pi, { text: "resume", source: "interactive" }, ctx);
	assert.equal(state.compactCalls, 0);
});

test("a model with no declared window falls back to the flat token floor", async (t) => {
	await withConfig(t, { contextFloorPercent: 15 });
	const pi = makeFakePi();
	smartCompaction(pi);
	const { ctx, state } = makeCtx({ tokens: 45_000, contextWindow: 0 });
	ctx.sessionManager.getBranch = () => oldAssistantBranch(3600_000);
	await fire(pi, "session_start", ctx);
	assert.match(state.status, /≥60k ·/);

	await fireInput(pi, { text: "resume", source: "interactive" }, ctx);
	assert.equal(state.compactCalls, 0, "45k is below the 60k fallback floor");
});
