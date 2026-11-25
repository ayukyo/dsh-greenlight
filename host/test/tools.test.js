/**
 * Tool-layer and plugin-assembly tests for the project board Host half.
 * Run with: node --test host/test
 */
import assert from 'node:assert/strict'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { apply, diagnostics } from '../../index.js'
import { createStore } from '../store.js'
import { createBoardTools } from '../tools.js'

/**
 * @returns {Promise<object>} a store over a temporary document.
 */
async function makeStore() {
  const dir = await mkdtemp(join(tmpdir(), 'greenlight-tools-'))
  const store = createStore(join(dir, 'board.json'))
  await store.init()
  return store
}

/**
 * Find one tool by name.
 * @param tools - tool list.
 * @param name - tool name.
 * @returns the tool.
 */
function toolNamed(tools, name) {
  const found = tools.find(tool => tool.name === name)
  assert.ok(found !== undefined, 'missing tool ' + name)
  return found
}

/**
 * @returns the module-level diagnostics snapshot.
 */
function diagnosticsState() {
  return diagnostics()
}

/**
 * Build a fake Host context that records registrations and supports the
 * optional-service wiring (`ctx.inject`) the plugin uses.
 * @returns { routes, tools, ctx } recorded registrations.
 */
function fakeHostContext() {
  const routes = []
  const tools = []
  const registry = { register(definition) { tools.push(definition); return () => {} } }
  const ctx = {
    effect(fn) {
      const cleanup = fn()
      if (typeof cleanup === 'function') cleanup()
    },
    webServer: {
      register(route) {
        routes.push(route)
        return () => {}
      },
    },
    inject(deps, callback) {
      assert.deepEqual(deps, ['tools'])
      const child = {
        tools: registry,
        effect(fn) {
          const cleanup = fn()
          if (typeof cleanup === 'function') cleanup()
        },
      }
      callback(child, undefined)
      return Promise.resolve()
    },
    get(name) {
      return name === 'tools' ? registry : undefined
    },
    logger: { warn() {} },
  }
  return { routes, tools, ctx }
}

test('the Host half registers routes and every tool', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'greenlight-assembly-'))
  const { routes, tools, ctx } = fakeHostContext()
  apply(ctx, { boardFile: join(dir, 'board.json') })
  assert.deepEqual(routes.map(route => route.path), [
    '/greenlight/state',
    '/greenlight/events',
    '/greenlight/ops',
    '/greenlight/archive',
    '/greenlight/diagnostics',
  ])
  assert.deepEqual(routes.map(route => route.kind), ['exact', 'exact', 'exact', 'exact', 'exact'])
  assert.ok(typeof routes[0].resource === 'function')
  assert.ok(typeof routes[1].handler === 'function')
  assert.ok(typeof routes[2].handler === 'function')
  assert.ok(typeof routes[3].resource === 'function')
  assert.ok(typeof routes[4].resource === 'function')
  assert.deepEqual(tools.map(tool => tool.name).sort(), [
    'greenlight_acceptance',
    'greenlight_archive',
    'greenlight_memory_add',
    'greenlight_overview',
    'greenlight_preview',
    'greenlight_project',
    'greenlight_recheck',
    'greenlight_review',
    'greenlight_session_attach',
    'greenlight_shared_entry',
    'greenlight_shared_set',
    'greenlight_task_create',
    'greenlight_task_submit',
    'greenlight_task_update',
    'greenlight_trash',
  ])
  for (const tool of tools) {
    assert.equal(typeof tool.description, 'string')
    assert.equal(typeof tool.parameters, 'object')
    assert.equal(typeof tool.output.schema, 'object')
    assert.equal(typeof tool.output.render, 'function')
    assert.equal(typeof tool.execute, 'function')
  }
  const diagnostics = diagnosticsState()
  assert.equal(diagnostics.registered.length, 15)
  assert.deepEqual(diagnostics.errors, [])
  assert.equal(diagnostics.serviceMissing, false)
})

test('the diagnostics route reports the mounted surface', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'greenlight-diagnostics-'))
  const { routes, ctx } = fakeHostContext()
  apply(ctx, { boardFile: join(dir, 'board.json') })
  const route = routes.find(entry => entry.path === '/greenlight/diagnostics')
  const response = await route.resource(new Request('http://127.0.0.1/greenlight/diagnostics'))
  const body = await response.json()
  assert.equal(response.status, 200)
  assert.equal(body.ok, true)
  assert.equal(body.plugin, 'greenlight')
  assert.equal(body.tools.registered.length, 15)
  assert.equal(body.boardFile, join(dir, 'board.json'))
})

