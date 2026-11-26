/**
 * Data-layer and store tests for the Greenlight board Host half.
 * Run with: node --test host/test
 */
import assert from 'node:assert/strict'
import { mkdtemp, readdir, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import {
  DOC_VERSION,
  applyOp,
  applyOps,
  boardCounts,
  emptyBoard,
  evaluateAcceptance,
  normalizeBoard,
  projectPercent,
  projectTone,
  statusCounts,
  verificationDebt,
  verifiedLayers,
} from '../board.js'
import { createStore } from '../store.js'

/**
 * @returns {Promise<string>} a fresh temporary directory.
 */
async function tempDir() {
  return mkdtemp(join(tmpdir(), 'greenlight-test-'))
}

/**
 * Build a board with one project holding one subtask.
 * @returns {object} board document.
 */
function boardWithOneTask() {
  return normalizeBoard({
    version: DOC_VERSION,
    revision: 7,
    projects: [{
      id: 'p1',
      name: 'Alpha',
      references: [{ id: 'ref-1', kind: 'link', name: '设计稿', value: 'docs/spec.md' }],
      tasks: [{ id: 't1', title: '第一件事', note: '描述', status: 'running', progress: 40 }],
      memory: [{ id: 'm1', text: '约定', taskId: 't1', createdAt: 1 }],
    }],
  })
}

test('empty and corrupt documents normalize to an empty board', () => {
  assert.equal(normalizeBoard(null).projects.length, 0)
  assert.equal(normalizeBoard('{not json').projects.length, 0)
  assert.equal(normalizeBoard({}).projects.length, 0)
  assert.equal(normalizeBoard('').projects.length, 0)
})

test('version-1 flat tasks migrate into one project with statuses', () => {
  const board = normalizeBoard({
    version: 1,
    tasks: [
      { id: 'a', title: '旧一', status: 'done', session: '会话X', createdAt: 1 },
      { id: 'b', title: '旧二', status: 'doing' },
      { id: 'c', title: '旧三', status: 'queued' },
    ],
  })
  assert.equal(board.projects.length, 1)
  assert.equal(board.projects[0].name, '默认项目')
  assert.deepEqual(board.projects[0].tasks.map(task => task.status), ['done', 'running', 'todo'])
  assert.deepEqual(board.projects[0].tasks.map(task => task.progress), [100, 50, 0])
  assert.equal(board.projects[0].tasks[0].note, '会话X')
  assert.equal(board.version, DOC_VERSION)
})

test('version-2 projects keep their fields and gain a status', () => {
  const board = normalizeBoard({
    version: 2,
    projects: [{
      id: 'p',
      name: 'P',
      references: [{ id: 'ref-1', kind: 'note', name: '约定', value: '路径' }],
      tasks: [{ id: 't', title: 'T', progress: 100 }],
      memory: [],
    }],
  })
  assert.equal(board.projects[0].references[0].value, '路径')
  assert.equal(board.projects[0].tasks[0].status, 'done')
  assert.equal(board.projects[0].tasks[0].reviewReason, '')
})

test('memory links to missing subtasks are cleared', () => {
  const board = normalizeBoard({
    projects: [{ id: 'p', name: 'P', tasks: [], memory: [{ id: 'm', text: 'x', taskId: 'gone' }] }],
  })
  assert.equal(board.projects[0].memory[0].taskId, '')
})

test('percent, tone and counts follow the documented rules', () => {
  const board = boardWithOneTask()
  const project = board.projects[0]
  assert.equal(projectPercent(project), 40)
  assert.equal(projectTone(project), 'yellow')
  assert.equal(statusCounts(project).running, 1)
  assert.equal(projectTone({ tasks: [] }), 'idle')
  assert.equal(projectTone({ tasks: [{ progress: 90, blocked: true }] }), 'red')
  assert.equal(projectTone({ tasks: [{ progress: 90, blocked: false }] }), 'green')
  assert.equal(boardCounts(board).running, 1)
})

test('project operations: add, rename, shared alias, remove, duplicate id', () => {
  const board = emptyBoard()
  assert.equal(applyOp(board, { type: 'project.add', id: 'p1', name: 'Alpha' }), null)
  assert.equal(board.projects.length, 1)
  assert.deepEqual(board.projects[0].references, [])
  assert.equal(applyOp(board, { type: 'project.add', id: 'p1', name: 'Again' }), 'duplicate_id')
  assert.equal(applyOp(board, { type: 'project.rename', projectId: 'p1', name: 'Beta' }), null)
  assert.equal(board.projects[0].name, 'Beta')
  // The version-9 free-text op is still accepted: it is carried as one note.
  assert.equal(applyOp(board, { type: 'project.setShared', projectId: 'p1', shared: 'a/b.md' }), null)
  assert.equal(board.projects[0].references.length, 1)
  assert.equal(board.projects[0].references[0].kind, 'note')
  assert.equal(board.projects[0].references[0].name, '项目说明')
  assert.equal(board.projects[0].references[0].value, 'a/b.md')
  // A second write updates that same note instead of piling up entries.
  assert.equal(applyOp(board, { type: 'project.setShared', projectId: 'p1', shared: 'c/d.md' }), null)
  assert.equal(board.projects[0].references.length, 1)
  assert.equal(board.projects[0].references[0].value, 'c/d.md')
  // An empty text removes the note again.
  assert.equal(applyOp(board, { type: 'project.setShared', projectId: 'p1', shared: '' }), null)
  assert.equal(board.projects[0].references.length, 0)
  assert.equal(applyOp(board, { type: 'project.rename', projectId: 'nope', name: 'X' }), 'unknown_project')
  assert.equal(applyOp(board, { type: 'project.remove', projectId: 'p1' }), null)
  assert.equal(board.projects.length, 0)
  assert.equal(applyOp(board, { type: 'project.remove', projectId: 'p1' }), null, 'removing a missing project is a no-op')
})

test('task.submit always runs acceptance, even from the panel origin', () => {
  const board = boardWithOneTask()
  const task = board.projects[0].tasks[0]
  // Even a ui-origin submit must be verified: submitting is not reviewing.
  assert.equal(applyOp(board, {
    type: 'task.submit',
    projectId: 'p1',
    taskId: 't1',
    progress: 100,
  }, 'ui'), null)
  assert.equal(task.status, 'review', 'a submit without evidence waits for a human')
  assert.equal(task.acceptedBy, '')

  assert.equal(applyOp(board, {
    type: 'task.submit',
    projectId: 'p1',
    taskId: 't1',
    progress: 100,
    evidence: '有说明',
  }, 'ui'), null)
  assert.equal(task.status, 'done')
  assert.equal(task.acceptedBy, 'auto')
})

test('automatic acceptance closes a verifiable completion and queues the rest', () => {
  const board = boardWithOneTask()
  const project = board.projects[0]
  // A clean, evidenced completion is accepted without a human.
  assert.equal(applyOp(board, {
    type: 'task.patch',
    projectId: 'p1',
    taskId: 't1',
    patch: { progress: 100, blocked: false, evidence: '跑通 pnpm test，30 项通过' },
  }), null)
  assert.equal(applyOp(board, { type: 'task.move', projectId: 'p1', taskId: 't1', status: 'done' }), null)
  assert.equal(project.tasks[0].status, 'done')
  assert.equal(project.tasks[0].acceptedBy, 'auto')
  assert.equal(project.tasks[0].acceptedAt > 0, true)
  assert.equal(project.tasks[0].acceptance.pass, true)

  // The same completion without a note cannot be verified and waits for a human.
  assert.equal(applyOp(board, { type: 'task.add', projectId: 'p1', id: 't2', title: '第二件事' }), null)
  assert.equal(applyOp(board, { type: 'task.patch', projectId: 'p1', taskId: 't2', patch: { progress: 100 } }), null)
  assert.equal(applyOp(board, { type: 'task.move', projectId: 'p1', taskId: 't2', status: 'done' }), null)
  const queued = project.tasks.find(task => task.id === 't2')
  assert.equal(queued.status, 'review')
  assert.equal(queued.acceptedBy, '')
  assert.match(queued.reviewReason, /完成说明/)
  assert.equal(queued.acceptance.pass, false)
})

test('automatic acceptance refuses a blocked or incomplete card', () => {
  const board = boardWithOneTask()
  const task = board.projects[0].tasks[0]
  task.evidence = '做了'
  task.progress = 100
  task.blocked = true
  assert.equal(applyOp(board, { type: 'task.move', projectId: 'p1', taskId: 't1', status: 'done' }), null)
  assert.equal(task.status, 'review')
  assert.match(task.reviewReason, /阻塞/)

  task.blocked = false
  task.progress = 60
  assert.equal(applyOp(board, { type: 'task.move', projectId: 'p1', taskId: 't1', status: 'done' }), null)
  assert.equal(task.status, 'review')
  assert.match(task.reviewReason, /进度/)
})

test('a human-mode project always routes completion through review', () => {
  const board = boardWithOneTask()
  const project = board.projects[0]
  const task = project.tasks[0]
  task.evidence = '全做完了'
  task.progress = 100
  assert.equal(applyOp(board, { type: 'project.setAcceptance', projectId: 'p1', mode: 'human' }), null)
  assert.equal(project.acceptanceMode, 'human')
  assert.equal(applyOp(board, { type: 'task.move', projectId: 'p1', taskId: 't1', status: 'done' }), null)
  assert.equal(task.status, 'review')
  assert.match(task.reviewReason, /人工验收/)
  // The panel still closes it, recording the human decision.
  assert.equal(applyOp(board, { type: 'task.move', projectId: 'p1', taskId: 't1', status: 'done' }, 'ui'), null)
  assert.equal(task.status, 'done')
  assert.equal(task.acceptedBy, 'human')
  assert.equal(applyOp(board, { type: 'project.setAcceptance', projectId: 'p1', mode: 'nonsense' }), 'invalid_field')
})

test('a card can demand human acceptance regardless of the project mode', () => {
  const board = boardWithOneTask()
  const task = board.projects[0].tasks[0]
  task.evidence = '做完了'
  task.progress = 100
  assert.equal(applyOp(board, { type: 'task.patch', projectId: 'p1', taskId: 't1', patch: { requireHuman: true } }), null)
  assert.equal(applyOp(board, { type: 'task.move', projectId: 'p1', taskId: 't1', status: 'done' }), null)
  assert.equal(task.status, 'review')
  assert.match(task.reviewReason, /人工验收/)
})

test('task.submit records evidence and settles the card', () => {
  const board = boardWithOneTask()
  const task = board.projects[0].tasks[0]
  assert.equal(applyOp(board, {
    type: 'task.submit',
    projectId: 'p1',
    taskId: 't1',
    progress: 100,
    evidence: '改了 3 个文件，测试全绿',
  }), null)
  assert.equal(task.status, 'done')
  assert.equal(task.acceptedBy, 'auto')
  assert.equal(task.evidence, '改了 3 个文件，测试全绿')

  // Declaring a deliverable makes it part of the claim: without a probe the
  // card cannot be verified, so it waits for a human.
  assert.equal(applyOp(board, { type: 'task.add', projectId: 'p1', id: 't3', title: '带交付物' }), null)
  assert.equal(applyOp(board, {
    type: 'task.submit',
    projectId: 'p1',
    taskId: 't3',
    progress: 100,
    evidence: '写了报告',
    deliverables: ['docs/report.md'],
  }), null)
  const claimed = board.projects[0].tasks.find(entry => entry.id === 't3')
  assert.equal(claimed.status, 'review')
  assert.match(claimed.reviewReason, /交付物尚未校验/)
  assert.deepEqual(claimed.deliverables, ['docs/report.md'])

  // With a probe verdict attached, the same claim is accepted.
  assert.equal(applyOp(board, {
    type: 'task.submit',
    projectId: 'p1',
    taskId: 't3',
    progress: 100,
    evidence: '写了报告',
    deliverables: ['docs/report.md'],
    verification: { checked: true, missing: [], unresolved: [], at: Date.now() },
  }), null)
  assert.equal(claimed.status, 'done')
  assert.equal(claimed.acceptedBy, 'auto')
  assert.equal(claimed.verification.checked, true)

  // Submitting a failure parks the card in the failed column instead.
  assert.equal(applyOp(board, { type: 'task.add', projectId: 'p1', id: 't2', title: '会失败' }), null)
  assert.equal(applyOp(board, { type: 'task.submit', projectId: 'p1', taskId: 't2', status: 'failed', evidence: '编译不过' }), null)
  assert.equal(board.projects[0].tasks.find(entry => entry.id === 't2').status, 'failed')
})

test('a missing or unresolved deliverable blocks automatic acceptance', () => {
  const board = boardWithOneTask()
  const project = board.projects[0]
  project.rootDir = '/repo'
  const task = project.tasks[0]
  task.evidence = '写了报告'

  // The probe reports the file missing.
  assert.equal(applyOp(board, {
    type: 'task.submit',
    projectId: 'p1',
    taskId: 't1',
    progress: 100,
    deliverables: ['docs/report.md'],
    verification: { checked: true, missing: ['docs/report.md'], unresolved: [], at: Date.now() },
  }), null)
  assert.equal(task.status, 'review')
  assert.match(task.reviewReason, /交付物不存在或为空/)

  // A relative path with no project root cannot be located at all.
  project.rootDir = ''
  assert.equal(applyOp(board, {
    type: 'task.submit',
    projectId: 'p1',
    taskId: 't1',
    progress: 100,
    deliverables: ['docs/report.md'],
    verification: { checked: false, missing: [], unresolved: ['docs/report.md'], at: Date.now() },
  }), null)
  assert.equal(task.status, 'review')
  assert.match(task.reviewReason, /无法定位交付物/)
})

test('acceptance rules are configurable per project', () => {
  const board = boardWithOneTask()
  const project = board.projects[0]
  const task = project.tasks[0]
  task.evidence = '做完了'
  task.progress = 100

  // Requiring deliverables turns a clean completion into a human decision.
  assert.equal(applyOp(board, {
    type: 'project.setAcceptance',
    projectId: 'p1',
    rules: { requireDeliverables: true },
  }), null)
  assert.equal(project.acceptanceRules.requireDeliverables, true)
  assert.equal(applyOp(board, { type: 'task.move', projectId: 'p1', taskId: 't1', status: 'done' }), null)
  assert.equal(task.status, 'review')
  assert.match(task.reviewReason, /没有声明交付物/)

  // Requiring a Session blocks a card that has none.
  assert.equal(applyOp(board, {
    type: 'project.setAcceptance',
    projectId: 'p1',
    rules: { requireDeliverables: false, requireSession: true },
  }), null)
  assert.equal(applyOp(board, { type: 'task.move', projectId: 'p1', taskId: 't1', status: 'done' }), null)
  assert.equal(task.status, 'review')
  assert.match(task.reviewReason, /未绑定会话/)

  // Turning evidence off lets a bare completion through.
  assert.equal(applyOp(board, {
    type: 'project.setAcceptance',
    projectId: 'p1',
    rules: { requireSession: false, requireEvidence: false },
  }), null)
  task.evidence = ''
  assert.equal(applyOp(board, { type: 'task.move', projectId: 'p1', taskId: 't1', status: 'done' }), null)
  assert.equal(task.status, 'done')
  assert.equal(task.acceptedBy, 'auto')

  // Unknown rule names and non-boolean values are refused.
  assert.equal(applyOp(board, { type: 'project.setAcceptance', projectId: 'p1', rules: { nope: true } }), 'invalid_field')
  assert.equal(applyOp(board, { type: 'project.setAcceptance', projectId: 'p1', rules: { requireEvidence: 'yes' } }), 'invalid_field')
  // The root directory is stored trimmed and bounded.
  assert.equal(applyOp(board, { type: 'project.setAcceptance', projectId: 'p1', rootDir: '  /repo  ' }), null)
  assert.equal(project.rootDir, '/repo')
})

test('a version-10 document migrates to v11 with no plan and automatic acceptance', () => {
  const legacy = {
    version: 10,
    revision: 3,
    projects: [{
      id: 'p1',
      name: '旧项目',
      references: [],
      tasks: [{ id: 't1', title: '旧卡', status: 'done', progress: 100 }],
      memory: [],
      trash: [],
    }],
  }
  const board = normalizeBoard(legacy)
  assert.equal(board.version, DOC_VERSION)
  assert.equal(board.version, 11)
  assert.equal(board.revision, 3)
  const project = board.projects[0]
  assert.equal(project.plan, null, 'a version-10 document has no draft breakdown')
  assert.equal(project.acceptanceMode, 'auto')
  assert.deepEqual(project.references, [])
  const task = project.tasks[0]
  assert.equal(task.acceptedBy, '')
  assert.equal(task.requireHuman, false)
  assert.equal(task.evidence, '')
  assert.deepEqual(task.deliverables, [])
  assert.equal(task.acceptance, null)
})

test('a version-9 document migrates its shared text and entries into references', () => {
  const legacy = {
    version: 9,
    revision: 4,
    projects: [{
      id: 'p1',
      name: '旧项目',
      shared: '先评审再实现',
      sharedEntries: [{
        id: 's1',
        name: '设计稿',
        path: 'docs/design.md',
        description: '首页与详情页 2 版',
        staleSince: 12,
      }],
      tasks: [{ id: 't1', title: '旧卡', refs: ['s1', 'ghost'], status: 'todo', progress: 0 }],
      memory: [],
      trash: [],
    }],
  }
  const board = normalizeBoard(legacy)
  assert.equal(board.version, 11)
  const project = board.projects[0]
  assert.equal(project.plan, null)
  assert.equal(project.references.length, 2, 'the text and the entry become two references')

  // The free text comes first, as a note.
  const note = project.references[0]
  assert.equal(note.kind, 'note')
  assert.equal(note.name, '项目说明')
  assert.equal(note.value, '先评审再实现')
  assert.equal(note.description, '')
  assert.equal(note.staleSince, 0)
  assert.match(note.id, /^ref-/)

  // The entry becomes a link, keeping its id so card references stay valid.
  const link = project.references[1]
  assert.equal(link.id, 's1')
  assert.equal(link.kind, 'link')
  assert.equal(link.name, '设计稿')
  assert.equal(link.value, 'docs/design.md')
  assert.equal(link.description, '首页与详情页 2 版')
  assert.equal(link.staleSince, 12)
  assert.equal('path' in link, false, 'the entry shape is replaced, not extended')

  assert.deepEqual(project.tasks[0].refs, ['s1'], 'the card still points at the migrated link')
  assert.equal('shared' in project, false, 'the version-9 fields are not written back')
  assert.equal('sharedEntries' in project, false)

  // Idempotence: a second pass must add nothing.
  const again = normalizeBoard(board)
  assert.equal(again.projects[0].references.length, 2, 'a second pass adds nothing')
  assert.deepEqual(again.projects[0].tasks[0].refs, ['s1'])
})

test('subtask operations: add, patch whitelist, move with expected status, remove clears links', () => {
  const board = boardWithOneTask()
  assert.equal(applyOp(board, { type: 'task.add', projectId: 'p1', id: 't2', title: '第二件事' }), null)
  assert.equal(board.projects[0].tasks.length, 2)
  assert.equal(applyOp(board, { type: 'task.add', projectId: 'p1', id: 't2', title: '重复' }), 'duplicate_id')

  const patch = (value) => applyOp(board, { type: 'task.patch', projectId: 'p1', taskId: 't1', patch: value })
  assert.equal(patch({ progress: 75, blocked: true }), null)
  assert.equal(board.projects[0].tasks[0].progress, 75)
  assert.equal(board.projects[0].tasks[0].blocked, true)
  assert.equal(patch({ progress: 130 }), null)
  assert.equal(board.projects[0].tasks[0].progress, 100, 'progress clamps to 100')
  assert.equal(patch({ status: 'nonsense' }), 'invalid_field')
  assert.equal(patch({ unknownField: 1 }), 'invalid_field')
  assert.equal(patch({ title: 42 }), 'invalid_field')

  assert.equal(applyOp(board, { type: 'task.move', projectId: 'p1', taskId: 't1', status: 'review', expectedStatus: 'done' }), 'stale_status')
  assert.equal(applyOp(board, { type: 'task.move', projectId: 'p1', taskId: 't1', status: 'review', expectedStatus: 'running' }), null)
  assert.equal(board.projects[0].tasks[0].status, 'review')
  // Automatic acceptance decides where a completion request lands: this card
  // is blocked and has no completion note, so it stops in review.
  assert.equal(applyOp(board, { type: 'task.move', projectId: 'p1', taskId: 't1', status: 'done', expectedStatus: 'review' }), null)
  assert.equal(board.projects[0].tasks[0].status, 'review', 'an unverifiable completion waits for a human')
  assert.deepEqual(board.projects[0].tasks[0].acceptedBy, '')
  // The panel closes it directly and records that a human accepted it.
  assert.equal(applyOp(board, { type: 'task.patch', projectId: 'p1', taskId: 't1', patch: { status: 'done' } }, 'ui'), null)
  assert.equal(board.projects[0].tasks[0].status, 'done')
  assert.equal(board.projects[0].tasks[0].acceptedBy, 'human')
  // A stale expectedStatus is still reported for an ordinary move.
  assert.equal(applyOp(board, { type: 'task.move', projectId: 'p1', taskId: 't1', status: 'review', expectedStatus: 'todo' }), 'stale_status')
  // Leaving done clears the acceptance marks.
  assert.equal(applyOp(board, { type: 'task.move', projectId: 'p1', taskId: 't1', status: 'running' }, 'ui'), null)
  assert.equal(board.projects[0].tasks[0].acceptedBy, '')

  assert.equal(applyOp(board, { type: 'task.remove', projectId: 'p1', taskId: 't1' }), null)
  assert.equal(board.projects[0].tasks.length, 1)
  assert.equal(board.projects[0].trash.length, 1, 'the removed card moves to the trash')
  assert.equal(board.projects[0].trash[0].task.id, 't1')
  assert.equal(board.projects[0].memory.length, 1, 'memory survives')
  assert.equal(board.projects[0].memory[0].taskId, 't1', 'memory keeps pointing at the trashed card')
  assert.equal(applyOp(board, { type: 'task.restore', projectId: 'p1', taskId: 't1' }), null)
  assert.equal(board.projects[0].tasks.length, 2, 'restore puts the card back')
  assert.equal(board.projects[0].trash.length, 0)
  assert.equal(applyOp(board, { type: 'trash.purge', projectId: 'p1', all: true }), null)
})

test('memory operations keep only existing subtask links', () => {
  const board = boardWithOneTask()
  assert.equal(applyOp(board, { type: 'memory.add', projectId: 'p1', id: 'm2', text: '第二条', taskId: 't1' }), null)
  assert.equal(board.projects[0].memory[1].taskId, 't1')
  assert.equal(applyOp(board, { type: 'memory.add', projectId: 'p1', id: 'm3', text: '第三条', taskId: 'gone' }), null)
  assert.equal(board.projects[0].memory[2].taskId, '')
  assert.equal(applyOp(board, { type: 'memory.add', projectId: 'p1', text: '   ' }), 'invalid_field')
  assert.equal(applyOp(board, { type: 'memory.remove', projectId: 'p1', memoryId: 'm2' }), null)
  assert.equal(board.projects[0].memory.length, 2)
})

test('batches bump the revision, report rejections, and skip writing when nothing applies', () => {
  const board = boardWithOneTask()
  const accepted = applyOps(board, [
    { opId: 'a', type: 'task.patch', projectId: 'p1', taskId: 't1', patch: { progress: 60 } },
    { opId: 'b', type: 'task.patch', projectId: 'p1', taskId: 'missing', patch: { progress: 10 } },
  ])
  assert.equal(accepted.board.revision, board.revision + 1)
  assert.equal(accepted.rejected.length, 1)
  assert.equal(accepted.rejected[0].code, 'unknown_task')
  assert.equal(accepted.rejected[0].opId, 'b')

  const none = applyOps(board, [{ type: 'project.rename', projectId: 'nope', name: 'X' }])
  assert.equal(none.board, board, 'a fully rejected batch returns the source board')
  assert.equal(none.board.revision, board.revision)
})

test('board.import seeds only an empty board', () => {
  const empty = emptyBoard()
  assert.equal(applyOp(empty, { type: 'board.import', document: { projects: [{ id: 'p', name: 'P', tasks: [] }] } }), null)
  assert.equal(empty.projects.length, 1)
  assert.equal(applyOp(empty, { type: 'board.import', document: { projects: [{ id: 'q', name: 'Q' }] } }), 'import_conflict')
  const blank = emptyBoard()
  assert.equal(applyOp(blank, { type: 'board.import', document: { projects: [] } }), 'import_empty')
})

test('store persists, reloads, and serializes concurrent mutations', async () => {
  const dir = await tempDir()
  const file = join(dir, 'board.json')
  const store = createStore(file)
  await store.init()
  assert.equal(store.snapshot().projects.length, 0)

  await Promise.all([
    store.mutate(draft => applyOps(draft, [{ type: 'project.add', id: 'p1', name: 'One' }]).board),
    store.mutate(draft => applyOps(draft, [{ type: 'project.add', id: 'p2', name: 'Two' }]).board),
    store.mutate(draft => applyOps(draft, [{ type: 'project.add', id: 'p3', name: 'Three' }]).board),
  ])
  assert.equal(store.snapshot().projects.length, 3, 'no mutation is lost')
  assert.equal(store.snapshot().revision, 3)

  const reopened = createStore(file)
  await reopened.init()
  assert.deepEqual(reopened.snapshot().projects.map(project => project.id).sort(), ['p1', 'p2', 'p3'])
  assert.equal(reopened.wasRecovered(), false)

  const raw = JSON.parse(await readFile(file, 'utf8'))
  assert.equal(raw.version, DOC_VERSION)
})

test('store sets an unparsable document aside and starts empty', async () => {
  const dir = await tempDir()
  const file = join(dir, 'board.json')
  await writeFile(file, '{ broken json', 'utf8')
  const store = createStore(file)
  await store.init()
  assert.equal(store.snapshot().projects.length, 0)
  assert.equal(store.wasRecovered(), true)
  const files = await readdir(dir)
  assert.ok(files.some(name => name.startsWith('board.json.corrupt-')), 'the bad file is kept: ' + files.join(','))

  await store.mutate(draft => applyOps(draft, [{ type: 'project.add', id: 'p1', name: 'After' }]).board)
  const reopened = createStore(file)
  await reopened.init()
  assert.equal(reopened.snapshot().projects.length, 1)
})
test('claims record what was checked, how, and at which layer', () => {
  const board = boardWithOneTask()
  const project = board.projects[0]
  const task = project.tasks[0]
  assert.equal(applyOp(board, {
    type: 'task.claim',
    projectId: 'p1',
    taskId: 't1',
    claim: { what: '单测通过', how: 'node --test 75 项', layer: 'unit', outcome: 'pass' },
  }), null)
  assert.equal(applyOp(board, {
    type: 'task.claim',
    projectId: 'p1',
    taskId: 't1',
    claim: { what: '未在真机验证', layer: 'physical', outcome: 'unverified' },
  }), null)
  assert.deepEqual(verifiedLayers(task), ['unit'])
  assert.deepEqual(verificationDebt(task), ['未在真机验证'])
  assert.equal(applyOp(board, { type: 'task.claim', projectId: 'p1', taskId: 't1', claim: { what: '' } }), 'invalid_field')
  assert.equal(applyOp(board, { type: 'task.claim', projectId: 'p1', taskId: 't1', claim: { what: 'x', layer: 'nope' } }), null)
  assert.equal(task.claims[2].layer, 'static', 'an unknown layer falls back to static')
})

test('required layers and a failed claim block automatic acceptance', () => {
  const board = boardWithOneTask()
  const project = board.projects[0]
  const task = project.tasks[0]
  task.evidence = '做完了'
  task.progress = 100

  assert.equal(applyOp(board, { type: 'project.setAcceptance', projectId: 'p1', requiredLayers: ['unit', 'build'] }), null)
  assert.deepEqual(project.requiredLayers, ['unit', 'build'])

  // Only unit covered -> blocked by the missing build layer.
  assert.equal(applyOp(board, { type: 'task.claim', projectId: 'p1', taskId: 't1', claim: { what: '单测', how: 'node --test', layer: 'unit', outcome: 'pass' } }), null)
  let verdict = evaluateAcceptance(task, project)
  assert.equal(verdict.pass, false)
  assert.ok(verdict.reasons.some(reason => reason.includes('缺少验证层级')))
  assert.ok(verdict.warnings.some(warning => warning.includes('下一步')))

  // A failing claim blocks even when layers are covered.
  assert.equal(applyOp(board, { type: 'task.claim', projectId: 'p1', taskId: 't1', claim: { what: '构建', how: 'npm run build', layer: 'build', outcome: 'fail' } }), null)
  verdict = evaluateAcceptance(task, project)
  assert.equal(verdict.pass, false)
  assert.ok(verdict.reasons.some(reason => reason.includes('验证失败项')))
})

test('the requireVerifiedClaim rule needs a claim with a method', () => {
  const board = boardWithOneTask()
  const project = board.projects[0]
  const task = project.tasks[0]
  task.evidence = '做完了'
  task.progress = 100
  assert.equal(applyOp(board, { type: 'project.setAcceptance', projectId: 'p1', rules: { requireVerifiedClaim: true } }), null)
  assert.equal(evaluateAcceptance(task, project).pass, false)
  // A claim without a method is not evidence.
  assert.equal(applyOp(board, { type: 'task.claim', projectId: 'p1', taskId: 't1', claim: { what: '看着没问题', layer: 'static', outcome: 'pass' } }), null)
  assert.equal(evaluateAcceptance(task, project).pass, false)
  assert.equal(applyOp(board, { type: 'task.claim', projectId: 'p1', taskId: 't1', claim: { what: '单测', how: 'node --test', layer: 'unit', outcome: 'pass' } }), null)
  assert.equal(evaluateAcceptance(task, project).pass, true)
})

test('gates block a column the card is not ready for', () => {
  const board = boardWithOneTask()
  const project = board.projects[0]
  const task = project.tasks[0]
  // Off by default: moving into review stays free.
  assert.equal(applyOp(board, { type: 'task.move', projectId: 'p1', taskId: 't1', status: 'review' }), null)
  assert.equal(applyOp(board, { type: 'task.move', projectId: 'p1', taskId: 't1', status: 'running' }), null)

  assert.equal(applyOp(board, {
    type: 'project.setAcceptance',
    projectId: 'p1',
    gates: { review: { requireEvidence: true, requireDeliverables: true } },
  }), null)
  assert.equal(applyOp(board, { type: 'task.move', projectId: 'p1', taskId: 't1', status: 'review' }), 'gate_evidence')

  assert.equal(applyOp(board, { type: 'task.patch', projectId: 'p1', taskId: 't1', patch: { evidence: '做了什么' } }), null)
  assert.equal(applyOp(board, { type: 'task.move', projectId: 'p1', taskId: 't1', status: 'review' }), 'gate_deliverables')

  assert.equal(applyOp(board, { type: 'task.patch', projectId: 'p1', taskId: 't1', patch: { deliverables: ['docs/a.md'] } }), null)
  assert.equal(applyOp(board, { type: 'task.move', projectId: 'p1', taskId: 't1', status: 'review' }), null)
  assert.equal(task.status, 'review')
})

test('cards keep an audit trail of what happened to them', () => {
  const board = boardWithOneTask()
  const task = board.projects[0].tasks[0]
  assert.equal(applyOp(board, { type: 'task.move', projectId: 'p1', taskId: 't1', status: 'review' }), null)
  assert.deepEqual(task.events.map(event => event.kind), ['moved'])
  assert.equal(task.events[0].from, 'running')
  assert.equal(task.events[0].to, 'review')

  task.evidence = '做完了'
  task.progress = 100
  assert.equal(applyOp(board, { type: 'task.move', projectId: 'p1', taskId: 't1', status: 'done' }), null)
  const kinds = task.events.map(event => event.kind)
  assert.ok(kinds.includes('accepted'), 'acceptance is recorded: ' + kinds.join(','))
  assert.equal(task.events.length <= 50, true)
})

test('an independent review is recorded on the card', () => {
  const board = boardWithOneTask()
  const task = board.projects[0].tasks[0]
  assert.equal(applyOp(board, { type: 'task.review', projectId: 'p1', taskId: 't1', review: { by: 'other-model', verdict: 'disagree', note: '证据不足' } }), null)
  assert.equal(task.reviews.length, 1)
  assert.equal(task.reviews[0].verdict, 'disagree')
  assert.equal(applyOp(board, { type: 'task.review', projectId: 'p1', taskId: 't1', review: { verdict: '' } }), 'invalid_field')
})

test('the decision anchor is distilled and merged incrementally', () => {
  const board = boardWithOneTask()
  const project = board.projects[0]
  assert.equal(applyOp(board, {
    type: 'project.setAnchor',
    projectId: 'p1',
    anchor: { digest: '做一个 X', decisions: [{ title: '用 A', reason: '更简单' }], risks: ['未测 WSL'] },
  }), null)
  assert.equal(project.anchor.digest, '做一个 X')
  assert.equal(project.anchor.decisions.length, 1)
  assert.equal(project.anchor.updatedAt > 0, true)

  // A later write keeps what it does not mention.
  assert.equal(applyOp(board, { type: 'project.setAnchor', projectId: 'p1', anchor: { deviations: ['少做一个 Y'] } }), null)
  assert.equal(project.anchor.digest, '做一个 X')
  assert.deepEqual(project.anchor.deviations, ['少做一个 Y'])
  assert.equal(project.anchor.risks.length, 1)
})

test('recheck marks stale links and refreshes deliverable verdicts', () => {
  const board = boardWithOneTask()
  const project = board.projects[0]
  assert.equal(applyOp(board, { type: 'reference.add', projectId: 'p1', id: 's1', kind: 'link', name: '文档', value: 'docs/a.md' }), null)
  assert.equal(applyOp(board, { type: 'reference.add', projectId: 'p1', id: 's2', kind: 'link', name: '还在的', value: 'docs/b.md' }), null)
  assert.equal(applyOp(board, { type: 'reference.add', projectId: 'p1', id: 's3', kind: 'note', name: '约定', value: '先评审' }), null)
  const task = project.tasks[0]
  task.deliverables = ['docs/a.md']

  assert.equal(applyOp(board, {
    type: 'project.recheck',
    projectId: 'p1',
    staleEntries: ['s1', 's3'],
    deliverables: { t1: { checked: true, missing: ['docs/a.md'], unresolved: [] } },
  }), null)
  assert.equal(project.references.find(entry => entry.id === 's1').staleSince > 0, true)
  assert.equal(project.references.find(entry => entry.id === 's2').staleSince, 0)
  assert.equal(project.references.find(entry => entry.id === 's3').staleSince, 0, 'a note is never stale')
  assert.deepEqual(task.verification.missing, ['docs/a.md'])
  assert.equal(project.lastCheckAt > 0, true)

  // A later sweep that resolves the path clears the stale flag.
  assert.equal(applyOp(board, {
    type: 'project.recheck',
    projectId: 'p1',
    staleEntries: [],
    deliverables: { t1: { checked: true, missing: [], unresolved: [] } },
  }), null)
  assert.equal(project.references.find(entry => entry.id === 's1').staleSince, 0)
  assert.deepEqual(task.verification.missing, [])
})

test('next action and verification debt round-trip through a patch', () => {
  const board = boardWithOneTask()
  const task = board.projects[0].tasks[0]
  assert.equal(applyOp(board, {
    type: 'task.patch',
    projectId: 'p1',
    taskId: 't1',
    patch: { nextAction: '补 3 个用例', pendingVerification: ['WSL 路径', '真机'] },
  }), null)
  assert.equal(task.nextAction, '补 3 个用例')
  assert.deepEqual(task.pendingVerification, ['WSL 路径', '真机'])
  assert.deepEqual(verificationDebt(task), ['WSL 路径', '真机'])
  assert.equal(applyOp(board, { type: 'task.patch', projectId: 'p1', taskId: 't1', patch: { nextAction: 42 } }), 'invalid_field')
})

test('a gate also guards a status written through a patch', () => {
  const board = boardWithOneTask()
  const project = board.projects[0]
  const task = project.tasks[0]
  assert.equal(applyOp(board, {
    type: 'project.setAcceptance',
    projectId: 'p1',
    gates: { review: { requireEvidence: true } },
  }), null)
  // The tool surface writes status through a patch; the gate must still hold.
  assert.equal(applyOp(board, { type: 'task.patch', projectId: 'p1', taskId: 't1', patch: { status: 'review' } }), 'gate_evidence')
  assert.equal(task.status, 'running', 'a refused gate leaves the column alone')
  assert.equal(applyOp(board, { type: 'task.patch', projectId: 'p1', taskId: 't1', patch: { evidence: '做了' } }), null)
  assert.equal(applyOp(board, { type: 'task.patch', projectId: 'p1', taskId: 't1', patch: { status: 'review' } }), null)
  assert.equal(task.status, 'review')
})

test('the store parks the previous document before a whole-document write', async () => {
  const dir = await tempDir()
  const file = join(dir, 'board.json')
  const store = createStore(file)
  await store.init()
  await store.mutate(draft => {
    draft.projects.push({ ...draft.projects[0], id: 'p-keep', name: '留下的' })
    return draft
  })
  const before = store.snapshot()
  const saved = await store.backup('before-replace')
  assert.equal(typeof saved, 'string')
  assert.equal(saved === '', false, 'a non-empty document must be copied')
  const copied = JSON.parse(await readFile(saved, 'utf8'))
  assert.equal(copied.projects.length, before.projects.length, 'the copy holds the document as it was')
  // An empty/missing document has nothing worth keeping.
  const blank = createStore(join(dir, 'missing', 'board.json'))
  assert.equal(await blank.backup('before-replace'), '')
})
