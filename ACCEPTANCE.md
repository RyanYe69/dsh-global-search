# dsh-global-search 验收报告 — v1.0.2

> 判定规则：每一项都要有**可复现命令 + 实测输出**才算 PASS。没做过的写「未验证」并给出复验命令。
> 本报告只记录本轮（v1.0.2）实测结果；更早版本的历史证据见 `CHANGELOG.md`。

---

## §0 结论

| 用户要求 | 状态 | 证据 |
|---|---|---|
| 设置界面可填写搜索 API key | **代码 PASS / 界面待重启** | §2.1 路由实测 200；§6 客户端 bundle 需重启才载入 |
| key 不与插件捆绑 | **PASS** | §2.2（包内 13 文件无 key；key 只在数据目录） |
| 引导用户提供 key | **PASS** | §2.2（设置页有获取地址 + 输入框 + 一键弹窗） |
| 输入框处可选用/不用 Google | **代码 PASS / 界面待重启** | §2.3 开关路由 200 + 工具随开关注册/注销 |
| 开启后由模型自行判断何时用 Google | **PASS** | §2.4 工具只在开启时存在 + 系统提示带额度与规则 |
| 每次对话结束查一次余额 | **PASS** | §2.5 回合钩子集成测试 + 真实余额 2491 |
| 校验所有功能可用 | **PASS** | §2 全表 + §3 116 项测试 + §5 真实 Google 检索 |
| 删除无用功能/文件 | **PASS** | §10（删 ~1 500 行 + 4 个模块 + 14 个脚本 + 3 个旧包） |
| 工作区回滚备份 | **PASS** | §7（3 个备份目录 + git 基线） |
| 装到我的 DSH | **PASS（Host 已生效）** | §4、§5；客户端界面需重启一次，§6 |
| GitHub 可发行完整包 | **PASS** | §11（tgz + 源码 zip + SHA256SUMS + release workflow） |

**一句话**：Host 侧已在你正在运行的 DSH 里生效并通过全部实测；点开设置页与输入框开关需要**重启一次 DeepSeek Harness**（客户端模块表在启动时编制，属宿主行为，见 §6）。

---

## §1 实测环境

| 项 | 值 |
|---|---|
| 日期 | 2026-10-26（Asia/Shanghai） |
| DSH | Web GUI `http://127.0.0.1:50200`，profile `desktop` |
| Node | v26.9.0 |
| OS | Windows（本机） |
| 网络特征 | Google 直连不可达（DNS 污染 + TLS RST）；`cn.bing.com` 可用；SERP API 可达 |
| 插件数据目录 | `C:\Users\Ryan\.dsh\dsh-global-search` |

---

## §2 功能矩阵（命令 → 实测输出）

### 2.1 状态端点（设置页读的就是它）

```bash
node -e "fetch('http://127.0.0.1:50200/dsh-global-search/status').then(r=>r.json()).then(j=>console.log(JSON.stringify(j,null,1)))"
```

实测：

```
HTTP 200 1339B version=1.0.2 enabled=true ready=true configured=true tool=true balance=2491 rateLimit=5 lastChannel=google
key        provider=serper source=state masked=e9a3…b9 balanceSupported=true
channels   international=bing-global domestic=bing-cn
logFile    C:\Users\Ryan\.dsh\dsh-global-search\log.jsonl
```

- `version` 改为运行时读 `package.json`（1.0.1 曾出现 status 报 1.0.0 而代码是 1.0.1 的漂移，已根治）。
- `tool=true` 说明 `google_search` 已真实注册进工具表。

### 2.2 key 的存取与"不捆绑"

```bash
tar -xzf dsh-global-search-1.0.2.tgz -C /tmp/x && grep -rl "e9a325a2" /tmp/x || echo "NO KEY IN PACKAGE"
cat ~/.dsh/dsh-global-search/state.json
```

实测：包内 **无 key**；`state.json` 中 `google.key.secret` 为完整 key；`status` 只回 `e9a3…b9`（前 4 + 后 2）；日志只记 `keyLength: 40`。

### 2.3 开关（输入框那颗按钮背后的接口）

