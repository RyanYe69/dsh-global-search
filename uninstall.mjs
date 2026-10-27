#!/usr/bin/env node
// One-click, idempotent uninstall for dsh-global-search.
//
// Why this exists: `dsh plugin remove` is a pnpm passthrough, so running it when the
// dependency is already gone exits non-zero (ERR_PNPM_CANNOT_REMOVE_MISSING_DEPS) and
// leaving the plugin data directory behind is not something pnpm knows about. This
// script makes the whole operation idempotent: it removes only what is actually
// present, then verifies the machine is back to its pre-install shape.
//
// Usage:
//   node uninstall.mjs                    # default profile, current $DSH_HOME
//   node uninstall.mjs --profile desktop
//   node uninstall.mjs --dry-run
import { readFile, rm, access } from 'node:fs/promises'
import { execFile, spawnSync } from 'node:child_process'
import os from 'node:os'
import path from 'node:path'
import { findResidue, removeResidue } from './lib/residue.js'

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
 *  quote the remover's own error line. */
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

/** Is this plugin still registered in the profile manifest? */
async function registration() {
  try {
    const manifest = JSON.parse(await readFile(path.join(profileDir, 'package.json'), 'utf8'))
    const inDeps = Object.prototype.hasOwnProperty.call(manifest.dependencies ?? {}, PKG)
    const bundles = manifest.dsh?.profile?.bundles ?? []
    return { inDeps, inBundles: bundles.includes(PKG), manifest }
  } catch {
    return { inDeps: false, inBundles: false, manifest: null, missing: true }
  }
}

console.log(`profile   : ${profileDir}`)
console.log(`data dir  : ${dataDir}`)
console.log(`mode      : ${dryRun ? 'DRY RUN (no changes)' : 'apply'}\n`)

// 1. Remove the registration, but only if it is actually there.
let state = await registration()
if (state.missing) {
  record('profile manifest', 'SKIP', 'profile not found; nothing to unregister')
} else if (!state.inDeps && !state.inBundles) {
  record('plugin registration', 'ALREADY', 'not in dependencies or dsh.profile.bundles')
} else if (dryRun) {
  record('plugin registration', 'WOULD', `dsh plugin --profile ${profile} remove ${PKG}`)
} else {
  const r = await run('dsh', ['plugin', '--profile', profile, 'remove', PKG])
  const clean = r.code === 0
  record('plugin registration', clean ? 'REMOVED' : 'SOFT-FAIL', clean ? 'dsh plugin remove exited 0' : `exit ${r.code}: ${(r.stderr || r.stdout).trim().split('\n')[0]}`)
  state = await registration()
}

// 2. Package directory (dsh plugin usually handles it; verify rather than assume).
const moduleDir = path.join(profileDir, 'node_modules', PKG)
if (!(await exists(moduleDir))) {
  record('node_modules entry', 'ALREADY', 'absent')
} else if (dryRun) {
  record('node_modules entry', 'WOULD', `rm -rf ${moduleDir}`)
} else {
  await rm(moduleDir, { recursive: true, force: true })
  record('node_modules entry', 'REMOVED', (await exists(moduleDir)) ? 'still present!' : 'deleted')
}

// 3. Installer residue: a pnpm add interrupted mid-flight leaves `<pkg>_tmp_*` staging
// dirs behind (and `.ignored/<pkg>_tmp_*` after pnpm demotes them), and the NEXT install
// hangs on them instead of completing. Uninstall is the natural place to sweep them.
{
  const residue = await findResidue(profileDir, PKG, { kinds: ['tmp-dir', 'ignored-dir'] })
  if (residue.length === 0) {
    record('installer residue', 'ALREADY', 'none')
  } else if (dryRun) {
    record('installer residue', 'WOULD', residue.map((e) => `${e.kind} ${path.basename(e.path)}`).join(', '))
  } else {
    const cleaned = await removeResidue(profileDir, PKG, { kinds: ['tmp-dir', 'ignored-dir'] })
    record('installer residue', cleaned.failed.length ? 'SOFT-FAIL' : 'REMOVED', residue.map((e) => e.kind).join(', '))
  }
}

// 4. Plugin data directory: kernel, node pool, state, logs.
if (!(await exists(dataDir))) {
  record('plugin data dir', 'ALREADY', 'absent')
} else if (dryRun) {
  record('plugin data dir', 'WOULD', `rm -rf ${dataDir}`)
} else {
  await rm(dataDir, { recursive: true, force: true })
  record('plugin data dir', 'REMOVED', (await exists(dataDir)) ? 'still present!' : 'deleted (kernel, nodes.yaml, state.json, logs)')
}

// 4. Verify the end state instead of trusting the steps above.
// A dry run promised not to change anything, so it cannot assert that the world is
// already clean — it asserts that the plan it printed is executable.
if (dryRun) {
  console.log('\nWOULD-BE-CLEAN — dry run: nothing was changed; the steps above are what an apply run would do')
  process.exit(0)
}

const final = await registration()
const checks = [
  ['dependencies has no entry', !final.inDeps],
  ['dsh.profile.bundles has no entry', !final.inBundles],
  ['node_modules entry gone', !(await exists(moduleDir))],
  ['plugin data dir gone', !(await exists(dataDir))],
]
console.log('')
let ok = true
for (const [label, pass] of checks) {
  console.log(`${pass ? 'PASS' : 'FAIL'}      ${label}`)
  if (!pass) ok = false
}
console.log(`\n${ok ? 'CLEAN' : 'INCOMPLETE'} — ${steps.length} step(s) recorded${dryRun ? ' (dry run, nothing was changed)' : ''}`)
process.exit(ok ? 0 : 1)
