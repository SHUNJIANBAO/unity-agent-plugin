/**
 * Shared test fixtures: temporary directories, synthetic skill roots, and a
 * scripted upstream manager.
 *
 * @module test/fixtures
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const created = [];

/** A temporary directory removed by `cleanup()`. */
export function makeTempDir(prefix = "dua-test-") {
	const dir = mkdtempSync(join(tmpdir(), prefix));
	created.push(dir);
	return dir;
}

/** Remove every temporary directory this test file created. */
export function cleanup() {
	while (created.length > 0) {
		const dir = created.pop();
		try {
			rmSync(dir, { recursive: true, force: true });
		} catch {
			/* best effort */
		}
	}
}

/**
 * Write `skills/<name>/SKILL.md` under a repository root.
 *
 * @param {string} root - repository root.
 * @param {string} name - skill (and directory) name.
 * @param {object} [options] - skill options.
 * @param {string} [options.description] - frontmatter description.
 * @param {string} [options.extraFrontmatter] - extra frontmatter lines.
 * @param {string} [options.body] - markdown body.
 * @param {string} [options.reference] - also write `references/<name>.md`.
 * @returns {string} the skill directory.
 */
export function writeSkill(root, name, { description = `Demo skill ${name}`, extraFrontmatter = "", body, reference } = {}) {
	const directory = join(root, "skills", name);
	mkdirSync(directory, { recursive: true });
	writeFileSync(
		join(directory, "SKILL.md"),
		`---\nname: ${name}\ndescription: ${description}\n${extraFrontmatter}---\n\n${body ?? `# ${name}\n\nBody of ${name}.\n`}`,
		"utf8",
	);
	if (reference !== undefined) {
		mkdirSync(join(directory, "references"), { recursive: true });
		writeFileSync(join(directory, "references", reference), `# ${reference}\n`, "utf8");
	}
	return directory;
}

/** Write a repository root's agent-plugin manifest. */
export function writeManifest(root, { name = "unity", version = "0.1.0" } = {}) {
	const directory = join(root, ".claude-plugin");
	mkdirSync(directory, { recursive: true });
	writeFileSync(join(directory, "plugin.json"), `${JSON.stringify({ name, version }, null, 2)}\n`, "utf8");
}

/** Write a package root's bundled-snapshot provenance stamp. */
export function writeProvenance(packageDir, { commit = "b".repeat(40), version = "0.1.0" } = {}) {
	writeFileSync(
		join(packageDir, "upstream.json"),
		`${JSON.stringify({ repo: "https://example.invalid/unity.git", branch: "main", commit, version }, null, 2)}\n`,
		"utf8",
	);
}

/**
 * A drop-in replacement for `lib/upstream.js` that never touches the network.
 *
 * @param {object} options - scripted behavior.
 * @param {string} options.dataDir - the plugin data dir the manager owns.
 * @param {string} [options.url] - reported repository URL.
 * @param {string} [options.sha] - the remote tip.
 * @param {string[]} [options.skills] - skills the next `install()` writes.
 * @param {string} [options.version] - version the next `install()` reports.
 * @param {boolean} [options.cloneFails] - make `install()` fail.
 * @param {boolean} [options.remoteFails] - make `checkRemote()` fail.
 * @returns {object} the scripted manager.
 */
export function scriptedUpstream({
	dataDir,
	url = "https://example.invalid/unity.git",
	sha = "a".repeat(40),
	skills = ["alpha"],
	version = "9.9.9",
	cloneFails = false,
	remoteFails = false,
}) {
	const activeDir = join(dataDir, "upstream");
	let present = false;
	let currentSha = sha;
	let nextSkills = [...skills];
	let nextVersion = version;
	let failingClone = cloneFails;
	let failingRemote = remoteFails;
	const calls = [];

	function materialize() {
		rmSync(activeDir, { recursive: true, force: true });
		mkdirSync(activeDir, { recursive: true });
		for (const name of nextSkills) writeSkill(activeDir, name, { description: `Scripted ${name}` });
		writeManifest(activeDir, { version: nextVersion });
		present = true;
	}

	return {
		url,
		activeDir,
		calls,
		get sha() {
			return currentSha;
		},
		setSha(next) {
			currentSha = next;
		},
		setSkills(next, nextVersionOverride) {
			nextSkills = [...next];
			if (nextVersionOverride !== undefined) nextVersion = nextVersionOverride;
		},
		setCloneFails(next) {
			failingClone = next;
		},
		async gitVersion() {
			return "git version 2.34.1.windows.1";
		},
		async checkRemote() {
			calls.push("checkRemote");
			if (failingRemote) return { reachable: false, gitAvailable: true, error: "scripted network failure" };
			return { reachable: true, gitAvailable: true, sha: currentSha };
		},
		async install() {
			calls.push("install");
			if (failingClone) return { ok: false, error: "scripted clone failure" };
			materialize();
			return { ok: true, dir: activeDir, commit: currentSha, version: nextVersion };
		},
		async discard() {
			calls.push("discard");
			rmSync(activeDir, { recursive: true, force: true });
			present = false;
			return { ok: true };
		},
		async localState() {
			if (!present) return { present: false };
			return { present: true, usable: true, dir: activeDir, commit: currentSha, version: nextVersion };
		},
	};
}

/**
 * Build a throwaway package root (the "bundled snapshot" side of the plugin).
 *
 * @param {object} [options] - root options.
 * @param {string[]} [options.skills] - skill names to write.
 * @param {string} [options.commit] - bundled commit.
 * @param {string} [options.version] - bundled version.
 * @returns {{ packageDir: string, dataDir: string }} the two directories.
 */
export function makePackageRoot({ skills = ["alpha", "beta"], commit = "b".repeat(40), version = "0.1.0" } = {}) {
	const packageDir = makeTempDir("dua-pkg-");
	const dataDir = makeTempDir("dua-data-");
	for (const name of skills) writeSkill(packageDir, name, { description: `Bundled ${name}` });
	writeProvenance(packageDir, { commit, version });
	return { packageDir, dataDir };
}
