/**
 * Greenlight board tools the model can call.
 *
 * These are raw `ToolDefinition` objects (no `defineTool` import): this bundle
 * lives outside the Harness package tree, so it registers the wire shape the
 * registry accepts — `{ name, description, parameters, output, execute }` — and
 * validates its own arguments, which the cookbook requires for raw JSON-Schema
 * tools.
 *
 * Every tool goes through the same store mutation the HTTP route uses, so a
 * change made from a conversation and a change made in the panel cannot take
 * different paths.
 */
import { applyOps, boardCounts, createId, findProject, findTask, projectPercent, projectTone, statusCounts } from './board.js'
import { archivedCount, isArchiveOp, putCards, takeCards } from './archive.js'
import { prepareBatch } from './verify.js'

/** Subtasks returned by the detail tool. */
const DETAIL_TASK_LIMIT = 50
/** Memory entries returned by the detail tool. */
const DETAIL_MEMORY_LIMIT = 20
/** Characters of a note returned by the detail tool. */
const DETAIL_NOTE_LIMIT = 240

/**
 * @param code - rejection code from the data layer.
 * @returns the message the model sees.
 */
function messageFor(code) {
  switch (code) {
    case 'unknown_project': return '项目不存在（projectId 有误）'
    case 'unknown_task': return '子任务不存在（taskId 有误）'
    case 'unknown_reference': return '资料不存在（id 有误）'
    case 'invalid_field': return '参数不合法'
    case 'duplicate_id': return '该 id 已存在'
    case 'stale_status': return '子任务已不在预期的状态列，请先重新读取'
    case 'review_required': return '已完成只能由人在看板上点「通过」；工具可以把卡推进到「待验收」'
    case 'import_conflict': return '看板已有数据，不能导入'
    case 'import_empty': return '导入内容里没有可用项目'
    default: return '操作被拒绝：' + code
  }
}

/**
 * Require a non-blank string argument.
 * @param args - tool arguments.
 * @param key - parameter name.
 * @returns the value.
 */
function requireString(args, key) {
  const value = args === null || args === undefined ? undefined : args[key]
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error('参数 ' + key + ' 必须是非空字符串')
  }
  return value
}

/**
 * Read an optional string argument.
 * @param args - tool arguments.
 * @param key - parameter name.
 * @returns the string, or undefined.
 */
function optionalString(args, key) {
  const value = args === null || args === undefined ? undefined : args[key]
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'string') throw new Error('参数 ' + key + ' 必须是字符串')
  return value
}

/**
 * Read an optional number argument.
 * @param args - tool arguments.
 * @param key - parameter name.
 * @returns the number, or undefined.
 */
function optionalNumber(args, key) {
  const value = args === null || args === undefined ? undefined : args[key]
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error('参数 ' + key + ' 必须是数字')
  return value
}

/**
 * Read an optional array of plain objects.
 * @param args - tool arguments.
 * @param key - parameter name.
 * @returns the array, or undefined.
 */
function optionalObjectArray(args, key) {
  const value = args === null || args === undefined ? undefined : args[key]
  if (value === undefined || value === null) return undefined
  if (!Array.isArray(value)) throw new Error('参数 ' + key + ' 必须是对象数组')
  for (const entry of value) {
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
      throw new Error('参数 ' + key + ' 必须是对象数组')
    }
  }
  return value
}

/**
 * Read an optional array of strings.
 * @param args - tool arguments.
 * @param key - parameter name.
 * @returns the array, or undefined.
 */
function optionalStringArray(args, key) {
  const value = args === null || args === undefined ? undefined : args[key]
  if (value === undefined || value === null) return undefined
  if (!Array.isArray(value)) throw new Error('参数 ' + key + ' 必须是字符串数组')
  for (const entry of value) {
    if (typeof entry !== 'string') throw new Error('参数 ' + key + ' 必须是字符串数组')
  }
  return value
}

/**
 * Read an optional boolean argument.
 * @param args - tool arguments.
 * @param key - parameter name.
 * @returns the boolean, or undefined.
 */
function optionalBoolean(args, key) {
  const value = args === null || args === undefined ? undefined : args[key]
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'boolean') throw new Error('参数 ' + key + ' 必须是布尔值')
  return value
}

/**
 * Apply one operation through the store.
 * @param store - board store.
 * @param op - operation to apply.
 * @param archiver - cold storage for archive operations.
 * @returns the committed board.
 */
async function runOp(store, op, archiver) {
  let code = null
  // Archive work is ordered around the board commit: save first when archiving,
  // restore the board first and drop from cold storage only after it commits.
  const restoring = op !== null && op.type === 'board.restore' && archiver !== undefined
    ? await archiver.findTasks(op.projectId, op.taskIds)
    : null
  const board = await store.mutate(async (draft) => {
    if (op !== null && typeof op === 'object' && (op.type === 'board.replace' || op.type === 'board.import')) {
      await store.backup('before-replace')
    }
    if (restoring !== null) {
      const added = putCards(draft, op.projectId, restoring.projectName, restoring.tasks)
      if (added === 0) {
        code = 'unknown_task'
        return null
      }
      draft.revision = (draft.revision | 0) + 1
      draft.updatedAt = new Date().toISOString()
      return draft
    }
    if (op !== null && op.type === 'board.archive') {
      if (archiver === undefined) {
        code = 'archive_unavailable'
        return null
      }
      const taken = takeCards(draft, op.projectId, op.taskIds)
      if (taken.tasks.length === 0) {
        code = 'unknown_task'
        return null
      }
      await archiver.appendTasks({ id: op.projectId, name: taken.projectName }, taken.tasks)
      draft.revision = (draft.revision | 0) + 1
      draft.updatedAt = new Date().toISOString()
      return draft
    }
    // Verification touches the filesystem, so it runs inside the lock.
    const prepared = (await prepareBatch(draft, [op]))[0]
    const outcome = applyOps(draft, [prepared])
    if (outcome.rejected.length > 0) {
      code = outcome.rejected[0].code
      return null
    }
    return outcome.board
  })
  if (code !== null) throw new Error(messageFor(code))
  if (restoring !== null && archiver !== undefined) {
    await archiver.removeTasks(op.projectId, restoring.tasks.map(task => task.id))
  }
  return board
}

