/**
 * Deliverable verification — the objective half of automatic acceptance.
 *
 * A completion claim is only worth auto-accepting when something outside the
 * claim itself can be checked. This module turns the declared deliverables into
 * a filesystem probe: every path must resolve (absolute, or relative to the
 * project's root directory) to a non-empty file.
 *
 * The probe is a port (`stat`) so board tests can drive it without touching the
 * disk; the Host passes the real implementation.
 */
import { stat } from 'node:fs/promises'
import { isAbsolute, join } from 'node:path'
import { applyOps, findProject, findTask } from './board.js'

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
 * Used by the stale sweep: a shared reference whose file disappeared, or a card
 * whose deliverables no longer exist, is worse than one that never claimed them,
 * because the board would keep presenting it as true.
 *
 * @param project - project to sweep.
 * @param options - `{ stat }` probe override.
 * @returns `{ staleEntries, deliverables }` ready to feed `project.recheck`.
 */
export async function probeProject(project, options) {
  const readSize = options === undefined || options.stat === undefined ? defaultStat : options.stat
  const entries = Array.isArray(project.sharedEntries) ? project.sharedEntries : []
  const tasks = Array.isArray(project.tasks) ? project.tasks : []
  const staleEntries = []
  for (const entry of entries) {
    if (typeof entry.path !== 'string' || entry.path.trim() === '') continue
    const probe = await probeDeliverables({ paths: [entry.path], rootDir: project.rootDir, stat: readSize })
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

/**
 * Prepare one operation for the board layer: fill in whatever needs the disk.
 *
 * Two operations need it — a completion claim (deliverable probe) and a stale
 * sweep (whole-project probe). Keeping this in one place means the HTTP route
 * and the agent tools cannot drift apart.
 *
 * @param board - board the op applies to (a store draft inside the lock).
 * @param op - candidate operation.
 * @param options - `{ stat }` probe override.
 * @returns the operation, possibly extended with a verdict.
 */
export async function prepareOp(board, op, options) {
  if (op === null || typeof op !== 'object') return op
  if (op.type === 'project.recheck') {
    const project = typeof op.projectId === 'string' ? findProject(board, op.projectId) : undefined
    if (project === undefined) return op
    const sweep = await probeProject(project, options)
    return { ...op, staleEntries: sweep.staleEntries, deliverables: sweep.deliverables }
  }
  return attachVerification(board, op, options)
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