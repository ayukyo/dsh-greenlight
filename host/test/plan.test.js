/**
 * Schema v11 tests: the draft breakdown (`project.plan`).
 *
 * The material text itself is covered by `board.test.js`; a draft only carries
 * the card fields now, no references.
 *
 * Run with: node --test host/test
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  DOC_VERSION,
  MAX_PLAN_ITEMS,
  applyOp,
  applyOps,
  emptyBoard,
  normalizeBoard,
} from '../board.js'

/**
 * @returns {object} a board with one empty project called `p`.
 */
function seed() {
  const board = emptyBoard()
  assert.equal(applyOp(board, { type: 'project.add', id: 'p', name: 'P' }), null)
  return board
}

/**
 * @param {number} count - how many items to build.
 * @returns {object[]} readable plan items.
 */
function manyItems(count) {
  return Array.from({ length: count }, (unused, index) => ({ title: '事项 ' + (index + 1) }))
}

test('plan.set writes a draft with an id, a timestamp and normalized items', () => {
  const board = seed()
  const project = board.projects[0]
  assert.equal(project.plan, null)

  assert.equal(applyOp(board, {
    type: 'plan.set',
    projectId: 'p',
    summary: '  把旧静态站迁到新构建链路  ',
    items: [
      {
        title: '整理目录结构',
        note: '输出目录树与依赖清单',
        priority: 'high',
        tags: ['docs'],
        deliverables: ['docs/tree.md'],
      },
      { title: '迁移构建脚本' },
    ],
  }), null)

  const plan = project.plan
  assert.match(plan.id, /^plan-/)
  assert.equal(typeof plan.createdAt, 'number')
  assert.equal(plan.summary, '把旧静态站迁到新构建链路')
  assert.deepEqual(Object.keys(plan).sort(), ['createdAt', 'id', 'items', 'summary'], 'a plan stores nothing else')
  assert.equal(plan.items.length, 2)

  // Optional fields carry over; absent ones take the task defaults.
  const first = plan.items[0]
  assert.deepEqual(Object.keys(first).sort(), ['deliverables', 'note', 'priority', 'tags', 'title'])
  assert.equal(first.title, '整理目录结构')
  assert.equal(first.note, '输出目录树与依赖清单')
  assert.equal(first.priority, 'high')
  assert.deepEqual(first.tags, ['docs'])
  assert.deepEqual(first.deliverables, ['docs/tree.md'])

  const second = plan.items[1]
  assert.equal(second.title, '迁移构建脚本')
  assert.equal(second.note, '')
  assert.equal(second.priority, 'normal')
  assert.deepEqual(second.tags, [])
  assert.deepEqual(second.deliverables, [])

  // A second set replaces the draft instead of merging into it.
  const firstId = plan.id
  assert.equal(applyOp(board, { type: 'plan.set', projectId: 'p', summary: '再来一版', items: [{ title: '只留一项' }] }), null)
  assert.equal(project.plan.items.length, 1)
  assert.notEqual(project.plan.id, firstId, 'each draft gets its own id')

  // The draft round-trips through the document shape.
  const reloaded = normalizeBoard(board)
  assert.equal(reloaded.version, DOC_VERSION)
  const reloadedPlan = reloaded.projects[0].plan
  assert.equal(reloadedPlan.summary, '再来一版')
  assert.deepEqual(reloadedPlan.items.map(item => item.title), ['只留一项'])
  assert.equal(reloadedPlan.createdAt, project.plan.createdAt)
})

