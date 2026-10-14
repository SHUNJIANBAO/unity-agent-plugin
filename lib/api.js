/**
 * The settings page's HTTP surface, mounted at `/api/dsh-unity-agent`.
 *
 * The browser half talks to this with same-origin `fetch`, the shape the other
 * settings-page plugins in this profile use; every route runs the trust fence
 * first (see `lib/trust.js`) because this prefix outranks the kernel's `/api`.
 *
 * Every route answers with the same envelope: `{ ok, error?, data }`, where
 * `data` is the complete settings payload, so one round trip is always enough
 * for the page to re-render from truth instead of from optimistic guesses.
 *
 * @module lib/api
 */

import { rejectionFor } from "./trust.js";

/** Largest accepted request body; every action carries at most a name list. */
const MAX_BODY_BYTES = 256 * 1024;

/** Read a JSON request body, refusing anything oversized. */
async function readJson(req) {
	const chunks = [];
	let size = 0;
	for await (const chunk of req) {
		size += chunk.length;
		if (size > MAX_BODY_BYTES) throw new Error("请求体过大");
		chunks.push(chunk);
	}
	if (size === 0) return {};
	const text = Buffer.concat(chunks).toString("utf8").trim();
	if (text === "") return {};
	return JSON.parse(text);
}

/**
 * Build the route handler.
 *
 * @param {object} options - handler options.
 * @param {object} options.service - the plugin core.
 * @param {() => (object|undefined)} options.connection - late-bound `connection` service lookup.
 * @param {{ warn?: Function, info?: Function }} [options.logger] - logger.
 * @returns {(req: object, res: object) => Promise<void>} the handler.
 */
export function createApiHandler({ service, connection, logger }) {
	return async function handler(req, res) {
		const send = (status, payload) => {
			let body;
			try {
				body = JSON.stringify(payload);
			} catch (error) {
				body = JSON.stringify({ ok: false, error: `响应无法序列化：${error?.message ?? error}` });
			}
			try {
				res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
				res.end(body);
			} catch (error) {
				logger?.warn?.(`dsh-unity-agent: could not answer (${error?.message ?? error})`);
			}
		};

		let connectionService;
		try {
			connectionService = typeof connection === "function" ? connection() : connection;
		} catch {
			connectionService = undefined;
		}
		const rejection = rejectionFor(req, connectionService);
		if (rejection !== undefined) {
			return send(rejection, {
				ok: false,
				error: rejection === 401 ? "unauthorized" : rejection === 503 ? "admission unavailable" : "forbidden",
			});
		}

		let routePath = "/";
		let method = "GET";
		try {
			const url = new URL(req.url ?? "/", "http://localhost");
			routePath = url.pathname.replace(/^\/api\/dsh-unity-agent/, "").replace(/\/+$/, "") || "/";
			method = String(req.method ?? "GET").toUpperCase();
		} catch {
			return send(400, { ok: false, error: "bad request" });
		}

		try {
			if (method === "GET" && (routePath === "/" || routePath === "/state")) {
				return send(200, { ok: true, data: await service.state() });
			}
			if (method === "POST" && routePath === "/check") {
				const check = await service.check();
				return send(200, { ok: check.ok === true, error: check.error, check, data: await service.state() });
			}
			if (method === "POST" && routePath === "/update") {
				const update = await service.update();
				return send(200, {
					ok: update.ok === true,
					error: update.error,
					changelog: update.changelog,
					data: await service.state(),
				});
			}
			if (method === "POST" && routePath === "/reset") {
				const reset = await service.reset();
				return send(200, { ok: reset.ok === true, error: reset.error, changelog: reset.changelog, data: await service.state() });
			}
			if (method === "POST" && routePath === "/skill") {
				const body = await readJson(req);
				const result = await service.setEnabled(body?.name, body?.enabled === true);
				return send(result.ok === true ? 200 : 400, { ok: result.ok === true, error: result.error, data: await service.state() });
			}
			if (method === "POST" && routePath === "/skills") {
				const body = await readJson(req);
				const result = await service.setAll(body?.enabled === true, Array.isArray(body?.names) ? body.names : undefined);
				return send(result.ok === true ? 200 : 400, {
					ok: result.ok === true,
					error: result.error,
					changed: result.changed,
					data: await service.state(),
				});
			}
			return send(404, { ok: false, error: `unknown route ${method} ${routePath}` });
		} catch (error) {
			logger?.warn?.(`dsh-unity-agent: ${method} ${routePath} failed: ${error?.message ?? error}`);
			return send(500, { ok: false, error: String(error?.message ?? error) });
		}
	};
}
