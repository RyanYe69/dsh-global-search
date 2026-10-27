// Host integration test: drives the real `apply()` against a minimal Cordis-shaped
// ctx — registered providers, the model-facing tool, the control routes, and the
// per-turn quota refresh. Network is stubbed; no DSH process is involved.
//
//   node tools/test-host.mjs
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const PKG_VERSION = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version

let pass = 0
let fail = 0
const failures = []

function ok(name, condition, detail) {
  if (condition) {
    pass += 1
    console.log(`  PASS ${name}`)
  } else {
    fail += 1
    failures.push({ name, detail })
    console.log(`  FAIL ${name}${detail === undefined ? '' : ` — ${detail}`}`)
  }
}
const eq = (name, actual, expected) =>
  ok(name, JSON.stringify(actual) === JSON.stringify(expected), `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`)
const section = (title) => console.log(`\n${title}`)

// --- fetch stub ------------------------------------------------------------
const seen = []
let responder = () => ({ status: 500, body: '{}' })
globalThis.fetch = async (url, init = {}) => {
  const target = String(url)
  seen.push({ url: target, method: init.method ?? 'GET', body: init.body ? String(init.body) : null })
  const { status, body, headers } = responder(target, init)
  const text = typeof body === 'string' ? body : JSON.stringify(body)
  const map = new Map(Object.entries(headers ?? {}))
  return {
    ok: status >= 200 && status < 300,
    status,
    url: target,
    headers: { get: (name) => map.get(String(name).toLowerCase()) ?? null },
    text: async () => text,
  }
}
const countOf = (fragment) => seen.filter((c) => c.url.includes(fragment)).length

const BING_HTML = `<ol id="b_results">
<li class="b_algo"><h2><a href="https://tokio.rs/">Tokio</a></h2><p class="b_lineclamp2">async runtime</p></li>
</ol>`

responder = (url) => {
  if (url.includes('/account')) return { status: 200, body: { balance: 2493, rateLimit: 5 } }
  if (url.includes('serper.dev/search')) return { status: 200, body: { organic: [{ link: 'https://tokio.rs/', title: 'Tokio', snippet: 'async runtime' }] } }
  if (url.includes('cn.bing.com')) return { status: 200, body: BING_HTML }
  if (url.includes('example.com')) return { status: 200, body: '<html>ok</html>', headers: { 'content-type': 'text/html' } }
  return { status: 404, body: '{}' }
}

// --- ctx mock --------------------------------------------------------------
function makeContext() {
  const state = {
    routes: new Map(),
    tools: new Map(),
    sections: [],
    listeners: new Map(),
    searchProvider: null,
    fetchProvider: null,
    disposers: [],
  }
  const makeEffect = () => (fn) => {
    const disposer = fn()
    state.disposers.push(typeof disposer === 'function' ? disposer : () => {})
    return () => {}
  }
  const toolScope = {
    tools: {
      register: (definition) => {
        state.tools.set(definition.name, definition)
        return () => state.tools.delete(definition.name)
      },
    },
    effect: makeEffect(),
  }
  const promptScope = {
    systemPrompt: {
      section: (s) => {
        state.sections.push(s)
        return () => {}
      },
    },
    effect: makeEffect(),
  }
  const ctx = {
    web: {
      registerSearchProvider: (p) => {
        state.searchProvider = p
        return () => {}
      },
      registerFetchProvider: (p) => {
        state.fetchProvider = p
        return () => {}
      },
    },
    webServer: {
      register: (route) => {
        state.routes.set(route.path, route)
        return () => state.routes.delete(route.path)
      },
    },
    effect: makeEffect(),
    on: (event, listener) => {
      state.listeners.set(event, listener)
      return () => {}
    },
    inject: (deps, callback) => {
      callback(deps.includes('tools') ? toolScope : promptScope)
      return () => {}
    },
  }
  return { ctx, state }
}

