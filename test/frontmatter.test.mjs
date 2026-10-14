/**
 * The frontmatter reader must agree with a real YAML parser.
 *
 * DSH itself parses skill fronts with `yaml` (see `@deepseek-ai/dsh-skill-filesystem`);
 * Unity's repository validates them in CI with `js-yaml`. This plugin ships no
 * parser dependency, so every bundled skill is re-parsed with `js-yaml` here and
 * compared field by field — a divergence fails the build instead of quietly
 * changing which skills reach the model.
 *
 * `js-yaml` is a dev-only dependency: it is not in `dependencies`, and `files`
 * does not ship it.
 *
 * @module test/frontmatter.test
 */

import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import yaml from "js-yaml";

import { group, test, assert } from "./harness.mjs";
import { parseFrontmatter, isSkillName } from "../lib/frontmatter.js";

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const skillsRoot = join(packageRoot, "skills");

group("frontmatter");

/** The exact frontmatter slice Unity's own validator feeds to js-yaml. */
function referenceFrontmatter(text) {
	const match = text.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
	return match === null ? null : match[1];
}

const skillDirs = existsSync(skillsRoot)
	? readdirSync(skillsRoot, { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort()
	: [];

test("the bundled snapshot carries every upstream skill", () => {
	assert.ok(skillDirs.length >= 30, `expected at least 30 bundled skills, found ${skillDirs.length}`);
});

for (const name of skillDirs) {
	test(`parses skills/${name}/SKILL.md exactly like js-yaml`, () => {
		const text = readFileSync(join(skillsRoot, name, "SKILL.md"), "utf8");
		const referenceText = referenceFrontmatter(text);
		assert.notEqual(referenceText, null, "no frontmatter fence");
		const expected = yaml.load(referenceText);
		const parsed = parseFrontmatter(text);
		assert.notEqual(parsed, null, "reader rejected the frontmatter");
		assert.deepEqual(parsed.data, expected);
		assert.equal(parsed.data.name, name);
		assert.ok(typeof parsed.data.description === "string" && parsed.data.description.trim() !== "");
		// The body must be exactly what follows the closing fence.
		const closing = text.replace(/\r\n?/g, "\n").split("\n");
		let close = -1;
		for (let i = 1; i < closing.length; i += 1) {
			if (closing[i] === "---") {
				close = i;
				break;
			}
		}
		assert.equal(parsed.body, closing.slice(close + 1).join("\n"));
	});
}

test("rejects a file without a frontmatter fence", () => {
	assert.equal(parseFrontmatter("# just a heading\n"), null);
	assert.equal(parseFrontmatter("---\nname: x\n"), null);
});

test("block scalar chomping follows the indicator", () => {
	const cases = [
		["fold-strip", "description: >-\n  a\n  b\n", "a b"],
		["fold-clip", "description: >\n  a\n  b\n", "a b\n"],
		["fold-keep", "description: >+\n  a\n\n\n", "a\n\n"],
		["literal-strip", "description: |-\n  a\n  b\n", "a\nb"],
		["literal-clip", "description: |\n  a\n  b\n", "a\nb\n"],
		["fold-paragraph", "description: >-\n  a\n\n  b\n", "a\nb"],
	];
	for (const [label, source, expected] of cases) {
		const parsed = parseFrontmatter(`---\n${source}---\n`);
		assert.notEqual(parsed, null, label);
		assert.equal(parsed.data.description, expected, label);
		assert.equal(parsed.data.description, yaml.load(source.replace(/\n$/, "")).description, `${label} vs js-yaml`);
	}
});

test("reads nested mappings, flow sequences and block sequences", () => {
	const source = [
		"name: demo",
		'description: "quoted: value"',
		"required_packages:",
		'    com.unity.industry.toolkit: ">=4.0.0"',
		"modes: [agent, ask]",
		"allowed-tools:",
		"  - Bash",
		"  - Read",
		"metadata:",
		"  version: 0.3.0",
		"flag: true",
		"empty:",
		"",
	].join("\n");
	const parsed = parseFrontmatter(`---\n${source}---\n`);
	const expected = yaml.load(source);
	assert.deepEqual(parsed.data, expected);
});

test("ignores trailing comments and tolerates lines it cannot classify", () => {
	const source = ["name: demo # trailing", "description: plain", "\t", "not yaml at all", "after: 1"].join("\n");
	const parsed = parseFrontmatter(`---\n${source}\n---\n`);
	assert.notEqual(parsed, null);
	assert.equal(parsed.data.name, "demo");
	assert.equal(parsed.data.after, 1);
	assert.equal(parsed.body, "");
	// Deliberate leniency: Unity's CI guarantees real YAML, so a hand-edited
	// front refused by js-yaml must not make the whole plugin throw.
	assert.throws(() => yaml.load(source));
});

test("unescapes double-quoted scalars like YAML", () => {
	const source = 'description: "line\\nbreak \\"q\\" \\u00e9"';
	const parsed = parseFrontmatter(`---\n${source}\n---\n`);
	assert.equal(parsed.data.description, yaml.load(source).description);
});

test("skill names keep the kebab-case grammar", () => {
	assert.equal(isSkillName("unity-cli"), true);
	assert.equal(isSkillName("2d-pixel-perfect"), true);
	assert.equal(isSkillName("Bad_Name"), false);
	assert.equal(isSkillName("-lead"), false);
});

test("a BOM and a padded fence line do not hide a skill", () => {
	const source = "name: demo\ndescription: plain\n";
	const withBom = parseFrontmatter(`\uFEFF---\n${source}---\n`);
	assert.notEqual(withBom, null, "a leading BOM is not content");
	assert.equal(withBom.data.name, "demo");
	const padded = parseFrontmatter(`---   \n${source}---  \nbody\n`);
	assert.notEqual(padded, null, "trailing spaces on a fence line are not significant");
	assert.equal(padded.data.description, "plain");
	assert.equal(padded.body, "body\n");
});

test("folds a plain scalar's continuation lines like YAML", () => {
	const cases = [
		["one continuation", "description: first\n  second\n"],
		["a paragraph break", "description: first\n\n  second\n"],
		["a two-line fold", "description: first line\n  second line\n  third line\n"],
	];
	for (const [label, source] of cases) {
		const parsed = parseFrontmatter(`---\nname: demo\n${source}---\n`);
		assert.notEqual(parsed, null, label);
		assert.equal(parsed.data.description, yaml.load(`name: demo\n${source}`).description, label);
	}
});

test("reads a flush-left sequence under its key, like YAML", () => {
	const source = ["name: demo", "description: plain", "allowed-tools:", "- Bash", "- Read"].join("\n");
	const parsed = parseFrontmatter(`---\n${source}\n---\n`);
	assert.notEqual(parsed, null);
	assert.deepEqual(parsed.data, yaml.load(source));
	assert.deepEqual(parsed.data["allowed-tools"], ["Bash", "Read"]);
});

test("honours an explicit block indentation indicator", () => {
	const source = "description: |2\n    indented once\n    and again";
	const parsed = parseFrontmatter(`---\nname: demo\n${source}\n---\n`);
	assert.notEqual(parsed, null);
	assert.equal(parsed.data.description, yaml.load(`name: demo\n${source}`).description);
});

test("literal keep-chomping matches YAML for both trailing shapes", () => {
	const cases = ["description: |+\n  a\n", "description: |+\n  a\n\n"];
	for (const source of cases) {
		const parsed = parseFrontmatter(`---\nname: demo\n${source}---\n`);
		assert.notEqual(parsed, null);
		assert.equal(parsed.data.description, yaml.load(`name: demo\n${source.replace(/\n$/, "")}`).description, JSON.stringify(source));
	}
});