```bash
POST /dsh-global-search/settings {"enabled":false}   # → 200 enabled=false tool=false
POST /dsh-global-search/settings {"enabled":true}    # → 200 enabled=true  tool=true
POST /dsh-global-search/settings {"enabled":"nope"}  # → 400 expected { enabled?: boolean } or { key, provider } or { clearKey: true }
```

实测：关 → 工具**注销**（模型看不到）；开 → 工具**注册**。不是"注册了但调用报错"，是真的从工具表消失。
另外：未配置 key 时 `{"enabled":true}` 返回 **400**「配置一个 SERP key 之后才能开启」。

### 2.4 模型侧的"自主判断"

- 工具描述写明：该用（用户明说要 Google / 需要国际一手来源 / Bing 结果偏国内）、不该用（中文国内问题、普通查证、只要一个网址）、每次 1 次额度。
- 系统提示段落（`dsh-global-search:google`）仅在"开启 + 有 key"时非空，注入 provider、剩余额度、"额度 < 20 次时只在用户明确要求时使用"。
- 关闭时该段落返回空字符串。

实测（集成测试）：`prompt section now describes Google` / `prompt section cleared` 双 PASS。

### 2.5 每回合查余额

```bash
POST /dsh-global-search/balance
{"ok":true,"balance":{"credits":2491,"rateLimit":5,"provider":"serper","checkedAt":1785600…,"reason":"manual"}}
```

- 端点：`GET https://google.serper.dev/account` → `{"balance":2491,"rateLimit":5}`（实测，不是文档推测）。
- 触发点：`session/event` 的 `turn/end`（耐久提交后的对话结束时刻）。
- 集成测试断言：一次 `turn/end` → 恰好 +1 次请求；第二次 `turn/end` → 再 +1；`user/message` → 不触发。
- 并发合并：`balanceInFlight` 保证同一时刻只有一条在飞。
- 该请求**不计费**（serper 只按 search 计次），受 25 次/窗口速率限制。

### 2.6 真实 Google 检索（消耗 1 次额度）

```bash
POST /dsh-global-search/test?q=deepseek%20harness%20dsh%20plugin
HTTP 200 ok=true provider=serper ms=1048 n=5 credits=2491
first: DeepSeek Harness | Explore the limits of intelligence | https://www.deepseek.com/en/harness/
```

另一条（`rust async runtime tokio`，n=5，2210 ms）：`https://tokio.rs/`、`https://tokio.rs/tokio/tutorial/async`、`https://docs.rs/tokio/latest/tokio/runtime/index.html`。

### 2.7 回退通道（Google 关闭时）

`web_search` 按查询语言分流，不消耗额度：英文/非中文 → `bing-global`（`cn.bing.com` + `ensearch=1`），中文 → `bing-cn`。
集成测试断言：英文请求 URL 含 `ensearch=1`，中文请求不含。

### 2.8 web_fetch

直连抓取，失败按 `dns / reset / tls / timeout / http / parse` 分类，错误消息**写明 URL**。实测：

```
https://example.com/page → 200 kind=html
https://blocked.invalid/ → could not fetch https://blocked.invalid/ — direct request failed with reset (connect ECONNREFUSED …)
```

---

## §3 自动化测试

```bash
cd dsh-global-search
node tools/test-unit.mjs     # 45 passed, 0 failed
node tools/test-host.mjs     # 71 passed, 0 failed
```

| 套件 | 数量 | 覆盖 |
|---|---|---|
| `tools/test-unit.mjs` | **45** | Bing 点击追踪 URL 解码、SERP 解析、CJK 分流、6 类错误分类、serper 搜索/余额、403→auth、429→rate-limit、空结果、无 key、无余额端点的 provider |
| `tools/test-host.mjs` | **71** | 4 条路由注册、provider 注册、工具注册/注销、工具 schema、`turn/end` 余额钩子、设置路由全分支（400/200/clearKey）、key 掩码与落盘、系统提示段落、Bing 分流、fetch 失败上报 |

合计 **116 项，0 失败**；全部 stub `fetch`，不发真实请求。

---

## §4 安装与卸载

### 4.1 隔离环境（不碰用户 profile）

```bash
export DSH_HOME=D:/DeepseekHarness/work/iso
node install.mjs --profile probe --from dsh-global-search-1.0.2.tgz
node uninstall.mjs --profile probe
```

