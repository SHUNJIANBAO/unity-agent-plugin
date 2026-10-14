/**
 * The state file must survive crashes, corrupt content and rapid clicking.
 *
 * @module test/store.test
 */

import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { group, test, assert } from "./harness.mjs";
import { cleanup, makeTempDir } from "./fixtures.mjs";
import { createStore, emptyState } from "../lib/store.js";

group("store");

test("a fresh store starts empty and persists patches", () => {
	const dir = makeTempDir();
	const file = join(dir, "state.json");
	const store = createStore({ file });
	assert.equal(store.get().version, emptyState().version);
	assert.deepEqual(store.get().enabled, {});
	store.patch((state) => {
		state.enabled.alpha = false;
		state.upstream.lastUpdateAt = "2026-01-01T00:00:00.000Z";
	});
	store.flush();
	assert.equal(existsSync(file), true);
	const reloaded = createStore({ file });
	assert.equal(reloaded.get().enabled.alpha, false);
	assert.equal(reloaded.get().upstream.lastUpdateAt, "2026-01-01T00:00:00.000Z");
	cleanup();
});

test("a corrupt state file is moved aside instead of throwing", () => {
	const dir = makeTempDir();
	const file = join(dir, "state.json");
	writeFileSync(file, "{ this is not json", "utf8");
	const warnings = [];
	const store = createStore({ file, logger: { warn: (message) => warnings.push(message) } });
	assert.deepEqual(store.get().enabled, {});
	assert.equal(warnings.length, 1);
	assert.match(warnings[0], /unreadable/);
	// Nothing is written over the broken file before it is moved aside.
	const aside = readdirSync(dir).filter((name) => name.startsWith("state.json.corrupt-"));
	assert.equal(aside.length, 1);
	assert.equal(readFileSync(join(dir, aside[0]), "utf8"), "{ this is not json");
	cleanup();
});

test("non-boolean and unknown entries are dropped on load", () => {
	const dir = makeTempDir();
	const file = join(dir, "state.json");
	writeFileSync(
		file,
		JSON.stringify({ version: 99, enabled: { good: true, bad: "yes", worse: 1 }, junk: { a: 1 }, upstream: "nope" }),
		"utf8",
	);
	const store = createStore({ file });
	assert.deepEqual(store.get().enabled, { good: true });
	assert.deepEqual(store.get().upstream, {});
	assert.equal(store.get().version, emptyState().version);
	cleanup();
});

test("rapid patches coalesce into one write and keep the last value", () => {
	const dir = makeTempDir();
	const file = join(dir, "state.json");
	const store = createStore({ file, debounceMs: 5 });
	for (let index = 0; index < 50; index += 1) {
		store.patch((state) => {
			state.enabled.alpha = index % 2 === 0;
		});
	}
	store.flush();
	const parsed = JSON.parse(readFileSync(file, "utf8"));
	assert.equal(parsed.enabled.alpha, false);
	cleanup();
});
