/**
 * The upstream manager: the cheap remote check, the clone-and-swap update, and
 * the guarantee that a failed download never removes what is already live.
 *
 * Two layers are tested. The scripted runner covers the branches that need a
 * network outcome (unreachable, failed clone, malformed payload). A second test
 * drives the real implementation against a real local git repository — no
 * network, but the actual `git clone` / `rev-parse` / directory swap.
 *
 * @module test/upstream.test
 */

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { group, test, assert } from "./harness.mjs";
import { cleanup, makeTempDir, writeManifest, writeSkill } from "./fixtures.mjs";
import { createUpstream } from "../lib/upstream.js";
import { isUsableRoot, listSkills } from "../lib/catalog.js";

group("upstream");

const SHA_A = "a".repeat(40);
const SHA_B = "b".repeat(40);

function runnerFor({ sha = SHA_A, cloneFails = false, lsFails = false, noSkills = false, log = [] }) {
	return async (_git, args, _timeoutMs) => {
		log.push(args.join(" "));
		if (args[0] === "--version") return { code: 0, stdout: "git version 2.34.1.windows.1\n", stderr: "" };
		if (args[0] === "ls-remote") {
			if (lsFails) return { code: 128, stdout: "", stderr: "Could not resolve host: github.com\n" };
			return { code: 0, stdout: `${sha}\trefs/heads/main\n`, stderr: "" };
		}
		if (args[0] === "clone") {
			if (cloneFails) return { code: 128, stdout: "", stderr: "fatal: unable to access the repository\n" };
			const destination = args[args.length - 1];
			mkdirSync(destination, { recursive: true });
			if (!noSkills) {
				writeSkill(destination, "alpha", { description: "from the scripted remote" });
			}
			return { code: 0, stdout: "", stderr: "" };
		}
		if (args.includes("rev-parse")) return { code: 0, stdout: `${sha}\n`, stderr: "" };
		return { code: 1, stdout: "", stderr: `unexpected git ${args.join(" ")}` };
	};
}

test("checkRemote reports the remote tip and how it failed", async () => {
	const dir = makeTempDir("dua-up-");
	const ok = createUpstream({ dataDir: dir, url: "https://example.invalid/u.git", runGit: runnerFor({ sha: SHA_A }) });
	assert.deepEqual(await ok.checkRemote(), { reachable: true, gitAvailable: true, sha: SHA_A });

	const unreachable = createUpstream({ dataDir: dir, url: "https://example.invalid/u.git", runGit: runnerFor({ lsFails: true }) });
	const result = await unreachable.checkRemote();
	assert.equal(result.reachable, false);
	assert.equal(result.gitAvailable, true);
	assert.match(result.error, /Could not resolve host/);
	cleanup();
});

test("install clones into a staging directory and swaps it into place", async () => {
	const dir = makeTempDir("dua-up-");
	const log = [];
	const upstream = createUpstream({ dataDir: dir, url: "https://example.invalid/u.git", runGit: runnerFor({ log }) });
	const result = await upstream.install();
	assert.equal(result.ok, true);
	assert.equal(result.commit, SHA_A);
	assert.equal(result.dir, upstream.activeDir);
	assert.equal(await isUsableRoot(upstream.activeDir), true);
	const listing = await listSkills(upstream.activeDir);
	assert.deepEqual(listing.skills.map((skill) => skill.name), ["alpha"]);
	// Shallow, single-branch, quiet: the update must not pull history it never reads.
	const cloneLine = log.find((line) => line.startsWith("clone"));
	assert.match(cloneLine, /--depth 1/);
	assert.match(cloneLine, /--branch main/);
	assert.equal(log.some((line) => line.includes("upstream.new-")), true);
	assert.equal(await upstream.gitVersion(), "git version 2.34.1.windows.1");
	const local = await upstream.localState();
	assert.equal(local.usable, true);
	assert.equal(local.commit, SHA_A);
	cleanup();
});

test("a failed clone leaves the previous checkout untouched", async () => {
	const dir = makeTempDir("dua-up-");
	const good = createUpstream({ dataDir: dir, runGit: runnerFor({ sha: SHA_A }) });
	assert.equal((await good.install()).ok, true);
	const before = readFileSync(join(good.activeDir, "skills", "alpha", "SKILL.md"), "utf8");

	const broken = createUpstream({ dataDir: dir, runGit: runnerFor({ sha: SHA_B, cloneFails: true }) });
	const failed = await broken.install();
	assert.equal(failed.ok, false);
	assert.match(failed.error, /unable to access/);
	assert.equal(readFileSync(join(good.activeDir, "skills", "alpha", "SKILL.md"), "utf8"), before);
	assert.equal(await isUsableRoot(good.activeDir), true);
	// No staging leftovers from the failed attempt.
	const staging = readdirSync(dir).filter((name) => name.startsWith("upstream."));
	assert.deepEqual(staging, []);
	cleanup();
});

test("an upstream without skills is rejected instead of replacing what works", async () => {
	const dir = makeTempDir("dua-up-");
	const good = createUpstream({ dataDir: dir, runGit: runnerFor({ sha: SHA_A }) });
	assert.equal((await good.install()).ok, true);
	const empty = createUpstream({ dataDir: dir, runGit: runnerFor({ sha: SHA_B, noSkills: true }) });
	const failed = await empty.install();
	assert.equal(failed.ok, false);
	assert.match(failed.error, /skills/);
	assert.equal(await isUsableRoot(good.activeDir), true);
	cleanup();
});

