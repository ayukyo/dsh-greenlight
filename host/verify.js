/**
 * Disk work that has to happen before the pure board layer runs.
 *
 * Two things need the filesystem: the objective half of automatic acceptance (a
 * completion's declared deliverables are probed, and a stale sweep re-checks the
 * project's link references) and scanning project material from local paths
 * (`reference.intake`). Both are prepared here and travel with the operation, so
 * the board layer stays synchronous and every caller — the HTTP route and the
 * agent tools — takes the same path.
 *
 * The probes are a port (`stat`) so board tests can drive them without touching
 * the disk; the Host passes the real implementation.
 */
import { readdir, stat } from 'node:fs/promises'
import { basename, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { applyOps, createId, findProject, findTask } from './board.js'

/**
 * @param path - candidate path.
 * @returns the size in bytes, or null when the path is not a readable file.
 */
async function defaultStat(path) {
  try {
    const info = await stat(path)
    if (!info.isFile()) return null
    return info.size
  } catch (error) {
    return null
  }
}

/**
 * Resolve one declared deliverable against the project root.
 * @param raw - declared path.
 * @param rootDir - absolute project root, or '' when unset.
 * @returns `{ path, resolved }`; `resolved` is false when a relative path has no root.
 */
function resolvePath(raw, rootDir) {
  const path = raw.trim()
  if (path === '') return { path, resolved: false }
  if (isAbsolute(path)) return { path, resolved: true }
  if (rootDir === '') return { path, resolved: false }
  return { path: join(rootDir, path), resolved: true }
}

/**
 * Probe every declared deliverable.
 * @param options - `{ paths, rootDir, stat }`.
 * @returns `{ checked, missing, unresolved }`.
 *   `checked` is false when nothing could be looked at (no root for relative paths).
 *   `missing` lists declared paths that did not resolve to a non-empty file.
 *   `unresolved` lists relative paths with no root directory to resolve against.
 */
export async function probeDeliverables(options) {
  const paths = Array.isArray(options.paths) ? options.paths : []
  const rootDir = typeof options.rootDir === 'string' ? options.rootDir.trim() : ''
  const readSize = typeof options.stat === 'function' ? options.stat : defaultStat
  if (paths.length === 0) return { checked: false, missing: [], unresolved: [] }

  const missing = []
  const unresolved = []
  let looked = 0
  for (const raw of paths) {
    const { path, resolved } = resolvePath(raw, rootDir)
    if (path === '') continue
    if (!resolved) {
      unresolved.push(path)
      continue
    }
    looked += 1
    const size = await readSize(path)
    if (size === null || size === 0) missing.push(raw.trim())
  }
  return { checked: looked > 0, missing, unresolved }
}

/**
 * Recheck every declared path in a project.
 *
 * Used by the stale sweep: a link reference whose file disappeared, or a card
 * whose deliverables no longer exist, is worse than one that never claimed them,
 * because the board would keep presenting it as true.
 *
 * Only `link` references are probed. A `note` is convention text, not a claim
 * about anything on disk, so it can never go stale.
 *
 * @param project - project to sweep.
 * @param options - `{ stat }` probe override.
 * @returns `{ staleEntries, deliverables }` ready to feed `project.recheck`.
 */
export async function probeProject(project, options) {
  const readSize = options === undefined || options.stat === undefined ? defaultStat : options.stat
  const entries = Array.isArray(project.references) ? project.references : []
  const tasks = Array.isArray(project.tasks) ? project.tasks : []
  const staleEntries = []
  for (const entry of entries) {
    if (entry.kind !== 'link') continue
    if (typeof entry.value !== 'string' || entry.value.trim() === '') continue
    const probe = await probeDeliverables({ paths: [entry.value], rootDir: project.rootDir, stat: readSize })
    if (probe.missing.length > 0 || probe.unresolved.length > 0) staleEntries.push(entry.id)
  }
  const deliverables = {}
  for (const task of tasks) {
    const declared = Array.isArray(task.deliverables) ? task.deliverables : []
    if (declared.length === 0) continue
    const probe = await probeDeliverables({ paths: declared, rootDir: project.rootDir, stat: readSize })
    deliverables[task.id] = { checked: probe.checked, missing: probe.missing, unresolved: probe.unresolved }
  }
  return { staleEntries, deliverables }
}

/* ------------------------------------------------------------------ intake */

/** Directory names a material scan never descends into. */
export const INTAKE_SKIP_DIRS = [
  '.git', 'node_modules', 'dist', 'build', 'out', 'target', 'coverage', '.next', 'vendor', '__pycache__',
]
/** Most files one scanned directory may contribute before it is truncated. */
export const MAX_INTAKE_FILES = 200

/**
 * @param value - candidate path.
 * @returns whether the value is an http(s) link.
 */
function isHttpLink(value) {
  return /^https?:\/\//i.test(value)
}

/**
 * Name a link after the last segment of its path, so a list of links reads like
 * a list of files.
 * @param url - http(s) link.
 * @returns the display name.
 */
function linkName(url) {
  try {
    const parsed = new URL(url)
    const segments = parsed.pathname.split('/').filter(segment => segment !== '')
    const last = segments.length === 0 ? '' : decodeURIComponent(segments[segments.length - 1])
    return last === '' ? parsed.hostname : last
  } catch (error) {
    return url
  }
}

/**
 * Store a local file the way the board reads it: relative to the project root,
 * with forward slashes so the value is the same on every platform, or absolute
 * when the project has no root directory.
 * @param absolute - absolute file path.
 * @param rootDir - absolute project root, or ''.
 * @returns the stored value.
 */
function storedPath(absolute, rootDir) {
  if (rootDir === '') return absolute
  return relative(rootDir, absolute).split(sep).join('/')
}

/**
 * Resolve one input path against the project root.
 * @param raw - input path.
 * @param rootDir - absolute project root, or ''.
 * @returns the absolute path.
 */
function inputPath(raw, rootDir) {
  if (isAbsolute(raw)) return raw
  const base = rootDir === '' ? process.cwd() : rootDir
  return resolve(base, raw)
}

/**
 * Collect the files under one directory, depth-first and in name order, so the
 * same tree always scans into the same list.
 * @param dir - absolute directory.
 * @param state - `{ files, truncated }`, mutated.
 */
async function collectFiles(dir, state) {
  if (state.truncated) return
  let entries
  try {
    entries = await readdir(dir, { withFileTypes: true })
  } catch (error) {
    return
  }
  entries.sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0))
  for (const entry of entries) {
    if (state.truncated) return
    if (entry.isDirectory()) {
      if (INTAKE_SKIP_DIRS.includes(entry.name)) continue
      await collectFiles(join(dir, entry.name), state)
      continue
    }
    if (!entry.isFile()) continue
    if (state.files.length >= MAX_INTAKE_FILES) {
      state.truncated = true
      return
    }
    state.files.push(join(dir, entry.name))
  }
}

