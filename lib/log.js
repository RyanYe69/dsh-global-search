// Structured JSONL logging for dsh-global-search.
//
// Every judgment the plugin makes (which channel, which step, how many ms) is one
// JSON object per line in <dataDir>/log.jsonl, so `grep` answers "why did this
// search go that way" without reading code. Writes are queued to preserve order
// and never reject: a logging failure must not fail a search.
import { mkdir, appendFile } from 'node:fs/promises'
import path from 'node:path'

export function createLogger(dir, { maxBytes = 4 * 1024 * 1024 } = {}) {
  const file = path.join(dir, 'log.jsonl')
  let chain = Promise.resolve()
  let seq = 0
  let bytes = 0
  let rotated = false

  const emit = (level, event, data) => {
    const row = { ts: new Date().toISOString(), seq: ++seq, level, event, ...data }
    const line = `${JSON.stringify(row)}\n`
    chain = chain.then(async () => {
      try {
        await mkdir(dir, { recursive: true })
        // Keep the log bounded so uninstall-size growth stays predictable.
        if (bytes === 0) {
          const { stat } = await import('node:fs/promises')
          bytes = (await stat(file).catch(() => ({ size: 0 }))).size
        }
        if (!rotated && bytes > maxBytes) {
          const { rename } = await import('node:fs/promises')
          await rename(file, `${file}.1`).catch(() => {})
          bytes = 0
          rotated = true
        }
        await appendFile(file, line, 'utf8')
        bytes += Buffer.byteLength(line)
      } catch {
        /* logging is best-effort by design */
      }
    })
    if (level !== 'info') process.stderr.write(`[dsh-global-search] ${level}: ${event} ${JSON.stringify(data)}\n`)
    return row
  }

  return {
    file,
    info: (event, data = {}) => emit('info', event, data),
    warn: (event, data = {}) => emit('warn', event, data),
    error: (event, data = {}) => emit('error', event, data),
    flush: () => chain,
  }
}
