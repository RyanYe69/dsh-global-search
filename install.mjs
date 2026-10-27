#!/usr/bin/env node
// One-click, idempotent install for dsh-global-search.
//
// Installation goes through DSH's own plugin mechanism (`dsh plugin add`), which is
// the only supported path: it writes the package into <profile>/package.json
// (dependencies + dsh.profile.bundles) and lets the host's HMR recompose the bundle
// about two seconds later. This script only wraps that command, verifies that both
// registrations really landed, and prints the one step the host cannot do for you
// (the page refresh that loads the client bundle).
//
// It never edits a manifest by hand, never runs pnpm install directly, and never
// touches the machine outside the profile you name.
//
// Usage:
//   node install.mjs                          # default profile (desktop), current $DSH_HOME
//   node install.mjs --profile desktop
//   node install.mjs --from D:\path\to\dsh-global-search-0.3.0.tgz
//   node install.mjs --google-key <key>       # seed a free SERP key (stored in the data dir)
//   node install.mjs --dry-run                # print the command, change nothing
import { readFile, writeFile, rename, access, stat, mkdir } from 'node:fs/promises'
import { findResidue, removeResidue } from './lib/residue.js'
import { execFile, spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import os from 'node:os'
import path from 'node:path'

const PKG = 'dsh-global-search'
const args = process.argv.slice(2)
const flag = (name, fallback) => {
  const i = args.indexOf(`--${name}`)
  return i === -1 ? fallback : args[i + 1]
}
const dryRun = args.includes('--dry-run')
const profile = flag('profile', process.env.DSH_PROFILE ?? 'desktop')
const dshHome = process.env.DSH_HOME ?? path.join(os.homedir(), '.dsh')
const profileDir = path.join(dshHome, 'profiles', profile)
const dataDir = path.join(dshHome, PKG)
const sourceDir = path.dirname(fileURLToPath(import.meta.url))
const source = path.resolve(flag('from', sourceDir))
const moduleDir = path.join(profileDir, 'node_modules', PKG)

const steps = []
const record = (step, status, detail) => {
  steps.push({ step, status, detail })
  console.log(`${status.padEnd(9)} ${step}${detail ? ` — ${detail}` : ''}`)
}

async function exists(p) {
  try { await access(p); return true } catch { return false }
}

/** Run a child process, never throwing. Two failure modes are treated as "retry
 *  without capturing": a sandbox that forbids piped stdio makes execFile throw
 *  synchronously (`spawn EPERM`), and in that mode the child still runs fine when it
 *  inherits our terminal. The captured path is preferred because it lets this script
 *  quote the installer's own error line. */
function run(cmd, cmdArgs) {
  return new Promise((resolve) => {
    try {
      execFile(cmd, cmdArgs, { windowsHide: true, shell: process.platform === 'win32', maxBuffer: 8 * 1024 * 1024 }, (error, stdout, stderr) => {
        if (String(error?.message ?? error).includes('EPERM')) resolve(runInherit(cmd, cmdArgs))
        else resolve({ code: error?.code ?? 0, stdout: String(stdout ?? ''), stderr: String(stderr ?? ''), spawned: true })
      })
    } catch (error) {
      if (String(error?.message ?? error).includes('EPERM')) resolve(runInherit(cmd, cmdArgs))
      else resolve({ code: -1, stdout: '', stderr: `spawn failed: ${error?.message ?? error}`, spawned: false })
    }
  })
}

function runInherit(cmd, cmdArgs) {
  const r = spawnSync(cmd, cmdArgs, { stdio: 'inherit', shell: process.platform === 'win32', windowsHide: true })
  const reason = r.error ? `spawn failed: ${r.error.message}` : 'output inherited (pipe capture blocked here)'
  return { code: r.status ?? -1, stdout: '', stderr: reason, spawned: !r.error, inherited: true }
}

async function readJson(p) {
  try { return JSON.parse(await readFile(p, 'utf8')) } catch { return null }
}

/** Is this plugin registered in the profile manifest? */
async function registration() {
  const manifest = await readJson(path.join(profileDir, 'package.json'))
  if (manifest === null) return { inDeps: false, inBundles: false, missing: true }
  const inDeps = Object.prototype.hasOwnProperty.call(manifest.dependencies ?? {}, PKG)
  const bundles = manifest.dsh?.profile?.bundles ?? []
  return { inDeps, inBundles: bundles.includes(PKG), bundles }
}

console.log(`profile   : ${profileDir}`)
console.log(`source    : ${source}`)
console.log(`data dir  : ${dataDir}`)
console.log(`mode      : ${dryRun ? 'DRY RUN (no changes)' : 'apply'}\n`)

// 0. Preflight — fail with a next step, never with a stack trace.
// Two shapes are accepted: an unpacked directory (package.json beside the files) and
// a packed tarball. A tarball is validated after pnpm unpacks it, through the copy in
// node_modules, because reading it here would duplicate what the installer does.
if (await exists(source)) {
  const sourceIsFile = (await stat(source)).isFile()
  if (sourceIsFile) {
    if (!/\.(tgz|tar\.gz)$/i.test(source)) {
      record('source package', 'FAIL', `${source} is a file but not a .tgz / .tar.gz archive`)
      process.exit(1)
    }
    record('source package', 'OK', `tarball ${(await stat(source)).size} B`)
  } else {
    const sourceManifest = await readJson(path.join(source, 'package.json'))
    if (sourceManifest === null || sourceManifest.name !== PKG) {
      record('source package', 'FAIL', `${source} does not look like ${PKG} (no matching package.json)`)
      process.exit(1)
    }
    if (sourceManifest.dsh?.bundle?.patch === undefined) {
      record('source package', 'FAIL', 'package.json has no dsh.bundle.patch; this is not a mountable plugin')
      process.exit(1)
    }
    record('source package', 'OK', `${sourceManifest.name}@${sourceManifest.version}`)
  }
} else {
  record('source package', 'FAIL', `not found: ${source}`)
  process.exit(1)
}

if (!(await exists(profileDir))) {
  record('target profile', 'FAIL', `not found: ${profileDir}`)
  console.log(`\nCreate it first, then re-run this script:\n  dsh --profile ${profile} --from-default-profile web --dump-config`)
  process.exit(1)
}
record('target profile', 'OK', 'package.json present')

// A real install spec: pnpm understands file:<dir> and file:<tarball>; hand it the
// absolute path with forward slashes so Windows backslashes are not read as escapes.
const spec = `file:${source.replace(/\\/g, '/')}`

// 0. Pre-flight: an interrupted earlier install leaves residue in node_modules, and the
// next install then hangs in pnpm's remove phase instead of finishing — the UI sits at
// 安装中, pnpm's log stops after `Packages: +1 -58`, nothing is written, no error.
// Measured: the identical tarball installs in ~1s once the residue is gone.
// A directory install legitimately keeps a symlink at node_modules/<pkg>, so the symlink
// shape is only residue when the incoming source is a tarball.
{
  const incomingTarball = /\.(tgz|tar\.gz)$/i.test(source)
  const kinds = incomingTarball ? null : ['tmp-dir', 'ignored-dir']
  const residue = await findResidue(profileDir, PKG, { kinds })
  if (residue.length === 0) {
    record('installer residue', 'OK', 'none')
  } else if (dryRun) {
    record('installer residue', 'WOULD', residue.map((e) => `${e.kind} ${path.basename(e.path)}`).join(', '))
  } else {
    const cleaned = await removeResidue(profileDir, PKG, { kinds })
    record('installer residue', cleaned.failed.length ? 'SOFT-FAIL' : 'CLEANED', residue.map((e) => e.kind).join(', '))
    for (const failure of cleaned.failed) record('installer residue', 'FAIL', `${failure.path}: ${failure.error}`)
  }
}

// 1. Install, but only if it is not already there (idempotent by design).
const before = await registration()
const already = before.inDeps && before.inBundles && (await exists(moduleDir))
if (already) {
  record('plugin registration', 'ALREADY', 'dependencies + dsh.profile.bundles both present')
} else if (dryRun) {
  record('plugin registration', 'WOULD', `dsh plugin --profile ${profile} add ${spec}`)
} else {
  // `dsh plugin add` is a pnpm passthrough: when pnpm is not on PATH it fails before it
  // touches the profile, and the verification below would then print five unrelated
  // FAILs. Check the one real precondition first and name it.
  const pnpmProbe = await run('pnpm', ['--version'])
  if (pnpmProbe.code !== 0) {
    const why = (pnpmProbe.stdout + pnpmProbe.stderr).trim().split('\n').filter(Boolean)[0] ?? `exit ${pnpmProbe.code}`
    record('package manager', 'FAIL', `pnpm not on PATH — ${why}`)
    console.log('\n`dsh plugin add` shells out to pnpm, so pnpm has to be reachable first.')
    console.log('  - Inside the DSH desktop app this is already true; run the install from its shell, or:')
    console.log('  - Plain terminal: install it once and re-run this script')
    console.log('      npm i -g pnpm')
    process.exit(3)
  }
  const version = (pnpmProbe.stdout || pnpmProbe.stderr).trim().split('\n').filter(Boolean)[0] ?? ''
  record('package manager', 'OK', pnpmProbe.inherited ? 'pnpm present (version printed above; this sandbox forbids capturing it)' : `pnpm ${version}`)
  const r = await run('dsh', ['plugin', '--profile', profile, 'add', spec])
  const firstLine = (r.stderr || r.stdout).trim().split('\n').filter(Boolean).pop() ?? ''
  record('plugin registration', r.code === 0 ? 'INSTALLED' : 'SOFT-FAIL', r.code === 0 ? 'dsh plugin add exited 0' : `exit ${r.code}: ${firstLine}`)
  if (r.code !== 0) {
    const tail = (r.stdout + r.stderr).trim().split('\n').slice(-8).join('\n')
    if (tail) console.log(`\n  output tail:\n${tail.replace(/^/gm, '  ')}\n`)
  }
}

if (dryRun) {
  console.log('\nWOULD-INSTALL — dry run: nothing was changed; the step above is what an apply run would do')
  process.exit(0)
}

// 2. Verify the end state instead of trusting the command that just ran.
const final = await registration()
const installedManifest = await readJson(path.join(moduleDir, 'package.json'))
const patchFile = path.join(moduleDir, 'cordis.patch.yml')
const checks = [
  ['dependencies has entry', final.inDeps],
  ['dsh.profile.bundles has entry', final.inBundles],
  ['node_modules package present', installedManifest?.name === PKG],
  ['host entrypoint present', await exists(path.join(moduleDir, 'lib', 'index.js'))],
  ['bundle patch present', await exists(patchFile)],
]
console.log('')
let ok = true
for (const [label, pass] of checks) {
  console.log(`${pass ? 'PASS' : 'FAIL'}      ${label}`)
  if (!pass) ok = false
}

if (!ok) {
  console.log('\nINCOMPLETE — the install did not register everything it needs.')
  console.log(`Fix the failing line above, then re-run:  node install.mjs --profile ${profile}`)
  console.log(`To back out cleanly:                      node uninstall.mjs --profile ${profile}`)
  process.exit(1)
}

console.log(`\nINSTALLED — ${steps.length} step(s) recorded`)

// 3. Optionally seed the free SERP key that makes the Google channel work immediately.
// The key lives in the plugin data directory (state.json), never in this package and
// never in the profile, so `uninstall.mjs` removes it together with everything else.
const googleKey = String(flag('google-key', process.env.DSH_GLOBAL_SEARCH_GOOGLE_KEY ?? '') ?? '').trim()
const googleProvider = String(flag('google-provider', 'serper') ?? 'serper').trim()
const KEY_PROVIDERS = ['serper', 'searchapi', 'serpapi', 'zenserp', 'valueserp']
if (googleKey.length > 0) {
  if (googleKey.length < 8 || !KEY_PROVIDERS.includes(googleProvider)) {
    console.log(`FAIL      google key seed — key needs >= 8 chars and provider one of ${KEY_PROVIDERS.join(', ')}`)
    process.exit(1)
  }
  const stateFile = path.join(dataDir, 'state.json')
  let current = {}
  try { current = JSON.parse(await readFile(stateFile, 'utf8')) } catch {}
  current.google = { ...(current.google ?? { enabled: true }), enabled: true, key: { provider: googleProvider, secret: googleKey } }
  await mkdir(dataDir, { recursive: true })
  const tmp = `${stateFile}.${process.pid}.tmp`
  await writeFile(tmp, `${JSON.stringify(current, null, 2)}\n`, 'utf8')
  await rename(tmp, stateFile)
  console.log(`PASS      google key seeded — ${googleProvider}, ${googleKey.slice(0, 4)}…${googleKey.slice(-2)} (${googleKey.length} chars) in ${stateFile}`)
} else {
  console.log('SKIP      google key — not provided; paste it later in 设置 › 外网搜索, or re-run with --google-key')
}

console.log(`
Next:
  1. HOST half: if DSH is already running, wait ~2 s — the host (@deepseek-ai/dsh-hmr)
     recomposes the bundle itself when dsh.profile.bundles changes. Search and the
     google_search tool are live without a restart.
  2. CLIENT half: restart DeepSeek Harness once. DSH composes its client-module table
     at boot, so a plugin installed while the app is running only has a Host half until
     the next start (/plugins/dsh-global-search/client.js is 404 before, 200 after).
     The settings page and the composer switch appear after that restart.
  3. Check it is alive:
       GET  /dsh-global-search/status
       POST /dsh-global-search/test?q=tokio     (spends one Google credit)
  4. With a key saved, the model can call the google_search tool; each call spends one
     credit and the remaining quota is re-read after every turn. Without a key (or with
     the switch off) web_search stays on Bing: English → international index, Chinese →
     domestic index. Logs: ${path.join(dataDir, 'log.jsonl')}`)
process.exit(0)