/**
 * Read back one subtask after a write.
 * @param store - board store.
 * @param projectId - project identity.
 * @param taskId - subtask identity.
 * @returns the tool result: status, progress and acceptance outcome.
 */
function describeTask(store, projectId, taskId) {
  const project = findProject(store.snapshot(), projectId)
  const task = project === undefined ? undefined : findTask(project, taskId)
  if (task === undefined) return { taskId, status: '', progress: 0, acceptedBy: '', reason: '' }
  const refused = task.acceptance !== null && task.acceptance.pass !== true
  return {
    taskId,
    status: task.status,
    progress: task.progress,
    acceptedBy: task.acceptedBy,
    reason: refused ? task.acceptance.reasons.join('；') : '',
  }
}

/**
 * One line telling the model what happened to a completion.
 * @param value - tool result.
 * @param prefix - leading sentence.
 * @returns the rendered line.
 */
function acceptanceLine(value, prefix) {
  const head = prefix + ' → ' + value.status + ' ' + value.progress + '%'
  if (value.acceptedBy === 'auto') return head + '（自动验收通过）'
  if (value.status === 'review' && value.reason !== '') {
    return head + '（自动验收未通过，已转人工验收：' + value.reason + '）'
  }
  return head
}

/**
 * Render one project reference as a model-facing line: the kind badge carries
 * the distinction the model has to keep — a link is re-checked, a note is not.
 * @param reference - reference to render.
 * @returns the bullet line.
 */
function referenceLine(reference) {
  // Only a link is probed; "约定" and "其它" are text the Host never checks.
  const kindLabel = reference.kind === 'link'
    ? '链接'
    : (reference.kind === 'note' ? '约定' : '其它')
  const valueText = reference.value === '' ? '' : '：' + reference.value
  // The description and the stale mark share one bracket, so a line never ends
  // with two parentheses.
  const marks = []
  if (reference.description !== '') marks.push(reference.description)
  if (reference.staleSince > 0) marks.push('已失效')
  return '- [' + kindLabel + '] ' + reference.name + valueText
    + (marks.length === 0 ? '' : '（' + marks.join('；') + '）')
}

/**
 * Render a list of references, one line each.
 * @param references - references to render.
 * @returns the lines joined by newlines.
 */
function renderReferences(references) {
  return references.map(referenceLine).join('\n')
}

/**
 * Build the tool definitions for one store.
 * @param store - board store.
 * @returns tool definitions ready for `ctx.tools.register`.
 */
