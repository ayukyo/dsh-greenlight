/**
 * Greenlight board store — the Host's authoritative document on disk.
 *
 * Writes are serialized through one promise chain and are atomic (temp file +
 * rename), so a crash cannot leave a half-written document. A document that
 * cannot be parsed is moved aside instead of being overwritten, and the board
 * starts empty with a `recovered` flag the browser can show.
 */
import { mkdir, open, readFile, readdir, rename, unlink, writeFile } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { emptyBoard, normalizeBoard } from './board.js'

/**
 * @param file - absolute path of the board document.
 * @returns the store.
 */
/** How many automatic pre-replace backups to keep. */
export const MAX_BACKUPS = 10

/**
 * Create the board store.
 * @param file - absolute document path.
 * @returns the store.
 */
export function createStore(file) {
  let board = emptyBoard()
  let recovered = false
  let loaded = false
  let queue = Promise.resolve()

  /**
   * Read the document from disk once.
   * @returns completion after the in-memory board is ready.
   */
  async function init() {
    if (loaded) return
    loaded = true
    let text
    try {
      text = await readFile(file, 'utf8')
    } catch (error) {
      if (error !== null && error !== undefined && error.code === 'ENOENT') {
        board = emptyBoard()
        return
      }
      recovered = true
      board = emptyBoard()
      return
    }
    try {
      const parsed = JSON.parse(text)
      const normalized = normalizeBoard(parsed)
      if (normalized.projects.length === 0 && parsed !== null && typeof parsed === 'object'
        && Array.isArray(parsed.projects) && parsed.projects.length > 0) {
        throw new Error('board document held no usable project')
      }
      board = normalized
    } catch (error) {
      recovered = true
      const stamp = new Date().toISOString().replace(/[:.]/g, '-')
      try {
        await rename(file, join(dirname(file), 'board.json.corrupt-' + stamp))
      } catch (renameError) {
        /* the unusable file stays where it is; the board still starts empty */
      }
      board = emptyBoard()
    }
  }

  /**
   * Write the board to disk atomically, then read it back.
   *
   * `fsync` before the rename means the bytes are on the platter before the name
   * flips, so a power cut cannot leave a renamed-but-empty document. The
   * read-back catches a short or corrupted write while the previous file is
   * still intact.
   * @param next - board to persist.
   * @returns completion.
   */
  async function persist(next) {
    await mkdir(dirname(file), { recursive: true })
    const text = JSON.stringify(next)
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
      throw new Error('board write verification failed: content mismatch')
    }
    await rename(temporary, file)
  }

  /**
   * Run one mutation under the store lock.
   *
   * `change` may be asynchronous; it is awaited inside the lock so an
   * acceptance check that touches the filesystem cannot race a concurrent write.
   * @param change - receives a clone of the current board and returns the next board.
   * @returns the committed board.
   */
  function mutate(change) {
    const run = queue.then(async () => {
      await init()
      const draft = structuredClone(board)
      const next = await change(draft)
      if (next === null || next === undefined) return board
      await persist(next)
      board = next
      return board
    })
    // A failed write must not wedge later mutations.
    queue = run.catch(() => undefined)
    return run
  }

  /**
   * Keep a copy of the document on disk before something replaces it wholesale.
   *
   * An import or a whole-document replace can delete work no undo can reach, so
   * the previous file is parked beside it first. Only the newest few are kept.
   * @param reason - short tag written into the file name.
   * @returns the backup path, or an empty string when there was nothing to copy.
   */
  async function backup(reason) {
    let text
    try {
      text = await readFile(file, 'utf8')
    } catch (error) {
      return ''
    }
    if (text.trim() === '') return ''
    const stamp = new Date().toISOString().replace(/[:.]/g, '-')
    const tag = typeof reason === 'string' && reason !== '' ? '-' + reason.replace(/[^a-z0-9-]/gi, '') : ''
    const target = file + '.backup-' + stamp + tag
    try {
      await writeFile(target, text, 'utf8')
    } catch (error) {
      return ''
    }
    await prune()
    return target
  }

  /**
   * Drop old automatic backups, keeping the newest {@link MAX_BACKUPS}.
   * @returns completion.
   */
  async function prune() {
    const dir = dirname(file)
    const prefix = basename(file) + '.backup-'
    let names
    try {
      names = await readdir(dir)
    } catch (error) {
      return
    }
    const mine = names.filter(name => name.startsWith(prefix)).sort()
    const extra = mine.slice(0, Math.max(0, mine.length - MAX_BACKUPS))
    for (const name of extra) {
      try {
        await unlink(join(dir, name))
      } catch (error) {
        /* a backup that cannot be pruned is harmless */
      }
    }
  }

  return {
    /**
     * @returns the current board (a clone; callers cannot mutate it).
     */
    snapshot() {
      return structuredClone(board)
    },
    /**
     * @returns whether the last load had to set an unusable document aside.
     */
    wasRecovered() {
      return recovered
    },
    /**
     * @returns the absolute document path.
     */
    path() {
      return file
    },
    init,
    mutate,
    backup,
  }
}