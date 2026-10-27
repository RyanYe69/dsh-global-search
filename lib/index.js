// dsh-global-search — Host half.
//
// One search provider, one fetch provider, one model-facing `google_search` tool,
// one same-origin control surface, and a settings page. It never edits another
// plugin's config, never writes system networking, and every degradation is both
// logged and visible in the UI.
//
// Division of labour, which is the whole point of this plugin:
//   · `web_search`          → Bing (international index for non-CJK, CN index for CJK). Free.
//   · `google_search` tool  → the user's own Google SERP key. One credit per call,
//                             so the *model* decides when Google is actually needed.
//   · the composer switch   → whether that tool exists at all.
import os from 'node:os'
import path from 'node:path'
import { rm } from 'node:fs/promises'
import { existsSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { CHANNEL, classifyNetworkError, fetchDirect, isCJK, searchBing } from './channels.js'
import { KEY_PROVIDERS, readBalance, resolveProvider, searchGoogle } from './google.js'
import { createLogger } from './log.js'
import { findResidue, removeResidue } from './residue.js'
import { createStore } from './state.js'

export const name = 'dsh-global-search'
export const inject = ['web', 'webServer']

const PROVIDER_ID = 'dsh-global-search'
const TOOL_NAME = 'google_search'
// Read the version instead of restating it: a hardcoded copy drifted once already
// (package.json 1.0.1 while status still reported 1.0.0).
const VERSION = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version

// A key can also arrive through the environment, which is what `install.mjs
// --google-key` and container images use. State wins, so a key pasted in the
// settings page always overrides a stale environment variable.
const KEY_ENV_NAMES = ['DSH_GLOBAL_SEARCH_GOOGLE_KEY', 'SERPER_API_KEY']

// After every conversation turn the plugin reads the remaining quota exactly once
// (one cheap GET, which the SERP provider does not bill as a query). Concurrent
// reads are coalesced so a burst of turns cannot fire a burst of requests.
function envCredential() {
  for (const envName of KEY_ENV_NAMES) {
    const secret = String(process.env[envName] ?? '').trim()
    if (secret.length >= 8) return { provider: 'serper', secret, source: `env:${envName}` }
  }
  return null
}

/** Throw the seam's own WebError when it is reachable, else an Error carrying `code`. */
let WebErrorClass = null
async function loadWebError() {
  if (WebErrorClass !== null) return WebErrorClass
  try {
    const mod = await import('@deepseek-ai/dsh-web')
    WebErrorClass = mod.WebError ?? false
  } catch {
    WebErrorClass = false
  }
  return WebErrorClass
}
function webError(message, code, cause) {
  const Ctor = WebErrorClass || null
  if (Ctor) return new Ctor(message, code, cause === undefined ? undefined : { cause })
  const err = new Error(message, cause === undefined ? undefined : { cause })
  err.code = code
  return err
}

/** Where this plugin keeps its state and logs. Deleted wholesale on uninstall. */
export function dataDirectory() {
  const home = process.env.DSH_HOME ?? path.join(os.homedir(), '.dsh')
  return path.join(home, 'dsh-global-search')
}

function readJsonBody(req, maxBytes = 8192) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    req.on('data', (c) => {
      size += c.length
      if (size > maxBytes) {
        reject(new Error('request body too large'))
        req.destroy()
        return
      }
      chunks.push(c)
    })
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8').trim()
      if (text.length === 0) return resolve({})
      try {
        resolve(JSON.parse(text))
      } catch (e) {
        reject(new Error(`invalid JSON body: ${e.message}`))
      }
    })
    req.on('error', reject)
  })
}

function json(res, status, value) {
  const body = `${JSON.stringify(value)}\n`
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
  })
  res.end(body)
}

const clampLimit = (wanted, fallback) => Math.min(Math.max(Number(wanted) > 0 ? Math.floor(Number(wanted)) : fallback, 1), 20)
const maskSecret = (secret) => `${String(secret).slice(0, 4)}…${String(secret).slice(-2)}`

function formatSources(sources, { query, provider, credits, ms }) {
  const lines = sources.map((s, i) => {
    const snippet = s.snippet ? `\n   ${String(s.snippet).replace(/\s+/g, ' ').slice(0, 300)}` : ''
    return `${i + 1}. ${s.title}\n   ${s.url}${snippet}`
  })
  const quota = Number.isFinite(credits) ? `剩余 ${credits} 次额度` : '额度未知'
  return `Google（${provider}）· ${sources.length} 条 · ${ms} ms · ${quota}\n\n${lines.join('\n')}`
}

