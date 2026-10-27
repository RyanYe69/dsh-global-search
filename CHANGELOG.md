## 1.1.9 — 2026-10-27

- **Fix: a killed install left residue that makes the next install look stuck.** A pnpm run that
  is killed (app restart, window closed) leaves three shapes in `node_modules`, and the next
  install spends its run on them instead of finishing: `<pkg>_tmp_<pid>_<n>` staging dirs, the
  same dirs demoted to `.ignored/`, and a half-copied package dir with no `package.json`.
  Evidence from `profiles/desktop/.plugin-manager/logs/`: the 08:23 and 08:24 runs stop after
  `Packages: +1 -58` with no `Done` (08:24 even prints
  `Moving dsh-global-search_tmp_6696_12 to "node_modules\.ignored\..."`), while the 08:31 run
  prints `+ dsh-global-search 1.1.8` / `Done in 1s`.
- **Install pre-flight**: `install.mjs` scans those three shapes and clears them before pnpm ever
  runs (`installer residue` records `OK` / `CLEANED` / `WOULD`). A directory install (`link:`)
  keeps its legitimate link and only clears staging dirs.
- **Uninstall sweeps them too**, so uninstall → reinstall no longer inherits the leftovers.
- **The plugin now clears its own leftovers at startup** (`installer.residue.cleaned` in the log),
  which is what makes the *installer UI* path recover: a killed install no longer poisons the
  next one, because the next successful boot removes the staging dirs first. It only acts when it
  is running from `<profile>/node_modules/dsh-global-search`, never from a source checkout, and it
  skips the sweep while `.plugin-manager/run.json` records an operation in flight.
- New `lib/residue.js`: read-only scan plus safe removal that **never follows a reparse point**.
  On Windows a junction is indistinguishable from a real directory (`isSymbolicLink()` is false and
  the inode matches), so removal tries `rmdir` first — which deletes a junction and never its
  target — and only falls back to a recursive delete for a directory that survives it. A directory
  holding a readable `package.json` is an installed package and is never touched.
- New `tools/test-residue.mjs` (11 checks) wired into `npm test`.

## 1.1.8 — 2026-10-26

- **Fix: the settings page rendered nothing, in both shapes.** Live evidence from the running
  app: the two hook-using entries sat at `active:false` and their component bodies were entered
  41 times (`client.mounted {surface:"panel-enter"}`) while their effects never ran and no error
  was thrown; the hook-free diagnostic entry registered into the same slot was `active:true`.
  The settings page is now written with **zero hooks** (`SettingsPage` / `renderSettingsPage`):
  DOM event handlers call the host and patch one output node, so no re-render is needed.
- **One entry instead of three.** The A/B pair and the temporary diagnostic page are removed;
  `settings.section` carries a single `外网搜索 (Google)` page, and the plugin card and bundle
  card render the same hook-free page.
- The composer chip keeps the rich `Panel` card — that surface renders correctly with hooks and
  is the fastest way in; the settings page needs no React runtime features at all.
- New client test: the settings-page source region is scanned and fails if any React hook
  reappears in it.

# Changelog

All notable changes to `dsh-global-search`. Versions follow SemVer; the `dsh:` block
in `package.json` (bundle patch + client platform) is part of the public surface.

## 1.1.2 — 2026-10-26

### Fixed

- 设置面板在真实页面里显示「渲染失败」（用户报告）。现场证据：客户端条目
  `settings.section#dsh-global-search` 的 `active` 已是 `true`，说明模块加载与注册都成功，
  抛错发生在**渲染阶段**。
- 根因：客户端半边用了 `class ErrorBoundary extends React.Component` 与 `useCallback`。动态
  Client bundle 文档化的入口只有 `createElement / useState / useEffect`（Cordis Inspect
  `client/Builtin` 实测），而当时那份假 React 测试把这些成员都塞了进去，于是"测试全绿、
  页面照崩"——这正是最该被测试挡住的一类回归。
- 客户端半边现在不含任何 class 组件，只用文档化的三个入口；面板与开关的渲染都包在
  `try/catch` 里，失败时显示错误文本并提示"已写入日志"，不再是空白卡片。

### Added

- `POST /dsh-global-search/client-error`：页面渲染异常经由插件自己的同源路由回传，写入
  `log.jsonl` 的 `client.render-error` 事件（message / 前 800 字符 stack / 页面 URL）。
  浏览器控制台上的错误从此在宿主侧可查，不必再让用户手抄。
- 客户端测试升级为「表面约束」：假 React 故意**不提供** `Component` / `useCallback` /
  `useRef`；源码剥掉注释后扫描所有 `React.*` 引用必须落在白名单内；断言 `status` 尚未
  到达时面板也必须渲染出四步引导与 key 输入框。
- 宿主测试新增：`client-error` 接受上报、拒绝 GET（405），且上报内容确实落到 `log.jsonl`。

### Tests

```
node tools/test-client.mjs   → client: 21 passed, 0 failed
node tools/test-unit.mjs     → unit:   45 passed, 0 failed
node tools/test-host.mjs     → host:   75 passed, 0 failed
```

## 1.1.1 — 2026-10-26

### Fixed
- 设置入口在真实 Web UI 里找不到（用户报告）：
  - 实测用 Cordis Inspect 读到 `settings.section` 的占位是 `{id:"dsh-global-search", active:false}` —— 注册存在但从未挂载，导航里点不到。
  - 旧版只注册了原生 `settings.section`，而当前使用的 Web UI 设置页是插件列表式（`web-ui.plugin.item`），插件在里面没有卡片，等于"没有入口"。
