/**
 * The settings HTTP surface: routing, the trust fence, the enable/disable
 * actions, and the update flow end to end.
 *
 * The requests and responses are plain objects shaped like Node's, so the whole
 * surface is exercised without a web server.
 *
 * @module test/api.test
 */

import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { group, test, assert } from "./harness.mjs";
import { cleanup } from "./fixtures.mjs";
import { callApi, makeRequest, makeResponse, makeServiceHarness } from "./server-harness.mjs";
import { createApiHandler } from "../lib/api.js";

group("api");

const REMOTE_SHA = "c".repeat(40);

/**
 * The request/response fakes and the service harness live in
 * `test/server-harness.mjs` so the client-half test drives the same surface.
 */
const makeHarness = makeServiceHarness;
const call = callApi;

test("GET /state reports skills, counters and provenance", async () => {
	const { service, dataDir } = makeHarness();
	const handler = createApiHandler({ service, connection: () => undefined });
	const { status, json, headers } = await call(handler, {});
	assert.equal(status, 200);
	assert.equal(json.ok, true);
	assert.equal(json.data.plugin.version, "1.2.3");
	assert.equal(json.data.plugin.source, "bundled");
	assert.equal(json.data.plugin.dataDir, dataDir);
	assert.deepEqual(json.data.skills.map((skill) => skill.name), ["alpha", "beta"]);
	assert.deepEqual(json.data.stats, { total: 2, enabled: 2, disabled: 0, broken: 0 });
	assert.equal(json.data.git.available, true);
	assert.equal(json.data.upstream.bundled.skills, 2);
	assert.equal(headers["content-type"], "application/json; charset=utf-8");
	assert.equal(headers["cache-control"], "no-store");
	cleanup();
});

test("the trust fence refuses anything but a same-origin loopback caller", async () => {
	const { service } = makeHarness();
	const handler = createApiHandler({ service, connection: () => undefined });
	assert.equal((await call(handler, { headers: { host: "evil.example" } })).status, 403);
	assert.equal((await call(handler, { headers: { "sec-fetch-site": "cross-site" } })).status, 403);
	assert.equal((await call(handler, { headers: { origin: "http://evil.example" } })).status, 403);
	assert.equal((await call(handler, { headers: { origin: "https://127.0.0.1:19387" } })).status, 403);
	// The desktop shell relays loopback calls with a dsh-app:// Referer.
	assert.equal((await call(handler, { headers: { referer: "dsh-app://app/" } })).status, 200);
	assert.equal((await call(handler, { headers: { origin: "http://127.0.0.1:19387", referer: "http://127.0.0.1:19387/" } })).status, 200);
	cleanup();
});

test("a mounted connection service owns the admission decision", async () => {
	const { service } = makeHarness();
	const rejecting = createApiHandler({ service, connection: () => ({ admit: () => ({ rejection: 401 }) }) });
	const first = await call(rejecting, {});
	assert.equal(first.status, 401);
	assert.equal(first.json.error, "unauthorized");

	const throwing = createApiHandler({
		service,
		connection: () => ({
			admit: () => {
				throw new Error("admission exploded");
			},
		}),
	});
	assert.equal((await call(throwing, {})).status, 503);

	const older = createApiHandler({ service, connection: () => ({ requestRejection: () => 403 }) });
	assert.equal((await call(older, {})).status, 403);
	cleanup();
});

test("POST /skill toggles one skill and the provider stops offering it", async () => {
	const { service } = makeHarness();
	const handler = createApiHandler({ service, connection: () => undefined });
	const off = await call(handler, { method: "POST", url: "/api/dsh-unity-agent/skill", body: { name: "alpha", enabled: false } });
	assert.equal(off.status, 200);
	assert.equal(off.json.ok, true);
	assert.equal(off.json.data.skills.find((skill) => skill.name === "alpha").enabled, false);
	assert.equal(off.json.data.stats.disabled, 1);
	assert.deepEqual((await service.listCandidates()).map((skill) => skill.name), ["beta"]);
	// The state file on disk agrees, so the choice survives a restart.
	assert.equal(service.store.get().enabled.alpha, false);

	const on = await call(handler, { method: "POST", url: "/api/dsh-unity-agent/skill", body: { name: "alpha", enabled: true } });
	assert.equal(on.json.data.skills.find((skill) => skill.name === "alpha").enabled, true);
	assert.deepEqual((await service.listCandidates()).map((skill) => skill.name), ["alpha", "beta"]);
	cleanup();
});

