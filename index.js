/**
 * dsh-unity-agent — the Host half.
 *
 * Unity publishes its agent skills through `Unity-Technologies/unity-agent-plugin`.
 * This plugin makes that repository a first-class DSH skill source:
 *
 * - a skill provider publishes the repository's `skills/` through `ctx.skills`,
 *   honouring the per-skill enable/disable state the settings page owns;
 * - the settings page's HTTP surface (`/api/dsh-unity-agent`) reports what is
 *   live, checks the upstream tip, and downloads a fresh checkout on demand;
 * - the bundled snapshot inside this package is the fallback, so the plugin
 *   works before the first download and on a machine with no network.
 *
 * All wiring is inside one `try`/`catch`: a plugin whose `apply` throws fails its
 * Loader entry, and a failed entry in this profile can take the whole desktop
 * shell down with it. A broken activation must therefore degrade to a log line,
 * never to an exception.
 *
 * Config keys (all optional, read from the Loader row's `config`):
 * `dshHome`, `dataDir`, `upstreamUrl`.
 *
 * @module dsh-unity-agent
 */

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { createApiHandler } from "./lib/api.js";
import { PROVIDER_NAME, PROVIDER_RANK, SOURCE, toCandidate, toDefinition } from "./lib/definition.js";
import { createService } from "./lib/service.js";
import { DEFAULT_UPSTREAM_URL } from "./lib/upstream.js";

const packageDir = dirname(fileURLToPath(import.meta.url));

/** Where the upstream repository and this plugin's own state live. */
const DATA_DIRNAME = "unity-agent-plugin";

/** The HTTP mount the browser half calls. */
const API_PATH = "/api/dsh-unity-agent";

export const name = "dsh-unity-agent";

/** The provider needs the skill registry; the web server is injected optionally. */
export const inject = ["skills"];

function packageVersion() {
	try {
		return JSON.parse(readFileSync(join(packageDir, "package.json"), "utf8"))?.version ?? "0.0.0";
	} catch {
		return "0.0.0";
	}
}

/**
 * Activate the plugin.
 *
 * @param {object} ctx - the Cordis context of this Loader row.
 * @param {object} [config] - optional Loader row config.
 * @returns {void}
 */
export function apply(ctx, config = {}) {
	try {
		const dshHome = typeof config.dshHome === "string" && config.dshHome !== "" ? config.dshHome : process.env.DSH_HOME || join(homedir(), ".dsh");
		const dataDir =
			typeof config.dataDir === "string" && config.dataDir !== "" ? config.dataDir : join(dshHome, DATA_DIRNAME);
		const upstreamUrl =
			typeof config.upstreamUrl === "string" && config.upstreamUrl !== "" ? config.upstreamUrl : DEFAULT_UPSTREAM_URL;
		const logger = ctx.logger ?? console;

		const service = createService({
			packageDir,
			dataDir,
			packageVersion: packageVersion(),
			upstreamUrl,
			logger,
		});

		const disposeProvider = ctx.skills.registerProvider((control) => {
			service.attachInvalidate(() => control.invalidate());
			return {
				name: PROVIDER_NAME,
				async list() {
					const skills = await service.listCandidates();
					return skills.map(toCandidate);
				},
				async get(candidate) {
					if (candidate === undefined || typeof candidate.name !== "string") return undefined;
					const entry = await service.readSkill(candidate.name);
					return entry === undefined ? undefined : toDefinition(entry);
				},
			};
		});

		ctx.effect(
			() => () => {
				try {
					disposeProvider?.();
				} catch (error) {
					logger.warn?.(`dsh-unity-agent: provider disposal failed (${error?.message ?? error})`);
				}
			},
			"dsh-unity-agent: skill provider",
		);

		ctx.inject(["webServer"], (scoped) => {
			const handler = createApiHandler({
				service,
				connection: () => ctx.get?.("connection"),
				logger,
			});
			scoped.effect(
				() => scoped.webServer.register({ kind: "prefix", path: API_PATH, handler }),
				"dsh-unity-agent: settings API",
			);
			logger.info?.(`dsh-unity-agent: settings API mounted at ${API_PATH}; upstream ${upstreamUrl}`);
		});

		logger.info?.(`dsh-unity-agent: skill provider "${PROVIDER_NAME}" registered from ${dataDir}`);
	} catch (error) {
		// Never rethrow: a failed Loader entry would take the desktop profile
		// down instead of merely disabling this one plugin.
		try {
			ctx?.logger?.error?.(`dsh-unity-agent: activation failed: ${error?.stack ?? error}`);
		} catch {
			console.error("dsh-unity-agent: activation failed", error);
		}
	}
}