export function apply(ctx, config = {}) {
  const maxResults = Number.isFinite(config.maxResults) ? Math.min(Math.max(config.maxResults, 1), 20) : 10
  const dataDir = dataDirectory()
  const log = createLogger(dataDir)
  const store = createStore(dataDir)

  // Synchronous mirror of the state values the model-facing prompt needs; a prompt
  // section cannot await, so every write goes through `save()` and updates this.
  const mirror = { enabled: false, hasKey: false, provider: 'serper', credits: null, balanceError: null, lastChannel: null }
  const syncMirror = (state) => {
    mirror.enabled = state.google?.enabled === true
    mirror.hasKey = Boolean(state.google?.key?.secret) || envCredential() !== null
    mirror.provider = resolveProvider(state.google?.key?.provider)
    mirror.credits = Number.isFinite(state.balance?.credits) ? state.balance.credits : null
    mirror.balanceError = state.balance?.error ?? null
    mirror.lastChannel = state.lastChannel ?? null
  }
  const save = async (patch) => {
    const next = await store.write(patch)
    syncMirror(next)
    return next
  }

  const credentialFrom = (state) => {
    const stored = state.google?.key ?? null
    if (stored?.secret) return { provider: resolveProvider(stored.provider), secret: stored.secret, source: 'state' }
    return envCredential()
  }
  const googleReady = () => mirror.enabled && mirror.hasKey

  log.info('plugin.activated', { version: VERSION, dataDir, config: { maxResults } })
  loadWebError().catch(() => {})

  // --- balance -------------------------------------------------------------
  let balanceInFlight = null
  async function refreshBalance({ reason } = {}) {
    const state = await store.read()
    const credential = credentialFrom(state)
    if (!credential) return null
    if (balanceInFlight) return balanceInFlight
    balanceInFlight = (async () => {
      const reading = await readBalance({ credential })
      const balance = { ...reading, reason }
      await save({ balance })
      log.info('google.balance', {
        credits: balance.credits,
        rateLimit: balance.rateLimit,
        provider: balance.provider,
        reason,
        error: balance.error ?? null,
        unsupported: balance.unsupported ?? null,
      })
      return balance
    })().finally(() => {
      balanceInFlight = null
    })
    return balanceInFlight
  }

  // --- google execution ----------------------------------------------------
  async function runGoogle(query, wanted) {
    const started = Date.now()
    const state = await store.read()
    if (state.google?.enabled !== true) return { ok: false, why: 'disabled' }
    const credential = credentialFrom(state)
    if (!credential) return { ok: false, why: 'no-key' }
    const limit = clampLimit(wanted, maxResults)
    try {
      const result = await searchGoogle({ query, maxResults: limit, credential, timeoutMs: 12000 })
      const balance = await refreshBalance({ reason: 'search' }).catch(() => null)
      await save({ lastChannel: result.channel, lastSearchAt: Date.now() })
      log.info('google.done', {
        query,
        provider: result.provider,
        n: result.sources.length,
        ms: result.ms,
        totalMs: Date.now() - started,
        credits: balance?.credits ?? null,
      })
      return { ok: true, result, credits: balance?.credits ?? null }
    } catch (error) {
      const category = error?.category ?? 'unknown'
      log.warn('google.failed', { query, category, provider: error?.provider ?? credential.provider, error: String(error?.message ?? error), ms: Date.now() - started })
      return { ok: false, why: 'failed', category, error }
    }
  }

  // --- search pipeline (Bing only; Google is the model's explicit choice) ---
  async function runSearch(query, wanted) {
    const started = Date.now()
    const limit = clampLimit(wanted, maxResults)
    const cjk = isCJK(query)
    const order = cjk ? [false, true] : [true, false]
    const attempts = []
    log.info('search.start', { query, limit, cjk, googleEnabled: mirror.enabled, googleKey: mirror.hasKey, order })
    let lastError = null
    for (const international of order) {
      const channel = international ? CHANNEL.BING_GLOBAL : CHANNEL.BING_CN
      const channelStarted = Date.now()
      try {
        const r = await searchBing({ query, international, maxResults: limit })
        attempts.push({ channel, ok: true, n: r.sources.length, ms: r.ms })
        log.info('search.done', { query, channel: r.channel, n: r.sources.length, ms: r.ms, totalMs: Date.now() - started, attempts })
        await save({ lastChannel: r.channel, lastSearchAt: Date.now() })
        return { sources: r.sources, truncated: false }
      } catch (error) {
        lastError = error
        attempts.push({ channel, ok: false, ms: Date.now() - channelStarted, category: error.category ?? 'unknown', error: String(error.message ?? error) })
        log.warn('search.channel-failed', { channel, category: error.category ?? 'unknown', error: String(error.message ?? error) })
      }
    }
    log.error('search.failed', { query, attempts, totalMs: Date.now() - started })
    throw webError(
      `global-search: every search channel failed for ${JSON.stringify(query)}. Tried: ${attempts
        .map((a) => `${a.channel}(${a.category ?? a.error})`)
        .join(', ')}. Google is only reachable through the ${TOOL_NAME} tool when a SERP key is configured and enabled.`,
      'WEB_PROVIDER_ERROR',
      lastError,
    )
  }

  // --- fetch pipeline ------------------------------------------------------
  async function runFetch(url) {
    const started = Date.now()
    try {
      const r = await fetchDirect({ url })
      log.info('fetch.done', { url, status: r.statusCode, bytes: r.body.content.length, ms: r.ms })
      return { url: r.url, statusCode: r.statusCode, body: r.body, truncated: r.truncated }
    } catch (error) {
      const category = error?.category ?? 'unknown'
      log.error('fetch.failed', { url, category, error: String(error?.message ?? error), ms: Date.now() - started })
      throw webError(
        `global-search: could not fetch ${url} — direct request failed with ${category} (${error?.message}). This plugin has no proxy or tunnel: if the host is blocked at the network layer, only a local proxy or a VPN on your side can reach it.`,
        category === 'timeout' ? 'WEB_FETCH_TIMEOUT' : 'WEB_PROVIDER_ERROR',
        error,
      )
    }
  }

  // --- providers -----------------------------------------------------------
  const searchProvider = {
    id: PROVIDER_ID,
    available: () => true,
    search(request) {
      return runSearch(request.query, request.maxResults)
    },
  }
  const fetchProvider = {
    id: PROVIDER_ID,
    available: () => true,
    fetch(request) {
      return runFetch(request.url)
    },
  }
  ctx.effect(() => ctx.web.registerSearchProvider(searchProvider))
  ctx.effect(() => ctx.web.registerFetchProvider(fetchProvider))
  log.info('providers.registered', { id: PROVIDER_ID, search: true, fetch: true })

  // --- model-facing tool ---------------------------------------------------
  // Registered only while Google is enabled *and* a key exists, so a disabled
  // switch really removes the capability instead of failing the call later.
  let toolScope = null
  let toolDisposer = null
  const toolDefinition = () => ({
    name: TOOL_NAME,
    description:
      'Search Google through the key the user configured in dsh-global-search. Use it when the answer really benefits from Google\'s index: the user explicitly asks for Google/谷歌 results, the question needs international or English sources, or the built-in web_search (Bing index) returned weak or China-only results. ' +
      'Every call spends one query from the user\'s free monthly quota, so do NOT use it for ordinary lookups, for Chinese-domestic questions, or when a snippet from web_search already answers the question. ' +
      'Returns numbered Google results (title, URL, snippet) plus the remaining quota.',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'The search query, in the language that best matches the sources you need (English for international sources).' },
        maxResults: { type: 'number', description: 'How many results to ask for, 1-20. Default comes from the plugin config (10).' },
        reason: { type: 'string', description: 'Optional one-line note on why Google is needed; shown in the user\'s plugin log.' },
      },
      required: ['query'],
      additionalProperties: false,
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: String(value ?? '') }],
    },
    execute: async (args, exec) => {
      const query = String(args?.query ?? '').trim()
      if (query.length === 0) return 'google_search: empty query.'
      const state = await store.read()
      if (state.google?.enabled !== true) {
        return 'Google 搜索已被用户关闭（输入框下方「Google 搜索」开关，或 设置 › 外网搜索）。请改用 web_search。'
      }
      if (!credentialFrom(state)) {
        return '还没有配置 Google SERP key（设置 › 外网搜索）。请改用 web_search，或提醒用户去配置。'
      }
      log.info('google.tool-call', { query, reason: typeof args?.reason === 'string' ? args.reason.slice(0, 200) : null })
      const outcome = await runGoogle(query, args?.maxResults ?? maxResults)
      if (!outcome.ok) {
        if (outcome.why === 'failed') {
          return `Google 搜索失败（${outcome.category}）：${outcome.error?.message ?? 'unknown'}。可以改用 web_search 继续（Bing 国际索引），或在设置里检查 key/额度。`
        }
        return `Google 搜索不可用（${outcome.why}），请改用 web_search。`
      }
      return formatSources(outcome.result.sources, {
        query,
        provider: outcome.result.provider,
        credits: outcome.credits,
        ms: outcome.result.ms,
      })
    },
  })

  const syncTool = () => {
    if (!toolScope) return
    const ready = googleReady()
    if (ready && !toolDisposer) {
      toolDisposer = toolScope.tools.register(toolDefinition())
      log.info('tool.registered', { name: TOOL_NAME })
    } else if (!ready && toolDisposer) {
      toolDisposer()
      toolDisposer = null
      log.info('tool.unregistered', { name: TOOL_NAME, enabled: mirror.enabled, hasKey: mirror.hasKey })
    }
  }

  ctx.inject(['tools'], (toolsCtx) => {
    toolScope = toolsCtx
    toolsCtx.effect(
      () => () => {
        toolScope = null
        toolDisposer = null
      },
    )
    syncTool()
  })

  // --- model guidance ------------------------------------------------------
  const promptText = () => {
    if (!googleReady()) return ''
    const quota =
      mirror.credits === null
        ? `额度未知${mirror.balanceError ? `（${mirror.balanceError}）` : ''}`
        : `剩余 ${mirror.credits} 次`
    return [
      'Google 搜索（来自插件 dsh-global-search）：用户的 Google SERP key 已配置且开关为「开」，你可以调用 `google_search` 工具。',
      `- 每次调用消耗用户 1 次免费额度（${mirror.provider}，${quota}）。`,
      '- 该用：用户明确要 Google/谷歌结果；需要国际或英文一手来源；web_search（Bing 索引）结果明显偏国内或不够权威；需要时新的英文资料。',
      '- 不该用：中文/国内问题、普通查证、用户只想要一个网址 —— 这些用 web_search，不消耗额度。',
      '- 额度低于 20 次时，只在用户明确要求 Google 时使用。',
    ].join('\n')
  }
  ctx.inject(['systemPrompt'], (promptCtx) => {
    promptCtx.effect(() =>
      promptCtx.systemPrompt.section({
        name: 'dsh-global-search:google',
        order: 120,
        interpolate: false,
        text: () => promptText(),
      }),
    )
  })

  // --- per-turn quota refresh ---------------------------------------------
  // "After every conversation turn, read the balance once." `turn/end` is the
  // durable, committed end of a turn, which is exactly that moment.
  ctx.on('session/event', (session, event) => {
    if (event?.type !== 'turn/end') return
    if (!googleReady()) return
    void refreshBalance({ reason: 'turn-end' }).catch((error) =>
      log.warn('google.balance-failed', { error: String(error?.message ?? error) }),
    )
    void session
  })

  // --- control surface -----------------------------------------------------
  const statusPayload = async () => {
    const state = await store.read()
    const credential = credentialFrom(state)
    const provider = resolveProvider(state.google?.key?.provider)
    const descriptor = KEY_PROVIDERS[provider]
    return {
      ok: true,
      version: VERSION,
      google: {
        enabled: state.google?.enabled === true,
        ready: state.google?.enabled === true && Boolean(credential),
        configured: Boolean(credential),
        key: credential
          ? {
              provider,
              source: credential.source,
              masked: maskSecret(credential.secret),
              balanceSupported: descriptor.balanceSupported,
              docs: descriptor.docs,
              label: descriptor.label,
              freeQuota: descriptor.freeQuota,
            }
          : null,
        providers: Object.entries(KEY_PROVIDERS).map(([id, p]) => ({
          id,
          label: p.label,
          docs: p.docs,
          freeQuota: p.freeQuota,
          balanceSupported: p.balanceSupported,
        })),
        balance: {
          credits: Number.isFinite(state.balance?.credits) ? state.balance.credits : null,
          rateLimit: Number.isFinite(state.balance?.rateLimit) ? state.balance.rateLimit : null,
          checkedAt: state.balance?.checkedAt ?? null,
          ageMs: state.balance?.checkedAt ? Date.now() - state.balance.checkedAt : null,
          error: state.balance?.error ?? null,
          unsupported: state.balance?.unsupported ?? null,
        },
        tool: { name: TOOL_NAME, registered: toolDisposer !== null },
      },
      channels: { international: CHANNEL.BING_GLOBAL, domestic: CHANNEL.BING_CN },
      lastChannel: state.lastChannel ?? null,
      lastSearchAt: state.lastSearchAt ?? null,
      logFile: log.file,
      dataDir,
    }
  }

  const routes = [
    {
      kind: 'exact',
      path: '/dsh-global-search/status',
      handler: async (req, res) => {
        if (req.method !== 'GET' && req.method !== 'HEAD') return json(res, 405, { ok: false, error: 'GET only' })
        json(res, 200, await statusPayload())
      },
    },
    {
      kind: 'exact',
      path: '/dsh-global-search/settings',
      handler: async (req, res) => {
        if (req.method === 'GET') return json(res, 200, await statusPayload())
        if (req.method !== 'POST') return json(res, 405, { ok: false, error: 'GET or POST' })
        let body
        try {
          body = await readJsonBody(req)
        } catch (error) {
          return json(res, 400, { ok: false, error: String(error.message ?? error) })
        }
        const state = await store.read()

        if (body?.clearKey === true) {
          await save({ google: { ...state.google, enabled: false, key: null }, balance: { credits: null, rateLimit: null, provider: null, checkedAt: null, error: null } })
          syncTool()
          log.info('google.key-cleared', {})
          return json(res, 200, await statusPayload())
        }

        if (typeof body?.key === 'string' && body.key.trim().length > 0) {
          const secret = body.key.trim()
          if (secret.length < 8) return json(res, 400, { ok: false, error: 'key looks too short (expected at least 8 characters)' })
          const provider = resolveProvider(body.provider)
          await save({ google: { enabled: true, key: { provider, secret } } })
          // Never log the secret itself.
          log.info('google.key-set', { provider, keyLength: secret.length })
          await refreshBalance({ reason: 'key-set' }).catch(() => {})
          syncTool()
          return json(res, 200, await statusPayload())
        }

        if (typeof body?.enabled === 'boolean') {
          if (body.enabled && !credentialFrom(state)) {
            return json(res, 400, { ok: false, error: '配置一个 SERP key 之后才能开启 Google 搜索' })
          }
          await save({ google: { ...state.google, enabled: body.enabled } })
          syncTool()
          log.info('google.toggled', {
            enabled: body.enabled,
            ua: String(req.headers?.['user-agent'] ?? '').slice(0, 80),
            origin: String(req.headers?.origin ?? ''),
            referer: String(req.headers?.referer ?? '').slice(0, 120),
          })
          return json(res, 200, await statusPayload())
        }

        return json(res, 400, { ok: false, error: 'expected { enabled?: boolean } or { key, provider } or { clearKey: true }' })
      },
    },
    {
      kind: 'exact',
      path: '/dsh-global-search/balance',
      handler: async (req, res) => {
        if (req.method !== 'POST' && req.method !== 'GET') return json(res, 405, { ok: false, error: 'GET or POST' })
        const state = await store.read()
        if (!credentialFrom(state)) return json(res, 400, { ok: false, error: 'no Google key configured yet' })
        const balance = await refreshBalance({ reason: 'manual' })
        json(res, 200, { ok: true, balance, status: await statusPayload() })
      },
    },
    {
      kind: 'exact',
      path: '/dsh-global-search/client-error',
      handler: async (req, res) => {
        if (req.method !== 'POST') return json(res, 405, { ok: false, error: 'POST only' })
        let body = null
        try {
          body = await readJsonBody(req)
        } catch (error) {
          return json(res, 400, { ok: false, error: String(error.message ?? error) })
        }
        // The client half renders in the browser, where its stack never reaches the
        // host. This route is the only way a settings-page render failure becomes
        // diagnosable from log.jsonl instead of a user-visible dead card.
        log.warn('client.render-error', {
          where: String(body?.where ?? '').slice(0, 40),
          message: String(body?.message ?? '').slice(0, 400),
          stack: String(body?.stack ?? '').replace(/\s+/g, ' ').slice(0, 800),
          url: String(body?.url ?? '').slice(0, 200),
        })
        json(res, 200, { ok: true })
      },
    },
    {
      kind: 'exact',
      path: '/dsh-global-search/client-heartbeat',
      handler: async (req, res) => {
        if (req.method !== 'POST') return json(res, 405, { ok: false, error: 'POST only' })
        let body = null
        try {
          body = await readJsonBody(req)
        } catch (error) {
          return json(res, 400, { ok: false, error: String(error.message ?? error) })
        }
        // Mount beacon from the browser. A slot occupant can be "registered" and still
        // never render, and the host cannot tell the difference on its own; this line
        // makes "the client is running and this surface is on screen" checkable from
        // log.jsonl without a screenshot.
        log.info('client.mounted', {
          surface: String(body?.surface ?? '').slice(0, 40),
          url: String(body?.url ?? '').slice(0, 160),
        })
        json(res, 200, { ok: true })
      },
    },
    {
      kind: 'exact',
      path: '/dsh-global-search/test',
      handler: async (req, res) => {
        if (req.method !== 'POST') return json(res, 405, { ok: false, error: 'POST only' })
        const url = new URL(req.url ?? '/', 'http://127.0.0.1')
        const query = url.searchParams.get('q') ?? 'tokio async runtime'
        const outcome = await runGoogle(query, 5)
        if (!outcome.ok) {
          return json(res, 200, {
            ok: false,
            query,
            why: outcome.why,
            category: outcome.category ?? null,
            error: outcome.error ? String(outcome.error.message ?? outcome.error) : null,
            status: await statusPayload(),
          })
        }
        json(res, 200, {
          ok: true,
          query,
          provider: outcome.result.provider,
          channel: outcome.result.channel,
          ms: outcome.result.ms,
          credits: outcome.credits,
          sources: outcome.result.sources,
          status: await statusPayload(),
        })
      },
    },
  ]
  for (const route of routes) ctx.effect(() => ctx.webServer.register(route))
  log.info('routes.registered', { paths: routes.map((r) => r.path) })

  // Files an older version of this plugin produced (a bundled tunnel kernel, a node
  // snapshot, a verdict file). They are dead weight and can be hundreds of KB, so the
  // first run of this version deletes them instead of leaving them for the user.
  const LEGACY_ARTIFACTS = ['nodes.yaml', 'kernel-verdict.json', 'kernel.pid', 'proxy.pid', 'config.yaml', 'clash-core.exe', 'dsh-clash-core.exe', 'mihomo.exe']
  async function removeLegacyArtifacts() {
    for (const name of LEGACY_ARTIFACTS) {
      try {
        await rm(path.join(dataDir, name))
        log.info('legacy.removed', { name })
      } catch {
        /* absent is the normal case */
      }
    }
  }

  // A `pnpm add` that is killed (app restart, window closed) leaves staging directories in
  // the profile's node_modules, and the next install spends its run on them instead of
  // finishing — the installer UI then sits at 安装中 while nothing is actually being installed.
  // Startup is the one moment no install can be running, so this is where the plugin clears
  // its own leftovers, before anyone has to diagnose them.
  async function sweepOwnInstallResidue() {
    try {
      // Only a real install has this shape: <profile>/node_modules/<pkg>/lib/index.js.
      // Running from a source checkout (`link:`) must never touch anything.
      const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
      const nodeModules = path.dirname(packageRoot)
      if (path.basename(nodeModules) !== 'node_modules') return
      const profileDir = path.dirname(nodeModules)
      // An operation in flight records its pnpm tree here; never race it.
      if (existsSync(path.join(profileDir, '.plugin-manager', 'run.json'))) return
      const kinds = ['tmp-dir', 'ignored-dir']
      if ((await findResidue(profileDir, name, { kinds })).length === 0) return
      const cleaned = await removeResidue(profileDir, name, { kinds })
      log.info('installer.residue.cleaned', { removed: cleaned.removed.length, failed: cleaned.failed.length })
    } catch (error) {
      log.warn('installer.residue.failed', { error: String(error?.message ?? error) })
    }
  }

  // --- activation ----------------------------------------------------------
  ctx.effect(() => {
    let disposed = false
    ;(async () => {
      await removeLegacyArtifacts()
      await sweepOwnInstallResidue()
      const state = await store.read()
      syncMirror(state)
      syncTool()
      if (disposed) return
      log.info('plugin.ready', { googleEnabled: mirror.enabled, hasKey: mirror.hasKey, tool: toolDisposer !== null })
      // Warm the balance so the settings page has a number without a round trip.
      if (credentialFrom(state)) {
        await refreshBalance({ reason: 'startup' }).catch((error) =>
          log.warn('google.balance-failed', { error: String(error?.message ?? error) }),
        )
      }
    })().catch((error) => log.error('plugin.activation-failed', { error: String(error?.message ?? error) }))
    return () => {
      disposed = true
    }
  })
}