/**
 * Scan material paths for one project: local files stay as they are, local
 * directories are expanded into their files, and http(s) links are kept as they
 * were given.
 *
 * A path that cannot be found is reported in `missing` instead of being added; a
 * value the project already holds is reported in `skipped`; a directory with more
 * files than {@link MAX_INTAKE_FILES} contributes the first ones in name order and
 * marks the whole scan `truncated`.
 *
 * @param project - project the material belongs to.
 * @param paths - local paths and links, already validated as non-empty strings.
 * @returns `{ added, missing, skipped, truncated }`, where `added` holds
 *   `{ id, name, value }` entries ready for `reference.intake`.
 */
export async function scanIntake(project, paths) {
  const rootDir = typeof project.rootDir === 'string' ? project.rootDir.trim() : ''
  const knownValues = new Set()
  const knownNames = new Set()
  for (const entry of Array.isArray(project.references) ? project.references : []) {
    if (typeof entry.value === 'string') knownValues.add(entry.value)
    if (typeof entry.name === 'string') knownNames.add(entry.name)
  }
  const added = []
  const missing = []
  const skipped = []
  let truncated = false

  /**
   * Record one resolved entry, dropping a value the project already holds and
   * giving a repeated file name the fuller stored path so both stay readable.
   * @param name - candidate display name.
   * @param value - stored value.
   */
  const push = (name, value) => {
    if (knownValues.has(value)) {
      skipped.push(value)
      return
    }
    knownValues.add(value)
    const chosen = name === '' || knownNames.has(name) ? value : name
    knownNames.add(chosen)
    added.push({ id: createId('ref-'), name: chosen, value })
  }

  for (const raw of Array.isArray(paths) ? paths : []) {
    const input = raw.trim()
    if (isHttpLink(input)) {
      push(linkName(input), input)
      continue
    }
    const absolute = inputPath(input, rootDir)
    let info
    try {
      info = await stat(absolute)
    } catch (error) {
      missing.push(input)
      continue
    }
    if (info.isFile()) {
      push(basename(absolute), storedPath(absolute, rootDir))
      continue
    }
    if (!info.isDirectory()) {
      // A socket or a device is not material a card can point at.
      missing.push(input)
      continue
    }
    const state = { files: [], truncated: false }
    await collectFiles(absolute, state)
    if (state.truncated) truncated = true
    for (const file of state.files) push(basename(file), storedPath(file, rootDir))
  }
  return { added, missing, skipped, truncated }
}

/**
 * Prepare one material intake: the scan needs the disk, so it runs here and the
 * resulting ledger travels on the operation.
 * @param board - board the op applies to.
 * @param op - candidate operation.
 * @returns the operation, extended with the scan result when it can run.
 */