test("a malformed ls-remote answer is an error, not a silent success", async () => {
	const dir = makeTempDir("dua-up-");
	const upstream = createUpstream({
		dataDir: dir,
		runGit: async (_git, args) =>
			args[0] === "ls-remote" ? { code: 0, stdout: "not-a-sha global\n", stderr: "" } : { code: 0, stdout: "", stderr: "" },
	});
	const result = await upstream.checkRemote();
	assert.equal(result.reachable, false);
	assert.match(result.error, /提交号|sha/);
	cleanup();
});

test("discard removes the checkout so the bundled snapshot serves again", async () => {
	const dir = makeTempDir("dua-up-");
	const upstream = createUpstream({ dataDir: dir, runGit: runnerFor({}) });
	assert.equal((await upstream.install()).ok, true);
	assert.equal((await upstream.localState()).present, true);
	await upstream.discard();
	assert.equal(existsSync(upstream.activeDir), false);
	assert.deepEqual(await upstream.localState(), { present: false });
	cleanup();
});

test("an orphaned checkout from an interrupted swap is recovered, not deleted", async () => {
	const dir = makeTempDir("dua-up-");
	// A previous swap moved the live checkout aside and then failed.
	const orphan = join(dir, "upstream.old-1700000000000");
	writeSkill(orphan, "alpha", { description: "survived the failed swap" });
	const upstream = createUpstream({ dataDir: dir, runGit: runnerFor({ cloneFails: true }) });
	const failed = await upstream.install();
	assert.equal(failed.ok, false);
	// Even though the clone failed, the plugin is not left without a root.
	assert.equal(existsSync(orphan), false);
	assert.equal(await isUsableRoot(upstream.activeDir), true);
	assert.equal((await upstream.localState()).usable, true);
	cleanup();
});

test("a fresh staging directory may belong to another process and is left alone", async () => {
	const dir = makeTempDir("dua-up-");
	const concurrent = join(dir, "upstream.new-other-process");
	writeSkill(concurrent, "alpha", { description: "another Host's clone" });
	const upstream = createUpstream({ dataDir: dir, runGit: runnerFor({ sha: SHA_A }) });
	assert.equal((await upstream.install()).ok, true);
	assert.equal(existsSync(concurrent), true);

	// A stale one has no owner left and is reclaimed.
	const stale = join(dir, "upstream.new-1700000000000");
	writeSkill(stale, "beta", { description: "abandoned" });
	const longAgo = new Date(Date.now() - 6 * 60 * 60 * 1000);
	utimesSync(stale, longAgo, longAgo);
	await upstream.install();
	assert.equal(existsSync(stale), false);
	cleanup();
});

test("a deliberate discard does not resurrect an older checkout", async () => {
	const dir = makeTempDir("dua-up-");
	const orphan = join(dir, "upstream.old-1700000000000");
	writeSkill(orphan, "alpha", { description: "older copy" });
	const upstream = createUpstream({ dataDir: dir, runGit: runnerFor({}) });
	await upstream.discard();
	assert.equal(existsSync(upstream.activeDir), false);
	assert.equal(existsSync(orphan), false);
	cleanup();
});

/** Is a usable `git` on PATH? The integration test needs one. */
function gitAvailable() {
	try {
		execFileSync("git", ["--version"], { stdio: "ignore" });
		return true;
	} catch {
		return false;
	}
}

test("real git: check, update and re-check against a local origin", async () => {
	if (!gitAvailable()) {
		console.log("       (skipped: no git on PATH)");
		return;
	}
	const workspace = makeTempDir("dua-git-");
	const origin = join(workspace, "origin");
	const dataDir = join(workspace, "data");
	mkdirSync(origin, { recursive: true });
	writeSkill(origin, "one", { description: "first" });
	writeManifest(origin, { version: "0.0.1" });

	const git = (args, cwd) =>
		execFileSync("git", ["-c", "user.name=test", "-c", "user.email=test@example.invalid", ...args], {
			cwd,
			stdio: ["ignore", "pipe", "pipe"],
		})
			.toString()
			.trim();

	git(["init", "-b", "main"], origin);
	git(["add", "."], origin);
	git(["commit", "-m", "first"], origin);
	const firstCommit = git(["rev-parse", "HEAD"], origin);

	const upstream = createUpstream({ dataDir, url: origin });
	const remote = await upstream.checkRemote();
	assert.equal(remote.reachable, true);
	assert.equal(remote.sha, firstCommit);
	assert.match(await upstream.gitVersion(), /^git version/);

	const installed = await upstream.install();
	assert.equal(installed.ok, true);
	assert.equal(installed.commit, firstCommit);
	assert.equal(installed.version, "0.0.1");
	assert.deepEqual((await listSkills(upstream.activeDir)).skills.map((skill) => skill.name), ["one"]);

	// Upstream publishes a new skill plus an edit to the existing one.
	writeSkill(origin, "two", { description: "second" });
	writeFileSync(join(origin, "skills", "one", "SKILL.md"), "---\nname: one\ndescription: first but better\n---\n\nbody\n", "utf8");
	git(["add", "."], origin);
	git(["commit", "-m", "second"], origin);
	const secondCommit = git(["rev-parse", "HEAD"], origin);
	assert.notEqual(secondCommit, firstCommit);

	const recheck = await upstream.checkRemote();
	assert.equal(recheck.sha, secondCommit);
	const updated = await upstream.install();
	assert.equal(updated.ok, true);
	assert.equal(updated.commit, secondCommit);
	const names = (await listSkills(upstream.activeDir)).skills.map((skill) => skill.name);
	assert.deepEqual(names, ["one", "two"]);
	const local = await upstream.localState();
	assert.equal(local.commit, secondCommit);
	assert.equal(local.version, "0.0.1");
	cleanup();
});
