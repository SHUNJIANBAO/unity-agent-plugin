/**
 * Reads Unity's skill tree into DSH skill candidates.
 *
 * A "root" is a directory laid out like the upstream repository: `skills/<name>/SKILL.md`
 * plus the per-skill resources those files reference. Two roots exist at
 * runtime — the clone the updater maintains and the snapshot bundled in this
 * package — and both are read by the same code.
 *
 * Listing reads only the head of each file (frontmatter is small), so the
 * catalog stays cheap on every lookup; loading a skill reads the whole file.
 *
 * @module lib/catalog
 */

import { createHash } from "node:crypto";
import { open, readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";

import { isSkillName, parseFrontmatter } from "./frontmatter.js";

/** Bytes read for a listing; a frontmatter block is far smaller than this. */
const HEAD_BYTES = 16 * 1024;

/** Where a repository keeps its skills. */
export const SKILLS_DIRNAME = "skills";

/** The two frontmatter spellings DSH honours for invocation policy. */
const DISABLE_MODEL_KEY = "disable-model-invocation";
const USER_INVOCABLE_KEY = "user-invocable";

function booleanField(data, key) {
	if (!Object.hasOwn(data, key)) return undefined;
	const value = data[key];
	if (typeof value === "boolean") return value;
	if (value === 1 || value === "1") return true;
	if (value === 0 || value === "0") return false;
	if (typeof value === "string") {
		const lowered = value.toLowerCase();
		if (["true", "yes", "on"].includes(lowered)) return true;
		if (["false", "no", "off"].includes(lowered)) return false;
	}
	return undefined;
}

function stringField(data, key) {
	const value = data[key];
	return typeof value === "string" ? value : undefined;
}

/** Map the frontmatter's invocation keys onto the registry's policy shape. */
export function invocationPolicyOf(data) {
	const disableModel = booleanField(data, DISABLE_MODEL_KEY);
	const userInvocable = booleanField(data, USER_INVOCABLE_KEY);
	return {
		modelInvocable: disableModel !== true,
		userInvocable: userInvocable !== false,
	};
}

/**
 * Parse one skill file's text into a catalog entry.
 *
 * @param {object} input - parsed inputs.
 * @param {string} input.name - the directory name, which the frontmatter must repeat.
 * @param {string} input.directory - absolute skill directory.
 * @param {string} input.file - absolute path of the skill file.
 * @param {string} input.text - the file's text.
 * @returns {{ entry?: object, broken?: string }} the entry, or why it is unusable.
 */
export function parseSkillFile({ name, directory, file, text }) {
	const parsed = parseFrontmatter(text);
	if (parsed === null) return { broken: "没有 YAML frontmatter（缺少 --- 区块）" };
	const declared = stringField(parsed.data, "name");
	const description = stringField(parsed.data, "description");
	if (declared === undefined || declared.trim() === "") return { broken: "frontmatter 缺少 name" };
	if (!isSkillName(declared)) return { broken: `frontmatter 的 name 不是 kebab-case：${declared}` };
	if (description === undefined || description.trim() === "") return { broken: "frontmatter 缺少 description" };
	if (declared !== name) return { broken: `frontmatter 的 name「${declared}」与目录名「${name}」不一致` };
	const metadata = parsed.data.metadata;
	const requiredPackages = parsed.data.required_packages;
	return {
		entry: {
			name,
			directory,
			file,
			description: description.trim(),
			whenToUse: stringField(parsed.data, "whenToUse"),
			invocation: invocationPolicyOf(parsed.data),
			body: parsed.body.trim(),
			bytes: Buffer.byteLength(text, "utf8"),
			requiredPackages:
				requiredPackages !== null && typeof requiredPackages === "object" && !Array.isArray(requiredPackages)
					? requiredPackages
					: undefined,
			requiredEditorVersion: stringField(parsed.data, "required_editor_version"),
			skillVersion:
				metadata !== null && typeof metadata === "object" && !Array.isArray(metadata)
					? stringField(metadata, "version")
					: undefined,
		},
	};
}

async function readHead(file) {
	const handle = await open(file, "r");
	try {
		const buffer = Buffer.alloc(HEAD_BYTES);
		const { bytesRead } = await handle.read(buffer, 0, HEAD_BYTES, 0);
		return buffer.subarray(0, bytesRead).toString("utf8");
	} finally {
		await handle.close();
	}
}

/** Read the whole file when the head did not contain a closing fence. */
async function readHeadOrWhole(file) {
	const head = await readHead(file);
	if (head.includes("\n---")) return head;
	try {
		return await readFile(file, "utf8");
	} catch {
		return head;
	}
}

/**
 * Read the skills of one repository root.
 *
 * @param {string} root - directory containing `skills/`.
 * @returns {Promise<{ skills: object[], broken: { name: string, reason: string }[] }>}
 *   usable entries sorted by name, and the directories that were rejected.
 */
export async function listSkills(root) {
	const skillsRoot = join(root, SKILLS_DIRNAME);
	let dirents;
	try {
		dirents = await readdir(skillsRoot, { withFileTypes: true });
	} catch (error) {
		if (error?.code === "ENOENT") return { skills: [], broken: [] };
		throw error;
	}
	const skills = [];
	const broken = [];
	for (const dirent of dirents.sort((left, right) => left.name.localeCompare(right.name))) {
		if (!dirent.isDirectory()) continue;
		const directory = join(skillsRoot, dirent.name);
		const file = join(directory, "SKILL.md");
		let text;
		try {
			text = await readHeadOrWhole(file);
		} catch (error) {
			if (error?.code === "ENOENT") continue;
			broken.push({ name: dirent.name, reason: `读取失败：${error?.message ?? error}` });
			continue;
		}
		if (!isSkillName(dirent.name)) {
			broken.push({ name: dirent.name, reason: "目录名不是 kebab-case，DSH 无法注册" });
			continue;
		}
		const result = parseSkillFile({ name: dirent.name, directory, file, text });
		if (result.entry !== undefined) skills.push(result.entry);
		else broken.push({ name: dirent.name, reason: result.broken });
	}
	return { skills, broken };
}

/**
 * Load one skill's full text from a root.
 *
 * @param {string} root - directory containing `skills/`.
 * @param {string} name - the skill name.
 * @returns {Promise<object | undefined>} the entry, or undefined when absent/invalid.
 */
export async function loadSkill(root, name) {
	if (!isSkillName(name)) return undefined;
	const directory = join(root, SKILLS_DIRNAME, name);
	const file = join(directory, "SKILL.md");
	let text;
	try {
		text = await readFile(file, "utf8");
	} catch {
		return undefined;
	}
	return parseSkillFile({ name, directory, file, text }).entry;
}

/** Hash one skill directory's whole content, so an update can report what changed. */
async function digestSkillDirectory(directory) {
	const hash = createHash("sha256");
	const walk = async (current, prefix) => {
		const dirents = await readdir(current, { withFileTypes: true });
		for (const dirent of dirents.sort((left, right) => left.name.localeCompare(right.name))) {
			const full = join(current, dirent.name);
			const relative = prefix === "" ? dirent.name : `${prefix}/${dirent.name}`;
			if (dirent.isDirectory()) {
				await walk(full, relative);
				continue;
			}
			if (!dirent.isFile()) continue;
			hash.update(relative);
			hash.update("\0");
			hash.update(await readFile(full));
			hash.update("\0");
		}
	};
	await walk(directory, "");
	return hash.digest("hex");
}

/**
 * Fingerprint every skill of a root for change reporting.
 *
 * @param {string} root - directory containing `skills/`.
 * @returns {Promise<Map<string, { digest: string, bytes: number }>>} name → fingerprint.
 */
export async function snapshotSkills(root) {
	const { skills } = await listSkills(root);
	const out = new Map();
	for (const skill of skills) {
		try {
			out.set(skill.name, { digest: await digestSkillDirectory(skill.directory), bytes: skill.bytes });
		} catch {
			out.set(skill.name, { digest: `unreadable:${skill.bytes}`, bytes: skill.bytes });
		}
	}
	return out;
}

/**
 * Compare two skill fingerprints.
 *
 * @param {Map<string, { digest: string }>} before - the older snapshot.
 * @param {Map<string, { digest: string }>} after - the newer snapshot.
 * @returns {{ added: string[], removed: string[], changed: string[] }} sorted names per class.
 */
export function diffSnapshots(before, after) {
	const added = [];
	const removed = [];
	const changed = [];
	for (const [name, value] of after) {
		const previous = before.get(name);
		if (previous === undefined) added.push(name);
		else if (previous.digest !== value.digest) changed.push(name);
	}
	for (const name of before.keys()) {
		if (!after.has(name)) removed.push(name);
	}
	return { added: added.sort(), removed: removed.sort(), changed: changed.sort() };
}

/**
 * Read a repository's agent-plugin manifest, which is where Unity states the
 * plugin version. Absent or malformed manifests are reported as `undefined`
 * rather than failing discovery.
 *
 * @param {string} root - repository root.
 * @param {string} [relative] - manifest path inside the root.
 * @returns {Promise<{ name?: string, version?: string } | undefined>} manifest fields.
 */
export async function readPluginManifest(root, relative = ".claude-plugin/plugin.json") {
	try {
		const parsed = JSON.parse(await readFile(join(root, relative), "utf8"));
		return {
			name: typeof parsed?.name === "string" ? parsed.name : undefined,
			version: typeof parsed?.version === "string" ? parsed.version : undefined,
		};
	} catch {
		return undefined;
	}
}

/**
 * Does this directory look like a usable checkout of the upstream repository?
 *
 * @param {string} root - candidate root.
 * @returns {Promise<boolean>} whether it holds at least one readable skill.
 */
export async function isUsableRoot(root) {
	try {
		const info = await stat(join(root, SKILLS_DIRNAME));
		if (!info.isDirectory()) return false;
	} catch {
		return false;
	}
	const { skills } = await listSkills(root);
	return skills.length > 0;
}
