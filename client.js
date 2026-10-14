/**
 * dsh-unity-agent — the browser half.
 *
 * Contributes one settings page (`settings.section`, id `dsh-unity-agent`) that
 * owns the repository's skills: a row per skill with an enable/disable switch,
 * and the upstream panel that checks and downloads the original Unity
 * repository.
 *
 * Hand-written ModuleLoader bundle, like the other settings-page plugins in
 * this profile: no build step, no dependency beyond the `react` the shell
 * already provides, and every colour from a `--dsw-alias-*` theme token so the
 * page survives a light/dark switch. All data comes from this plugin's own
 * same-origin `/api/dsh-unity-agent/*` routes, which the Host half serves.
 *
 * @module dsh-unity-agent/client
 */

window.__ModuleLoader__.load({
	id: "dsh-unity-agent",
	factory: (require) => {
		const React = require("react");
		const {
			createElement: h,
			useCallback,
			useEffect,
			useMemo,
			useRef,
			useState,
		} = React;

		/** Locale namespace for this plugin's copy. */
		const NS = "dsh-unity-agent";

		/** The Host mount, resolved against the page's base like the shell does. */
		const API = (() => {
			try {
				return new URL("api/dsh-unity-agent", document.baseURI).pathname;
			} catch {
				return "/api/dsh-unity-agent";
			}
		})();

		// ── copy ────────────────────────────────────────────────────────────────
		const DICT = {
			zh: {
				nav: "Unity 官方技能",
				title: "Unity 官方技能",
				subtitle:
					"Unity 官方 unity-agent-plugin 的技能包。单个技能开关即时生效；「检查更新」比对上游原仓库，「立即更新」把上游内容整份拉取到本机。",
				repoLink: "打开上游仓库",
				sectionSkills: "技能列表",
				sectionUpstream: "上游与更新",
				search: "搜索技能名或描述…",
				enableAll: "全部启用",
				disableAll: "全部禁用",
				counter: "已启用 {enabled} / 共 {total}",
				loading: "正在加载…",
				loadFailed: "无法连接插件后端",
				retry: "重试",
				check: "检查更新",
				checking: "检查中…",
				update: "立即更新",
				updating: "正在更新…",
				updateAvailable: "上游有更新",
				upToDate: "已是最新",
				reset: "恢复内置快照",
				resetting: "正在恢复…",
				current: "当前生效",
				sourceBundled: "内置快照",
				sourceUpstream: "上游检出",
				bundled: "内置快照",
				remote: "上游最新",
				lastCheck: "上次检查",
				lastUpdate: "上次更新",
				never: "从未",
				gitMissing: "未找到 git，无法检查或更新",
				unreachable: "无法连接上游：{error}",
				changelog: "更新内容",
				added: "新增",
				changed: "变更",
				removed: "移除",
				noChange: "内容没有变化",
				brokenTitle: "无法解析的技能（{count}）",
				enabledTag: "已启用",
				disabledTag: "已禁用",
				requiresPackage: "需要 {name}",
				requiresEditor: "需要编辑器 {version}",
				skillVersion: "技能 v{version}",
				dataDir: "数据目录",
				stateFile: "状态文件",
				errorPrefix: "操作失败：",
				saved: "已保存",
				confirmReset: "确定删除本机检出、回到包内置的快照吗？",
				emptySkills: "这里是空的：当前来源没有解析出任何技能。",
				emptySearch: "没有匹配的技能。",
			},
			en: {
				nav: "Unity Official Skills",
				title: "Unity Official Skills",
				subtitle:
					"Unity's official unity-agent-plugin skill pack. Each switch takes effect immediately; Check compares against the upstream repository and Update downloads its content onto this machine.",
				repoLink: "Open upstream repository",
				sectionSkills: "Skills",
				sectionUpstream: "Upstream and updates",
				search: "Search name or description…",
				enableAll: "Enable all",
				disableAll: "Disable all",
				counter: "{enabled} of {total} enabled",
				loading: "Loading…",
				loadFailed: "Cannot reach the plugin backend",
				retry: "Retry",
				check: "Check for updates",
				checking: "Checking…",
				update: "Update now",
				updating: "Updating…",
				updateAvailable: "An update is available",
				upToDate: "Up to date",
				reset: "Restore bundled snapshot",
				resetting: "Restoring…",
				current: "In use",
				sourceBundled: "bundled snapshot",
				sourceUpstream: "upstream checkout",
				bundled: "Bundled snapshot",
				remote: "Upstream tip",
				lastCheck: "Last check",
				lastUpdate: "Last update",
				never: "never",
				gitMissing: "git was not found, so updates cannot be checked or applied",
				unreachable: "Cannot reach upstream: {error}",
				changelog: "Changes",
				added: "Added",
				changed: "Changed",
				removed: "Removed",
				noChange: "No content changed",
				brokenTitle: "Unreadable skills ({count})",
				enabledTag: "enabled",
				disabledTag: "disabled",
				requiresPackage: "Needs {name}",
				requiresEditor: "Needs editor {version}",
				skillVersion: "skill v{version}",
				dataDir: "Data directory",
				stateFile: "State file",
				errorPrefix: "Failed: ",
				saved: "Saved",
				confirmReset: "Delete the local checkout and go back to the bundled snapshot?",
				emptySkills: "Nothing here: the current source produced no skills.",
				emptySearch: "No skill matches.",
			},
		};

		const CSS = `
.dua-page{display:flex;flex-direction:column;gap:16px;padding:4px 2px 28px;color:var(--dsw-alias-label-primary);font-size:13px;line-height:1.55}
.dua-head{display:flex;flex-direction:column;gap:6px}
.dua-title{margin:0;font-size:16px;font-weight:600}
.dua-sub{margin:0;color:var(--dsw-alias-label-secondary);max-width:74ch}
.dua-card{background:var(--dsw-alias-bg-layer-1);border:1px solid var(--dsw-alias-border-l1);border-radius:10px;padding:14px 16px;display:flex;flex-direction:column;gap:12px}
.dua-cardHead{display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap}
.dua-cardTitle{margin:0;font-size:14px;font-weight:600}
.dua-muted{color:var(--dsw-alias-label-secondary)}
.dua-mono{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:12px}
.dua-row{display:flex;gap:10px;align-items:baseline;flex-wrap:wrap}
.dua-grid{display:grid;grid-template-columns:auto 1fr;gap:6px 14px;align-items:baseline}
.dua-kv-key{color:var(--dsw-alias-label-secondary);white-space:nowrap}
.dua-kv-value{min-width:0;overflow-wrap:anywhere}
.dua-btn{appearance:none;font:inherit;cursor:pointer;border-radius:8px;padding:5px 12px;border:1px solid var(--dsw-alias-border-l1);background:transparent;color:var(--dsw-alias-label-primary);white-space:nowrap}
.dua-btn:hover:not(:disabled){border-color:var(--dsw-alias-border-l2)}
.dua-btnPrimary{background:var(--dsw-alias-brand-primary);border-color:var(--dsw-alias-brand-primary);color:#fff}
.dua-btnPrimary:hover:not(:disabled){filter:brightness(1.06)}
.dua-btn:disabled{opacity:.5;cursor:default}
.dua-badge{display:inline-flex;align-items:center;gap:4px;font-size:11px;line-height:18px;padding:0 7px;border-radius:999px;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-secondary);white-space:nowrap}
.dua-badgeOk{color:var(--dsw-alias-state-success-primary)}
.dua-badgeWarn{color:var(--dsw-alias-state-warn-primary)}
.dua-badgeErr{color:var(--dsw-alias-state-error-primary)}
.dua-list{display:flex;flex-direction:column}
.dua-item{display:flex;gap:14px;align-items:flex-start;padding:12px 2px;border-top:1px solid var(--dsw-alias-border-l1)}
.dua-item:first-child{border-top:none}
.dua-itemMain{min-width:0;flex:1;display:flex;flex-direction:column;gap:4px}
.dua-itemName{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.dua-name{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:12.5px;font-weight:600}
.dua-desc{margin:0;color:var(--dsw-alias-label-secondary);display:-webkit-box;-webkit-line-clamp:3;-webkit-box-orient:vertical;overflow:hidden}
.dua-off .dua-name,.dua-off .dua-desc{opacity:.55}
.dua-switch{position:relative;flex:0 0 auto;width:38px;height:22px;margin-top:2px;border-radius:999px;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-2);cursor:pointer;padding:0;transition:background .15s ease,border-color .15s ease}
.dua-switch[aria-checked="true"]{background:var(--dsw-alias-brand-primary);border-color:var(--dsw-alias-brand-primary)}
.dua-switch:disabled{opacity:.5;cursor:default}
.dua-knob{position:absolute;top:2px;left:2px;width:16px;height:16px;border-radius:50%;background:var(--dsw-alias-label-secondary);box-shadow:0 1px 2px rgba(0,0,0,.25);transition:transform .15s ease,background .15s ease}
.dua-switch[aria-checked="true"] .dua-knob{transform:translateX(16px);background:var(--dsw-alias-bg-base)}
.dua-search{appearance:none;font:inherit;color:inherit;background:var(--dsw-alias-bg-base);border:1px solid var(--dsw-alias-border-l1);border-radius:8px;padding:5px 10px;min-width:220px;flex:1}
.dua-search:focus{outline:none;border-color:var(--dsw-alias-border-l2)}
.dua-banner{display:flex;gap:8px;align-items:flex-start;border-radius:8px;padding:9px 12px;background:var(--dsw-alias-bg-layer-2);border:1px solid var(--dsw-alias-border-l1)}
.dua-bannerErr{border-color:var(--dsw-alias-state-error-primary);color:var(--dsw-alias-state-error-primary)}
.dua-bannerWarn{border-color:var(--dsw-alias-state-warn-primary)}
.dua-bannerOk{border-color:var(--dsw-alias-state-success-primary)}
.dua-chips{display:flex;gap:6px;flex-wrap:wrap}
.dua-chip{font-size:11.5px;padding:1px 8px;border-radius:999px;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-secondary)}
.dua-chipAdd{color:var(--dsw-alias-state-success-primary)}
.dua-chipChange{color:var(--dsw-alias-state-warn-primary)}
.dua-chipRemove{color:var(--dsw-alias-state-error-primary)}
.dua-actions{display:flex;gap:8px;flex-wrap:wrap;align-items:center}
.dua-link{color:var(--dsw-alias-brand-primary);text-decoration:none}
.dua-link:hover{text-decoration:underline}
.dua-toolbar{display:flex;gap:8px;align-items:center;flex-wrap:wrap}
.dua-broken{display:flex;flex-direction:column;gap:4px;font-size:12px}
`;

		// ── helpers ─────────────────────────────────────────────────────────────
		/** Fill `{name}` placeholders. */
		function fill(template, params) {
			return String(template).replace(/\{(\w+)\}/g, (whole, key) =>
				params !== undefined && params[key] !== undefined ? String(params[key]) : whole,
			);
		}

		function shortCommit(sha) {
			return typeof sha === "string" && sha.length > 7 ? sha.slice(0, 7) : sha;
		}

		function formatTime(value, language) {
			if (typeof value !== "string" || value === "") return undefined;
			const date = new Date(value);
			if (Number.isNaN(date.getTime())) return value;
			try {
				return date.toLocaleString(language === undefined || language === "" ? undefined : language);
			} catch {
				return date.toISOString();
			}
		}

		/**
		 * One API call. The Host answers `{ ok, error?, data }`; a transport
		 * failure or a non-JSON body is reported as an error instead of throwing
		 * into React, because a throwing component blanks the slot entry.
		 */
		async function api(path, options) {
			let response;
			try {
				response = await fetch(`${API}${path}`, {
					method: options?.method ?? "GET",
					headers: options?.body === undefined ? undefined : { "content-type": "application/json" },
					body: options?.body === undefined ? undefined : JSON.stringify(options.body),
					credentials: "same-origin",
				});
			} catch (error) {
				return { ok: false, error: String(error?.message ?? error) };
			}
			let payload;
			try {
				payload = await response.json();
			} catch {
				return { ok: false, error: `HTTP ${response.status}` };
			}
			if (payload === null || typeof payload !== "object") return { ok: false, error: `HTTP ${response.status}` };
			return { ...payload, status: response.status };
		}

		/** A two-state control: real `role="switch"` semantics and keyboard support. */
		function Switch({ checked, disabled, onToggle, label }) {
			return h(
				"button",
				{
					type: "button",
					className: "dua-switch",
					role: "switch",
					"aria-checked": checked ? "true" : "false",
					"aria-label": label,
					title: label,
					disabled: disabled === true,
					onClick: () => onToggle(!checked),
				},
				h("span", { className: "dua-knob" }),
			);
		}

		function Chip({ children, tone }) {
			const className = tone === "add" ? "dua-chip dua-chipAdd" : tone === "change" ? "dua-chip dua-chipChange" : tone === "remove" ? "dua-chip dua-chipRemove" : "dua-chip";
			return h("span", { className }, children);
		}

		/** Keep a render failure inside this page instead of blanking the slot. */
		class Boundary extends React.Component {
			constructor(props) {
				super(props);
				this.state = { error: null };
			}

			static getDerivedStateFromError(error) {
				return { error };
			}

			componentDidCatch(error) {
				try {
					// eslint-disable-next-line no-console
					console.error("dsh-unity-agent settings page crashed", error);
				} catch {
					/* logging is best effort */
				}
			}

			render() {
				if (this.state.error !== null) {
					return h(
						"div",
						{ className: "dua-page" },
						h(
							"div",
							{ className: "dua-banner dua-bannerErr" },
							h("span", null, `${this.props.fallbackPrefix ?? "Page error: "}${String(this.state.error?.message ?? this.state.error)}`),
						),
					);
				}
				return this.props.children;
			}
		}

		// ── the page ────────────────────────────────────────────────────────────
		function UnityAgentPage({ t, language }) {
			const [data, setData] = useState(null);
			const [error, setError] = useState(null);
			const [notice, setNotice] = useState(null);
			const [busy, setBusy] = useState(null);
			const [query, setQuery] = useState("");
			const [changelog, setChangelog] = useState(null);
			const alive = useRef(true);
			const busyRef = useRef(null);

			useEffect(() => {
				alive.current = true;
				return () => {
					alive.current = false;
				};
			}, []);

			const load = useCallback(async () => {
				const result = await api("/state");
				if (!alive.current) return;
				if (result.data !== undefined) setData(result.data);
				setError(result.ok === false && result.data === undefined ? result.error ?? t("loadFailed") : null);
			}, [t]);

			useEffect(() => {
				void load();
			}, [load]);

			/** Run one action with a busy key, folding the returned state back in. */
			const run = useCallback(
				async (key, path, body, onResult) => {
					if (busyRef.current !== null) return;
					busyRef.current = key;
					setBusy(key);
					setError(null);
					const result = await api(path, { method: "POST", body });
					busyRef.current = null;
					if (!alive.current) return;
					setBusy(null);
					if (result.data !== undefined) setData(result.data);
					if (result.ok === false && result.error !== undefined) {
						setError(result.error);
						// A failure that carried no state (transport error) would leave
						// the optimistic switch flipped; re-read the truth instead.
						if (result.data === undefined) void load();
					} else if (typeof onResult === "function") onResult(result);
				},
				[load],
			);

			const skills = (Array.isArray(data?.skills) ? data.skills : []).filter(
				(entry) => entry !== null && typeof entry === "object" && typeof entry.name === "string",
			);
			const broken = (Array.isArray(data?.broken) ? data.broken : []).filter(
				(entry) => entry !== null && typeof entry === "object",
			);
			const filtered = useMemo(() => {
				const needle = query.trim().toLowerCase();
				if (needle === "") return skills;
				return skills.filter(
					(skill) =>
						String(skill.name).toLowerCase().includes(needle) ||
						String(skill.description ?? "").toLowerCase().includes(needle),
				);
			}, [skills, query]);

			// Every field is read defensively: an older or newer Host may omit one,
			// and a render-time throw would blank this slot entry.
			const enabledCount = skills.filter((skill) => skill.enabled !== false).length;
			const upstream = data?.upstream ?? {};
			const pending = upstream.pending;
			const git = data?.git ?? {};
			const source = data?.plugin?.source;
			const remoteReachable = upstream.remote?.reachable !== false;
			const repoUrl = (() => {
				const url = upstream.url;
				if (typeof url !== "string") return null;
				const trimmed = url.replace(/\.git$/, "");
				return /^https?:\/\//i.test(trimmed) ? trimmed : null;
			})();
			const changelogLists = {
				added: Array.isArray(changelog?.added) ? changelog.added : [],
				changed: Array.isArray(changelog?.changed) ? changelog.changed : [],
				removed: Array.isArray(changelog?.removed) ? changelog.removed : [],
			};

			const toggleSkill = useCallback(
				(skill, next) => {
					setData((current) =>
						current === null
							? current
							: { ...current, skills: current.skills.map((entry) => (entry.name === skill.name ? { ...entry, enabled: next } : entry)) },
					);
					void run(`skill:${skill.name}`, "/skill", { name: skill.name, enabled: next });
				},
				[run],
			);

			if (data === null) {
				// A first load that failed must say so and offer a retry; showing
				// "loading" forever is the one state a user cannot act on.
				if (error === null) return h("div", { className: "dua-page" }, h("div", { className: "dua-muted" }, t("loading")));
				return h(
					"div",
					{ className: "dua-page" },
					h("div", { className: "dua-banner dua-bannerErr" }, h("span", null, `${t("loadFailed")}：${error}`)),
					h(
						"div",
						{ className: "dua-actions" },
						h("button", { type: "button", className: "dua-btn", onClick: () => void load() }, t("retry")),
					),
				);
			}

			return h(
				"div",
				{ className: "dua-page" },
				h(
					"div",
					{ className: "dua-head" },
					h("h2", { className: "dua-title" }, t("title")),
					h("p", { className: "dua-sub" }, t("subtitle")),
					h(
						"div",
						{ className: "dua-actions" },
						repoUrl !== null
							? h("a", { className: "dua-link", href: repoUrl, target: "_blank", rel: "noreferrer" }, t("repoLink"))
							: null,
						h("span", { className: "dua-badge" }, `${skills.length} skills`),
					),
				),

				error !== null
					? h("div", { className: "dua-banner dua-bannerErr" }, h("span", null, `${t("errorPrefix")}${error}`))
					: null,
				notice !== null ? h("div", { className: "dua-banner dua-bannerOk" }, h("span", null, notice)) : null,

				// ── upstream ───────────────────────────────────────────────────────
				h(
					"section",
					{ className: "dua-card" },
					h(
						"div",
						{ className: "dua-cardHead" },
						h("h3", { className: "dua-cardTitle" }, t("sectionUpstream")),
						h(
							"div",
							{ className: "dua-actions" },
							h(
								"button",
								{
									type: "button",
									className: "dua-btn",
									disabled: busy !== null,
									onClick: () => void run("check", "/check", {}),
								},
								busy === "check" ? t("checking") : t("check"),
							),
							h(
								"button",
								{
									type: "button",
									className: pending?.available === true ? "dua-btn dua-btnPrimary" : "dua-btn",
									disabled: busy !== null,
									onClick: () =>
										void run("update", "/update", {}, (result) => {
											setChangelog(result.changelog ?? null);
											const count =
												(result.changelog?.added?.length ?? 0) +
												(result.changelog?.changed?.length ?? 0) +
												(result.changelog?.removed?.length ?? 0);
											setNotice(count === 0 ? t("noChange") : undefined);
										}),
								},
								busy === "update" ? t("updating") : t("update"),
							),
							upstream.checkout?.present === true
								? h(
										"button",
										{
											type: "button",
											className: "dua-btn",
											disabled: busy !== null,
											onClick: () => {
												if (window.confirm(t("confirmReset")) !== true) return;
												void run("reset", "/reset", {}, (result) => setChangelog(result.changelog ?? null));
											},
										},
										busy === "reset" ? t("resetting") : t("reset"),
									)
								: null,
						),
					),

					git.available === false
						? h("div", { className: "dua-banner dua-bannerErr" }, h("span", null, t("gitMissing")))
						: null,
					upstream.remote?.reachable === false && upstream.remote?.error !== undefined
						? h("div", { className: "dua-banner dua-bannerWarn" }, h("span", null, fill(t("unreachable"), { error: upstream.remote.error })))
						: null,
					pending !== undefined && pending !== null && pending.available === true
						? h(
								"div",
								{ className: "dua-banner dua-bannerOk" },
								h("span", null, `${t("updateAvailable")} — ${shortCommit(pending.remote) ?? ""}`),
							)
						: pending !== undefined && pending !== null && pending.available === false && remoteReachable
							? h("div", { className: "dua-banner" }, h("span", null, t("upToDate")))
							: null,

					h(
						"div",
						{ className: "dua-grid" },
						h("span", { className: "dua-kv-key" }, t("current")),
						h(
							"span",
							{ className: "dua-kv-value" },
							`${source === "upstream" ? t("sourceUpstream") : t("sourceBundled")}`,
							upstream.checkout?.usable === true && source === "upstream"
								? ` · ${upstream.checkout.version ?? ""} ${shortCommit(upstream.checkout.commit) ?? ""}`
								: ` · ${upstream.bundled?.version ?? ""} ${shortCommit(upstream.bundled?.commit) ?? ""}`,
						),
						h("span", { className: "dua-kv-key" }, t("bundled")),
						h(
							"span",
							{ className: "dua-kv-value dua-mono" },
							`${upstream.bundled?.version ?? "—"} @ ${shortCommit(upstream.bundled?.commit) ?? "—"} · ${upstream.bundled?.skills ?? 0} skills`,
						),
						h("span", { className: "dua-kv-key" }, t("remote")),
						h(
							"span",
							{ className: "dua-kv-value dua-mono" },
							upstream.remote?.sha !== undefined
								? `${shortCommit(upstream.remote.sha)} · ${formatTime(upstream.remote.checkedAt, language) ?? ""}`
								: t("never"),
						),
						h("span", { className: "dua-kv-key" }, t("lastUpdate")),
						h(
							"span",
							{ className: "dua-kv-value dua-mono" },
							upstream.lastUpdateAt !== undefined
								? `${shortCommit(upstream.lastUpdateCommit) ?? "—"} · ${formatTime(upstream.lastUpdateAt, language) ?? ""}`
								: t("never"),
						),
						h("span", { className: "dua-kv-key" }, t("dataDir")),
						h("span", { className: "dua-kv-value dua-mono" }, data?.plugin?.dataDir ?? "—"),
						h("span", { className: "dua-kv-key" }, t("stateFile")),
						h("span", { className: "dua-kv-value dua-mono" }, data?.plugin?.stateFile ?? "—"),
					),

					changelog !== null
						? h(
								"div",
								{ className: "dua-muted" },
								h("div", null, `${t("changelog")}: ${shortCommit(changelog.from) ?? "—"} → ${shortCommit(changelog.to) ?? "—"}`),
								h(
									"div",
									{ className: "dua-chips" },
									changelogLists.added.map((item) => h(Chip, { key: `a-${item}`, tone: "add" }, `${t("added")} ${item}`)),
									changelogLists.changed.map((item) => h(Chip, { key: `c-${item}`, tone: "change" }, `${t("changed")} ${item}`)),
									changelogLists.removed.map((item) => h(Chip, { key: `r-${item}`, tone: "remove" }, `${t("removed")} ${item}`)),
								),
							)
						: null,
				),

				// ── skills ─────────────────────────────────────────────────────────
				h(
					"section",
					{ className: "dua-card" },
					h(
						"div",
						{ className: "dua-cardHead" },
						h("h3", { className: "dua-cardTitle" }, `${t("sectionSkills")} · ${fill(t("counter"), { enabled: enabledCount, total: skills.length })}`),
						h(
							"div",
							{ className: "dua-actions" },
							h(
								"button",
								{ type: "button", className: "dua-btn", disabled: busy !== null, onClick: () => void run("all-on", "/skills", { enabled: true }) },
								t("enableAll"),
							),
							h(
								"button",
								{ type: "button", className: "dua-btn", disabled: busy !== null, onClick: () => void run("all-off", "/skills", { enabled: false }) },
								t("disableAll"),
							),
						),
					),
					h("input", {
						className: "dua-search",
						type: "search",
						placeholder: t("search"),
						value: query,
						onChange: (event) => setQuery(event.target.value),
					}),

					broken.length > 0
						? h(
								"div",
								{ className: "dua-banner dua-bannerWarn dua-broken" },
								h("strong", null, fill(t("brokenTitle"), { count: broken.length })),
								broken.map((item) => h("span", { className: "dua-mono", key: `broken-${item.name}` }, `${item.name ?? "?"} — ${item.reason ?? ""}`)),
							)
						: null,

					skills.length === 0
						? h("div", { className: "dua-muted" }, t("emptySkills"))
						: h(
								"div",
								{ className: "dua-list" },
								filtered.length === 0
									? h("div", { className: "dua-muted" }, t("emptySearch"))
									: filtered.map((skill) => {
											// The Host treats an absent flag as enabled; render the
											// same way instead of showing a healthy skill as off.
											const on = skill.enabled !== false;
											const packages =
												skill.requiredPackages !== null && typeof skill.requiredPackages === "object" && !Array.isArray(skill.requiredPackages)
													? Object.keys(skill.requiredPackages)
													: [];
											return h(
												"div",
												{ className: on ? "dua-item" : "dua-item dua-off", key: skill.name },
												h(
													"div",
													{ className: "dua-itemMain" },
													h(
														"div",
														{ className: "dua-itemName" },
														h("span", { className: "dua-name" }, skill.name),
														h("span", { className: "dua-badge" }, on ? t("enabledTag") : t("disabledTag")),
														skill.skillVersion !== undefined ? h("span", { className: "dua-badge" }, fill(t("skillVersion"), { version: skill.skillVersion })) : null,
														skill.requiredEditorVersion !== undefined
															? h("span", { className: "dua-badge" }, fill(t("requiresEditor"), { version: skill.requiredEditorVersion }))
															: null,
														packages.map((packageName) =>
															h("span", { className: "dua-badge", key: `${skill.name}-${packageName}` }, fill(t("requiresPackage"), { name: packageName })),
														),
													),
													h("p", { className: "dua-desc" }, skill.description ?? ""),
												),
												h(Switch, {
													checked: on,
													disabled: busy !== null,
													label: `${on ? t("enabledTag") : t("disabledTag")} ${skill.name}`,
													onToggle: (next) => toggleSkill(skill, next),
												}),
											);
										}),
							),
				),
			);
		}

		/** Keep the section inside an error boundary and inject its translator. */
		function Page(props) {
			const { t, language } = props;
			return h(Boundary, { fallbackPrefix: t("errorPrefix") }, h(UnityAgentPage, { t, language }));
		}

		/** Bind the shell's locale service when it is present. */
		function bindLocale(ctx) {
			try {
				const translator = ctx.locale?.bind?.(NS);
				return typeof translator === "function" ? translator : null;
			} catch {
				return null;
			}
		}

		return {
			inject: ["slots"],
			apply(ctx) {
				try {
					if (typeof ctx.locale?.register === "function") {
						ctx.effect(() => ctx.locale.register(NS, { zh: DICT.zh, en: DICT.en }), "dsh-unity-agent: dictionaries");
					}
				} catch {
					/* an older shell without the locale service still renders */
				}

				try {
					ctx.effect(() => {
						const style = document.createElement("style");
						style.setAttribute("data-plugin", "dsh-unity-agent");
						style.textContent = CSS;
						document.head.appendChild(style);
						return () => style.remove();
					}, "dsh-unity-agent: styles");
				} catch {
					/* a missing document (headless lint) must not break activation */
				}

				ctx.slots.inject("settings.section", () => {
					const language = String(document?.documentElement?.lang ?? "");
					const bound = bindLocale(ctx);
					const local = language.toLowerCase().startsWith("en") ? DICT.en : DICT.zh;
					// Resolved once per registration: the shell re-registers this
					// section on a locale change, which re-reads the bound strings.
					const resolved = (key, params) => {
						let template = local[key];
						if (bound !== null) {
							const value = bound(key);
							// A translator that echoes the key has no entry for it —
							// keep the plugin's own dictionary rather than showing keys.
							if (typeof value === "string" && !(value === key && local[key] !== undefined)) template = value;
						}
						if (template === undefined) template = DICT.zh[key];
						return params === undefined ? template : fill(template, params);
					};
					const Section = () => h(Page, { t: resolved, language });
					return ctx.slots.register(
						{
							name: "settings.section",
							id: "dsh-unity-agent",
							order: 22,
							label: () => resolved("nav"),
						},
						Section,
					);
				});
			},
		};
	},
});
