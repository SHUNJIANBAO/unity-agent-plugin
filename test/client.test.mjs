/**
 * The browser half, exercised in a real DOM against the real HTTP surface.
 *
 * The page is a hand-written React component with no build step, so the risk is
 * not the bundle format but what it does once mounted: does it survive the real
 * state payload, do the switches send the right request, does a failed backend
 * still render. Here jsdom provides the DOM, the plugin's own `createApiHandler`
 * serves the requests (the same handler the Host mounts), and only the network
 * upstream is scripted.
 *
 * @module test/client.test
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { JSDOM } from "jsdom";
import React from "react";
import { createRoot } from "react-dom/client";
import { act } from "react-dom/test-utils";

import { group, test, assert } from "./harness.mjs";
import { cleanup } from "./fixtures.mjs";
import { callApi, makeServiceHarness, REMOTE_SHA } from "./server-harness.mjs";

group("client");

const packageDir = join(dirname(fileURLToPath(import.meta.url)), "..");
const source = readFileSync(join(packageDir, "client.js"), "utf8");

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

/**
 * Mount the real client module in a fresh DOM wired to a real API handler.
 *
 * @param {object} harness - a `makeServiceHarness()` result.
 * @param {object} [options] - mount options.
 * @param {string} [options.lang] - the document language.
 * @param {(key: string) => string} [options.boundTranslator] - what `ctx.locale.bind` returns.
 * @returns {Promise<object>} the mounted page.
 */
async function mountClient(harness, { lang = "zh", boundTranslator } = {}) {
	const dom = new JSDOM(
		`<!doctype html><html lang="${lang}"><head></head><body><div id="host"></div></body></html>`,
		{ url: "http://127.0.0.1:19387/" },
	);
	const previousWindow = globalThis.window;
	const previousDocument = globalThis.document;
	globalThis.window = dom.window;
	globalThis.document = dom.window.document;

	const requests = [];
	globalThis.fetch = async (url, options = {}) => {
		const method = options.method ?? "GET";
		const body = options.body === undefined ? undefined : JSON.parse(options.body);
		requests.push({ url, method, body });
		const path = String(url).replace(/^.*\/api\/dsh-unity-agent/, "") || "/state";
		const { status, json } = await callApi(harness.handler, { method, url: `/api/dsh-unity-agent${path}`, body });
		return {
			ok: status >= 200 && status < 300,
			status,
			async json() {
				return json;
			},
		};
	};

	let definition;
	dom.window.__ModuleLoader__ = {
		load: (value) => {
			definition = value;
		},
	};
	new Function(source)();

	assert.notEqual(definition, undefined, "client.js registered its module");
	assert.equal(definition.id, "dsh-unity-agent");

	const registered = { dictionaries: 0 };
	const module = definition.factory((specifier) => {
		if (specifier === "react") return React;
		throw new Error(`the bundle must not require ${specifier}`);
	});
	assert.deepEqual(module.inject, ["slots"]);

	let registration;
	const ctx = {
		effect: (fn, label) => {
			void label;
			const dispose = fn();
			return () => {
				try {
					dispose?.();
				} catch {
					/* disposal is best effort in the test too */
				}
			};
		},
		locale: {
			register: (ns, dictionaries) => {
				registered.namespace = ns;
				registered.dictionaries = dictionaries;
				return () => {};
			},
			bind: () => boundTranslator ?? ((key) => key),
		},
		slots: {
			inject: (key, callback) => {
				registered.slotKey = key;
				callback();
				return () => {};
			},
			register: (options, Component) => {
				registration = { options, Component };
				return () => {};
			},
		},
	};
	module.apply(ctx);
	assert.equal(registered.slotKey, "settings.section");
	assert.equal(registration.options.id, "dsh-unity-agent");
	assert.equal(typeof registration.options.label, "function");
	assert.equal(registered.namespace, "dsh-unity-agent");
	assert.ok(registered.dictionaries.zh.title.length > 0);

	const container = dom.window.document.getElementById("host");
	const root = createRoot(container);
	await act(async () => {
		root.render(React.createElement(registration.Component));
	});
	// The page loads its state in an effect; give the fetch chain time to settle.
	await act(async () => {
		await new Promise((resolve) => setTimeout(resolve, 10));
	});

	const flush = async () => {
		await act(async () => {
			await new Promise((resolve) => setTimeout(resolve, 10));
		});
	};
	/** Flush until `predicate` holds; request handling is asynchronous. */
	const waitFor = async (predicate, timeoutMs = 4000) => {
		const deadline = Date.now() + timeoutMs;
		for (;;) {
			if (predicate()) return true;
			if (Date.now() > deadline) return false;
			await act(async () => {
				await new Promise((resolve) => setTimeout(resolve, 20));
			});
		}
	};
	const click = async (label) => {
		const button = [...container.querySelectorAll("button")].find((element) => (element.textContent ?? "").includes(label));
		assert.notEqual(button, undefined, `button containing ${label} exists`);
		await act(async () => {
			button.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true }));
		});
		await flush();
	};
	const switches = () => [...container.querySelectorAll('button[role="switch"]')];
	const text = () => container.textContent ?? "";

	const unmount = async () => {
		await act(async () => {
			root.unmount();
		});
		dom.window.close();
		globalThis.window = previousWindow;
		globalThis.document = previousDocument;
		cleanup();
	};

	return { dom, container, root, requests, registration, registered, flush, waitFor, click, switches, text, unmount };
}