function makeReq({ method = 'GET', url = '/', body }) {
  const listeners = new Map()
  const req = {
    method,
    url,
    on(event, fn) {
      const list = listeners.get(event) ?? []
      list.push(fn)
      listeners.set(event, list)
      return req
    },
    destroy() {},
  }
  queueMicrotask(() => {
    if (body !== undefined) for (const fn of listeners.get('data') ?? []) fn(Buffer.from(body))
    for (const fn of listeners.get('end') ?? []) fn()
  })
  return req
}

function makeRes() {
  const res = { status: 0, headers: null, text: '' }
  res.writeHead = (status, headers) => {
    res.status = status
    res.headers = headers
  }
  res.end = (chunk) => {
    res.text = chunk ?? ''
    try {
      res.body = JSON.parse(res.text)
    } catch {
      res.body = null
    }
  }
  return res
}

async function call(state, pathName, { method = 'GET', body, url } = {}) {
  const route = state.routes.get(pathName)
  if (!route) throw new Error(`route not registered: ${pathName}`)
  const res = makeRes()
  await route.handler(makeReq({ method, url: url ?? pathName, body: body === undefined ? undefined : JSON.stringify(body) }), res)
  return res
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// --- phase A: fresh install, no key ---------------------------------------
section('A. fresh install (no key)')
const homeA = mkdtempSync(path.join(os.tmpdir(), 'dsh-gs-a-'))
process.env.DSH_HOME = homeA
const { apply } = await import('../lib/index.js')
const a = makeContext()
apply(a.ctx, { maxResults: 10 })
await sleep(120)

eq('registers six control routes', [...a.state.routes.keys()].sort(), [
  '/dsh-global-search/balance',
  '/dsh-global-search/client-error',
  '/dsh-global-search/client-heartbeat',
  '/dsh-global-search/settings',
  '/dsh-global-search/status',
  '/dsh-global-search/test',
])
ok('registers the search provider', a.state.searchProvider?.id === 'dsh-global-search')
ok('registers the fetch provider', a.state.fetchProvider?.id === 'dsh-global-search')
ok('registers a system-prompt section', a.state.sections.some((s) => s.name === 'dsh-global-search:google'))
eq('prompt section is empty while Google is off', a.state.sections[0].text(), '')

let status = (await call(a.state, '/dsh-global-search/status')).body
eq('status http 200', (await call(a.state, '/dsh-global-search/status')).status, 200)
eq('version matches package.json', status.version, PKG_VERSION)
eq('google disabled on a fresh install', status.google.enabled, false)
eq('no key configured', status.google.configured, false)
eq('tool not registered without a key', status.google.tool.registered, false)
eq('no tool in the registry', a.state.tools.size, 0)
eq('balance unknown before a key exists', status.google.balance.credits, null)
ok('status reports the log path', String(status.logFile).endsWith('log.jsonl'))

section('A. a render error reported by the page becomes a log line')
const reported = await call(a.state, '/dsh-global-search/client-error', {
  method: 'POST',
  body: { where: 'panel', message: 'TypeError: useCallback is not a function', stack: 'at Panel (client.js:1)' },
})
eq('client-error accepts a report', reported.status, 200)
await sleep(150)
const logText = readFileSync(path.join(homeA, 'dsh-global-search', 'log.jsonl'), 'utf8')
ok('render error lands in log.jsonl', logText.includes('client.render-error'))
ok('log keeps the message, not just an event name', logText.includes('useCallback is not a function'))
eq('client-error is POST only', (await call(a.state, '/dsh-global-search/client-error')).status, 405)

section('A. enabling Google without a key is refused')
const refused = await call(a.state, '/dsh-global-search/settings', { method: 'POST', body: { enabled: true } })
eq('refused with 400', refused.status, 400)
ok('refusal explains why', /key/.test(refused.body?.error ?? ''))

// --- phase B: save a key ---------------------------------------------------
section('B. saving a key turns Google on')
const saved = await call(a.state, '/dsh-global-search/settings', { method: 'POST', body: { key: 'k'.repeat(40), provider: 'serper' } })
eq('save returns 200', saved.status, 200)
status = saved.body
eq('google now enabled', status.google.enabled, true)
eq('google now ready', status.google.ready, true)
eq('key is masked, never echoed', status.google.key.masked, 'kkkk…kk')
eq('key source is state', status.google.key.source, 'state')
eq('provider advertised as balance-capable', status.google.key.balanceSupported, true)
eq('balance read on save', status.google.balance.credits, 2493)
eq('rate limit recorded', status.google.balance.rateLimit, 5)
eq('tool registered after key save', status.google.tool.registered, true)
ok('tool exists in the registry', a.state.tools.has('google_search'))
ok('prompt section now describes Google', a.state.sections[0].text().includes('google_search'))

const statePath = path.join(homeA, 'dsh-global-search', 'state.json')
const onDisk = JSON.parse(readFileSync(statePath, 'utf8'))
eq('key persisted to the plugin data dir', Boolean(onDisk.google.key.secret), true)
eq('raw secret never appears in status', JSON.stringify(status).includes('k'.repeat(40)), false)

section('B. the tool definition the model sees')
const tool = a.state.tools.get('google_search')
eq('tool name', tool.name, 'google_search')
eq('tool requires a query', tool.parameters.required, ['query'])
ok('tool explains the quota cost', /quota/.test(tool.description))
ok('tool explains when NOT to use it', /do NOT use/.test(tool.description))

section('B. calling the tool')
const toolValue = await tool.execute({ query: 'tokio async runtime', reason: 'test' }, {})
eq('tool output schema is a JSON-Schema string', tool.output.schema.type, 'string')
eq('tool returns a string', typeof toolValue, 'string')
ok('tool text lists the URL', toolValue.includes('https://tokio.rs/'))
ok('tool text names the provider', toolValue.includes('serper'))
ok('tool text carries the remaining quota', toolValue.includes('剩余 2493 次'))
const rendered = tool.output.render({}, toolValue)
eq('tool renders text content', rendered[0].type, 'text')
ok('rendered content is the model-facing text', rendered[0].text === toolValue)
section('B. the tool rejects empty input')
const empty = await tool.execute({}, {})
ok('empty query returns guidance, not a throw', typeof empty === 'string' && empty.includes('empty query'))

section('B. turning Google off removes the tool')
const off = await call(a.state, '/dsh-global-search/settings', { method: 'POST', body: { enabled: false } })
eq('toggle returns 200', off.status, 200)
eq('google disabled', off.body.google.enabled, false)
eq('tool unregistered', off.body.google.tool.registered, false)
eq('registry is empty again', a.state.tools.size, 0)
const staleCall = await tool.execute({ query: 'x' }, {})
ok('a stale tool handle explains the switch instead of searching', String(staleCall).includes('关闭'))
eq('prompt section cleared', a.state.sections[0].text(), '')
const onAgain = await call(a.state, '/dsh-global-search/settings', { method: 'POST', body: { enabled: true } })
eq('toggle back on re-registers the tool', onAgain.body.google.tool.registered, true)

section('B. the test route spends one credit and reports results')
const tested = await call(a.state, '/dsh-global-search/test', { method: 'POST', url: '/dsh-global-search/test?q=tokio' })
eq('test route 200', tested.status, 200)
eq('test route ok', tested.body.ok, true)
eq('test route uses Google', tested.body.channel, 'google')
eq('test route includes status', tested.body.status.version, PKG_VERSION)

section('B. clearing the key disables everything')
const cleared = await call(a.state, '/dsh-global-search/settings', { method: 'POST', body: { clearKey: true } })
eq('clear returns 200', cleared.status, 200)
eq('key gone', cleared.body.google.configured, false)
eq('google disabled', cleared.body.google.enabled, false)
eq('tool gone', a.state.tools.size, 0)
eq('balance reset', cleared.body.google.balance.credits, null)
const onCleared = JSON.parse(readFileSync(statePath, 'utf8'))
eq('cleared key persisted as null', onCleared.google.key, null)

// --- phase C: providers ----------------------------------------------------
section('C. web_search routing (Bing)')
process.env.DSH_HOME = homeA
const en = await a.state.searchProvider.search({ query: 'rust async runtime', maxResults: 5 })
eq('english query uses the international index', en.sources.length, 1)
eq('english query hits ensearch=1', /ensearch=1/.test(seen.at(-1).url), true)
const cn = await a.state.searchProvider.search({ query: '国产操作系统', maxResults: 5 })
eq('chinese query returns results', cn.sources.length, 1)
eq('chinese query avoids ensearch', /ensearch=1/.test(seen.at(-1).url), false)

section('C. web_fetch (direct only)')
const fetched = await a.state.fetchProvider.fetch({ url: 'https://example.com/page' })
eq('fetch kind', fetched.body.kind, 'html')
eq('fetch status', fetched.statusCode, 200)
responder = (url) => {
  if (url.includes('blocked.invalid')) throw Object.assign(new Error('connect ECONNREFUSED 203.0.113.9:443'), { cause: { code: 'ECONNREFUSED' } })
  return { status: 200, body: BING_HTML }
}
try {
  await a.state.fetchProvider.fetch({ url: 'https://blocked.invalid/' })
  ok('fetch failure throws', false)
} catch (error) {
  ok('fetch failure names the address', String(error.message).includes('https://blocked.invalid/'))
  ok('fetch failure is a web error', typeof error.code === 'string')
}

// --- phase D: per-turn balance refresh ------------------------------------
section('D. turn-end quota refresh')
const homeD = mkdtempSync(path.join(os.tmpdir(), 'dsh-gs-d-'))
mkdirSync(path.join(homeD, 'dsh-global-search'), { recursive: true })
writeFileSync(
  path.join(homeD, 'dsh-global-search', 'state.json'),
  `${JSON.stringify(
    {
      google: { enabled: true, key: { provider: 'serper', secret: 'k'.repeat(40) } },
      balance: { credits: 2500, rateLimit: 5, provider: 'serper', checkedAt: 1, error: null },
    },
    null,
    2,
  )}\n`,
  'utf8',
)
process.env.DSH_HOME = homeD
responder = (url) => (url.includes('/account') ? { status: 200, body: { balance: 2492, rateLimit: 5 } } : { status: 200, body: BING_HTML })
const d = makeContext()
apply(d.ctx, { maxResults: 10 })
await sleep(150)

const before = countOf('/account')
const listener = d.state.listeners.get('session/event')
ok('session/event listener registered', typeof listener === 'function')
listener({ id: 's1' }, { type: 'turn/end', seq: 42, data: { turn: 1 } })
await sleep(250)
const after = countOf('/account')
eq('turn end read the balance once', after - before, 1)
const statusD = (await call(d.state, '/dsh-global-search/status')).body
eq('balance updated from the provider', statusD.google.balance.credits, 2492)

listener({ id: 's1' }, { type: 'turn/end', seq: 44, data: { turn: 2 } })
await sleep(250)
eq('every turn end reads the balance once more', countOf('/account') - after, 1)
listener({ id: 's1' }, { type: 'user/message', seq: 45, data: {} })
await sleep(120)
eq('unrelated session events do not read the balance', countOf('/account') - after, 1)

eq('failures recorded in state', statusD.ok, true)

// --- cleanup ---------------------------------------------------------------
rmSync(homeA, { recursive: true, force: true })
rmSync(homeD, { recursive: true, force: true })

console.log(`\n${'='.repeat(52)}`)
console.log(`host: ${pass} passed, ${fail} failed, ${pass + fail} total`)
if (fail > 0) {
  for (const f of failures) console.log(`  · ${f.name} — ${f.detail}`)
  process.exit(1)
}
