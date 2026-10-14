/**
 * Entry point for the package's test suite: `node test/run-all.mjs`.
 *
 * The test-only dependencies (a real YAML parser, a DOM, React) are deliberately
 * NOT declared in `package.json`: a `devDependencies` block makes pnpm install
 * them into its own git checkout every time someone installs this plugin, and
 * the published package must stay dependency-free. Install them ad hoc, in one
 * command so npm does not prune the previously added ones:
 *
 * ```
 * npm install --no-save --no-package-lock js-yaml@4 jsdom react@18.3.1 react-dom@18.3.1
 * ```
 *
 * @module test/run-all
 */

const DEV_DEPENDENCIES = ["js-yaml@4", "jsdom", "react@18.3.1", "react-dom@18.3.1"];

try {
	await import("js-yaml");
	await import("jsdom");
	await import("react");
	await import("react-dom");
} catch (error) {
	console.error(`\nThis suite needs its test-only dependencies: ${error?.message ?? error}`);
	console.error("Install all four in one command (npm prunes un-saved packages on each install):\n");
	console.error(`  npm install --no-save --no-package-lock ${DEV_DEPENDENCIES.join(" ")}\n`);
	process.exit(2);
}

const { run } = await import("./harness.mjs");

await import("./frontmatter.test.mjs");
await import("./store.test.mjs");
await import("./catalog.test.mjs");
await import("./upstream.test.mjs");
await import("./api.test.mjs");
await import("./provider.test.mjs");
await import("./client.test.mjs");

const result = await run();
process.exit(result.failed === 0 ? 0 : 1);