test("the section registers with the shell and renders the real state payload", async () => {
	const harness = makeServiceHarness({ skills: ["alpha", "beta", "gamma"] });
	const page = await mountClient(harness);
	assert.equal(page.requests[0].url.includes("/state"), true);
	assert.match(page.text(), /Unity 官方技能/);
	assert.match(page.text(), /已启用 3 \/ 共 3/);
	for (const name of ["alpha", "beta", "gamma"]) assert.match(page.text(), new RegExp(name));
	assert.match(page.text(), /Bundled alpha/);
	assert.equal(page.switches().length, 3);
	assert.deepEqual(
		page.switches().map((element) => element.getAttribute("aria-checked")),
		["true", "true", "true"],
	);
	// The provenance block shows the bundled snapshot the page is serving.
	assert.match(page.text(), /0\.1\.0/);
	assert.match(page.text(), /数据目录/);
	await page.unmount();
});

test("clicking a switch disables exactly that skill and survives a reload", async () => {
	const harness = makeServiceHarness({ skills: ["alpha", "beta", "gamma"] });
	const page = await mountClient(harness);
	const first = page.switches()[0];
	await act(async () => {
		first.dispatchEvent(new page.dom.window.MouseEvent("click", { bubbles: true }));
	});
	// The switch flips optimistically; wait for the request to have landed.
	assert.equal(await page.waitFor(() => harness.service.store.get().enabled.alpha === false), true);
	assert.equal(page.switches()[0].getAttribute("aria-checked"), "false");
	const posted = page.requests.find((request) => request.url.includes("/skill"));
	assert.notEqual(posted, undefined);
	assert.deepEqual(posted.body, { name: "alpha", enabled: false });
	assert.match(page.text(), /已启用 2 \/ 共 3/);
	// The choice is durable: it is in the state file, and the provider agrees.
	assert.deepEqual(
		(await harness.service.listCandidates()).map((skill) => skill.name),
		["beta", "gamma"],
	);
	await page.unmount();
});

test("the search box filters rows without touching state", async () => {
	const harness = makeServiceHarness({ skills: ["alpha", "beta", "gamma"] });
	const page = await mountClient(harness);
	const input = page.container.querySelector('input[type="search"]');
	assert.notEqual(input, null);
	// React 18 only reports a change through its own input plugin (the value
	// tracker ignores a raw `input` event), so the test uses Simulate.
	const { Simulate } = await import("react-dom/test-utils");
	await act(async () => {
		Simulate.change(input, { target: { value: "gamm" } });
	});
	assert.equal(await page.waitFor(() => page.switches().length === 1), true);
	assert.match(page.text(), /gamma/);
	assert.doesNotMatch(page.text(), /Bundled alpha/);
	// The counter still describes the whole catalog, not the filtered view.
	assert.match(page.text(), /已启用 3 \/ 共 3/);
	assert.equal(harness.service.store.get().enabled.alpha, undefined);
	// A query that matches nothing explains itself instead of showing an empty page.
	await act(async () => {
		Simulate.change(input, { target: { value: "zzz" } });
	});
	assert.equal(await page.waitFor(() => /没有匹配的技能/.test(page.text())), true);
	assert.equal(page.switches().length, 0);
	await page.unmount();
});

