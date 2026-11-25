/**
 * HTTP surface tests for the Greenlight board Host half.
 * Run with: node --test host/test
 */
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { createStore } from '../store.js'
import { applyOps } from '../board.js'
import { GUARD_HEADER, createBoardRoutes } from '../routes.js'

/**
 * @returns {Promise<{ store: object, dir: string }>} a store over a temp file.
 */
async function makeStore() {
  const dir = await mkdtemp(join(tmpdir(), 'greenlight-routes-'))
  const store = createStore(join(dir, 'board.json'))
  await store.init()
  return { store, dir }
}

/**
 * Call the POST handler with a fake Node request/response pair.
 * @param route - the ops route.
 * @param options - method, headers and body text.
 * @returns { status, body } parsed from the response.
 */
async function callOps(route, options) {
  const req = new EventEmitter()
  req.method = options.method === undefined ? 'POST' : options.method
  req.headers = options.headers === undefined ? {} : options.headers
  const chunks = options.body === undefined ? [] : [Buffer.from(options.body, 'utf8')]
  const res = {
    status: 0,
    headers: null,
    text: '',
    writeHead(status, headers) {
      this.status = status
      this.headers = headers
    },
    end(text) {
      this.text = text === undefined ? '' : String(text)
    },
  }
  const done = route.handler(req, res)
  // Deliver the body on the next tick, the way a socket would.
  queueMicrotask(() => {
    for (const chunk of chunks) req.emit('data', chunk)
    req.emit('end')
  })
  await done
  let body = null
  try {
    body = res.text === '' ? null : JSON.parse(res.text)
  } catch (error) {
    body = res.text
  }
  return { status: res.status, body }
}

/**
 * Read the GET state resource.
 * @param route - the state route.
 * @returns parsed JSON body.
 */
async function callState(route) {
  const response = await route.resource(new Request('http://127.0.0.1/greenlight/state'))
  return { status: response.status, body: await response.json() }
}

test('GET state answers the current board', async () => {
  const { store } = await makeStore()
  const [stateRoute] = createBoardRoutes(store)
  const first = await callState(stateRoute)
  assert.equal(first.status, 200)
  assert.equal(first.body.revision, 0)
  assert.deepEqual(first.body.board.projects, [])
  assert.equal(first.body.recovered, false)
})

test('the events route streams revision frames and stops on close', async () => {
  const { store } = await makeStore()
  const routes = createBoardRoutes(store, { eventsIntervalMs: 5 })
  const events = routes.find(route => route.path === '/greenlight/events')
  assert.ok(events !== undefined)

  const chunks = []
  const req = new EventEmitter()
  req.on = req.on.bind(req)
  const res = new EventEmitter()
  res.writeHead = () => {}
  res.write = (chunk) => { chunks.push(String(chunk)); return true }
  res.end = () => { res.ended = true }

  events.handler(req, res)
  await new Promise(resolve => setTimeout(resolve, 40))
  const initial = chunks.join('')
  assert.match(initial, /event: revision/)
  assert.match(initial, /"revision":0/)

  // A write must be announced on the next tick.
  await store.mutate(draft => applyOps(draft, [{ type: 'project.add', id: 'p1', name: 'Alpha' }]).board)
  await new Promise(resolve => setTimeout(resolve, 40))
  const afterWrite = chunks.join('')
  assert.match(afterWrite, /"revision":1/, 'the stream pushes the new revision')

  res.emit('close')
  const before = chunks.length
  await new Promise(resolve => setTimeout(resolve, 40))
  assert.equal(chunks.length, before, 'the stream stops writing after close')
})

test('POST ops rejects calls without the same-origin header', async () => {
  const { store } = await makeStore()
  const opsRoute = createBoardRoutes(store).find(route => route.path === '/greenlight/ops')
  const outcome = await callOps(opsRoute, { body: JSON.stringify({ revision: 0, ops: [] }) })
  assert.equal(outcome.status, 403)
  assert.equal(outcome.body.code, 'forbidden')
})

test('POST ops rejects other methods and malformed bodies', async () => {
  const { store } = await makeStore()
  const opsRoute = createBoardRoutes(store).find(route => route.path === '/greenlight/ops')
  const headers = { [GUARD_HEADER]: '1' }

  const wrongMethod = await callOps(opsRoute, { method: 'GET', headers })
  assert.equal(wrongMethod.status, 405)

  const badJson = await callOps(opsRoute, { headers, body: '{oops' })
  assert.equal(badJson.status, 400)
  assert.equal(badJson.body.code, 'invalid_json')

  const noOps = await callOps(opsRoute, { headers, body: JSON.stringify({ revision: 0 }) })
  assert.equal(noOps.status, 400)
  assert.equal(noOps.body.code, 'invalid_ops')
})

test('POST ops refuses more than 200 operations', async () => {
  const { store } = await makeStore()
  const opsRoute = createBoardRoutes(store).find(route => route.path === '/greenlight/ops')
  const ops = Array.from({ length: 201 }, () => ({ type: 'project.rename', projectId: 'p', name: 'x' }))
  const outcome = await callOps(opsRoute, { headers: { [GUARD_HEADER]: '1' }, body: JSON.stringify({ revision: 0, ops }) })
  assert.equal(outcome.status, 413)
  assert.equal(outcome.body.code, 'too_many_ops')
})

