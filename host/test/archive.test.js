/**
 * Cold-storage tests: the archive must survive a restart, dedupe, and stay
 * small enough that the active board can drop cards without losing them.
 * Run with: node --test host/test
 */
import assert from 'node:assert/strict'
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import {
  archivedCount,
  archivePathFor,
  createArchiver,
  isArchiveOp,
  putCards,
  takeCards,
} from '../archive.js'
import { applyOp, emptyBoard } from '../board.js'

/**
 * @returns {Promise<string>} a fresh temporary directory.
 */
async function tempDir() {
  return mkdtemp(join(tmpdir(), 'board-archive-test-'))
}

/**
 * @returns {object} a board with one project holding two cards.
 */
function boardWithCards() {
  const board = emptyBoard()
  applyOp(board, { type: 'project.add', id: 'p1', name: '工程' })
  applyOp(board, { type: 'task.add', projectId: 'p1', id: 't1', title: '甲' })
  applyOp(board, { type: 'task.add', projectId: 'p1', id: 't2', title: '乙' })
  return board
}

test('takeCards removes the chosen cards and reports the rest', () => {
  const board = boardWithCards()
  const taken = takeCards(board, 'p1', ['t1', 'nope'])
  assert.equal(taken.tasks.length, 1)
  assert.equal(taken.tasks[0].id, 't1')
  assert.equal(taken.projectName, '工程')
  assert.deepEqual(taken.missing, ['nope'])
  assert.deepEqual(board.projects[0].tasks.map(task => task.id), ['t2'])
})

test('putCards restores cards and recreates a missing project', () => {
  const board = boardWithCards()
  const taken = takeCards(board, 'p1', ['t1'])
  const added = putCards(board, 'p1', '工程', taken.tasks)
  assert.equal(added, 1)
  assert.deepEqual(board.projects[0].tasks.map(task => task.id).sort(), ['t1', 't2'])
  // Restoring twice must not duplicate the card.
  assert.equal(putCards(board, 'p1', '工程', taken.tasks), 0)

  const fresh = emptyBoard()
  assert.equal(putCards(fresh, 'p9', '恢复来的', taken.tasks), 1)
  assert.equal(fresh.projects[0].name, '恢复来的')
  assert.equal(fresh.projects[0].tasks.length, 1)
  assert.equal(fresh.projects[0].acceptanceMode, 'auto')
  assert.equal(fresh.projects[0].materials, '', 'a recreated project starts with an empty material text')
})

test('the archive survives a restart', async () => {
  const dir = await tempDir()
  const file = join(dir, 'board-archive.json')
  const first = createArchiver(file)
  await first.appendTasks({ id: 'p1', name: '工程' }, [{ id: 't1', title: '甲' }])
  await first.appendTasks({ id: 'p1', name: '工程' }, [{ id: 't2', title: '乙' }])

  const second = createArchiver(file)
  await second.init()
  assert.equal(archivedCount(second.snapshot()), 2)
  assert.equal(second.snapshot().projects[0].projectName, '工程')

  const found = await second.findTasks('p1', ['t2', 'gone'])
  assert.deepEqual(found.tasks.map(task => task.id), ['t2'])
  assert.deepEqual(found.missing, ['gone'])

  await second.removeTasks('p1', ['t1', 't2'])
  assert.equal(archivedCount(second.snapshot()), 0)
})

test('appendTasks dedupes by card id', async () => {
  const dir = await tempDir()
  const archiver = createArchiver(join(dir, 'board-archive.json'))
  await archiver.appendTasks({ id: 'p1', name: '工程' }, [{ id: 't1', title: '甲' }])
  await archiver.appendTasks({ id: 'p1', name: '工程' }, [{ id: 't1', title: '甲' }])
  assert.equal(archivedCount(archiver.snapshot()), 1)
})

test('a corrupt archive is moved aside instead of overwriting user data', async () => {
  const dir = await tempDir()
  const file = join(dir, 'board-archive.json')
  await writeFile(file, '{ not json', 'utf8')
  const archiver = createArchiver(file)
  await archiver.init()
  assert.equal(archivedCount(archiver.snapshot()), 0)
  await archiver.appendTasks({ id: 'p1', name: '工程' }, [{ id: 't1', title: '甲' }])
  const text = await readFile(file, 'utf8')
  assert.match(text, /"t1"/)
})

test('the archive file sits beside the board document', () => {
  const path = archivePathFor(join('C:', 'data', 'board.json'))
  assert.match(path, /board-archive\.json$/)
  assert.match(path, /data/)
})

test('archive operations are recognised', () => {
  assert.equal(isArchiveOp({ type: 'board.archive' }), true)
  assert.equal(isArchiveOp({ type: 'board.restore' }), true)
  assert.equal(isArchiveOp({ type: 'task.move' }), false)
  assert.equal(isArchiveOp(null), false)
})