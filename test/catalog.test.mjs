/**
 * Catalog discovery: the bundled snapshot parses, malformed skills are reported
 * rather than dropped silently, and fingerprints drive the update changelog.
 *
 * @module test/catalog.test
 */

import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { mkdirSync, writeFileSync } from "node:fs";

import { group, test, assert } from "./harness.mjs";
import { cleanup, makeTempDir, writeManifest, writeSkill } from "./fixtures.mjs";
import {
	diffSnapshots,
	invocationPolicyOf,
	isUsableRoot,
	listSkills,
	loadSkill,
	readPluginManifest,
	snapshotSkills,
} from "../lib/catalog.js";

group("catalog");

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

test("the bundled snapshot lists every Unity skill with a usable shape", async () => {
	const { skills, broken } = await listSkills(packageRoot);
	assert.ok(skills.length >= 30, `expected at least 30 skills, found ${skills.length}`);
	assert.deepEqual(broken, []);
	const names = skills.map((skill) => skill.name).sort();
	assert.deepEqual(names, [...new Set(names)], "names are unique");
	for (const skill of skills) {
		assert.match(skill.name, /^[a-z0-9]+(?:-[a-z0-9]+)*$/);
		assert.ok(skill.description.length > 0, `${skill.name} has a description`);
		assert.equal(skill.invocation.modelInvocable, true);
		assert.equal(skill.invocation.userInvocable, true);
		assert.ok(skill.bytes > 0);
	}
	assert.ok(names.includes("unity-cli"));
	assert.ok(names.includes("2d-pixel-perfect"));
	// Unity's own extra frontmatter survives for the settings page to show.
	const vivox = skills.find((skill) => skill.name === "setup-vivox-voice-chat");
	assert.deepEqual(vivox.requiredPackages, { "com.unity.services.vivox": ">=16.4.0" });
	cleanup();
});

test("a loaded skill carries the body and a directory resource base", async () => {
	const entry = await loadSkill(packageRoot, "2d-pixel-perfect");
	assert.equal(entry.name, "2d-pixel-perfect");
	assert.ok(entry.description.startsWith("Sets up, diagnoses"));
	assert.equal(entry.body.startsWith("---"), false);
	assert.ok(entry.body.length > 1000);
	assert.ok(entry.directory.endsWith(join("skills", "2d-pixel-perfect")));
	assert.ok(entry.file.endsWith(join("skills", "2d-pixel-perfect", "SKILL.md")));
	assert.ok(isUsableRoot(packageRoot));
	cleanup();
});

test("malformed skills are reported, not silently dropped", async () => {
	const root = makeTempDir("dua-bad-");
	writeSkill(root, "good-one", { description: "fine" });
	// Missing description.
	mkdirSync(join(root, "skills", "no-description"), { recursive: true });
	writeFileSync(join(root, "skills", "no-description", "SKILL.md"), "---\nname: no-description\n---\n\nbody\n", "utf8");
	// Name that disagrees with the directory.
	writeSkill(root, "mismatch", { description: "x", extraFrontmatter: "" });
	writeFileSync(join(root, "skills", "mismatch", "SKILL.md"), "---\nname: other\ndescription: x\n---\n\nbody\n", "utf8");
	// No frontmatter at all.
	mkdirSync(join(root, "skills", "no-frontmatter"), { recursive: true });
	writeFileSync(join(root, "skills", "no-frontmatter", "SKILL.md"), "# plain markdown\n", "utf8");
	// Invalid directory name for the registry grammar.
	writeSkill(root, "Bad_Name", { description: "x" });
	// A directory without a skill file is ignored, not reported.
	mkdirSync(join(root, "skills", "empty-dir"), { recursive: true });

	const { skills, broken } = await listSkills(root);
	assert.deepEqual(skills.map((skill) => skill.name), ["good-one"]);
	assert.deepEqual(broken.map((item) => item.name).sort(), ["Bad_Name", "mismatch", "no-description", "no-frontmatter"]);
	for (const item of broken) assert.ok(item.reason.length > 0);
	cleanup();
});

test("invocation policy honours DSH's frontmatter keys", () => {
	assert.deepEqual(invocationPolicyOf({}), { modelInvocable: true, userInvocable: true });
	assert.deepEqual(invocationPolicyOf({ "disable-model-invocation": true }), { modelInvocable: false, userInvocable: true });
	assert.deepEqual(invocationPolicyOf({ "user-invocable": false }), { modelInvocable: true, userInvocable: false });
	assert.deepEqual(invocationPolicyOf({ "disable-model-invocation": true, "user-invocable": false }), {
		modelInvocable: false,
		userInvocable: false,
	});
});

test("fingerprints report added, changed and removed skills", async () => {
	const root = makeTempDir("dua-snap-");
	writeSkill(root, "one", { description: "one" });
	writeSkill(root, "two", { description: "two" });
	const before = await snapshotSkills(root);

	writeSkill(root, "three", { description: "three" });
	writeFileSync(join(root, "skills", "two", "SKILL.md"), "---\nname: two\ndescription: two changed\n---\n\nbody\n", "utf8");
	writeSkill(root, "two", { description: "two changed" });
	const after = await snapshotSkills(root);

	assert.deepEqual([...before.keys()].sort(), ["one", "two"]);
	assert.deepEqual([...after.keys()].sort(), ["one", "three", "two"]);
	assert.deepEqual(diffSnapshots(before, after), { added: ["three"], removed: [], changed: ["two"] });

	writeFileSync(join(root, "skills", "one", "SKILL.md"), "---\nname: one\ndescription: one\n---\n\nbody\n", "utf8");
	const third = await snapshotSkills(root);
	assert.deepEqual(diffSnapshots(after, third), { added: [], removed: [], changed: ["one"] });
	cleanup();
});

test("a missing root is empty, never an exception", async () => {
	const missing = join(makeTempDir("dua-missing-"), "nope");
	assert.deepEqual(await listSkills(missing), { skills: [], broken: [] });
	assert.equal(await isUsableRoot(missing), false);
	assert.equal(await loadSkill(missing, "unity-cli"), undefined);
	assert.equal(await loadSkill(packageRoot, "Not_Kebab"), undefined);
	cleanup();
});

test("a repository manifest is read for its version", async () => {
	const root = makeTempDir("dua-manifest-");
	writeManifest(root, { version: "0.1.8-beta" });
	assert.deepEqual(await readPluginManifest(root), { name: "unity", version: "0.1.8-beta" });
	assert.equal(await readPluginManifest(makeTempDir("dua-nomanifest-")), undefined);
	cleanup();
});