async function prepareIntake(board, op) {
  // An already-scanned operation is left alone: preparing a batch twice must not
  // scan twice nor mint different reference ids.
  if (Array.isArray(op.added)) return op
  const project = typeof op.projectId === 'string' ? findProject(board, op.projectId) : undefined
  if (project === undefined) return op
  if (!Array.isArray(op.paths) || op.paths.length === 0) return op
  if (!op.paths.every(path => typeof path === 'string' && path.trim() !== '')) return op
  const scan = await scanIntake(project, op.paths)
  return { ...op, added: scan.added, missing: scan.missing, skipped: scan.skipped, truncated: scan.truncated }
}

/**
 * Prepare one operation for the board layer: fill in whatever needs the disk.
 *
 * A completion claim (deliverable probe), a stale sweep (whole-project probe) and
 * a material intake (path scan) all need it. Keeping this in one place means the
 * HTTP route and the agent tools cannot drift apart.
 *
 * @param board - board the op applies to (a store draft inside the lock).
 * @param op - candidate operation.
 * @param options - `{ stat }` probe override.
 * @returns the operation, possibly extended with a verdict or a scan.
 */
export async function prepareOp(board, op, options) {
  if (op === null || typeof op !== 'object') return op
  // An id minted while applying would differ from the one the scratch board handed
  // a later probe, so a sweep could mark an entry that never lands and miss the one
  // that does. Pinning it here keeps the prepared batch and the applied batch equal.
  const pinned = op.type === 'reference.add' && (typeof op.id !== 'string' || op.id === '')
    ? { ...op, id: createId('ref-') }
    : op
  if (pinned.type === 'project.recheck') {
    const project = typeof pinned.projectId === 'string' ? findProject(board, pinned.projectId) : undefined
    if (project === undefined) return pinned
    const sweep = await probeProject(project, options)
    return { ...pinned, staleEntries: sweep.staleEntries, deliverables: sweep.deliverables }
  }
  if (pinned.type === 'reference.intake') return prepareIntake(board, pinned)
  return attachVerification(board, pinned, options)
}

/**
 * Prepare a whole batch for the board layer.
 *
 * Operations are prepared before any of them is applied, so a probe cannot see
 * what an earlier operation in the same batch would add. A stale sweep is the
 * one case where that matters — it must see the references the batch itself
 * just declared — so it is prepared against a scratch board holding the earlier
 * operations.
 *
 * @param board - board the batch applies to.
 * @param ops - candidate operations.
 * @param options - `{ stat }` probe override.
 * @returns the prepared operations.
 */
export async function prepareBatch(board, ops, options) {
  const list = Array.isArray(ops) ? ops : []
  const prepared = []
  for (const op of list) {
    if (op !== null && typeof op === 'object' && (op.type === 'project.recheck' || completesOn(op))) {
      // Both a stale sweep and a completion probe must see what earlier
      // operations in the same batch did, so they run against a scratch board.
      const scratch = prepared.length === 0 ? board : applyOps(board, prepared).board
      prepared.push(await prepareOp(scratch, op, options))
      continue
    }
    prepared.push(await prepareOp(board, op, options))
  }
  return prepared
}

/**
 * Whether an operation settles a card as complete.
 * @param op - candidate operation.
 * @returns true for the three shapes that finish a card.
 */
function completesOn(op) {
  if (op.type === 'task.submit') return true
  if (op.type === 'task.move') return op.status === 'done'
  if (op.type === 'task.patch') {
    return op.patch !== null && typeof op.patch === 'object' && op.patch.status === 'done'
  }
  return false
}

/**
 * Attach a verification verdict to a completing operation.
 *
 * The verdict travels with the op so the pure board layer can stay synchronous:
 * `applyOps` reads it instead of touching the filesystem itself.
 *
 * @param board - board the op is applied to.
 * @param op - candidate operation.
 * @param options - `{ stat }` probe override.
 * @returns the operation, copied with `verification` when a probe ran.
 */
export async function attachVerification(board, op, options) {
  if (op === null || typeof op !== 'object') return op
  const completes = op.type === 'task.submit'
    || (op.type === 'task.patch' && op.patch !== null && typeof op.patch === 'object' && op.patch.status === 'done')
    || (op.type === 'task.move' && op.status === 'done')
  if (!completes) return op

  const project = typeof op.projectId === 'string' ? findProject(board, op.projectId) : undefined
  if (project === undefined) return op
  const task = typeof op.taskId === 'string' ? findTask(project, op.taskId) : undefined
  if (task === undefined) return op
  const rules = project.acceptanceRules !== undefined ? project.acceptanceRules : {}
  if (rules.verifyDeliverables !== true) return op

  // The op may carry new declarations; those win over what is stored.
  const declared = Array.isArray(op.deliverables)
    ? op.deliverables
    : (Array.isArray(task.deliverables) ? task.deliverables : [])
  if (declared.length === 0) return op

  const probe = await probeDeliverables({
    paths: declared,
    rootDir: project.rootDir,
    stat: options === undefined ? undefined : options.stat,
  })
  return { ...op, verification: { checked: probe.checked, missing: probe.missing, unresolved: probe.unresolved, at: Date.now() } }
}