test("enable-all and disable-all go through one bulk request", async () => {
	const harness = makeServiceHarness({ skills: ["alpha", "beta"] });
	const page = await mountClient(harness);
	await page.click("全部禁用");
	assert.equal(await page.waitFor(() => page.switches().every((element) => element.getAttribute("aria-checked") === "false")), true);
	const bulk = page.requests.find((request) => request.url.endsWith("/skills"));
	assert.notEqual(bulk, undefined);
	assert.deepEqual(bulk.body, { enabled: false });
	assert.match(page.text(), /已启用 0 \/ 共 2/);
	await page.click("全部启用");
	assert.equal(await page.waitFor(() => page.switches().every((element) => element.getAttribute("aria-checked") === "true")), true);
	await page.unmount();
});

test("check reports an available update, and update shows the changelog", async () => {
	const harness = makeServiceHarness({ skills: ["alpha", "beta"] });
	harness.upstream.setSha(REMOTE_SHA);
	const page = await mountClient(harness);

	await page.click("检查更新");
	assert.equal(await page.waitFor(() => /上游有更新/.test(page.text())), true);
	const check = page.requests.find((request) => request.url.endsWith("/check"));
	assert.notEqual(check, undefined);
	assert.equal(check.method, "POST");
	assert.match(page.text(), /ccccccc/);

	harness.upstream.setSkills(["alpha", "beta", "delta"], "2.0.0");
	await page.click("立即更新");
	assert.equal(await page.waitFor(() => /新增 delta/.test(page.text())), true);
	const update = page.requests.find((request) => request.url.endsWith("/update"));
	assert.notEqual(update, undefined);
	assert.match(page.text(), /已启用 3 \/ 共 3/);
	assert.match(page.text(), /上游检出/);
	// The page can offer to go back to the bundled snapshot once a checkout exists.
	assert.match(page.text(), /恢复内置快照/);
	await page.unmount();
});

test("an unreachable upstream and a rejected action both surface as banners", async () => {
	const harness = makeServiceHarness({ remoteFails: true });
	const page = await mountClient(harness);
	await page.click("检查更新");
	assert.equal(await page.waitFor(() => /无法连接上游/.test(page.text())), true);
	assert.match(page.text(), /scripted network failure/);
	await page.unmount();

	const failing = makeServiceHarness({ cloneFails: true });
	const page2 = await mountClient(failing);
	await page2.click("立即更新");
	assert.equal(await page2.waitFor(() => /操作失败/.test(page2.text())), true);
	assert.match(page2.text(), /scripted clone failure/);
	// The skills are still listed and togglable after the failure.
	assert.equal(page2.switches().length, 2);
	await page2.unmount();
});

test("a backend that cannot be reached renders an error instead of a blank page", async () => {
	const harness = makeServiceHarness({});
	const page = await mountClient(harness);
	// Break the backend, then ask the page for state again through a toggle.
	globalThis.fetch = async () => {
		throw new Error("connection refused");
	};
	await page.click("全部禁用");
	assert.equal(await page.waitFor(() => /操作失败/.test(page.text())), true);
	assert.match(page.text(), /connection refused/);
	// The rows the page already had stay mounted.
	assert.ok(page.switches().length > 0);
	await page.unmount();
});

test("the shell's own translations win when the locale service resolves them", async () => {
	const harness = makeServiceHarness({ skills: ["alpha"] });
	const page = await mountClient(harness, {
		lang: "en",
		boundTranslator: (key) => `BOUND:${key}`,
	});
	assert.match(page.text(), /BOUND:title/);
	assert.equal(page.registration.options.label(), "BOUND:nav");
	assert.ok(page.registered.dictionaries.en.subtitle.length > 0);
	await page.unmount();
});
