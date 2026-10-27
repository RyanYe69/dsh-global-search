// Retrieval channels: the Bing HTML indexes and plain direct fetch.
//
// Every channel is one function that takes a timeout and returns
//   { channel, sources, ms } | throws ChannelError
// so the caller can log which link was tried, why, and for how long. Nothing here
// touches global state, system networking, or a proxy: the plugin's whole network
// surface is "make an HTTPS request and parse the answer".
//
// Deliberately absent: a DuckDuckGo channel and a tunnel transport. Both were
// measured on the target host and neither could be reached from it (0 of 946 free
// nodes ever passed a strict 204 health check), so shipping them only added code
// that never ran. Google lives in `google.js` as a key-backed channel instead.

export const UA_BROWSER =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'

export const CHANNEL = {
  BING_GLOBAL: 'bing-global',
  BING_CN: 'bing-cn',
}

/** A channel failure that carries a machine-routable category. */
export class ChannelError extends Error {
  constructor(message, category, { channel, cause } = {}) {
    super(message, cause === undefined ? undefined : { cause })
    this.name = 'ChannelError'
    this.code =
      category === 'timeout' ? 'WEB_FETCH_TIMEOUT' : category === 'invalid' ? 'WEB_INVALID_URL' : 'WEB_PROVIDER_ERROR'
    this.category = category
    this.channel = channel
  }
}

/** True when the query is mostly Chinese/Japanese/Korean script (route to the CN index). */
export function isCJK(query) {
  const cjk = (query.match(/[\u3400-\u9FFF\uF900-\uFAFF\u3040-\u30FF\uAC00-\uD7AF]/g) ?? []).length
  return cjk >= Math.max(1, Math.floor(query.replace(/\s/g, '').length * 0.4))
}

