/**
 * The upstream repository, kept as a real `git` checkout.
 *
 * Unity publishes skills by pushing to `Unity-Technologies/unity-agent-plugin`.
 * This module talks to that repository with the `git` binary the machine
 * already has (the desktop app's own tooling and every developer machine ship
 * one) instead of an HTTPS client inside the Host process, because the
 * environment's TLS interception is only configured for the system tools.
 *
 * Updating is a fresh shallow clone into a staging directory followed by an
 * atomic swap, never a pull into the live checkout: the tree the model reads is
 * either the previous complete clone or the new complete clone, and a failed or
 * interrupted download leaves the previous one untouched.
 *
 * @module lib/upstream
 */

import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readdir, rename, rm } from "node:fs/promises";
import { join } from "node:path";

import { isUsableRoot, readPluginManifest } from "./catalog.js";

/** The Unity repository this plugin mirrors. */
export const DEFAULT_UPSTREAM_URL = "https://github.com/Unity-Technologies/unity-agent-plugin.git";

/** Branch of the upstream repository. */
export const UPSTREAM_BRANCH = "main";

const LS_REMOTE_TIMEOUT_MS = 60_000;
const CLONE_TIMEOUT_MS = 300_000;
const MAX_ERROR_CHARS = 400;

/** Candidate git locations for a Host process whose PATH may be minimal. */
const GIT_FALLBACKS = [
	"C:\\Program Files\\Git\\cmd\\git.exe",
	"C:\\Program Files (x86)\\Git\\cmd\\git.exe",
	"/usr/bin/git",
	"/usr/local/bin/git",
	"/opt/homebrew/bin/git",
];

function oneLine(text) {
	const collapsed = String(text ?? "").replace(/\s+/g, " ").trim();
	return collapsed.length > MAX_ERROR_CHARS ? `${collapsed.slice(0, MAX_ERROR_CHARS)}…` : collapsed;
}

/**
 * Run one git command for real.
 *
 * @param {string} git - executable to use.
 * @param {string[]} args - arguments.
 * @param {number} timeoutMs - kill deadline.
 * @returns {Promise<{ code: number, stdout: string, stderr: string }>} the outcome.
 */
function runRealGit(git, args, timeoutMs) {
	return new Promise((resolve) => {
		execFile(
			git,
			args,
			{
				timeout: timeoutMs,
				windowsHide: true,
				maxBuffer: 8 * 1024 * 1024,
				env: {
					...process.env,
					// Never let git block on an interactive credential prompt: this
					// runs in the Host process, where a hung request looks like a
					// frozen settings page.
					GIT_TERMINAL_PROMPT: "0",
					GIT_ASKPASS: "echo",
					GCM_INTERACTIVE: "never",
				},
			},
			(error, stdout, stderr) => {
				resolve({
					code: error === null || error === undefined ? 0 : typeof error.code === "number" ? error.code : 1,
					stdout: String(stdout ?? ""),
					stderr: String(stderr ?? "") || (error ? String(error.message ?? "") : ""),
				});
			},
		);
	});
}

/**
 * Create the upstream manager.
 *
 * @param {object} options - manager options.
 * @param {string} options.dataDir - plugin data directory (`$DSH_HOME/unity-agent-plugin`).
 * @param {string} [options.url] - repository URL; defaults to Unity's.
 * @param {{ warn?: (message: string) => void, info?: (message: string) => void }} [options.logger] - logger.
 * @param {string} [options.gitPath] - git executable to use instead of probing.
 * @param {(git: string, args: string[], timeoutMs: number) => Promise<{ code: number, stdout: string, stderr: string }>} [options.runGit]
 *   command runner; the default shells out to `git`. Tests replace it to script
 *   network outcomes deterministically.
 * @returns {object} the upstream manager.
 */