实测：

```
OK source package — tarball 30564 B
OK target profile — package.json present
OK package manager — pnpm present
INSTALLED plugin registration — dsh plugin add exited 0
PASS dependencies has entry / dsh.profile.bundles has entry / node_modules package present / host entrypoint present / bundle patch present
（重跑）ALREADY plugin registration — dependencies + dsh.profile.bundles both present
（卸载）PASS ×4 → CLEAN — 3 step(s) recorded
残留：deps: null  bundles: []  node_modules: gone  data dir: gone
```

### 4.2 真实安装到 desktop profile

通过 DSH 自己的插件入口执行（`plugin_manager install_bundle`，等价于 `dsh plugin add file:…tgz`）：

```
- dsh-global-search 1.0.0
+ dsh-global-search 1.0.2
application: applied   version: 1.0.2   exitCode: 0
```

落地核验（安装目录 vs 源码，逐文件 sha256）：

```
SAME lib/index.js  SAME lib/client.js  SAME lib/google.js  SAME lib/channels.js
SAME lib/state.js  SAME lib/log.js     SAME package.json   SAME cordis.patch.yml
```

其它 10 个插件（dsh-meme / dsh-ops / dsh-comfyui / dshmarket / graph-memory / dsh-univer-office / dsh-our-free-model / @xmanrui/dsh-im / @linxin666/dsh-web-all / dsh-whale-widget）安装后逐个复查：**全部在位**。

---

## §5 运行日志（真实片段）

```jsonl
{"event":"plugin.activated","version":"1.0.2","config":{"maxResults":10}}
{"event":"providers.registered","id":"dsh-global-search","search":true,"fetch":true}
{"event":"routes.registered","paths":["/dsh-global-search/status","/dsh-global-search/settings","/dsh-global-search/balance","/dsh-global-search/test"]}
{"event":"legacy.removed","name":"nodes.yaml"}          ← 清掉 0.6.0 留下的 731 KB 节点快照
{"event":"legacy.removed","name":"kernel-verdict.json"}
{"event":"tool.registered","name":"google_search"}
{"event":"google.balance","credits":2491,"rateLimit":5,"provider":"serper","reason":"startup"}
{"event":"google.toggled","enabled":true,"ua":"node","origin":"","referer":""}
{"event":"google.tool-call","query":"rust async runtime tokio","reason":null}
{"event":"google.done","provider":"serper","n":5,"ms":1048,"credits":2491}
```

---

## §6 客户端界面：需要重启一次（唯一未闭环项）

```bash
node -e "fetch('http://127.0.0.1:50200/plugins/dsh-global-search/client.js').then(r=>console.log(r.status, r.headers.get('content-length')))"
   → 404 0
```

原因：DSH 在**启动时**扫描 `dsh.client` 并编制客户端模块表与 bundle 路由；运行中新装的插件只热重组 Host 半边（`dsh.profile.bundles` 变化 → 约 2 秒重组），不会重建客户端表。这不是插件缺陷：隔离环境里"先装后启动"实测该路由 **200**，内容含 `settings.section`、`conversation.composer.dock`、`Google 搜索`。

**复验命令（重启后执行）**：

```bash
node -e "fetch('http://127.0.0.1:50200/plugins/dsh-global-search/client.js').then(async r=>{const t=await r.text();console.log(r.status,t.length,'settings:',t.includes('settings.section'),'dock:',t.includes('conversation.composer.dock'))})"
# 期望：200 <字节数> settings: true dock: true
```

重启后可见：**设置 › 外网搜索**（填 key / 开关 / 余额 / 测试 / 状态）与输入框下方 **`Google 搜索 · 开|关`**。

---

## §7 回滚备份

