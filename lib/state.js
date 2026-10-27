// Persisted plugin state: the Google switch, the user's key, and the last balance
// reading. Lives in the plugin data directory, never in DSH settings, so nothing
// here can outlive a real uninstall: `dsh plugin remove` touches only the profile
// (registration + node_modules), deleting this directory is what uninstall.mjs adds.
import { mkdir, readFile, writeFile, rename } from 'node:fs/promises'
import path from 'node:path'

const DEFAULTS = {
  // Google search is off until a key exists: an install with no key must not
  // advertise a capability it cannot deliver.
  google: { enabled: false, key: null }, // key: { provider, secret }
  // Last credit reading from the SERP provider, refreshed after every turn.
  balance: { credits: null, rateLimit: null, provider: null, checkedAt: null, error: null },
  lastChannel: null,
  lastSearchAt: null,
}

export function createStore(dir) {
  const file = path.join(dir, 'state.json')
  let cache = null

  // Only known keys survive a read: upgrading from an older version must not carry
  // its retired fields (mode / tunnel / bootstrap / …) forward forever.
  const merge = (raw = {}) => ({
    google: { ...DEFAULTS.google, ...(raw.google ?? {}) },
    balance: { ...DEFAULTS.balance, ...(raw.balance ?? {}) },
    lastChannel: raw.lastChannel ?? null,
    lastSearchAt: raw.lastSearchAt ?? null,
  })

  const read = async () => {
    if (cache) return cache
    try {
      cache = merge(JSON.parse(await readFile(file, 'utf8')))
    } catch {
      cache = structuredClone(DEFAULTS)
    }
    return cache
  }

  const write = async (patch) => {
    const current = await read()
    cache = merge({ ...current, ...patch })
    try {
      await mkdir(dir, { recursive: true })
      const tmp = `${file}.${process.pid}.tmp`
      await writeFile(tmp, `${JSON.stringify(cache, null, 2)}\n`, 'utf8')
      await rename(tmp, file)
    } catch {
      /* state persistence is best-effort; the in-memory value still applies */
    }
    return cache
  }

  return { file, read, write }
}