test('enabled:false mounts nothing', async () => {
  const { routes, tools, ctx } = fakeHostContext()
  apply(ctx, { enabled: false })
  assert.equal(routes.length, 0)
  assert.equal(tools.length, 0)
})

test('tools read and write through the same store as the routes', async () => {
  const store = await makeStore()
  const tools = createBoardTools(store)

  const overviewEmpty = await toolNamed(tools, 'greenlight_overview').execute({}, {})
  assert.deepEqual(overviewEmpty.projects, [])

  const created = await toolNamed(tools, 'greenlight_task_create')
  await assert.rejects(() => created.execute({ projectId: 'nope', title: 'x' }, {}), /项目不存在/)

  await store.mutate((draft) => {
    draft.projects.push({ id: 'p1', name: 'Alpha', shared: '', tasks: [], memory: [], createdAt: Date.now() })
    return draft
  })

  const overview = await toolNamed(tools, 'greenlight_overview').execute({}, {})
  assert.equal(overview.projects.length, 1)
  assert.equal(overview.projects[0].name, 'Alpha')
  assert.equal(overview.projects[0].percent, 0)
  assert.equal(overview.projects[0].tone, 'idle')

  const task = await created.execute({ projectId: 'p1', title: '第一件事', note: '描述' }, {})
  assert.ok(typeof task.taskId === 'string' && task.taskId !== '')

  const updated = await toolNamed(tools, 'greenlight_task_update')
  const result = await updated.execute({ projectId: 'p1', taskId: task.taskId, progress: 55, blocked: true }, {})
  assert.equal(result.progress, 55)
  assert.equal(result.status, 'todo')
  await assert.rejects(() => updated.execute({ projectId: 'p1', taskId: task.taskId }, {}), /至少要给出/)
  await assert.rejects(() => updated.execute({ projectId: 'p1', taskId: task.taskId, status: 'nope' }, {}), /不合法/)

  const memory = await toolNamed(tools, 'greenlight_memory_add')
  const entry = await memory.execute({ projectId: 'p1', text: '约定：先评审', taskId: task.taskId }, {})
  assert.ok(typeof entry.memoryId === 'string' && entry.memoryId !== '')

  const shared = await toolNamed(tools, 'greenlight_shared_set')
  const sharedResult = await shared.execute({ projectId: 'p1', text: 'docs/spec.md' }, {})
  assert.equal(sharedResult.length, 'docs/spec.md'.length)

  const attach = await toolNamed(tools, 'greenlight_session_attach')
  const bound = await attach.execute({ projectId: 'p1', taskId: task.taskId, sessionId: 'sess-1' }, {})
  assert.equal(bound.sessionId, 'sess-1')

  const detail = await toolNamed(tools, 'greenlight_project').execute({ projectId: 'p1' }, {})
  assert.equal(detail.project.shared, 'docs/spec.md')
  assert.equal(detail.project.tasks[0].status, 'todo')
  assert.equal(detail.project.tasks[0].progress, 55)
  assert.equal(detail.project.tasks[0].sessionId, 'sess-1')
  assert.equal(detail.project.memory[0].text, '约定：先评审')
  assert.equal(detail.project.percent, 55)
  // The subtask is blocked, so the project band is red regardless of the average.
  assert.equal(detail.project.tone, 'red')
})

