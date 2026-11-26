/**
 * Edge-case tests for the Greenlight board Host half: request bounds, duplicate
 * ids, clamping, revision normalization and diagnostics.
 * Run with: node --test host/test
 */
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { apply, diagnostics } from '../../index.js'
import { applyOp, applyOps, emptyBoard, normalizeBoard } from '../board.js'
import { GUARD_HEADER, createBoardRoutes } from '../routes.js'
import { createStore } from '../store.js'

/**
 * @returns {Promise<object>} a store over a temporary document.
 */
async function makeStore() {
  const dir = await mkdtemp(join(tmpdir(), 'greenlight-edge-'))
  const store = createStore(join(dir, 'board.json'))
  await store.init()
  return store
}

/**
 * Call the ops handler with a fake request/response pair.
 * @param route - ops route.
 * @param body - request body text.
 * @param headers - request headers.
 * @returns { status, body } parsed response.
 */
async function callOps(route, body, headers) {
  const req = new EventEmitter()
  req.method = 'POST'
  req.headers = headers === undefined ? { [GUARD_HEADER]: '1' } : headers
  // The real request aborts an oversized body; the fake must survive that call.
  req.destroy = () => {}
  const res = {
    status: 0,
    text: '',
    writeHead(status) { this.status = status },
    end(text) { this.text = text === undefined ? '' : String(text) },
  }
  const done = route.handler(req, res)
  queueMicrotask(() => {
    if (body !== '') req.emit('data', Buffer.from(body, 'utf8'))
    req.emit('end')
  })
  await done
  let parsed = null
  try {
    parsed = res.text === '' ? null : JSON.parse(res.text)
  } catch (error) {
    parsed = res.text
  }
  return { status: res.status, body: parsed }
}

test('an oversized request body is refused before parsing', async () => {
  const store = await makeStore()
  const opsRoute = createBoardRoutes(store).find(route => route.path === '/greenlight/ops')
  const huge = 'x'.repeat(400 * 1024)
  const outcome = await callOps(opsRoute, JSON.stringify({ revision: 0, ops: [], padding: huge }))
  assert.equal(outcome.status, 413)
  assert.equal(outcome.body.code, 'too_large')
})

test('normalizeBoard floors a negative or fractional revision', () => {
  assert.equal(normalizeBoard({ revision: -5, projects: [] }).revision, 0)
  assert.equal(normalizeBoard({ revision: 4.7, projects: [] }).revision, 4)
})

test('duplicate ids are rejected per entity kind', () => {
  const board = emptyBoard()
  assert.equal(applyOp(board, { type: 'project.add', id: 'p', name: 'P' }), null)
  assert.equal(applyOp(board, { type: 'task.add', projectId: 'p', id: 't', title: 'T' }), null)
  assert.equal(applyOp(board, { type: 'task.add', projectId: 'p', id: 't', title: 'T2' }), 'duplicate_id')
  assert.equal(applyOp(board, { type: 'memory.add', projectId: 'p', id: 'm', text: 'x' }), null)
  assert.equal(applyOp(board, { type: 'memory.add', projectId: 'p', id: 'm', text: 'y' }), 'duplicate_id')
  assert.equal(board.projects[0].tasks.length, 1)
  assert.equal(board.projects[0].memory.length, 1)
})

test('titles and notes are bounded, not rejected', () => {
  const board = emptyBoard()
  applyOp(board, { type: 'project.add', id: 'p', name: 'P' })
  assert.equal(applyOp(board, { type: 'task.add', projectId: 'p', id: 't', title: 'x'.repeat(500) }), null)
  assert.equal(board.projects[0].tasks[0].title.length, 200)
  assert.equal(applyOp(board, { type: 'task.patch', projectId: 'p', taskId: 't', patch: { note: 'y'.repeat(20000) } }), null)
  assert.equal(board.projects[0].tasks[0].note.length, 8000)
})

test('task.move can carry a progress value and rejects unknown columns', () => {
  const board = emptyBoard()
  applyOp(board, { type: 'project.add', id: 'p', name: 'P' })
  applyOp(board, { type: 'task.add', projectId: 'p', id: 't', title: 'T' })
  // Closing a card is a human action, so the panel origin is required here.
  assert.equal(applyOp(board, { type: 'task.move', projectId: 'p', taskId: 't', status: 'done', progress: 100 }, 'ui'), null)
  assert.equal(board.projects[0].tasks[0].progress, 100)
  assert.equal(applyOp(board, { type: 'task.move', projectId: 'p', taskId: 't', status: 'nope' }), 'invalid_field')
})

test('a batch reports every rejection and keeps applied work', () => {
  const board = emptyBoard()
  const outcome = applyOps(board, [
    { opId: '1', type: 'project.add', id: 'p', name: 'P' },
    { opId: '2', type: 'task.add', projectId: 'p', id: 't', title: 'T' },
    { opId: '3', type: 'task.patch', projectId: 'p', taskId: 'missing', patch: { progress: 1 } },
    { opId: '4', type: 'memory.add', projectId: 'p', id: 'm', text: '记忆' },
  ])
  assert.equal(outcome.rejected.length, 1)
  assert.equal(outcome.rejected[0].index, 2)
  assert.equal(outcome.board.projects[0].tasks.length, 1)
  assert.equal(outcome.board.projects[0].memory.length, 1)
})

test('two stores over one file keep the last write, and a reload sees it', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'greenlight-edge-store-'))
  const file = join(dir, 'board.json')
  const first = createStore(file)
  await first.init()
  await first.mutate(draft => applyOps(draft, [{ type: 'project.add', id: 'p1', name: 'One' }]).board)

  const second = createStore(file)
  await second.init()
  assert.equal(second.snapshot().projects.length, 1, 'a fresh store sees the persisted board')
  await second.mutate(draft => applyOps(draft, [{ type: 'project.add', id: 'p2', name: 'Two' }]).board)

  const third = createStore(file)
  await third.init()
  assert.deepEqual(third.snapshot().projects.map(project => project.id), ['p1', 'p2'])
})

test('diagnostics report the last mount', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'greenlight-edge-diag-'))
  const routes = []
  const tools = []
  const ctx = {
    effect(fn) { fn() },
    webServer: { register(route) { routes.push(route); return () => {} } },
    inject(deps, callback) {
      callback({ tools: { register(definition) { tools.push(definition); return () => {} } }, effect(fn) { fn() } })
    },
  }
  apply(ctx, { boardFile: join(dir, 'board.json') })
  const state = diagnostics()
  assert.equal(state.registered.length, 16)
  assert.deepEqual(state.errors, [])
  assert.equal(state.serviceMissing, false)

  const diagRoute = routes.find(route => route.path === '/greenlight/diagnostics')
  const body = await (await diagRoute.resource(new Request('http://127.0.0.1/greenlight/diagnostics'))).json()
  assert.equal(body.tools.registered.length, 16)
  assert.equal(body.boardFile, join(dir, 'board.json'))
})

test('the ops route accepts a batch of exactly 200 operations', async () => {
  const store = await makeStore()
  const opsRoute = createBoardRoutes(store).find(route => route.path === '/greenlight/ops')
  const ops = [{ type: 'project.add', id: 'p', name: 'P' }]
  for (let index = 0; index < 199; index += 1) {
    ops.push({ type: 'task.add', projectId: 'p', id: 't' + index, title: 'T' + index })
  }
  const outcome = await callOps(opsRoute, JSON.stringify({ revision: 0, ops }))
  assert.equal(outcome.status, 200)
  assert.equal(outcome.body.rejected.length, 0)
  assert.equal(outcome.body.board.projects[0].tasks.length, 199)
})