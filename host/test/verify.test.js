import assert from 'node:assert/strict'
import { mkdtemp, mkdir, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { emptyBoard, applyOp, applyOps } from '../board.js'
import { attachVerification, prepareBatch, probeDeliverables, probeProject } from '../verify.js'

/**
 * @returns a temp directory holding one real file.
 */
async function makeRoot() {
  const dir = await mkdtemp(join(tmpdir(), 'greenlight-verify-'))
  await mkdir(join(dir, 'docs'), { recursive: true })
  await writeFile(join(dir, 'docs', 'report.md'), 'hello', 'utf8')
  await writeFile(join(dir, 'docs', 'empty.md'), '', 'utf8')
  return dir
}

test('probeDeliverables accepts existing non-empty files', async () => {
  const dir = await makeRoot()
  const result = await probeDeliverables({ paths: ['docs/report.md'], rootDir: dir })
  assert.equal(result.checked, true)
  assert.deepEqual(result.missing, [])
  assert.deepEqual(result.unresolved, [])
})

test('probeDeliverables reports missing and empty files', async () => {
  const dir = await makeRoot()
  const result = await probeDeliverables({ paths: ['docs/report.md', 'docs/nope.md', 'docs/empty.md'], rootDir: dir })
  assert.equal(result.checked, true)
  assert.deepEqual(result.missing.sort(), ['docs/empty.md', 'docs/nope.md'])
})

test('probeDeliverables reports relative paths it cannot locate', async () => {
  const result = await probeDeliverables({ paths: ['docs/report.md'], rootDir: '' })
  assert.equal(result.checked, false)
  assert.deepEqual(result.unresolved, ['docs/report.md'])
})

test('probeDeliverables accepts absolute paths without a root', async () => {
  const dir = await makeRoot()
  const result = await probeDeliverables({ paths: [join(dir, 'docs', 'report.md')], rootDir: '' })
  assert.equal(result.checked, true)
  assert.deepEqual(result.missing, [])
})

test('probeDeliverables with no declared path checks nothing', async () => {
  const result = await probeDeliverables({ paths: [], rootDir: '/tmp' })
  assert.equal(result.checked, false)
})

test('the probe is injectable so the board layer stays testable', async () => {
  const expected = join('/repo', 'a.md')
  const result = await probeDeliverables({
    paths: ['a.md'],
    rootDir: '/repo',
    stat: async (path) => (path === expected ? 12 : null),
  })
  assert.equal(result.checked, true)
  assert.deepEqual(result.missing, [])
})

test('attachVerification leaves non-completing operations alone', async () => {
  const board = emptyBoard()
  applyOp(board, { type: 'project.add', id: 'p1', name: 'P' })
  applyOp(board, { type: 'task.add', projectId: 'p1', id: 't1', title: 'T' })
  const op = { type: 'task.patch', projectId: 'p1', taskId: 't1', patch: { progress: 20 } }
  assert.equal(await attachVerification(board, op), op)
})

test('attachVerification probes the declared deliverables of a completion', async () => {
  const dir = await makeRoot()
  const board = emptyBoard()
  applyOp(board, { type: 'project.add', id: 'p1', name: 'P' })
  applyOp(board, { type: 'project.setAcceptance', projectId: 'p1', rootDir: dir })
  applyOp(board, { type: 'task.add', projectId: 'p1', id: 't1', title: 'T' })

  const good = await attachVerification(board, {
    type: 'task.submit',
    projectId: 'p1',
    taskId: 't1',
    progress: 100,
    evidence: 'done',
    deliverables: ['docs/report.md'],
  })
  assert.equal(good.verification.checked, true)
  assert.deepEqual(good.verification.missing, [])

  const bad = await attachVerification(board, {
    type: 'task.submit',
    projectId: 'p1',
    taskId: 't1',
    progress: 100,
    evidence: 'done',
    deliverables: ['docs/nope.md'],
  })
  assert.deepEqual(bad.verification.missing, ['docs/nope.md'])

  // A completion that declares nothing needs no probe.
  const bare = await attachVerification(board, { type: 'task.submit', projectId: 'p1', taskId: 't1', progress: 100 })
  assert.equal(bare.verification, undefined)
})

test('attachVerification is skipped when the project does not verify files', async () => {
  const board = emptyBoard()
  applyOp(board, { type: 'project.add', id: 'p1', name: 'P' })
  applyOp(board, { type: 'project.setAcceptance', projectId: 'p1', rules: { verifyDeliverables: false } })
  applyOp(board, { type: 'task.add', projectId: 'p1', id: 't1', title: 'T' })
  const op = await attachVerification(board, {
    type: 'task.submit',
    projectId: 'p1',
    taskId: 't1',
    deliverables: ['nowhere.md'],
  })
  assert.equal(op.verification, undefined)
})

test('a verified deliverable completes the card end to end', async () => {
  const dir = await makeRoot()
  const board = emptyBoard()
  applyOp(board, { type: 'project.add', id: 'p1', name: 'P' })
  applyOp(board, { type: 'project.setAcceptance', projectId: 'p1', rootDir: dir })
  applyOp(board, { type: 'task.add', projectId: 'p1', id: 't1', title: 'T' })
  const op = await attachVerification(board, {
    type: 'task.submit',
    projectId: 'p1',
    taskId: 't1',
    progress: 100,
    evidence: 'wrote the report',
    deliverables: ['docs/report.md'],
  })
  assert.equal(applyOp(board, op, 'agent'), null)
  const task = board.projects[0].tasks[0]
  assert.equal(task.status, 'done')
  assert.equal(task.acceptedBy, 'auto')

  // The same completion against a missing file waits for a human.
  const second = await attachVerification(board, {
    type: 'task.submit',
    projectId: 'p1',
    taskId: 't1',
    progress: 100,
    evidence: 'wrote another report',
    deliverables: ['docs/nope.md'],
  })
  applyOp(board, { type: 'task.move', projectId: 'p1', taskId: 't1', status: 'running' })
  assert.equal(applyOp(board, second, 'agent'), null)
  assert.equal(task.status, 'review')
  assert.match(task.reviewReason, /交付物不存在或为空/)
})
test('probeProject reports the deliverables of the cards that declare one', async () => {
  const dir = await makeRoot()
  const board = emptyBoard()
  applyOp(board, { type: 'project.add', id: 'p1', name: 'P' })
  applyOp(board, { type: 'project.setAcceptance', projectId: 'p1', rootDir: dir })
  applyOp(board, { type: 'task.add', projectId: 'p1', id: 't1', title: '带交付物', deliverables: ['docs/report.md'] })
  applyOp(board, { type: 'task.add', projectId: 'p1', id: 't2', title: '没交付物' })

  const sweep = await probeProject(board.projects[0])
  assert.deepEqual(Object.keys(sweep), ['deliverables'], 'a sweep reports deliverables and nothing else')
  assert.deepEqual(sweep.deliverables.t1, { checked: true, missing: [], unresolved: [] })
  assert.equal('t2' in sweep.deliverables, false, 'a card that declares nothing is not probed')
})

test('prepareBatch sweeps the deliverables a recheck reports', async () => {
  const board = emptyBoard()
  applyOp(board, { type: 'project.add', id: 'p1', name: 'P' })
  applyOp(board, { type: 'project.setAcceptance', projectId: 'p1', rootDir: '/repo' })
  applyOp(board, { type: 'task.add', projectId: 'p1', id: 't1', title: 'T', deliverables: ['docs/nope.md'] })
  const prepared = await prepareBatch(board, [
    { type: 'project.recheck', projectId: 'p1' },
  ], { stat: async () => null })
  assert.deepEqual(prepared[0].deliverables, { t1: { checked: true, missing: ['docs/nope.md'], unresolved: [] } })
  assert.equal('staleEntries' in prepared[0], false, 'a sweep no longer reports stale references')
  assert.equal(applyOp(board, prepared[0]), null)
  assert.deepEqual(board.projects[0].tasks[0].verification.missing, ['docs/nope.md'])
  assert.equal(board.projects[0].lastCheckAt > 0, true)
})

test('a completion in the same batch sees deliverables declared earlier in that batch', async () => {
  const board = emptyBoard()
  applyOp(board, { type: 'project.add', id: 'p1', name: 'P' })
  applyOp(board, { type: 'task.add', projectId: 'p1', id: 't1', title: 'T', status: 'running' })
  // Relative deliverables need a project root, or they count as unresolvable.
  applyOp(board, { type: 'project.setAcceptance', projectId: 'p1', rootDir: join('C:', 'repo') })
  const probe = async (path) => ({ size: String(path).endsWith('ok.md') ? 12 : 0 })
  const prepared = await prepareBatch(board, [
    { type: 'task.patch', projectId: 'p1', taskId: 't1', patch: { deliverables: ['docs/ok.md'] } },
    { type: 'task.submit', projectId: 'p1', taskId: 't1', progress: 100 },
  ], { stat: probe })
  assert.deepEqual(prepared[1].verification.missing, [], 'the probe must see the deliverable the batch just declared')
  assert.deepEqual(prepared[1].verification.unresolved, [])
  assert.equal(prepared[1].verification.checked, true)
})

test('a recheck in the same batch sees the card the batch just declared', async () => {
  const board = emptyBoard()
  applyOp(board, { type: 'project.add', id: 'p1', name: 'P' })
  const root = await mkdtemp(join(tmpdir(), 'greenlight-sweep-'))
  await mkdir(join(root, 'docs'), { recursive: true })
  await writeFile(join(root, 'docs', 'there.md'), 'x')
  // The probe contract is a size, with 0 meaning "cannot see it".
  const probe = async (path) => {
    try {
      const info = await stat(path)
      return info.size
    } catch (error) {
      return 0
    }
  }
  const applied = applyOps(board, await prepareBatch(board, [
    { type: 'project.setAcceptance', projectId: 'p1', rootDir: root },
    { type: 'task.add', projectId: 'p1', id: 't-there', title: '还在的', deliverables: ['docs/there.md'] },
    { type: 'task.add', projectId: 'p1', id: 't-gone', title: '丢了的', deliverables: ['docs/gone.md'] },
    { type: 'project.recheck', projectId: 'p1' },
  ], { stat: probe }))
  assert.deepEqual(applied.rejected, [])
  const tasks = applied.board.projects[0].tasks
  const there = tasks.find(task => task.id === 't-there')
  const gone = tasks.find(task => task.id === 't-gone')
  assert.ok(there && gone, 'both cards must exist after the batch')
  assert.deepEqual(there.verification.missing, [], 'the file that exists must not be flagged')
  assert.deepEqual(gone.verification.missing, ['docs/gone.md'], 'the file that is missing must be flagged in the same batch')
})
