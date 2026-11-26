/**
 * Cold storage for finished subtasks.
 *
 * The active board document must stay small: it is read on every poll, cloned on
 * every write, and streamed to the browser. Archive keeps closed cards in a
 * separate file that is only read when the user opens the archive, with the same
 * durability rules as the board store (atomic write, fsync, corrupt isolation).
 *
 * Ordering matters for safety:
 *   archive  — write the archive first, then drop the card from the board; a
 *              crash between the two leaves the card in both places (harmless,
 *              the next archive dedupes by id) instead of in neither.
 *   restore  — add to the board first, then drop from the archive; a crash
 *              between the two re-proposes the card (visible, recoverable).
 */
import { mkdir, open, readFile, rename, unlink } from 'node:fs/promises'
import { dirname, join } from 'node:path'

/** Archive document version. */
export const ARCHIVE_VERSION = 1

/**
 * @param file - absolute archive path.
 * @returns the archiver.
 */
export function createArchiver(file) {
  let document = emptyArchive()
  let loaded = false
  let queue = Promise.resolve()

  /**
   * @returns a fresh archive document.
   */
  function emptyArchive() {
    return { version: ARCHIVE_VERSION, updatedAt: new Date().toISOString(), projects: [] }
  }

  /**
   * Read the archive once.
   * @returns completion.
   */
  async function init() {
    if (loaded) return
    loaded = true
    let text
    try {
      text = await readFile(file, 'utf8')
    } catch (error) {
      if (error !== null && error !== undefined && error.code === 'ENOENT') return
      document = emptyArchive()
      return
    }
    try {
      const parsed = JSON.parse(text)
      document = normalizeArchive(parsed)
    } catch (error) {
      // Move the unusable archive aside instead of overwriting the user's data.
      const stamp = new Date().toISOString().replace(/[:.]/g, '-')
      await rename(file, join(dirname(file), 'board-archive.json.corrupt-' + stamp)).catch(() => undefined)
      document = emptyArchive()
    }
  }

  /**
   * Persist the archive atomically.
   * @returns completion.
   */
  async function persist() {
    await mkdir(dirname(file), { recursive: true })
    const text = JSON.stringify(document)
    const temporary = file + '.tmp-' + process.pid
    const handle = await open(temporary, 'w')
    try {
      await handle.writeFile(text, 'utf8')
      await handle.sync()
    } finally {
      await handle.close()
    }
    const written = await readFile(temporary, 'utf8')
    if (written !== text) {
      await unlink(temporary).catch(() => undefined)
      throw new Error('archive write verification failed: content mismatch')
    }
    await rename(temporary, file)
  }

  /**
   * Run one archive change under a lock.
   * @param change - receives the archive document, returns true when it changed.
   * @returns completion.
   */
  function mutate(change) {
    const run = queue.then(async () => {
      await init()
      const next = structuredClone(document)
      if (change(next) !== true) return document
      next.updatedAt = new Date().toISOString()
      document = next
      await persist()
      return document
    })
    queue = run.catch(() => undefined)
    return run
  }

  /**
   * Append finished cards.
   * @param project - `{ id, name }` snapshot.
   * @param tasks - cards to store.
   * @returns completion.
   */
  async function appendTasks(project, tasks) {
    await mutate((draft) => {
      let bucket = draft.projects.find(entry => entry.projectId === project.id)
      if (bucket === undefined) {
        bucket = { projectId: project.id, projectName: project.name, tasks: [], archivedAt: Date.now() }
        draft.projects.push(bucket)
      }
      bucket.projectName = project.name
      bucket.archivedAt = Date.now()
      const known = new Set(bucket.tasks.map(task => task.id))
      for (const task of tasks) {
        if (known.has(task.id)) continue
        bucket.tasks.push(task)
        known.add(task.id)
      }
      return true
    })
  }

  /**
   * Find archived cards by id.
   * @param projectId - project identity.
   * @param taskIds - wanted ids.
   * @returns the cards, plus whether every id was found.
   */
  async function findTasks(projectId, taskIds) {
    await init()
    const wanted = new Set(Array.isArray(taskIds) ? taskIds : [])
    const bucket = document.projects.find(entry => entry.projectId === projectId)
    if (bucket === undefined) return { tasks: [], missing: [...wanted] }
    const tasks = bucket.tasks.filter(task => wanted.has(task.id))
    const found = new Set(tasks.map(task => task.id))
    return { tasks, missing: [...wanted].filter(id => !found.has(id)), projectName: bucket.projectName }
  }

  /**
   * Drop cards from the archive.
   * @param projectId - project identity.
   * @param taskIds - ids to drop.
   * @returns completion.
   */
  async function removeTasks(projectId, taskIds) {
    const wanted = new Set(Array.isArray(taskIds) ? taskIds : [])
    await mutate((draft) => {
      const bucket = draft.projects.find(entry => entry.projectId === projectId)
      if (bucket === undefined) return false
      const before = bucket.tasks.length
      bucket.tasks = bucket.tasks.filter(task => !wanted.has(task.id))
      if (bucket.tasks.length === 0) draft.projects = draft.projects.filter(entry => entry !== bucket)
      return bucket.tasks.length !== before
    })
  }

  return {
    init,
    /**
     * @returns every archived project with its cards (a clone).
     */
    snapshot() {
      return structuredClone(document)
    },
    appendTasks,
    findTasks,
    removeTasks,
    path() {
      return file
    },
  }
}