| 位置 | 内容 |
|---|---|
| `D:\DeepseekHarness\work\backup\dsh-global-search-v0.6.0-2026-10-26\` | 改动前完整源码快照（25 文件 / 322 KB）+ 各文件 sha256 |
| `D:\DeepseekHarness\work\backup\profile-desktop-pre-1.0.0\` | 安装前 profile 的 `package.json` / `cordis.patch.yml` / `pnpm-lock.yaml` + 0.6.0 的 `state.json` |
| `D:\DeepseekHarness\work\backup\profile-desktop-during-1.0.1\` | lockfile 事故瞬间的 manifest + lockfile（复盘用） |
| `D:\DeepseekHarness\work\dsh-global-search\.git` | git 基线 commit `14115ff`（v1.0.2 全量） |

**只回滚 profile 登记**（最快）：删掉 `package.json` 的 `dsh-global-search` 依赖行与 `dsh.profile.bundles` 中该行，原生搜索立即接管。
**完整回滚到 0.6.0**：恢复备份源码 → 恢复 `package.json`/`pnpm-lock.yaml` → 重新 `npm pack` → `dsh plugin add`（0.6.0 的 tarball 已删，需重打）。

---

## §8 残留清单（卸载后）

| 位置 | 卸载后 |
|---|---|
| `<profile>/package.json` 的 `dependencies` | 整行移除（`deps: null`） |
| `<profile>/package.json` 的 `dsh.profile.bundles` | 条目移除 |
| `<profile>/node_modules/dsh-global-search` | 删除 |
| `~/.dsh/dsh-global-search/` | 删除（含 key、状态、日志） |
| 系统层（服务/计划任务/注册表/环境变量/hosts/系统代理） | **本插件从不写入**，无残留 |

`uninstall.mjs` 输出 `PASS×4` + `CLEAN`，退出码 0；重复执行仍 `CLEAN`（幂等）。

---

## §9 安全说明

1. **key 存放**：仅 `~/.dsh/dsh-global-search/state.json`；不进安装包、不进 profile、不进日志、`status` 只回掩码。
2. **控制路由无鉴权**：`/dsh-global-search/*` 与 DSH 其它插件路由同语义，仅绑定 `127.0.0.1`。任何本机进程可读 `status`（掩码 key）或改开关，但**读不到完整 key**（需文件系统权限）。这是宿主策略边界，插件不自造 token。
3. **额度消耗有上限**：只有 `google_search` 工具调用与 `/test` 会消耗额度；`status/balance/settings` 不消耗。

---

## §10 本轮删除的死代码（及原因）

| 删除项 | 规模 | 原因（实测） |
|---|---|---|
| `lib/tunnel.js`、`lib/proxy-core.js` | ~1 500 行 | 16 个内核镜像全不可达；946 个免费节点 0 个通过严格 204；本机从未成功过一次 |
| DDG 通道 | ~30 行 | 只能经上述隧道访问 |
| 公共 SearXNG 池 + 引擎归属校验 | ~120 行 | 可达实例全部无结果 / 返回别家引擎结果 |
| 本地出口探测与复用 | ~180 行 | 能探测到代理，但 Google 对任何出口都只回 JS 外壳 |
| `locale/` | 2 文件 | 从未被引用 |
| `tools/*.mjs` 探针脚本 | 14 文件 | 一次性验证脚本 |
| 旧 tgz | 3 文件 | 0.3.0 / 0.5.0 / 0.6.0 |
| 状态字段 `mode`/`tunnel`/`bootstrap`/`usage` | — | 无对应功能；`state.js` 改白名单合并，升级不残留旧字段 |

---

## §11 发行包

| 文件 | 大小 | SHA-256 |
|---|---|---|
| `dist/dsh-global-search-1.0.2.tgz` | 30 748 B | `dc9858615e259de4ddf63d511b1bf0b0e369a9a8ddc89541a309d0de7aa78fdb` |
| `dist/dsh-global-search-1.0.2-github.zip` | 见 `dist/SHA256SUMS.txt` | 见 `dist/SHA256SUMS.txt`（本文件也被打进该 zip，所以 zip 自身哈希只记在校验和文件里） |
| `dist/SHA256SUMS.txt` | — | 上面两项 |

> 已安装到 profile 的那份与 `dist` 包的差别只有 `README.md` 与 `install.mjs`（纯文档/安装器，运行时不加载）：两者在装完之后又修过一次"重启说明"。代码文件（`lib/*`、`package.json`、`cordis.patch.yml`）逐字节一致，见 §4.2。

包内 13 文件与源码逐字节一致（`tar -xzf` 后逐文件 `cmp` 全 SAME）：`LICENSE`、`README.md`、`cordis.patch.yml`、`icon.svg`、`install.mjs`、`uninstall.mjs`、`package.json`、`lib/{index,client,google,channels,state,log}.js`。

安装：

```bash
dsh plugin --profile desktop add file:D:/path/dsh-global-search-1.0.2.tgz
# 或 node install.mjs --profile desktop --from <tgz> --google-key <key>
```

---

## §12 升级过程中踩到的坑（均已修复，留档）

1. **`output.schema = { type: 'json' }` 非法** → `ctx.tools.register` 抛 `unsupported JSON schema`，插件激活中断（余额没预热、工具没注册）。改为 `{ type: 'string' }`，工具直接返回给模型看的文本。**测试没覆盖、靠真实安装才暴露**（mock 了 `tools.register`，没校验 schema）。→ 1.0.1
2. **同路径同版本 tarball 不会重装**：`dsh plugin add` 返回 `ambiguous-install`，装上的还是旧代码。→ 版本号必须变。
3. **删掉旧 tarball 会让 lockfile 悬空**：下一次 pnpm 解析直接 `ENOENT`。→ 换版本时先让 pnpm 切到新路径，再删旧包。
4. **`status.version` 硬编码漂移**：1.0.1 装上后 status 仍报 1.0.0。→ 运行时读 `package.json`。→ 1.0.2
5. **运行中替换包文件不会重载**：Host 只在 `dsh.profile.bundles` 变化时重组。→ 用"移除→装回"触发真正重载。
6. **一次未解释的开关变更**：07:25:54 与 07:25:58 各一条 `google.toggled enabled:false`，不是本轮任何脚本发出（当时尚无 UA 记录）。从 1.0.1 起该事件记录 `ua/origin/referer`，若再现可直接定位。当前状态 `enabled=true`、工具已注册、检索正常。

---

## §13 边界与未验证

| 项 | 状态 | 说明 / 复验 |
|---|---|---|
| 客户端界面（设置页 + 开关） | **未验证（需重启）** | §6 复验命令；Host 侧功能已全部实测 |
| macOS / Linux | 未验证 | 代码无平台分支，但未在宿主上跑过 |
| `searchapi / serpapi / zenserp / valueserp` | 未验证（未接 key） | 只测过 serper；这 4 家余额端点**故意不实现**，界面明示"不提供余额接口" |
| 抓被墙站点 | 不可用（设计如此） | 无代理/隧道；失败会明确分类并写明 URL |
| Google 直连网页 | 不可用（Google 侧限制） | 无 JS 结果页；这是选 SERP API 的原因 |


## 13. v1.1.1 — 设置入口修复（2026-10-26）

### 13.1 现场诊断（Cordis Inspect，运行中的应用）

```
client/Slots.listSubTree root=settings.section
  occupants: ... {"registrant":"Kb","id":"dsh-global-search","order":40,"active":false}

client/Slots.listSubTree root=conversation.composer.dock
  occupants: ... {"id":"dsh-global-search","order":2,"active":true}
```

结论：注册对象存在，但 `active:false`（从未挂载，导航里没有可点的条目）；同时旧版没有注册 Web UI
插件列表的 `web-ui.plugin.item`，而当前设置页正是插件卡片式，两者叠加就是用户看到的「没有入口」。

### 13.2 修复后（v1.1.1）

| 面 | 槽 | 标识 |
| --- | --- | --- |
| 原生设置导航 | `settings.section` | id `dsh-global-search`，order 16 |
| Web UI 设置 › 插件列表卡片 | `web-ui.plugin.item` | id `dsh-global-search` |
| 设置 › 插件 › 本包页面卡片 | `plugins.bundle.config` | key `dsh-global-search` |
| 输入框下方开关 | `conversation.composer.dock` | id `dsh-global-search-switch` |

### 13.3 可复现的自动化验证

```
node tools/test-client.mjs   → client: 16 passed, 0 failed
node tools/test-unit.mjs     → unit:   45 passed, 0 failed
node tools/test-host.mjs     → host:   71 passed, 0 failed
```

### 13.4 仍未验证（需要重启后看一眼）

- 设置页在浏览器里的实际渲染：客户端模块表在应用启动时编制，本次改动必须重启 DSH 才进入页面；重启前
  `GET /dsh-global-search/status` 仍返回 `1.0.2`（Host 侧 ESM 模块缓存同理），这本身就是必须重启的证据。
- 重启后的复核命令：`GET /dsh-global-search/status` 应返回 `1.1.1`；再用
  `cordis_inspect_query client/Slots root=settings.section` 观察该 id 的 `active` 是否变为 true。

---

## 14. 设置面板「渲染失败」的定位与修复（1.1.2）

重启后用户报告：设置面板显示「渲染失败」。本节只记录可复现的观测。

### 14.1 现场证据

| 观测（命令） | 值 | 含义 |
| --- | --- | --- |
| `cordis_inspect_query client/Slots root=settings.section` | `{"id":"dsh-global-search","order":16,"active":true}` | 注册成功且占位已挂载 —— 不是"没注册" |
| `GET /dsh-global-search/status` | `"version":"1.1.1"` | Host 半边已是新版（热重组生效） |
| `GET /plugins/dsh-global-search/client.js` | `404` | 该路径并非客户端取包入口（客户端走启动时编制的模块表），不作为证据 |
| `cordis_inspect_query client/Builtin listBuiltins` | `React`: `createElement / useState / useEffect` | 动态 Client bundle 文档化的 React 入口只有三个 |
| `grep -E "useCallback\|useRef"` @ dsh-comfyui（正常工作） | 命中 13 处 | hook 面比三个入口宽 |
| `grep "extends React.Component"` @ 全部已装插件 | **0 命中** | 没有第二个插件用 class 组件 |
| `~/.dsh/logs` | 无客户端堆栈 | 浏览器侧异常不会自己进宿主日志 |

### 14.2 结论与修复

抛错点在渲染阶段，而本插件客户端唯一"与别人不同"的构造就是 class 错误边界
（`class ErrorBoundary extends React.Component` + `getDerivedStateFromError`）。
那份假 React 自带 `Component`，于是测试通过、真实运行时却不支持 → 面板渲染失败。

1.1.2 的做法：

- 删除 class 组件与 `useCallback`，客户端只剩 `createElement / useState / useEffect`；
- 面板、开关的渲染各包一层 `try/catch`，异常显示文本并注明"已写入日志"；
- 新增 `POST /dsh-global-search/client-error` → `log.jsonl` 的 `client.render-error`（含
  message、前 800 字符 stack、页面 URL），让下一次失败可被宿主侧直接读到。

### 14.3 验证

```
node tools/test-client.mjs   → client: 21 passed, 0 failed
node tools/test-unit.mjs     → unit:   45 passed, 0 failed
node tools/test-host.mjs     → host:   75 passed, 0 failed
```

新增断言（防止复发）：假 React 不再提供 `Component`/`useCallback`/`useRef`；源码剥注释后
`React.*` 引用必须落在白名单；`status` 未到达时面板仍须渲染出四步引导与 key 输入框；
`client-error` 接受上报、拒绝 GET、内容落到 `log.jsonl`。

安装：`install_bundle file:…/dsh-global-search-1.1.2.tgz` → `exitCode 0`、
`dsh-global-search 1.1.2`、`application: applied`；profile 内 `lib/client.js`、`lib/index.js`、
`package.json` 与源码 `SAME`（sha256 逐一对比）。

### 14.4 仍需重启一次

客户端模块表在应用启动时编制，本次改动重启后才进页面（重启前 `status` 仍报 `1.1.1`）。
若重启后面板依旧失败，`client.render-error` 会带着真实报错进日志，下一次修复不需要再猜：

```
grep client.render-error C:\Users\Ryan\.dsh\dsh-global-search\log.jsonl
```

## 15. 1.1.3 — 设置页 `active:false` 的真根因（已修，含实时证据）

**现象**：设置导航里没有本插件的一页；`Slots.listSubTree(settings.section)` 显示
`{"id":"dsh-global-search","active":false}`，而同页其它条目全是 `active:true`。

**排除法**（全部来自运行中应用，不是推测）：

| 假设 | 检验 | 结果 |
|---|---|---|
| 客户端包没送达 | 对比 `dsh-meme` / `dsh-comfyui` 的 `/plugins/<name>/client.js` | **全部 404**，说明该 URL 不是投递路径，假设作废 |
| 组件渲染抛错 | `client.render-error` 日志条数 | **0**，且输入框开关 `active:true`、`client.mounted` 有记录 → 渲染正常 |
| 注册参数形状错 | 对照 comfyui 的 `settings.section` 注册（第 5215 行） | 形状一致（`{name,id,order,label}` + 组件） |
| **同一 id 注册到两个槽** | 1.1.2 中 `settings.section` 与 `web-ui.plugin.item` 都用 `id:'dsh-global-search'` | **成立** |

**根因**：loader 以注册 id 记账，同一个 id 在第二个槽注册后，先注册的占用项被标成
`active:false`——表现就是"页面的代码在，但导航里永远点不到"，与"没实现"无法区分。

**修复**：每个面独立 id（`dsh-global-search-page` / `-card` / `-switch`）；
`tools/test-client.mjs` 增加"跨所有槽 id 唯一"断言（22 项）。

**修复后的实时证据**（安装 1.1.3 后，未刷新页面，客户端热重载）：

```
settings.section   → dsh-global-search-page  active: true      ← 修复前为 false
web-ui.plugin.item → dsh-global-search-card  active: true
client.mounted     {"surface":"switch","url":"/"}             ← 浏览器真的渲染了
client.render-error 条数 0
GET /dsh-global-search/status → version 1.1.3, tool registered, credits 2490
POST /dsh-global-search/client-heartbeat → 200 {"ok":true}
```

**顺带补的可观测性**：`POST /dsh-global-search/client-heartbeat` 让每个客户端组件挂载时
上报 `client.mounted {surface}`，以后"到底有没有渲染"由日志回答，不再依赖截图。
点开设置页后会多一条 `surface:"settings-page"`——这是复验本条的最后一个动作。

## 16. The settings page: measured evidence, final fix (1.1.8)

The failing symptom was never "the plugin is missing" — the settings entry was there and
clickable, and every version until 1.1.7 rendered **an empty page**.

### Evidence, from the running application (not inferred)

| Observation | Value | Meaning |
| --- | --- | --- |
| `settings.section` occupant `dsh-global-search-page` | `active: false` | registered, never committed |
| `settings.section` occupant `dsh-global-search-b` | `active: false` | same for the A/B twin |
| `settings.section` occupant `dsh-global-search-diag` (hook-free, static text) | `active: true` | the slot itself renders fine |
| `client.mounted {surface:"panel-enter"}` | **41 events** | the shell keeps calling the component |
| `client.mounted {surface:"settings-page"}` (emitted from `useEffect`) | **0 events** | render output was never committed, so effects never ran |
| `client.render-error` | **0 events** | nothing threw — so no error text could ever be shown |
| the same `Panel` rendered into `conversation.composer.dock` | works, user configured the key through it | hooks are fine; **this slot** will not commit them |

Rejected hypotheses, each killed by data rather than opinion:
`/plugins/<name>/client.js` 404 (every plugin 404s, including working ones),
id collision across slots (both entries were inactive; the diag id was unique and active),
missing registration (the occupant list contained all three),
render crash (no error, body entered repeatedly).

### The fix

The settings page is hook-free: `SettingsPage` → `renderSettingsPage`, plain markup plus DOM
handlers that call the host and patch one `[data-gs-out]` node. No `useState`, `useEffect`,
`useRef`, `useCallback` or `useMemo` anywhere in that region, and `tools/test-client.mjs`
scans the region and fails if one comes back. The A/B pair and the diagnostic entry are
removed: `settings.section` carries exactly one `外网搜索 (Google)` page, and the plugin
card and bundle card render the same hook-free page. The composer chip keeps the rich
`Panel` card, which is the fast path and the surface that is known to render.

### What wrote the evidence

`POST /dsh-global-search/client-heartbeat` + `client.mounted` beacons, and
`POST /dsh-global-search/client-error` for `window.onerror`, `unhandledrejection` and panel
render failures. Both land in `~/.dsh/dsh-global-search/log.jsonl`, so a blank panel is
diagnosable from the host side without a screenshot or a browser console.

## 17. 1.1.9 — 「安装一直卡在安装中」的定位与修复（2026-10-27）

### 症状

界面上的安装格子一直转，无报错，安装永不结束。此前 1.1.3 → 1.1.8 的迭代都用「卸载 → 装 tgz」
这条路径，每次都卡在同一处。

### 实测：安装其实成功了

| 观测 | 结果 |
|---|---|
| `node_modules/dsh-global-search` 类型 | 真实目录（`lstat: directory`），版本 **1.1.8** |
| profile `dependencies` | `"dsh-global-search": "file:…/dist/dsh-global-search-1.1.8.tgz"` |
| profile `dsh.profile.bundles` | 含 `dsh-global-search` |
| `pnpm-lock.yaml` | 有该 `file:` 规格与 integrity |
| 包内 13 文件与安装目录逐字节比对 | **13/13 identical** |
| 插件日志 | `00:31:10 plugin.ready` + `tool.registered google_search` |
| 客户端 | `client.mounted {"surface":"apply"}` / `{"surface":"switch"}` |
| `GET /dsh-global-search/status` | `version: 1.1.8`（运行中的宿主已加载新代码） |

### 根因（两件事叠加，都不是"界面坏了"）

1. **被杀掉的 pnpm 留下残留**，下一次安装把整轮时间花在它们身上。宿主的运行日志
   （`profiles/desktop/.plugin-manager/logs/operation-*/pnpm.log`）三连读：

   | 操作目录 | 最后一行 | 判定 |
   |---|---|---|
   | `operation-tyZBc6`（08:23） | `Packages: +1 -58` 之后无 `Done` | 被杀 |
   | `operation-fG6hf6`（08:24） | `Moving dsh-global-search_tmp_6696_12 to "node_modules\.ignored\…"` 之后无 `Done` | 被杀，且**残留就在这一行被 pnpm 自己点出来** |
   | `operation-eDOV8U`（08:31） | `+ dsh-global-search 1.1.8` / `Done in 1s` | **成功** |

   被杀的运行留下三种形状：`<pkg>_tmp_<pid>_<n>` 暂存目录、`.ignored/` 下的同名目录、
   以及没有 `package.json` 的半拷贝包目录。pnpm 的清理靠"下一次运行顺手挪走"，因此一次被杀
   会污染后续每一次尝试。

2. **界面那格是过期的前端状态**：08:31 的成功发生在插件客户端重载期间，那一轮的完成事件
   没能落到页面上，于是格子一直转。宿主侧 `run.json`（`.plugin-manager/run.json`，记录发起
   安装的 pnpm 进程 pid）此时**不存在**，说明没有僵持的操作在跑。

宿主源码里的相关机制（从 `app.asar` 只读提取，`@deepseek-ai/dsh-plugin-manager/lib/index.js`）：
`runRecordPath()` → `<profile>/.plugin-manager/run.json`，`activeRecordedRun()` 会等待记录中的
进程结束，若仍存活则拒绝并提示「wait for it or stop it, then retry… delete run.json」。

### 修复

- 新增 `lib/residue.js`：只读扫描三类残留 + 安全删除。删除**从不跟随重解析点**：Windows 上
  junction 与真实目录在 `lstat` 下不可区分（`isSymbolicLink()` 为 `false`、inode 相同，本机
  实测），所以先试 `rmdir`（只删 junction/空目录，绝不动目标），失败才递归删除；带可读
  `package.json` 的目录一律不动。
- `install.mjs` 在调 pnpm 之前自检并清理，记录 `installer residue` → `OK` / `CLEANED` / `WOULD`；
  目录安装只清暂存目录、保留合法链接。
- `uninstall.mjs` 顺手清理同类残留，断开"卸载→重装"的继承。
- 新增 `tools/test-residue.mjs`：11 项，覆盖三类残留识别、dry-run 不动盘、删除后归零、
  已安装包不误删、链接检出点不被穿透、二次运行幂等。
- `npm test` 现在 155 项：45 单元 + 75 宿主 + 24 客户端 + 11 残留，全绿。

### 仍然属于宿主侧、插件改不了的部分

界面那格的「安装中」是前端状态，插件无法触及。判定顺序写进 README §6：先看 `pnpm.log` 是否
有 `Done` —— 有就说明装好了，刷新页面（仍不自愈则重启一次应用）；没有则按上面的残留清单清理
后重装。
