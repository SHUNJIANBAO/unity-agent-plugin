/**
 * Durable plugin state: which skills are enabled, and what the updater last saw.
 *
 * Everything lives in one JSON file under `$DSH_HOME/unity-agent-plugin/`.
 * Writing is atomic (temp file + rename) because the Host can be killed at any
 * moment, and reading is tolerant: a corrupt file is moved aside instead of
 * making the plugin throw during activation.
 *
 * @module lib/store
 */

import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

/** Version of the on-disk state document. */
export const STATE_VERSION = 1;

/**
 * The state a fresh installation starts from.
 *
 * @returns {object} an empty state document.
 */
export function emptyState() {
	return {
		version: STATE_VERSION,
		createdAt: new Date().toISOString(),
		// Absent names are enabled, so a new upstream skill becomes usable
		// without the user having to visit settings first.
		enabled: {},
		upstream: {},
	};
}

function normalize(raw) {
	const base = emptyState();
	if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return base;
	const enabled = {};
	if (raw.enabled !== null && typeof raw.enabled === "object" && !Array.isArray(raw.enabled)) {
		for (const [key, value] of Object.entries(raw.enabled)) {
			if (typeof value === "boolean") enabled[key] = value;
		}
	}
	return {
		version: STATE_VERSION,
		createdAt: typeof raw.createdAt === "string" ? raw.createdAt : base.createdAt,
		enabled,
		upstream: raw.upstream !== null && typeof raw.upstream === "object" && !Array.isArray(raw.upstream) ? raw.upstream : {},
	};
}

/**
 * Create the plugin's state store.
 *
 * @param {object} options - store options.
 * @param {string} options.file - absolute path of the JSON state file.
 * @param {{ warn?: (message: string) => void }} [options.logger] - optional logger.
 * @param {number} [options.debounceMs] - write coalescing window.
 * @returns {{ get: () => object, patch: (mutate: (state: object) => void) => object, flush: () => boolean, file: string }} the store.
 */
export function createStore({ file, logger, debounceMs = 120 }) {
	mkdirSync(dirname(file), { recursive: true });
	let state = load();
	let timer = null;

	function load() {
		if (!existsSync(file)) return emptyState();
		try {
			return normalize(JSON.parse(readFileSync(file, "utf8")));
		} catch (error) {
			const aside = `${file}.corrupt-${Date.now()}`;
			try {
				renameSync(file, aside);
				logger?.warn?.(`dsh-unity-agent: state file was unreadable (${error?.message ?? error}); moved to ${aside}`);
			} catch {
				logger?.warn?.(`dsh-unity-agent: state file was unreadable (${error?.message ?? error})`);
			}
			return emptyState();
		}
	}

	function writeNow() {
		if (timer !== null) {
			clearTimeout(timer);
			timer = null;
		}
		const temporary = `${file}.tmp`;
		try {
			writeFileSync(temporary, `${JSON.stringify(state, null, 2)}\n`, "utf8");
			renameSync(temporary, file);
			return true;
		} catch (error) {
			logger?.warn?.(`dsh-unity-agent: could not persist state (${error?.message ?? error})`);
			try {
				rmSync(temporary, { force: true });
			} catch {
				/* the temp file is best-effort cleanup */
			}
			return false;
		}
	}

	function schedule() {
		if (timer !== null) return;
		timer = setTimeout(() => {
			timer = null;
			writeNow();
		}, debounceMs);
		if (typeof timer.unref === "function") timer.unref();
	}

	return {
		file,
		get: () => state,
		patch(mutate) {
			mutate(state);
			schedule();
			return state;
		},
		/** Write immediately; `true` only when the state file is durable on disk. */
		flush: writeNow,
	};
}
