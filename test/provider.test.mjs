/**
 * The registry contract.
 *
 * `@deepseek-ai/dsh-skill` validates every candidate and definition strictly
 * and throws out of the whole provider on a violation, which would erase every
 * Unity skill from the catalog at once. The assertions below restate the
 * checks from that package's registry (`validateCandidate`, `validateDefinition`,
 * `SKILL_NAME`) so this plugin's part of the contract is verified without
 * mounting a Harness.
 *
 * @module test/provider.test
 */

import { existsSync, statSync } from "node:fs";

import { group, test, assert } from "./harness.mjs";
import { cleanup, makePackageRoot, scriptedUpstream } from "./fixtures.mjs";
import { PROVIDER_NAME, PROVIDER_RANK, SOURCE, toCandidate, toDefinition } from "../lib/definition.js";
import { createService } from "../lib/service.js";

group("provider");

/** The registry's public name grammar. */
const SKILL_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** Restate `validateCandidate` from `@deepseek-ai/dsh-skill`. */
function assertValidCandidate(candidate, providerName) {
	assert.equal(typeof candidate.name, "string");
	assert.ok(SKILL_NAME.test(candidate.name), `invalid skill name ${candidate.name}`);
	assert.equal(typeof candidate.description, "string");
	assert.ok(candidate.description.length > 0, "description must not be empty");
	assert.equal(typeof candidate.source, "string");
	assert.equal(typeof candidate.rank, "number");
	assert.ok(Number.isFinite(candidate.rank));
	assert.equal(typeof candidate.provider, "string");
	assert.equal(candidate.provider, providerName, "provider must equal the provider's own name");
	if (candidate.whenToUse !== undefined) assert.equal(typeof candidate.whenToUse, "string");
	if (candidate.path !== undefined) assert.equal(typeof candidate.path, "string");
	const invocation = candidate.invocation;
	assert.equal(typeof invocation, "object");
	assert.equal(typeof invocation.modelInvocable, "boolean");
	assert.equal(typeof invocation.userInvocable, "boolean");
}

/** Restate `validateDefinition` from `@deepseek-ai/dsh-skill`. */
function assertValidDefinition(definition, expectedName) {
	assert.equal(definition.name, expectedName);
	assert.equal(typeof definition.description, "string");
	assert.ok(definition.description.length > 0);
	assert.equal(typeof definition.source, "string");
	assert.equal(typeof definition.provider, "string");
	assert.equal(typeof definition.content, "string");
	assert.ok(definition.content.length > 0);
	assert.equal(definition.content.startsWith("---"), false, "the body must not repeat the frontmatter");
	if (definition.path !== undefined) assert.equal(typeof definition.path, "string");
	const base = definition.resourceBase;
	assert.ok(base !== undefined);
	assert.equal(base.kind, "directory");
	assert.equal(existsSync(base.path), true, "the resource base must exist");
	assert.equal(statSync(base.path).isDirectory(), true);
}

function makeService({ upstreamSkills = ["alpha"] } = {}) {
	const { packageDir, dataDir } = makePackageRoot({ skills: ["alpha", "beta", "gamma"] });
	const upstream = scriptedUpstream({ dataDir, skills: upstreamSkills, sha: "d".repeat(40) });
	const service = createService({ packageDir, dataDir, upstream, logger: {} });
	return { packageDir, dataDir, upstream, service };
}

test("every candidate satisfies the registry's candidate validation", async () => {
	const { service } = makeService();
	const entries = await service.listCandidates();
	assert.deepEqual(entries.map((entry) => entry.name), ["alpha", "beta", "gamma"]);
	for (const entry of entries) {
		const candidate = toCandidate(entry);
		assertValidCandidate(candidate, PROVIDER_NAME);
		assert.equal(candidate.source, SOURCE);
		assert.equal(candidate.rank, PROVIDER_RANK);
		assert.deepEqual(candidate.locator, { name: entry.name });
	}
	cleanup();
});

test("a disabled skill is absent from the catalog and cannot be loaded", async () => {
	const { service } = makeService();
	assert.equal((await service.listCandidates()).length, 3);
	await service.setEnabled("beta", false);
	assert.deepEqual((await service.listCandidates()).map((entry) => entry.name), ["alpha", "gamma"]);
	assert.equal(await service.readSkill("beta"), undefined);
	assert.notEqual(await service.readSkill("alpha"), undefined);
	// The rejection never leaks into the state file as a stray key.
	assert.equal(service.store.get().enabled.beta, false);
	cleanup();
});

test("every definition satisfies the registry's definition validation", async () => {
	const { service } = makeService();
	for (const name of ["alpha", "beta", "gamma"]) {
		const entry = await service.readSkill(name);
		assert.notEqual(entry, undefined, `${name} loads`);
		assertValidDefinition(toDefinition(entry), name);
	}
	cleanup();
});

test("a skill's relative resources resolve through the resource base", async () => {
	const { packageDir, dataDir, service } = makeService();
	const { writeSkill } = await import("./fixtures.mjs");
	const { join } = await import("node:path");
	writeSkill(packageDir, "delta", { description: "has references", reference: "notes.md" });
	await service.setAll(true);
	const entry = await service.readSkill("delta");
	assert.notEqual(entry, undefined);
	const definition = toDefinition(entry);
	assertValidDefinition(definition, "delta");
	assert.equal(existsSync(join(definition.resourceBase.path, "references", "notes.md")), true);
	void dataDir;
	cleanup();
});

test("the provider follows the active root, not the package", async () => {
	const { service, upstream } = makeService({ upstreamSkills: ["alpha", "zeta"] });
	await service.update();
	assert.equal((await service.activeRoot()).source, "upstream");
	const names = (await service.listCandidates()).map((entry) => entry.name);
	assert.deepEqual(names, ["alpha", "zeta"]);
	// A skill the upstream dropped is gone; the one it added is usable.
	assert.equal(await service.readSkill("beta"), undefined);
	const zeta = await service.readSkill("zeta");
	assert.notEqual(zeta, undefined);
	assertValidDefinition(toDefinition(zeta), "zeta");
	assert.equal(service.store.get().upstream.lastChangelog.added.includes("zeta"), true);
	assert.equal(service.store.get().upstream.lastChangelog.removed.includes("beta"), true);
	cleanup();
});

test("invalidation is requested on every change so the catalog refreshes", async () => {
	const { service } = makeService();
	let invalidations = 0;
	service.attachInvalidate(() => {
		invalidations += 1;
	});
	await service.setEnabled("alpha", false);
	assert.equal(invalidations, 1);
	await service.setAll(false);
	assert.equal(invalidations, 2);
	await service.check();
	assert.equal(invalidations, 2, "a check does not change what is published");
	await service.update();
	assert.equal(invalidations, 3);
	cleanup();
});
