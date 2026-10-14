/**
 * Drives the plugin's real HTTP surface with plain-object requests, so tests can
 * exercise routing, the trust fence and the service without a web server.
 *
 * Shared by `test/api.test.mjs` and `test/client.test.mjs`.
 *
 * @module test/server-harness
 */

import { cleanup, makePackageRoot, scriptedUpstream } from "./fixtures.mjs";
import { createApiHandler } from "../lib/api.js";
import { createService } from "../lib/service.js";

/** The commit the scripted remote reports while "an update" is available. */
export const REMOTE_SHA = "c".repeat(40);

/**
 * A service over a throwaway package root plus a scripted upstream, and the API
 * handler in front of it.
 *
 * @param {object} [options] - harness options.
 * @param {string} [options.remoteSha] - the scripted remote tip.
 * @param {boolean} [options.cloneFails] - make the scripted clone fail.
 * @param {boolean} [options.remoteFails] - make the scripted remote unreachable.
 * @param {string[]} [options.skills] - skills in the bundled snapshot.
 * @param {object} [options.connection] - a `connection` service stand-in.
 * @returns {object} the harness.
 */
export function makeServiceHarness({
	remoteSha = REMOTE_SHA,
	cloneFails = false,
	remoteFails = false,
	skills = ["alpha", "beta"],
	connection,
} = {}) {
	const { packageDir, dataDir } = makePackageRoot({ skills });
	const upstream = scriptedUpstream({
		dataDir,
		sha: remoteSha,
		skills,
		cloneFails,
		remoteFails,
	});
	const service = createService({ packageDir, dataDir, packageVersion: "1.2.3", upstream, logger: {} });
	const handler = createApiHandler({ service, connection: connection ?? (() => undefined), logger: {} });
	return { packageDir, dataDir, upstream, service, handler, cleanup };
}

/** A fake `IncomingMessage`-like request. */
export function makeRequest({ method = "GET", url = "/api/dsh-unity-agent/state", headers = {}, body } = {}) {
	const chunks = body === undefined ? [] : [Buffer.from(JSON.stringify(body), "utf8")];
	return {
		method,
		url,
		headers: { host: "127.0.0.1:19387", ...headers },
		async *[Symbol.asyncIterator]() {
			for (const chunk of chunks) yield chunk;
		},
	};
}

/** A fake `ServerResponse` that records what was written. */
export function makeResponse() {
	const captured = { status: undefined, headers: undefined, body: undefined };
	return {
		captured,
		writeHead(status, headers) {
			captured.status = status;
			captured.headers = headers;
			return this;
		},
		end(body) {
			captured.body = body;
			return this;
		},
	};
}

/**
 * Run one request through a handler and parse its JSON envelope.
 *
 * @param {(req: object, res: object) => Promise<void>} handler - the API handler.
 * @param {object} [requestOptions] - request fields.
 * @returns {Promise<{ status: number, json: object|undefined, headers: object|undefined }>} the answer.
 */
export async function callApi(handler, requestOptions) {
	const response = makeResponse();
	await handler(makeRequest(requestOptions), response);
	const { status, body, headers } = response.captured;
	let json;
	try {
		json = JSON.parse(body);
	} catch {
		json = undefined;
	}
	return { status, json, headers };
}

export { cleanup };
