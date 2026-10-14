/**
 * Entry point for the package's test suite: `node test/run-all.mjs`.
 *
 * @module test/run-all
 */

import { run } from "./harness.mjs";

await import("./frontmatter.test.mjs");
await import("./store.test.mjs");
await import("./catalog.test.mjs");
await import("./upstream.test.mjs");
await import("./api.test.mjs");
await import("./provider.test.mjs");
await import("./client.test.mjs");

const result = await run();
process.exit(result.failed === 0 ? 0 : 1);