test('plan.set refuses invalid input and writes nothing', () => {
  const board = seed()
  const project = board.projects[0]
  assert.equal(applyOp(board, { type: 'plan.set', projectId: 'p', summary: 'x', items: [] }), 'invalid_field', 'a draft needs an item')
  assert.equal(applyOp(board, { type: 'plan.set', projectId: 'p', summary: 'x', items: 'nope' }), 'invalid_field')
  assert.equal(applyOp(board, { type: 'plan.set', projectId: 'p', summary: 'x', items: manyItems(MAX_PLAN_ITEMS + 1) }), 'invalid_field')
  assert.equal(applyOp(board, { type: 'plan.set', projectId: 'p', summary: 42, items: [{ title: 'T' }] }), 'invalid_field')
  assert.equal(applyOp(board, { type: 'plan.set', projectId: 'p', summary: 'x', items: [{ title: '' }] }), 'invalid_field', 'a title must not be blank')
  assert.equal(applyOp(board, { type: 'plan.set', projectId: 'p', summary: 'x', items: [{ title: '   ' }] }), 'invalid_field')
  assert.equal(applyOp(board, { type: 'plan.set', projectId: 'p', summary: 'x', items: [{ title: 'x'.repeat(201) }] }), 'invalid_field', 'a title is at most 200 characters')
  assert.equal(applyOp(board, { type: 'plan.set', projectId: 'p', summary: 'x', items: [{ title: 'T', priority: 'nope' }] }), 'invalid_field')
  assert.equal(applyOp(board, { type: 'plan.set', projectId: 'p', summary: 'x', items: [{ title: 'T', tags: 'nope' }] }), 'invalid_field')
  assert.equal(applyOp(board, { type: 'plan.set', projectId: 'p', summary: 'x', items: [{ note: 'no title' }] }), 'invalid_field')
  assert.equal(applyOp(board, { type: 'plan.set', projectId: 'nope', summary: 'x', items: [{ title: 'T' }] }), 'unknown_project')
  assert.equal(project.plan, null, 'a refused draft leaves nothing behind')

  // The 50-item bound is inclusive, and a refused overwrite keeps the old draft.
  assert.equal(applyOp(board, { type: 'plan.set', projectId: 'p', summary: '满', items: manyItems(MAX_PLAN_ITEMS) }), null)
  assert.equal(project.plan.items.length, MAX_PLAN_ITEMS)
  assert.equal(applyOp(board, { type: 'plan.set', projectId: 'p', summary: '坏', items: [{ title: '' }] }), 'invalid_field')
  assert.equal(project.plan.summary, '满', 'a refused overwrite changes nothing')
})

test('plan.set ignores the removed refs field an older client still sends', () => {
  const board = seed()
  const project = board.projects[0]
  assert.equal(applyOp(board, {
    type: 'plan.set',
    projectId: 'p',
    summary: '旧客户端',
    items: [{ title: '整理目录', refs: ['ref-gone', 'ref-1'] }],
  }), null, 'a leftover refs field is ignored instead of refused')
  assert.deepEqual(project.plan.items.map(item => item.title), ['整理目录'])
  assert.equal('refs' in project.plan.items[0], false, 'a stored draft item has no refs field')
})

test('plan.apply creates the cards in order, then clears the draft', () => {
  const board = seed()
  const project = board.projects[0]
  // One card already exists with a title the draft also uses.
  assert.equal(applyOp(board, { type: 'task.add', projectId: 'p', id: 't-old', title: '迁移构建脚本', status: 'running', progress: 30 }), null)

  assert.equal(applyOp(board, {
    type: 'plan.set',
    projectId: 'p',
    summary: '迁移',
    items: [
      { title: '整理目录结构', note: '输出目录树', priority: 'urgent', tags: ['docs'], deliverables: ['docs/tree.md'] },
      { title: '迁移构建脚本' },
      { title: '首页性能优化' },
    ],
  }), null)
  const planItems = project.plan.items

  const op = { type: 'plan.apply', projectId: 'p' }
  assert.equal(applyOp(board, op), null)
  assert.deepEqual(op.result, { created: 2, skippedTitles: ['迁移构建脚本'] })
  assert.equal(project.plan, null, 'the draft is consumed')

  const created = project.tasks.filter(task => task.id !== 't-old')
  assert.deepEqual(created.map(task => task.title), ['整理目录结构', '首页性能优化'], 'items land in order')
  for (const task of created) {
    assert.equal(task.status, 'backlog')
    assert.equal(task.progress, 0)
    assert.match(task.id, /^t/)
  }
  const first = created[0]
  assert.equal(first.note, '输出目录树')
  assert.equal(first.priority, 'urgent')
  assert.deepEqual(first.tags, ['docs'])
  assert.deepEqual(first.deliverables, ['docs/tree.md'])
  // The title the board already had is untouched, not moved or rewritten.
  const existing = project.tasks.find(task => task.id === 't-old')
  assert.equal(existing.status, 'running')
  assert.equal(existing.progress, 30)

  // The draft's items were not mutated by applying it.
  assert.deepEqual(planItems.map(item => item.title), ['整理目录结构', '迁移构建脚本', '首页性能优化'])
})

