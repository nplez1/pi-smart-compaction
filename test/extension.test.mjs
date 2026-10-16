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

function makeCtx({ tokens = 200_000, idle = true, promptCache = { short: 300 } } = {}) {
	const state = { compactCalls: 0, status: undefined, notifications: [] };
	const ctx = {
		mode: "tui",
		hasUI: true,
		isIdle: () => idle,
		model: { promptCache },
		getContextUsage: () => ({ tokens, contextWindow: 200_000, percent: null }),
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
