/**
 * Socket-level integration test: the board routes behind a real node:http
 * server, called with real fetch. Verifies request handling, status codes and
 * JSON shapes without touching the running Harness.
 * Run with: node --test host/test
 */
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { GUARD_HEADER, createBoardRoutes } from '../routes.js'
import { createStore } from '../store.js'

/**
 * Start an HTTP server that dispatches to the board routes.
 * @param routes - route registrations.
 * @returns { origin, close } a base URL and a closer.
 */
async function startServer(routes) {
  const server = createServer(async (req, res) => {
    const pathname = new URL(req.url === undefined ? '/' : req.url, 'http://127.0.0.1').pathname
    for (const route of routes) {
      if (route.kind !== 'exact' || route.path !== pathname) continue
      if (typeof route.handler === 'function') {
        await route.handler(req, res)
        return
      }
      const request = new Request('http://127.0.0.1' + req.url, { method: req.method })
      const response = await route.resource(request)
      const text = await response.text()
      res.writeHead(response.status, Object.fromEntries(response.headers.entries()))
      res.end(text)
      return
    }
    res.writeHead(404, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ ok: false, code: 'not_found' }))
  })
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const address = server.address()
  return {
    origin: 'http://127.0.0.1:' + address.port,
    // An SSE subscriber keeps its socket open, so closing must be forced.
    close: () => new Promise((resolve) => {
      if (typeof server.closeAllConnections === 'function') server.closeAllConnections()
      server.close(resolve)
    }),
  }
}

/**
 * @returns {Promise<{ origin: string, close: Function }>} a server over a temp store.
 */
async function startBoard() {
  const dir = await mkdtemp(join(tmpdir(), 'greenlight-http-'))
  const store = createStore(join(dir, 'board.json'))
  await store.init()
  return startServer(createBoardRoutes(store))
}

test('an oversized body is answered with 413 over a real socket', async () => {
  const server = await startBoard()
  try {
    // A real socket is the point: destroying the request instead of draining it
    // would reset the connection and the caller would never see the 413.
    const response = await fetch(server.origin + '/greenlight/ops', {
      method: 'POST',
      headers: { 'content-type': 'application/json', [GUARD_HEADER]: '1' },
      body: JSON.stringify({ revision: 0, ops: [], padding: 'x'.repeat(400 * 1024) }),
    })
    assert.equal(response.status, 413)
    const body = await response.json()
    assert.equal(body.code, 'too_large')

    // The board must still be usable after a refused oversized request.
    const state = await (await fetch(server.origin + '/greenlight/state')).json()
    assert.equal(state.revision, 0)
  } finally {
    await server.close()
  }
})

test('GET state answers over a real socket', async () => {
  const server = await startBoard()
  try {
    const response = await fetch(server.origin + '/greenlight/state')
    assert.equal(response.status, 200)
    const body = await response.json()
    assert.equal(body.revision, 0)
    assert.deepEqual(body.board.projects, [])
  } finally {
    await server.close()
  }
})

test('POST ops round-trips over a real socket and persists to disk', async () => {
  const server = await startBoard()
  try {
    const forbidden = await fetch(server.origin + '/greenlight/ops', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ revision: 0, ops: [] }),
    })
    assert.equal(forbidden.status, 403)

    const created = await fetch(server.origin + '/greenlight/ops', {
      method: 'POST',
      headers: { 'content-type': 'application/json', [GUARD_HEADER]: '1' },
      body: JSON.stringify({ revision: 0, ops: [{ type: 'project.add', id: 'p1', name: 'Alpha' }] }),
    })
    assert.equal(created.status, 200)
    const body = await created.json()
    assert.equal(body.revision, 1)
    assert.equal(body.board.projects[0].name, 'Alpha')

    const state = await (await fetch(server.origin + '/greenlight/state')).json()
    assert.equal(state.revision, 1)
    assert.equal(state.board.projects[0].name, 'Alpha')

    const task = await fetch(server.origin + '/greenlight/ops', {
      method: 'POST',
      headers: { 'content-type': 'application/json', [GUARD_HEADER]: '1' },
      body: JSON.stringify({
        revision: 1,
        ops: [{ type: 'task.add', projectId: 'p1', id: 't1', title: '第一件事' }],
      }),
    })
    assert.equal(task.status, 200)
    const taskBody = await task.json()
    assert.equal(taskBody.board.projects[0].tasks[0].status, 'todo')
    assert.equal(taskBody.board.projects[0].tasks[0].title, '第一件事')

    const stale = await fetch(server.origin + '/greenlight/ops', {
      method: 'POST',
      headers: { 'content-type': 'application/json', [GUARD_HEADER]: '1' },
      body: JSON.stringify({ revision: 1, ops: [{ type: 'project.rename', projectId: 'p1', name: 'X' }] }),
    })
    assert.equal(stale.status, 409)
    const staleBody = await stale.json()
    assert.equal(staleBody.code, 'stale_revision')
    assert.equal(staleBody.revision, 2)
  } finally {
    await server.close()
  }
})