test('plan.apply skips titles that the draft itself repeats', () => {
  const board = seed()
  const project = board.projects[0]
  assert.equal(applyOp(board, {
    type: 'plan.set',
    projectId: 'p',
    summary: '重复',
    items: [{ title: '同一件事' }, { title: '同一件事' }],
  }), null)
  const op = { type: 'plan.apply', projectId: 'p' }
  assert.equal(applyOp(board, op), null)
  assert.deepEqual(op.result, { created: 1, skippedTitles: ['同一件事'] })
  assert.equal(project.tasks.filter(task => task.title === '同一件事').length, 1)
})

test('plan.apply without a draft reports unknown_plan', () => {
  const board = seed()
  assert.equal(applyOp(board, { type: 'plan.apply', projectId: 'p' }), 'unknown_plan')
  assert.equal(applyOp(board, { type: 'plan.apply', projectId: 'nope' }), 'unknown_project')

  const project = board.projects[0]
  assert.equal(applyOp(board, { type: 'plan.set', projectId: 'p', summary: 'x', items: [{ title: 'T' }] }), null)
  assert.equal(applyOp(board, { type: 'plan.discard', projectId: 'p' }), null)
  assert.equal(applyOp(board, { type: 'plan.apply', projectId: 'p' }), 'unknown_plan', 'a discarded draft cannot be applied')
  assert.equal(project.tasks.length, 0)
})

test('plan.discard clears the draft and is a no-op without one', () => {
  const board = seed()
  const project = board.projects[0]
  assert.equal(applyOp(board, { type: 'plan.discard', projectId: 'p' }), null, 'discarding nothing is not an error')
  assert.equal(applyOp(board, { type: 'plan.set', projectId: 'p', summary: '草案', items: [{ title: 'T' }] }), null)
  assert.equal(applyOp(board, { type: 'plan.discard', projectId: 'p' }), null)
  assert.equal(project.plan, null)
  assert.equal(applyOp(board, { type: 'plan.discard', projectId: 'p' }), null, 'a second discard is still a no-op')
  assert.equal(board.projects[0].tasks.length, 0, 'discarding never creates cards')
})

test('a loaded plan drops unusable items and stays bounded', () => {
  const board = seed()
  const project = board.projects[0]
  assert.equal(applyOp(board, {
    type: 'plan.set',
    projectId: 'p',
    summary: '草案',
    items: [{ title: '整理目录结构' }],
  }), null)

  // A hand-edited draft whose every item is unreadable is no draft at all.
  const broken = normalizeBoard({
    version: DOC_VERSION,
    projects: [{ id: 'p', name: 'P', plan: { summary: 'x', items: [{ note: 'no title' }, null, 'nope'] } }],
  })
  assert.equal(broken.projects[0].plan, null)

  // A plan is bounded on load too.
  const huge = normalizeBoard({
    version: DOC_VERSION,
    projects: [{ id: 'p', name: 'P', plan: { summary: 'x', items: manyItems(MAX_PLAN_ITEMS + 10) } }],
  })
  assert.equal(huge.projects[0].plan.items.length, MAX_PLAN_ITEMS)
})

test('a batch reports plan results and bumps the revision', () => {
  const board = seed()
  assert.equal(applyOp(board, { type: 'plan.set', projectId: 'p', summary: 'x', items: [{ title: 'T' }] }), null)
  const batch = [
    { type: 'plan.apply', projectId: 'p' },
    { type: 'plan.discard', projectId: 'p' },
  ]
  const before = board.revision
  const outcome = applyOps(board, batch)
  assert.deepEqual(outcome.rejected, [])
  assert.equal(outcome.board.revision, before + 1)
  assert.deepEqual(batch[0].result, { created: 1, skippedTitles: [] })
  assert.equal(outcome.board.projects[0].plan, null)
  assert.equal(outcome.board.projects[0].tasks.length, 1)
})