- 现在一份面板注册到三个面：`settings.section`（原生导航，order 16，紧跟"插件"）、`web-ui.plugin.item`（Web UI 设置→插件列表卡片）、`plugins.bundle.config`（设置→插件→本包页面卡片）。
- 输入框开关的注册 id 改为 `dsh-global-search-switch`，避免与设置页共用同一个 id。
- 面板外包一层 `ErrorBoundary`：渲染出错时显示错误文本，而不是留一张空白卡片。

### Added
- 面板顶部"接入步骤（约 1 分钟，免费）"四步引导：打开 serper.dev → 注册 → 复制 key → 粘贴保存并测试。
- `tools/test-client.mjs`（16 项）：用真实的 `window.__ModuleLoader__.load` 缝隙 + 假 React 载入客户端模块，断言 4 个注册面、id 不冲突、label 是 thunk、每个组件体各渲染一次不抛错。

## 1.0.2 — 2026-10-26

- `status.version` now reads `package.json` instead of restating it in code. The 1.0.1
  build reported 1.0.0 while running 1.0.1 code — caught by comparing the live status
  endpoint against the installed package, which is exactly what the acceptance run does.

## 1.0.1 — 2026-10-26

Fix found during live installation, not by the test suite:

- The `google_search` tool declared `output.schema = { type: 'json' }`, which is not a
  valid JSON-Schema type. `ctx.tools.register` rejected it, plugin activation aborted
  right after tool registration, and the balance warm-up never ran — so the settings
  page showed a configured key with "unknown" quota and no tool. The output schema is
  now a real JSON-Schema string and the tool returns the model-facing text directly.
- The `/settings` toggle now logs the caller's user-agent, origin and referer, so a
  switch change made by something other than this plugin's own UI is identifiable.

## 1.0.0 — 2026-10-26

First version that does one thing completely: **Google search through the user's own
free SERP key**, with a switch the user controls and the model deciding when to spend
a credit.

### Added

- **Settings page** (`settings.section`, id `dsh-global-search`, label 「外网搜索」):
  paste/replace/clear the key, toggle Google, read and refresh the remaining quota,
  run a live connection test, and see the runtime state plus the log path. The page
  explains how to get a free key and links to the provider.
- **Model-facing `google_search` tool**, registered only while Google is on *and* a
  key exists — turning the switch off removes the capability instead of failing calls
  later. Its description teaches the cost model, so the model spends a credit only
  when Google's index actually matters.
- **System-prompt section** carrying the live quota and the "when to use / when not to
  use" rules, so the model's judgment is informed rather than guessed.
- **Per-turn quota tracking**: after every `turn/end` the plugin reads
  `GET https://google.serper.dev/account` once and stores `balance` + `rateLimit`.
  Concurrent reads are coalesced; unrelated session events never trigger a read.
- **Provider registry for 5 free SERP APIs** (serper, searchapi, serpapi, zenserp,
  valueserp). Only serper's balance endpoint is implemented, because it is the only
  one measured; the others honestly report "no balance endpoint" in the UI.
- `install.mjs --google-key` seeds a key into the plugin data directory (never into the
  package or the profile).
- `tools/test-unit.mjs` (45 assertions) and `tools/test-host.mjs` (69 assertions)
  driving the real `apply()` against a mock Cordis context.
- Self-cleaning upgrade: files produced by 0.6.0 (node snapshot, kernel verdict) are
  deleted on first activation, and `state.json` keeps only known fields.

### Changed

- The composer switch is now **「Google 搜索 · 开/关」** instead of the old
  「外网搜索 · 自动/外网」 mode toggle. Closed = Bing only, no credits.
- `web_search` routing no longer chases Google: non-CJK → Bing international index,
  CJK → Bing domestic index. Google is only ever reached through the explicit tool.
- Error classification kept and surfaced: DNS / reset / TLS / timeout / http / parse.

### Removed

- The whole bundled-tunnel subsystem (~1 500 lines): mihomo kernel download with mirror
  fallback and parallel range fetching, 4-subscription aggregation, `url-test` +
  `generate_204` health checks, 6-hour refresh, the dependency-free trojan / vless /
  shadowsocks clients, and the local proxy supervisor. Measured on the target host:
  16 of 16 kernel mirrors unreachable, 0 of 946 free nodes passed a strict 204 check.
  Shipping it only produced log noise and a 731 KB node snapshot.
- The DuckDuckGo channel (reachable only through that dead tunnel).
- The public-SearXNG fleet with engine-attribution checks (reachable instances returned
  no results or another engine's results).
- Local-egress detection and reuse (it worked, but Google answers with a JS-only shell
  through any egress, so the route could never return results).
- The `mode` / `tunnel` / `bootstrap` state fields, `locale/` (unused), 14 one-off
  probe scripts, and 3 stale tarballs.

## 0.6.0 — 2026-10-26

- Four-route Google channel (free key → existing local proxy → Google direct → public
  SearXNG) on top of the Bing indexes, with per-route cooldowns.
- Fixed 6 real defects in the tunnel's node sourcing (inline YAML proxies, multiple
  `proxies:` headers, missing vless/ss clients, subscription mirrors that skip the
  GitHub API quota, 150-way liveness sweep, full loopback listener enumeration).
- First successful egress to Google (`generate_204` → 204), then the finding that Google
  serves a JS-only shell to every non-browser client.
- `install.mjs --from <tarball>` end-to-end verification.

## 0.5.0 — 2026-10-26

- Google channel module with 4 routes and error classification; tarball end-to-end
  install/uninstall verification in an isolated `DSH_HOME`.

## 0.3.0 — 2026-10-25

- Self-contained bundle: provider registration, tunnel supervisor, composer switch,
  structured JSONL logs, install/uninstall scripts, acceptance report A1–A12 / U1–U9.

## 0.2.0 — 2026-10-25

- Merged the earlier "plugin + external bridge + third-party search plugin" setup into a
  single self-contained plugin.