export function createUpstream({ dataDir, url = DEFAULT_UPSTREAM_URL, logger, gitPath: forcedGitPath, runGit }) {
	const activeDir = join(dataDir, "upstream");
	const runner = runGit ?? runRealGit;
	let gitPath = forcedGitPath ?? "git";
	let queue = Promise.resolve();

	/** Serialize mutating operations so two clicks cannot clone at once. */
	function locked(operation) {
		const run = queue.then(operation, operation);
		queue = run.then(
			() => undefined,
			() => undefined,
		);
		return run;
	}

	async function resolveGit() {
		if (runGit !== undefined) return gitPath;
		const probe = await runner(gitPath, ["--version"], 20_000);
		if (probe.code === 0) return gitPath;
		for (const candidate of GIT_FALLBACKS) {
			if (!existsSync(candidate)) continue;
			const fallback = await runner(candidate, ["--version"], 20_000);
			if (fallback.code === 0) {
				gitPath = candidate;
				return gitPath;
			}
		}
		return null;
	}

	async function gitVersion() {
		const git = await resolveGit();
		if (git === null) return undefined;
		const probe = await runner(git, ["--version"], 20_000);
		return probe.code === 0 ? oneLine(probe.stdout) : undefined;
	}

	async function commitOf(directory) {
		const git = await resolveGit();
		if (git === null) return undefined;
		const result = await runner(git, ["-C", directory, "rev-parse", "HEAD"], 20_000);
		if (result.code !== 0) return undefined;
		const sha = oneLine(result.stdout);
		return /^[0-9a-f]{7,40}$/.test(sha) ? sha : undefined;
	}

	/**
	 * Ask the remote for its current tip. This is the cheap half of the update
	 * flow: it needs no clone and no working tree.
	 *
	 * @returns {Promise<{ reachable: boolean, sha?: string, error?: string, gitAvailable: boolean }>} remote state.
	 */
	async function checkRemote() {
		const git = await resolveGit();
		if (git === null) return { reachable: false, gitAvailable: false, error: "本机未找到 git 可执行文件" };
		const result = await runner(git, ["ls-remote", "--heads", url, `refs/heads/${UPSTREAM_BRANCH}`], LS_REMOTE_TIMEOUT_MS);
		if (result.code !== 0) {
			return { reachable: false, gitAvailable: true, error: oneLine(result.stderr) || `git ls-remote 退出码 ${result.code}` };
		}
		const line = result.stdout
			.split("\n")
			.map((entry) => entry.trim())
			.find((entry) => entry !== "");
		const sha = line === undefined ? undefined : line.split(/\s+/)[0];
		if (sha === undefined || !/^[0-9a-f]{7,40}$/.test(sha)) {
			return { reachable: false, gitAvailable: true, error: "远端没有返回 main 分支的提交号" };
		}
		return { reachable: true, gitAvailable: true, sha };
	}

	/** Remove leftover staging directories from an interrupted update. */
	async function cleanStaging() {
		let dirents = [];
		try {
			dirents = await readdir(dataDir, { withFileTypes: true });
		} catch {
			return;
		}
		for (const dirent of dirents) {
			if (!dirent.isDirectory()) continue;
			if (!dirent.name.startsWith("upstream.")) continue;
			try {
				await rm(join(dataDir, dirent.name), { recursive: true, force: true });
			} catch {
				/* best effort: a locked leftover must not fail the update */
			}
		}
	}

	/**
	 * Clone the upstream tip and swap it into place.
	 *
	 * @returns {Promise<{ ok: boolean, dir?: string, commit?: string, version?: string, error?: string }>} the outcome.
	 */
	async function install() {
		return locked(async () => {
			const git = await resolveGit();
			if (git === null) return { ok: false, error: "本机未找到 git 可执行文件，无法从上游拉取内容" };
			await mkdir(dataDir, { recursive: true });
			await cleanStaging();
			const staging = join(dataDir, `upstream.new-${Date.now()}`);
			logger?.info?.(`dsh-unity-agent: cloning ${url} into ${staging}`);
			const clone = await runner(
				git,
				["clone", "--depth", "1", "--single-branch", "--branch", UPSTREAM_BRANCH, "--quiet", url, staging],
				CLONE_TIMEOUT_MS,
			);
			if (clone.code !== 0) {
				await rm(staging, { recursive: true, force: true }).catch(() => {});
				return { ok: false, error: oneLine(clone.stderr) || `git clone 退出码 ${clone.code}` };
			}
			if (!(await isUsableRoot(staging))) {
				await rm(staging, { recursive: true, force: true }).catch(() => {});
				return { ok: false, error: "上游仓库里没有可用的 skills/ 目录，已放弃切换" };
			}
			const commit = await commitOf(staging);
			const manifest = await readPluginManifest(staging);
			const previous = `${activeDir}.old-${Date.now()}`;
			let moved = false;
			try {
				if (existsSync(activeDir)) {
					await rename(activeDir, previous);
					moved = true;
				}
				await rename(staging, activeDir);
			} catch (error) {
				// Put the previous checkout back so the plugin never ends up with no
				// usable root because of a rename failure.
				if (moved) await rename(previous, activeDir).catch(() => {});
				await rm(staging, { recursive: true, force: true }).catch(() => {});
				return { ok: false, error: `切换目录失败：${oneLine(error?.message ?? error)}` };
			}
			await rm(previous, { recursive: true, force: true }).catch(() => {});
			logger?.info?.(`dsh-unity-agent: upstream is now ${commit ?? "unknown"}`);
			return { ok: true, dir: activeDir, commit, version: manifest?.version };
		});
	}

	/** Delete this plugin's checkout, falling back to the bundled snapshot. */
	async function discard() {
		return locked(async () => {
			await rm(activeDir, { recursive: true, force: true });
			await cleanStaging();
			return { ok: true };
		});
	}

	/** Describe the checkout currently on disk, without touching the network. */
	async function localState() {
		if (!existsSync(activeDir)) return { present: false };
		const usable = await isUsableRoot(activeDir);
		if (!usable) return { present: true, usable: false, dir: activeDir };
		const [commit, manifest] = await Promise.all([commitOf(activeDir), readPluginManifest(activeDir)]);
		return { present: true, usable: true, dir: activeDir, commit, version: manifest?.version };
	}

	return {
		url,
		activeDir,
		gitVersion,
		checkRemote,
		install,
		discard,
		localState,
	};
}
