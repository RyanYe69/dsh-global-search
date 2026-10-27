// Google, through a free-tier SERP key the user owns.
//
// Why a key and not a proxy: on the target host `www.google.com` resolves to
// poisoned addresses, 6 of 7 real Google IPs time out on 443 (the 7th resets TLS),
// and every reachable egress — including a live local proxy — receives Google's
// JavaScript-only shell instead of a result page (Google removed the no-JS SERP).
// A SERP API is the only free route that still returns parseable Google results.
// Measured: serper.dev answers in ~0.7-1.9 s with real `organic` rows.
//
// Nothing here is a bundled credential: the key is supplied by the user at runtime
// (settings page or environment) and stored in the plugin data directory only.

export const GOOGLE_CHANNEL = 'google'

/** A Google failure with a category the caller can log and the model can act on. */
export class GoogleError extends Error {
  constructor(message, category, { provider, cause } = {}) {
    super(message, cause === undefined ? undefined : { cause })
    this.name = 'GoogleError'
    this.category = category
    this.provider = provider
    this.code =
      category === 'timeout'
        ? 'WEB_FETCH_TIMEOUT'
        : category === 'auth'
          ? 'WEB_PROVIDER_ERROR'
          : 'WEB_PROVIDER_ERROR'
  }
}

const organic = (rows, urlKey, snippetKey) =>
  (Array.isArray(rows) ? rows : [])
    .map((r) => ({ url: r?.[urlKey], title: r?.title, snippet: r?.[snippetKey] }))
    .filter((s) => typeof s.url === 'string' && /^https?:\/\//i.test(s.url) && typeof s.title === 'string' && s.title.length > 0)

/**
 * Supported free-tier SERP providers.
 *
 * `balance` exists only where the endpoint was measured on this host (serper;
 * `GET /account` → `{"balance":2493,"rateLimit":5}`). Providers without a measured
 * balance endpoint report `balanceSupported: false` instead of guessing a shape —
 * a wrong balance is worse than an absent one.
 */
export const KEY_PROVIDERS = {
  serper: {
    label: 'serper.dev — 2,500 free queries/month',
    docs: 'https://serper.dev',
    freeQuota: 2500,
    balanceSupported: true,
    search: (q, n, key) => ({
      url: 'https://google.serper.dev/search',
      method: 'POST',
      headers: { 'X-API-KEY': key, 'content-type': 'application/json' },
      body: JSON.stringify({ q, num: n, hl: 'en', gl: 'us' }),
    }),
    parse: (json) => organic(json?.organic, 'link', 'snippet'),
    balance: (key) => ({
      url: 'https://google.serper.dev/account',
      method: 'GET',
      headers: { 'X-API-KEY': key, accept: 'application/json' },
    }),
    parseBalance: (json) => ({
      credits: Number.isFinite(json?.balance) ? json.balance : null,
      rateLimit: Number.isFinite(json?.rateLimit) ? json.rateLimit : null,
    }),
  },
  searchapi: {
    label: 'searchapi.io — 100 free queries',
    docs: 'https://www.searchapi.io',
    freeQuota: 100,
    balanceSupported: false,
    search: (q, n, key) => ({
      url: `https://www.searchapi.io/api/v1/search?engine=google&num=${n}&hl=en&gl=us&q=${encodeURIComponent(q)}&api_key=${encodeURIComponent(key)}`,
      method: 'GET',
    }),
    parse: (json) => organic(json?.organic_results, 'link', 'snippet'),
  },
  serpapi: {
    label: 'serpapi.com — 100 free queries',
    docs: 'https://serpapi.com',
    freeQuota: 100,
    balanceSupported: false,
    search: (q, n, key) => ({
      url: `https://serpapi.com/search.json?engine=google&num=${n}&hl=en&gl=us&q=${encodeURIComponent(q)}&api_key=${encodeURIComponent(key)}`,
      method: 'GET',
    }),
    parse: (json) => organic(json?.organic_results, 'link', 'snippet'),
  },
  zenserp: {
    label: 'zenserp.com — 50 free queries',
    docs: 'https://zenserp.com',
    freeQuota: 50,
    balanceSupported: false,
    search: (q, n, key) => ({
      url: `https://app.zenserp.com/api/v2/search?q=${encodeURIComponent(q)}&num=${n}&hl=en&gl=us`,
      method: 'GET',
      headers: { apikey: key },
    }),
    parse: (json) => organic(json?.organic, 'url', 'description'),
  },
  valueserp: {
    label: 'valueserp.com — 100 free queries',
    docs: 'https://www.valueserp.com',
    freeQuota: 100,
    balanceSupported: false,
    search: (q, n, key) => ({
      url: `https://api.valueserp.com/search?q=${encodeURIComponent(q)}&num=${n}&hl=en&gl=us&api_key=${encodeURIComponent(key)}`,
      method: 'GET',
    }),
    parse: (json) => organic(json?.organic_results, 'link', 'snippet'),
  },
}

/** Which provider a key belongs to: an explicit choice wins, otherwise serper. */
export function resolveProvider(explicit) {
  return typeof explicit === 'string' && KEY_PROVIDERS[explicit] ? explicit : 'serper'
}

async function readJson(res, providerName, what) {
  const text = await res.text()
  try {
    return JSON.parse(text)
  } catch {
    throw new GoogleError(`${providerName} returned non-JSON for ${what} (first 120 bytes: ${text.slice(0, 120)})`, 'parse', {
      provider: providerName,
    })
  }
}

/**
 * One Google search through the configured key.
 * Returns { channel, provider, sources, ms } or throws GoogleError.
 */
export async function searchGoogle({ query, maxResults = 10, credential, timeoutMs = 12000, signal }) {
  const key = String(credential?.secret ?? '').trim()
  if (key.length === 0) throw new GoogleError('no Google key configured', 'auth')
  const providerName = resolveProvider(credential?.provider)
  const provider = KEY_PROVIDERS[providerName]
  const req = provider.search(query, maxResults, key)
  const started = Date.now()
  let res
  try {
    res = await fetch(req.url, {
      method: req.method,
      headers: { accept: 'application/json', ...(req.headers ?? {}) },
      body: req.body,
      redirect: 'follow',
      signal: signal ?? AbortSignal.timeout(timeoutMs),
    })
  } catch (error) {
    const code = String(error?.cause?.code ?? error?.name ?? error?.message ?? error)
    throw new GoogleError(`${providerName} unreachable (${code})`, /timeout|abort/i.test(code) ? 'timeout' : 'network', {
      provider: providerName,
      cause: error,
    })
  }
  if (res.status === 401 || res.status === 403) {
    throw new GoogleError(`${providerName} rejected the key (HTTP ${res.status}) — check the key in Settings › 外网搜索`, 'auth', { provider: providerName })
  }
  if (res.status === 429) throw new GoogleError(`${providerName} rate limited this key (HTTP 429)`, 'rate-limit', { provider: providerName })
  if (!res.ok) throw new GoogleError(`${providerName} returned HTTP ${res.status}`, 'http', { provider: providerName })
  const json = await readJson(res, providerName, 'the search request')
  const sources = provider.parse(json).slice(0, maxResults)
  if (sources.length === 0) throw new GoogleError(`${providerName} returned no organic results`, 'empty', { provider: providerName })
  return { channel: GOOGLE_CHANNEL, provider: providerName, sources, ms: Date.now() - started }
}

/**
 * Read the remaining free quota for the configured provider.
 * Returns { provider, credits, rateLimit, checkedAt, unsupported? }.
 * Never throws: a balance read is diagnostics, it must not break a turn.
 */
export async function readBalance({ credential, timeoutMs = 8000 } = {}) {
  const key = String(credential?.secret ?? '').trim()
  const providerName = resolveProvider(credential?.provider)
  const provider = KEY_PROVIDERS[providerName]
  const checkedAt = Date.now()
  if (key.length === 0 || !provider?.balanceSupported) {
    return {
      provider: providerName,
      credits: null,
      rateLimit: null,
      checkedAt,
      unsupported: key.length === 0 ? 'no-key' : 'provider-has-no-balance-endpoint',
    }
  }
  const req = provider.balance(key)
  try {
    const res = await fetch(req.url, {
      method: req.method,
      headers: { accept: 'application/json', ...(req.headers ?? {}) },
      signal: AbortSignal.timeout(timeoutMs),
    })
    if (!res.ok) {
      return { provider: providerName, credits: null, rateLimit: null, checkedAt, error: `HTTP ${res.status}` }
    }
    const json = await readJson(res, providerName, 'the balance request')
    const parsed = provider.parseBalance(json)
    return { provider: providerName, credits: parsed.credits, rateLimit: parsed.rateLimit, checkedAt }
  } catch (error) {
    return { provider: providerName, credits: null, rateLimit: null, checkedAt, error: String(error?.message ?? error) }
  }
}