test('POST ops applies a batch, bumps the revision, and reports rejections', async () => {
  const { store } = await makeStore()
  const opsRoute = createBoardRoutes(store).find(route => route.path === '/greenlight/ops')
  const headers = { [GUARD_HEADER]: '1' }

  const created = await callOps(opsRoute, {
    headers,
    body: JSON.stringify({
      revision: 0,
      ops: [{ opId: 'a', type: 'project.add', id: 'p1', name: 'Alpha' }],
    }),
  })
  assert.equal(created.status, 200)
  assert.equal(created.body.ok, true)
  assert.equal(created.body.revision, 1)
  assert.equal(created.body.board.projects[0].name, 'Alpha')
  assert.deepEqual(created.body.rejected, [])

  const mixed = await callOps(opsRoute, {
    headers,
    body: JSON.stringify({
      revision: 1,
      ops: [
        { opId: 'b', type: 'task.add', projectId: 'p1', id: 't1', title: '第一件事' },
        { opId: 'c', type: 'task.add', projectId: 'missing', id: 't2', title: 'x' },
      ],
    }),
  })
  assert.equal(mixed.status, 200)
  assert.equal(mixed.body.revision, 2)
  assert.equal(mixed.body.board.projects[0].tasks.length, 1)
  assert.equal(mixed.body.rejected.length, 1)
  assert.equal(mixed.body.rejected[0].code, 'unknown_project')
  assert.equal(mixed.body.rejected[0].opId, 'c')
})

test('POST ops refuses a stale revision and returns the current board', async () => {
  const { store } = await makeStore()
  const opsRoute = createBoardRoutes(store).find(route => route.path === '/greenlight/ops')
  const headers = { [GUARD_HEADER]: '1' }
  await callOps(opsRoute, { headers, body: JSON.stringify({ revision: 0, ops: [{ type: 'project.add', id: 'p1', name: 'Alpha' }] }) })

  const stale = await callOps(opsRoute, {
    headers,
    body: JSON.stringify({ revision: 0, ops: [{ type: 'project.add', id: 'p2', name: 'Beta' }] }),
  })
  assert.equal(stale.status, 409)
  assert.equal(stale.body.code, 'stale_revision')
  assert.equal(stale.body.revision, 1)
  assert.equal(stale.body.board.projects.length, 1, 'the caller can recover from the returned board')
})

test('two concurrent writes at the same revision: exactly one wins', async () => {
  const { store } = await makeStore()
  const opsRoute = createBoardRoutes(store).find(route => route.path === '/greenlight/ops')
  const headers = { [GUARD_HEADER]: '1' }
  // Both requests are in flight before either mutation runs; the revision
  // check must happen inside the store lock, or both would succeed.
  const request = (name) => callOps(opsRoute, {
    headers,
    body: JSON.stringify({ revision: 0, ops: [{ type: 'project.add', id: name, name }] }),
  })
  const [first, second] = await Promise.all([request('p-a'), request('p-b')])
  const statuses = [first.status, second.status].sort()
  assert.deepEqual(statuses, [200, 409], 'expected one winner and one conflict, got ' + statuses.join(','))

  const state = await callState(createBoardRoutes(store).find(route => route.path === '/greenlight/state'))
  assert.equal(state.body.revision, 1)
  assert.equal(state.body.board.projects.length, 1, 'the losing write must not be applied')
})

test('a stale revision returns the board the caller can recover from', async () => {
  const { store } = await makeStore()
  const opsRoute = createBoardRoutes(store).find(route => route.path === '/greenlight/ops')
  const headers = { [GUARD_HEADER]: '1' }
  await callOps(opsRoute, { headers, body: JSON.stringify({ revision: 0, ops: [{ type: 'project.add', id: 'p1', name: 'Alpha' }] }) })

  const stale = await callOps(opsRoute, { headers, body: JSON.stringify({ revision: 0, ops: [{ type: 'project.add', id: 'p2', name: 'Beta' }] }) })
  assert.equal(stale.status, 409)
  assert.equal(stale.body.revision, 1)
  assert.equal(stale.body.board.projects.length, 1)
  assert.equal(stale.body.board.projects[0].id, 'p1')
})

test('an empty batch does not advance the revision', async () => {
  const { store } = await makeStore()
  const opsRoute = createBoardRoutes(store).find(route => route.path === '/greenlight/ops')
  const headers = { [GUARD_HEADER]: '1' }
  const outcome = await callOps(opsRoute, { headers, body: JSON.stringify({ revision: 0, ops: [] }) })
  assert.equal(outcome.status, 200)
  assert.equal(outcome.body.revision, 0)
})

test('a fully rejected batch leaves the board revision untouched', async () => {
  const { store } = await makeStore()
  const opsRoute = createBoardRoutes(store).find(route => route.path === '/greenlight/ops')
  const headers = { [GUARD_HEADER]: '1' }
  await callOps(opsRoute, { headers, body: JSON.stringify({ revision: 0, ops: [{ type: 'project.add', id: 'p1', name: 'Alpha' }] }) })

  const rejected = await callOps(opsRoute, {
    headers,
    body: JSON.stringify({ revision: 1, ops: [{ type: 'project.rename', projectId: 'nope', name: 'X' }] }),
  })
  assert.equal(rejected.status, 200)
  assert.equal(rejected.body.revision, 1)
  assert.equal(rejected.body.rejected.length, 1)
})

test('board.import seeds an empty board through the HTTP surface', async () => {
  const { store } = await makeStore()
  const opsRoute = createBoardRoutes(store).find(route => route.path === '/greenlight/ops')
  const headers = { [GUARD_HEADER]: '1' }
  const imported = await callOps(opsRoute, {
    headers,
    body: JSON.stringify({
      revision: 0,
      ops: [{
        type: 'board.import',
        document: { version: 1, tasks: [{ id: 'a', title: '旧任务', status: 'done', session: '会话X' }] },
      }],
    }),
  })
  assert.equal(imported.status, 200)
  assert.equal(imported.body.board.projects[0].tasks[0].status, 'done')
  assert.equal(imported.body.board.projects[0].tasks[0].note, '会话X')
})