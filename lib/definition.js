/**
 * The registry contract this plugin publishes.
 *
 * Kept in its own module so `index.js` and `test/provider.test.mjs` describe the
 * same objects: `@deepseek-ai/dsh-skill` validates every candidate strictly
 * (kebab-case name, non-empty description, `provider` equal to the provider's
 * own name, a finite `rank`) and throws out of the whole provider on a
 * violation, which would make every Unity skill disappear from the catalog.
 *
 * @module lib/definition
 */

/** The provider name reported on every candidate; `get` must match it exactly. */
export const PROVIDER_NAME = "unity-agent";

/**
 * Precedence rank. Lower wins. The registry's own scale is: project roots
 * 100-200, runtime 250, custom 300, user-level `~/.dsh/skills` 400, bundled 600.
 * The plugin claims 350 — above the user's own skill directory so an identical
 * name resolves to Unity's copy, below project and custom roots so a project can
 * always override it.
 */
export const PROVIDER_RANK = 350;

/** Provenance string the registry shows for these skills. */
export const SOURCE = "unity-agent-plugin";

/**
 * Map a catalog entry onto a registry candidate.
 *
 * @param {object} entry - an entry from `lib/catalog.js`.
 * @returns {object} the candidate.
 */
export function toCandidate(entry) {
	return {
		name: entry.name,
		description: entry.description,
		...(entry.whenToUse === undefined ? {} : { whenToUse: entry.whenToUse }),
		invocation: entry.invocation,
		source: SOURCE,
		provider: PROVIDER_NAME,
		rank: PROVIDER_RANK,
		locator: { name: entry.name },
		path: entry.file,
	};
}

/**
 * Map a catalog entry onto a loaded skill definition.
 *
 * `resourceBase` points at the skill's own directory, so relative references
 * inside the body (Unity's skills ship `references/`, `scripts/` and
 * `resources/` folders) resolve for the model exactly as they do for the
 * filesystem provider.
 *
 * @param {object} entry - an entry from `lib/catalog.js`.
 * @returns {object} the definition.
 */
export function toDefinition(entry) {
	return {
		name: entry.name,
		description: entry.description,
		...(entry.whenToUse === undefined ? {} : { whenToUse: entry.whenToUse }),
		invocation: entry.invocation,
		source: SOURCE,
		provider: PROVIDER_NAME,
		path: entry.file,
		resourceBase: { kind: "directory", path: entry.directory },
		content: entry.body,
	};
}
