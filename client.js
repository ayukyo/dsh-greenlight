/**
 * Greenlight board — browser half.
 *
 * The left sidebar entry and the page it opens are separate registrations:
 * `sidebar.panellist` supplies the icon inside the sidebar's own row button
 * (the shell owns that button, its label, and its selected state), and `main`
 * keyed by the same id supplies the page. `ctx.layout.selectPanel(null)` — the
 * page's Back control — returns to the Conversation, and the sidebar's session
 * list stays reachable the whole time.
 *
 * Data model: projects, each holding subtasks and a shared memory log. A
 * subtask starts from a description and gets a title derived from it (the
 * title stays editable, and once the subtask owns a Session the Session's own
 * title can name it instead). Every subtask carries a completion percentage
 * and a blocked flag; a project's completion is the average of its subtasks
 * and its color follows that average (green / yellow / red), with any blocked
 * subtask forcing red. Memory entries belong to the project — subtasks of one
 * project share that context — and an entry may name the subtask it came from.
 *
 * A subtask can own one real Session: creating it goes through
 * `ctx.sessions.create`, opening it goes through `ctx.uiWorkspace.openSession`,
 * and its title plus running state are read from the Session list. The board's
 * own document stays in this browser's local storage and is never read from a
 * Session, a Host service, or a model request.
 */