/**
 * Normalize a stored archive document.
 * @param raw - candidate document.
 * @returns a usable archive.
 */
function normalizeArchive(raw) {
  const out = { version: ARCHIVE_VERSION, updatedAt: new Date().toISOString(), projects: [] }
  if (raw === null || typeof raw !== 'object' || !Array.isArray(raw.projects)) return out
  if (typeof raw.updatedAt === 'string') out.updatedAt = raw.updatedAt
  for (const entry of raw.projects) {
    if (entry === null || typeof entry !== 'object') continue
    if (typeof entry.projectId !== 'string' || !Array.isArray(entry.tasks)) continue
    out.projects.push({
      projectId: entry.projectId,
      projectName: typeof entry.projectName === 'string' ? entry.projectName : '',
      tasks: entry.tasks.filter(task => task !== null && typeof task === 'object' && typeof task.id === 'string'),
      archivedAt: typeof entry.archivedAt === 'number' ? entry.archivedAt : Date.now(),
    })
  }
  return out
}

/**
 * @param archived - snapshot from {@link createArchiver}.
 * @returns how many cards the archive holds.
 */
export function archivedCount(archived) {
  const projects = archived !== null && archived !== undefined && Array.isArray(archived.projects)
    ? archived.projects
    : []
  return projects.reduce((total, entry) => total + (Array.isArray(entry.tasks) ? entry.tasks.length : 0), 0)
}

/**
 * The archive file that belongs beside a board document.
 * @param boardFile - absolute board path.
 * @returns the archive path.
 */
export function archivePathFor(boardFile) {
  return join(dirname(boardFile), 'board-archive.json')
}

/**
 * Which operations this module owns.
 * @param op - candidate operation.
 * @returns true when the operation moves cards to or from cold storage.
 */
export function isArchiveOp(op) {
  return op !== null && op !== undefined && typeof op === 'object'
    && (op.type === 'board.archive' || op.type === 'board.restore')
}

/**
 * Take cards out of a board document, in place.
 *
 * Pure: the caller decides when to persist. Returns the cards that were found so
 * the caller can write them to the archive *before* the board loses them.
 *
 * @param board - board document (mutated).
 * @param projectId - project identity.
 * @param taskIds - ids to remove.
 * @returns `{ tasks, missing, projectName }`.
 */
export function takeCards(board, projectId, taskIds) {
  const wanted = new Set(Array.isArray(taskIds) ? taskIds.filter(id => typeof id === 'string') : [])
  const project = (Array.isArray(board.projects) ? board.projects : []).find(entry => entry.id === projectId)
  if (project === undefined) return { tasks: [], missing: [...wanted], projectName: '' }
  const tasks = []
  const kept = []
  for (const task of project.tasks) {
    if (wanted.has(task.id)) tasks.push(task)
    else kept.push(task)
  }
  project.tasks = kept
  const removed = new Set(tasks.map(task => task.id))
  project.trash = (Array.isArray(project.trash) ? project.trash : []).filter(entry => !removed.has(entry.taskId))
  return { tasks, missing: [...wanted].filter(id => !removed.has(id)), projectName: project.name }
}

/**
 * Put archived cards back into a board document, in place.
 * @param board - board document (mutated).
 * @param projectId - project identity, created when it disappeared.
 * @param projectName - name used when the project must be recreated.
 * @param tasks - cards to restore.
 * @returns how many were actually added.
 */
export function putCards(board, projectId, projectName, tasks) {
  let project = (Array.isArray(board.projects) ? board.projects : []).find(entry => entry.id === projectId)
  if (project === undefined) {
    project = {
      id: projectId,
      name: projectName === '' ? '恢复的项目' : projectName,
      tasks: [],
      memory: [],
      materials: '',
      plan: null,
      trash: [],
      acceptanceMode: 'auto',
      acceptanceRules: { requireEvidence: true, requireDeliverables: false, verifyDeliverables: true, requireSession: false, requireVerifiedClaim: false },
      requiredLayers: [],
      gates: { review: { requireEvidence: false, requireDeliverables: false }, done: { requireEvidence: false, requireDeliverables: false } },
      anchor: { digest: '', decisions: [], risks: [], deviations: [], updatedAt: 0 },
      lastCheckAt: 0,
      rootDir: '',
    }
    board.projects.push(project)
  }
  const known = new Set(project.tasks.map(task => task.id))
  let added = 0
  for (const task of tasks) {
    if (known.has(task.id)) continue
    project.tasks.push(task)
    known.add(task.id)
    added += 1
  }
  return added
}