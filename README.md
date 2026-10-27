# dsh-global-search

让 DeepSeek Harness 能**真正搜索 Google**，并保留一条永远可用的国际索引兜底。

- **零捆绑凭据**：插件不含任何 key。你自己在设置里填一枚免费 SERP key（serper.dev 注册即给 2500 次/月，不要信用卡），key 只存在本机插件数据目录。
- **零系统改动**：不设系统代理、不改环境变量、不写 hosts/DNS、不装驱动、不开服务、不加开机自启。
- **模型自主判断**：开启后，插件给模型一个 `google_search` 工具；只有在"确实需要 Google 索引"时模型才调用它，每次消耗 1 次额度。关闭后该工具**直接消失**，搜索走 Bing。
- **额度可见**：每轮对话结束后自动读一次余额，设置页和输入框下方都能看到剩余次数。
- **可彻底卸载**：卸载后 profile 登记、node_modules、插件数据目录一并消失。

---

## 1. 安装

三种方式任选其一（都走 DSH 自己的插件机制，不需要手改任何文件）：

```bash
# A. Desktop/WEB 界面：设置 › 插件 › 安装，填本地路径或发布包
# B. 命令行：
dsh plugin --profile desktop add file:D:/path/dsh-global-search-1.0.2.tgz
# C. 仓库里的包装脚本（幂等，装完打印 5 项复核）：
node install.mjs --profile desktop --from D:/path/dsh-global-search-1.0.2.tgz --google-key <你的key>
```

装完请 **重启一次 DeepSeek Harness**。原因是 DSH 在启动时编制客户端模块表：运行中新装的插件只会热重组 Host 半边（约 2 秒，搜索立刻可用），而设置页与输入框开关属于客户端 bundle，只有重启后 `/plugins/dsh-global-search/client.js` 才会从 404 变成 200。

> 只装、不想重启？那 Host 能力仍然可用（`google_search` 工具、`web_search` 回退、`/dsh-global-search/*` 接口），只是看不到设置页和开关。

**首次配置（30 秒）**

1. 打开 <https://serper.dev> 注册，复制 API key（免费 2500 次/月）。
2. DSH 里进 **设置 › 外网搜索**，粘贴 key → 点「保存」→ 点「测试连接」。
3. 也可以直接点输入框下方的 **「Google 搜索 · 未配置」**，弹窗粘贴 key，一步完成。

> 不想给 key？那就不用装这个插件：DSH 自带的搜索仍然可用。装上但不填 key 时，插件只是把搜索固定到 Bing（英文→国际索引，中文→国内索引），不消耗任何额度。

## 2. 用起来是什么样

| 位置 | 作用 |
|---|---|
| 输入框下方 `Google 搜索 · 开 / 关` | 一键启用/停用 Google。绿灯=可用，右侧数字是剩余额度。未配置时点击直接粘 key。 |
| 设置 › 外网搜索 | 填/换/清 key、开关、余额刷新、连接测试、运行状态与日志路径。 |
| 模型工具 `google_search` | 仅当开关为开时存在。模型自行判断是否调用，调用即消耗 1 次额度。 |
| `web_search`（原生工具） | 不消耗额度。非中文查询走 Bing 国际索引（`cn.bing.com` + `ensearch=1`），中文查询走国内索引。 |
| `web_fetch`（原生工具） | 直连抓取；失败时按 DNS / reset / TLS / timeout 分类报错并写明地址。 |

**为什么由模型决定，而不是每次搜索都用 Google**：搜索额度是按次计费的资源，普通查证用 Bing 就够。插件在系统提示里告诉模型当前额度、什么时候该用、什么时候不该用，并把工具描述写成"仅在需要 Google 索引时调用"。真正做到"只在需要 Google 时花额度"。

## 3. 额度

- 每轮对话结束（`turn/end`）后自动请求一次 `GET https://google.serper.dev/account`，把 `balance` 写进状态与设置页 —— 这也是唯一会主动发起的额外请求。
- 余额读取**不消耗查询次数**（serper 不计费），只受其 25 次/窗口的速率限制约束。
- 额度 < 20 次时，插件会在系统提示里提醒模型"只在用户明确要求时使用 Google"。
- 用尽或被限流（HTTP 429）时，`google_search` 会返回明确原因，模型会退回 `web_search`，不会卡死。

## 4. 支持的 SERP 服务商

