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
  MAX_MATERIALS_LENGTH,
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
      materials: 'docs/需求.md',
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
  // The typed list of an older document is merged into the one text block.
  assert.equal(board.projects[0].materials, '- 约定：路径')
  assert.equal('references' in board.projects[0], false)
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
  // A card waiting in review must not let the project read as finished.
  assert.equal(projectPercent({ tasks: [{ status: 'review', progress: 100 }] }), 99)
  assert.equal(projectTone({ tasks: [{ status: 'review', progress: 100, blocked: false }] }), 'yellow')
  assert.equal(projectPercent({ tasks: [{ status: 'done', progress: 100 }] }), 100)
  assert.equal(projectTone({ tasks: [{ status: 'done', progress: 100, blocked: false }] }), 'green')
  assert.equal(boardCounts(board).running, 1)
})

test('project operations: add, rename, setMaterials, remove, duplicate id', () => {
  const board = emptyBoard()
  assert.equal(applyOp(board, { type: 'project.add', id: 'p1', name: 'Alpha' }), null)
  assert.equal(board.projects.length, 1)
  assert.equal(board.projects[0].materials, '', 'a new project starts with an empty material text')
  assert.equal(applyOp(board, { type: 'project.add', id: 'p1', name: 'Again' }), 'duplicate_id')
  assert.equal(applyOp(board, { type: 'project.rename', projectId: 'p1', name: 'Beta' }), null)
  assert.equal(board.projects[0].name, 'Beta')
  assert.equal(applyOp(board, { type: 'project.setMaterials', projectId: 'p1', materials: 'a/b.md' }), null)
  assert.equal(board.projects[0].materials, 'a/b.md')
  // A write replaces the whole block instead of piling text up.
  assert.equal(applyOp(board, { type: 'project.setMaterials', projectId: 'p1', materials: 'c/d.md' }), null)
  assert.equal(board.projects[0].materials, 'c/d.md')
  // An empty text clears the block again.
  assert.equal(applyOp(board, { type: 'project.setMaterials', projectId: 'p1', materials: '' }), null)
  assert.equal(board.projects[0].materials, '')
  assert.equal(applyOp(board, { type: 'project.rename', projectId: 'nope', name: 'X' }), 'unknown_project')
  assert.equal(applyOp(board, { type: 'project.remove', projectId: 'p1' }), null)
  assert.equal(board.projects.length, 0)
  assert.equal(applyOp(board, { type: 'project.remove', projectId: 'p1' }), null, 'removing a missing project is a no-op')
})

test('project.setMaterials truncates a long text and refuses a non-string', () => {
  const board = emptyBoard()
  assert.equal(applyOp(board, { type: 'project.add', id: 'p1', name: 'Alpha' }), null)
  const project = board.projects[0]
  const long = 'x'.repeat(MAX_MATERIALS_LENGTH + 50)
  assert.equal(applyOp(board, { type: 'project.setMaterials', projectId: 'p1', materials: long }), null)
  assert.equal(project.materials.length, MAX_MATERIALS_LENGTH, 'an over-long text is cut, not refused')
  assert.equal(applyOp(board, { type: 'project.setMaterials', projectId: 'p1', materials: 42 }), 'invalid_field')
  assert.equal(applyOp(board, { type: 'project.setMaterials', projectId: 'p1', materials: ['a.md'] }), 'invalid_field')
  assert.equal(applyOp(board, { type: 'project.setMaterials', projectId: 'p1' }), 'invalid_field')
  assert.equal(applyOp(board, { type: 'project.setMaterials', projectId: 'nope', materials: 'x' }), 'unknown_project')
})

test('the removed material operations answer unknown_op', () => {
  const board = boardWithOneTask()
  const removed = [
    { type: 'reference.add', projectId: 'p1', kind: 'link', name: 'A', value: 'a.md' },
    { type: 'reference.update', projectId: 'p1', referenceId: 'ref-1', patch: { value: 'b.md' } },
    { type: 'reference.remove', projectId: 'p1', referenceId: 'ref-1' },
    { type: 'reference.intake', projectId: 'p1', paths: ['a.md'] },
    { type: 'project.setShared', projectId: 'p1', shared: '旧文本' },
    { type: 'sharedEntry.add', projectId: 'p1', id: 's1', name: 'A', path: 'a.md' },
    { type: 'sharedEntry.patch', projectId: 'p1', entryId: 's1', path: 'b.md' },
    { type: 'sharedEntry.update', projectId: 'p1', entryId: 's1', path: 'b.md' },
    { type: 'sharedEntry.remove', projectId: 'p1', entryId: 's1' },
  ]
  for (const op of removed) {
    assert.equal(applyOp(board, op), 'unknown_op', op.type + ' must be gone')
  }
  assert.equal(board.projects[0].materials, 'docs/需求.md', 'a refused operation changes nothing')
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
  assert.equal(applyOp(board, { type: 'project.setAcceptance', projectId: 'p1', rules: { blockOnDebt: 'yes' } }), 'invalid_field')
  // The root directory is stored trimmed and bounded.
  assert.equal(applyOp(board, { type: 'project.setAcceptance', projectId: 'p1', rootDir: '  /repo  ' }), null)
  assert.equal(project.rootDir, '/repo')
})

