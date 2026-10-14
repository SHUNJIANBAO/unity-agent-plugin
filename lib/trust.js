/**
 * Request trust fence for this plugin's HTTP surface.
 *
 * Web-server dispatch is longest-prefix-wins, and this plugin registers a
 * prefix longer than the kernel's `/api`, so these routes run *before* the
 * connection service's own admission check. Two layers close that gap, in the
 * order the shape of the running composition allows:
 *
 * 1. the composition's `connection` service, when present — the exact decision
 *    the kernel applies to `/api` (host/origin checks plus browser auth);
 * 2. a structural replica for compositions without it: loopback `Host` only,
 *    no cross-site fetches, and an `Origin`/`Referer` that matches the `Host`
 *    authority whenever the caller supplies one.
 *
 * This plugin can start a network download and rewrite a directory under
 * `$DSH_HOME`, so it must never answer a caller the app itself would refuse.
 *
 * @module lib/trust
 */

const LOOPBACK_NAMES = new Set(["127.0.0.1", "[::1]", "::1", "localhost"]);

/**
 * Decide one request.
 *
 * @param {object} req - the Node HTTP request.
 * @param {object|undefined} connection - the Harness `connection` service, when mounted.
 * @returns {number|undefined} a status to reject with, or undefined to proceed.
 */
export function rejectionFor(req, connection) {
	if (connection !== undefined && connection !== null) {
		try {
			if (typeof connection.admit === "function") {
				const admission = connection.admit(req);
				const status = admission !== null && typeof admission === "object" ? admission.rejection : undefined;
				return typeof status === "number" ? status : undefined;
			}
			if (typeof connection.requestRejection === "function") {
				const status = connection.requestRejection(req);
				return typeof status === "number" ? status : undefined;
			}
		} catch {
			// A mounted Host service that throws must not switch authentication
			// off, so the request is refused rather than served.
			return 503;
		}
	}
	return structuralRejection(req);
}

/**
 * The replica fence: loopback host, same-origin caller.
 *
 * @param {object} req - the Node HTTP request.
 * @returns {number|undefined} 403 when the request is not a same-machine,
 *   same-origin call; undefined otherwise.
 */
export function structuralRejection(req) {
	const headers = req?.headers ?? {};
	const host = authorityOf(headers.host, "http");
	if (host === null || !LOOPBACK_NAMES.has(host.hostname)) return 403;
	const site = String(headers["sec-fetch-site"] ?? "").toLowerCase();
	if (site === "cross-site") return 403;
	for (const header of ["origin", "referer"]) {
		const raw = headers[header];
		if (typeof raw !== "string" || raw.trim() === "") continue;
		// The desktop shell relays loopback requests with a dsh-app:// Referer
		// and no other browser marker; it is not an origin grant.
		if (header === "referer" && isDesktopRelayReferer(raw)) {
			if (headers.origin !== undefined || headers["sec-fetch-site"] !== undefined) return 403;
			continue;
		}
		const authority = authorityOf(raw.trim());
		if (authority === null) return 403;
		if (authority.scheme !== host.scheme || authority.hostname !== host.hostname || authority.port !== host.port) return 403;
	}
	return undefined;
}

function isDesktopRelayReferer(value) {
	try {
		const url = new URL(value);
		return url.protocol === "dsh-app:" && url.hostname === "app" && url.port === "" && url.username === "" && url.password === "";
	} catch {
		return false;
	}
}

function authorityOf(value, fallbackScheme) {
	if (typeof value !== "string" || value.trim() === "") return null;
	let url;
	try {
		url = new URL(value.includes("://") ? value.trim() : `${fallbackScheme ?? "http"}://${value.trim()}`);
	} catch {
		return null;
	}
	if (url.protocol !== "http:" && url.protocol !== "https:") return null;
	const port = url.port === "" ? (url.protocol === "https:" ? "443" : "80") : url.port;
	return { scheme: url.protocol.replace(":", ""), hostname: url.hostname.toLowerCase(), port };
}
