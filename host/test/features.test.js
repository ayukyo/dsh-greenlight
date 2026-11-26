/**
 * Schema v7 features: priority, due date, tags, trash restore/purge and
 * whole-board replacement.
 * Run with: node --test host/test
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  DOC_VERSION,
  TRASH_RETENTION_MS,
  applyOp,
  emptyBoard,
  normalizeBoard,
} from '../board.js'

/**
 * @returns {object} a board with one project and one subtask.
 */
function seed() {
  const board = emptyBoard()
  assert.equal(applyOp(board, { type: 'project.add', id: 'p', name: 'P' }), null)
  assert.equal(applyOp(board, { type: 'task.add', projectId: 'p', id: 't', title: 'T' }), null)
  return board
}

test('priority, due date and tags are normalized', () => {
  const board = seed()
  assert.equal(applyOp(board, {
    type: 'task.patch',
    projectId: 'p',
    taskId: 't',
    patch: { priority: 'urgent', dueDate: '2026-12-31', tags: ['  后端 ', '后端', 'UI'] },
  }), null)
  const task = board.projects[0].tasks[0]
  assert.equal(task.priority, 'urgent')
  assert.equal(task.dueDate, '2026-12-31')
  assert.deepEqual(task.tags, ['后端', 'UI'], 'tags are trimmed and de-duplicated')

  assert.equal(applyOp(board, { type: 'task.patch', projectId: 'p', taskId: 't', patch: { priority: 'nope' } }), 'invalid_field')
  assert.equal(applyOp(board, { type: 'task.patch', projectId: 'p', taskId: 't', patch: { dueDate: '2026-13-99' } }), null)
  assert.equal(board.projects[0].tasks[0].dueDate, '', 'an impossible date clears the field')
  assert.equal(applyOp(board, { type: 'task.patch', projectId: 'p', taskId: 't', patch: { tags: 'nope' } }), 'invalid_field')
  assert.equal(board.projects[0].tasks[0].priority, 'urgent', 'a rejected patch leaves the value alone')
})

test('task.add accepts the new fields and the version is v7', () => {
  const board = emptyBoard()
  applyOp(board, { type: 'project.add', id: 'p', name: 'P' })
  assert.equal(applyOp(board, {
    type: 'task.add',
    projectId: 'p',
    id: 't',
    title: 'T',
    priority: 'high',
    dueDate: '2026-01-02',
    tags: ['a'],
  }), null)
  const task = board.projects[0].tasks[0]
  assert.equal(task.priority, 'high')
  assert.equal(task.dueDate, '2026-01-02')
  assert.deepEqual(task.tags, ['a'])
  assert.equal(normalizeBoard(board).version, DOC_VERSION)
})

test('removed cards stay restorable, and purge respects the retention window', () => {
  const board = seed()
  applyOp(board, { type: 'task.remove', projectId: 'p', taskId: 't' })
  assert.equal(board.projects[0].trash.length, 1)
  assert.equal(board.projects[0].trash[0].index, 0)

  assert.equal(applyOp(board, { type: 'trash.purge', projectId: 'p' }), null)
  assert.equal(board.projects[0].trash.length, 1, 'a fresh trash entry survives a normal purge')

  // Age the entry past the retention window and purge again.
  board.projects[0].trash[0].deletedAt = Date.now() - TRASH_RETENTION_MS - 1000
  assert.equal(applyOp(board, { type: 'trash.purge', projectId: 'p' }), null)
  assert.equal(board.projects[0].trash.length, 0)

  assert.equal(applyOp(board, { type: 'task.restore', projectId: 'p', taskId: 't' }), null, 'restoring a purged card is a no-op')
  assert.equal(board.projects[0].tasks.length, 0)
})

test('expired trash is dropped when a document is loaded', () => {
  const board = seed()
  applyOp(board, { type: 'task.remove', projectId: 'p', taskId: 't' })
  board.projects[0].trash[0].deletedAt = Date.now() - TRASH_RETENTION_MS - 1000
  const reloaded = normalizeBoard(board)
  assert.equal(reloaded.projects[0].trash.length, 0, 'stale trash never accumulates on disk')
})

test('board.replace swaps the whole document', () => {
  const board = seed()
  assert.equal(applyOp(board, {
    type: 'board.replace',
    document: { version: DOC_VERSION, projects: [{ id: 'q', name: '导入的项目', tasks: [{ id: 'x', title: '导入的任务' }] }] },
  }), null)
  assert.equal(board.projects.length, 1)
  assert.equal(board.projects[0].name, '导入的项目')
  assert.equal(board.projects[0].tasks[0].title, '导入的任务')
  assert.equal(applyOp(board, { type: 'board.replace', document: { projects: [] } }), 'import_empty')
  assert.equal(applyOp(board, { type: 'board.replace', document: null }), 'invalid_field')
})
test('the material text round-trips through a document load', () => {
  const board = emptyBoard()
  applyOp(board, { type: 'project.add', id: 'p', name: 'P' })
  applyOp(board, { type: 'project.setMaterials', projectId: 'p', materials: 'docs/api.md\n先评审再实现' })
  const reloaded = normalizeBoard(board)
  assert.equal(reloaded.projects[0].materials, 'docs/api.md\n先评审再实现')
  assert.equal('references' in reloaded.projects[0], false)
})
