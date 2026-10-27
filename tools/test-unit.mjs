// Unit tests for the pure parts: Bing parsing, query routing, and the Google
// channel (search + balance) against a stubbed fetch. No network, no DSH.
//
//   node tools/test-unit.mjs
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

function eq(name, actual, expected) {
  ok(name, JSON.stringify(actual) === JSON.stringify(expected), `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`)
}

function section(title) {
  console.log(`\n${title}`)
}

// --- fetch stub ------------------------------------------------------------
// Every Google call in this file goes through the plugin's real `fetch`, so the
// stub has to be installed before the modules are imported.
const calls = []
let responder = () => ({ status: 500, body: '{"error":"no responder"}' })
globalThis.fetch = async (url, init = {}) => {
  calls.push({ url: String(url), method: init.method ?? 'GET', headers: init.headers ?? {}, body: init.body ? String(init.body) : null })
  const { status, body, headers } = responder(String(url), init)
  const text = typeof body === 'string' ? body : JSON.stringify(body)
  return {
    ok: status >= 200 && status < 300,
    status,
    url: String(url),
    headers: { get: (name) => (headers ?? {})[name.toLowerCase()] ?? null },
    text: async () => text,
    json: async () => JSON.parse(text),
  }
}

const { CHANNEL, classifyNetworkError, decodeBingHref, isCJK, parseBingHtml, searchBing, fetchDirect } = await import('../lib/channels.js')
const { KEY_PROVIDERS, readBalance, resolveProvider, searchGoogle } = await import('../lib/google.js')

// --- channels --------------------------------------------------------------
section('channels: Bing decoding and parsing')

eq('decodeBingHref decodes the a1 payload', decodeBingHref('https://www.bing.com/ck/a?!&&p=abc&u=a1aHR0cHM6Ly9ydXN0LWxhbmcub3JnLw&ntb=1'), 'https://rust-lang.org/')
eq('decodeBingHref leaves plain URLs alone', decodeBingHref('https://example.com/x'), 'https://example.com/x')

const bingHtml = `<ol id="b_results">
<li class="b_algo"><h2><a href="https://www.bing.com/ck/a?!&&u=a1aHR0cHM6Ly90b2tpby5ycy8&ntb=1">Tokio</a></h2><div class="b_caption"><p class="b_lineclamp2">An async Rust runtime.</p></div></li>
<li class="b_algo"><h2><a href="https://github.com/tokio-rs/tokio">tokio-rs/tokio</a></h2><p class="b_lineclamp3">Repo &amp; docs.</p></li>
</ol>`
const parsed = parseBingHtml(bingHtml, { maxResults: 10 })
eq('parseBingHtml finds both results', parsed.length, 2)
eq('parseBingHtml unwraps the tracking URL', parsed[0].url, 'https://tokio.rs/')
eq('parseBingHtml keeps titles', parsed[0].title, 'Tokio')
eq('parseBingHtml keeps snippets and unescapes entities', parsed[1].snippet, 'Repo & docs.')
eq('parseBingHtml honours maxResults', parseBingHtml(bingHtml, { maxResults: 1 }).length, 1)
eq('parseBingHtml tolerates unknown markup', parseBingHtml('<html>nope</html>').length, 0)

section('channels: query routing')
ok('isCJK: Chinese query → CN index', isCJK('国产操作系统'))
ok('isCJK: English query → international index', !isCJK('rust async runtime'))
ok('isCJK: mixed with mostly English stays international', !isCJK('tokio runtime 介绍'))

section('channels: error classification')
eq('ENOTFOUND → dns', classifyNetworkError(Object.assign(new Error('x'), { cause: { code: 'ENOTFOUND' } })).category, 'dns')
eq('ECONNRESET → reset', classifyNetworkError(Object.assign(new Error('x'), { code: 'ECONNRESET' })).category, 'reset')
eq('cert error → tls', classifyNetworkError(Object.assign(new Error('certificate has expired'), { code: 'CERT_HAS_EXPIRED' })).category, 'tls')
eq('abort → timeout', classifyNetworkError(Object.assign(new Error('The operation was aborted due to timeout'), { name: 'AbortError' })).category, 'timeout')

section('channels: searchBing against a stubbed index')
responder = () => ({ status: 200, body: bingHtml })
const intl = await searchBing({ query: 'rust async runtime', international: true, maxResults: 5 })
eq('international request sets ensearch=1', /ensearch=1/.test(calls.at(-1).url), true)
eq('international channel id', intl.channel, CHANNEL.BING_GLOBAL)
eq('international results parsed', intl.sources.length, 2)
await searchBing({ query: '国产操作系统', international: false, maxResults: 5 })
eq('domestic request has no ensearch', /ensearch=1/.test(calls.at(-1).url), false)
responder = () => ({ status: 200, body: '<html>no results</html>' })
try {
  await searchBing({ query: 'x', international: true })
  ok('empty SERP throws', false)
} catch (error) {
  eq('empty SERP throws with category parse', error.category, 'parse')
}