test('a tool completion is auto-accepted only when it is verifiable', async () => {
  const store = await makeStore()
  const tools = createBoardTools(store)
  const project = {
    id: 'p1',
    name: 'Alpha',
    acceptanceMode: 'auto',
    shared: '',
    sharedEntries: [],
    tasks: [],
    memory: [],
    trash: [],
    createdAt: Date.now(),
  }
  await store.mutate((draft) => {
    draft.projects.push(project)
    return draft
  })
  const create = toolNamed(tools, 'greenlight_task_create')
  const update = toolNamed(tools, 'greenlight_task_update')

  // Evidence recorded -> automatic acceptance closes the card.
  const clean = await create.execute({ projectId: 'p1', title: '可验收的事' }, {})
  const accepted = await update.execute({
    projectId: 'p1',
    taskId: clean.taskId,
    status: 'done',
    progress: 100,
    evidence: '跑通全部测试，30 项通过',
  }, {})
  assert.equal(accepted.status, 'done')
  assert.equal(accepted.acceptedBy, 'auto')
  const cleanTask = store.snapshot().projects[0].tasks.find(task => task.id === clean.taskId)
  assert.equal(cleanTask.status, 'done')
  assert.equal(cleanTask.acceptedBy, 'auto')

  // No evidence -> the card waits for a human and the tool says why.
  const vague = await create.execute({ projectId: 'p1', title: '说不清的事' }, {})
  const queued = await update.execute({ projectId: 'p1', taskId: vague.taskId, status: 'done', progress: 100 }, {})
  assert.equal(queued.status, 'review')
  assert.equal(queued.acceptedBy, '')
  assert.match(queued.reason, /完成说明/)
  const queuedTask = store.snapshot().projects[0].tasks.find(task => task.id === vague.taskId)
  assert.equal(queuedTask.status, 'review', 'an unverifiable completion waits for a human')
  assert.match(queuedTask.reviewReason, /完成说明/)

  // Ordinary field updates still land.
  const moved = await update.execute({ projectId: 'p1', taskId: vague.taskId, progress: 90 }, {})
  assert.equal(moved.status, 'review')
  assert.equal(moved.progress, 90)
})

test('the submit tool records evidence and settles the card', async () => {
  const store = await makeStore()
  const tools = createBoardTools(store)
  await store.mutate((draft) => {
    draft.projects.push({
      id: 'p1',
      name: 'Alpha',
      acceptanceMode: 'auto',
      shared: '',
      sharedEntries: [],
      tasks: [],
      memory: [],
      trash: [],
      createdAt: Date.now(),
    })
    return draft
  })
  const created = await toolNamed(tools, 'greenlight_task_create').execute({ projectId: 'p1', title: 'T' }, {})
  const submitted = await toolNamed(tools, 'greenlight_task_submit').execute({
    projectId: 'p1',
    taskId: created.taskId,
    evidence: '改了 lib/index.js 并跑了 vitest',
    progress: 100,
  }, {})
  assert.equal(submitted.status, 'done')
  assert.equal(submitted.acceptedBy, 'auto')
  const task = store.snapshot().projects[0].tasks[0]
  assert.equal(task.evidence, '改了 lib/index.js 并跑了 vitest')
})

test('a human-mode project keeps tool completions in review', async () => {
  const store = await makeStore()
  const tools = createBoardTools(store)
  await store.mutate((draft) => {
    draft.projects.push({
      id: 'p1',
      name: 'Alpha',
      acceptanceMode: 'human',
      shared: '',
      sharedEntries: [],
      tasks: [],
      memory: [],
      trash: [],
      createdAt: Date.now(),
    })
    return draft
  })
  const created = await toolNamed(tools, 'greenlight_task_create').execute({ projectId: 'p1', title: 'T' }, {})
  const submitted = await toolNamed(tools, 'greenlight_task_submit').execute({
    projectId: 'p1',
    taskId: created.taskId,
    evidence: '全做完了',
    progress: 100,
  }, {})
  assert.equal(submitted.status, 'review')
  assert.match(submitted.reason, /人工验收/)
})

test('agent tools can still record progress, notes and rejection reasons', async () => {
  const store = await makeStore()
  const tools = createBoardTools(store)
  await store.mutate((draft) => {
    draft.projects.push({ id: 'p1', name: 'Alpha', shared: '', sharedEntries: [], tasks: [], memory: [], trash: [], createdAt: Date.now() })
    return draft
  })
  const created = await toolNamed(tools, 'greenlight_task_create').execute({ projectId: 'p1', title: 'T' }, {})
  const update = toolNamed(tools, 'greenlight_task_update')
  const result = await update.execute({
    projectId: 'p1',
    taskId: created.taskId,
    status: 'failed',
    progress: 40,
    reviewReason: '证据不足',
  }, {})
  assert.equal(result.status, 'failed')
  const task = store.snapshot().projects[0].tasks[0]
  assert.equal(task.reviewReason, '证据不足')
  assert.equal(task.progress, 40)
})

test('the panel route may complete a card', async () => {
  const store = await makeStore()
  await store.mutate((draft) => {
    draft.projects.push({
      id: 'p1',
      name: 'Alpha',
      shared: '',
      sharedEntries: [],
      tasks: [{ id: 't1', title: 'T', status: 'review', progress: 90 }],
      memory: [],
      trash: [],
      createdAt: Date.now(),
    })
    return draft
  })
  const { applyOps, OP_ORIGIN_UI } = await import('../board.js')
  const outcome = store.mutate((draft) => applyOps(draft, [{ type: 'task.move', projectId: 'p1', taskId: 't1', status: 'done' }], OP_ORIGIN_UI).board)
  const board = await outcome
  assert.equal(board.projects[0].tasks[0].status, 'done')
})