export function createBoardTools(store, options) {
  const archiver = options === null || options === undefined ? undefined : options.archiver
  /**
   * Apply one operation with this mount's archiver bound.
   * @param op - operation to apply.
   * @returns the committed board.
   */
  const apply = op => runOp(store, op, archiver)
  return [
    {
      name: 'greenlight_overview',
      description: 'List the board: every project with its completion percentage, colour band, and subtask counts per status. Use this first to find a projectId.',
      parameters: { type: 'object', properties: {}, additionalProperties: false },
      output: {
        schema: {
          type: 'object',
          required: ['projects'],
          additionalProperties: false,
          properties: {
            projects: {
              type: 'array',
              items: {
                type: 'object',
                required: ['id', 'name', 'percent', 'tone'],
                additionalProperties: false,
                properties: {
                  id: { type: 'string' },
                  name: { type: 'string' },
                  percent: { type: 'number' },
                  tone: { type: 'string', enum: ['idle', 'red', 'yellow', 'green'] },
                  taskCount: { type: 'number' },
                  counts: { type: 'object', additionalProperties: true },
                },
              },
            },
            totals: { type: 'object', additionalProperties: true },
          },
        },
        render: (_args, value) => {
          if (value.projects.length === 0) return [{ type: 'text', text: '看板还没有项目。' }]
          const lines = value.projects.map(project =>
            '- ' + project.name + ' [' + project.id + '] ' + project.percent + '% ' + project.tone + '（' + project.taskCount + ' 个子任务）')
          return [{ type: 'text', text: '项目（' + value.projects.length + '）：\n' + lines.join('\n') }]
        },
      },
      async execute(args) {
        await store.init()
        const board = store.snapshot()
        return {
          projects: board.projects.map(project => ({
            id: project.id,
            name: project.name,
            percent: projectPercent(project),
            tone: projectTone(project),
            taskCount: project.tasks.length,
            counts: statusCounts(project),
          })),
          totals: boardCounts(board),
        }
      },
    },
    {
      name: 'greenlight_project',
      description: 'Read one project: its references (links and convention notes), its subtasks (bounded), and its recent memory entries.',
      parameters: {
        type: 'object',
        required: ['projectId'],
        additionalProperties: false,
        properties: {
          projectId: { type: 'string', description: 'Project id from greenlight_overview' },
        },
      },
      output: {
        schema: {
          type: 'object',
          required: ['project'],
          additionalProperties: false,
          properties: {
            project: {
              type: 'object',
              required: ['id', 'name', 'references', 'tasks', 'memory'],
              additionalProperties: false,
              properties: {
                id: { type: 'string' },
                name: { type: 'string' },
                percent: { type: 'number' },
                tone: { type: 'string' },
                references: { type: 'array', items: { type: 'object', additionalProperties: true } },
                tasks: { type: 'array', items: { type: 'object', additionalProperties: true } },
                memory: { type: 'array', items: { type: 'object', additionalProperties: true } },
                truncated: { type: 'boolean' },
              },
            },
          },
        },
        render: (_args, value) => {
          const project = value.project
          const head = '项目「' + project.name + '」 ' + project.percent + '%（' + project.tasks.length + ' 个子任务）'
          const references = project.references.length === 0
            ? '资料：空'
            : '资料：\n' + renderReferences(project.references)
          const tasks = project.tasks.length === 0
            ? '子任务：无'
            : '子任务：\n' + project.tasks.map(task =>
              '- [' + task.status + '] ' + task.title + ' [' + task.id + '] ' + task.progress + '%'
              + (task.blocked ? '（阻塞）' : '')
              + (task.sessionId ? ' session=' + task.sessionId : '')).join('\n')
          const memory = project.memory.length === 0
            ? '项目记忆：无'
            : '项目记忆：\n' + project.memory.map(entry => '- ' + entry.text).join('\n')
          return [{ type: 'text', text: [head, references, tasks, memory].join('\n\n') }]
        },
      },
      async execute(args) {
        const projectId = requireString(args, 'projectId')
        await store.init()
        const project = findProject(store.snapshot(), projectId)
        if (project === undefined) throw new Error(messageFor('unknown_project'))
        const tasks = project.tasks.slice(0, DETAIL_TASK_LIMIT).map(task => ({
          id: task.id,
          title: task.title,
          status: task.status,
          progress: task.progress,
          blocked: task.blocked,
          reviewReason: task.reviewReason,
          sessionId: task.sessionId,
          note: task.note.length > DETAIL_NOTE_LIMIT ? task.note.slice(0, DETAIL_NOTE_LIMIT) + '…' : task.note,
        }))
        const memory = project.memory.slice(-DETAIL_MEMORY_LIMIT).map(entry => ({
          id: entry.id,
          text: entry.text,
          taskId: entry.taskId,
          createdAt: entry.createdAt,
        }))
        return {
          project: {
            id: project.id,
            name: project.name,
            percent: projectPercent(project),
            tone: projectTone(project),
            acceptanceMode: project.acceptanceMode,
            acceptanceRules: project.acceptanceRules,
            rootDir: project.rootDir,
            references: project.references.map(entry => ({
              id: entry.id,
              kind: entry.kind,
              name: entry.name,
              value: entry.value,
              description: entry.description,
              staleSince: entry.staleSince,
            })),
            tasks,
            memory,
            truncated: project.tasks.length > DETAIL_TASK_LIMIT || project.memory.length > DETAIL_MEMORY_LIMIT,
          },
        }
      },
    },
    {
      name: 'greenlight_task_create',
      description: 'Add a subtask to one project. The new subtask starts in the todo column unless status is given.',
      parameters: {
        type: 'object',
        required: ['projectId', 'title'],
        additionalProperties: false,
        properties: {
          projectId: { type: 'string' },
          title: { type: 'string', description: 'Short subtask title' },
          note: { type: 'string', description: 'Optional longer description' },
          status: { type: 'string', enum: ['backlog', 'todo', 'running', 'review', 'done', 'failed'] },
        },
      },
      output: {
        schema: {
          type: 'object',
          required: ['taskId', 'projectId'],
          additionalProperties: false,
          properties: { taskId: { type: 'string' }, projectId: { type: 'string' } },
        },
        render: (_args, value) => [{ type: 'text', text: '已创建子任务 ' + value.taskId }],
      },
      async execute(args) {
        const projectId = requireString(args, 'projectId')
        const title = requireString(args, 'title')
        const note = optionalString(args, 'note')
        const status = optionalString(args, 'status')
        await store.init()
        if (findProject(store.snapshot(), projectId) === undefined) throw new Error(messageFor('unknown_project'))
        const taskId = 't' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8)
        const op = { type: 'task.add', projectId, id: taskId, title, titleSource: 'manual' }
        if (note !== undefined) op.note = note
        if (status !== undefined) op.status = status
        await apply(op)
        return { taskId, projectId }
      },
    },
    {
      name: 'greenlight_task_update',
      description: 'Update one subtask: move it between columns, change progress, mark it blocked, rewrite its title or note, or record a review result. Setting status to "done" is a completion request: the Host verifies it first and only keeps the card in done when it is verifiable, otherwise it parks the card in review.',
      parameters: {
        type: 'object',
        required: ['projectId', 'taskId'],
        additionalProperties: false,
        properties: {
          projectId: { type: 'string' },
          taskId: { type: 'string' },
          status: { type: 'string', enum: ['backlog', 'todo', 'running', 'review', 'done', 'failed'] },
          progress: { type: 'number', description: '0–100' },
          blocked: { type: 'boolean' },
          title: { type: 'string' },
          note: { type: 'string' },
          evidence: {
            type: 'string',
            description: 'What you actually did and checked. Required for automatic acceptance; without it the card waits for a human.',
          },
          deliverables: {
            type: 'array',
            items: { type: 'string' },
            description: 'Files or links this subtask produced',
          },
          reviewReason: { type: 'string', description: 'Why a review was rejected' },
          sessionId: { type: 'string', description: 'Main Session this subtask belongs to' },
          priority: { type: 'string', enum: ['low', 'normal', 'high', 'urgent'] },
          dueDate: { type: 'string', description: 'YYYY-MM-DD, or an empty string to clear' },
          tags: { type: 'array', items: { type: 'string' }, description: 'Replaces the tag list' },
          refs: {
            type: 'array',
            items: { type: 'string' },
            description: 'Ids of the project references this subtask points at',
          },
        },
      },
      output: {
        schema: {
          type: 'object',
          required: ['taskId'],
          additionalProperties: false,
          properties: {
            taskId: { type: 'string' },
            status: { type: 'string' },
            progress: { type: 'number' },
            acceptedBy: { type: 'string' },
            reason: { type: 'string' },
          },
        },
        render: (_args, value) => [{
          type: 'text',
          text: acceptanceLine(value, '已更新子任务 ' + value.taskId),
        }],
      },
      async execute(args) {
        const projectId = requireString(args, 'projectId')
        const taskId = requireString(args, 'taskId')
        const patch = {}
        const status = optionalString(args, 'status')
        const progress = optionalNumber(args, 'progress')
        const blocked = optionalBoolean(args, 'blocked')
        const title = optionalString(args, 'title')
        const note = optionalString(args, 'note')
        const reviewReason = optionalString(args, 'reviewReason')
        const sessionId = optionalString(args, 'sessionId')
        const evidence = optionalString(args, 'evidence')
        const deliverables = optionalStringArray(args, 'deliverables')
        if (status !== undefined) patch.status = status
        if (progress !== undefined) patch.progress = progress
        if (blocked !== undefined) patch.blocked = blocked
        if (title !== undefined) patch.title = title
        if (note !== undefined) patch.note = note
        if (reviewReason !== undefined) patch.reviewReason = reviewReason
        if (sessionId !== undefined) patch.sessionId = sessionId
        if (evidence !== undefined) patch.evidence = evidence
        if (deliverables !== undefined) patch.deliverables = deliverables
        const priority = optionalString(args, 'priority')
        const dueDate = optionalString(args, 'dueDate')
        const tags = optionalStringArray(args, 'tags')
        const refs = optionalStringArray(args, 'refs')
        if (priority !== undefined) patch.priority = priority
        if (dueDate !== undefined) patch.dueDate = dueDate
        if (tags !== undefined) patch.tags = tags
        if (refs !== undefined) patch.refs = refs
        if (Object.keys(patch).length === 0) throw new Error('至少要给出一个要修改的字段')
        await store.init()
        await apply({ type: 'task.patch', projectId, taskId, patch })
        return describeTask(store, projectId, taskId)
      },
    },
    {
      name: 'greenlight_task_submit',
      description: 'Report a subtask as finished and let the Host verify it. Include what you did (evidence) and the files you produced (deliverables). The card lands in done when the completion is verifiable, otherwise it goes to review with the reason so a human decides.',
      parameters: {
        type: 'object',
        required: ['projectId', 'taskId'],
        additionalProperties: false,
        properties: {
          projectId: { type: 'string' },
          taskId: { type: 'string' },
          evidence: { type: 'string', description: 'What you did and how you checked it' },
          deliverables: { type: 'array', items: { type: 'string' } },
          claims: {
            type: 'array',
            description: 'What you actually verified: one entry per check, each with how you checked it and at which layer',
            items: {
              type: 'object',
              required: ['what'],
              additionalProperties: false,
              properties: {
                what: { type: 'string' },
                how: { type: 'string', description: 'The command, test, or observation that supports it' },
                layer: { type: 'string', enum: ['static', 'unit', 'build', 'host', 'physical'] },
                outcome: { type: 'string', enum: ['pass', 'fail', 'unverified'] },
              },
            },
          },
          nextAction: { type: 'string', description: 'The next concrete step for whoever picks this up' },
          pendingVerification: {
            type: 'array',
            items: { type: 'string' },
            description: 'Things you know are still unverified; they show up as this card’s verification debt',
          },
          progress: { type: 'number', description: 'Defaults to 100' },
          blocked: { type: 'boolean', description: 'True when the work cannot continue' },
          status: { type: 'string', enum: ['failed'], description: 'Use "failed" to report that the work did not succeed' },
        },
      },
      output: {
        schema: {
          type: 'object',
          required: ['taskId'],
          additionalProperties: false,
          properties: {
            taskId: { type: 'string' },
            status: { type: 'string' },
            progress: { type: 'number' },
            acceptedBy: { type: 'string' },
            reason: { type: 'string' },
          },
        },
        render: (_args, value) => [{
          type: 'text',
          text: acceptanceLine(value, '已提交子任务 ' + value.taskId),
        }],
      },
      async execute(args) {
        const projectId = requireString(args, 'projectId')
        const taskId = requireString(args, 'taskId')
        const op = { type: 'task.submit', projectId, taskId }
        const evidence = optionalString(args, 'evidence')
        const deliverables = optionalStringArray(args, 'deliverables')
        const progress = optionalNumber(args, 'progress')
        const blocked = optionalBoolean(args, 'blocked')
        const status = optionalString(args, 'status')
        if (evidence !== undefined) op.evidence = evidence
        if (deliverables !== undefined) op.deliverables = deliverables
        if (progress !== undefined) op.progress = progress
        if (blocked !== undefined) op.blocked = blocked
        if (status !== undefined) op.status = status
        const claims = optionalObjectArray(args, 'claims')
        const nextAction = optionalString(args, 'nextAction')
        const pendingVerification = optionalStringArray(args, 'pendingVerification')
        if (claims !== undefined) op.claims = claims
        if (nextAction !== undefined) op.nextAction = nextAction
        if (pendingVerification !== undefined) op.pendingVerification = pendingVerification
        await store.init()
        await apply(op)
        return describeTask(store, projectId, taskId)
      },
    },
    {
      name: 'greenlight_archive',
      description: 'Move finished subtasks to cold storage, or bring them back. The active board stays small; archived cards are kept in a separate file and can be restored.',
      parameters: {
        type: 'object',
        required: ['action'],
        additionalProperties: false,
        properties: {
          action: { type: 'string', enum: ['list', 'archive', 'restore'] },
          projectId: { type: 'string' },
          taskIds: { type: 'array', items: { type: 'string' } },
        },
      },
      output: {
        schema: {
          type: 'object',
          required: ['action', 'count'],
          additionalProperties: false,
          properties: {
            action: { type: 'string' },
            count: { type: 'number' },
            projects: { type: 'array', items: { type: 'object', additionalProperties: true } },
          },
        },
        render: (_args, value) => [{
          type: 'text',
          text: value.action === 'list'
            ? '归档区共 ' + value.count + ' 张卡片'
            : (value.action === 'archive' ? '已归档 ' : '已恢复 ') + value.count + ' 张卡片',
        }],
      },
      async execute(args) {
        const action = requireString(args, 'action')
        if (archiver === undefined) throw new Error('归档不可用')
        const projectId = optionalString(args, 'projectId')
        const taskIds = optionalStringArray(args, 'taskIds')
        if (action === 'list') {
          await archiver.init()
          const archived = archiver.snapshot()
          return { action, count: archivedCount(archived), projects: archived.projects }
        }
        if (projectId === undefined || taskIds === undefined || taskIds.length === 0) {
          throw new Error('归档与恢复都需要 projectId 和 taskIds')
        }
        await apply({ type: 'board.' + action, projectId, taskIds })
        await archiver.init()
        return { action, count: taskIds.length, projects: archiver.snapshot().projects }
      },
    },
    {
      name: 'greenlight_preview',
      description: 'Dry-run board operations: apply them to a copy and report what would change, without writing anything. Use it before a risky batch.',
      parameters: {
        type: 'object',
        required: ['ops'],
        additionalProperties: false,
        properties: {
          ops: {
            type: 'array',
            description: 'Operations to preview, same shape as the ops the panel sends',
            items: { type: 'object', additionalProperties: true },
          },
        },
      },
      output: {
        schema: {
          type: 'object',
          required: ['ok', 'applied', 'rejected'],
          additionalProperties: false,
          properties: {
            ok: { type: 'boolean' },
            applied: { type: 'number' },
            rejected: { type: 'array', items: { type: 'object', additionalProperties: true } },
            changes: { type: 'array', items: { type: 'string' } },
          },
        },
        render: (_args, value) => [{
          type: 'text',
          text: value.rejected.length === 0
            ? '预演：' + value.applied + ' 个操作可全部应用' + (value.changes.length === 0 ? '' : '；变化：' + value.changes.join('，'))
            : '预演：' + value.rejected.length + ' 个操作会被拒绝（' + value.rejected.map(entry => entry.code).join('、') + '）',
        }],
      },
      async execute(args) {
        const ops = optionalObjectArray(args, 'ops')
        if (ops === undefined || ops.length === 0) throw new Error('至少要给一个要预演的操作')
        await store.init()
        const before = store.snapshot()
        const prepared = await prepareBatch(before, ops)
        const outcome = applyOps(before, prepared)
        const changes = []
        const beforeById = {}
        for (const project of before.projects) {
          for (const task of project.tasks) beforeById[task.id] = task
        }
        for (const project of outcome.board.projects) {
          for (const task of project.tasks) {
            const previous = beforeById[task.id]
            if (previous === undefined) changes.push('新增卡片 ' + task.title)
            else if (previous.status !== task.status) changes.push(task.title + ': ' + previous.status + ' → ' + task.status)
          }
        }
        return {
          ok: outcome.rejected.length === 0,
          applied: ops.length - outcome.rejected.length,
          rejected: outcome.rejected,
          changes: changes.slice(0, 20),
        }
      },
    },
    {
      name: 'greenlight_recheck',
      description: 'Re-check every declared path in a project: link references that no longer resolve are marked stale, and card deliverables are probed again. Notes are never probed. Read-only on the project files; only board flags change.',
      parameters: {
        type: 'object',
        required: ['projectId'],
        additionalProperties: false,
        properties: { projectId: { type: 'string' } },
      },
      output: {
        schema: {
          type: 'object',
          required: ['staleEntries', 'missingDeliverables'],
          additionalProperties: false,
          properties: {
            staleEntries: { type: 'array', items: { type: 'string' } },
            missingDeliverables: { type: 'array', items: { type: 'string' } },
          },
        },
        render: (_args, value) => [{
          type: 'text',
          text: value.staleEntries.length === 0 && value.missingDeliverables.length === 0
            ? '复查完成：所有引用与交付物都能定位'
            : '复查完成：' + value.staleEntries.length + ' 个失效引用，' + value.missingDeliverables.length + ' 张卡片交付物缺失',
        }],
      },
      async execute(args) {
        const projectId = requireString(args, 'projectId')
        await store.init()
        const project = findProject(store.snapshot(), projectId)
        if (project === undefined) throw new Error(messageFor('unknown_project'))
        await apply({ type: 'project.recheck', projectId })
        const after = findProject(store.snapshot(), projectId)
        const staleEntries = after.references.filter(entry => entry.staleSince > 0).map(entry => entry.name)
        const missingDeliverables = []
        for (const task of after.tasks) {
          if (task.verification !== null && (task.verification.missing.length > 0 || task.verification.unresolved.length > 0)) {
            missingDeliverables.push(task.title)
          }
        }
        return { staleEntries, missingDeliverables }
      },
    },
    {
      name: 'greenlight_review',
      description: 'Record an independent review of a subtask next to the card, so a second opinion is visible to the human instead of buried in chat.',
      parameters: {
        type: 'object',
        required: ['projectId', 'taskId', 'verdict'],
        additionalProperties: false,
        properties: {
          projectId: { type: 'string' },
          taskId: { type: 'string' },
          verdict: { type: 'string', description: 'Short conclusion, e.g. agree / disagree / needs-work' },
          by: { type: 'string', description: 'Who or what performed the review' },
          note: { type: 'string' },
        },
      },
      output: {
        schema: {
          type: 'object',
          required: ['taskId', 'reviews'],
          additionalProperties: false,
          properties: { taskId: { type: 'string' }, reviews: { type: 'number' } },
        },
        render: (_args, value) => [{ type: 'text', text: '已记录独立复评 ' + value.taskId + '（累计 ' + value.reviews + ' 条）' }],
      },
      async execute(args) {
        const projectId = requireString(args, 'projectId')
        const taskId = requireString(args, 'taskId')
        const verdict = requireString(args, 'verdict')
        const review = { verdict }
        const by = optionalString(args, 'by')
        const note = optionalString(args, 'note')
        if (by !== undefined) review.by = by
        if (note !== undefined) review.note = note
        await store.init()
        await apply({ type: 'task.review', projectId, taskId, review })
        const project = findProject(store.snapshot(), projectId)
        const task = project === undefined ? undefined : findTask(project, taskId)
        return { taskId, reviews: task === undefined ? 0 : task.reviews.length }
      },
    },
    {
      name: 'greenlight_acceptance',
      description: 'Read or change how a project accepts finished subtasks. Automatic acceptance verifies a completion; anything it cannot verify goes to a human. Reading needs only projectId; give mode/rules/rootDir to change them.',
      parameters: {
        type: 'object',
        required: ['projectId'],
        additionalProperties: false,
        properties: {
          projectId: { type: 'string' },
          mode: { type: 'string', enum: ['auto', 'human'] },
          requireEvidence: { type: 'boolean', description: 'A completion must explain what was done' },
          requireDeliverables: { type: 'boolean', description: 'A completion must declare deliverables' },
          verifyDeliverables: { type: 'boolean', description: 'Declared deliverables must exist as non-empty files' },
          requireSession: { type: 'boolean', description: 'A completion must belong to a Session' },
          requireVerifiedClaim: { type: 'boolean', description: 'A completion must carry at least one verified claim' },
          requiredLayers: {
            type: 'array',
            items: { type: 'string', enum: ['static', 'unit', 'build', 'host', 'physical'] },
            description: 'Verification layers a completion must cover',
          },
          gateReviewEvidence: { type: 'boolean', description: 'Refuse to move a card into review without a completion note' },
          gateReviewDeliverables: { type: 'boolean', description: 'Refuse to move a card into review without deliverables' },
          rootDir: {
            type: 'string',
            description: 'Absolute directory that relative deliverables resolve against; an empty string clears it',
          },
        },
      },
      output: {
        schema: {
          type: 'object',
          required: ['mode'],
          additionalProperties: false,
          properties: {
            mode: { type: 'string' },
            requireEvidence: { type: 'boolean' },
            requireDeliverables: { type: 'boolean' },
            verifyDeliverables: { type: 'boolean' },
            requireSession: { type: 'boolean' },
            rootDir: { type: 'string' },
          },
        },
        render: (_args, value) => [{
          type: 'text',
          text: '验收方式：' + (value.mode === 'human' ? '人工验收' : '自动验收')
            + '\n需要完成说明：' + (value.requireEvidence ? '是' : '否')
            + '\n需要交付物：' + (value.requireDeliverables ? '是' : '否')
            + '\n校验交付物文件：' + (value.verifyDeliverables ? '是' : '否')
            + '\n需要绑定会话：' + (value.requireSession ? '是' : '否')
            + '\n项目根目录：' + (value.rootDir === '' ? '（未设置）' : value.rootDir),
        }],
      },
      async execute(args) {
        const projectId = requireString(args, 'projectId')
        const mode = optionalString(args, 'mode')
        const rootDir = optionalString(args, 'rootDir')
        const rules = {}
        for (const key of ['requireEvidence', 'requireDeliverables', 'verifyDeliverables', 'requireSession', 'requireVerifiedClaim']) {
          const value = optionalBoolean(args, key)
          if (value !== undefined) rules[key] = value
        }
        const hasRules = Object.keys(rules).length > 0
        const requiredLayers = optionalStringArray(args, 'requiredLayers')
        const gateReviewEvidence = optionalBoolean(args, 'gateReviewEvidence')
        const gateReviewDeliverables = optionalBoolean(args, 'gateReviewDeliverables')
        const gates = {}
        if (gateReviewEvidence !== undefined || gateReviewDeliverables !== undefined) {
          gates.review = {}
          if (gateReviewEvidence !== undefined) gates.review.requireEvidence = gateReviewEvidence
          if (gateReviewDeliverables !== undefined) gates.review.requireDeliverables = gateReviewDeliverables
        }
        const hasGates = Object.keys(gates).length > 0
        await store.init()
        if (findProject(store.snapshot(), projectId) === undefined) throw new Error(messageFor('unknown_project'))
        if (mode !== undefined || rootDir !== undefined || hasRules || requiredLayers !== undefined || hasGates) {
          const op = { type: 'project.setAcceptance', projectId }
          if (mode !== undefined) op.mode = mode
          if (rootDir !== undefined) op.rootDir = rootDir
          if (hasRules) op.rules = rules
          if (requiredLayers !== undefined) op.requiredLayers = requiredLayers
          if (hasGates) op.gates = gates
          await apply(op)
        }
        const project = findProject(store.snapshot(), projectId)
        return {
          mode: project.acceptanceMode,
          requireEvidence: project.acceptanceRules.requireEvidence,
          requireDeliverables: project.acceptanceRules.requireDeliverables,
          verifyDeliverables: project.acceptanceRules.verifyDeliverables,
          requireSession: project.acceptanceRules.requireSession,
          requireVerifiedClaim: project.acceptanceRules.requireVerifiedClaim,
          requiredLayers: project.requiredLayers,
          rootDir: project.rootDir,
        }
      },
    },
    {
      name: 'greenlight_memory_add',
      description: 'Append one entry to a project memory. Every subtask of that project shares these entries; optionally link the entry to one subtask.',
      parameters: {
        type: 'object',
        required: ['projectId', 'text'],
        additionalProperties: false,
        properties: {
          projectId: { type: 'string' },
          text: { type: 'string' },
          taskId: { type: 'string', description: 'Optional subtask to link this entry to' },
        },
      },
      output: {
        schema: {
          type: 'object',
          required: ['memoryId'],
          additionalProperties: false,
          properties: { memoryId: { type: 'string' } },
        },
        render: (_args, value) => [{ type: 'text', text: '已记录项目记忆 ' + value.memoryId }],
      },
      async execute(args) {
        const projectId = requireString(args, 'projectId')
        const text = requireString(args, 'text')
        const taskId = optionalString(args, 'taskId')
        await store.init()
        if (findProject(store.snapshot(), projectId) === undefined) throw new Error(messageFor('unknown_project'))
        const memoryId = 'm' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8)
        const op = { type: 'memory.add', projectId, id: memoryId, text }
        if (taskId !== undefined) op.taskId = taskId
        await apply(op)
        return { memoryId }
      },
    },
    {
      name: 'greenlight_session_attach',
      description: 'Bind a subtask to the Session that carries its work, or clear the binding with an empty sessionId.',
      parameters: {
        type: 'object',
        required: ['projectId', 'taskId', 'sessionId'],
        additionalProperties: false,
        properties: {
          projectId: { type: 'string' },
          taskId: { type: 'string' },
          sessionId: { type: 'string', description: 'Session id, or an empty string to clear' },
        },
      },
      output: {
        schema: {
          type: 'object',
          required: ['taskId', 'sessionId'],
          additionalProperties: false,
          properties: { taskId: { type: 'string' }, sessionId: { type: 'string' } },
        },
        render: (_args, value) => [{
          type: 'text',
          text: value.sessionId === ''
            ? '已解除子任务 ' + value.taskId + ' 的会话绑定'
            : '已把子任务 ' + value.taskId + ' 绑定到会话 ' + value.sessionId,
        }],
      },
      async execute(args) {
        const projectId = requireString(args, 'projectId')
        const taskId = requireString(args, 'taskId')
        const sessionId = optionalString(args, 'sessionId')
        if (sessionId === undefined) throw new Error('参数 sessionId 必须是字符串')
        await store.init()
        await apply({ type: 'task.patch', projectId, taskId, patch: { sessionId } })
        return { taskId, sessionId }
      },
    },
    {
      name: 'greenlight_reference',
      description: 'Manage the references of one project: a single list holding three kinds. "link" is a path or URL — the Host re-checks it on every sweep, so a target that cannot be found is marked stale, and a card may point at it through refs. "note" is convention text for the project: it is never re-checked and never goes stale. "other" is anything that fits neither (an external system, a verbal agreement): free text, also never re-checked. Actions: list, add, update, remove.',
      parameters: {
        type: 'object',
        required: ['projectId', 'action'],
        additionalProperties: false,
        properties: {
          projectId: { type: 'string' },
          action: { type: 'string', enum: ['list', 'add', 'update', 'remove'] },
          id: { type: 'string', description: 'Reference id: required for update and remove, optional for add' },
          kind: { type: 'string', enum: ['link', 'note', 'other'], description: 'Required when adding: link is re-checked, note and other are never' },
          name: { type: 'string', description: 'Display name; required when adding' },
          value: { type: 'string', description: 'link: a path or URL; note: the convention text' },
          description: { type: 'string' },
        },
      },
      output: {
        schema: {
          type: 'object',
          required: ['action', 'references'],
          additionalProperties: false,
          properties: {
            action: { type: 'string' },
            references: { type: 'array', items: { type: 'object', additionalProperties: true } },
            id: { type: 'string' },
            removed: { type: 'boolean' },
          },
        },
        render: (_args, value) => [{
          type: 'text',
          text: value.action === 'list'
            ? (value.references.length === 0
              ? '该项目没有资料条目。'
              : '项目资料（' + value.references.length + '）：\n' + renderReferences(value.references))
            : (value.action === 'add' ? '已添加资料 ' : value.action === 'update' ? '已更新资料 ' : '已删除资料 ') + value.id,
        }],
      },
      async execute(args) {
        const projectId = requireString(args, 'projectId')
        const action = requireString(args, 'action')
        await store.init()
        const project = findProject(store.snapshot(), projectId)
        if (project === undefined) throw new Error(messageFor('unknown_project'))

        if (action === 'list') return { action, references: project.references.slice() }
        if (action === 'add') {
          const kind = optionalString(args, 'kind')
          if (kind === undefined) throw new Error('add 需要 kind（link / note / other）')
          if (kind !== 'link' && kind !== 'note' && kind !== 'other') throw new Error('kind 只能是 link / note / other')
          const name = requireString(args, 'name')
          const value = optionalString(args, 'value')
          if (kind === 'link' && (value === undefined || value.trim() === '')) {
            throw new Error('link 需要非空的 value（路径或 URL）')
          }
          const description = optionalString(args, 'description')
          const given = optionalString(args, 'id')
          const id = given === undefined || given === '' ? createId('ref-') : given
          const op = { type: 'reference.add', projectId, id, kind, name, value: value === undefined ? '' : value }
          if (description !== undefined) op.description = description
          await apply(op)
          return { action, id, references: findProject(store.snapshot(), projectId).references }
        }
        if (action === 'update') {
          const id = requireString(args, 'id')
          const patch = {}
          const kind = optionalString(args, 'kind')
          const name = optionalString(args, 'name')
          const value = optionalString(args, 'value')
          const description = optionalString(args, 'description')
          if (kind !== undefined) patch.kind = kind
          if (name !== undefined) patch.name = name
          if (value !== undefined) patch.value = value
          if (description !== undefined) patch.description = description
          if (Object.keys(patch).length === 0) throw new Error('至少要给出一个要修改的字段')
          await apply({ type: 'reference.update', projectId, referenceId: id, patch })
          return { action, id, references: findProject(store.snapshot(), projectId).references }
        }
        if (action === 'remove') {
          const id = requireString(args, 'id')
          await apply({ type: 'reference.remove', projectId, referenceId: id })
          return { action, id, references: findProject(store.snapshot(), projectId).references, removed: true }
        }
        throw new Error('action 只能是 list / add / update / remove')
      },
    },
    {
      name: 'greenlight_trash',
      description: 'Inspect or restore removed subtasks of one project. Removed cards stay restorable for seven days.',
      parameters: {
        type: 'object',
        required: ['projectId', 'action'],
        additionalProperties: false,
        properties: {
          projectId: { type: 'string' },
          action: { type: 'string', enum: ['list', 'restore'] },
          taskId: { type: 'string', description: 'Required for restore' },
        },
      },
      output: {
        schema: {
          type: 'object',
          required: ['entries'],
          additionalProperties: false,
          properties: {
            entries: { type: 'array', items: { type: 'object', additionalProperties: true } },
            restored: { type: 'boolean' },
          },
        },
        render: (_args, value) => [{
          type: 'text',
          text: value.entries.length === 0
            ? '回收站是空的。'
            : '回收站（' + value.entries.length + '）：\n' + value.entries.map(entry =>
              '- ' + entry.title + ' [' + entry.taskId + ']（' + entry.status + '）').join('\n'),
        }],
      },
      async execute(args) {
        const projectId = requireString(args, 'projectId')
        const action = requireString(args, 'action')
        await store.init()
        const project = findProject(store.snapshot(), projectId)
        if (project === undefined) throw new Error(messageFor('unknown_project'))

        if (action === 'list') {
          return { entries: project.trash.map(record => ({ taskId: record.task.id, title: record.task.title, status: record.task.status, deletedAt: record.deletedAt })) }
        }
        if (action === 'restore') {
          const taskId = requireString(args, 'taskId')
          await apply({ type: 'task.restore', projectId, taskId })
          const after = findProject(store.snapshot(), projectId)
          return { entries: after.trash.map(record => ({ taskId: record.task.id, title: record.task.title, status: record.task.status, deletedAt: record.deletedAt })), restored: true }
        }
        throw new Error('action 只能是 list / restore')
      },
    },
  ]
}