/**
 * Zero-dependency test harness for this package.
 *
 * `node test/run-all.mjs` imports every test module; each module registers
 * cases against the shared registry below and the runner reports one line per
 * case. No test framework is installed, because the packaged plugin must stay
 * dependency-free and the tests must be runnable from the packaged copy too.
 *
 * @module test/harness
 */

import assert from "node:assert/strict";

const cases = [];
let currentGroup = "(ungrouped)";

/** Group the cases registered afterwards. */
export function group(name) {
	currentGroup = name;
}

/** Register one test case. */
export function test(name, fn) {
	cases.push({ group: currentGroup, name, fn });
}

/** Run every registered case; returns { passed, failed, failures }. */
export async function run() {
	let passed = 0;
	const failures = [];
	for (const item of cases) {
		const label = `${item.group} › ${item.name}`;
		try {
			await item.fn();
			passed += 1;
			console.log(`  ok   ${label}`);
		} catch (error) {
			failures.push({ label, error });
			console.log(`  FAIL ${label}`);
			console.log(`       ${error && error.message ? error.message : String(error)}`);
		}
	}
	console.log(`\n${passed} passed, ${failures.length} failed, ${cases.length} total`);
	return { passed, failed: failures.length, failures };
}

export { assert };