test("POST /skill rejects an unknown skill and malformed input", async () => {
	const { service } = makeHarness();
	const handler = createApiHandler({ service, connection: () => undefined });
	const unknown = await call(handler, { method: "POST", url: "/api/dsh-unity-agent/skill", body: { name: "nope", enabled: false } });
	assert.equal(unknown.status, 400);
	assert.match(unknown.json.error, /未知技能/);
	assert.equal(unknown.json.data !== undefined, true, "the page still gets fresh state");
	const malformed = await call(handler, { method: "POST", url: "/api/dsh-unity-agent/skill", body: { enabled: false } });
	assert.equal(malformed.status, 400);
	cleanup();
});

test("POST /skills switches every skill at once", async () => {
	const { service } = makeHarness();
	const handler = createApiHandler({ service, connection: () => undefined });
	const all = await call(handler, { method: "POST", url: "/api/dsh-unity-agent/skills", body: { enabled: false } });
	assert.equal(all.status, 200);
	assert.equal(all.json.changed, 2);
	assert.equal(all.json.data.stats.enabled, 0);
	assert.deepEqual(await service.listCandidates(), []);
	const back = await call(handler, { method: "POST", url: "/api/dsh-unity-agent/skills", body: { enabled: true, names: ["beta"] } });
	assert.equal(back.json.changed, 1);
	assert.deepEqual((await service.listCandidates()).map((skill) => skill.name), ["beta"]);
	cleanup();
});

test("POST /check compares the live commit with the upstream tip", async () => {
	const { service, upstream, packageDir } = makeHarness();
	const handler = createApiHandler({ service, connection: () => undefined });

	// The remote tip equals the bundled commit: nothing to do.
	upstream.setSha(JSON.parse(readFileSync(join(packageDir, "upstream.json"), "utf8")).commit);
	const upToDate = await call(handler, { method: "POST", url: "/api/dsh-unity-agent/check", body: {} });
	assert.equal(upToDate.status, 200);
	assert.equal(upToDate.json.ok, true);
	assert.equal(upToDate.json.data.upstream.pending.available, false);
	assert.equal(upToDate.json.data.upstream.pending.baseSource, "bundled");

	// Then Unity publishes a commit.
	upstream.setSha(REMOTE_SHA);
	const available = await call(handler, { method: "POST", url: "/api/dsh-unity-agent/check", body: {} });
	assert.equal(available.json.data.upstream.pending.available, true);
	assert.equal(available.json.data.upstream.pending.remote, REMOTE_SHA);
	assert.equal(available.json.data.upstream.remote.reachable, true);
	cleanup();
});

test("POST /check surfaces an unreachable upstream without losing the page", async () => {
	const { service } = makeHarness({ remoteFails: true });
	const handler = createApiHandler({ service, connection: () => undefined });
	const { status, json } = await call(handler, { method: "POST", url: "/api/dsh-unity-agent/check", body: {} });
	assert.equal(status, 200);
	assert.equal(json.ok, false);
	assert.match(json.error, /scripted network failure/);
	assert.equal(json.data.skills.length, 2);
	assert.equal(json.data.upstream.remote.reachable, false);
	assert.equal(json.data.upstream.pending.available, false);
	cleanup();
});

test("POST /update downloads, reports a changelog and makes the new skills live", async () => {
	const { service, upstream } = makeHarness();
	const handler = createApiHandler({ service, connection: () => undefined });
	upstream.setSkills(["alpha", "gamma"], "2.0.0");
	const { status, json } = await call(handler, { method: "POST", url: "/api/dsh-unity-agent/update", body: {} });
	assert.equal(status, 200);
	assert.equal(json.ok, true);
	// Against the bundled snapshot: gamma is new, beta is gone, and alpha's
	// content differs (the scripted remote rewrites every skill it publishes).
	assert.deepEqual(json.changelog.added, ["gamma"]);
	assert.deepEqual(json.changelog.removed, ["beta"]);
	assert.deepEqual(json.changelog.changed, ["alpha"]);
	assert.equal(json.changelog.fromSource, "bundled");
	assert.equal(json.changelog.to, REMOTE_SHA);
	assert.equal(json.data.plugin.source, "upstream");
	assert.equal(json.data.upstream.checkout.version, "2.0.0");
	assert.deepEqual(json.data.skills.map((skill) => skill.name), ["alpha", "gamma"]);
	assert.equal(json.data.upstream.pending.available, false);
	// The new skill is immediately offered to the registry.
	assert.deepEqual((await service.listCandidates()).map((skill) => skill.name), ["alpha", "gamma"]);
	cleanup();
});