test('a version-11 document migrates to v12 with an empty material text and automatic acceptance', () => {
  const legacy = {
    version: 11,
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
  assert.equal(board.version, 12)
  assert.equal(board.revision, 3)
  const project = board.projects[0]
  assert.equal(project.plan, null, 'a version-11 document has no draft breakdown unless it wrote one')
  assert.equal(project.acceptanceMode, 'auto')
  assert.equal(project.acceptanceRules.blockOnDebt, true, 'an older document inherits the default, which is on')
  assert.equal(project.materials, '')
  assert.equal('references' in project, false, 'the typed list is not written back')
  const task = project.tasks[0]
  assert.equal(task.acceptedBy, '')
  assert.equal(task.requireHuman, false)
  assert.equal(task.evidence, '')
  assert.deepEqual(task.deliverables, [])
  assert.equal(task.acceptance, null)
  assert.equal('refs' in task, false, 'a card no longer points at material')
})

test('a version-11 document merges its references into one material text', () => {
  const legacy = {
    version: 11,
    revision: 5,
    projects: [{
      id: 'p1',
      name: '旧项目',
      references: [
        { id: 'r1', kind: 'link', name: '接口文档', value: 'docs/api.md', description: 'v2 协议', staleSince: 0 },
        { id: 'r2', kind: 'link', name: '需求', value: 'docs/需求.md', description: '', staleSince: 9 },
        { id: 'r3', kind: 'note', name: '约定', value: '先评审再实现', description: '口头确认', staleSince: 0 },
      ],
      tasks: [{ id: 't1', title: '旧卡', refs: ['r1', 'ghost'], status: 'todo', progress: 0 }],
      memory: [],
      trash: [],
      plan: { id: 'plan-1', summary: '草案', createdAt: 1, items: [{ title: '整理目录', refs: ['r1'] }] },
    }],
  }
  const board = normalizeBoard(legacy)
  assert.equal(board.version, 12)
  assert.equal(board.revision, 5)
  const project = board.projects[0]
  assert.equal(project.materials, [
    '- 接口文档：docs/api.md（v2 协议）',
    '- 需求：docs/需求.md',
    '- 约定：先评审再实现',
  ].join('\n'), 'each reference becomes one line, in stored order; a note keeps no description bracket')
  assert.equal('references' in project, false, 'the typed list is gone')
  assert.equal('refs' in project.tasks[0], false, 'a card no longer points at material')
  assert.deepEqual(project.plan.items.map(item => item.title), ['整理目录'])
  assert.equal('refs' in project.plan.items[0], false, 'a draft item no longer points at material')

  // A migrated document is stable: reading it again must not append the lines.
  const again = normalizeBoard(board)
  assert.equal(again.projects[0].materials, project.materials, 'a second pass adds nothing')
  assert.equal('references' in again.projects[0], false)
})

test('a version-9 document folds its shared text and entries into the material text', () => {
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
  assert.equal(board.version, DOC_VERSION)
  const project = board.projects[0]
  assert.equal(project.materials, [
    '- 项目说明：先评审再实现',
    '- 设计稿：docs/design.md（首页与详情页 2 版）',
  ].join('\n'), 'the old free text comes first, then the entries')
  assert.equal('shared' in project, false, 'the version-9 fields are not written back')
  assert.equal('sharedEntries' in project, false)
  assert.equal('refs' in project.tasks[0], false)

  // Idempotence: a second pass must add nothing.
  const again = normalizeBoard(board)
  assert.equal(again.projects[0].materials, project.materials, 'a second pass adds nothing')
})

test('a material entry with no value renders as a bare name', () => {
  const legacy = {
    version: 11,
    projects: [{
      id: 'p1',
      name: 'P',
      references: [
        { id: 'r1', kind: 'note', name: '先评审再实现' },
        { id: 'r2', kind: 'other', name: '外部审批', value: '走线下邮件', description: '采购确认' },
      ],
      tasks: [],
      memory: [],
    }],
  }
  assert.equal(normalizeBoard(legacy).projects[0].materials, [
    '- 先评审再实现',
    '- 外部审批：走线下邮件（采购确认）',
  ].join('\n'))
})

test('an already written material text wins over a stale structured list', () => {
  const legacy = {
    version: 11,
    projects: [{
      id: 'p1',
      name: 'P',
      materials: 'docs/新的.md\n先评审',
      references: [{ id: 'r1', kind: 'link', name: '旧文档', value: 'docs/old.md' }],
      tasks: [],
      memory: [],
    }],
  }
  const project = normalizeBoard(legacy).projects[0]
  assert.equal(project.materials, 'docs/新的.md\n先评审', 'a migrated document keeps its text')
  assert.equal('references' in project, false)

  // A stored block longer than the bound is cut on load too.
  const long = normalizeBoard({ version: 12, projects: [{ id: 'p2', name: 'P2', materials: 'x'.repeat(MAX_MATERIALS_LENGTH + 10) }] })
  assert.equal(long.projects[0].materials.length, MAX_MATERIALS_LENGTH)
})

test('subtask operations: add, patch whitelist, move with expected status, remove and restore', () => {
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

test('contextSentAt records whether the card has ever been dispatched', () => {
  const board = boardWithOneTask()
  // A stored card that never carried the field reads as "never dispatched".
  assert.equal(board.projects[0].tasks[0].contextSentAt, 0)

  assert.equal(applyOp(board, { type: 'task.add', projectId: 'p1', id: 't2', title: '新任务' }), null)
  assert.equal(board.projects[0].tasks[1].contextSentAt, 0, 'a new task starts never dispatched')

  const patch = (value) => applyOp(board, { type: 'task.patch', projectId: 'p1', taskId: 't1', patch: value })
  assert.equal(patch({ contextSentAt: 123 }), null)
  assert.equal(board.projects[0].tasks[0].contextSentAt, 123)
  assert.equal(patch({ contextSentAt: 'yes' }), 'invalid_field')
  assert.equal(patch({ contextSentAt: -1 }), 'invalid_field')
  assert.equal(board.projects[0].tasks[0].contextSentAt, 123, 'a refused patch leaves the stored mark alone')

  // Old documents gain the field at its empty value, and a hand-edited
  // negative value cannot read as "dispatched".
  const legacy = normalizeBoard({ version: 1, tasks: [{ id: 'a', title: '旧一' }] })
  assert.equal(legacy.projects[0].tasks[0].contextSentAt, 0)
  const handEdited = normalizeBoard({
    version: 12,
    projects: [{ id: 'p', name: 'P', tasks: [{ id: 't', title: 'T', contextSentAt: -5 }] }],
  })
  assert.equal(handEdited.projects[0].tasks[0].contextSentAt, 0)

  // A card stored before the field existed, but already bound to a Session and
  // past todo, was dispatched: it must offer "open", not "dispatch again".
  const adopted = normalizeBoard({
    version: 12,
    projects: [{
      id: 'p', name: 'P', materials: '', memory: [], trash: [],
      tasks: [
        { id: 'a', title: '已派过', status: 'review', sessionId: 'sess-1', updatedAt: 1700000000000 },
        { id: 'b', title: '已开始', status: 'running', sessionId: 'sess-2', updatedAt: 1700000000000 },
        { id: 'c', title: '绑了但没派', status: 'todo', sessionId: 'sess-3', updatedAt: 1700000000000 },
        { id: 'd', title: '没绑会话', status: 'review', updatedAt: 1700000000000 },
        { id: 'e', title: '显式记 0', status: 'review', sessionId: 'sess-4', contextSentAt: 0 },
      ],
    }],
  })
  const adoptedTasks = adopted.projects[0].tasks
  assert.equal(adoptedTasks[0].contextSentAt, 1700000000000, 'review + bound reads as dispatched')
  assert.equal(adoptedTasks[1].contextSentAt, 1700000000000, 'running + bound reads as dispatched')
  assert.equal(adoptedTasks[2].contextSentAt, 0, 'todo + bound still reads as never dispatched')
  assert.equal(adoptedTasks[3].contextSentAt, 0, 'no Session means nothing was dispatched')
  assert.equal(adoptedTasks[4].contextSentAt, 0, 'an explicit 0 is respected')
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

test('recheck refreshes deliverable verdicts and records when it ran', () => {
  const board = boardWithOneTask()
  const project = board.projects[0]
  const task = project.tasks[0]
  task.deliverables = ['docs/a.md']

  assert.equal(applyOp(board, {
    type: 'project.recheck',
    projectId: 'p1',
    deliverables: { t1: { checked: true, missing: ['docs/a.md'], unresolved: [] } },
  }), null)
  assert.deepEqual(task.verification.missing, ['docs/a.md'])
  assert.equal(project.lastCheckAt > 0, true)

  // The stale-reference sweep is gone: nothing is probed or marked, and a
  // leftover field on the operation is ignored instead of reviving the old
  // shape.
  assert.equal(applyOp(board, { type: 'project.recheck', projectId: 'p1', staleEntries: ['ref-1'] }), null)
  assert.equal('references' in project, false)

  // A later sweep that resolves the file clears the verdict.
  assert.equal(applyOp(board, {
    type: 'project.recheck',
    projectId: 'p1',
    deliverables: { t1: { checked: true, missing: [], unresolved: [] } },
  }), null)
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

test('blockOnDebt decides whether verification debt blocks automatic acceptance', () => {
  // The rule is on by default, so switching it off is what makes an open item a
  // warning only: the card then closes exactly as it used to.
  const open = boardWithOneTask()
  const openProject = open.projects[0]
  const openTask = openProject.tasks[0]
  openTask.progress = 100
  openTask.evidence = '分析报告写完了'
  openTask.nextAction = '等真机'
  openTask.pendingVerification = ['要不要在这里修', '真机没跑']
  assert.equal(openProject.acceptanceRules.blockOnDebt, true)
  assert.equal(applyOp(open, { type: 'project.setAcceptance', projectId: 'p1', rules: { blockOnDebt: false } }), null)
  assert.equal(openProject.acceptanceRules.blockOnDebt, false)
  let verdict = evaluateAcceptance(openTask, openProject)
  assert.equal(verdict.pass, true, 'the default rule keeps the card auto-acceptable')
  assert.deepEqual(verdict.reasons, [])
  assert.deepEqual(verdict.warnings, ['还有 2 项未验证或待决策：要不要在这里修、真机没跑'])
  assert.equal(applyOp(open, { type: 'task.submit', projectId: 'p1', taskId: 't1', progress: 100 }), null)
  assert.equal(openTask.status, 'done')
  assert.equal(openTask.acceptedBy, 'auto')

  // Turned on: the same sentence becomes a reason, so the card waits for a human.
  const blocked = boardWithOneTask()
  const blockedProject = blocked.projects[0]
  const blockedTask = blockedProject.tasks[0]
  assert.equal(applyOp(blocked, { type: 'project.setAcceptance', projectId: 'p1', rules: { blockOnDebt: true } }), null)
  assert.equal(blockedProject.acceptanceRules.blockOnDebt, true)
  assert.equal(applyOp(blocked, {
    type: 'task.submit',
    projectId: 'p1',
    taskId: 't1',
    progress: 100,
    evidence: '分析报告写完了',
    nextAction: '等用户决定要不要在这里修',
    pendingVerification: ['要不要在这里修'],
  }), null)
  assert.equal(blockedTask.status, 'review')
  assert.equal(blockedTask.acceptedBy, '')
  assert.deepEqual(blockedTask.acceptance.reasons, ['还有 1 项未验证或待决策：要不要在这里修'])
  assert.deepEqual(blockedTask.acceptance.warnings, [])
  assert.match(blockedTask.reviewReason, /还有 1 项未验证或待决策：要不要在这里修/)

  // With nothing open the rule changes nothing.
  const clean = boardWithOneTask()
  const cleanProject = clean.projects[0]
  const cleanTask = cleanProject.tasks[0]
  assert.equal(applyOp(clean, { type: 'project.setAcceptance', projectId: 'p1', rules: { blockOnDebt: true } }), null)
  assert.equal(applyOp(clean, {
    type: 'task.submit', projectId: 'p1', taskId: 't1', progress: 100, evidence: '全做完了',
  }), null)
  assert.equal(cleanTask.status, 'done')
  assert.equal(cleanTask.acceptedBy, 'auto')
})

test('the debt reason counts every open item but names only the first three', () => {
  const board = boardWithOneTask()
  const project = board.projects[0]
  const task = project.tasks[0]
  task.progress = 100
  task.evidence = '做完了'
  task.nextAction = '等真机'
  task.pendingVerification = ['一', '二', '三', '四', '五']
  assert.equal(applyOp(board, { type: 'project.setAcceptance', projectId: 'p1', rules: { blockOnDebt: true } }), null)
  const verdict = evaluateAcceptance(task, project)
  assert.equal(verdict.pass, false)
  assert.deepEqual(verdict.reasons, ['还有 5 项未验证或待决策：一、二、三'])
  assert.deepEqual(verdict.warnings, [])
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
