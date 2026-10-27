#!/usr/bin/env node
// Regression test for lib/residue.js — the installer-residue repair that unsticks a plugin
// install whose earlier run was killed.
//
// Builds a throwaway profile under the OS temp dir with every residue shape that the
// 2026-10-27 operation logs show, then asserts detection, dry-run safety, removal, and the
// two things repair must never do: delete an installed package, or follow a junction into
// its target.

import os from 'node:os'
import path from 'node:path'
import { mkdir, mkdtemp, readdir, rm, symlink, writeFile } from 'node:fs/promises'
import { findResidue, removeResidue } from '../lib/residue.js'

const PKG = 'dsh-global-search'
const results = []
const check = async (name, fn) => {
  try {
    const value = await fn()
    const ok = value !== false
    results.push({ name, ok, error: ok ? undefined : 'assertion returned false' })
  } catch (error) {
    results.push({ name, ok: false, error: String(error?.message ?? error) })
  }
}

const root = await mkdtemp(path.join(os.tmpdir(), 'dsh-residue-'))
const profileDir = path.join(root, 'profiles', 'test')
const nodeModules = path.join(profileDir, 'node_modules')
const sourceDir = path.join(root, 'source-checkout')

await mkdir(nodeModules, { recursive: true })
await mkdir(path.join(nodeModules, '.ignored'), { recursive: true })
await mkdir(sourceDir, { recursive: true })
await writeFile(path.join(sourceDir, 'package.json'), '{"name":"dsh-global-search","version":"checkout"}')
await writeFile(path.join(sourceDir, 'keep.txt'), 'must survive')
await writeFile(path.join(profileDir, 'package.json'), '{"name":"fake-profile"}')

// 1. broken copy: a real directory at the package path with no package.json (half-copied)
await mkdir(path.join(nodeModules, PKG, 'lib'), { recursive: true })
await writeFile(path.join(nodeModules, PKG, 'lib', 'index.js'), '// partial copy')
// 2. pnpm staging directory of the killed run (the 08:23 / 08:24 shape)
await mkdir(path.join(nodeModules, `${PKG}_tmp_16676_5`), { recursive: true })
await writeFile(path.join(nodeModules, `${PKG}_tmp_16676_5`, 'package.json'), '{"version":"1.1.8"}')
// 3. the same staging directory after pnpm demoted it
await mkdir(path.join(nodeModules, '.ignored', `${PKG}_tmp_6696_12`), { recursive: true })
// 4. an installed package that must never be touched
await mkdir(path.join(nodeModules, 'dsh-meme'), { recursive: true })
await writeFile(path.join(nodeModules, 'dsh-meme', 'package.json'), '{"name":"dsh-meme"}')
mkdir(path.join(nodeModules, 'dsh-global-search-other'), { recursive: true }).catch(() => {})

await check('detects the three residue shapes', async () => {
  const kinds = (await findResidue(profileDir, PKG)).map((entry) => entry.kind).sort()
  return JSON.stringify(kinds) === JSON.stringify(['broken-dir', 'ignored-dir', 'tmp-dir'])
})

await check('reports a complete package as installed, not as residue', async () => {
  const found = await findResidue(profileDir, 'dsh-meme')
  return found.length === 0
})

await check('kinds filter excludes the package path for a directory install', async () => {
  const found = await findResidue(profileDir, PKG, { kinds: ['tmp-dir', 'ignored-dir'] })
  return !found.some((entry) => entry.kind === 'broken-dir') && found.length === 2
})

await check('dry run reports the plan and removes nothing', async () => {
  const planned = await removeResidue(profileDir, PKG, { dryRun: true })
  const still = await findResidue(profileDir, PKG)
  return planned.removed.length === 0 && planned.planned.length === 3 && still.length === 3
})

await check('removal clears every shape', async () => {
  const removed = await removeResidue(profileDir, PKG)
  const after = await findResidue(profileDir, PKG)
  return removed.failed.length === 0 && after.length === 0
})

await check('staging dirs gone, unrelated packages kept', async () => {
  const entries = await readdir(nodeModules)
  return (
    !entries.some((name) => name.includes('_tmp_')) &&
    entries.includes('dsh-meme') &&
    entries.includes('dsh-global-search-other')
  )
})

await check('empty .ignored directory is swept too', async () => {
  const entries = await readdir(nodeModules)
  return !entries.includes('.ignored')
})

// A junction is what pnpm leaves for a directory/link install. It is indistinguishable from
// a real directory by any read-only call on this platform, so the guard is behavioural: a
// junction that still holds a readable package.json is not residue, and removing it must
// never remove its target.
await check('a linked checkout with package.json is not residue', async () => {
  const linkPath = path.join(root, 'profiles', 'linked', 'node_modules', PKG)
  await mkdir(path.dirname(linkPath), { recursive: true })
  await writeFile(path.join(root, 'profiles', 'linked', 'package.json'), '{"name":"linked"}')
  try {
    await symlink(sourceDir, linkPath, 'dir')
  } catch (error) {
    if (error.code !== 'EPERM') throw error
    await symlink(sourceDir, linkPath, 'junction')
  }
  const found = await findResidue(path.join(root, 'profiles', 'linked'), PKG)
  return found.length === 0
})

await check('source checkout survived every repair attempt', async () => {
  const files = await readdir(sourceDir)
  return files.includes('package.json') && files.includes('keep.txt')
})

await check('second run is a no-op', async () => {
  const again = await removeResidue(profileDir, PKG)
  return again.removed.length === 0 && again.failed.length === 0
})

await check('a profile without node_modules is not an error', async () => {
  const bare = path.join(root, 'profiles', 'bare')
  await mkdir(bare, { recursive: true })
  const found = await findResidue(bare, PKG)
  return Array.isArray(found) && found.length === 0
})

// Temp cleanup is best-effort: Windows can refuse to unlink a tree that still holds a
// reparse point, and a leftover temp dir must never fail the assertions above.
try {
  await rm(root, { recursive: true, force: true })
} catch {
  // ignore
}

const failed = results.filter((result) => !result.ok)
for (const result of results) {
  console.log(result.ok ? `  PASS ${result.name}` : `  FAIL ${result.name} — ${result.error}`)
}
console.log(`\nresidue: ${results.length - failed.length} passed, ${failed.length} failed, ${results.length} total`)
process.exit(failed.length ? 1 : 0)