const ENTITIES = { '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'", '&#x27;': "'", '&nbsp;': ' ' }
const unescape = (s) => s.replace(/&(?:amp|lt|gt|quot|#39|#x27|nbsp);/g, (m) => ENTITIES[m] ?? m)
const stripTags = (s) => unescape(s.replace(/<[^>]*>/g, '')).replace(/\s+/g, ' ').trim()

/**
 * Bing wraps result links in `https://www.bing.com/ck/a?...&u=a1<base64url>`.
 * The payload is the destination URL prefixed with the literal `a1`; decode it so
 * the model receives real destinations instead of bing.com click-tracking URLs.
 */
export function decodeBingHref(href) {
  const raw = unescape(href)
  if (!/bing\.com\/ck\/a/i.test(raw)) return raw
  const m = /[?&]u=a1([A-Za-z0-9_\-]+)/.exec(raw)
  if (!m) return raw
  try {
    const b64 = m[1].replace(/-/g, '+').replace(/_/g, '/')
    const desliced = b64 + '='.repeat((4 - (b64.length % 4)) % 4)
    const out = Buffer.from(desliced, 'base64').toString('utf8')
    return /^https?:\/\//i.test(out) ? out : raw
  } catch {
    return raw
  }
}

/** Parse a Bing SERP into sources. Unknown markup degrades to fewer results, never to a throw. */
export function parseBingHtml(html, { maxResults = 10 } = {}) {
  const sources = []
  const seen = new Set()
  const blocks = html.split(/<li class="b_algo"/).slice(1)
  for (const block of blocks) {
    const anchor = /<h2[^>]*>\s*<a[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/i.exec(block)
    if (!anchor) continue
    const url = decodeBingHref(anchor[1])
    if (!/^https?:\/\//i.test(url) || seen.has(url)) continue
    const title = stripTags(anchor[2])
    if (title.length === 0) continue
    seen.add(url)
    const snippetMatch =
      /<p[^>]*class="[^"]*b_lineclamp[^"]*"[^>]*>([\s\S]*?)<\/p>/i.exec(block) ??
      /<div class="b_caption"[^>]*>\s*<p[^>]*>([\s\S]*?)<\/p>/i.exec(block)
    const snippet = snippetMatch ? stripTags(snippetMatch[1]) : undefined
    sources.push({ url, title, ...(snippet !== undefined && snippet.length > 0 ? { snippet } : {}) })
    if (sources.length >= maxResults) break
  }
  return sources
}

/** Map a thrown transport error to a failure category the log and the model can act on. */
export function classifyNetworkError(error) {
  const code = String(error?.cause?.code ?? error?.code ?? error?.name ?? '')
  const message = String(error?.cause?.message ?? error?.message ?? error)
  if (/^(ENOTFOUND|EAI_AGAIN|EAI_NODATA)$/.test(code)) return { category: 'dns', code, message }
  if (/^(CERT_|UNABLE_TO_VERIFY|ERR_TLS|DEPTH_ZERO)/.test(code) || /certificate|self.signed|SSL/i.test(message))
    return { category: 'tls', code, message }
  if (/^(ECONNRESET|ECONNREFUSED|ECONNABORTED|EPIPE|UND_ERR_SOCKET|UND_ERR_CLOSED)/.test(code) || /reset|closed/i.test(message))
    return { category: 'reset', code, message }
  if (/Timeout|ABORT_ERR|ETIMEDOUT|UND_ERR_CONNECT_TIMEOUT/i.test(code) || /timed? ?out/i.test(message))
    return { category: 'timeout', code, message }
  return { category: 'unknown', code, message }
}

/**
 * One Bing index. `international: true` selects the international index through
 * `ensearch=1` on cn.bing.com — measured on the target host at 130-470 ms, and the
 * only index that returns foreign sites from inside the network.
 */
export async function searchBing({ query, international, maxResults = 10, timeoutMs = 12000, signal }) {
  const started = Date.now()
  const params = new URLSearchParams({ q: query, count: String(Math.min(30, Math.max(maxResults, 10))) })
  if (international) {
    params.set('ensearch', '1')
    params.set('mkt', 'en-US')
    params.set('setlang', 'en')
  }
  const url = `https://cn.bing.com/search?${params.toString()}`
  const channel = international ? CHANNEL.BING_GLOBAL : CHANNEL.BING_CN
  let res
  try {
    res = await fetch(url, {
      headers: {
        'user-agent': UA_BROWSER,
        accept: 'text/html,application/xhtml+xml',
        'accept-language': international ? 'en-US,en;q=0.9' : 'zh-CN,zh;q=0.9,en;q=0.8',
      },
      redirect: 'follow',
      signal: signal ?? AbortSignal.timeout(timeoutMs),
    })
  } catch (error) {
    const { category, message } = classifyNetworkError(error)
    throw new ChannelError(`bing ${international ? 'international' : 'domestic'} index unreachable (${category}): ${message}`, category, { channel, cause: error })
  }
  if (!res.ok) throw new ChannelError(`bing returned HTTP ${res.status}`, 'http', { channel })
  const html = await res.text()
  const sources = parseBingHtml(html, { maxResults })
  if (sources.length === 0) throw new ChannelError('bing returned a page with no parseable results (markup may have changed)', 'parse', { channel })
  return { channel, sources, ms: Date.now() - started, url }
}

/** Direct fetch of one URL, shaped exactly like the web seam's fetch result. */
export async function fetchDirect({ url, timeoutMs = 20000, maxChars = 100000 }) {
  const started = Date.now()
  let res
  let text
  try {
    res = await fetch(url, {
      headers: {
        'user-agent': UA_BROWSER,
        accept: 'text/html,application/xhtml+xml,text/*;q=0.9,application/json;q=0.8',
        'accept-language': 'en-US,en;q=0.9',
      },
      redirect: 'follow',
      signal: AbortSignal.timeout(timeoutMs),
    })
    text = await res.text()
  } catch (error) {
    const { category, message } = classifyNetworkError(error)
    throw new ChannelError(`direct fetch failed (${category}): ${message}`, category, { cause: error })
  }
  const contentType = res.headers.get('content-type') ?? ''
  const mime = contentType.replace(/;.*$/, '').trim().toLowerCase()
  const kind = mime === 'text/html' || mime === 'application/xhtml+xml' ? 'html' : 'text'
  const truncated = text.length > maxChars
  return {
    url: res.url,
    statusCode: res.status,
    body: { kind, content: truncated ? text.slice(0, maxChars) : text },
    truncated,
    ms: Date.now() - started,
  }
}