window.__ModuleLoader__.load({
  id: 'dsh-greenlight',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    /** Client locale namespace owned by this plugin. */
    const NS = 'greenlight'
    /** Package identity: prefixes the slot ids this plugin owns. */
    const PACKAGE_NAME = 'dsh-greenlight'
    /** Shared by the sidebar entry and the main page it opens; package-prefixed like the Loader row. */
    const PANEL_ID = PACKAGE_NAME + ':board'
    /** Local storage key of the board document (kept across versions so it migrates in place). */
    const STORAGE_KEY = 'dsh.greenlight.v1'
    /** Document version written back to storage; it mirrors the Host document shape. */
    const DOC_VERSION = 10
    /** Subtask priorities, low to high. */
    const PRIORITIES = ['low', 'normal', 'high', 'urgent']
    /** How long a removed card stays restorable (mirrors the Host rule). */
    const TRASH_KEEP_MS = 7 * 24 * 60 * 60 * 1000
    /** Interval of the opt-in auto dispatcher. */
    const AUTO_DISPATCH_MS = 20000
    /** Local key remembering whether auto dispatch is on. */
    const AUTO_DISPATCH_KEY = 'dsh.greenlight.autoDispatch'
    /** Host route that returns the authoritative board. */
    /** Verification layers, coarsest to strictest; mirrors the Host vocabulary. */
    const LAYERS = ['static', 'unit', 'build', 'host', 'physical']

    /** Host route that serves the current board document. */
    const HOST_STATE_PATH = '/greenlight/state'
    /** Host route that applies queued operations. */
    /** Host route that serves cold-stored cards. */
    const HOST_ARCHIVE_PATH = '/greenlight/archive'

    /** Host route that applies queued operations. */
    const HOST_OPS_PATH = '/greenlight/ops'
    /** Header the Host requires on writes; a cross-origin page cannot set it silently. */
    const HOST_GUARD_HEADER = 'x-greenlight'
    /** Operations merged into one pending write instead of queueing behind it. */
    const COALESCED_OPS = ['task.patch', 'project.rename', 'reference.update']
    /** Wait before a queued batch is sent, so a typing burst costs one request. */
    const FLUSH_DELAY_MS = 140
    /** Retry delays after a transport failure, in milliseconds. */
    const RETRY_DELAYS_MS = [1000, 2000, 4000, 8000, 15000]
    /** How often this surface checks the Host document without a live stream. */
    const POLL_INTERVAL_MS = 4000
    /** Host route that streams revision notifications. */
    const HOST_EVENTS_PATH = '/greenlight/events'
    /** Poll interval while a live event stream is connected. */
    const SSE_FALLBACK_POLL_MS = 15000
    /** How long a deleted card can be restored. */
    const UNDO_WINDOW_MS = 8000
    /** Subtask columns, in board order. */
    const STATUS_ORDER = ['backlog', 'todo', 'running', 'review', 'done', 'failed']
    /** Columns a card flows through when advanced; `failed` is a resting column. */
    const ADVANCE_PATH = ['backlog', 'todo', 'running', 'review', 'done']
    /** Longest title derived from a description. */
    const MAX_DERIVED_TITLE = 30
    /** How many Sessions the "link an existing Session" menu lists. */
    const SESSION_OPTION_LIMIT = 60

    const zh = {
      'panel.label': '绿灯看板',
      'page.title': '绿灯看板',
      'page.subtitle': '按项目拆任务，每个子任务可绑定一个主会话。能核对的自动通过（绿灯），核不了的才转人工（黄灯）；项目内资料与记忆。',
      'page.back': '返回对话',
      'sync.connecting': '连接中…',
      'sync.synced': '已同步',
      'sync.pending': '同步中…',
      'sync.offline': '离线，稍后重试',
      'sync.local': '本地模式',
      'sync.conflict': '有改动未同步',
      'sync.conflictHint': '%s 条改动与 Host 冲突，未写入',
      'sync.retry': '重试',
      'sync.discard': '丢弃并采用 Host 版本',
      'sync.recovered': '检测到损坏的看板文件：已另存备份，并以空看板启动',
      'task.dispatchBadWorkspace': '绑定的工作区已不存在，未发送提示词',
      'rail.title': '项目',
      'rail.collapse': '收起项目栏',
      'rail.expand': '展开项目栏',
      'rail.countUnit': '个子任务',
      'rail.empty': '还没有项目，先在下面新建一个。',
      'rail.new': '新建项目',
      'rail.create': '创建',
      'rail.missingName': '请先填写项目名称',
      'detail.empty': '左侧还没有项目。先在左侧新建一个项目，再往里添加子任务。',
      'detail.name': '项目名称',
      'detail.untitled': '未命名项目',
      'detail.progress': '完成度',
      'detail.deleteProject': '删除项目',
      'detail.deleteProjectConfirm': '删除项目「%s」？\n\n该项目下的子任务和项目记忆都会一起删除。',
      'references.section': '项目资料',
      'references.hint': '链接会被复查、可被卡片引用；约定只作为项目说明文本',
      'references.kind': '类型',
      'references.kindNote': '约定',
      'references.kindLink': '链接',
      'references.name': '名称',
      'references.linkValue': '路径或链接',
      'references.noteValue': '约定内容',
      'references.description': '说明（可选）',
      'references.add': '添加资料',
      'references.empty': '还没有项目资料',
      'references.delete': '删除资料',
      'references.edit': '编辑资料',
      'references.save': '保存',
      'references.cancel': '取消',
      'tone.red': '异常',
      'tone.yellow': '推进中',
      'tone.green': '顺利',
      'tone.idle': '未开始',
      'task.section': '子任务',
      'task.sectionHint': '每个子任务可以拥有一个主会话',
      'task.describe': '任务描述（自动生成标题）',
      'task.add': '添加子任务',
      'task.empty': '这个项目还没有子任务。',
      'task.title': '子任务标题',
      'task.untitled': '未命名子任务',
      'task.note': '任务说明（可选）',
      'task.blocked': '阻塞',
      'task.delete': '删除子任务',
      'task.linkedMemory': '条记忆',
      'task.done': '已完成',
      'status.backlog': '待规划',
      'status.todo': '待办',
      'status.running': '进行中',
      'status.review': '待验收',
      'status.done': '已完成',
      'status.failed': '已失败',
      'column.empty': '空',
      'task.advance': '推进到下一列',
      'task.confirmReview': '通过',
      'task.acceptedAuto': '自动通过',
      'task.acceptedHuman': '人工通过',
      'task.acceptanceBlocked': '自动验收未通过',
      'project.acceptance': '验收方式',
      'project.acceptanceAuto': '自动验收',
      'project.acceptanceHuman': '人工验收',
      'project.acceptanceAutoHint': '能核对的自动通过，核对不了才转人工',
      'project.acceptanceHumanHint': '所有完成都需人工点「通过」',
      'rules.title': '自动验收规则',
      'rules.requireEvidence': '需要完成说明',
      'rules.requireDeliverables': '需要交付物',
      'rules.verifyDeliverables': '校验交付物文件',
      'rules.requireSession': '需要绑定会话',
      'rules.rootDir': '项目根目录',
      'rules.rootDirHint': '相对交付物按此目录查找，留空则无法校验相对路径',
      'rules.missing': '交付物缺失',
      'task.deliverables': '交付物',
      'task.evidence': '完成说明',
      'task.next': '下一步',
      'task.nextPlaceholder': '下一步做什么',
      'task.claims': '验证项',
      'task.claimAdd': '记录验证',
      'task.claimOutcome': '结论',
      'task.claimPass': '通过',
      'task.claimFail': '失败',
      'task.claimUnverified': '未验证',
      'task.claimSubmit': '加入',
      'task.archive': '归档',
      'archive.title': '归档区',
      'archive.empty': '还没有归档的卡片',
      'archive.restore': '恢复',
      'archive.count': '张',
      'task.claimWhat': '验证了什么',
      'task.claimHow': '怎么验证的',
      'task.claimLayer': '层级',
      'task.debt': '验证债',
      'task.layer.static': '静态',
      'task.layer.unit': '单测',
      'task.layer.build': '构建',
      'task.layer.host': '本机',
      'task.layer.physical': '真机',
      'task.events': '轨迹',
      'task.staleRef': '已失效',
      'anchor.title': '决策锚点',
      'anchor.digest': '需求摘要',
      'anchor.decisions': '关键决策',
      'anchor.risks': '未解决风险',
      'board.recheck': '复查引用',
      'task.rejectReview': '打回',
      'task.rejectReason': '打回原因（必填）',
      'task.rejectSubmit': '确认打回',
      'task.rejectCancel': '取消',
      'task.reopen': '重新打开',
      'task.dispatch': '派给会话',
      'task.dispatching': '派发中…',
      'task.dispatchCost': '会向该会话发送一条提示词，消耗对应额度',
      'task.dispatchNoSession': '先绑定一个主会话才能派活',
      'task.dispatchFailed': '派活失败',
      'task.dispatchDone': '已派发',
      'task.reviewHint': '执行方不能自己结账：需要人点通过才完成',
      'undo.deleted': '已删除「%s」',
      'confirm.cancel': '取消',
      'confirm.delete': '删除',
      'confirm.archive': '归档',
      'confirm.purge': '清空',
      'confirm.deleteProject': '删除项目「%s」？',
      'confirm.deleteProjectBody': '项目下的子任务、项目记忆和项目资料会一起删除，无法撤销。',
      'confirm.projectTasks': '子任务：%s 个',
      'confirm.projectMemory': '项目记忆：%s 条',
      'confirm.deleteTask': '删除子任务「%s」？',
      'confirm.deleteTaskBody': '删除后会进入回收站，可以恢复。',
      'confirm.deleteMemory': '删除这条项目记忆？',
      'confirm.deleteRef': '删除引用资料「%s」？',
      'confirm.deleteRefBody': '引用该资料的子任务会同时解除关联。',
      'confirm.purgeTrash': '清空回收站？',
      'confirm.purgeTrashBody': '回收站里的子任务会被永久删除，无法恢复。',
      'confirm.import': '导入会覆盖当前看板？',
      'confirm.importBody': '当前看板上的所有项目和子任务会被导入文件替换。建议先导出备份。',
      'confirm.importCount': '导入后将包含：%s 个项目',
      'confirm.importAction': '覆盖导入',
      'confirm.archiveTask': '把「%s」移入归档？',
      'confirm.archiveTaskBody': '归档的卡片会离开看板，之后可以在底部归档区恢复。',
      'confirm.discard': '丢弃未同步的改动？',
      'confirm.discardBody': '这些改动还没有写入 Host，丢弃后无法找回。',
      'confirm.discardAction': '丢弃',
      'task.archiveHint': '移入归档区，可随时恢复',
      'trash.hintCount': '%s 张卡片在这里，可以恢复。',
      'task.nextLabelHint': '下一步',
      'undo.action': '撤销',
      'undo.hint': '撤销后卡片回到原列',
      'task.priority': '优先级',
      'priority.low': '低',
      'priority.normal': '普通',
      'priority.high': '高',
      'priority.urgent': '紧急',
      'task.due': '截止',
      'task.overdue': '逾期',
      'task.back': '退回上一列',
      'filter.search': '搜索任务…',
      'filter.all': '全部',
      'filter.overdue': '只看逾期',
      'filter.blocked': '只看阻塞',
      'filter.clear': '清除筛选',
      'filter.result': '筛选后 %s 项',
      'filter.none': '没有符合条件的任务',
      'task.tags': '标签',
      'task.tagsPlaceholder': '用逗号分隔',
      'task.refs': '引用资料',
      'trash.section': '回收站',
      'trash.hint': '删除的卡片保留 7 天，可恢复',
      'trash.empty': '回收站是空的',
      'trash.restore': '恢复',
      'trash.purge': '清空回收站',
      'export.action': '导出',
      'import.action': '导入',
      'import.confirm': '导入会替换当前看板，确定吗？',
      'import.failed': '导入失败：文件不是有效的看板数据',
      'auto.toggle': '自动派发',
      'auto.hint': '每隔 20 秒把「待办」且已绑定会话的卡片派出去',
      'task.session': '主会话',
      'task.sessionNone': '尚未绑定主会话',
      'task.createSession': '新建主会话',
      'task.creatingSession': '创建中…',
      'task.linkSession': '关联已有会话',
      'task.noSessions': '暂无可关联的会话',
      'task.openSession': '打开会话',
      'task.unbindSession': '解除关联',
      'task.syncSessionTitle': '用会话标题命名',
      'task.running': '运行中',
      'task.idle': '空闲',
      'task.createSessionFailed': '创建主会话失败',
      'memory.section': '项目记忆',
      'memory.hint': '同一项目的子任务共享这段上下文；条目可关联到某个子任务。',
      'memory.placeholder': '记录约定、结论、待确认点…',
      'memory.link': '关联子任务',
      'memory.noLink': '不关联子任务',
      'memory.add': '记录',
      'memory.empty': '还没有记忆条目。',
      'memory.delete': '删除记忆',
      'memory.edit': '点击编辑',
      'memory.save': '保存',
    }

    const en = {
      'panel.label': 'Greenlight Board',
      'page.title': 'Greenlight Board',
      'page.subtitle': 'Work splits into projects and subtasks, each subtask can own a main Session. What can be checked closes itself on a green light; what cannot asks a human. Projects share references and memory.',
      'page.back': 'Back to conversation',
      'sync.connecting': 'Connecting…',
      'sync.synced': 'Synced',
      'sync.pending': 'Syncing…',
      'sync.offline': 'Offline, retrying',
      'sync.local': 'Local only',
      'sync.conflict': 'Unsynced changes',
      'sync.conflictHint': '%s changes conflict with the Host and were not written',
      'sync.retry': 'Retry',
      'sync.discard': 'Discard and take the Host version',
      'sync.recovered': 'The board file could not be read: it was set aside as a backup and the board started empty',
      'task.dispatchBadWorkspace': 'The pinned workspace no longer exists; nothing was sent',
      'rail.title': 'Projects',
      'rail.collapse': 'Collapse the project rail',
      'rail.expand': 'Expand the project rail',
      'rail.countUnit': 'subtasks',
      'rail.empty': 'No projects yet. Create one below.',
      'rail.new': 'New project',
      'rail.create': 'Create',
      'rail.missingName': 'Enter a project name first',
      'detail.empty': 'No projects yet. Create one on the left, then add subtasks to it.',
      'detail.name': 'Project name',
      'detail.untitled': 'Untitled project',
      'detail.progress': 'Completion',
      'detail.deleteProject': 'Delete project',
      'detail.deleteProjectConfirm': 'Delete the project "%s"?\n\nIts subtasks and project memory are deleted with it.',
      'references.section': 'Project references',
      'references.hint': 'Links are rechecked and cards can point at them; notes stay as project conventions',
      'references.kind': 'Type',
      'references.kindNote': 'Convention',
      'references.kindLink': 'Link',
      'references.name': 'Name',
      'references.linkValue': 'Path or link',
      'references.noteValue': 'Convention text',
      'references.description': 'Description (optional)',
      'references.add': 'Add reference',
      'references.empty': 'No project references yet',
      'references.delete': 'Delete reference',
      'references.edit': 'Edit reference',
      'references.save': 'Save',
      'references.cancel': 'Cancel',
      'tone.red': 'At risk',
      'tone.yellow': 'In progress',
      'tone.green': 'On track',
      'tone.idle': 'Not started',
      'task.section': 'Subtasks',
      'task.sectionHint': 'each subtask can own one main Session',
      'task.describe': 'Describe the task (title is derived)',
      'task.add': 'Add subtask',
      'task.empty': 'This project has no subtasks yet.',
      'task.title': 'Subtask title',
      'task.untitled': 'Untitled subtask',
      'task.note': 'Task description (optional)',
      'task.blocked': 'Blocked',
      'task.delete': 'Delete subtask',
      'task.linkedMemory': 'memory entries',
      'task.done': 'Done',
      'status.backlog': 'Backlog',
      'status.todo': 'To do',
      'status.running': 'In progress',
      'status.review': 'In review',
      'status.done': 'Done',
      'status.failed': 'Failed',
      'column.empty': 'Empty',
      'task.advance': 'Move to the next column',
      'task.confirmReview': 'Accept',
      'task.acceptedAuto': 'Auto-accepted',
      'task.acceptedHuman': 'Accepted by you',
      'task.acceptanceBlocked': 'Automatic acceptance failed',
      'project.acceptance': 'Acceptance',
      'project.acceptanceAuto': 'Automatic',
      'project.acceptanceHuman': 'Manual',
      'project.acceptanceAutoHint': 'Verifiable work closes itself; the rest comes to you',
      'project.acceptanceHumanHint': 'Every completion needs your approval',
      'rules.title': 'Automatic acceptance rules',
      'rules.requireEvidence': 'Requires a completion note',
      'rules.requireDeliverables': 'Requires deliverables',
      'rules.verifyDeliverables': 'Verifies deliverable files',
      'rules.requireSession': 'Requires a Session',
      'rules.rootDir': 'Project root',
      'rules.rootDirHint': 'Relative deliverables resolve here; without it they cannot be checked',
      'rules.missing': 'Missing deliverables',
      'task.deliverables': 'Deliverables',
      'task.evidence': 'Completion note',
      'task.next': 'Next',
      'task.nextPlaceholder': 'What happens next',
      'task.claims': 'Checks',
      'task.claimAdd': 'Record a check',
      'task.claimOutcome': 'Outcome',
      'task.claimPass': 'pass',
      'task.claimFail': 'fail',
      'task.claimUnverified': 'unverified',
      'task.claimSubmit': 'Add',
      'task.archive': 'Archive',
      'archive.title': 'Archive',
      'archive.empty': 'Nothing archived yet',
      'archive.restore': 'Restore',
      'archive.count': 'cards',
      'task.claimWhat': 'What you checked',
      'task.claimHow': 'How you checked it',
      'task.claimLayer': 'Layer',
      'task.debt': 'Unverified',
      'task.layer.static': 'static',
      'task.layer.unit': 'unit',
      'task.layer.build': 'build',
      'task.layer.host': 'host',
      'task.layer.physical': 'device',
      'task.events': 'History',
      'task.staleRef': 'stale',
      'anchor.title': 'Decision anchor',
      'anchor.digest': 'Requirement',
      'anchor.decisions': 'Key decisions',
      'anchor.risks': 'Open risks',
      'board.recheck': 'Recheck references',
      'task.rejectReview': 'Reject',
      'task.rejectReason': 'Reason for rejection (required)',
      'task.rejectSubmit': 'Reject',
      'task.rejectCancel': 'Cancel',
      'task.reopen': 'Reopen',
      'task.dispatch': 'Dispatch to Session',
      'task.dispatching': 'Dispatching…',
      'task.dispatchCost': 'Sends one prompt to that Session and spends its quota',
      'task.dispatchNoSession': 'Bind a main Session before dispatching',
      'task.dispatchFailed': 'Dispatch failed',
      'task.dispatchDone': 'Dispatched',
      'task.reviewHint': 'The runner cannot close its own card: a human accepts it',
      'undo.deleted': 'Deleted “%s”',
      'confirm.cancel': 'Cancel',
      'confirm.delete': 'Delete',
      'confirm.archive': 'Archive',
      'confirm.purge': 'Empty',
      'confirm.deleteProject': 'Delete the project "%s"?',
      'confirm.deleteProjectBody': 'Its subtasks, project memory and references are deleted with it. This cannot be undone.',
      'confirm.projectTasks': 'Subtasks: %s',
      'confirm.projectMemory': 'Memory entries: %s',
      'confirm.deleteTask': 'Delete the subtask "%s"?',
      'confirm.deleteTaskBody': 'It moves to the trash and can be restored.',
      'confirm.deleteMemory': 'Delete this project memory entry?',
      'confirm.deleteRef': 'Delete the reference "%s"?',
      'confirm.deleteRefBody': 'Subtasks using it lose the link.',
      'confirm.purgeTrash': 'Empty the trash?',
      'confirm.purgeTrashBody': 'Trashed subtasks are deleted permanently and cannot be restored.',
      'confirm.import': 'Importing replaces the whole board?',
      'confirm.importBody': 'Every project and subtask on this board is replaced by the imported file. Export a backup first.',
      'confirm.importCount': 'The file contains %s project(s)',
      'confirm.importAction': 'Replace and import',
      'confirm.archiveTask': 'Move "%s" to the archive?',
      'confirm.archiveTaskBody': 'The card leaves the board and can be restored from the archive section later.',
      'confirm.discard': 'Discard unsynced changes?',
      'confirm.discardBody': 'These changes were never written to the Host and cannot be recovered.',
      'confirm.discardAction': 'Discard',
      'task.archiveHint': 'Move to the archive; it can be restored',
      'trash.hintCount': '%s card(s) held here, restorable.',
      'task.nextLabelHint': 'Next',
      'undo.action': 'Undo',
      'undo.hint': 'Undo puts the card back in its column',
      'task.priority': 'Priority',
      'priority.low': 'Low',
      'priority.normal': 'Normal',
      'priority.high': 'High',
      'priority.urgent': 'Urgent',
      'task.due': 'Due',
      'task.overdue': 'Overdue',
      'task.back': 'Move back a column',
      'filter.search': 'Search subtasks…',
      'filter.all': 'All',
      'filter.overdue': 'Overdue only',
      'filter.blocked': 'Blocked only',
      'filter.clear': 'Clear filters',
      'filter.result': '%s matching',
      'filter.none': 'No subtask matches',
      'task.tags': 'Tags',
      'task.tagsPlaceholder': 'comma separated',
      'task.refs': 'References',
      'trash.section': 'Trash',
      'trash.hint': 'Removed cards stay restorable for 7 days',
      'trash.empty': 'Trash is empty',
      'trash.restore': 'Restore',
      'trash.purge': 'Empty trash',
      'export.action': 'Export',
      'import.action': 'Import',
      'import.confirm': 'Importing replaces the current board. Continue?',
      'import.failed': 'Import failed: the file is not a valid board document',
      'auto.toggle': 'Auto dispatch',
      'auto.hint': 'Every 20s, dispatches todo cards that already own a Session',
      'task.session': 'Main Session',
      'task.sessionNone': 'No main Session yet',
      'task.createSession': 'New main Session',
      'task.creatingSession': 'Creating…',
      'task.linkSession': 'Link an existing Session',
      'task.noSessions': 'No Session to link',
      'task.openSession': 'Open Session',
      'task.unbindSession': 'Unlink',
      'task.syncSessionTitle': 'Use the Session title',
      'task.running': 'Running',
      'task.idle': 'Idle',
      'task.createSessionFailed': 'Creating the main Session failed',
      'memory.section': 'Project memory',
      'memory.hint': 'Subtasks in this project share this context; an entry can be linked to one subtask.',
      'memory.placeholder': 'Record an agreement, a conclusion, an open question…',
      'memory.link': 'Link subtask',
      'memory.noLink': 'No linked subtask',
      'memory.add': 'Record',
      'memory.empty': 'No memory entries yet.',
      'memory.delete': 'Delete memory entry',
      'memory.edit': 'Click to edit',
      'memory.save': 'Save',
    }

    /*
     * Page styles, rendered inside the page component so unmounting removes
     * them. Only `--dsw-*` theme tokens carry color, so the board follows the
     * host's light and dark palettes; sizes and spacing are the host's scale.
     */
    const CSS = `
.dsh-board {
  display: flex;
  flex-direction: column;
  flex: 1 1 auto;
  box-sizing: border-box;
  height: 100%;
  min-height: 0;
  background: var(--dsw-alias-bg-base);
  color: var(--dsw-alias-label-primary);
  font-family: inherit;
}
.dsh-board *,
.dsh-board *::before,
.dsh-board *::after {
  box-sizing: border-box;
}
.dsh-board__head {
  flex: none;
  padding: calc(var(--dsh-frame-top-clearance, 0px) + 24px) 32px 14px;
  border-bottom: 0.5px solid var(--dsw-alias-border-l1);
}
.dsh-board__headInner,
.dsh-board__body {
  width: 100%;
  max-width: 1240px;
  margin: 0 auto;
}
.dsh-board__headInner {
  display: flex;
  flex-direction: column;
  gap: 6px;
  min-width: 0;
}
.dsh-board__titleRow {
  display: flex;
  align-items: center;
  gap: 10px;
  min-width: 0;
}
.dsh-board__mark {
  display: inline-flex;
  flex: none;
  color: var(--dsw-alias-label-secondary);
}
.dsh-board__title {
  margin: 0;
  min-width: 0;
  font-size: 17px;
  line-height: 24px;
  font-weight: 600;
}
.dsh-board__back {
  flex: none;
  margin-left: auto;
  height: 28px;
  padding: 0 10px;
  border: 0.5px solid var(--dsw-alias-border-l3);
  border-radius: 8px;
  background: transparent;
  color: var(--dsw-alias-label-secondary);
  font: inherit;
  font-size: 12px;
  line-height: 18px;
  cursor: pointer;
}
.dsh-board__subtitle {
  margin: 0;
  font-size: 12px;
  line-height: 18px;
  color: var(--dsw-alias-label-tertiary);
}
.dsh-board__body {
  display: flex;
  flex: 1 1 auto;
  min-height: 0;
}
.dsh-board__rail {
  display: flex;
  flex: none;
  flex-direction: column;
  gap: 8px;
  width: 244px;
  min-height: 0;
  padding: 14px 12px 18px 32px;
  border-right: 0.5px solid var(--dsw-alias-border-l1);
}
.dsh-board__railHead {
  display: flex;
  align-items: baseline;
  gap: 8px;
  padding: 0 2px;
}
/* One control, one place: the rail toggle lives in the header and never moves. */
.dsh-board__railToggle {
  flex: none;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 26px;
  height: 26px;
  padding: 0;
  margin-right: 2px;
  border: 0.5px solid transparent;
  border-radius: 7px;
  background: transparent;
  color: var(--dsw-alias-label-tertiary);
  font: inherit;
  cursor: pointer;
}
.dsh-board__railToggle:hover {
  border-color: var(--dsw-alias-border-l2);
  background: var(--dsw-alias-interactive-bg-hover);
  color: var(--dsw-alias-label-primary);
}
.dsh-board__railToggle[aria-expanded='true'] {
  color: var(--dsw-alias-label-secondary);
}
.dsh-board__railTitle {
  font-size: 12px;
  line-height: 18px;
  font-weight: 600;
  color: var(--dsw-alias-label-secondary);
}
.dsh-board__railCount {
  font-size: 11px;
  line-height: 18px;
  color: var(--dsw-alias-label-tertiary);
  font-variant-numeric: tabular-nums;
}
.dsh-board__railList {
  display: flex;
  flex: 1 1 auto;
  flex-direction: column;
  gap: 2px;
  min-height: 0;
  overflow-y: auto;
}
.dsh-board__project {
  display: flex;
  flex-direction: column;
  gap: 2px;
  width: 100%;
  padding: 8px 10px;
  border: 0;
  border-radius: 9px;
  background: transparent;
  color: inherit;
  font: inherit;
  text-align: left;
  cursor: pointer;
}
.dsh-board__project[data-active='true'] {
  background: var(--dsw-alias-interactive-bg-hover);
}
.dsh-board__projectTop {
  display: flex;
  align-items: center;
  gap: 7px;
  min-width: 0;
}
.dsh-board__projectName {
  flex: 1 1 auto;
  min-width: 0;
  font-size: 13px;
  line-height: 18px;
  color: var(--dsw-alias-label-primary);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.dsh-board__projectMeta {
  padding-left: 14px;
  font-size: 11px;
  line-height: 16px;
  color: var(--dsw-alias-label-tertiary);
  font-variant-numeric: tabular-nums;
}
.dsh-board__dot {
  flex: none;
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: var(--dsw-alias-label-tertiary);
}
.dsh-board__dot[data-tone='red'] {
  background: var(--dsw-alias-state-error-primary);
}
.dsh-board__dot[data-tone='yellow'] {
  background: var(--dsw-alias-state-warn-primary);
}
.dsh-board__dot[data-tone='green'] {
  background: var(--dsw-alias-state-success-primary);
}
.dsh-board__railForm {
  display: flex;
  gap: 6px;
}
.dsh-board__railInput {
  flex: 1 1 auto;
  min-width: 0;
  height: 30px;
  padding: 0 8px;
  border: 0.5px solid var(--dsw-alias-border-l3);
  border-radius: 8px;
  background: var(--dsw-specific-input-major);
  color: inherit;
  font: inherit;
  font-size: 12px;
}
.dsh-board__railInput::placeholder,
.dsh-board__input::placeholder,
.dsh-board__taskNote::placeholder {
  color: var(--dsw-alias-label-tertiary);
}
.dsh-board__railGrow {
  flex: none;
  width: 30px;
  height: 30px;
  padding: 0;
  border: 0.5px solid var(--dsw-alias-border-l3);
  border-radius: 8px;
  background: transparent;
  color: var(--dsw-alias-label-secondary);
  font: inherit;
  font-size: 15px;
  line-height: 1;
  cursor: pointer;
}
.dsh-board__detail {
  display: flex;
  flex: 1 1 auto;
  flex-direction: column;
  gap: 18px;
  min-width: 0;
  min-height: 0;
  padding: 16px 32px 48px 24px;
  overflow-y: auto;
}
.dsh-board__projectTitleRow {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
  margin-left: -6px;
}
.dsh-board__projectTitle {
  flex: 1 1 auto;
  min-width: 0;
  height: 34px;
  padding: 0 6px;
  border: 0.5px solid transparent;
  border-radius: 8px;
  background: transparent;
  color: inherit;
  font: inherit;
  font-size: 16px;
  line-height: 22px;
  font-weight: 600;
}
.dsh-board__progressRow {
  display: flex;
  align-items: center;
  gap: 10px;
}
.dsh-board__bar {
  flex: 1 1 auto;
  height: 6px;
  min-width: 0;
  border-radius: 999px;
  background: var(--dsw-alias-interactive-bg-hover);
  overflow: hidden;
}
.dsh-board__barFill {
  display: block;
  height: 100%;
  border-radius: 999px;
  background: var(--dsw-alias-state-warn-primary);
  transition: width 120ms ease;
}
.dsh-board__bar[data-tone='red'] .dsh-board__barFill {
  background: var(--dsw-alias-state-error-primary);
}
.dsh-board__bar[data-tone='green'] .dsh-board__barFill {
  background: var(--dsw-alias-state-success-primary);
}
.dsh-board__bar[data-tone='idle'] .dsh-board__barFill {
  background: var(--dsw-alias-label-tertiary);
}
.dsh-board__percent {
  flex: none;
  min-width: 38px;
  font-size: 12px;
  line-height: 18px;
  text-align: right;
  color: var(--dsw-alias-label-secondary);
  font-variant-numeric: tabular-nums;
}
.dsh-board__pill {
  flex: none;
  padding: 1px 9px;
  border-radius: 999px;
  background: var(--dsw-alias-interactive-bg-hover);
  color: var(--dsw-alias-label-secondary);
  font-size: 11px;
  line-height: 16px;
  white-space: nowrap;
}
.dsh-board__pill[data-tone='red'] {
  color: var(--dsw-alias-state-error-primary);
}
.dsh-board__pill[data-tone='yellow'] {
  color: var(--dsw-alias-state-warn-primary);
}
.dsh-board__pill[data-tone='green'] {
  color: var(--dsw-alias-state-success-primary);
}
.dsh-board__section {
  display: flex;
  flex-direction: column;
  gap: 10px;
  min-width: 0;
}
.dsh-board__sectionHead {
  display: flex;
  align-items: baseline;
  gap: 8px;
  min-width: 0;
}
.dsh-board__sectionTitle {
  font-size: 13px;
  line-height: 20px;
  font-weight: 600;
  color: var(--dsw-alias-label-primary);
}
.dsh-board__sectionHint {
  min-width: 0;
  font-size: 11px;
  line-height: 18px;
  color: var(--dsw-alias-label-tertiary);
}
.dsh-board__form {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
}
.dsh-board__input {
  flex: 1 1 200px;
  min-width: 0;
  height: 34px;
  padding: 0 10px;
  border: 0.5px solid var(--dsw-alias-border-l3);
  border-radius: 8px;
  background: var(--dsw-specific-input-major);
  color: inherit;
  font: inherit;
  font-size: 13px;
}
.dsh-board__select {
  flex: none;
  max-width: 190px;
  height: 34px;
  padding: 0 8px;
  border: 0.5px solid var(--dsw-alias-border-l3);
  border-radius: 8px;
  background: var(--dsw-specific-input-major);
  color: inherit;
  font: inherit;
  font-size: 12px;
}
.dsh-board__primary {
  flex: none;
  height: 34px;
  padding: 0 14px;
  border: 0;
  border-radius: 8px;
  background: var(--dsw-alias-button-primary-fill);
  color: var(--dsw-alias-label-primary-foreground);
  font: inherit;
  font-size: 13px;
  line-height: 20px;
  font-weight: 500;
  cursor: pointer;
}
.dsh-board__shared {
  display: block;
  width: 100%;
  min-height: 92px;
  padding: 10px 12px;
  border: 0.5px solid var(--dsw-alias-border-l3);
  border-radius: 10px;
  background: var(--dsw-specific-input-major);
  color: var(--dsw-alias-label-primary);
  font: inherit;
  font-size: 12px;
  line-height: 18px;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  resize: vertical;
}
.dsh-board__shared::placeholder {
  color: var(--dsw-alias-label-tertiary);
}
.dsh-board__tasks {
  display: flex;
  flex-direction: column;
  gap: 8px;
  min-width: 0;
}
.dsh-board__task {
  display: flex;
  flex-direction: column;
  gap: 7px;
  padding: 9px 11px;
  border: 0.5px solid var(--dsw-alias-border-l2);
  border-radius: 12px;
  background: var(--dsw-alias-card-fill);
}
.dsh-board__task[data-blocked='true'] {
  border-color: var(--dsw-alias-state-error-primary);
}
.dsh-board__task[data-done='true'] .dsh-board__taskTitle {
  color: var(--dsw-alias-label-secondary);
}
.dsh-board__taskTop {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
}
.dsh-board__taskTitle {
  flex: 1 1 auto;
  min-width: 0;
  height: 26px;
  padding: 0 6px;
  border: 0.5px solid transparent;
  border-radius: 6px;
  background: transparent;
  color: inherit;
  font: inherit;
  font-size: 13px;
}
.dsh-board__taskMeta {
  display: flex;
  align-items: center;
  gap: 12px;
  min-width: 0;
}
.dsh-board__range {
  flex: 1 1 auto;
  min-width: 0;
  height: 16px;
  accent-color: var(--dsw-alias-state-business-primary);
  cursor: pointer;
}
.dsh-board__check {
  display: inline-flex;
  flex: none;
  align-items: center;
  gap: 5px;
  color: var(--dsw-alias-label-secondary);
  font-size: 11px;
  line-height: 16px;
  white-space: nowrap;
  cursor: pointer;
}
.dsh-board__taskPercent {
  flex: none;
  min-width: 36px;
  font-size: 11px;
  line-height: 16px;
  text-align: right;
  color: var(--dsw-alias-label-secondary);
  font-variant-numeric: tabular-nums;
}
.dsh-board__taskNote {
  height: 28px;
  padding: 0 8px;
  border: 0.5px solid var(--dsw-alias-border-l2);
  border-radius: 6px;
  background: var(--dsw-specific-input-major);
  color: inherit;
  font: inherit;
  font-size: 12px;
}
.dsh-board__sessionRow {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
  min-width: 0;
  padding-top: 2px;
}
.dsh-board__sessionLabel {
  flex: none;
  font-size: 11px;
  line-height: 16px;
  color: var(--dsw-alias-label-tertiary);
}
.dsh-board__sessionTitle {
  flex: 0 1 auto;
  min-width: 0;
  max-width: 46%;
  font-size: 12px;
  line-height: 18px;
  color: var(--dsw-alias-label-primary);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.dsh-board__chip {
  flex: none;
  padding: 1px 7px;
  border-radius: 6px;
  background: var(--dsw-alias-interactive-bg-hover);
  color: var(--dsw-alias-label-secondary);
  font-size: 11px;
  line-height: 16px;
  white-space: nowrap;
}
.dsh-board__chip[data-live='true'] {
  color: var(--dsw-alias-state-success-primary);
}
.dsh-board__delete {
  display: inline-flex;
  flex: none;
  align-items: center;
  justify-content: center;
  width: 22px;
  height: 22px;
  padding: 0;
  border: 0;
  border-radius: 6px;
  background: transparent;
  color: var(--dsw-alias-label-tertiary);
  font: inherit;
  font-size: 15px;
  line-height: 1;
  cursor: pointer;
}
.dsh-board__ghost {
  flex: none;
  height: 26px;
  padding: 0 9px;
  border: 0.5px solid var(--dsw-alias-border-l3);
  border-radius: 7px;
  background: transparent;
  color: var(--dsw-alias-label-secondary);
  font: inherit;
  font-size: 11px;
  line-height: 16px;
  cursor: pointer;
}
.dsh-board__destructiveRow:hover:not(:disabled) {
  background: color-mix(in srgb, var(--dsw-alias-state-error-primary) 12%, transparent);
  color: var(--dsw-alias-state-error-primary);
}
.dsh-board__destructiveRow:disabled {
  opacity: 0.5;
  cursor: default;
}
.dsh-board__ghost.dsh-board__ghost--danger {
  color: var(--dsw-alias-state-error-primary);
  border-color: color-mix(in srgb, var(--dsw-alias-state-error-primary) 40%, transparent);
}
.dsh-board__ghost.dsh-board__ghost--danger:hover:not(:disabled) {
  background: color-mix(in srgb, var(--dsw-alias-state-error-primary) 12%, transparent);
  color: var(--dsw-alias-state-error-primary);
}
.dsh-board__nextLabel {
  flex: none;
  color: var(--dsw-alias-label-tertiary);
  white-space: nowrap;
}
.dsh-board__ghost:disabled {
  opacity: 0.5;
  cursor: default;
}
.dsh-board__ghost:hover:not(:disabled) {
  background: var(--dsw-alias-interactive-bg-hover);
  color: var(--dsw-alias-label-primary);
}
.dsh-board__primary:hover:not(:disabled) {
  filter: brightness(1.06);
}
.dsh-board__delete:hover {
  background: var(--dsw-alias-interactive-bg-hover);
  color: var(--dsw-alias-state-error-primary);
}
/* Destructive confirmation: only the dialog's accept button uses this. */
.dsh-board__danger {
  flex: none;
  height: 34px;
  padding: 0 14px;
  border: 0;
  border-radius: 8px;
  background: var(--dsw-alias-state-error-primary);
  color: #fff;
  font: inherit;
  font-size: 13px;
  line-height: 20px;
  font-weight: 500;
  cursor: pointer;
}
.dsh-board__danger:hover:not(:disabled) {
  filter: brightness(1.06);
}
.dsh-board__backdrop {
  position: fixed;
  inset: 0;
  z-index: 40;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 24px;
  background: rgba(0, 0, 0, 0.32);
}
.dsh-board__dialog {
  display: flex;
  flex-direction: column;
  gap: 10px;
  width: min(420px, 100%);
  padding: 18px;
  border-radius: 14px;
  background: var(--dsw-alias-card-fill);
  box-shadow: 0 12px 40px rgba(0, 0, 0, 0.24);
}
.dsh-board__dialogTitle {
  margin: 0;
  font-size: 14px;
  line-height: 20px;
  font-weight: 600;
  color: var(--dsw-alias-label-primary);
}
.dsh-board__dialogBody {
  margin: 0;
  font-size: 12px;
  line-height: 18px;
  color: var(--dsw-alias-label-secondary);
  white-space: pre-line;
}
.dsh-board__dialogList {
  margin: 0;
  padding-left: 18px;
  font-size: 12px;
  line-height: 18px;
  color: var(--dsw-alias-label-secondary);
}
.dsh-board__dialogActions {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  margin-top: 4px;
}
.dsh-board__dialogActions .dsh-board__ghost {
  height: 34px;
  padding: 0 14px;
  font-size: 13px;
  border-radius: 8px;
}
.dsh-board__error {
  margin: 0;
  font-size: 11px;
  line-height: 16px;
  color: var(--dsw-alias-state-error-primary);
}
.dsh-board__memoryList {
  display: flex;
  flex-direction: column;
  gap: 6px;
  min-width: 0;
}
.dsh-board__memoryItem {
  display: flex;
  align-items: flex-start;
  gap: 10px;
  padding: 8px 10px;
  border: 0.5px solid var(--dsw-alias-border-l1);
  border-radius: 10px;
  background: var(--dsw-alias-card-fill);
  min-width: 0;
}
.dsh-board__memoryText {
  flex: 1 1 auto;
  min-width: 0;
  color: var(--dsw-alias-label-primary);
  font-size: 12px;
  line-height: 18px;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}
.dsh-board__memoryText--editable {
  cursor: text;
}
.dsh-board__memoryMeta {
  display: flex;
  flex: none;
  align-items: center;
  gap: 6px;
  color: var(--dsw-alias-label-tertiary);
  font-size: 11px;
  line-height: 16px;
  white-space: nowrap;
}
.dsh-board__empty {
  margin: 0;
  padding: 14px 12px;
  border: 0.5px dashed var(--dsw-alias-border-l3);
  border-radius: 10px;
  color: var(--dsw-alias-label-tertiary);
  font-size: 12px;
  line-height: 18px;
  text-align: center;
}
.dsh-board__center {
  display: flex;
  flex: 1 1 auto;
  align-items: center;
  justify-content: center;
  padding: 40px 24px;
}
.dsh-board__input:focus-visible,
.dsh-board__railInput:focus-visible,
.dsh-board__select:focus-visible,
.dsh-board__taskNote:focus-visible,
.dsh-board__shared:focus-visible {
  outline: var(--dsw-focus-ring-width, 2px) solid var(--dsw-focus-ring-color, var(--dsw-alias-state-business-primary));
  outline-offset: -1px;
}
.dsh-board__projectTitle:focus-visible,
.dsh-board__taskTitle:focus-visible {
  outline: var(--dsw-focus-ring-width, 2px) solid var(--dsw-focus-ring-color, var(--dsw-alias-state-business-primary));
  outline-offset: -1px;
}
.dsh-board__primary:focus-visible,
.dsh-board__ghost:focus-visible,
.dsh-board__back:focus-visible,
.dsh-board__delete:focus-visible,
.dsh-board__railGrow:focus-visible {
  outline: var(--dsw-focus-ring-width, 2px) solid var(--dsw-focus-ring-color, var(--dsw-alias-state-business-primary));
  outline-offset: 1px;
}
@media (hover: hover) {
  .dsh-board__back:hover,
  .dsh-board__ghost:hover:not(:disabled),
  .dsh-board__railGrow:hover {
    background: var(--dsw-alias-interactive-bg-hover);
    color: var(--dsw-alias-label-primary);
  }
  .dsh-board__primary:hover {
    background: var(--dsw-alias-button-primary-hover);
  }
  .dsh-board__project:hover:not([data-active='true']) {
    background: var(--dsw-alias-interactive-bg-hover);
  }
  .dsh-board__delete:hover {
    background: var(--dsw-alias-interactive-bg-hover-danger);
    color: var(--dsw-alias-state-error-primary);
  }
  .dsh-board__projectTitle:hover,
  .dsh-board__taskTitle:hover {
    border-color: var(--dsw-alias-border-l2);
  }
}
@media (max-width: 900px) {
  .dsh-board__body {
    flex-direction: column;
  }
  .dsh-board__rail {
    width: auto;
    border-right: 0;
    border-bottom: 0.5px solid var(--dsw-alias-border-l1);
    padding: 12px 20px 14px;
    max-height: 220px;
  }
  .dsh-board__detail {
    padding: 14px 20px 40px;
  }
  .dsh-board__head {
    padding-left: 20px;
    padding-right: 20px;
  }
}

/* ------------------------------------------------------------- polish layer */
.dsh-board__headInner {
  gap: 8px;
}
.dsh-board__title {
  font-size: 18px;
  line-height: 26px;
  letter-spacing: -0.01em;
}
.dsh-board__subtitle {
  max-width: 780px;
  line-height: 19px;
}
.dsh-board__back {
  height: 26px;
  padding: 0 12px;
  border-radius: 999px;
  margin-left: 8px;
}
.dsh-board__pill--sync {
  margin-left: auto;
  font-variant-numeric: tabular-nums;
}
.dsh-board__banner {
  margin: 10px 32px 0;
  padding: 8px 12px;
  border-radius: 10px;
  background: var(--dsw-alias-card-fill);
  color: var(--dsw-alias-state-warn-primary);
  font-size: 12px;
  line-height: 18px;
}
.dsh-board__banner--conflict {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
  color: var(--dsw-alias-state-error-primary);
}
.dsh-board__rail {
  width: 252px;
  gap: 10px;
  padding: 16px 12px 20px 32px;
}
.dsh-board__railHead {
  align-items: center;
  justify-content: space-between;
  padding: 0 4px;
}
.dsh-board__railTitle {
  font-size: 11px;
  line-height: 16px;
  letter-spacing: 0.04em;
  text-transform: uppercase;
  color: var(--dsw-alias-label-tertiary);
}
.dsh-board__railCount {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-width: 18px;
  height: 16px;
  padding: 0 5px;
  border-radius: 999px;
  background: var(--dsw-alias-interactive-bg-hover);
  font-size: 10px;
  line-height: 16px;
  color: var(--dsw-alias-label-secondary);
}
.dsh-board__railList {
  gap: 3px;
  padding-right: 2px;
}
.dsh-board__project {
  position: relative;
  gap: 3px;
  padding: 9px 10px 9px 13px;
  border-radius: 10px;
  transition: background-color 120ms ease, box-shadow 120ms ease;
}
.dsh-board__project::before {
  content: '';
  position: absolute;
  left: 4px;
  top: 10px;
  bottom: 10px;
  width: 2px;
  border-radius: 2px;
  background: transparent;
  transition: background-color 120ms ease;
}
.dsh-board__project[data-active='true'] {
  background: var(--dsw-alias-card-fill);
  box-shadow: inset 0 0 0 0.5px var(--dsw-alias-border-l2);
}
.dsh-board__project[data-active='true']::before {
  background: var(--dsw-alias-state-business-primary);
}
.dsh-board__projectName {
  font-weight: 500;
}
.dsh-board__projectMeta {
  font-size: 10.5px;
  line-height: 15px;
}
.dsh-board__railForm {
  gap: 6px;
  padding-top: 4px;
}
.dsh-board__railInput {
  height: 32px;
}
.dsh-board__railGrow {
  width: 32px;
  height: 32px;
  border-radius: 9px;
}
.dsh-board__detail {
  gap: 14px;
  padding: 16px 32px 56px 24px;
}
.dsh-board__hero {
  display: flex;
  flex-direction: column;
  gap: 12px;
  padding: 16px 18px;
  border: 0.5px solid var(--dsw-alias-border-l2);
  border-radius: 14px;
  background: var(--dsw-alias-card-fill);
}
.dsh-board__card {
  display: flex;
  flex-direction: column;
  gap: 12px;
  padding: 16px 18px;
  border: 0.5px solid var(--dsw-alias-border-l1);
  border-radius: 14px;
}
.dsh-board__projectTitleRow {
  gap: 10px;
  margin-left: -8px;
}
.dsh-board__projectTitle {
  height: 36px;
  padding: 0 8px;
  font-size: 17px;
  line-height: 24px;
  letter-spacing: -0.01em;
}
.dsh-board__progressRow {
  gap: 12px;
}
.dsh-board__bar {
  height: 8px;
}
.dsh-board__percent {
  min-width: 44px;
  font-size: 13px;
  line-height: 18px;
  font-weight: 600;
}
.dsh-board__pill {
  padding: 2px 10px;
  font-weight: 500;
}
.dsh-board__stats {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}
.dsh-board__stat {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  height: 22px;
  padding: 0 9px;
  border-radius: 999px;
  background: var(--dsw-alias-interactive-bg-hover);
  color: var(--dsw-alias-label-secondary);
  font-size: 11px;
  line-height: 22px;
  white-space: nowrap;
}
.dsh-board__stat::before {
  content: '';
  width: 5px;
  height: 5px;
  border-radius: 50%;
  background: var(--dsw-alias-label-tertiary);
}
.dsh-board__stat[data-tone='green']::before {
  background: var(--dsw-alias-state-success-primary);
}
.dsh-board__stat[data-tone='red']::before {
  background: var(--dsw-alias-state-error-primary);
}
.dsh-board__stat[data-tone='business']::before {
  background: var(--dsw-alias-state-business-primary);
}
.dsh-board__sectionHead {
  align-items: center;
  gap: 8px;
}
.dsh-board__sectionTitle {
  font-size: 13px;
  line-height: 20px;
}
.dsh-board__sectionHint {
  font-size: 11px;
  line-height: 17px;
}
.dsh-board__shared {
  min-height: 104px;
  padding: 12px 14px;
  border-radius: 12px;
  line-height: 1.6;
}
.dsh-board__form {
  gap: 8px;
}
.dsh-board__input,
.dsh-board__select {
  height: 36px;
  border-radius: 9px;
}
.dsh-board__primary {
  height: 36px;
  padding: 0 16px;
  border-radius: 9px;
  font-weight: 600;
}
.dsh-board__tasks {
  gap: 10px;
}
.dsh-board__task {
  position: relative;
  gap: 9px;
  padding: 12px 14px 12px 17px;
  border-radius: 12px;
  transition: border-color 120ms ease, box-shadow 120ms ease, transform 120ms ease;
}
.dsh-board__task:hover {
  border-color: var(--dsw-alias-border-l3);
  box-shadow: 0 2px 10px rgba(0, 0, 0, 0.06);
}
.dsh-board__task:focus-within {
  border-color: var(--dsw-alias-border-l3);
  box-shadow: 0 0 0 2px var(--dsw-alias-interactive-bg-hover);
}
.dsh-board__badge {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  flex: none;
  padding: 1px 7px;
  border-radius: 999px;
  font-size: 11px;
  line-height: 16px;
  white-space: nowrap;
}
.dsh-board__badge[data-tone='warn'] {
  background: color-mix(in srgb, var(--dsw-alias-state-warn-primary) 14%, transparent);
  color: var(--dsw-alias-state-warn-primary);
}
.dsh-board__badge[data-tone='error'] {
  background: color-mix(in srgb, var(--dsw-alias-state-error-primary) 14%, transparent);
  color: var(--dsw-alias-state-error-primary);
}
.dsh-board__badge[data-tone='ok'] {
  background: color-mix(in srgb, var(--dsw-alias-state-success-primary) 14%, transparent);
  color: var(--dsw-alias-state-success-primary);
}
.dsh-board__task::before {
  content: '';
  position: absolute;
  left: 6px;
  top: 14px;
  bottom: 14px;
  width: 3px;
  border-radius: 3px;
  background: var(--dsw-alias-border-l3);
}
.dsh-board__task[data-tone='yellow']::before {
  background: var(--dsw-alias-state-warn-primary);
}
.dsh-board__task[data-tone='green']::before {
  background: var(--dsw-alias-state-success-primary);
}
.dsh-board__task[data-tone='red']::before {
  background: var(--dsw-alias-state-error-primary);
}
.dsh-board__task[data-blocked='true'] {
  background: var(--dsw-alias-card-fill);
}
.dsh-board__taskTitle {
  height: 28px;
  font-size: 13.5px;
  font-weight: 500;
}
.dsh-board__taskMeta {
  gap: 10px;
}
.dsh-board__taskNote {
  height: 30px;
  border-radius: 7px;
}
.dsh-board__sessionRow {
  margin-top: 2px;
  padding-top: 9px;
  border-top: 0.5px dashed var(--dsw-alias-border-l2);
  gap: 8px;
}
.dsh-board__sessionLabel {
  font-size: 10.5px;
  letter-spacing: 0.02em;
}
.dsh-board__sessionTitle {
  font-weight: 500;
}
.dsh-board__ghost {
  border-radius: 7px;
}
.dsh-board__chip {
  border-radius: 7px;
}
.dsh-board__memoryItem {
  align-items: center;
  padding: 10px 12px;
  border-color: var(--dsw-alias-border-l2);
}
.dsh-board__memoryMeta {
  gap: 8px;
  font-size: 10.5px;
}
.dsh-board__empty {
  padding: 18px 14px;
  border-radius: 12px;
}
.dsh-board__center {
  padding: 56px 24px;
}
@media (hover: hover) {
  .dsh-board__task:hover {
    border-color: var(--dsw-alias-border-l3);
  }
}
@media (prefers-reduced-motion: reduce) {
  .dsh-board__barFill,
  .dsh-board__task,
  .dsh-board__project,
  .dsh-board__project::before {
    transition: none;
  }
}
@media (max-width: 900px) {
  .dsh-board__hero,
  .dsh-board__card {
    padding: 14px;
    border-radius: 12px;
  }
  .dsh-board__detail {
    gap: 12px;
  }
}

/* ------------------------------------------------------- status columns */
.dsh-board__columns {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(210px, 1fr));
  gap: 10px;
  padding-bottom: 4px;
}
.dsh-board__column {
  display: flex;
  flex-direction: column;
  gap: 8px;
  min-width: 0;
  padding: 8px;
  border-radius: 12px;
  background: var(--dsw-alias-interactive-bg-hover);
}
.dsh-board__column[data-status='review'] {
  background: var(--dsw-alias-card-fill);
  box-shadow: inset 0 0 0 0.5px var(--dsw-alias-border-l2);
}
.dsh-board__columnHead {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 2px 4px;
}
.dsh-board__columnTitle {
  font-size: 11px;
  line-height: 16px;
  font-weight: 600;
  color: var(--dsw-alias-label-secondary);
  white-space: nowrap;
}
.dsh-board__count {
  margin-left: auto;
  padding: 0 6px;
  border-radius: 999px;
  background: var(--dsw-alias-interactive-bg-hover);
  font-size: 10px;
  line-height: 16px;
  color: var(--dsw-alias-label-tertiary);
  font-variant-numeric: tabular-nums;
}
.dsh-board__cards {
  display: flex;
  flex-direction: column;
  gap: 8px;
  min-height: 36px;
  min-width: 0;
}
.dsh-board__columnEmpty {
  margin: 0;
  padding: 10px 8px;
  border: 0.5px dashed var(--dsw-alias-border-l2);
  border-radius: 10px;
  color: var(--dsw-alias-label-tertiary);
  font-size: 11px;
  line-height: 16px;
  text-align: center;
}
.dsh-board__taskStatus {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px;
  padding-bottom: 2px;
}
/* The status pill reads as a label; the actions that follow belong to a group. */
.dsh-board__taskStatus .dsh-board__pill {
  margin-right: 2px;
}
.dsh-board__taskStatus .dsh-board__ghost {
  height: 22px;
  padding: 0 8px;
}
.dsh-board__rejectRow {
  display: flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
}
.dsh-board__reviewReason {
  margin: 0;
  font-size: 11px;
  line-height: 16px;
  color: var(--dsw-alias-state-error-primary);
  overflow-wrap: anywhere;
}
.dsh-board__acceptedNote {
  margin: 0;
  font-size: 11px;
  line-height: 16px;
  color: var(--dsw-alias-state-success-primary);
}
.dsh-board__acceptanceRow {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
  min-width: 0;
}
.dsh-board__rules {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 10px;
  margin-top: 6px;
  min-width: 0;
}
.dsh-board__ruleLabel {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  font-size: 11px;
  line-height: 16px;
  color: var(--dsw-alias-label-secondary);
  cursor: pointer;
}
.dsh-board__rootDirRow {
  flex: 1 1 260px;
  min-width: 200px;
}
.dsh-board__evidence,
.dsh-board__deliverables {
  margin: 0;
  font-size: 11px;
  line-height: 16px;
  color: var(--dsw-alias-label-secondary);
  overflow-wrap: anywhere;
}
.dsh-board__missing {
  color: var(--dsw-alias-state-error-primary);
}
.dsh-board__archiveList {
  display: flex;
  flex-direction: column;
  gap: 4px;
  flex: 1;
  min-width: 0;
}
.dsh-board__archiveRow {
  display: flex;
  align-items: center;
  gap: 6px;
  justify-content: space-between;
}
.dsh-board__claimForm > summary,
.dsh-board__events > summary {
  cursor: pointer;
  font-size: 11px;
  line-height: 16px;
  color: var(--dsw-alias-label-tertiary);
  list-style: none;
}
.dsh-board__claimForm > summary::-webkit-details-marker,
.dsh-board__events > summary::-webkit-details-marker {
  display: none;
}
.dsh-board__claimForm > summary::before,
.dsh-board__events > summary::before {
  content: '\u25B8';
  display: inline-block;
  width: 12px;
  color: var(--dsw-alias-label-tertiary);
  transition: transform 120ms ease;
}
.dsh-board__claimForm[open] > summary::before,
.dsh-board__events[open] > summary::before {
  transform: rotate(90deg);
}
.dsh-board__claimForm > summary:hover,
.dsh-board__events > summary:hover {
  color: var(--dsw-alias-label-secondary);
}
.dsh-board__claimForm form {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin-top: 6px;
}
.dsh-board__claimForm .dsh-board__input--compact {
  flex: 1 1 120px;
  min-width: 0;
}
.dsh-board__claims,
.dsh-board__debt {
  margin: 0;
  font-size: 11px;
  line-height: 16px;
  color: var(--dsw-alias-label-secondary);
  overflow-wrap: anywhere;
}
.dsh-board__debt {
  color: var(--dsw-alias-state-warn-primary);
}
.dsh-board__nextRow {
  display: grid;
  grid-template-columns: auto minmax(0, 1fr);
  align-items: center;
  gap: 6px;
  min-width: 0;
}
.dsh-board__events {
  font-size: 11px;
  line-height: 16px;
  color: var(--dsw-alias-label-secondary);
}
.dsh-board__events ul {
  margin: 4px 0 0;
  padding-left: 16px;
}
.dsh-board__stale {
  margin: 0;
  font-size: 11px;
  line-height: 16px;
  color: var(--dsw-alias-state-warn-primary);
}
.dsh-board__toast {
  position: sticky;
  bottom: 12px;
  z-index: 2;
  display: flex;
  align-items: center;
  gap: 10px;
  width: fit-content;
  max-width: calc(100% - 64px);
  margin: 0 32px 12px;
  padding: 8px 10px 8px 14px;
  border: 0.5px solid var(--dsw-alias-border-l2);
  border-radius: 12px;
  background: var(--dsw-alias-card-fill);
  box-shadow: 0 4px 14px rgba(0, 0, 0, 0.12);
}
.dsh-board__toastText {
  min-width: 0;
  font-size: 12px;
  line-height: 18px;
  color: var(--dsw-alias-label-primary);
  overflow-wrap: anywhere;
}
.dsh-board__toastHint {
  flex: none;
  font-size: 11px;
  line-height: 16px;
  color: var(--dsw-alias-label-tertiary);
}
.dsh-board__taskFields {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px;
  min-width: 0;
}
.dsh-board__select--compact {
  height: 26px;
  padding: 0 6px;
  font-size: 11px;
}
.dsh-board__dueDate,
.dsh-board__tags {
  flex: 1 1 90px;
  min-width: 0;
  height: 26px;
  font-size: 11px;
}
.dsh-board__input--compact {
  flex: 1 1 120px;
  height: 30px;
  font-size: 12px;
}
.dsh-board__refRow {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px;
  min-width: 0;
}
.dsh-board__ghost[data-active='true'] {
  border-color: var(--dsw-alias-state-business-primary);
  color: var(--dsw-alias-state-business-primary);
}
.dsh-board__chip--toggle {
  border: 0.5px solid transparent;
  cursor: pointer;
  font: inherit;
}
.dsh-board__chip--toggle[data-active='true'] {
  border-color: var(--dsw-alias-state-business-primary);
  color: var(--dsw-alias-state-business-primary);
}
.dsh-board__dueDate[data-overdue='true'] {
  border-color: var(--dsw-alias-state-error-primary);
  color: var(--dsw-alias-state-error-primary);
}
.dsh-board__chip--overdue {
  background: transparent;
  color: var(--dsw-alias-state-error-primary);
}
.dsh-board__filters {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px;
  min-width: 0;
}
@media (max-width: 1200px) {
  .dsh-board__columns {
    grid-template-columns: repeat(auto-fit, minmax(210px, 1fr));
  }
}
@media (max-width: 900px) {
  .dsh-board__columns {
    grid-template-columns: minmax(0, 1fr);
  }
}
`

    /* ------------------------------------------------------------------ data */

    /**
     * Build a locally unique id.
     * @param prefix - character naming the entity kind.
     * @returns a locally unique id.
     */
    function createId(prefix) {
      return prefix + Date.now().toString(36) + Math.random().toString(36).slice(2, 7)
    }

    /**
     * Clamp a number into the completion range.
     * @param value - candidate percentage.
     * @param fallback - value used when the candidate is not a finite number.
     * @returns an integer from 0 to 100.
     */
    function clampPercent(value, fallback) {
      const number = typeof value === 'number' && isFinite(value) ? value : fallback
      return Math.max(0, Math.min(100, Math.round(number)))
    }

    /**
     * Read the stored board document.
     * @returns the raw stored string, or '' when storage is empty or unavailable.
     */
    function readStored() {
      try {
        const value = window.localStorage.getItem(STORAGE_KEY)
        return typeof value === 'string' ? value : ''
      } catch (error) {
        return ''
      }
    }

    /**
     * Persist the board document. Storage can be unavailable (for example in a
     * browser that blocks site data); the board keeps working for this view.
     * @param raw - serialized board document.
     */
    function writeStored(raw) {
      try {
        window.localStorage.setItem(STORAGE_KEY, raw)
      } catch (error) {
        /* the in-memory board remains the source of truth for this view */
      }
    }

    /**
     * Keep a copy of the browser document before it is replaced by the Host's.
     * @param raw - serialized board document.
     */
    function writeStoredBackup(raw) {
      try {
        window.localStorage.setItem(STORAGE_KEY + '.backup', raw)
      } catch (error) {
        /* the copy is a convenience, not a requirement */
      }
    }

    /**
     * Identity of a patchable operation, used to coalesce repeated edits.
     * @param op - board operation.
     * @returns a stable key.
     */
    function opKey(op) {
      if (op === null || typeof op !== 'object') return ''
      const parts = [op.type, op.projectId, op.taskId, op.memoryId, op.referenceId]
      return parts.map(part => (typeof part === 'string' ? part : '')).join('|')
    }

    /**
     * Derive a short title from a free-form description: the first non-blank
     * line, without a list marker, cut at the first sentence break and bounded
     * to a readable length. This is the board's "recognize a title" step; the
     * field stays editable and a bound Session's title can replace it.
     * @param text - the description the user typed.
     * @returns the derived title, or '' when the text holds nothing usable.
     */
    function deriveTitle(text) {
      if (typeof text !== 'string') return ''
      const lines = text.split(/\r?\n/)
      let candidate = ''
      for (let index = 0; index < lines.length; index += 1) {
        const line = lines[index].trim()
        if (line !== '') {
          candidate = line
          break
        }
      }
      if (candidate === '') return ''
      candidate = candidate.replace(/^[-*+•]\s*/, '')
      candidate = candidate.replace(/^\d+\s*[.、)）]\s*/, '')
      const sentence = candidate.split(/[。！？!?；;]/)[0]
      if (sentence !== undefined && sentence.trim() !== '') candidate = sentence
      candidate = candidate.replace(/\s+/g, ' ').trim()
      if (candidate.length > MAX_DERIVED_TITLE) candidate = candidate.slice(0, MAX_DERIVED_TITLE).trim()
      return candidate
    }

    /**
     * Parse one stored subtask. A blank title is kept (the card shows its
     * placeholder and the field is restored on blur), so clearing a field while
     * editing never destroys the record.
     * @param item - candidate from the stored document.
     * @returns a normalized subtask, or null when the entry is unusable.
     */
    function normalizeTask(item) {
      if (item === null || typeof item !== 'object') return null
      if (typeof item.title !== 'string') return null
      return {
        id: typeof item.id === 'string' && item.id !== '' ? item.id : createId('t'),
        title: item.title,
        titleSource: item.titleSource === 'auto' ? 'auto' : 'manual',
        note: typeof item.note === 'string' ? item.note : '',
        status: STATUS_ORDER.includes(item.status) ? item.status : 'todo',
        progress: clampPercent(item.progress, 0),
        priority: PRIORITIES.includes(item.priority) ? item.priority : 'normal',
        dueDate: typeof item.dueDate === 'string' ? item.dueDate : '',
        tags: asStringList(item.tags),
        refs: asStringList(item.refs),
        blocked: item.blocked === true,
        reviewReason: typeof item.reviewReason === 'string' ? item.reviewReason : '',
        evidence: typeof item.evidence === 'string' ? item.evidence : '',
        deliverables: Array.isArray(item.deliverables) ? item.deliverables.filter(entry => typeof entry === 'string') : [],
        requireHuman: item.requireHuman === true,
        nextAction: typeof item.nextAction === 'string' ? item.nextAction : '',
        claims: Array.isArray(item.claims) ? item.claims.filter(claim => claim !== null && typeof claim === 'object') : [],
        pendingVerification: Array.isArray(item.pendingVerification) ? item.pendingVerification.filter(entry => typeof entry === 'string') : [],
        reviews: Array.isArray(item.reviews) ? item.reviews : [],
        events: Array.isArray(item.events) ? item.events : [],
        acceptedBy: item.acceptedBy === 'auto' || item.acceptedBy === 'human' ? item.acceptedBy : '',
        acceptedAt: typeof item.acceptedAt === 'number' && isFinite(item.acceptedAt) ? item.acceptedAt : 0,
        acceptance: item.acceptance !== null && typeof item.acceptance === 'object' && Array.isArray(item.acceptance.reasons)
          ? item.acceptance
          : null,
        verification: item.verification !== null && typeof item.verification === 'object'
          ? {
            checked: item.verification.checked === true,
            missing: Array.isArray(item.verification.missing) ? item.verification.missing.filter(entry => typeof entry === 'string') : [],
            unresolved: Array.isArray(item.verification.unresolved) ? item.verification.unresolved.filter(entry => typeof entry === 'string') : [],
          }
          : null,
        sessionId: typeof item.sessionId === 'string' ? item.sessionId : '',
        workspaceId: typeof item.workspaceId === 'string' ? item.workspaceId : '',
        agentPreset: typeof item.agentPreset === 'string' ? item.agentPreset : '',
        createdAt: typeof item.createdAt === 'number' && isFinite(item.createdAt) ? item.createdAt : Date.now(),
        updatedAt: typeof item.updatedAt === 'number' && isFinite(item.updatedAt) ? item.updatedAt : Date.now(),
      }
    }

    /**
     * Keep a bounded list of non-empty strings from untrusted input.
     * @param value - candidate list.
     * @returns the cleaned list.
     */
    function asStringList(value) {
      if (!Array.isArray(value)) return []
      const list = []
      for (const candidate of value) {
        if (typeof candidate !== 'string' || candidate === '') continue
        if (list.includes(candidate)) continue
        list.push(candidate)
      }
      return list
    }

    /**
     * Parse one stored memory entry.
     * @param item - candidate from the stored document.
     * @returns a normalized entry, or null when the entry is unusable.
     */
    function normalizeMemory(item) {
      if (item === null || typeof item !== 'object') return null
      const text = typeof item.text === 'string' ? item.text : ''
      if (text.trim() === '') return null
      return {
        id: typeof item.id === 'string' && item.id !== '' ? item.id : createId('m'),
        text,
        taskId: typeof item.taskId === 'string' ? item.taskId : '',
        createdAt: typeof item.createdAt === 'number' && isFinite(item.createdAt) ? item.createdAt : Date.now(),
      }
    }

    /**
     * Parse one stored project reference: a `link` is a path or URL the Host
     * rechecks and cards may point at; a `note` is convention text that is
     * never probed, so it can never be marked stale.
     * @param item - candidate from the stored document.
     * @returns a normalized reference, or null when the entry is unusable.
     */
    function normalizeReference(item) {
      if (item === null || typeof item !== 'object') return null
      const name = typeof item.name === 'string' ? item.name.trim() : ''
      if (name === '') return null
      const kind = item.kind === 'note' ? 'note' : 'link'
      return {
        id: typeof item.id === 'string' && item.id !== '' ? item.id : createId('ref-'),
        kind,
        name,
        value: typeof item.value === 'string' ? item.value : '',
        description: typeof item.description === 'string' ? item.description : '',
        staleSince: kind === 'link' && typeof item.staleSince === 'number' && isFinite(item.staleSince) && item.staleSince > 0
          ? item.staleSince
          : 0,
      }
    }

    /**
     * Normalize the acceptance rules of one project.
     * @param value - candidate rules.
     * @returns the rules with every default filled in.
     */
    function normalizeRules(value) {
      const source = value !== null && typeof value === 'object' ? value : {}
      return {
        requireEvidence: typeof source.requireEvidence === 'boolean' ? source.requireEvidence : true,
        requireDeliverables: typeof source.requireDeliverables === 'boolean' ? source.requireDeliverables : false,
        verifyDeliverables: typeof source.verifyDeliverables === 'boolean' ? source.verifyDeliverables : true,
        requireSession: typeof source.requireSession === 'boolean' ? source.requireSession : false,
      }
    }

    /**
     * Parse one stored project. A blank name is kept for the same reason a
     * blank subtask title is: editing must not drop the record under the
     * cursor.
     * @param item - candidate from the stored document.
     * @returns a normalized project, or null when the entry is unusable.
     */
    function normalizeProject(item) {
      if (item === null || typeof item !== 'object') return null
      if (typeof item.name !== 'string') return null
      const tasks = []
      const taskSource = Array.isArray(item.tasks) ? item.tasks : []
      for (let index = 0; index < taskSource.length; index += 1) {
        const task = normalizeTask(taskSource[index])
        if (task !== null) tasks.push(task)
      }
      const memory = []
      const memorySource = Array.isArray(item.memory) ? item.memory : []
      for (let index = 0; index < memorySource.length; index += 1) {
        const entry = normalizeMemory(memorySource[index])
        if (entry !== null) memory.push(entry)
      }
      // A link to a subtask that no longer exists is dropped, never rendered as a dangling id.
      // Trashed cards still count, so restoring one brings its memory links back.
      const known = {}
      for (let index = 0; index < tasks.length; index += 1) known[tasks[index].id] = true
      const trashSource = Array.isArray(item.trash) ? item.trash : []
      const trash = []
      for (let index = 0; index < trashSource.length; index += 1) {
        const record = trashSource[index]
        if (record === null || typeof record !== 'object') continue
        const task = normalizeTask(record.task)
        if (task === null) continue
        known[task.id] = true
        trash.push({
          task,
          index: typeof record.index === 'number' && isFinite(record.index) ? Math.max(0, Math.floor(record.index)) : 0,
          deletedAt: typeof record.deletedAt === 'number' && isFinite(record.deletedAt) ? record.deletedAt : Date.now(),
        })
      }
      for (let index = 0; index < memory.length; index += 1) {
        if (memory[index].taskId !== '' && known[memory[index].taskId] !== true) memory[index].taskId = ''
      }
      // Version 9 kept project material in two fields — a free-text `shared`
      // block and a `sharedEntries` list — and version 10 folds both into one
      // typed list. A stored v9 document is migrated here, in memory, and the
      // legacy fields are dropped so what gets written back is already v10.
      const references = []
      const referenceSource = Array.isArray(item.references) ? item.references : []
      for (let index = 0; index < referenceSource.length; index += 1) {
        const reference = normalizeReference(referenceSource[index])
        if (reference !== null) references.push(reference)
      }
      const sharedText = typeof item.shared === 'string' ? item.shared : ''
      if (sharedText.trim() !== '') {
        // The old free text becomes a note, kept first: that is where it was read.
        references.unshift({
          id: createId('ref-'),
          kind: 'note',
          name: '项目说明',
          value: sharedText,
          description: '',
          staleSince: 0,
        })
      }
      const legacyEntrySource = Array.isArray(item.sharedEntries) ? item.sharedEntries : []
      for (let index = 0; index < legacyEntrySource.length; index += 1) {
        const entry = legacyEntrySource[index]
        if (entry === null || typeof entry !== 'object') continue
        const reference = normalizeReference({
          id: entry.id,
          kind: 'link',
          name: entry.name,
          value: entry.path,
          description: entry.description,
          staleSince: entry.staleSince,
        })
        if (reference !== null) references.push(reference)
      }
      // A hand-edited document may repeat an id; the first one keeps it so the
      // cards that already point at it stay valid.
      const knownReferences = {}
      for (let index = 0; index < references.length; index += 1) {
        while (knownReferences[references[index].id] === true) references[index].id = createId('ref-')
        knownReferences[references[index].id] = true
      }
      for (let index = 0; index < tasks.length; index += 1) {
        tasks[index].refs = tasks[index].refs.filter(ref => knownReferences[ref] === true)
      }
      return {
        id: typeof item.id === 'string' && item.id !== '' ? item.id : createId('p'),
        name: item.name,
        acceptanceMode: item.acceptanceMode === 'human' ? 'human' : 'auto',
        acceptanceRules: normalizeRules(item.acceptanceRules),
        requiredLayers: Array.isArray(item.requiredLayers) ? item.requiredLayers.filter(entry => typeof entry === 'string') : [],
        anchor: item.anchor !== null && typeof item.anchor === 'object' ? item.anchor : { digest: '', decisions: [], risks: [], deviations: [] },
        lastCheckAt: typeof item.lastCheckAt === 'number' ? item.lastCheckAt : 0,
        rootDir: typeof item.rootDir === 'string' ? item.rootDir : '',
        references,
        tasks,
        memory,
        trash,
        createdAt: typeof item.createdAt === 'number' && isFinite(item.createdAt) ? item.createdAt : Date.now(),
      }
    }

    /**
     * Migrate the earlier flat task list (`status: queued | doing | done`) into
     * one project, so an existing board keeps its work after the upgrade.
     * @param list - legacy task array.
     * @returns a board document holding those tasks in a single project.
     */
    function migrateLegacyTasks(list) {
      const tasks = []
      for (let index = 0; index < list.length; index += 1) {
        const item = list[index]
        if (item === null || typeof item !== 'object') continue
        const title = typeof item.title === 'string' ? item.title : ''
        if (title.trim() === '') continue
        const status = item.status === 'done' ? 'done' : item.status === 'doing' ? 'doing' : 'queued'
        const progress = status === 'done' ? 100 : status === 'doing' ? 50 : 0
        const session = typeof item.session === 'string' ? item.session.trim() : ''
        tasks.push({
          id: typeof item.id === 'string' && item.id !== '' ? item.id : createId('t'),
          title,
          titleSource: 'manual',
          note: session === '' ? '' : session,
          status: status === 'doing' ? 'running' : status === 'done' ? 'done' : 'todo',
          progress,
          priority: 'normal',
          dueDate: '',
          tags: [],
          refs: [],
          blocked: false,
          requireHuman: false,
          evidence: '',
          deliverables: [],
          acceptedBy: '',
          acceptedAt: 0,
          acceptance: null,
          reviewReason: '',
          sessionId: '',
          workspaceId: '',
          agentPreset: '',
          createdAt: typeof item.createdAt === 'number' && isFinite(item.createdAt) ? item.createdAt : Date.now(),
          updatedAt: Date.now(),
        })
      }
      if (tasks.length === 0) return { version: DOC_VERSION, projects: [] }
      return {
        version: DOC_VERSION,
        projects: [{
          id: createId('p'),
          name: '默认项目',
          acceptanceMode: 'auto',
          references: [],
          tasks,
          memory: [],
          trash: [],
          createdAt: Date.now(),
        }],
      }
    }

    /**
     * Parse a stored document of any earlier version into projects.
     * @param raw - serialized board document.
     * @returns the board projects, in creation order.
     */
    function parseProjects(raw) {
      if (raw === '') return []
      let document
      try {
        document = JSON.parse(raw)
      } catch (error) {
        return []
      }
      if (document === null || typeof document !== 'object') return []
      if (Array.isArray(document)) return migrateLegacyTasks(document).projects
      if (Array.isArray(document.projects)) {
        const projects = []
        for (let index = 0; index < document.projects.length; index += 1) {
          const project = normalizeProject(document.projects[index])
          if (project !== null) projects.push(project)
        }
        return projects
      }
      if (Array.isArray(document.tasks)) return migrateLegacyTasks(document.tasks).projects
      return []
    }

    /**
     * Serialize projects for storage.
     * @param projects - the projects to keep.
     * @returns the stored document string.
     */
    function serializeProjects(projects) {
      return JSON.stringify({ version: DOC_VERSION, projects })
    }

    /**
     * Board state backed by the Host document, with this browser's local
     * storage kept as a mirror and as the fallback when the Host route is not
     * reachable (for example an install whose Host half is disabled).
     *
     * Writes are fire-and-forget for the UI: the local mirror updates at once,
     * operations queue in order, a short burst coalesces into one request, and
     * the Host's returned board replaces the mirror on every acknowledgement.
     * A stale revision is rebased once against the returned board.
     *
     * @returns the current projects, a local commit function, and the sync handle.
     */
    function useBoard() {
      const [raw, setRaw] = React.useState(readStored)
      const projects = React.useMemo(() => parseProjects(raw), [raw])
      const [archived, setArchived] = React.useState([])
      const [status, setStatus] = React.useState('connecting')
      const [recovered, setRecovered] = React.useState(false)
      const [stuck, setStuck] = React.useState(0)
      const revisionRef = React.useRef(-1)
      const queueRef = React.useRef([])
      const timerRef = React.useRef(null)
      const busyRef = React.useRef(false)
      const rebasesRef = React.useRef(0)
      const retriesRef = React.useRef(0)

      const commit = React.useCallback((next) => {
        const serialized = serializeProjects(next)
        writeStored(serialized)
        setRaw(serialized)
      }, [])

      /**
       * Load the cold-storage document.
       *
       * It is read on demand rather than polled: archived cards do not change
       * while the board is open, and keeping them out of the poll is the point.
       * @returns the archived projects.
       */
      const loadArchive = React.useCallback(async () => {
        try {
          const response = await fetch(HOST_ARCHIVE_PATH, { cache: 'no-store', headers: { accept: 'application/json' } })
          if (!response.ok) return
          const body = await response.json()
          const projects = body !== null && body !== undefined && Array.isArray(body.projects) ? body.projects : []
          setArchived(projects)
        } catch (error) {
          /* the panel still works without cold storage */
        }
      }, [])

      /**
       * Replace the mirror with a board the Host returned.
       * @param board - Host board document.
       */
      const adopt = React.useCallback((board) => {
        if (board === null || typeof board !== 'object') return
        if (typeof board.revision === 'number' && isFinite(board.revision)) revisionRef.current = board.revision
        const list = Array.isArray(board.projects) ? board.projects : []
        const serialized = JSON.stringify({ version: DOC_VERSION, projects: list })
        writeStored(serialized)
        setRaw(serialized)
      }, [])

      /** Send whatever is queued, then settle the status. */
      const flush = React.useCallback(async () => {
        if (busyRef.current) return
        if (typeof fetch !== 'function') {
          setStatus('local')
          return
        }
        const queued = queueRef.current
        if (queued.length === 0) {
          setStatus('synced')
          return
        }
        busyRef.current = true
        queueRef.current = []
        try {
          const response = await fetch(HOST_OPS_PATH, {
            method: 'POST',
            cache: 'no-store',
            headers: { 'content-type': 'application/json', [HOST_GUARD_HEADER]: '1' },
            body: JSON.stringify({ revision: revisionRef.current, ops: queued }),
          })
          if (response.status === 409 || response.status === 412) {
            const body = await response.json().catch(() => null)
            if (body !== null && body !== undefined) adopt(body.board)
            rebasesRef.current += 1
            if (rebasesRef.current <= 1) {
              queueRef.current = queued.concat(queueRef.current)
              setStatus('pending')
              scheduleFlush(FLUSH_DELAY_MS)
              return
            }
            // The Host keeps winning: keep the queued work so the user can retry or
            // discard it, and say so instead of claiming the board is synced.
            queueRef.current = queued.concat(queueRef.current)
            rebasesRef.current = 0
            setStuck(queueRef.current.length)
            setStatus('conflict')
            return
          }
          if (response.status === 403 || response.status === 404) {
            // The Host half is not mounted in this profile: stay local.
            queueRef.current = []
            setStatus('local')
            return
          }
          if (!response.ok) throw new Error('board ops failed: HTTP ' + response.status)
          const body = await response.json()
          // Adopt only when nothing is still waiting: otherwise this response
          // predates the user's newer edits and would revert them on screen.
          if (queueRef.current.length === 0) {
            adopt(body.board)
          }
          rebasesRef.current = 0
          retriesRef.current = 0
          if (queueRef.current.length > 0) {
            setStatus('pending')
            scheduleFlush(FLUSH_DELAY_MS)
          } else {
            setStatus('synced')
          }
        } catch (error) {
          queueRef.current = queued.concat(queueRef.current)
          setStatus('offline')
          const delay = RETRY_DELAYS_MS[Math.min(retriesRef.current, RETRY_DELAYS_MS.length - 1)]
          retriesRef.current += 1
          scheduleFlush(delay)
        } finally {
          busyRef.current = false
        }
      }, [adopt])

      /** @param delay - milliseconds to wait before the next flush. */
      const scheduleFlush = React.useCallback((delay) => {
        if (timerRef.current !== null) return
        timerRef.current = setTimeout(() => {
          timerRef.current = null
          void flush()
        }, delay)
      }, [flush])

      /**
       * Queue operations for the Host. Same-target field writes replace the
       * pending one instead of queueing behind it, so typing costs one op.
       * @param ops - operations to queue.
       */
      const enqueue = React.useCallback((ops) => {
        if (!Array.isArray(ops) || ops.length === 0) return
        for (const op of ops) {
          if (op === null || typeof op !== 'object') continue
          if (COALESCED_OPS.includes(op.type)) {
            const key = opKey(op)
            const index = queueRef.current.findIndex(entry => opKey(entry) === key)
            if (index >= 0) {
              const pending = queueRef.current[index]
              if (op.type === 'task.patch' && pending.type === 'task.patch') {
                // Field-level merge: editing three controls on one card must
                // reach the Host as one patch that carries all three fields.
                queueRef.current[index] = { ...pending, patch: { ...pending.patch, ...op.patch } }
              } else {
                queueRef.current[index] = op
              }
              continue
            }
          }
          queueRef.current.push(op)
        }
        setStatus('pending')
        scheduleFlush(FLUSH_DELAY_MS)
      }, [scheduleFlush])

      // First load: adopt the Host board, or seed the Host from this browser's
      // document when the Host document is still empty.
      React.useEffect(() => {
        let cancelled = false
        const load = async () => {
          if (typeof fetch !== 'function') {
            if (!cancelled) setStatus('local')
            return
          }
          try {
            const response = await fetch(HOST_STATE_PATH, { cache: 'no-store', headers: { accept: 'application/json' } })
            if (!response.ok) {
              if (!cancelled) setStatus('local')
              return
            }
            const body = await response.json()
            if (cancelled) return
            if (body !== null && body !== undefined && body.recovered === true) setRecovered(true)
            const board = body === null || body === undefined ? null : body.board
            const hostProjects = board !== null && board !== undefined && Array.isArray(board.projects) ? board.projects : []
            const localProjects = parseProjects(readStored())
            if (hostProjects.length === 0 && localProjects.length > 0) {
              // One-time migration: keep a copy of the browser document first.
              try {
                writeStoredBackup(readStored())
              } catch (error) {
                /* the copy is a convenience, not a requirement */
              }
              revisionRef.current = board !== null && board !== undefined && typeof board.revision === 'number'
                ? board.revision
                : 0
              queueRef.current = [{
                type: 'board.import',
                document: { version: DOC_VERSION, projects: localProjects },
              }]
              setStatus('pending')
              void flush()
              return
            }
            adopt(board)
            setStatus('synced')
          } catch (error) {
            if (!cancelled) setStatus('local')
          }
        }
        void load()
        return () => {
          cancelled = true
        }
      }, [adopt, flush])

      // Another window on the same origin follows this one through storage.
      React.useEffect(() => {
        const onStorage = (event) => {
          if (event.key !== STORAGE_KEY) return
          setRaw(typeof event.newValue === 'string' ? event.newValue : '')
        }
        window.addEventListener('storage', onStorage)
        return () => {
          window.removeEventListener('storage', onStorage)
          if (timerRef.current !== null) {
            clearTimeout(timerRef.current)
            timerRef.current = null
          }
        }
      }, [])

      // Follow the Host document so a change made elsewhere — another window,
      // or an agent calling greenlight_* — appears here without a reload.
      // Skipped while this surface has unsent work, so a poll never overwrites
      // an edit the user just made.
      React.useEffect(() => {
        if (typeof fetch !== 'function') return undefined
        let stopped = false
        const poll = async () => {
          if (stopped || busyRef.current || queueRef.current.length > 0) return
          try {
            const response = await fetch(HOST_STATE_PATH, { cache: 'no-store', headers: { accept: 'application/json' } })
            if (!response.ok || stopped) return
            const body = await response.json()
            if (stopped || body === null || body === undefined) return
            if (body.recovered === true) setRecovered(true)
            const revision = typeof body.revision === 'number' ? body.revision : revisionRef.current
            if (revision > revisionRef.current) adopt(body.board)
          } catch (error) {
            /* keep the current mirror; the next tick retries */
          }
        }

        // A live stream turns every Host revision into an immediate re-read;
        // the interval stays as a slow fallback and as the only mechanism when
        // EventSource is unavailable.
        let source = null
        if (typeof EventSource === 'function') {
          try {
            source = new EventSource(HOST_EVENTS_PATH)
            source.addEventListener('revision', () => { void poll() })
            source.onerror = () => { /* the interval keeps the mirror fresh */ }
          } catch (error) {
            source = null
          }
        }
        const interval = source === null ? POLL_INTERVAL_MS : SSE_FALLBACK_POLL_MS
        const timer = setInterval(() => { void poll() }, interval)
        return () => {
          stopped = true
          clearInterval(timer)
          if (source !== null && typeof source.close === 'function') source.close()
        }
      }, [adopt])

      return [projects, commit, {
        enqueue,
        status,
        recovered,
        stuck,
        archived,
        loadArchive,
        setArchived,
        /** Retry the work that a conflict left unsent. */
        retryStuck: () => {
          setStuck(0)
          setStatus('pending')
          scheduleFlush(FLUSH_DELAY_MS)
        },
        /** Drop the unsent work and take the Host's board as truth. */
        discardStuck: async () => {
          queueRef.current = []
          setStuck(0)
          try {
            const response = await fetch(HOST_STATE_PATH, { cache: 'no-store', headers: { accept: 'application/json' } })
            if (response.ok) {
              const body = await response.json()
              if (body !== null && body !== undefined) adopt(body.board)
            }
          } catch (error) {
            /* keep the mirror; the next poll retries */
          }
          setStatus('synced')
        },
      }]
    }

    /**
     * Follow the Session Controller's list without polling. Effects are the
     * only subscription point, so a render never installs a listener.
     * @param sessions - the Session Controller service, when this profile has one.
     * @returns the latest list snapshot, or null while the service is absent.
     */
    function useSessionsSnapshot(sessions) {
      const read = () => {
        if (sessions === undefined || sessions === null) return null
        try {
          return sessions.list.getSnapshot()
        } catch (error) {
          return null
        }
      }
      const [snapshot, setSnapshot] = React.useState(read)
      React.useEffect(() => {
        if (sessions === undefined || sessions === null) return undefined
        return sessions.list.subscribe(() => { setSnapshot(read()) })
      }, [sessions])
      return snapshot
    }

    /* --------------------------------------------------------------- derived */

    /**
     * A project's completion: the average of its subtask percentages.
     * @param project - project to measure.
     * @returns an integer from 0 to 100.
     */
    function projectPercent(project) {
      if (project.tasks.length === 0) return 0
      let total = 0
      for (let index = 0; index < project.tasks.length; index += 1) total += project.tasks[index].progress
      return Math.round(total / project.tasks.length)
    }

    /**
     * The project's color band: any blocked subtask forces red, otherwise the
     * average decides — red below 40%, yellow below 80%, green at or above it.
     * An empty project has no band.
     * @param project - project to classify.
     * @returns one of 'idle', 'red', 'yellow', 'green'.
     */
    function projectTone(project) {
      if (project.tasks.length === 0) return 'idle'
      for (let index = 0; index < project.tasks.length; index += 1) {
        if (project.tasks[index].blocked) return 'red'
      }
      const percent = projectPercent(project)
      if (percent >= 80) return 'green'
      if (percent >= 40) return 'yellow'
      return 'red'
    }

    /**
     * Read one Session summary from the list snapshot.
     * @param snapshot - Session list snapshot, or null when unavailable.
     * @param sessionId - Session to look up.
     * @returns the summary, or null when the Session is unknown or the service is absent.
     */
    function sessionSummaryOf(snapshot, sessionId) {
      if (snapshot === null || sessionId === '') return null
      const byId = snapshot.byId
      if (byId === undefined || byId === null) return null
      const summary = byId[sessionId]
      return summary === undefined ? null : summary
    }

    /**
     * The titles a subtask can be named after, newest Session first.
     * @param snapshot - Session list snapshot, or null.
     * @returns linkable Session options, bounded by SESSION_OPTION_LIMIT.
     */
    function sessionOptionsOf(snapshot) {
      const options = []
      if (snapshot === null) return options
      const ids = Array.isArray(snapshot.ids) ? snapshot.ids : []
      const byId = snapshot.byId || {}
      for (let index = 0; index < ids.length && options.length < SESSION_OPTION_LIMIT; index += 1) {
        const summary = byId[ids[index]]
        if (summary === undefined || summary === null) continue
        const label = typeof summary.displayTitle === 'string' && summary.displayTitle !== ''
          ? summary.displayTitle
          : String(summary.id)
        options.push({ id: String(summary.id), label, running: summary.running === true })
      }
      return options
    }

    /**
     * The Workspace a new Session should join: the first one the host lists.
     * @param workspaces - the Workspace Controller service, when present.
     * @returns a Workspace id, or '' when none is known.
     */
    function preferredWorkspaceId(workspaces) {
      if (workspaces === undefined || workspaces === null) return ''
      try {
        const snapshot = workspaces.list.getSnapshot()
        const items = snapshot === null || snapshot === undefined ? [] : snapshot.items
        if (!Array.isArray(items) || items.length === 0) return ''
        const first = items[0]
        return first !== undefined && typeof first.workspaceId === 'string' ? first.workspaceId : ''
      } catch (error) {
        return ''
      }
    }

    /**
     * Fill a localized template's `%s` placeholder.
     * @param template - localized text containing one `%s`.
     * @param value - replacement text.
     * @returns the filled text.
     */
    function fill(template, value) {
      return template.replace('%s', value)
    }

    /**
     * Read a human message from an unknown error.
     * @param error - thrown value.
     * @returns its message, or its string form.
     */
    function messageOf(error) {
      if (error === null || error === undefined) return ''
      if (typeof error === 'string') return error
      if (typeof error.message === 'string') return error.message
      return String(error)
    }

    /**
     * Whether the opt-in auto dispatcher is on for this browser.
     * @returns the stored flag.
     */
/** localStorage key for the project rail collapse state. */
    const RAIL_KEY = 'dsh.greenlight.railCollapsed'

    /**
     * @returns whether the project rail starts collapsed.
     */
    function readRailCollapsed() {
      try {
        return window.localStorage.getItem(RAIL_KEY) === '1'
      } catch (error) {
        return false
      }
    }

    /**
     * @param collapsed - whether the rail is collapsed.
     */
    function writeRailCollapsed(collapsed) {
      try {
        window.localStorage.setItem(RAIL_KEY, collapsed ? '1' : '0')
      } catch (error) {
        /* the rail still toggles for this session */
      }
    }

    function readAutoFlag() {
      try {
        return window.localStorage.getItem(AUTO_DISPATCH_KEY) === '1'
      } catch (error) {
        return false
      }
    }

    /**
     * Persist the auto-dispatch preference.
     * @param on - desired state.
     */
    function writeAutoFlag(on) {
      try {
        window.localStorage.setItem(AUTO_DISPATCH_KEY, on ? '1' : '0')
      } catch (error) {
        /* the toggle is only a preference */
      }
    }

    /**
     * Pick the next card the auto dispatcher should send: the first todo card
     * that already owns a Session and is not blocked.
     * @param project - project to scan.
     * @returns the subtask id, or '' when nothing is ready.
     */
    function pickAutoDispatchTask(project) {
      if (project === null || project === undefined || !Array.isArray(project.tasks)) return ''
      for (const task of project.tasks) {
        if (task.status === 'todo' && task.sessionId !== '' && task.blocked !== true) return task.id
      }
      return ''
    }

    /**
     * Colour band for the sync indicator.
     * @param status - sync status from the board hook.
     * @returns a tone understood by the pill styles.
     */
    function syncToneOf(status) {
      if (status === 'synced') return 'green'
      if (status === 'pending' || status === 'connecting') return 'yellow'
      if (status === 'offline' || status === 'conflict') return 'red'
      return 'idle'
    }

    /**
     * The next column a card advances into.
     * @param status - current column.
     * @returns the next column, or '' when the card is at the end of the path.
     */
    function nextStatusOf(status) {
      const index = ADVANCE_PATH.indexOf(status)
      if (index < 0 || index === ADVANCE_PATH.length - 1) return ''
      return ADVANCE_PATH[index + 1]
    }

    /**
     * The column a card steps back into.
     * @param status - current column.
     * @returns the previous column, or '' at the start of the path.
     */
    function previousStatusOf(status) {
      const index = ADVANCE_PATH.indexOf(status)
      if (index <= 0) return ''
      return ADVANCE_PATH[index - 1]
    }

    /**
     * Local calendar date as `YYYY-MM-DD`.
     * @returns today's date string.
     */
    function todayString() {
      const now = new Date()
      const month = String(now.getMonth() + 1).padStart(2, '0')
      const day = String(now.getDate()).padStart(2, '0')
      return now.getFullYear() + '-' + month + '-' + day
    }

    /**
     * Whether a card is past its due date and still open.
     * @param task - subtask to inspect.
     * @returns whether the card is overdue.
     */
    function isOverdue(task) {
      if (task.dueDate === '' || task.status === 'done') return false
      return task.dueDate < todayString()
    }

    /**
     * Colour band of one subtask, derived from its column and blocked flag.
     * @param task - subtask.
     * @returns 'idle' | 'yellow' | 'green' | 'red'.
     */
    function taskToneOf(task) {
      if (task.blocked) return 'red'
      if (task.status === 'done') return 'green'
      if (task.status === 'failed') return 'red'
      if (task.status === 'review' || task.status === 'running') return 'yellow'
      return 'idle'
    }

    /**
     * Whether a card should move into review because its Session stopped.
     *
     * The runner never closes its own card: a Session that was running and is
     * now idle only moves the card to `review`, where a human accepts it.
     * @param previousRunning - running state observed on the previous render.
     * @param currentRunning - running state observed now.
     * @param status - the card's current column.
     * @returns whether the card should move to review.
     */
    function shouldMoveToReview(previousRunning, currentRunning, status) {
      return previousRunning === true && currentRunning !== true && status === 'running'
    }

    /**
     * Build the prompt text that dispatches one subtask into its Session.
     * @param task - subtask to dispatch.
     * @param project - project the subtask belongs to.
     * @returns the prompt text.
     */
    function buildDispatchPrompt(task, project) {
      const lines = ['请执行看板上的这个子任务。', '', '标题：' + task.title]
      if (task.note !== '') lines.push('说明：' + task.note)
      if (project.references.length > 0) {
        lines.push('', '项目资料：')
        for (const reference of project.references) {
          lines.push('- [' + (reference.kind === 'note' ? '约定' : '链接') + '] ' + reference.name + (reference.value === '' ? '' : '：' + reference.value))
        }
      }
      const linked = project.memory.filter(entry => entry.taskId === task.id)
      if (linked.length > 0) {
        lines.push('', '相关项目记忆：')
        for (const entry of linked) lines.push('- ' + entry.text)
      }
      lines.push('', '完成后请把结果写进项目记忆，并把子任务推进到「待验收」。')
      return lines.join('\n')
    }

    /* ---------------------------------------------------------------- glyphs */

    /**
     * The Greenlight mark: a traffic light with the bottom lamp lit.
     *
     * One silhouette, three lamps, only "go" solid — it still reads at 16px and
     * says which way the board leans without relying on colour, which the
     * sidebar cannot promise.
     * @param props - requested square edge in pixels.
     * @returns the glyph element.
     */
    function BoardGlyph({ size }) {
      return h('svg', {
        width: size,
        height: size,
        viewBox: '0 0 20 20',
        fill: 'none',
        stroke: 'currentColor',
        strokeWidth: 1.4,
        strokeLinecap: 'round',
        strokeLinejoin: 'round',
        'aria-hidden': true,
        focusable: 'false',
        style: { display: 'block' },
      },
      h('rect', { key: 'body', x: 4.7, y: 1.5, width: 10.6, height: 17, rx: 5.3 }),
      h('circle', { key: 'stop', cx: 10, cy: 6.3, r: 1.85, fill: 'currentColor', fillOpacity: 0.22, stroke: 'none' }),
      h('circle', { key: 'wait', cx: 10, cy: 10, r: 1.85, fill: 'currentColor', fillOpacity: 0.45, stroke: 'none' }),
      h('circle', { key: 'go', cx: 10, cy: 13.9, r: 2.05, fill: 'var(--dsw-alias-state-success-primary)', stroke: 'none' }))
    }

    /**
     * The rail toggle: a panel with its left column marked when the rail is open.
     *
     * One icon in one place — collapsing must never move the control that brings
     * the rail back, so the button above always sits in the header.
     * @param props - `{ size, open }`.
     * @returns the glyph element.
     */
    function RailGlyph({ size, open }) {
      return h('svg', {
        width: size,
        height: size,
        viewBox: '0 0 20 20',
        fill: 'none',
        stroke: 'currentColor',
        strokeWidth: 1.4,
        strokeLinecap: 'round',
        strokeLinejoin: 'round',
        'aria-hidden': true,
        focusable: 'false',
        style: { display: 'block' },
      },
      h('rect', { key: 'frame', x: 2.6, y: 3.6, width: 14.8, height: 12.8, rx: 2.6 }),
      h('line', { key: 'split', x1: 8.2, y1: 3.8, x2: 8.2, y2: 16.2, opacity: open ? 1 : 0.45 }),
      open
        ? h('rect', { key: 'fill', x: 2.8, y: 3.8, width: 5.3, height: 12.4, rx: 2.4, fill: 'currentColor', stroke: 'none', opacity: 0.9 })
        : null)
    }

    /**
     * Sidebar entry icon. The shell draws the row button, the label, and the
     * selected fill around this glyph and passes the edge length it wants.
     * @param props - the sidebar's icon share.
     * @returns the icon element.
     */
    function SidebarPanelIcon({ size }) {
      return h(BoardGlyph, { size })
    }

    /* ------------------------------------------------------------- components */

    /**
     * One project row in the left rail: color dot, name, and its subtask count
     * with completion.
     * @param props - the project, its selection state, and the select callback.
     * @returns the row button element.
     */
    function ProjectRow({ project, active, t, onSelect }) {
      const percent = projectPercent(project)
      const tone = projectTone(project)
      return h('button', {
        type: 'button',
        className: 'dsh-board__project',
        'data-active': active ? 'true' : undefined,
        onClick: () => { onSelect(project.id) },
        title: project.name,
      },
      h('span', { className: 'dsh-board__projectTop' },
        h('span', { className: 'dsh-board__dot', 'data-tone': tone, 'aria-hidden': true }),
        h('span', { className: 'dsh-board__projectName' }, project.name)),
      h('span', { className: 'dsh-board__projectMeta' },
        String(project.tasks.length) + ' ' + t('rail.countUnit') + ' · ' + percent + '%'))
    }

    /**
     * The project's completion bar, percentage, and color band pill.
     * @param props - the project to summarize.
     * @returns the summary row element.
     */
    function ProgressSummary({ project, t }) {
      const percent = projectPercent(project)
      const tone = projectTone(project)
      return h('div', { className: 'dsh-board__progressRow' },
        h('span', { className: 'dsh-board__bar', 'data-tone': tone, role: 'img', 'aria-label': t('detail.progress') + ' ' + percent + '%' },
          h('span', { className: 'dsh-board__barFill', style: { width: percent + '%' } })),
        h('span', { className: 'dsh-board__taskPercent' }, percent + '%'),
        h('span', { className: 'dsh-board__pill', 'data-tone': tone }, t('tone.' + tone)))
    }

    /**
     * The subtask's main-Session row: the bound Session with its title and
     * running state, or the controls that create or link one.
     * @param props - the subtask, its Session summary, and the Session actions.
     * @returns the row element.
     */
    function SessionRow({ task, summary, t, options, busy, actions }) {
      const bound = summary !== null
      const sessionTitle = bound ? (typeof summary.displayTitle === 'string' ? summary.displayTitle : String(summary.id)) : ''
      const sessionId = task.sessionId
      const canRename = bound && sessionTitle !== '' && sessionTitle !== task.title

      const controls = []
      if (bound) {
        controls.push(h('span', {
          className: 'dsh-board__dot',
          'data-tone': summary.running === true ? 'green' : 'idle',
          'aria-hidden': true,
        }))
        controls.push(h('span', { className: 'dsh-board__sessionTitle', title: sessionTitle }, sessionTitle))
        controls.push(h('span', { className: 'dsh-board__chip', 'data-live': summary.running === true ? 'true' : undefined },
          summary.running === true ? t('task.running') : t('task.idle')))
        controls.push(h('button', {
          type: 'button',
          className: 'dsh-board__ghost',
          onClick: () => { actions.openSession(sessionId) },
        }, t('task.openSession')))
        if (canRename) {
          controls.push(h('button', {
            type: 'button',
            className: 'dsh-board__ghost',
            onClick: () => { actions.syncTitle(sessionTitle) },
          }, t('task.syncSessionTitle')))
        }
        controls.push(h('button', {
          type: 'button',
          className: 'dsh-board__ghost',
          onClick: () => { actions.unbindSession() },
        }, t('task.unbindSession')))
      } else {
        controls.push(h('span', { className: 'dsh-board__sessionLabel' }, t('task.sessionNone')))
        controls.push(h('button', {
          type: 'button',
          className: 'dsh-board__ghost',
          disabled: busy,
          onClick: () => { actions.createSession() },
        }, busy ? t('task.creatingSession') : t('task.createSession')))
        if (options.length === 0) {
          controls.push(h('span', { className: 'dsh-board__sessionLabel' }, t('task.noSessions')))
        } else {
          controls.push(h('select', {
            className: 'dsh-board__ghost',
            value: '',
            'aria-label': t('task.linkSession'),
            title: t('task.linkSession'),
            onChange: (event) => {
              const value = event.target.value
              if (value !== '') actions.linkSession(value)
            },
          },
          h('option', { value: '' }, t('task.linkSession')),
          options.map(option => h('option', { key: option.id, value: option.id }, option.label))))
        }
      }

      return h('div', { className: 'dsh-board__sessionRow' },
        h('span', { className: 'dsh-board__sessionLabel' }, t('task.session')),
        controls)
    }

    /**
     * One subtask card: its column, title, advance/review/dispatch controls,
     * progress slider, blocked switch, description, and its main Session.
     * @param props - the subtask, its callbacks, and its Session state.
     * @returns the card element.
     */
    function TaskCard({
      task, t, linkedMemory, summary, sessionOptions, sessionBusy, sessionError, references, actions,
    }) {
      const [rejecting, setRejecting] = React.useState(false)
      const [reason, setReason] = React.useState('')
      const [dispatchBusy, setDispatchBusy] = React.useState(false)
      const [dispatchError, setDispatchError] = React.useState('')
      const [claimDraft, setClaimDraft] = React.useState({ what: '', how: '', layer: 'unit', outcome: 'pass' })

      const done = task.status === 'done'
      const tone = taskToneOf(task)
      const next = nextStatusOf(task.status)
      const previous = previousStatusOf(task.status)
      const inReview = task.status === 'review'
      const overdue = isOverdue(task)

      const dispatch = () => {
        setDispatchBusy(true)
        setDispatchError('')
        const settle = async () => {
          try {
            await actions.dispatch()
          } catch (error) {
            setDispatchError(messageOf(error))
          } finally {
            setDispatchBusy(false)
          }
        }
        void settle()
      }

      const submitReject = () => {
        const trimmed = reason.trim()
        if (trimmed === '') return
        actions.reject(trimmed)
        setRejecting(false)
        setReason('')
      }

      return h('article', {
        className: 'dsh-board__task',
        draggable: true,
        onDragStart: () => { actions.dragStart() },
        'data-done': done ? 'true' : undefined,
        'data-blocked': task.blocked ? 'true' : undefined,
        'data-tone': tone,
      },
      h('div', { className: 'dsh-board__taskStatus' },
        h('span', { className: 'dsh-board__pill', 'data-tone': tone }, t('status.' + task.status)),
        inReview
          ? h('button', {
            type: 'button',
            className: 'dsh-board__ghost',
            onClick: () => { actions.confirm() },
          }, t('task.confirmReview'))
          : null,
        inReview
          ? h('button', {
            type: 'button',
            className: 'dsh-board__ghost',
            onClick: () => { setRejecting(!rejecting) },
          }, t('task.rejectReview'))
          : null,
        !inReview && next !== '' && task.status !== 'review'
          ? h('button', {
            type: 'button',
            className: 'dsh-board__ghost',
            title: t('task.advance'),
            onClick: () => { actions.advance() },
          }, '\u2192')
          : null,
        previous !== '' && !inReview
          ? h('button', {
            type: 'button',
            className: 'dsh-board__ghost',
            title: t('task.back'),
            onClick: () => { actions.back() },
          }, '\u2190')
          : null,
        task.status === 'failed'
          ? h('button', {
            type: 'button',
            className: 'dsh-board__ghost',
            onClick: () => { actions.reopen() },
          }, t('task.reopen'))
          : null,
        h('button', {
          type: 'button',
          className: 'dsh-board__ghost',
          disabled: dispatchBusy || task.sessionId === '',
          title: task.sessionId === '' ? t('task.dispatchNoSession') : t('task.dispatchCost'),
          onClick: dispatch,
        }, dispatchBusy ? t('task.dispatching') : t('task.dispatch')),
        // Only a finished card is worth putting away; archiving work in flight
        // would hide it from the columns without anyone deciding it is done.
        task.status === 'done'
          ? h('button', {
            type: 'button',
            className: 'dsh-board__ghost',
            title: t('task.archiveHint'),
            onClick: () => { actions.archive() },
          }, t('task.archive'))
          : null,
        task.sessionId === ''
          ? null
          : h('span', { className: 'dsh-board__sessionLabel' }, t('task.dispatchCost'))),
      rejecting
        ? h('div', { className: 'dsh-board__rejectRow' },
          h('input', {
            className: 'dsh-board__input',
            type: 'text',
            value: reason,
            placeholder: t('task.rejectReason'),
            'aria-label': t('task.rejectReason'),
            onChange: (event) => { setReason(event.target.value) },
          }),
          h('button', { type: 'button', className: 'dsh-board__primary', onClick: submitReject }, t('task.rejectSubmit')),
          h('button', { type: 'button', className: 'dsh-board__ghost', onClick: () => { setRejecting(false) } }, t('task.rejectCancel')))
        : null,
      task.reviewReason === ''
        ? null
        : h('p', { className: 'dsh-board__reviewReason' },
          (task.acceptance !== null && task.acceptance.pass === false
            ? t('task.acceptanceBlocked')
            : t('task.rejectReason')) + '：' + task.reviewReason),
      task.status === 'done' && task.acceptedBy !== ''
        ? h('p', { className: 'dsh-board__acceptedNote' },
          task.acceptedBy === 'auto' ? t('task.acceptedAuto') : t('task.acceptedHuman'))
        : null,
      task.evidence === ''
        ? null
        : h('p', { className: 'dsh-board__evidence' }, t('task.evidence') + '：' + task.evidence),
      task.deliverables.length === 0
        ? null
        : h('p', { className: 'dsh-board__deliverables' },
          t('task.deliverables') + '：' + task.deliverables.join('、'),
          task.verification !== null && (task.verification.missing.length > 0 || task.verification.unresolved.length > 0)
            ? h('span', { className: 'dsh-board__missing' },
              '（' + t('rules.missing') + '：' + task.verification.missing.concat(task.verification.unresolved).join('、') + '）')
            : null),
      task.claims.length === 0
        ? null
        : h('p', { className: 'dsh-board__claims' },
          t('task.claims') + '：' + task.claims.map(claim =>
            (claim.outcome === 'pass' ? '✓' : claim.outcome === 'fail' ? '✗' : '?') + ' ' + claim.what
            + (claim.layer === undefined ? '' : '（' + t('task.layer.' + claim.layer) + '）')).join('，')),
      task.pendingVerification.length === 0
        ? null
        : h('p', { className: 'dsh-board__debt' },
          h('span', { className: 'dsh-board__badge', 'data-tone': 'warn' }, t('task.debt') + ' ' + task.pendingVerification.length),
          ' ' + task.pendingVerification.join('、')),
      h('details', { className: 'dsh-board__claimForm' },
        h('summary', null, t('task.claimAdd')),
        h('form', {
          onSubmit: (event) => {
            event.preventDefault()
            const what = claimDraft.what.trim()
            if (what === '') return
            actions.addClaim({
              what,
              how: claimDraft.how.trim(),
              layer: claimDraft.layer,
              outcome: claimDraft.outcome,
            })
            setClaimDraft({ what: '', how: '', layer: 'unit', outcome: 'pass' })
          },
        },
        h('input', {
          className: 'dsh-board__input dsh-board__input--compact',
          type: 'text',
          value: claimDraft.what,
          placeholder: t('task.claimWhat'),
          'aria-label': t('task.claimWhat'),
          onChange: (event) => { setClaimDraft({ ...claimDraft, what: event.target.value }) },
        }),
        h('input', {
          className: 'dsh-board__input dsh-board__input--compact',
          type: 'text',
          value: claimDraft.how,
          placeholder: t('task.claimHow'),
          'aria-label': t('task.claimHow'),
          onChange: (event) => { setClaimDraft({ ...claimDraft, how: event.target.value }) },
        }),
        h('select', {
          className: 'dsh-board__select',
          value: claimDraft.layer,
          'aria-label': t('task.claimLayer'),
          onChange: (event) => { setClaimDraft({ ...claimDraft, layer: event.target.value }) },
        }, LAYERS.map(layer => h('option', { key: layer, value: layer }, t('task.layer.' + layer)))),
        h('select', {
          className: 'dsh-board__select',
          value: claimDraft.outcome,
          'aria-label': t('task.claimOutcome'),
          onChange: (event) => { setClaimDraft({ ...claimDraft, outcome: event.target.value }) },
        },
        h('option', { value: 'pass' }, t('task.claimPass')),
        h('option', { value: 'fail' }, t('task.claimFail')),
        h('option', { value: 'unverified' }, t('task.claimUnverified'))),
        h('button', { type: 'submit', className: 'dsh-board__ghost' }, t('task.claimSubmit')))),
      h('div', { className: 'dsh-board__nextRow' },
        h('span', { className: 'dsh-board__sectionHint dsh-board__nextLabel' }, t('task.next')),
        h('input', {
          className: 'dsh-board__input dsh-board__input--compact',
          type: 'text',
          value: task.nextAction,
          placeholder: t('task.nextPlaceholder'),
          'aria-label': t('task.next'),
          onChange: (event) => { actions.nextAction(event.target.value) },
        })),
      task.events.length === 0
        ? null
        : h('details', { className: 'dsh-board__events' },
          h('summary', null, t('task.events') + ' ' + task.events.length),
          h('ul', null,
            task.events.slice(-8).map((event, index) =>
              h('li', { key: index },
                new Date(event.at).toLocaleString() + ' · ' + event.kind
                + (event.from === '' ? '' : ' ' + event.from + '→' + event.to)
                + (event.note === '' ? '' : ' · ' + event.note))))),
      h('div', { className: 'dsh-board__taskTop' },
        h('input', {
          className: 'dsh-board__taskTitle',
          type: 'text',
          value: task.title,
          'aria-label': t('task.title'),
          placeholder: t('task.untitled'),
          title: task.titleSource === 'auto' ? t('task.describe') : t('task.title'),
          onChange: (event) => { actions.title(event.target.value) },
          onBlur: (event) => {
            if (event.target.value.trim() === '') actions.title(t('task.untitled'))
          },
        }),
        linkedMemory > 0
          ? h('span', { className: 'dsh-board__chip' }, String(linkedMemory) + ' ' + t('task.linkedMemory'))
          : null,
        h('button', {
          type: 'button',
          className: 'dsh-board__delete',
          'aria-label': t('task.delete'),
          title: t('task.delete'),
          onClick: () => { actions.remove() },
        }, '\u00d7')),
      h('div', { className: 'dsh-board__taskMeta' },
        h('input', {
          className: 'dsh-board__range',
          type: 'range',
          min: 0,
          max: 100,
          step: 5,
          value: task.progress,
          'aria-label': t('detail.progress'),
          onChange: (event) => { actions.progress(clampPercent(Number(event.target.value), task.progress)) },
        }),
        h('span', { className: 'dsh-board__taskPercent' }, task.progress + '%'),
        h('label', { className: 'dsh-board__check' },
          h('input', {
            type: 'checkbox',
            checked: task.blocked,
            'aria-label': t('task.blocked'),
            onChange: (event) => { actions.blocked(event.target.checked) },
          }),
          t('task.blocked'))),
      h('div', { className: 'dsh-board__taskFields' },
        h('select', {
          className: 'dsh-board__select dsh-board__select--compact',
          value: task.priority,
          'aria-label': t('task.priority'),
          title: t('task.priority'),
          onChange: (event) => { actions.priority(event.target.value) },
        },
        PRIORITIES.map(priority => h('option', { key: priority, value: priority }, t('priority.' + priority)))),
        h('input', {
          className: 'dsh-board__taskNote dsh-board__dueDate',
          type: 'date',
          value: task.dueDate,
          'aria-label': t('task.due'),
          title: overdue ? t('task.overdue') : t('task.due'),
          'data-overdue': overdue ? 'true' : undefined,
          onChange: (event) => { actions.dueDate(event.target.value) },
        }),
        overdue ? h('span', { className: 'dsh-board__chip dsh-board__chip--overdue' }, t('task.overdue')) : null,
        h('input', {
          className: 'dsh-board__taskNote dsh-board__tags',
          type: 'text',
          value: task.tags.join(', '),
          placeholder: t('task.tags'),
          'aria-label': t('task.tags'),
          title: t('task.tagsPlaceholder'),
          onChange: (event) => { actions.tags(event.target.value) },
        })),
      references.length === 0
        ? null
        : h('div', { className: 'dsh-board__refRow' },
          h('span', { className: 'dsh-board__sessionLabel' }, t('task.refs')),
          references.map(reference => h('button', {
            key: reference.id,
            type: 'button',
            className: 'dsh-board__chip dsh-board__chip--toggle',
            'data-active': task.refs.includes(reference.id) ? 'true' : undefined,
            title: reference.value === '' ? reference.name : reference.value,
            onClick: () => { actions.toggleRef(reference.id) },
          }, reference.name))),
      h('input', {
        className: 'dsh-board__taskNote',
        type: 'text',
        value: task.note,
        placeholder: t('task.note'),
        'aria-label': t('task.note'),
        onChange: (event) => { actions.note(event.target.value) },
      }),
      h(SessionRow, {
        task,
        summary,
        t,
        options: sessionOptions,
        busy: sessionBusy,
        actions: {
          createSession: actions.createSession,
          openSession: actions.openSession,
          linkSession: actions.linkSession,
          unbindSession: actions.unbindSession,
          syncTitle: actions.syncTitle,
        },
      }),
      sessionError === '' ? null : h('p', { className: 'dsh-board__error', role: 'alert' }, sessionError),
      dispatchError === '' ? null : h('p', { className: 'dsh-board__error', role: 'alert' }, t('task.dispatchFailed') + '：' + dispatchError))
    }

    /**
     * One project memory entry: its text, optional linked subtask, time, and
     * delete control.
     * @param props - the entry, its linked subtask title, and callbacks.
     * @returns the entry element.
     */
    function MemoryItem({ entry, linkedTitle, t, onDelete, onSave }) {
      const [editing, setEditing] = React.useState(false)
      const [draft, setDraft] = React.useState(entry.text)
      const stamp = new Date(entry.createdAt)
      const label = stamp.getFullYear() + '-' + String(stamp.getMonth() + 1).padStart(2, '0') + '-' + String(stamp.getDate()).padStart(2, '0')
        + ' ' + String(stamp.getHours()).padStart(2, '0') + ':' + String(stamp.getMinutes()).padStart(2, '0')

      const save = () => {
        const trimmed = draft.trim()
        if (trimmed !== '' && trimmed !== entry.text) onSave(trimmed)
        setEditing(false)
      }

      return h('div', { className: 'dsh-board__memoryItem' },
        editing
          ? h('input', {
            className: 'dsh-board__input dsh-board__input--compact',
            type: 'text',
            value: draft,
            'aria-label': t('memory.edit'),
            onChange: (event) => { setDraft(event.target.value) },
            onKeyDown: (event) => {
              if (event.key === 'Enter') save()
              if (event.key === 'Escape') { setDraft(entry.text); setEditing(false) }
            },
          })
          : h('span', {
            className: 'dsh-board__memoryText dsh-board__memoryText--editable',
            title: t('memory.edit'),
            onClick: () => { setDraft(entry.text); setEditing(true) },
          }, entry.text),
        h('span', { className: 'dsh-board__memoryMeta' },
          linkedTitle === '' ? null : h('span', { className: 'dsh-board__chip' }, linkedTitle),
          h('span', null, label),
          editing
            ? h('button', { type: 'button', className: 'dsh-board__ghost', onClick: save }, t('memory.save'))
            : null,
          h('button', {
            type: 'button',
            className: 'dsh-board__delete',
            'aria-label': t('memory.delete'),
            title: t('memory.delete'),
            onClick: onDelete,
          }, '\u00d7')))
    }

    /**
     * The project detail pane: name, completion summary, subtasks with their
     * main Sessions, and shared memory.
     * @param props - the selected project, its update callbacks, Session data, and locale seat.
     * @returns the detail element.
     */
    function ProjectDetail({ project, t, actions, sessionsSnapshot }) {
      const [describeDraft, setDescribeDraft] = React.useState('')
      const [memoryDraft, setMemoryDraft] = React.useState('')
      const [memoryLink, setMemoryLink] = React.useState('')
      const [busyTaskId, setBusyTaskId] = React.useState('')
      const [sessionError, setSessionError] = React.useState('')

      const linkedCounts = React.useMemo(() => {
        const counts = {}
        for (let index = 0; index < project.memory.length; index += 1) {
          const taskId = project.memory[index].taskId
          if (taskId !== '') counts[taskId] = (counts[taskId] || 0) + 1
        }
        return counts
      }, [project])

      const titleById = React.useMemo(() => {
        const titles = {}
        for (let index = 0; index < project.tasks.length; index += 1) {
          titles[project.tasks[index].id] = project.tasks[index].title
        }
        return titles
      }, [project])

      const sessionOptions = React.useMemo(() => sessionOptionsOf(sessionsSnapshot), [sessionsSnapshot])
      const [referenceDraft, setReferenceDraft] = React.useState({ kind: 'link', name: '', value: '', description: '' })
      // One row at a time is edited in place: two open editors would compete for
      // the same draft and the second save would silently win.
      const [editingReferenceId, setEditingReferenceId] = React.useState('')
      const [referenceEditDraft, setReferenceEditDraft] = React.useState({ kind: 'link', name: '', value: '', description: '' })
      const [filterText, setFilterText] = React.useState('')
      const [filterMode, setFilterMode] = React.useState('all')

      // Filtering is display-only: the board document is untouched, and a
      // filtered-out card can still be edited after clearing the filter.
      const visibleTasks = React.useMemo(() => {
        const needle = filterText.trim().toLowerCase()
        return project.tasks.filter((task) => {
          if (filterMode === 'overdue' && !isOverdue(task)) return false
          if (filterMode === 'blocked' && task.blocked !== true) return false
          if (needle === '') return true
          const haystack = [task.title, task.note, task.tags.join(' ')].join(' ').toLowerCase()
          return haystack.includes(needle)
        })
      }, [project, filterText, filterMode])

      // One summary lookup per subtask, shared by the cards and the hero counters.
      const summaries = React.useMemo(() => {
        const map = {}
        for (let index = 0; index < project.tasks.length; index += 1) {
          const task = project.tasks[index]
          map[task.id] = sessionSummaryOf(sessionsSnapshot, task.sessionId)
        }
        return map
      }, [project, sessionsSnapshot])

      const counts = React.useMemo(() => {
        let done = 0
        let running = 0
        let blocked = 0
        for (let index = 0; index < project.tasks.length; index += 1) {
          const task = project.tasks[index]
          if (task.blocked) blocked += 1
          else if (task.progress >= 100) done += 1
          const summary = summaries[task.id]
          if (summary !== null && summary !== undefined && summary.running === true) running += 1
        }
        return { done, running, blocked }
      }, [project, summaries])

      const addTask = (event) => {
        event.preventDefault()
        const description = describeDraft.trim()
        if (description === '') return
        const title = deriveTitle(description) || t('task.untitled')
        actions.addTask(title, description)
        setDescribeDraft('')
      }

      const addMemory = (event) => {
        event.preventDefault()
        const trimmed = memoryDraft.trim()
        if (trimmed === '') return
        actions.addMemory(trimmed, memoryLink)
        setMemoryDraft('')
        setMemoryLink('')
      }

      // A link needs something to probe, a note does not; the Host validates
      // the same way, so the draft is only sent when it can be accepted.
      const addReference = (event) => {
        event.preventDefault()
        const kind = referenceDraft.kind === 'note' ? 'note' : 'link'
        const name = referenceDraft.name.trim()
        const value = kind === 'link' ? referenceDraft.value.trim() : referenceDraft.value
        if (name === '') return
        if (kind === 'link' && value === '') return
        actions.addReference(kind, name, value, referenceDraft.description.trim())
        setReferenceDraft({ kind, name: '', value: '', description: '' })
      }

      /**
       * Open one reference for editing, seeded with what is on screen.
       * @param reference - the entry being edited.
       */
      const startReferenceEdit = (reference) => {
        setEditingReferenceId(reference.id)
        setReferenceEditDraft({
          kind: reference.kind,
          name: reference.name,
          value: reference.value,
          description: reference.description,
        })
      }

      const cancelReferenceEdit = () => {
        setEditingReferenceId('')
        setReferenceEditDraft({ kind: 'link', name: '', value: '', description: '' })
      }

      // Same validation as the add form, for the same reason: the Host would
      // refuse an empty name or an empty link, so the draft never leaves the page.
      const saveReferenceEdit = (event) => {
        event.preventDefault()
        if (editingReferenceId === '') return
        const kind = referenceEditDraft.kind === 'note' ? 'note' : 'link'
        const name = referenceEditDraft.name.trim()
        const value = kind === 'link' ? referenceEditDraft.value.trim() : referenceEditDraft.value
        if (name === '') return
        if (kind === 'link' && value === '') return
        actions.updateReference(editingReferenceId, {
          kind,
          name,
          value,
          description: referenceEditDraft.description.trim(),
        })
        cancelReferenceEdit()
      }

      const createSession = (taskId) => {
        setBusyTaskId(taskId)
        setSessionError('')
        const settle = async () => {
          try {
            const sessionId = await actions.createSession(taskId)
            if (sessionId === '' || sessionId === undefined) setSessionError(t('task.createSessionFailed'))
          } catch (error) {
            setSessionError(t('task.createSessionFailed') + '：' + messageOf(error))
          } finally {
            setBusyTaskId('')
          }
        }
        void settle()
      }

      const projectArchive = (actions.archived || []).filter(entry => entry.projectId === project.id)

      const renderTaskCard = (task) => h(TaskCard, {
        key: task.id,
        task,
        t,
        linkedMemory: linkedCounts[task.id] || 0,
        summary: summaries[task.id] === undefined ? null : summaries[task.id],
        sessionOptions,
        sessionBusy: busyTaskId === task.id,
        sessionError: busyTaskId === '' && sessionError !== '' ? sessionError : '',
        references: project.references,
        actions: {
          title: (value) => { actions.updateTask(task.id, { title: value, titleSource: 'manual' }) },
          progress: (value) => { actions.updateTask(task.id, { progress: value }) },
          blocked: (value) => { actions.updateTask(task.id, { blocked: value }) },
          note: (value) => { actions.updateTask(task.id, { note: value }) },
          priority: (value) => { actions.updateTask(task.id, { priority: value }) },
          nextAction: (value) => { actions.updateTask(task.id, { nextAction: value }) },
          addClaim: (claim) => { actions.addClaim(task.id, claim) },
          dueDate: (value) => { actions.updateTask(task.id, { dueDate: value }) },
          tags: (value) => {
            const tags = value.split(',').map(part => part.trim()).filter(part => part !== '')
            actions.updateTask(task.id, { tags })
          },
          toggleRef: (entryId) => {
            const refs = task.refs.includes(entryId)
              ? task.refs.filter(ref => ref !== entryId)
              : task.refs.concat([entryId])
            actions.updateTask(task.id, { refs })
          },
          remove: () => { actions.deleteTask(task.id) },
          createSession: () => { createSession(task.id) },
          openSession: (sessionId) => { actions.openSession(sessionId) },
          linkSession: (sessionId) => { actions.updateTask(task.id, { sessionId }) },
          unbindSession: () => { actions.updateTask(task.id, { sessionId: '' }) },
          syncTitle: (title) => { actions.updateTask(task.id, { title, titleSource: 'auto' }) },
          advance: () => { actions.moveTask(task.id, task.status) },
          back: () => { actions.moveTask(task.id, task.status, previousStatusOf(task.status)) },
          confirm: () => { actions.confirmReview(task.id) },
          reject: (reason) => { actions.rejectReview(task.id, reason) },
          reopen: () => { actions.reopenTask(task.id) },
          dispatch: () => actions.dispatch(task.id),
          archive: () => actions.archiveTask(task.id),
          dragStart: () => { actions.dragStart(task.id, task.status) },
        },
      })

      // A Session that stopped running moves its card into review, never to done.
      const runningRef = React.useRef({})
      React.useEffect(() => {
        const previous = runningRef.current
        const current = {}
        for (const task of project.tasks) {
          if (task.sessionId === '') continue
          const summary = summaries[task.id]
          if (summary === null || summary === undefined) continue
          current[task.id] = summary.running === true
          if (shouldMoveToReview(previous[task.id], summary.running === true, task.status)) {
            actions.moveTask(task.id, task.status, 'review')
          }
        }
        runningRef.current = current
      }, [project, summaries])

      const columns = STATUS_ORDER.map((status) => {
        const items = visibleTasks.filter(task => task.status === status)
        return h('section', {
          key: status,
          className: 'dsh-board__column',
          'data-status': status,
          onDragOver: (event) => {
            if (event !== null && event !== undefined && typeof event.preventDefault === 'function') event.preventDefault()
          },
          onDrop: () => { actions.dropOn(status) },
        },
        h('header', { className: 'dsh-board__columnHead' },
          h('span', { className: 'dsh-board__dot', 'data-tone': taskToneOf({ status, blocked: false }), 'aria-hidden': true }),
          h('span', { className: 'dsh-board__columnTitle' }, t('status.' + status)),
          h('span', { className: 'dsh-board__count' }, String(items.length))),
        h('div', { className: 'dsh-board__cards' },
          items.length === 0
            ? h('p', { className: 'dsh-board__columnEmpty' }, t('column.empty'))
            : items.map(renderTaskCard)))
      })

      const memoryItems = project.memory.slice().sort((left, right) => right.createdAt - left.createdAt)
      const memoryRows = memoryItems.map(entry => h(MemoryItem, {
        key: entry.id,
        entry,
        t,
        linkedTitle: entry.taskId === '' ? '' : (titleById[entry.taskId] || ''),
        onDelete: () => { actions.deleteMemory(entry.id) },
        onSave: (text) => { actions.updateMemory(entry.id, text) },
      }))

      const linkOptions = project.tasks.map(task => h('option', { key: task.id, value: task.id }, task.title))

      return h('section', { className: 'dsh-board__detail' },
        h('div', { className: 'dsh-board__hero' },
          h('div', { className: 'dsh-board__projectTitleRow' },
            h('input', {
              className: 'dsh-board__projectTitle',
              type: 'text',
              value: project.name,
              'aria-label': t('detail.name'),
              placeholder: t('detail.untitled'),
              title: t('detail.name'),
              onChange: (event) => { actions.renameProject(event.target.value) },
              onBlur: (event) => {
                if (event.target.value.trim() === '') actions.renameProject(t('detail.untitled'))
              },
            }),
            h('button', {
              type: 'button',
              className: 'dsh-board__ghost',
              onClick: () => { actions.deleteProject() },
            }, t('detail.deleteProject'))),
          h('div', { className: 'dsh-board__acceptanceRow' },
            h('span', { className: 'dsh-board__sectionHint' }, t('project.acceptance')),
            h('select', {
              className: 'dsh-board__select dsh-board__select--compact',
              value: project.acceptanceMode === 'human' ? 'human' : 'auto',
              'aria-label': t('project.acceptance'),
              onChange: (event) => { actions.setAcceptance(event.target.value) },
            },
            h('option', { value: 'auto' }, t('project.acceptanceAuto')),
            h('option', { value: 'human' }, t('project.acceptanceHuman'))),
            h('span', { className: 'dsh-board__sectionHint' },
              project.acceptanceMode === 'human' ? t('project.acceptanceHumanHint') : t('project.acceptanceAutoHint'))),
          project.acceptanceMode === 'human'
            ? null
            : h('div', { className: 'dsh-board__rules' },
              h('span', { className: 'dsh-board__sectionHint' }, t('rules.title')),
              ...['requireEvidence', 'requireDeliverables', 'verifyDeliverables', 'requireSession'].map(key =>
                h('label', { className: 'dsh-board__ruleLabel', key },
                  h('input', {
                    type: 'checkbox',
                    checked: project.acceptanceRules[key] === true,
                    'aria-label': t('rules.' + key),
                    onChange: (event) => { actions.setRule(key, event.target.checked) },
                  }),
                  h('span', null, t('rules.' + key)))),
              project.acceptanceRules.verifyDeliverables === true
                ? h('div', { className: 'dsh-board__rootDirRow' },
                  h('input', {
                    className: 'dsh-board__input dsh-board__input--compact',
                    type: 'text',
                    value: project.rootDir,
                    placeholder: t('rules.rootDir'),
                    'aria-label': t('rules.rootDir'),
                    title: t('rules.rootDirHint'),
                    onChange: (event) => { actions.setRootDir(event.target.value) },
                  }))
                : null),
          h(ProgressSummary, { project, t }),
          h('div', { className: 'dsh-board__stats' },
            h('span', { className: 'dsh-board__stat' },
              String(project.tasks.length) + ' ' + t('rail.countUnit')),
            h('span', { className: 'dsh-board__stat', 'data-tone': 'green' },
              t('task.done') + ' ' + String(counts.done)),
            counts.blocked === 0
              ? null
              : h('span', { className: 'dsh-board__stat', 'data-tone': 'red' },
                t('task.blocked') + ' ' + String(counts.blocked)),
            counts.running === 0
              ? null
              : h('span', { className: 'dsh-board__stat', 'data-tone': 'business' },
                t('task.running') + ' ' + String(counts.running)))),
        h('div', { className: 'dsh-board__card' },
          h('div', { className: 'dsh-board__sectionHead' },
            h('span', { className: 'dsh-board__sectionTitle' }, t('references.section')),
            h('span', { className: 'dsh-board__sectionHint' }, t('references.hint'))),
          h('form', { className: 'dsh-board__form', onSubmit: addReference },
            h('select', {
              className: 'dsh-board__select dsh-board__select--compact',
              value: referenceDraft.kind,
              'aria-label': t('references.kind'),
              title: t('references.kind'),
              onChange: (event) => { setReferenceDraft({ ...referenceDraft, kind: event.target.value }) },
            },
            h('option', { value: 'link' }, t('references.kindLink')),
            h('option', { value: 'note' }, t('references.kindNote'))),
            h('input', {
              className: 'dsh-board__input dsh-board__input--compact',
              type: 'text',
              value: referenceDraft.name,
              placeholder: t('references.name'),
              'aria-label': t('references.name'),
              onChange: (event) => { setReferenceDraft({ ...referenceDraft, name: event.target.value }) },
            }),
            referenceDraft.kind === 'note'
              ? h('textarea', {
                className: 'dsh-board__shared',
                rows: 3,
                value: referenceDraft.value,
                placeholder: t('references.noteValue'),
                'aria-label': t('references.noteValue'),
                onChange: (event) => { setReferenceDraft({ ...referenceDraft, value: event.target.value }) },
              })
              : h('input', {
                className: 'dsh-board__input dsh-board__input--compact',
                type: 'text',
                value: referenceDraft.value,
                placeholder: t('references.linkValue'),
                'aria-label': t('references.linkValue'),
                onChange: (event) => { setReferenceDraft({ ...referenceDraft, value: event.target.value }) },
              }),
            h('input', {
              className: 'dsh-board__input dsh-board__input--compact',
              type: 'text',
              value: referenceDraft.description,
              placeholder: t('references.description'),
              'aria-label': t('references.description'),
              onChange: (event) => { setReferenceDraft({ ...referenceDraft, description: event.target.value }) },
            }),
            h('button', { type: 'submit', className: 'dsh-board__ghost' }, t('references.add'))),
          project.references.length === 0
            ? h('p', { className: 'dsh-board__empty' }, t('references.empty'))
            : h('div', { className: 'dsh-board__memoryList' },
              project.references.map(reference => h('div', { key: reference.id, className: 'dsh-board__memoryItem' },
                editingReferenceId === reference.id
                  ? h('form', { className: 'dsh-board__form', onSubmit: saveReferenceEdit },
                    h('select', {
                      className: 'dsh-board__select dsh-board__select--compact',
                      value: referenceEditDraft.kind,
                      'aria-label': t('references.kind'),
                      title: t('references.kind'),
                      onChange: (event) => { setReferenceEditDraft({ ...referenceEditDraft, kind: event.target.value }) },
                    },
                    h('option', { value: 'link' }, t('references.kindLink')),
                    h('option', { value: 'note' }, t('references.kindNote'))),
                    h('input', {
                      className: 'dsh-board__input dsh-board__input--compact',
                      type: 'text',
                      value: referenceEditDraft.name,
                      placeholder: t('references.name'),
                      'aria-label': t('references.name'),
                      onChange: (event) => { setReferenceEditDraft({ ...referenceEditDraft, name: event.target.value }) },
                    }),
                    referenceEditDraft.kind === 'note'
                      ? h('textarea', {
                        className: 'dsh-board__shared',
                        rows: 3,
                        value: referenceEditDraft.value,
                        placeholder: t('references.noteValue'),
                        'aria-label': t('references.noteValue'),
                        onChange: (event) => { setReferenceEditDraft({ ...referenceEditDraft, value: event.target.value }) },
                      })
                      : h('input', {
                        className: 'dsh-board__input dsh-board__input--compact',
                        type: 'text',
                        value: referenceEditDraft.value,
                        placeholder: t('references.linkValue'),
                        'aria-label': t('references.linkValue'),
                        onChange: (event) => { setReferenceEditDraft({ ...referenceEditDraft, value: event.target.value }) },
                      }),
                    h('input', {
                      className: 'dsh-board__input dsh-board__input--compact',
                      type: 'text',
                      value: referenceEditDraft.description,
                      placeholder: t('references.description'),
                      'aria-label': t('references.description'),
                      onChange: (event) => { setReferenceEditDraft({ ...referenceEditDraft, description: event.target.value }) },
                    }),
                    h('button', { type: 'submit', className: 'dsh-board__ghost' }, t('references.save')),
                    h('button', { type: 'button', className: 'dsh-board__ghost', onClick: cancelReferenceEdit }, t('references.cancel')))
                  : [
                    h('span', { key: 'chip', className: 'dsh-board__chip' },
                      reference.kind === 'note' ? t('references.kindNote') : t('references.kindLink')),
                    h('span', { key: 'text', className: 'dsh-board__memoryText' },
                      reference.value === '' ? reference.name : reference.name + '：' + reference.value),
                    reference.description === ''
                      ? null
                      : h('span', { key: 'desc', className: 'dsh-board__sectionHint' }, reference.description),
                    reference.kind === 'link' && reference.staleSince > 0
                      ? h('span', { key: 'stale', className: 'dsh-board__badge', 'data-tone': 'warn' }, t('task.staleRef'))
                      : null,
                    h('button', {
                      key: 'edit',
                      type: 'button',
                      className: 'dsh-board__delete',
                      'aria-label': t('references.edit'),
                      title: t('references.edit'),
                      onClick: () => { startReferenceEdit(reference) },
                    }, '\u270e'),
                    h('button', {
                      key: 'delete',
                      type: 'button',
                      className: 'dsh-board__delete',
                      'aria-label': t('references.delete'),
                      title: t('references.delete'),
                      onClick: () => { actions.removeReference(reference.id) },
                    }, '\u00d7'),
                  ]))),
          h('button', {
            type: 'button',
            className: 'dsh-board__ghost',
            onClick: () => { actions.recheck() },
          }, t('board.recheck'))),
        h('div', { className: 'dsh-board__card' },
          h('div', { className: 'dsh-board__sectionHead' },
            h('span', { className: 'dsh-board__sectionTitle' }, t('archive.title')),
            h('span', { className: 'dsh-board__sectionHint' },
              String(projectArchive.reduce((total, entry) => total + entry.tasks.length, 0)) + ' ' + t('archive.count'))),
          projectArchive.length === 0
            ? h('p', { className: 'dsh-board__empty' }, t('archive.empty'))
            : h('div', null,
              projectArchive.map(entry => h('div', { key: entry.projectId, className: 'dsh-board__memoryItem' },
                h('span', { className: 'dsh-board__chip' }, entry.tasks.length + ' ' + t('archive.count')),
                h('div', { className: 'dsh-board__archiveList' },
                  entry.tasks.map(task => h('div', { key: task.id, className: 'dsh-board__archiveRow' },
                    h('span', { className: 'dsh-board__memoryText' }, task.title),
                    h('button', {
                      type: 'button',
                      className: 'dsh-board__ghost',
                      'aria-label': t('archive.restore'),
                      onClick: () => { actions.restoreTask(entry.projectId, task.id) },
                    }, t('archive.restore'))))))))),
        h('div', { className: 'dsh-board__card' },
          h('div', { className: 'dsh-board__sectionHead' },
            h('span', { className: 'dsh-board__sectionTitle' }, t('task.section')),
            h('span', { className: 'dsh-board__sectionHint' },
              String(project.tasks.length) + ' ' + t('rail.countUnit') + ' · ' + t('task.sectionHint'))),
          h('form', { className: 'dsh-board__form', onSubmit: addTask },
            h('input', {
              className: 'dsh-board__input',
              type: 'text',
              value: describeDraft,
              placeholder: t('task.describe'),
              'aria-label': t('task.describe'),
              onChange: (event) => { setDescribeDraft(event.target.value) },
            }),
            h('button', { type: 'submit', className: 'dsh-board__primary' }, t('task.add'))),
          project.tasks.length === 0
            ? h('p', { className: 'dsh-board__empty' }, t('task.empty'))
            : h('div', null,
              h('div', { className: 'dsh-board__filters' },
                h('input', {
                  className: 'dsh-board__input dsh-board__input--compact',
                  type: 'text',
                  value: filterText,
                  placeholder: t('filter.search'),
                  'aria-label': t('filter.search'),
                  onChange: (event) => { setFilterText(event.target.value) },
                }),
                h('select', {
                  className: 'dsh-board__select dsh-board__select--compact',
                  value: filterMode,
                  'aria-label': t('filter.all'),
                  onChange: (event) => { setFilterMode(event.target.value) },
                },
                h('option', { value: 'all' }, t('filter.all')),
                h('option', { value: 'overdue' }, t('filter.overdue')),
                h('option', { value: 'blocked' }, t('filter.blocked'))),
                (filterText === '' && filterMode === 'all')
                  ? null
                  : h('button', {
                    type: 'button',
                    className: 'dsh-board__ghost',
                    onClick: () => { setFilterText(''); setFilterMode('all') },
                  }, t('filter.clear')),
                (filterText === '' && filterMode === 'all')
                  ? null
                  : h('span', { className: 'dsh-board__sectionHint' }, fill(t('filter.result'), String(visibleTasks.length)))),
              visibleTasks.length === 0
                ? h('p', { className: 'dsh-board__empty' }, t('filter.none'))
                : h('div', { className: 'dsh-board__columns' }, columns))),
        project.trash.length === 0
          ? null
          : h('div', { className: 'dsh-board__card' },
            h('div', { className: 'dsh-board__sectionHead' },
              h('span', { className: 'dsh-board__sectionTitle' }, t('trash.section')),
              h('span', { className: 'dsh-board__sectionHint' },
                fill(t('trash.hintCount'), String(project.trash.length))),
              h('button', {
                type: 'button',
                className: 'dsh-board__ghost dsh-board__ghost--danger',
                onClick: () => { actions.purgeTrash() },
              }, t('trash.purge'))),
            h('div', { className: 'dsh-board__memoryList' },
              project.trash.map(record => h('div', { key: record.task.id, className: 'dsh-board__memoryItem' },
                h('span', { className: 'dsh-board__chip' }, t('status.' + record.task.status)),
                h('span', { className: 'dsh-board__memoryText' }, record.task.title),
                h('button', {
                  type: 'button',
                  className: 'dsh-board__ghost',
                  onClick: () => { actions.restoreTask(record.task.id) },
                }, t('trash.restore')))))),
        h('div', { className: 'dsh-board__card' },
          h('div', { className: 'dsh-board__sectionHead' },
            h('span', { className: 'dsh-board__sectionTitle' }, t('memory.section')),
            h('span', { className: 'dsh-board__sectionHint' }, t('memory.hint'))),
          h('form', { className: 'dsh-board__form', onSubmit: addMemory },
            h('input', {
              className: 'dsh-board__input',
              type: 'text',
              value: memoryDraft,
              placeholder: t('memory.placeholder'),
              'aria-label': t('memory.section'),
              onChange: (event) => { setMemoryDraft(event.target.value) },
            }),
            h('select', {
              className: 'dsh-board__select',
              value: memoryLink,
              'aria-label': t('memory.link'),
              title: t('memory.link'),
              onChange: (event) => { setMemoryLink(event.target.value) },
            },
            h('option', { value: '' }, t('memory.noLink')),
            linkOptions),
            h('button', { type: 'submit', className: 'dsh-board__primary' }, t('memory.add'))),
          memoryRows.length === 0
            ? h('p', { className: 'dsh-board__empty' }, t('memory.empty'))
            : h('div', { className: 'dsh-board__memoryList' }, memoryRows)))
    }

    /**
     * The board page: project rail, project detail, and local persistence.
     * @param props - the locale `t` seat, the close callback, and the Host services the page uses.
     * @returns the page element.
     */
    function GreenlightPage({ t, closeBoard, services }) {
      const [projects, commit, sync] = useBoard()

      // Cold storage is not polled; it is read once per page open.
      React.useEffect(() => {
        if (sync.loadArchive !== undefined) void sync.loadArchive()
      }, [sync.loadArchive])
      const [selectedId, setSelectedId] = React.useState('')
      const [projectDraft, setProjectDraft] = React.useState('')
      const [missingProjectName, setMissingProjectName] = React.useState(false)
      const projectInputRef = React.useRef(null)
      const dragRef = React.useRef(null)
      const undoTimerRef = React.useRef(null)
      const importRef = React.useRef(null)
      const actionsRef = React.useRef(null)
      const autoBusyRef = React.useRef(false)
      const [undo, setUndo] = React.useState(null)
      const [autoOn, setAutoOn] = React.useState(readAutoFlag)
      const [railCollapsed, setRailCollapsed] = React.useState(readRailCollapsed)
      const toggleRail = React.useCallback(() => {
        setRailCollapsed(previous => {
          writeRailCollapsed(!previous)
          return !previous
        })
      }, [])
      // A pending destructive action, rendered as a modal until answered.
      const [confirming, setConfirming] = React.useState(null)
      /**
       * Ask before doing something that cannot be undone by accident.
       * @param spec - `{ title, body, confirmLabel, tone, options, onConfirm }`.
       */
      const askConfirm = (spec) => { setConfirming(spec) }
      const answerConfirm = (accepted) => {
        const pending = confirming
        setConfirming(null)
        if (accepted && pending !== null && typeof pending.onConfirm === 'function') pending.onConfirm()
      }
      const sessionsSnapshot = useSessionsSnapshot(services === undefined ? undefined : services.sessions)

      const selected = React.useMemo(() => {
        for (let index = 0; index < projects.length; index += 1) {
          if (projects[index].id === selectedId) return projects[index]
        }
        return projects.length > 0 ? projects[0] : null
      }, [projects, selectedId])

      const replaceProject = React.useCallback((projectId, updater) => {
        commit(projects.map(project => (project.id === projectId ? updater(project) : project)))
      }, [commit, projects])

      const addProject = (event) => {
        event.preventDefault()
        const name = projectDraft.trim()
        if (name === '') {
          setMissingProjectName(true)
          if (projectInputRef.current !== null) projectInputRef.current.focus()
          return
        }
        setMissingProjectName(false)
        const project = { id: createId('p'), name, references: [], tasks: [], memory: [], createdAt: Date.now() }
        commit(projects.concat([project]))
        sync.enqueue([{ type: 'project.add', id: project.id, name }])
        setProjectDraft('')
        setSelectedId(project.id)
      }

      const selectedProjectId = selected === null ? '' : selected.id

      /** Drop the undo offer and cancel its timer. */
      const dismissUndo = () => {
        setUndo(null)
        if (undoTimerRef.current !== null) {
          clearTimeout(undoTimerRef.current)
          undoTimerRef.current = null
        }
      }

      /** Offer to restore one deleted card for a short while. @param snapshot - the deleted card and its place. */
      const showUndo = (snapshot) => {
        if (undoTimerRef.current !== null) clearTimeout(undoTimerRef.current)
        setUndo(snapshot)
        undoTimerRef.current = setTimeout(() => {
          setUndo(null)
          undoTimerRef.current = null
        }, UNDO_WINDOW_MS)
      }

      const actions = {
        addClaim: (taskId, claim) => {
          const next = {
            what: claim.what,
            how: claim.how,
            layer: claim.layer,
            outcome: claim.outcome,
            at: Date.now(),
            id: createId('c'),
          }
          // Claims go through their own op so the Host records an audit event
          // and applies the same validation as the agent tools.
          replaceProject(selectedProjectId, project => ({
            ...project,
            tasks: project.tasks.map(entry => (entry.id === taskId
              ? { ...entry, claims: [...entry.claims, next], updatedAt: Date.now() }
              : entry)),
          }))
          sync.enqueue([{ type: 'task.claim', projectId: selectedProjectId, taskId, claim: next }])
        },
        archived: sync.archived,
        renameProject: (value) => {
          if (selectedProjectId === '') return
          replaceProject(selectedProjectId, project => ({ ...project, name: value }))
          sync.enqueue([{ type: 'project.rename', projectId: selectedProjectId, name: value }])
        },
        addReference: (kind, name, value, description) => {
          if (selectedProjectId === '') return
          const reference = {
            id: createId('ref-'),
            kind,
            name,
            value,
            description,
            staleSince: 0,
          }
          replaceProject(selectedProjectId, project => ({
            ...project,
            references: project.references.concat([reference]),
          }))
          sync.enqueue([{
            type: 'reference.add',
            projectId: selectedProjectId,
            id: reference.id,
            kind,
            name,
            value,
            description,
          }])
        },
        updateReference: (referenceId, patch) => {
          if (selectedProjectId === '') return
          replaceProject(selectedProjectId, project => ({
            ...project,
            references: project.references.map(reference => (reference.id === referenceId
              ? { ...reference, ...patch }
              : reference)),
          }))
          sync.enqueue([{ type: 'reference.update', projectId: selectedProjectId, referenceId, patch }])
        },
        setAcceptance: (mode) => {
          if (selectedProjectId === '') return
          const next = mode === 'human' ? 'human' : 'auto'
          replaceProject(selectedProjectId, project => ({ ...project, acceptanceMode: next }))
          sync.enqueue([{ type: 'project.setAcceptance', projectId: selectedProjectId, mode: next }])
        },
        setRule: (key, value) => {
          if (selectedProjectId === '') return
          replaceProject(selectedProjectId, project => ({
            ...project,
            acceptanceRules: { ...project.acceptanceRules, [key]: value },
          }))
          sync.enqueue([{
            type: 'project.setAcceptance',
            projectId: selectedProjectId,
            rules: { [key]: value },
          }])
        },
        setRootDir: (value) => {
          if (selectedProjectId === '') return
          replaceProject(selectedProjectId, project => ({ ...project, rootDir: value }))
          sync.enqueue([{ type: 'project.setAcceptance', projectId: selectedProjectId, rootDir: value }])
        },
        restoreTask: (projectId, taskId) => { if (sync.restoreTask !== undefined) sync.restoreTask(projectId, taskId) },
        recheck: () => {
          if (selectedProjectId === '') return
          sync.enqueue([{ type: 'project.recheck', projectId: selectedProjectId }])
        },
        archiveTask: (taskId) => {
          if (selectedProjectId === '') return
          const project = projects.find(entry => entry.id === selectedProjectId)
          const target = project === undefined ? undefined : project.tasks.find(task => task.id === taskId)
          if (target === undefined) return
          askConfirm({
            title: fill(t('confirm.archiveTask'), target.title),
            body: t('confirm.archiveTaskBody'),
            confirmLabel: t('confirm.archive'),
            onConfirm: () => {
              // Archive mirrors what the Host does: drop the card here, keep it in
              // cold storage there.
              replaceProject(selectedProjectId, entry => ({
                ...entry,
                tasks: entry.tasks.filter(task => task.id !== taskId),
              }))
              sync.enqueue([{ type: 'board.archive', projectId: selectedProjectId, taskIds: [taskId] }])
              if (sync.loadArchive !== undefined) void sync.loadArchive()
            },
          })
        },
        restoreTask: (projectId, taskId) => {
          sync.enqueue([{ type: 'board.restore', projectId, taskIds: [taskId] }])
          if (sync.setArchived !== undefined) {
            sync.setArchived(prev => prev.map(project => (project.projectId === projectId
              ? { ...project, tasks: project.tasks.filter(task => task.id !== taskId) }
              : project)))
          }
        },
        deleteProject: () => {
          if (selected === null) return
          const target = selected
          const taskCount = target.tasks.length
          const memoryCount = target.memory.length
          askConfirm({
            title: fill(t('confirm.deleteProject'), target.name),
            body: t('confirm.deleteProjectBody'),
            options: [
              fill(t('confirm.projectTasks'), String(taskCount)),
              fill(t('confirm.projectMemory'), String(memoryCount)),
            ],
            confirmLabel: t('confirm.delete'),
            tone: 'danger',
            onConfirm: () => {
              const removedId = target.id
              const remaining = projects.filter(project => project.id !== removedId)
              commit(remaining)
              sync.enqueue([{ type: 'project.remove', projectId: removedId }])
              setSelectedId(remaining.length > 0 ? remaining[0].id : '')
            },
          })
        },
        addTask: (title, note) => {
          if (selectedProjectId === '') return
          const task = {
            id: createId('t'),
            title,
            titleSource: 'auto',
            note: note === undefined ? '' : note,
            status: 'todo',
            progress: 0,
            blocked: false,
            sessionId: '',
            createdAt: Date.now(),
            updatedAt: Date.now(),
          }
          replaceProject(selectedProjectId, project => ({ ...project, tasks: project.tasks.concat([task]) }))
          sync.enqueue([{
            type: 'task.add',
            projectId: selectedProjectId,
            id: task.id,
            title: task.title,
            note: task.note,
            titleSource: 'auto',
            status: 'todo',
          }])
        },
        updateTask: (taskId, patch) => {
          if (selectedProjectId === '') return
          replaceProject(selectedProjectId, project => ({
            ...project,
            tasks: project.tasks.map(task => (task.id === taskId
              ? { ...task, ...patch, updatedAt: Date.now() }
              : task)),
          }))
          sync.enqueue([{ type: 'task.patch', projectId: selectedProjectId, taskId, patch }])
        },
        deleteTask: (taskId) => {
          if (selectedProjectId === '') return
          const project = projects.find(entry => entry.id === selectedProjectId)
          if (project === undefined) return
          const index = project.tasks.findIndex(task => task.id === taskId)
          const removed = index < 0 ? undefined : project.tasks[index]
          if (removed === undefined) return
          askConfirm({
            title: fill(t('confirm.deleteTask'), removed.title),
            body: t('confirm.deleteTaskBody'),
            confirmLabel: t('confirm.delete'),
            tone: 'danger',
            onConfirm: () => {
              replaceProject(selectedProjectId, entry => ({
                ...entry,
                tasks: entry.tasks.filter(task => task.id !== taskId),
                memory: entry.memory.map(memoryEntry => (memoryEntry.taskId === taskId ? { ...memoryEntry, taskId: '' } : memoryEntry)),
              }))
              sync.enqueue([{ type: 'task.remove', projectId: selectedProjectId, taskId }])
              showUndo({ projectId: selectedProjectId, task: removed, index })
            },
          })
        },
        undoDelete: () => {
          if (undo === null) return
          const snapshot = undo
          dismissUndo()
          const project = projects.find(entry => entry.id === snapshot.projectId)
          if (project === undefined) return
          const restored = snapshot.task
          const insertAt = Math.max(0, Math.min(snapshot.index, project.tasks.length))
          const nextTasks = project.tasks.slice()
          nextTasks.splice(insertAt, 0, restored)
          commit(projects.map(entry => (entry.id === snapshot.projectId ? { ...entry, tasks: nextTasks } : entry)))
          sync.enqueue([{
            type: 'task.add',
            projectId: snapshot.projectId,
            id: restored.id,
            title: restored.title,
            titleSource: restored.titleSource,
            note: restored.note,
            status: restored.status,
            progress: restored.progress,
            blocked: restored.blocked,
            reviewReason: restored.reviewReason,
            sessionId: restored.sessionId,
            workspaceId: restored.workspaceId,
            agentPreset: restored.agentPreset,
            createdAt: restored.createdAt,
          }])
        },
        dragStart: (taskId, status) => {
          dragRef.current = { taskId, status }
        },
        dropOn: (status) => {
          const drag = dragRef.current
          dragRef.current = null
          if (drag === null || selectedProjectId === '') return
          if (drag.status === status) return
          actions.moveTask(drag.taskId, drag.status, status)
        },
        removeReference: (referenceId) => {
          if (selectedProjectId === '') return
          const project = projects.find(entry => entry.id === selectedProjectId)
          const target = project === undefined ? undefined : project.references.find(entry => entry.id === referenceId)
          if (target === undefined) return
          askConfirm({
            title: fill(t('confirm.deleteRef'), target.name),
            body: target.value === '' ? t('confirm.deleteRefBody') : target.value,
            confirmLabel: t('confirm.delete'),
            tone: 'danger',
            onConfirm: () => {
              replaceProject(selectedProjectId, entry => ({
                ...entry,
                references: entry.references.filter(item => item.id !== referenceId),
                tasks: entry.tasks.map(task => ({ ...task, refs: task.refs.filter(ref => ref !== referenceId) })),
              }))
              sync.enqueue([{ type: 'reference.remove', projectId: selectedProjectId, referenceId }])
            },
          })
        },
        restoreTask: (taskId) => {
          if (selectedProjectId === '') return
          const project = projects.find(entry => entry.id === selectedProjectId)
          if (project === undefined) return
          const record = project.trash.find(entry => entry.task.id === taskId)
          if (record === undefined) return
          replaceProject(selectedProjectId, entry => {
            const tasks = entry.tasks.slice()
            const at = Math.max(0, Math.min(record.index, tasks.length))
            tasks.splice(at, 0, record.task)
            return { ...entry, tasks, trash: entry.trash.filter(candidate => candidate !== record) }
          })
          sync.enqueue([{ type: 'task.restore', projectId: selectedProjectId, taskId }])
        },
        purgeTrash: () => {
          if (selectedProjectId === '') return
          askConfirm({
            title: t('confirm.purgeTrash'),
            body: t('confirm.purgeTrashBody'),
            confirmLabel: t('confirm.purge'),
            tone: 'danger',
            onConfirm: () => {
              replaceProject(selectedProjectId, project => ({ ...project, trash: [] }))
              sync.enqueue([{ type: 'trash.purge', projectId: selectedProjectId, all: true }])
            },
          })
        },
        exportBoard: () => {
          const document = serializeProjects(projects)
          try {
            if (typeof Blob !== 'function' || typeof URL === 'undefined' || typeof URL.createObjectURL !== 'function') return
            const blob = new Blob([document], { type: 'application/json' })
            const url = URL.createObjectURL(blob)
            const anchor = window.document.createElement('a')
            anchor.href = url
            anchor.download = 'greenlight.json'
            anchor.click()
            URL.revokeObjectURL(url)
          } catch (error) {
            /* exporting is a convenience; the Host document remains the source */
          }
        },
        importBoard: (text) => {
          let document
          try {
            document = JSON.parse(text)
          } catch (error) {
            throw new Error(t('import.failed'))
          }
          const imported = parseProjects(JSON.stringify(document))
          if (imported.length === 0) throw new Error(t('import.failed'))
          askConfirm({
            title: t('confirm.import'),
            body: t('confirm.importBody'),
            options: [fill(t('confirm.importCount'), String(imported.length))],
            confirmLabel: t('confirm.importAction'),
            tone: 'danger',
            onConfirm: () => {
              commit(imported)
              setSelectedId(imported[0].id)
              sync.enqueue([{ type: 'board.replace', document: { version: DOC_VERSION, projects: imported } }])
            },
          })
        },
        toggleAuto: () => {
          const next = !autoOn
          setAutoOn(next)
          writeAutoFlag(next)
        },
        moveTask: (taskId, expectedStatus, targetStatus) => {
          if (selectedProjectId === '') return
          const project = projects.find(entry => entry.id === selectedProjectId)
          const task = project === undefined ? undefined : project.tasks.find(entry => entry.id === taskId)
          if (task === undefined) return
          const next = targetStatus === undefined ? nextStatusOf(task.status) : targetStatus
          if (next === '') return
          const patch = { status: next }
          if (next === 'done') patch.progress = 100
          replaceProject(selectedProjectId, entry => ({
            ...entry,
            tasks: entry.tasks.map(item => (item.id === taskId ? { ...item, ...patch, updatedAt: Date.now() } : item)),
          }))
          sync.enqueue([{
            type: 'task.move',
            projectId: selectedProjectId,
            taskId,
            status: next,
            expectedStatus,
            ...(patch.progress === undefined ? {} : { progress: patch.progress }),
          }])
        },
        confirmReview: (taskId) => {
          actions.moveTask(taskId, 'review', 'done')
        },
        rejectReview: (taskId, reason) => {
          if (selectedProjectId === '') return
          replaceProject(selectedProjectId, entry => ({
            ...entry,
            tasks: entry.tasks.map(item => (item.id === taskId
              ? { ...item, status: 'failed', reviewReason: reason, updatedAt: Date.now() }
              : item)),
            memory: entry.memory.concat([{
              id: createId('m'),
              text: '打回：' + reason,
              taskId,
              createdAt: Date.now(),
            }]),
          }))
          sync.enqueue([
            { type: 'task.patch', projectId: selectedProjectId, taskId, patch: { status: 'failed', reviewReason: reason } },
            {
              type: 'memory.add',
              projectId: selectedProjectId,
              id: createId('m'),
              text: '打回：' + reason,
              taskId,
            },
          ])
        },
        reopenTask: (taskId) => {
          actions.moveTask(taskId, 'failed', 'todo')
        },
        dispatch: async (taskId) => {
          if (selectedProjectId === '' || services === undefined || services === null) throw new Error('no service')
          const project = projects.find(entry => entry.id === selectedProjectId)
          const task = project === undefined ? undefined : project.tasks.find(entry => entry.id === taskId)
          if (project === undefined || task === undefined) throw new Error('no task')
          if (task.sessionId === '') throw new Error('no session')
          // Pin check: a task pinned to a workspace that is gone must fail
          // before a prompt is sent, never half-run.
          if (task.workspaceId !== '') {
            const workspaces = services.workspaces
            const items = workspaces === undefined || workspaces === null
              ? []
              : (workspaces.list.getSnapshot().items || [])
            const known = items.some(item => item.workspaceId === task.workspaceId)
            if (!known) throw new Error(t('task.dispatchBadWorkspace'))
          }
          const sessions = services.sessions
          if (sessions === undefined || sessions === null) throw new Error('no session service')
          const text = buildDispatchPrompt(task, project)
          const parts = [{ type: 'text', text }]
          const send = async (reference) => {
            await reference.ready
            return reference.binding.session.prompt(parts, 'queue')
          }
          let outcome
          if (typeof sessions.using === 'function') {
            outcome = await sessions.using(task.sessionId, { source: 'greenlight' }, send)
          } else {
            const reference = sessions.retain(task.sessionId, { source: 'greenlight' })
            try {
              outcome = await send(reference)
            } finally {
              reference.release()
            }
          }
          if (outcome !== null && outcome !== undefined && outcome.ok === false) {
            const failure = outcome.error
            throw new Error(failure !== null && failure !== undefined && typeof failure.message === 'string' ? failure.message : 'prompt refused')
          }
          actions.moveTask(taskId, task.status, 'running')
          return true
        },
        createSession: async (taskId) => {
          if (services === undefined || services === null || services.sessions === undefined) return ''
          const workspaceId = preferredWorkspaceId(services.workspaces)
          const request = workspaceId === '' ? {} : { workspaceId }
          const sessionId = await services.sessions.create(request)
          if (typeof sessionId !== 'string' || sessionId === '') return ''
          if (selectedProjectId !== '') {
            const project = projects.find(entry => entry.id === selectedProjectId)
            if (project !== undefined) {
              commit(projects.map(entry => (entry.id !== selectedProjectId ? entry : {
                ...entry,
                tasks: entry.tasks.map(task => (task.id === taskId
                  ? { ...task, sessionId, updatedAt: Date.now() }
                  : task)),
              })))
              sync.enqueue([{ type: 'task.patch', projectId: selectedProjectId, taskId, patch: { sessionId } }])
            }
          }
          if (services.uiWorkspace !== undefined && services.uiWorkspace !== null) {
            services.uiWorkspace.openSession(sessionId)
          }
          return sessionId
        },
        openSession: (sessionId) => {
          if (services === undefined || services === null || services.uiWorkspace === undefined) return
          if (sessionId === '') return
          services.uiWorkspace.openSession(sessionId)
        },
        addMemory: (text, taskId) => {
          if (selectedProjectId === '') return
          const entry = {
            id: createId('m'),
            text,
            taskId: taskId === undefined ? '' : taskId,
            createdAt: Date.now(),
          }
          replaceProject(selectedProjectId, project => ({ ...project, memory: project.memory.concat([entry]) }))
          sync.enqueue([{
            type: 'memory.add',
            projectId: selectedProjectId,
            id: entry.id,
            text: entry.text,
            taskId: entry.taskId,
          }])
        },
        deleteMemory: (entryId) => {
          if (selectedProjectId === '') return
          const project = projects.find(entry => entry.id === selectedProjectId)
          const target = project === undefined ? undefined : project.memory.find(entry => entry.id === entryId)
          if (target === undefined) return
          askConfirm({
            title: t('confirm.deleteMemory'),
            body: target.text.length > 120 ? target.text.slice(0, 120) + '…' : target.text,
            confirmLabel: t('confirm.delete'),
            tone: 'danger',
            onConfirm: () => {
              replaceProject(selectedProjectId, entry => ({
                ...entry,
                memory: entry.memory.filter(memoryEntry => memoryEntry.id !== entryId),
              }))
              sync.enqueue([{ type: 'memory.remove', projectId: selectedProjectId, memoryId: entryId }])
            },
          })
        },
        updateMemory: (entryId, text) => {
          if (selectedProjectId === '') return
          replaceProject(selectedProjectId, project => ({
            ...project,
            memory: project.memory.map(entry => (entry.id === entryId ? { ...entry, text } : entry)),
          }))
          sync.enqueue([{ type: 'memory.patch', projectId: selectedProjectId, memoryId: entryId, text }])
        },
      }

      actionsRef.current = actions

      // Opt-in auto dispatch: one ready card per tick, never two at once.
      React.useEffect(() => {
        if (!autoOn) return undefined
        const timer = setInterval(() => {
          const current = actionsRef.current
          if (current === null || autoBusyRef.current) return
          const project = projects.find(entry => entry.id === selectedId) || projects[0]
          const taskId = pickAutoDispatchTask(project)
          if (taskId === '') return
          autoBusyRef.current = true
          Promise.resolve(current.dispatch(taskId))
            .catch(() => undefined)
            .finally(() => { autoBusyRef.current = false })
        }, AUTO_DISPATCH_MS)
        return () => clearInterval(timer)
      }, [autoOn, projects, selectedId])

      return h('div', { className: 'dsh-board' },
        h('style', { key: 'styles' }, CSS),
        h('header', { className: 'dsh-board__head' },
          h('div', { className: 'dsh-board__headInner' },
            h('div', { className: 'dsh-board__titleRow' },
              h('span', { className: 'dsh-board__mark', 'aria-hidden': true }, h(BoardGlyph, { size: 20 })),
              h('h1', { className: 'dsh-board__title' }, t('page.title')),
              h('button', {
                type: 'button',
                className: 'dsh-board__railToggle',
                'aria-expanded': railCollapsed ? 'false' : 'true',
                'aria-label': railCollapsed ? t('rail.expand') : t('rail.collapse'),
                title: railCollapsed ? t('rail.expand') : t('rail.collapse'),
                onClick: toggleRail,
              }, h(RailGlyph, { size: 18, open: !railCollapsed })),
              h('span', {
                className: 'dsh-board__pill dsh-board__pill--sync',
                'data-tone': syncToneOf(sync.status),
                title: t('sync.' + sync.status),
                role: 'status',
              }, t('sync.' + sync.status)),
              h('button', {
                type: 'button',
                className: 'dsh-board__ghost',
                title: t('auto.hint'),
                'data-active': autoOn ? 'true' : undefined,
                onClick: () => { actions.toggleAuto() },
              }, t('auto.toggle')),
              h('button', {
                type: 'button',
                className: 'dsh-board__ghost',
                onClick: () => { actions.exportBoard() },
              }, t('export.action')),
              h('button', {
                type: 'button',
                className: 'dsh-board__ghost',
                onClick: () => {
                  const input = importRef.current
                  if (input !== null && typeof input.click === 'function') input.click()
                },
              }, t('import.action')),
              h('input', {
                ref: importRef,
                type: 'file',
                accept: 'application/json,.json',
                style: { display: 'none' },
                onChange: (event) => {
                  const file = event.target.files === undefined ? undefined : event.target.files[0]
                  if (file === undefined) return
                  try {
                    if (typeof file.text === 'function') {
                      void file.text().then((text) => {
                        try {
                          actions.importBoard(text)
                        } catch (error) {
                          /* reported through the board's own surface */
                        }
                      })
                    } else if (typeof FileReader === 'function') {
                      const reader = new FileReader()
                      reader.onload = () => {
                        try {
                          actions.importBoard(String(reader.result))
                        } catch (error) {
                          /* reported through the board's own surface */
                        }
                      }
                      reader.readAsText(file)
                    }
                  } catch (error) {
                    /* ignore an unreadable picker result */
                  }
                  event.target.value = ''
                },
              }),
              h('button', {
                type: 'button',
                className: 'dsh-board__back',
                onClick: closeBoard,
              }, t('page.back'))),
            h('p', { className: 'dsh-board__subtitle' }, t('page.subtitle')))),
        sync.recovered
          ? h('p', { className: 'dsh-board__banner', role: 'alert' }, t('sync.recovered'))
          : null,
        sync.stuck > 0
          ? h('div', { className: 'dsh-board__banner dsh-board__banner--conflict', role: 'alert' },
            h('span', null, fill(t('sync.conflictHint'), String(sync.stuck))),
            h('button', {
              type: 'button',
              className: 'dsh-board__ghost',
              onClick: () => { sync.retryStuck() },
            }, t('sync.retry')),
            h('button', {
              type: 'button',
              className: 'dsh-board__ghost',
              onClick: () => {
                askConfirm({
                  title: t('confirm.discard'),
                  body: t('confirm.discardBody'),
                  confirmLabel: t('confirm.discardAction'),
                  tone: 'danger',
                  onConfirm: () => { void sync.discardStuck() },
                })
              },
            }, t('sync.discard')))
          : null,
        h('div', { className: 'dsh-board__body' },
          railCollapsed ? null : h('aside', { className: 'dsh-board__rail' },
            h('div', { className: 'dsh-board__railHead' },
              h('span', { className: 'dsh-board__railTitle' }, t('rail.title')),
              h('span', { className: 'dsh-board__railCount' }, String(projects.length))),
            projects.length === 0
              ? h('p', { className: 'dsh-board__empty' }, t('rail.empty'))
              : h('div', { className: 'dsh-board__railList' },
                projects.map(project => h(ProjectRow, {
                  key: project.id,
                  project,
                  t,
                  active: selected !== null && project.id === selected.id,
                  onSelect: (id) => { setSelectedId(id) },
                }))),
            h('form', { className: 'dsh-board__railForm', onSubmit: addProject },
              h('input', {
                ref: projectInputRef,
                className: 'dsh-board__railInput',
                type: 'text',
                value: projectDraft,
                placeholder: t('rail.new'),
                'aria-label': t('rail.new'),
                onChange: (event) => {
                  setProjectDraft(event.target.value)
                  if (missingProjectName) setMissingProjectName(false)
                },
              }),
              h('button', { type: 'submit', className: 'dsh-board__railGrow', title: t('rail.create'), 'aria-label': t('rail.create') }, '+')),
            missingProjectName
              ? h('p', { className: 'dsh-board__sectionHint', role: 'alert' }, t('rail.missingName'))
              : null),
          selected === null
            ? h('div', { className: 'dsh-board__center' },
              h('p', { className: 'dsh-board__empty' }, t('detail.empty')))
            : h(ProjectDetail, {
              key: selected.id,
              project: selected,
              t,
              actions: { ...actions, archived: sync.archived || [] },
              sessionsSnapshot,
            })),
        undo === null
          ? null
          : h('div', { className: 'dsh-board__toast', role: 'status' },
            h('span', { className: 'dsh-board__toastText' }, fill(t('undo.deleted'), undo.task.title)),
            h('span', { className: 'dsh-board__toastHint' }, t('undo.hint')),
            h('button', {
              type: 'button',
              className: 'dsh-board__primary',
              onClick: () => { actions.undoDelete() },
            }, t('undo.action')),
            h('button', {
              type: 'button',
              className: 'dsh-board__delete',
              'aria-label': t('undo.hint'),
              onClick: dismissUndo,
            }, '\u00d7')),
        confirming === null
          ? null
          : h(ConfirmDialog, {
            spec: confirming,
            t,
            onCancel: () => { answerConfirm(false) },
            onConfirm: () => { answerConfirm(true) },
          }))
    }

    /**
     * A destructive action, held until the user says yes.
     *
     * The board owns cards that are expensive to reconstruct, so every removal
     * passes through this dialog instead of firing on the first click. The
     * backdrop and Escape both cancel; only the explicit button confirms.
     * @param props - `{ spec, t, onCancel, onConfirm }`.
     * @returns the dialog element.
     */
    function ConfirmDialog({ spec, t, onCancel, onConfirm }) {
      React.useEffect(() => {
        const onKey = (event) => {
          if (event !== null && event !== undefined && (event.key === 'Escape' || event.key === 'Esc')) onCancel()
        }
        if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
          window.addEventListener('keydown', onKey)
          return () => { window.removeEventListener('keydown', onKey) }
        }
        return undefined
      }, [onCancel])
      const options = spec.options === undefined ? [] : spec.options
      return h('div', {
        className: 'dsh-board__backdrop',
        role: 'presentation',
        onClick: onCancel,
      },
      h('div', {
        className: 'dsh-board__dialog',
        role: 'dialog',
        'aria-modal': 'true',
        'aria-label': spec.title,
        onClick: (event) => { if (event !== null && typeof event.stopPropagation === 'function') event.stopPropagation() },
      },
      h('p', { className: 'dsh-board__dialogTitle' }, spec.title),
      spec.body === '' ? null : h('p', { className: 'dsh-board__dialogBody' }, spec.body),
      options.length === 0
        ? null
        : h('ul', { className: 'dsh-board__dialogList' },
          options.map((option, index) => h('li', { key: index }, option))),
      h('div', { className: 'dsh-board__dialogActions' },
        h('button', {
          type: 'button',
          className: 'dsh-board__ghost',
          onClick: onCancel,
        }, t('confirm.cancel')),
        h('button', {
          type: 'button',
          className: spec.tone === 'danger' ? 'dsh-board__danger' : 'dsh-board__primary',
          onClick: onConfirm,
        }, spec.confirmLabel))))
    }

    /* ------------------------------------------------------------------ host */

    /**
     * Services this Client entry needs before it activates.
     *
     * Session services are looked up instead of injected: a static `inject`
     * entry for a service the host no longer provides leaves the whole entry
     * stuck pending, which would take the board down on a host upgrade. The
     * board renders without them and only the Session controls degrade.
     */
    const inject = ['slots', 'locale', 'layout']

    /**
     * Register the sidebar entry, the page it opens, and the dictionary, all as
     * effects of this plugin: unloading removes the row and the page, and leaves
     * the Conversation selected when this plugin's page was the current one.
     * @param ctx - the Client root context.
     */
    function apply(ctx) {
      ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'greenlight: dictionaries')
      const t = ctx.locale.bind(NS)
      const optionalService = (name) => {
        try {
          return typeof ctx.get === 'function' ? ctx.get(name) : undefined
        } catch (error) {
          return undefined
        }
      }
      const services = {
        sessions: optionalService('sessions'),
        workspaces: optionalService('workspaces'),
        uiWorkspace: optionalService('uiWorkspace'),
      }

      // Leave this plugin's page on unload, but never reset a page the user chose
      // instead. Layout disposal or a missing main registry must not fail unload.
      ctx.effect(() => () => {
        try {
          if (ctx.layout.panelInfo.getSnapshot().activePanelId === PANEL_ID) ctx.layout.selectPanel(null)
        } catch (error) {
          /* the layout service is already gone */
        }
      }, 'greenlight: leave panel')

      ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
        name: 'sidebar.panellist',
        id: PANEL_ID,
        order: 20,
        label: () => t('panel.label'),
        locale: NS,
      }, SidebarPanelIcon))

      ctx.slots.inject('main', () => ctx.slots.register({
        name: 'main',
        key: PANEL_ID,
        locale: NS,
        inject: () => ({
          closeBoard: () => {
            try {
              ctx.layout.selectPanel(null)
            } catch (error) {
              /* the layout service is already gone */
            }
          },
          services,
        }),
      }, GreenlightPage))
    }

    return { inject, apply }
  },
})
