/**
 * Configuration for pi-smart-compaction.
 *
 * Read fresh on each decision so edits take effect without `/reload`, matching
 * the convention used by the other plugins in this config. The file is optional;
 * a missing or malformed file falls back to the defaults below.
 *
 * Location: ~/.config/pi-smart-compaction/config.json
 * Override: PI_SMART_COMPACTION_CONFIG=/path/to/config.json (used by tests)
 */

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { DEFAULT_CONTEXT_FLOOR_TOKENS } from "./decision.js";

export interface SmartCompactionConfig {
	/** Master switch. */
	enabled: boolean;
	/** Minimum projected context (tokens) worth compacting on resume. */
	contextFloorTokens: number;
	/** Idle threshold override in ms. Undefined means "use the model's cache TTL". */
	idleThresholdMs: number | undefined;
	/**
	 * Per-model idle threshold overrides in ms. Keys match `provider/modelId`, a
	 * bare model id, or a provider id, with `*` as a wildcard (`deepseek/*`).
	 * The most specific matching key wins.
	 */
	idleThresholdByModel: Record<string, number> | undefined;
	/** Show a transcript notice when compaction runs. */
	notify: boolean;
	/** Show a footer status line. */
	status: boolean;
}

export const DEFAULT_CONFIG: SmartCompactionConfig = {
	enabled: true,
	contextFloorTokens: DEFAULT_CONTEXT_FLOOR_TOKENS,
	idleThresholdMs: undefined,
	idleThresholdByModel: undefined,
	notify: true,
	status: true,
};

export function configPath(): string {
	const override = process.env.PI_SMART_COMPACTION_CONFIG;
	if (override && override.trim() !== "") return override;
	return join(homedir(), ".config", "pi-smart-compaction", "config.json");
}

function asBoolean(value: unknown, fallback: boolean): boolean {
	return typeof value === "boolean" ? value : fallback;
}

function asPositiveNumber(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined;
}

/** Keep only well-formed pattern → ms entries; an empty map becomes undefined. */
function asTtlMap(value: unknown): Record<string, number> | undefined {
	if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
	const map: Record<string, number> = {};
	for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
		const pattern = key.trim();
		const ms = asPositiveNumber(raw);
		if (pattern !== "" && ms !== undefined) map[pattern] = ms;
	}
	return Object.keys(map).length > 0 ? map : undefined;
}

/** Normalize an arbitrary parsed value into a valid config, dropping bad fields. */
export function normalizeConfig(raw: unknown): SmartCompactionConfig {
	if (!raw || typeof raw !== "object") return { ...DEFAULT_CONFIG };
	const obj = raw as Record<string, unknown>;
	const floor = asPositiveNumber(obj.contextFloorTokens);
	return {
		enabled: asBoolean(obj.enabled, DEFAULT_CONFIG.enabled),
		contextFloorTokens: floor ?? DEFAULT_CONFIG.contextFloorTokens,
		idleThresholdMs: asPositiveNumber(obj.idleThresholdMs),
		idleThresholdByModel: asTtlMap(obj.idleThresholdByModel),
		notify: asBoolean(obj.notify, DEFAULT_CONFIG.notify),
		status: asBoolean(obj.status, DEFAULT_CONFIG.status),
	};
}

export function loadConfig(): SmartCompactionConfig {
	let text: string;
	try {
		text = readFileSync(configPath(), "utf8");
	} catch {
		return { ...DEFAULT_CONFIG };
	}
	try {
		return normalizeConfig(JSON.parse(text));
	} catch {
		return { ...DEFAULT_CONFIG };
	}
}
