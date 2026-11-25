/**
 * Project board HTTP surface.
 *
 * Two exact routes on the Host web server:
 *   GET  /greenlight/state  → { revision, board, recovered }
 *   POST /greenlight/ops    → { ok, revision, board, rejected }
 *
 * The POST route is a same-origin-only endpoint by construction: it requires a
 * custom request header, which a cross-origin page cannot send without a CORS
 * preflight this route never answers. The board is local state, so no further
 * authority is claimed.
 */
import { OP_ORIGIN_UI, applyOps } from './board.js'
import { archivedCount, isArchiveOp, putCards, takeCards } from './archive.js'
import { prepareBatch } from './verify.js'

/** Request bodies larger than this are refused. */
const MAX_BODY_BYTES = 384 * 1024
/** Operations accepted in one request. */
const MAX_OPS = 200
/** Header a same-origin fetch sets; cross-origin pages cannot add it silently. */
export const GUARD_HEADER = 'x-greenlight'
/** HTTP status used for a write from a non-conforming caller. */
const STATUS_FORBIDDEN = 403
/** HTTP status used for an oversized request. */
const STATUS_TOO_LARGE = 413
/** HTTP status used for a stale revision. */
const STATUS_CONFLICT = 409

/**
 * Answer with JSON.
 * @param res - server response.
 * @param status - HTTP status.
 * @param body - JSON-serializable body.
 */
function sendJson(res, status, body) {
  const text = JSON.stringify(body)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(text),
  })
  res.end(text)
}

/**
 * Answer a Fetch request with JSON.
 * @param status - HTTP status.
 * @param body - JSON-serializable body.
 * @returns the Fetch response.
 */
function jsonResponse(status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  })
}

/**
 * Read a request body with a hard size bound.
 * @param req - Node request.
 * @returns { text, tooLarge } where tooLarge means the body was refused.
 */
function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    let settled = false
    req.on('data', (chunk) => {
      if (settled) return
      size += chunk.length
      if (size > MAX_BODY_BYTES) {
        settled = true
        chunks.length = 0
        // Drain the rest instead of destroying the request: destroying the
        // socket here would kill the connection before the 413 can be sent.
        if (typeof req.resume === 'function') req.resume()
        resolve({ text: '', tooLarge: true })
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      if (settled) return
      settled = true
      resolve({ text: Buffer.concat(chunks).toString('utf8'), tooLarge: false })
    })
    req.on('error', (error) => {
      if (settled) return
      settled = true
      reject(error)
    })
  })
}

/**
 * Build the route registrations for `ctx.webServer.register`.
 * @param store - the board store.
 * @param options - optional `eventsIntervalMs` for the SSE tick (tests use a short one).
 * @returns route objects: GET state, GET events, POST ops.
 */
