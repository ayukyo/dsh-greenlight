import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { emptyBoard, applyOp } from '../board.js'
import { attachVerification, prepareBatch, probeDeliverables } from '../verify.js'

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
test('prepareBatch lets a recheck see references added in the same batch', async () => {
  const board = emptyBoard()
  applyOp(board, { type: 'project.add', id: 'p1', name: 'P' })
  const prepared = await prepareBatch(board, [
    { type: 'reference.add', projectId: 'p1', id: 's1', kind: 'link', name: '缺失', value: 'docs/nope.md' },
    { type: 'reference.add', projectId: 'p1', id: 's2', kind: 'note', name: '约定', value: 'docs/nope.md' },
    { type: 'project.recheck', projectId: 'p1' },
  ], { stat: async () => null })
  assert.deepEqual(prepared[2].staleEntries, ['s1'], 'the sweep must see the link the batch just added, and only links')
  assert.equal(applyOp(board, prepared[0]), null)
  assert.equal(applyOp(board, prepared[1]), null)
  assert.equal(applyOp(board, prepared[2]), null)
  const references = board.projects[0].references
  assert.equal(references.find(entry => entry.id === 's1').staleSince > 0, true)
  assert.equal(references.find(entry => entry.id === 's2').staleSince, 0, 'a note is never probed')
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