section('channels: direct fetch shape')
responder = () => ({ status: 200, body: '<html>hello</html>', headers: { 'content-type': 'text/html; charset=utf-8' } })
const fetched = await fetchDirect({ url: 'https://example.com/' })
eq('fetch reports html kind', fetched.body.kind, 'html')
eq('fetch reports status', fetched.statusCode, 200)
responder = () => {
  throw Object.assign(new Error('getaddrinfo ENOTFOUND nope.invalid'), { cause: { code: 'ENOTFOUND' } })
}
try {
  await fetchDirect({ url: 'https://nope.invalid/' })
  ok('direct fetch failure throws', false)
} catch (error) {
  eq('direct fetch failure is classified', error.category, 'dns')
}

// --- google ----------------------------------------------------------------
section('google: provider registry')
eq('serper is the default provider', resolveProvider(undefined), 'serper')
eq('unknown provider falls back to serper', resolveProvider('nope'), 'serper')
eq('serper advertises a balance endpoint', KEY_PROVIDERS.serper.balanceSupported, true)
eq('searchapi honestly reports no balance endpoint', KEY_PROVIDERS.searchapi.balanceSupported, false)
ok('serper parses organic rows', KEY_PROVIDERS.serper.parse({ organic: [{ link: 'https://a.test/', title: 'A', snippet: 's' }] }).length === 1)

section('google: search through a stubbed SERP API')
const goodBody = { organic: [{ link: 'https://tokio.rs/', title: 'Tokio', snippet: 'async runtime' }, { link: 'https://github.com/tokio-rs/tokio', title: 'tokio-rs/tokio', snippet: 'repo' }] }
responder = () => ({ status: 200, body: goodBody })
const g1 = await searchGoogle({ query: 'tokio', maxResults: 5, credential: { provider: 'serper', secret: 'k'.repeat(40) } })
eq('google channel id', g1.channel, 'google')
eq('google provider echoed', g1.provider, 'serper')
eq('google parses organic results', g1.sources.length, 2)
eq('google sends the key header', calls.at(-1).headers['X-API-KEY'], 'k'.repeat(40))
eq('google posts the query as JSON', JSON.parse(calls.at(-1).body).q, 'tokio')

responder = () => ({ status: 403, body: '{"message":"Unauthorized"}' })
try {
  await searchGoogle({ query: 'x', credential: { provider: 'serper', secret: 'bad-key-123' } })
  ok('403 throws', false)
} catch (error) {
  eq('403 → auth category', error.category, 'auth')
}
responder = () => ({ status: 429, body: '{}' })
try {
  await searchGoogle({ query: 'x', credential: { provider: 'serper', secret: 'k'.repeat(20) } })
  ok('429 throws', false)
} catch (error) {
  eq('429 → rate-limit category', error.category, 'rate-limit')
}
responder = () => ({ status: 200, body: { organic: [] } })
try {
  await searchGoogle({ query: 'x', credential: { provider: 'serper', secret: 'k'.repeat(20) } })
  ok('empty organic throws', false)
} catch (error) {
  eq('empty organic → empty category', error.category, 'empty')
}
try {
  await searchGoogle({ query: 'x', credential: null })
  ok('missing credential throws', false)
} catch (error) {
  eq('missing credential → auth', error.category, 'auth')
}

section('google: balance')
responder = () => ({ status: 200, body: { balance: 2493, rateLimit: 5 } })
const b1 = await readBalance({ credential: { provider: 'serper', secret: 'k'.repeat(40) } })
eq('balance reads credits', b1.credits, 2493)
eq('balance reads rate limit', b1.rateLimit, 5)
eq('balance hits the /account endpoint', calls.at(-1).url, 'https://google.serper.dev/account')
eq('balance returns no error', b1.error, undefined)

responder = () => ({ status: 500, body: 'boom' })
const b2 = await readBalance({ credential: { provider: 'serper', secret: 'k'.repeat(40) } })
eq('failed balance read reports the HTTP status', b2.error, 'HTTP 500')
eq('failed balance read leaves credits null', b2.credits, null)

const b3 = await readBalance({ credential: { provider: 'searchapi', secret: 'k'.repeat(40) } })
eq('provider without a balance endpoint is unsupported', b3.unsupported, 'provider-has-no-balance-endpoint')

const b4 = await readBalance({ credential: null })
eq('balance without a key is unsupported', b4.unsupported, 'no-key')

// --- summary ---------------------------------------------------------------
console.log(`\n${'='.repeat(52)}`)
console.log(`unit: ${pass} passed, ${fail} failed, ${pass + fail} total`)
if (fail > 0) {
  for (const f of failures) console.log(`  · ${f.name} — ${f.detail}`)
  process.exit(1)
}
