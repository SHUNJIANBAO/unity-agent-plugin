# dsh-unity-agent

把 Unity 官方技能仓库 [Unity-Technologies/unity-agent-plugin](https://github.com/Unity-Technologies/unity-agent-plugin)
整体接进 DeepSeek Harness：**一个独立设置页**列出全部 Unity 技能，逐个启用/禁用；**「检查更新」**比对上游原仓库，
**「立即更新」**把上游内容整份拉取到本机。

本文件描述的是**本 fork 相对上游新增的那部分**（即 DSH 插件），位于仓库根目录；
仓库其余内容（`skills/`、`.claude-plugin/`、`.codex-plugin/`、`scripts/`、`assets/`、上游 `README.md`、
GitHub 工作流、`LICENSE.md`）都保持上游原样，**技能内容始终以上游 `main` 分支为准**。
上游插件给 Claude Code / Codex / Grok 的装法与说明见上游 `README.md`。

## 它是怎么工作的

```
┌─ 设置页（浏览器半身 client.js） ────────────────────────────────┐
│  技能开关 / 检查更新 / 立即更新 / 恢复内置快照                    │
└───────────────┬────────────────────────────────────────────────┘
                │ 同源 fetch
                ▼
┌─ /api/dsh-unity-agent/*（宿主半身 index.js + lib/） ────────────┐
│  lib/service.js   目录 + 状态 + 更新编排                         │
│  lib/catalog.js   读 skills/<name>/SKILL.md（frontmatter 解析）  │
│  lib/upstream.js  git ls-remote 检查 / 浅克隆 + 原子换目录        │
│  lib/store.js     $DSH_HOME/unity-agent-plugin/state.json       │
└───────────────┬────────────────────────────────────────────────┘
                │ ctx.skills.registerProvider(...)
                ▼
        DSH 技能注册表 —— 只有「已启用」的技能会出现在模型目录和 `/` 菜单里
```

技能有两个来源，优先级从高到低：

1. **上游检出**：`$DSH_HOME/unity-agent-plugin/upstream/`，由「立即更新」从上游 `main` 分支浅克隆而来；
2. **内置快照**：本包自带的 `skills/`（= fork 当前锁定的上游内容）。

没有检出时用内置快照，所以**装完即可用、离线也能用**；更新只是把 1 建起来并切过去。

### 更新语义

- **检查更新**：`git ls-remote --heads <repo> refs/heads/main`，把上游 tip 的 commit 与当前生效的 commit 比较。
  这一步不下载、不建目录，秒级返回；结果是「有更新 / 已是最新 / 无法连接（附原因）」。
- **立即更新**：`git clone --depth 1 --single-branch --branch main` 到 `upstream.new-<时间戳>`，
  校验新目录里确有可用 `skills/` 之后，**先改名再切换**（旧目录 → `upstream.old-*`，新目录 → `upstream/`，随后清理）。
  任何一步失败都会保留原有可用的目录 —— 不会出现「更新失败导致技能全没了」。
- **更新内容（changelog）**：对更新前后的两棵技能树逐个技能做内容指纹（sha256），
  因此能明确列出**新增 / 变更 / 移除**了哪些技能，而不是只知道 commit 变了。
- **恢复内置快照**：删掉本机检出，回到包自带的快照。
- 更新只影响**内容**（`skills/`），不影响插件代码；插件自身的升级走正常的插件安装/更新流程。

### 启用/禁用语义

- 状态存在 `$DSH_HOME/unity-agent-plugin/state.json` 的 `enabled` 字段，跨会话、跨重启保留。
- 被禁用的技能**不会**交给 `ctx.skills`：模型技能目录和 `/` 菜单里都不会出现，不是「只隐藏 UI」。
- 新技能默认启用（上游新增技能无需手动打开）。
- 优先级 rank = 350：高于用户级 `~/.dsh/skills`（400），低于项目级（100–200），项目始终能覆盖本插件。

## 安装

在 DSH 桌面端里，用插件管理器的「添加插件」或在会话中让 `plugin_manager` 执行 `install_bundle`，
目标填本仓库地址：

```
github:SHUNJIANBAO/unity-agent-plugin
```

本地开发时也可以直接指向包目录：

```
plugin_manager(install_bundle, target: "C:/Users/Admin/Desktop/Plugins/dsh-unity-agent")
```

安装后**完全重启客户端**（宿主半身按 ESM 路径缓存），然后在 **设置 → Unity 官方技能** 里就能看到分页。

## 配置（可选）

在 profile 的 `cordis.patch.yml` 里给这一行加 `config` 即可，未提供的键都有默认值：

| 键 | 默认值 | 含义 |
|---|---|---|
| `dshHome` | `$DSH_HOME` 或 `~/.dsh` | 数据目录的根 |
| `dataDir` | `<dshHome>/unity-agent-plugin` | 检出与状态文件的存放目录 |
| `upstreamUrl` | Unity 官方仓库 | 改成自己的镜像时用 |

```yaml
- id: dsh-unity-agent
  name: 'dsh-unity-agent'
  config:
    upstreamUrl: https://github.com/Unity-Technologies/unity-agent-plugin.git
```

## 目录与文件

| 路径 | 内容 |
|---|---|
| `index.js` | 宿主半身入口：注册技能提供方 + 挂载 `/api/dsh-unity-agent` |
| `client.js` | 浏览器半身：`window.__ModuleLoader__` 手写 bundle，注册 `settings.section` 分页 |
| `lib/` | frontmatter 解析、目录、状态、上游、信任围栏、HTTP 路由 |
| `skills/` | 内置的上游技能快照（由 `dev/stamp-upstream.mjs` 盖章） |
| `upstream.json` | 内置快照的来源：仓库、分支、commit、上游插件版本 |
| `$DSH_HOME/unity-agent-plugin/upstream/` | 「立即更新」拉下来的上游检出 |
| `$DSH_HOME/unity-agent-plugin/state.json` | 启用/禁用状态 + 上次检查/更新结果 |

依赖：**零运行时依赖**，不声明 `@deepseek-ai/*` peerDependencies，浏览器半身只用 shell 自带的 `react`。
`git` 是运行期唯一的外部要求（检查/更新用；不做这两件事时完全不需要它）。

## 开发

```bash
node test/run-all.mjs        # 83 项离线回归（frontmatter/store/catalog/upstream/api/provider/client）
node dev/stamp-upstream.mjs <上游检出路径>   # 刷新内置快照的 provenance
```

`test/frontmatter.test.mjs` 需要 `js-yaml`（仅 devDependency，通过
`npm install --no-save --no-package-lock js-yaml@4` 安装；不进 `files`，不进运行时）。它把
`lib/frontmatter.js` 的解析结果与真实 YAML 解析器在**全部 32 个内置技能**上逐字段比对 ——
DSH 的注册表对 candidate/definition 校验很严格，解析错一个字段就会让技能静默消失。

`test/client.test.mjs` 用 jsdom 挂载真实浏览器半身，请求打到真实的 `createApiHandler`（只把上游网络换成脚本），覆盖开关、批量、搜索、检查/更新、失败提示。`test/upstream.test.mjs` 既覆盖脚本化的失败路径（连不上、克隆失败、上游没有 skills/），
也用**本机真实 git + 本地 origin 仓库**跑一遍「检查 → 安装 → 再检查 → 再安装」，不依赖网络。

## 已知边界

- 检查更新只报「上游 commit 与当前生效 commit 是否一致」，**不预告**具体会新增哪些技能；
  精确的 changelog 在更新完成时给出（此时两棵树都在本机，指纹可比）。
- 上游的插件版本号（`.claude-plugin/plugin.json`）只有在下载后才知道，检查阶段只能显示 commit。
- 便携性：更新依赖 `git`；没有 `git` 时页面会明确提示，内置快照仍然照常工作。
- 本仓库的技能内容遵循 Unity 的 [Unity Companion License](UPSTREAM-LICENSE.md)；
  本插件的代码为 MIT。商标与品牌展示遵循 [Unity 品牌指南](https://unity.com/legal/branding-trademarks)。
