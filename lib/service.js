/**
 * The plugin's core: one object that owns the catalog, the state file and the
 * upstream checkout, and that both the DSH skill provider and the settings HTTP
 * API talk to.
 *
 * Keeping the wiring in `index.js` thin makes the interesting behavior testable
 * without a Harness: `test/store.test.mjs`, `test/catalog.test.mjs`,
 * `test/upstream.test.mjs`, `test/api.test.mjs` and `test/provider.test.mjs`
 * drive this module against temporary directories.
 *
 * @module lib/service
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import {
	diffSnapshots,
	listSkills,
	loadSkill,
	snapshotSkills,
} from "./catalog.js";
import { createStore } from "./store.js";
import { DEFAULT_UPSTREAM_URL, UPSTREAM_BRANCH, createUpstream } from "./upstream.js";

/** How long a `git rev-parse` answer is reused before asking git again. */
const LOCAL_STATE_TTL_MS = 5_000;

/** Read `upstream.json`, the provenance stamp of the bundled snapshot. */
function readBundledProvenance(packageDir) {
	try {
		const parsed = JSON.parse(readFileSync(join(packageDir, "upstream.json"), "utf8"));
		return {
			repo: typeof parsed?.repo === "string" ? parsed.repo : DEFAULT_UPSTREAM_URL,
			branch: typeof parsed?.branch === "string" ? parsed.branch : UPSTREAM_BRANCH,
			commit: typeof parsed?.commit === "string" ? parsed.commit : undefined,
			version: typeof parsed?.version === "string" ? parsed.version : undefined,
			snapshotAt: typeof parsed?.snapshotAt === "string" ? parsed.snapshotAt : undefined,
		};
	} catch {
		return { repo: DEFAULT_UPSTREAM_URL, branch: UPSTREAM_BRANCH };
	}
}

/**
 * Create the plugin core.
 *
 * @param {object} options - core options.
 * @param {string} options.packageDir - this package's directory (holds `skills/`).
 * @param {string} options.dataDir - plugin data directory under `$DSH_HOME`.
 * @param {string} [options.packageVersion] - version of this plugin.
 * @param {string} [options.upstreamUrl] - repository to mirror.
 * @param {{ warn?: Function, info?: Function, error?: Function }} [options.logger] - logger.
 * @param {object} [options.upstream] - an upstream manager replacement (tests).
 * @returns {object} the plugin core.
 */