export function createBoardRoutes(store, options) {
  const eventsIntervalMs = options !== null && options !== undefined && typeof options.eventsIntervalMs === 'number'
    ? options.eventsIntervalMs
    : 2000
  const archiver = options === null || options === undefined ? undefined : options.archiver

  /**
   * Persist cards to cold storage, then drop them from the board draft.
   *
   * The archive write happens first on purpose: a crash between the two leaves
   * the card in both places, which is recoverable, instead of in neither.
   * @param draft - board draft (mutated).
   * @param op - archive operation.
   * @returns `{ changed, rejected }`.
   */
  async function applyArchive(draft, op) {
    if (archiver === undefined) return { changed: false, rejected: [{ op, code: 'archive_unavailable' }] }
    if (typeof op.projectId !== 'string') return { changed: false, rejected: [{ op, code: 'invalid_field' }] }
    const taken = takeCards(draft, op.projectId, op.taskIds)
    if (taken.tasks.length === 0) return { changed: false, rejected: [{ op, code: 'unknown_task' }] }
    await archiver.appendTasks({ id: op.projectId, name: taken.projectName }, taken.tasks)
    draft.revision = (draft.revision | 0) + 1
    draft.updatedAt = new Date().toISOString()
    return { changed: true, rejected: [] }
  }

  /**
   * Put cards back from cold storage into the board draft.
   * @param draft - board draft (mutated).
   * @param op - restore operation.
   * @param found - cards read from the archive beforehand.
   * @returns `{ changed, rejected }`.
   */
  function applyRestore(draft, op, found) {
    if (typeof op.projectId !== 'string') return { changed: false, rejected: [{ op, code: 'invalid_field' }] }
    const added = putCards(draft, op.projectId, found.projectName, found.tasks)
    if (added === 0) return { changed: false, rejected: [{ op, code: 'unknown_task' }] }
    draft.revision = (draft.revision | 0) + 1
    draft.updatedAt = new Date().toISOString()
    return { changed: true, rejected: [] }
  }

  /** GET /greenlight/archive */
  const archiveRoute = {
    kind: 'exact',
    path: '/greenlight/archive',
    async resource() {
      if (archiver === undefined) return jsonResponse(200, { ok: true, count: 0, projects: [] })
      await archiver.init()
      const archived = archiver.snapshot()
      return jsonResponse(200, {
        ok: true,
        count: archivedCount(archived),
        updatedAt: archived.updatedAt,
        projects: archived.projects,
      })
    },
  }
  /** GET /greenlight/state */
  const stateRoute = {
    kind: 'exact',
    path: '/greenlight/state',
    async resource() {
      await store.init()
      return jsonResponse(200, {
        revision: store.snapshot().revision,
        board: store.snapshot(),
        recovered: store.wasRecovered(),
      })
    },
  }

  /**
   * GET /greenlight/events — server-sent revision notifications.
   *
   * The payload is only a revision number: a subscriber that sees a newer one
   * re-reads `/greenlight/state`, so the two routes cannot disagree.
   */
  const eventsRoute = {
    kind: 'exact',
    path: '/greenlight/events',
    handler(req, res) {
      res.writeHead(200, {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-store',
        connection: 'keep-alive',
      })
      let closed = false
      let lastRevision = -1
      const sendRevision = (revision) => {
        try {
          res.write('event: revision\ndata: ' + JSON.stringify({ revision }) + '\n\n')
        } catch (error) {
          /* the socket is already gone */
        }
      }
      const tick = () => {
        if (closed) return
        let revision
        try {
          revision = store.snapshot().revision
        } catch (error) {
          return
        }
        if (revision !== lastRevision) {
          lastRevision = revision
          sendRevision(revision)
          return
        }
        try {
          res.write(': keep-alive\n\n')
        } catch (error) {
          /* the socket is already gone */
        }
      }
      const close = () => {
        if (closed) return
        closed = true
        clearInterval(timer)
        try {
          res.end()
        } catch (error) {
          /* already closed */
        }
      }
      void store.init().then(tick, () => undefined)
      const timer = setInterval(tick, eventsIntervalMs)
      // A caller without event emitters (a unit test's fake request) still gets
      // a well-formed response; it must not leave the tick behind either.
      const canListen = typeof req.on === 'function' && typeof res.on === 'function'
      if (canListen) {
        req.on('close', close)
        res.on('close', close)
      } else {
        clearInterval(timer)
      }
    },
  }

  /** POST /greenlight/ops */
  const opsRoute = {
    kind: 'exact',
    path: '/greenlight/ops',
    async handler(req, res) {
      if (req.method !== 'POST') {
        sendJson(res, 405, { ok: false, code: 'method_not_allowed' })
        return
      }
      if (req.headers[GUARD_HEADER] !== '1') {
        sendJson(res, STATUS_FORBIDDEN, { ok: false, code: 'forbidden' })
        return
      }
      let body
      try {
        body = await readBody(req)
      } catch (error) {
        sendJson(res, 400, { ok: false, code: 'unreadable_body' })
        return
      }
      if (body.tooLarge) {
        sendJson(res, STATUS_TOO_LARGE, { ok: false, code: 'too_large' })
        return
      }
      let payload
      try {
        payload = JSON.parse(body.text === '' ? '{}' : body.text)
      } catch (error) {
        sendJson(res, 400, { ok: false, code: 'invalid_json' })
        return
      }
      if (payload === null || typeof payload !== 'object' || !Array.isArray(payload.ops)) {
        sendJson(res, 400, { ok: false, code: 'invalid_ops' })
        return
      }
      if (payload.ops.length > MAX_OPS) {
        sendJson(res, STATUS_TOO_LARGE, { ok: false, code: 'too_many_ops' })
        return
      }

      await store.init()

      // Cards coming back from cold storage are read before the lock: the read
      // is idempotent and the removal from the archive happens only after the
      // board has committed, so a crash re-proposes the card instead of losing it.
      const restorePlan = []
      for (const op of payload.ops) {
        if (op === null || typeof op !== 'object' || op.type !== 'board.restore') continue
        const found = archiver === undefined
          ? { tasks: [], missing: [] }
          : await archiver.findTasks(op.projectId, op.taskIds)
        restorePlan.push({ op, found })
      }

      // The revision check has to run inside the serialized mutation: two
      // requests that read the same revision outside the lock would both pass
      // and the second write would silently win.
      let stale = null
      let rejected = []
      let committed
      try {
        committed = await store.mutate(async (draft) => {
          if (typeof payload.revision === 'number' && Number.isFinite(payload.revision)
            && payload.revision !== draft.revision) {
            stale = { revision: draft.revision, board: draft }
            return null
          }
          // Archive work happens on a copy so a partially applied batch cannot
          // leave the draft half-archived.
          let current = structuredClone(draft)
          let changed = false
          // A completion claim carrying deliverables is checked against the
          // filesystem before the board layer decides where the card lands.
          const boardOps = payload.ops.filter(op => !isArchiveOp(op))
          const prepared = await prepareBatch(current, boardOps)
          const outcome = applyOps(current, prepared, OP_ORIGIN_UI)
          rejected = rejected.concat(outcome.rejected)
          if (outcome.board !== current) {
            current = outcome.board
            changed = true
          }
          for (const op of payload.ops) {
            if (op === null || typeof op !== 'object' || op.type !== 'board.archive') continue
            const result = await applyArchive(current, op)
            if (result.changed) changed = true
            rejected = rejected.concat(result.rejected)
          }
          for (const entry of restorePlan) {
            const result = applyRestore(current, entry.op, entry.found)
            if (result.changed) changed = true
            rejected = rejected.concat(result.rejected)
          }
          if (!changed) return null
          return current
        })
      } catch (error) {
        sendJson(res, 500, { ok: false, code: 'store_failed', message: String(error && error.message ? error.message : error) })
        return
      }

      // The board now owns these cards, so they may leave cold storage.
      if (committed !== null && committed !== undefined && archiver !== undefined) {
        for (const entry of restorePlan) {
          if (entry.found.tasks.length === 0) continue
          const refused = rejected.some(item => item.op === entry.op)
          if (refused) continue
          await archiver.removeTasks(entry.op.projectId, entry.found.tasks.map(task => task.id))
        }
      }

      if (stale !== null) {
        sendJson(res, STATUS_CONFLICT, {
          ok: false,
          code: 'stale_revision',
          revision: stale.revision,
          board: stale.board,
        })
        return
      }

      sendJson(res, 200, {
        ok: true,
        revision: committed.revision,
        board: committed,
        rejected,
      })
    },
  }

  return [stateRoute, eventsRoute, opsRoute, archiveRoute]
}