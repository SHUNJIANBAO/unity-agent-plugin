/**
 * Regenerate `upstream.json`, the provenance stamp of the bundled snapshot.
 *
 * The plugin reads that file to say which upstream commit and version the skills
 * inside this package came from. Run it whenever the bundled `skills/` tree is
 * refreshed from Unity's repository:
 *
 * ```
 * node dev/stamp-upstream.mjs "C:/path/to/unity-agent-plugin"
 * ```
 *
 * The argument is a checkout of `Unity-Technologies/unity-agent-plugin`. Its
 * branch may be `main` or a detached HEAD; the commit and the plugin version
 * come from the checkout itself, never from the plugin's own manifest.
 *
 * @module dev/stamp-upstream
 */

import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const packageDir = join(dirname(fileURLToPath(import.meta.url)), "..");
const checkout = process.argv[2];
if (checkout === undefined || checkout === "") {
	console.error("usage: node dev/stamp-upstream.mjs <path-to-unity-agent-plugin-checkout>");
	process.exit(2);
}

const git = (args) => execFileSync("git", args, { cwd: checkout, stdio: ["ignore", "pipe", "pipe"] }).toString().trim();
const commit = git(["rev-parse", "HEAD"]);
const branch = (() => {
	try {
		return git(["rev-parse", "--abbrev-ref", "HEAD"]);
	} catch {
		return "main";
	}
})();
const remote = (() => {
	try {
		return git(["remote", "get-url", "upstream"]);
	} catch {
		return git(["remote", "get-url", "origin"]);
	}
})();
const manifest = JSON.parse(readFileSync(join(checkout, ".claude-plugin", "plugin.json"), "utf8"));
const provenance = {
	repo: remote.endsWith(".git") ? remote : `${remote}.git`,
	branch: branch === "HEAD" ? "main" : branch,
	commit,
	version: manifest.version,
	snapshotAt: new Date().toISOString(),
};
writeFileSync(join(packageDir, "upstream.json"), `${JSON.stringify(provenance, null, 2)}\n`, "utf8");
console.log(`stamped ${provenance.version} @ ${commit.slice(0, 7)} from ${provenance.repo}`);