| id | 免费额度 | 余额查询 |
|---|---|---|
| `serper`（默认） | 2500 次/月 | ✅ 实测 `{"balance":2493,"rateLimit":5}` |
| `searchapi` | 100 次 | ❌ 无公开余额端点，界面明示"该 provider 不提供余额接口" |
| `serpapi` | 100 次 | ❌ 同上 |
| `zenserp` | 50 次 | ❌ 同上 |
| `valueserp` | 100 次 | ❌ 同上 |

> 只有实测过的端点才标 ✅。宁可显示"未知"，也不显示一个编出来的数字。

## 5. 卸载（零残留）

```bash
node uninstall.mjs --profile desktop        # 打印 4 项 PASS + CLEAN
# 或：设置 › 插件 › 移除 dsh-global-search
```

卸载做三件事，脚本会逐项复核：

1. `dsh plugin remove` 删掉 profile 的 `dependencies` 与 `dsh.profile.bundles` 登记；
2. 删除 `<profile>/node_modules/dsh-global-search`；
3. 删除插件数据目录 `~/.dsh/dsh-global-search`（**包含你填的 key**、状态、日志）。

随后 `web` provider 自动回落到 DSH 原生搜索，无需重启。

## 6. 日志与排错

- 结构化 JSONL：`~/.dsh/dsh-global-search/log.jsonl`（4 MB 轮转一次）
- 关键事件：`search.start` / `search.done` / `search.channel-failed`、`google.tool-call` / `google.done` / `google.failed`、`google.balance`、`tool.registered` / `tool.unregistered`、`legacy.removed`
- 现场诊断（不需要界面）：
  ```bash
  curl http://127.0.0.1:50200/dsh-global-search/status
  curl -X POST "http://127.0.0.1:50200/dsh-global-search/test?q=tokio"   # 消耗 1 次额度
  ```

### 安装一直停在「安装中」

先看安装到底有没有完成，别按界面猜：

```bash
# 1. 宿主那一轮 pnpm 的真实结果（多看几个 operation-* 目录）
tail -6 ~/.dsh/profiles/<profile>/.plugin-manager/logs/operation-*/pnpm.log

# 2. 插件是否真的装好了并已加载
curl -s http://127.0.0.1:<端口>/dsh-global-search/status
```

- 日志最后一行是 **`Done in Ns`** → 安装其实成功了，界面那格是**过期的前端状态**：刷新页面（F5）即可；
  若刷新后仍是「安装中」，说明宿主内存里的操作记录没结算，重启一次应用就好（插件本身已生效）。
- 日志停在 `Packages: +1 -58` 且**没有** `Done` → 那一轮 pnpm 被杀了（重启应用/关窗口）。
  它留下的 `<pkg>_tmp_*` 会让下一次安装白跑一遍。**1.1.9 起插件会在每次启动时清理自己的
  这类残留**（日志事件 `installer.residue.cleaned`），所以装好一版之后就不会再被上一次的
  残骸拖住；脚本安装（`install.mjs`）另有一道装前自检，效果相同。

## 7. 已知边界（诚实清单）

- **本插件不提供翻墙能力。** 早期版本内置过 mihomo 内核 + 免费节点隧道，实测在本机环境下 946 个免费节点 0 个可用、16 个内核镜像全部不可达，无法通过验收，已在 1.0.0 整体删除（约 1 500 行）。因此 `web_fetch` 抓被墙站点会失败，并如实报出失败分类。
- **不直连 Google 网页。** Google 已取消无 JS 结果页，任何出口（包括可用代理）都只回 JS 外壳；SERP API 是唯一免费可解析的路径。
- **控制路由与 DSH 的其它插件路由同语义**：绑定 `127.0.0.1`，同源可访问；插件不自造鉴权 token（那属于宿主策略）。
- 仅支持 Windows 上实测通过的路径；其它平台未验证。

## 8. 开发

```bash
npm test          # 155 项：45 单元 + 75 宿主集成 + 24 客户端 + 11 安装残留
npm run pack      # 生成发布包
```

代码结构（6 个模块，无运行时依赖）：

| 文件 | 职责 |
|---|---|
| `lib/index.js` | Host：providers、`google_search` 工具、控制路由、每回合额度刷新、系统提示注入 |
| `lib/client.js` | 客户端：设置页（`settings.section`）与输入框开关（`conversation.composer.dock`） |
| `lib/google.js` | SERP 服务商：搜索 + 余额，错误分类 |
| `lib/channels.js` | Bing 国际/国内索引解析、直连抓取、失败分类 |
| `lib/state.js` | 状态持久化（白名单合并，升级不残留旧字段） |
| `lib/log.js` | JSONL 日志 |

License: MIT