export function createService({
	packageDir,
	dataDir,
	packageVersion = "0.0.0",
	upstreamUrl = DEFAULT_UPSTREAM_URL,
	logger,
	upstream,
}) {
	const bundled = readBundledProvenance(packageDir);
	const store = createStore({ file: join(dataDir, "state.json"), logger });
	const upstreamManager = upstream ?? createUpstream({ dataDir, url: upstreamUrl, logger });
	const bundledRoot = packageDir;
	let invalidateProvider = null;
	let localStateCache = { at: 0, value: undefined };
	let gitInfoCache;
	let actionQueue = Promise.resolve();

	/** Serialize settings actions so two clicks cannot interleave two clones. */
	function serialized(operation) {
		const next = actionQueue.then(operation, operation);
		actionQueue = next.then(
			() => undefined,
			() => undefined,
		);
		return next;
	}

	function invalidate() {
		localStateCache = { at: 0, value: undefined };
		store.flush();
		try {
			invalidateProvider?.();
		} catch (error) {
			logger?.warn?.(`dsh-unity-agent: provider invalidation failed (${error?.message ?? error})`);
		}
	}

	async function checkoutState({ fresh = false } = {}) {
		const now = Date.now();
		if (!fresh && localStateCache.value !== undefined && now - localStateCache.at < LOCAL_STATE_TTL_MS) {
			return localStateCache.value;
		}
		let value;
		try {
			value = await upstreamManager.localState();
		} catch (error) {
			value = { present: existsSync(upstreamManager.activeDir), usable: false, error: String(error?.message ?? error) };
		}
		localStateCache = { at: now, value };
		return value;
	}

	async function activeRoot() {
		const checkout = await checkoutState();
		if (checkout.present === true && checkout.usable === true) {
			return { root: checkout.dir, source: "upstream", commit: checkout.commit, version: checkout.version };
		}
		return { root: bundledRoot, source: "bundled", commit: bundled.commit, version: bundled.version };
	}

	async function gitInfo() {
		if (gitInfoCache !== undefined) return gitInfoCache;
		try {
			const version = await upstreamManager.gitVersion();
			gitInfoCache = version === undefined ? { available: false } : { available: true, version };
		} catch {
			gitInfoCache = { available: false };
		}
		return gitInfoCache;
	}

	/** Skills of the active root, plus the rejected directories. */
	async function readCatalog() {
		const active = await activeRoot();
		const listing = await listSkills(active.root);
		return { active, ...listing };
	}

	function isEnabled(name) {
		return store.get().enabled[name] !== false;
	}

	/**
	 * The candidates the DSH skill registry may publish. Disabled skills are
	 * simply absent, so they leave both the model catalog and the `/` menu.
	 */
	async function listCandidates() {
		const { skills } = await readCatalog();
		return skills.filter((skill) => isEnabled(skill.name));
	}

	/** Load one enabled skill's full definition. */
	async function readSkill(name) {
		if (!isEnabled(name)) return undefined;
		const active = await activeRoot();
		return await loadSkill(active.root, name);
	}

	/** The complete payload the settings page renders. */
	async function state() {
		const [{ active, skills, broken }, checkout] = await Promise.all([readCatalog(), checkoutState()]);
		const enabledMap = store.get().enabled;
		const upstreamState = store.get().upstream;
		const git = await gitInfo();
		const view = skills.map((skill) => ({
			name: skill.name,
			description: skill.description,
			whenToUse: skill.whenToUse,
			enabled: enabledMap[skill.name] !== false,
			bytes: skill.bytes,
			skillVersion: skill.skillVersion,
			requiredPackages: skill.requiredPackages,
			requiredEditorVersion: skill.requiredEditorVersion,
			invocation: skill.invocation,
		}));
		const enabledCount = view.filter((skill) => skill.enabled).length;
		return {
			plugin: {
				name: "dsh-unity-agent",
				version: packageVersion,
				dataDir,
				activeRoot: active.root,
				source: active.source,
				bundledRoot,
				stateFile: store.file,
			},
			git,
			upstream: {
				url: upstreamManager.url ?? upstreamUrl,
				branch: bundled.branch,
				bundled: { commit: bundled.commit, version: bundled.version, snapshotAt: bundled.snapshotAt, skills: await countBundled() },
				checkout: {
					present: checkout.present === true,
					usable: checkout.usable === true,
					commit: checkout.usable === true ? checkout.commit : undefined,
					version: checkout.usable === true ? checkout.version : undefined,
					skills: active.source === "upstream" ? view.length : 0,
					dir: upstreamManager.activeDir,
				},
				remote: upstreamState.lastCheck
					? {
							reachable: upstreamState.lastCheck.reachable === true,
							sha: upstreamState.lastCheck.sha,
							error: upstreamState.lastCheck.error,
							checkedAt: upstreamState.lastCheck.checkedAt,
						}
					: undefined,
				pending: upstreamState.pending,
				lastUpdateAt: upstreamState.lastUpdateAt,
				lastUpdateCommit: upstreamState.lastUpdateCommit,
				lastError: upstreamState.lastError,
				lastChangelog: upstreamState.lastChangelog,
			},
			skills: view,
			broken,
			stats: {
				total: view.length,
				enabled: enabledCount,
				disabled: view.length - enabledCount,
				broken: broken.length,
			},
		};
	}

	async function countBundled() {
		try {
			const { skills } = await listSkills(bundledRoot);
			return skills.length;
		} catch {
			return 0;
		}
	}

	/**
	 * Ask the remote for its tip and record whether it differs from what is live.
	 * This is the cheap half: no clone, no working tree, no download.
	 */
	async function check() {
		return serialized(async () => {
			const checkedAt = new Date().toISOString();
			const active = await activeRoot();
			const remote = await upstreamManager.checkRemote();
			const lastCheck = {
				reachable: remote.reachable === true,
				sha: remote.sha,
				error: remote.error,
				gitAvailable: remote.gitAvailable !== false,
				checkedAt,
			};
			let pending;
			if (remote.reachable === true && typeof remote.sha === "string") {
				const available = typeof active.commit !== "string" || active.commit !== remote.sha;
				pending = {
					available,
					base: active.commit,
					baseSource: active.source,
					remote: remote.sha,
					checkedAt,
				};
			} else {
				pending = { available: false, base: active.commit, baseSource: active.source, checkedAt, error: remote.error };
			}
			store.patch((draft) => {
				draft.upstream.lastCheck = lastCheck;
				draft.upstream.pending = pending;
				if (remote.reachable !== true) draft.upstream.lastError = remote.error;
				else delete draft.upstream.lastError;
			});
			return { ok: remote.reachable === true, error: remote.error, pending };
		});
	}

	/**
	 * Download the upstream tip and make it live. The changelog is computed from
	 * real content fingerprints of the previous and the new tree, so it lists
	 * exactly which skills appeared, changed or disappeared.
	 */
	async function update() {
		return serialized(async () => {
			const at = new Date().toISOString();
			const active = await activeRoot();
			const before = await snapshotSkills(active.root).catch(() => new Map());
			const result = await upstreamManager.install();
			if (result.ok !== true) {
				store.patch((draft) => {
					draft.upstream.lastError = result.error;
				});
				return { ok: false, error: result.error };
			}
			const after = await snapshotSkills(result.dir).catch(() => new Map());
			const diff = diffSnapshots(before, after);
			const changelog = {
				at,
				from: active.commit,
				fromSource: active.source,
				to: result.commit,
				toVersion: result.version,
				added: diff.added,
				removed: diff.removed,
				changed: diff.changed,
			};
			store.patch((draft) => {
				draft.upstream.lastUpdateAt = at;
				draft.upstream.lastUpdateCommit = result.commit;
				draft.upstream.lastChangelog = changelog;
				draft.upstream.pending = {
					available: false,
					base: result.commit,
					baseSource: "upstream",
					remote: result.commit,
					checkedAt: at,
				};
				delete draft.upstream.lastError;
			});
			invalidate();
			return { ok: true, changelog };
		});
	}

	/** Drop this plugin's checkout and serve the bundled snapshot again. */
	async function reset() {
		return serialized(async () => {
			const active = await activeRoot();
			const before = active.source === "upstream" ? await snapshotSkills(active.root).catch(() => new Map()) : new Map();
			const result = await upstreamManager.discard();
			if (result.ok !== true) return { ok: false, error: result.error };
			const after = await snapshotSkills(bundledRoot).catch(() => new Map());
			const diff = diffSnapshots(before, after);
			const at = new Date().toISOString();
			const changelog = {
				at,
				from: active.commit,
				fromSource: active.source,
				to: bundled.commit,
				toVersion: bundled.version,
				added: diff.added,
				removed: diff.removed,
				changed: diff.changed,
			};
			store.patch((draft) => {
				draft.upstream.lastChangelog = changelog;
				delete draft.upstream.pending;
				delete draft.upstream.lastError;
			});
			invalidate();
			return { ok: true, changelog };
		});
	}

	/**
	 * Enable or disable one skill.
	 *
	 * @param {string} name - skill name present in the active catalog.
	 * @param {boolean} enabled - desired state.
	 * @returns {Promise<{ ok: boolean, error?: string }>} the outcome.
	 */
	async function setEnabled(name, enabled) {
		if (typeof name !== "string" || typeof enabled !== "boolean") {
			return { ok: false, error: "参数不合法" };
		}
		const { skills } = await readCatalog();
		if (!skills.some((skill) => skill.name === name)) return { ok: false, error: `未知技能：${name}` };
		store.patch((draft) => {
			draft.enabled[name] = enabled;
		});
		invalidate();
		return { ok: true };
	}

	/**
	 * Enable or disable many skills at once.
	 *
	 * @param {boolean} enabled - desired state.
	 * @param {string[]} [names] - subset; defaults to every skill of the active catalog.
	 * @returns {Promise<{ ok: boolean, changed: number, error?: string }>} the outcome.
	 */
	async function setAll(enabled, names) {
		if (typeof enabled !== "boolean") return { ok: false, error: "参数不合法", changed: 0 };
		const { skills } = await readCatalog();
		const known = new Set(skills.map((skill) => skill.name));
		const targets = Array.isArray(names) && names.length > 0 ? names.filter((name) => known.has(name)) : [...known];
		store.patch((draft) => {
			for (const name of targets) draft.enabled[name] = enabled;
		});
		invalidate();
		return { ok: true, changed: targets.length };
	}

	return {
		paths: { packageDir, dataDir, bundledRoot, stateFile: store.file },
		bundled,
		store,
		upstream: upstreamManager,
		attachInvalidate(fn) {
			invalidateProvider = fn;
		},
		activeRoot,
		isEnabled,
		listCandidates,
		readSkill,
		readCatalog,
		state,
		check,
		update,
		reset,
		setEnabled,
		setAll,
	};
}