test('tools can set priority, due date, tags and refs', async () => {
  const store = await makeStore()
  const tools = createBoardTools(store)
  await store.mutate((draft) => {
    draft.projects.push({ id: 'p1', name: 'Alpha', shared: '', sharedEntries: [], tasks: [], memory: [], trash: [], createdAt: Date.now() })
    return draft
  })
  const entry = await toolNamed(tools, 'greenlight_shared_entry').execute(
    { projectId: 'p1', action: 'add', name: '接口文档', path: 'docs/api.md' },
    {},
  )
  const sharedId = entry.entries[0].id

  const created = await toolNamed(tools, 'greenlight_task_create').execute({ projectId: 'p1', title: 'T' }, {})
  await toolNamed(tools, 'greenlight_task_update').execute({
    projectId: 'p1',
    taskId: created.taskId,
    priority: 'high',
    dueDate: '2026-12-31',
    tags: ['后端', '联调'],
    refs: [sharedId],
  }, {})

  const task = store.snapshot().projects[0].tasks[0]
  assert.equal(task.priority, 'high')
  assert.equal(task.dueDate, '2026-12-31')
  assert.deepEqual(task.tags, ['后端', '联调'])
  assert.deepEqual(task.refs, [sharedId])
})

test('the shared-entry tool lists and removes entries', async () => {
  const store = await makeStore()
  const tools = createBoardTools(store)
  await store.mutate((draft) => {
    draft.projects.push({ id: 'p1', name: 'Alpha', shared: '', sharedEntries: [], tasks: [], memory: [], trash: [], createdAt: Date.now() })
    return draft
  })
  const tool = toolNamed(tools, 'greenlight_shared_entry')
  const added = await tool.execute({ projectId: 'p1', action: 'add', name: 'A', path: 'a.md' }, {})
  assert.equal(added.entries.length, 1)
  const listed = await tool.execute({ projectId: 'p1', action: 'list' }, {})
  assert.equal(listed.entries[0].name, 'A')
  const removed = await tool.execute({ projectId: 'p1', action: 'remove', entryId: added.entries[0].id }, {})
  assert.equal(removed.entries.length, 0)
  await assert.rejects(() => tool.execute({ projectId: 'p1', action: 'nope' }, {}), /action 只能是/)
})

test('the trash tool lists and restores removed cards', async () => {
  const store = await makeStore()
  const tools = createBoardTools(store)
  await store.mutate((draft) => {
    draft.projects.push({ id: 'p1', name: 'Alpha', shared: '', sharedEntries: [], tasks: [], memory: [], trash: [], createdAt: Date.now() })
    return draft
  })
  const created = await toolNamed(tools, 'greenlight_task_create').execute({ projectId: 'p1', title: '删掉的卡' }, {})
  await store.mutate((draft) => {
    const project = draft.projects[0]
    project.trash.push({ task: project.tasks[0], index: 0, deletedAt: Date.now() })
    project.tasks = []
    return draft
  })
  const tool = toolNamed(tools, 'greenlight_trash')
  const listed = await tool.execute({ projectId: 'p1', action: 'list' }, {})
  assert.equal(listed.entries.length, 1)
  assert.equal(listed.entries[0].title, '删掉的卡')
  const restored = await tool.execute({ projectId: 'p1', action: 'restore', taskId: created.taskId }, {})
  assert.equal(restored.entries.length, 0)
  assert.equal(store.snapshot().projects[0].tasks.length, 1)
})

test('tool renders produce model-facing text', async () => {
  const store = await makeStore()
  const tools = createBoardTools(store)
  const overview = toolNamed(tools, 'greenlight_overview')

  const emptyValue = await overview.execute({}, {})
  const emptyContent = overview.output.render({}, emptyValue)
  assert.equal(emptyContent[0].type, 'text')
  assert.match(emptyContent[0].text, /还没有项目/)

  await store.mutate((draft) => {
    draft.projects.push({ id: 'p1', name: 'Alpha', shared: '', tasks: [], memory: [], createdAt: Date.now() })
    return draft
  })
  const value = await overview.execute({}, {})
  const content = overview.output.render({}, value)
  assert.match(content[0].text, /Alpha/)
  assert.match(content[0].text, /\[p1\]/)
})