test("a failed update reports the error and keeps serving what works", async () => {
	const { service, upstream } = makeHarness({ cloneFails: true });
	const handler = createApiHandler({ service, connection: () => undefined });
	const { status, json } = await call(handler, { method: "POST", url: "/api/dsh-unity-agent/update", body: {} });
	assert.equal(status, 200);
	assert.equal(json.ok, false);
	assert.match(json.error, /scripted clone failure/);
	assert.equal(json.data.plugin.source, "bundled");
	assert.equal(json.data.skills.length, 2);
	assert.match(json.data.upstream.lastError, /scripted clone failure/);
	upstream.setCloneFails(false);
	cleanup();
});

test("POST /reset drops the checkout and returns to the bundled snapshot", async () => {
	const { service, upstream } = makeHarness();
	const handler = createApiHandler({ service, connection: () => undefined });
	await call(handler, { method: "POST", url: "/api/dsh-unity-agent/update", body: {} });
	assert.equal((await call(handler, {})).json.data.plugin.source, "upstream");
	const reset = await call(handler, { method: "POST", url: "/api/dsh-unity-agent/reset", body: {} });
	assert.equal(reset.json.ok, true);
	assert.equal(reset.json.data.plugin.source, "bundled");
	assert.equal(reset.json.data.skills.length, 2);
	assert.equal(upstream.calls.includes("discard"), true);
	cleanup();
});

test("an unknown route or method is a 404, and a broken body is a 500", async () => {
	const { service } = makeHarness();
	const handler = createApiHandler({ service, connection: () => undefined });
	assert.equal((await call(handler, { url: "/api/dsh-unity-agent/nope" })).status, 404);
	assert.equal((await call(handler, { method: "DELETE", url: "/api/dsh-unity-agent/state" })).status, 404);
	const response = makeResponse();
	const request = makeRequest({ method: "POST", url: "/api/dsh-unity-agent/skill" });
	request[Symbol.asyncIterator] = async function* () {
		yield Buffer.from("{ not json", "utf8");
	};
	await handler(request, response);
	assert.equal(response.captured.status, 500);
	cleanup();
});

test("a state file that cannot be written is reported, not silently accepted", async () => {
	const harness = makeHarness();
	const { service } = harness;
	// Block the atomic write the way a locked directory would.
	mkdirSync(`${service.paths.stateFile}.tmp`, { recursive: true });
	const result = await call(harness.handler, {
		method: "POST",
		url: "/api/dsh-unity-agent/skill",
		body: { name: "alpha", enabled: false },
	});
	assert.equal(result.status, 400);
	assert.equal(result.json.ok, false);
	assert.match(result.json.error, /状态文件写入失败/);
	const bulk = await call(harness.handler, { method: "POST", url: "/api/dsh-unity-agent/skills", body: { enabled: false } });
	assert.equal(bulk.json.ok, false);
	assert.match(bulk.json.error, /状态文件写入失败/);
	cleanup();
});

test("a check is persisted immediately, and a reset stops claiming the old update", async () => {
	const harness = makeHarness();
	const { service, upstream } = harness;
	upstream.setSha(REMOTE_SHA);
	await service.check();
	const persisted = JSON.parse(readFileSync(service.paths.stateFile, "utf8"));
	assert.equal(persisted.upstream.lastCheck.sha, REMOTE_SHA);
	assert.equal(persisted.upstream.pending.available, true);

	await call(harness.handler, { method: "POST", url: "/api/dsh-unity-agent/update", body: {} });
	assert.equal(typeof service.store.get().upstream.lastUpdateAt, "string");
	await service.reset();
	assert.equal(service.store.get().upstream.lastUpdateAt, undefined);
	assert.equal(service.store.get().upstream.pending, undefined);
	assert.notEqual(service.store.get().upstream.lastChangelog, undefined);
	cleanup();
});
