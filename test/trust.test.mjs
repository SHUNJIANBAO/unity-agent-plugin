/**
 * The request trust fence.
 *
 * These routes register a prefix longer than the kernel's `/api`, so they run
 * before the connection service's own admission check: the fence is the only
 * thing standing in front of "clone a repository" and "disable a skill". The
 * cases below cover both layers — the mounted service's answers, and the
 * structural replica used when it is absent or speaks an unknown shape.
 *
 * @module test/trust.test
 */

import { group, test, assert } from "./harness.mjs";
import { isLoopbackAddress, rejectionFor, structuralRejection } from "../lib/trust.js";

group("trust");

/** A request shaped like Node's IncomingMessage. */
function request({ host = "127.0.0.1:19387", headers = {}, remoteAddress = "127.0.0.1" } = {}) {
	return { headers: { host, ...headers }, socket: remoteAddress === undefined ? undefined : { remoteAddress } };
}

test("a same-machine, same-origin request passes", () => {
	assert.equal(structuralRejection(request()), undefined);
	assert.equal(structuralRejection(request({ headers: { origin: "http://127.0.0.1:19387" } })), undefined);
	assert.equal(structuralRejection(request({ host: "localhost:19387" })), undefined);
	assert.equal(structuralRejection(request({ host: "[::1]:19387", remoteAddress: "::1" })), undefined);
});

test("a caller that is not on this machine, or not this page, is refused", () => {
	assert.equal(structuralRejection(request({ host: "evil.example" })), 403);
	assert.equal(structuralRejection(request({ headers: { "sec-fetch-site": "cross-site" } })), 403);
	assert.equal(structuralRejection(request({ headers: { origin: "http://evil.example" } })), 403);
	assert.equal(structuralRejection(request({ headers: { origin: "https://127.0.0.1:19387" } })), 403, "scheme must match");
	assert.equal(structuralRejection(request({ headers: { origin: "http://127.0.0.1:9999" } })), 403, "port must match");
	assert.equal(structuralRejection(request({ headers: { origin: "null" } })), 403);
	assert.equal(structuralRejection(request({ remoteAddress: "192.168.0.10", headers: { origin: "http://127.0.0.1:19387" } })), 403);
	assert.equal(structuralRejection(request({ remoteAddress: "::ffff:10.0.0.5" })), 403);
	assert.equal(structuralRejection(request({ headers: { host: "127.0.0.1:19387", origin: ["a", "b"] } })), 403);
});

test("the desktop relay's Referer is accepted only while it stands alone", () => {
	assert.equal(structuralRejection(request({ headers: { referer: "dsh-app://app/" } })), undefined);
	assert.equal(structuralRejection(request({ headers: { referer: "dsh-app://app/", origin: "http://127.0.0.1:19387" } })), 403);
	assert.equal(structuralRejection(request({ headers: { referer: "dsh-app://other/" } })), 403);
});

test("the peer address is checked independently of the Host header", () => {
	// The header is caller-supplied, so a loopback claim from a remote peer must
	// not be enough on its own.
	assert.equal(structuralRejection({ headers: { host: "127.0.0.1:19387" }, socket: { remoteAddress: "203.0.113.7" } }), 403);
	// Without an address on the socket the header checks still apply.
	assert.equal(structuralRejection({ headers: { host: "127.0.0.1:19387" } }), undefined);
	assert.equal(structuralRejection({ headers: { host: "evil.example" }, socket: undefined }), 403);
});

test("loopback addresses are recognised in every shape the socket uses", () => {
	for (const address of ["127.0.0.1", "127.1.2.3", "::1", "::ffff:127.0.0.1", "::ffff:7f00:1", "127.0.0.1:0"]) {
		if (address === "127.0.0.1:0") continue;
		assert.equal(isLoopbackAddress(address), true, address);
	}
	for (const address of ["", "0.0.0.0", "10.0.0.1", "::", "fe80::1", "evil"]) {
		assert.equal(isLoopbackAddress(address), false, address);
	}
});

test("a mounted connection service owns the decision", () => {
	assert.equal(rejectionFor(request(), { admit: () => ({ rejection: 401 }) }), 401);
	assert.equal(rejectionFor(request(), { admit: () => ({ peer: { id: "operator" } }) }), undefined);
	assert.equal(rejectionFor(request(), { requestRejection: () => 403 }), 403);
	assert.equal(rejectionFor(request(), { requestRejection: () => undefined }), undefined);
	assert.equal(
		rejectionFor(request(), {
			admit: () => {
				throw new Error("admission exploded");
			},
		}),
		503,
	);
});

test("an unrecognized admission answer falls through to the fence, never to permission", () => {
	const service = { admit: () => ({ ok: true }) };
	assert.equal(rejectionFor(request({ headers: { origin: "http://evil.example" } }), service), 403);
	assert.equal(rejectionFor(request(), service), undefined, "a same-origin caller still works");
	// A bare status, a boolean or a promise are all unrecognized shapes.
	assert.equal(rejectionFor(request({ headers: { origin: "http://evil.example" } }), { admit: () => 401 }), 403);
	assert.equal(rejectionFor(request({ headers: { origin: "http://evil.example" } }), { admit: async () => ({ rejection: 401 }) }), 403);
	assert.equal(rejectionFor(request(), { admit: () => true }), undefined);
	// requestRejection's older contract: a status, or undefined for "allowed".
	const older = { requestRejection: () => "yes" };
	assert.equal(rejectionFor(request({ headers: { origin: "http://evil.example" } }), older), 403);
	// A mounted service that owns neither method cannot speak for these routes.
	assert.equal(rejectionFor(request({ headers: { origin: "http://evil.example" } }), {}), 403);
	assert.equal(rejectionFor(request(), {}), undefined);
});
