// Installer residue: detection and repair.
//
// Why this file exists — measured on this machine, not hypothesised. A `pnpm add` that is
// killed mid-flight leaves shapes behind in `<profile>/node_modules`, and the next install
// then wastes its run on them instead of finishing:
//
//   1. `<pkg>_tmp_<pid>_<n>`      pnpm's staging directory of the killed run.
//   2. `.ignored/<pkg>_tmp_*`     the same directory after pnpm demoted it, with the log line
//                                 `Moving <pkg>_tmp_6696_12 to "node_modules\.ignored\..."` —
//                                 the 2026-10-27 08:24 run stopped exactly there.
//   3. `<pkg>` without package.json
//                                 a half-copied package from the same killed run.
//
// Evidence from `.plugin-manager/logs/operation-*/pnpm.log`: the 08:23 and 08:24 runs end
// after `Packages: +1 -58` with no `Done`, while the 08:31 run that followed prints
// `+ dsh-global-search 1.1.8` / `Done in 1s`.
//
// Two things this file deliberately does NOT do:
//   * It never follows a reparse point. On Windows a junction (the shape pnpm leaves for a
//     `link:`/directory install) reports `isSymbolicLink() === false` and shares the target's
//     inode, so it is indistinguishable from a real directory by any read-only call. Removal
//     therefore tries `rmdir` first, which deletes a junction and never its target, and only
//     falls back to a recursive delete for a directory that is provably not a link.
//   * It never removes a directory that still holds a readable package.json: that is an
//     installed package, not residue.

import { lstat, readdir, readFile, rm, rmdir, unlink } from 'node:fs/promises'
import path from 'node:path'

const isMissing = (error) => error && (error.code === 'ENOENT' || error.code === 'ENOTDIR')

/** True when the directory holds a readable package.json. */
async function looksInstalled(dir) {
  try {
    const manifest = JSON.parse(await readFile(path.join(dir, 'package.json'), 'utf8'))
    return typeof manifest?.name === 'string'
  } catch {
    return false
  }
}

/** Remove a directory only if it is a link or empty; false when it really has contents. */
async function rmdirIfLink(dir) {
  try {
    await rmdir(dir)
    return true
  } catch (error) {
    if (isMissing(error)) return true
    return false
  }
}

/**
 * Read-only scan for residue that can waste or block the next install.
 *
 * @param {string} profileDir absolute profile directory (the one holding package.json)
 * @param {string} pkg        package name, e.g. `dsh-global-search`
 * @param {{kinds?: string[]}} [options] limit the reported kinds
 * @returns {Promise<Array<{path: string, kind: string, detail: string}>>}
 */
export async function findResidue(profileDir, pkg, options = {}) {
  const nodeModules = path.join(profileDir, 'node_modules')
  const found = []
  let entries = []
  try {
    entries = await readdir(nodeModules, { withFileTypes: true })
  } catch (error) {
    if (isMissing(error)) return []
    throw error
  }

  const tmpPrefix = `${pkg}_tmp_`
  for (const entry of entries) {
    const absolute = path.join(nodeModules, entry.name)

    if (entry.name === pkg) {
      let info
      try {
        info = await lstat(absolute)
      } catch (error) {
        if (isMissing(error)) continue
        throw error
      }
      if (info.isSymbolicLink()) {
        found.push({ path: absolute, kind: 'symlink', detail: 'symbolic link at the package path; a tarball install needs a real copy' })
      } else if (info.isDirectory() && !(await looksInstalled(absolute))) {
        found.push({ path: absolute, kind: 'broken-dir', detail: 'half-copied package from an interrupted install (no package.json)' })
      }
      continue
    }

    if (entry.name.startsWith(tmpPrefix)) {
      found.push({ path: absolute, kind: 'tmp-dir', detail: 'pnpm staging directory of an interrupted install' })
    }
  }

  const ignoredDir = path.join(nodeModules, '.ignored')
  let ignored = []
  try {
    ignored = await readdir(ignoredDir)
  } catch (error) {
    if (isMissing(error)) ignored = []
    else throw error
  }
  for (const name of ignored) {
    if (name === pkg || name.startsWith(tmpPrefix)) {
      found.push({
        path: path.join(ignoredDir, name),
        kind: 'ignored-dir',
        detail: 'pnpm moved an orphaned staging directory here instead of using it',
      })
    }
  }

  const kinds = options.kinds ?? null
  return kinds ? found.filter((entry) => kinds.includes(entry.kind)) : found
}

/** Delete one residue entry without ever following a reparse point. */
async function removeEntry(entry) {
  if (entry.kind === 'symlink') {
    await unlink(entry.path)
    return
  }
  if (entry.kind === 'broken-dir') {
    // A junction disappears with rmdir and leaves its target alone; a real half-copied
    // directory survives that call and is then safe to delete recursively.
    if (await rmdirIfLink(entry.path)) return
    await rm(entry.path, { recursive: true, force: true })
    return
  }
  await rm(entry.path, { recursive: true, force: true })
}

/**
 * Remove the residue reported by `findResidue`.
 *
 * @param {string} profileDir
 * @param {string} pkg
 * @param {{dryRun?: boolean, kinds?: string[]}} [options]
 * @returns {Promise<{removed: string[], planned: string[], failed: Array<{path: string, error: string}>}>}
 */
export async function removeResidue(profileDir, pkg, options = {}) {
  const dryRun = options.dryRun === true
  const entries = await findResidue(profileDir, pkg, { kinds: options.kinds })
  const removed = []
  const planned = []
  const failed = []

  for (const entry of entries) {
    if (dryRun) {
      planned.push(entry.path)
      continue
    }
    try {
      await removeEntry(entry)
      removed.push(entry.path)
    } catch (error) {
      if (isMissing(error)) continue
      failed.push({ path: entry.path, error: String(error?.message ?? error) })
    }
  }

  // An `.ignored` directory left empty by the removal above is itself residue.
  if (!dryRun && removed.length) {
    const ignoredDir = path.join(profileDir, 'node_modules', '.ignored')
    try {
      const rest = await readdir(ignoredDir)
      if (rest.length === 0) {
        await rm(ignoredDir, { recursive: true, force: true })
        removed.push(ignoredDir)
      }
    } catch (error) {
      if (!isMissing(error)) throw error
    }
  }

  return { removed, planned, failed }
}
