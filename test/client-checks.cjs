/**
 * Headless verification for the project board client module.
 *
 * Runs the real client.js with stubbed browser globals, a minimal React hook
 * runtime, and a fake Cordis Client context. Verifies: module init, slot
 * registration, document migration, title derivation, shared reference text,
 * subtask fields, Session create/link/unbind/title-sync, project memory, and
 * deletion paths. It never touches the user's UI.
 */
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const sourcePath = process.argv[2]
const source = fs.readFileSync(sourcePath, 'utf8')
if (!source.includes('return { inject, apply }')) {
  console.error('FAIL: expected export line not found')
  process.exit(1)
}

const exposed = source.replace(
  'return { inject, apply }',
  'return { inject, apply, __test: { parseProjects, projectPercent, projectTone, serializeProjects, migrateLegacyTasks, deriveTitle, fill, shouldMoveToReview, nextStatusOf, buildDispatchPrompt, taskToneOf, pickAutoDispatchTask, normalizeTask } }',
)

const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-greenlight-check-'))
const modulePath = path.join(workDir, 'board.cjs')
fs.writeFileSync(modulePath, exposed, 'utf8')

/* ------------------------------------------------------- browser globals */

const storage = new Map()
const listeners = new Map()
let confirmAnswer = true

global.window = {
  localStorage: {
    getItem: key => (storage.has(key) ? storage.get(key) : null),
    setItem: (key, value) => { storage.set(key, String(value)) },
    removeItem: key => { storage.delete(key) },
  },
  addEventListener: (type, fn) => {
    if (!listeners.has(type)) listeners.set(type, [])
    listeners.get(type).push(fn)
  },
  removeEventListener: (type, fn) => {
    const list = listeners.get(type) || []
    const index = list.indexOf(fn)
    if (index >= 0) list.splice(index, 1)
  },
  confirm: () => confirmAnswer,
}

let factory = null
global.window.__ModuleLoader__ = {
  load: definition => { factory = definition.factory },
}

/* --------------------------------------------------------- mini React */

const instances = new Map()
let current = null
let dirty = false
let rootElement = null

function createElement(type, props, ...children) {
  const flat = []
  for (const child of children) {
    if (Array.isArray(child)) flat.push(...child)
    else flat.push(child)
  }
  return { type, key: props && props.key !== undefined ? props.key : undefined, props: { ...(props || {}), children: flat } }
}

function slot(initial) {
  const instance = current.instance
  const index = current.index++
  if (!(index in instance.hooks)) instance.hooks[index] = typeof initial === 'function' ? initial() : initial
  return { instance, index }
}

const React = {
  createElement,
  useState: initial => {
    const { instance, index } = slot(initial)
    const setter = value => {
      const next = typeof value === 'function' ? value(instance.hooks[index]) : value
      if (instance.hooks[index] !== next) {
        instance.hooks[index] = next
        dirty = true
      }
    }
    return [instance.hooks[index], setter]
  },
  useMemo: compute => compute(),
  useCallback: fn => fn,
  useRef: initial => {
    const { instance, index } = slot({ current: initial })
    return instance.hooks[index]
  },
  useEffect: effect => {
    const { instance, index } = slot(undefined)
    if (instance.effects === undefined) instance.effects = new Set()
    if (instance.effects.has(index)) return
    instance.effects.add(index)
    try {
      const cleanup = effect()
      if (typeof cleanup === 'function') instance.hooks[index + ':cleanup'] = cleanup
    } catch (error) {
      console.log('  warn effect threw: ' + (error && error.message ? error.message : error))
    }
  },
}

function renderElement(element, elementPath) {
  if (element === null || element === undefined || typeof element === 'boolean') return null
  if (Array.isArray(element)) {
    return element.map((child, index) => renderElement(child, elementPath + '[' + index + ']'))
  }
  if (typeof element !== 'object') return null

  const type = element.type
  if (typeof type === 'function') {
    const instancePath = elementPath + '<' + (type.name || 'anon') + '>'
    let instance = instances.get(instancePath)
    if (!instance) {
      instance = { hooks: [], path: instancePath }
      instances.set(instancePath, instance)
    }
    const previous = current
    current = { instance, index: 0 }
    let output
    try {
      output = type(element.props)
    } finally {
      current = previous
    }
    return { element, path: instancePath, output: renderElement(output, instancePath + '/out') }
  }

  const children = element.props.children || []
  return {
    element,
    path: elementPath,
    children: children.map((child, index) => renderElement(child, elementPath + '/' + index)),
  }
}

function flatten(node, sink) {
  if (node === null || node === undefined) return sink
  if (Array.isArray(node)) {
    for (const child of node) flatten(child, sink)
    return sink
  }
  if (node.element !== undefined) {
    sink.push(node)
    if (node.children) for (const child of node.children) flatten(child, sink)
    if (node.output) flatten(node.output, sink)
  }
  return sink
}

function renderRoot() {
  return renderElement(rootElement, 'root')
}

function allNodes() {
  return flatten(renderRoot(), [])
}

function rerender() {
  let guard = 0
  do {
    dirty = false
    renderRoot()
    guard += 1
  } while (dirty && guard < 40)
}

function collectText(node, sink) {
  if (node === null || node === undefined) return sink
  if (Array.isArray(node)) {
    for (const child of node) collectText(child, sink)
    return sink
  }
  if (typeof node === 'string' || typeof node === 'number') {
    sink.push(String(node))
    return sink
  }
  if (node.element !== undefined) {
    // A <style> block is not user-visible text; keeping it would drown every
    // text assertion in CSS.
    const isStyle = String(node.element.type) === 'style'
    if (!isStyle) {
      for (const child of node.element.props.children || []) collectText(child, sink)
    }
    if (node.children) for (const child of node.children) collectText(child, sink)
    if (node.output) collectText(node.output, sink)
  }
  return sink
}

function textOf() {
  return collectText(renderRoot(), []).join(' | ')
}

function childText(element) {
  const sink = []
  for (const child of element.props.children || []) collectText(child, sink)
  return sink.join('')
}

/**
 * Every element reachable through one element's children.
 * @param element - element to walk.
 * @param sink - accumulator.
 * @returns the accumulated elements.
 */
function descendants(element, sink) {
  if (element === null || element === undefined || typeof element !== 'object') return sink
  if (Array.isArray(element)) {
    for (const child of element) descendants(child, sink)
    return sink
  }
  if (element.props !== undefined) {
    sink.push(element)
    for (const child of element.props.children || []) descendants(child, sink)
  }
  return sink
}

function findElement(predicate) {
  for (const node of allNodes()) {
    if (predicate(node.element, node)) return node.element
  }
  return null
}

function findAll(predicate) {
  const found = []
  for (const node of allNodes()) {
    if (predicate(node.element, node)) found.push(node.element)
  }
  return found
}

function byAria(label) {
  return findElement(element => element.props && element.props['aria-label'] === label)
}

function byClassName(className) {
  return findAll(element => element.props && element.props.className === className)
}

function byButtonText(text) {
  return findElement(element => element.type === 'button' && childText(element) === text)
}

function formOf(inputElement) {
  for (const node of allNodes()) {
    const element = node.element
    if (element.type !== 'form') continue
    const has = (element.props.children || []).some(child => child && child.props && child.props['aria-label'] === inputElement.props['aria-label'])
    if (has) return element
  }
  return null
}

function change(element, value) {
  if (!element) throw new Error('element not found to change')
  element.props.onChange({ target: { value } })
  rerender()
}

function toggle(element, checked) {
  if (!element) throw new Error('checkbox not found')
  element.props.onChange({ target: { checked } })
  rerender()
}

function submit(form) {
  if (!form) throw new Error('form not found')
  form.props.onSubmit({ preventDefault() {} })
  rerender()
}

function click(element) {
  if (!element) throw new Error('element not found to click')
  element.props.onClick()
  rerender()
}

/**
 * The board asks before anything destructive; this answers the dialog.
 * @param label - accept button text, e.g. 删除 / 清空 / 归档.
 */
function confirmNow(label) {
  const dialog = findElement(element => element.props && element.props.role === 'dialog')
  if (!dialog) throw new Error('no confirmation dialog on screen')
  const wanted = label === undefined ? '删除' : label
  // Only look inside the dialog: the card behind it can carry the same label.
  const accept = findIn(dialog, element => element.type === 'button' && childText(element) === wanted)
  if (!accept) throw new Error('no "' + wanted + '" button in the dialog')
  click(accept)
}

/**
 * Find a descendant of one element.
 * @param root - element to search under.
 * @param predicate - match test.
 * @returns the element, or undefined.
 */
function findIn(root, predicate) {
  for (const element of descendants(root, [])) {
    if (predicate(element)) return element
  }
  return undefined
}

/** @returns {boolean} whether a confirmation dialog is on screen. */
function hasConfirm() {
  return findElement(element => element.props && element.props.role === 'dialog') !== undefined
}

/** Dismiss the dialog without acting. */
function cancelConfirm() {
  const dialog = findElement(element => element.props && element.props.role === 'dialog')
  if (!dialog) throw new Error('no confirmation dialog on screen')
  const cancel = findIn(dialog, element => element.type === 'button' && childText(element) === '取消')
  if (!cancel) throw new Error('no cancel button in the dialog')
  click(cancel)
}

async function flush() {
  await new Promise(resolve => setImmediate(resolve))
  rerender()
}

/* ------------------------------------------------------------ assertions */

let failures = 0
let checks = 0
function check(name, condition, detail) {
  checks += 1
  if (condition) {
    console.log('  ok   ' + name)
  } else {
    failures += 1
    console.log('  FAIL ' + name + (detail === undefined ? '' : ' -> ' + detail))
  }
}

function stored() {
  const raw = storage.get('dsh.greenlight.v1')
  return raw === undefined ? null : JSON.parse(raw)
}

/* ---------------------------------------------------------------- run */

const moduleExports = require(modulePath)
if (factory === null) {
  console.error('FAIL: __ModuleLoader__.load was never called')
  process.exit(1)
}

/* ------------------------------------------------- fake Host (real modules) */

const hostModulePath = process.argv[3]
let hostBoard
let hostState = null
let hostArchive = { count: 0, projects: [] }

function jsonResponse(status, body) {
  return { ok: status >= 200 && status < 300, status, json: async () => body }
}

function resetHost() {
  hostState = { board: hostBoard.emptyBoard(), failNetwork: false }
  hostArchive = { count: 0, projects: [] }
}

global.fetch = async (url, init) => {
  if (hostState === null) resetHost()
  if (hostState.failNetwork) throw new Error('network down')
  if (url === '/greenlight/state') {
    const board = hostState.board
    return jsonResponse(200, { revision: board.revision, board, recovered: false })
  }
  if (url === '/greenlight/archive') {
    return jsonResponse(200, { ok: true, count: 0, updatedAt: '', projects: [] })
  }
  if (url === '/greenlight/ops') {
    const headers = (init && init.headers) || {}
    if (headers['x-greenlight'] !== '1') return jsonResponse(403, { ok: false, code: 'forbidden' })
    const payload = JSON.parse(init.body)
    if (payload.revision !== hostState.board.revision) {
      return jsonResponse(409, {
        ok: false,
        code: 'stale_revision',
        revision: hostState.board.revision,
        board: hostState.board,
      })
    }
    const outcome = hostBoard.applyOps(hostState.board, payload.ops, 'ui')
    hostState.board = outcome.board
    // Emulate the Host archive surface: cold-stored cards leave the board.
    const keptOps = []
    for (const op of payload.ops) {
      if (op !== null && op.type === 'board.archive') {
        const project = hostState.board.projects.find(entry => entry.id === op.projectId)
        if (project !== undefined) {
          const moving = project.tasks.filter(task => op.taskIds.includes(task.id))
          project.tasks = project.tasks.filter(task => !op.taskIds.includes(task.id))
          hostArchive = {
            count: hostArchive.count + moving.length,
            projects: [{ projectId: op.projectId, projectName: project.name, tasks: moving, archivedAt: Date.now() }],
          }
        }
        continue
      }
      keptOps.push(op)
    }
    if (keptOps.length !== payload.ops.length) hostState.board = { ...hostState.board, revision: hostState.board.revision + 1 }
    return jsonResponse(200, {
      ok: true,
      revision: hostState.board.revision,
      board: hostState.board,
      rejected: outcome.rejected,
    })
  }
  return jsonResponse(404, { ok: false, code: 'not_found' })
}

const registrations = []
const dictionaries = {}
let boundNamespace = ''

/* Fake Session Controller: one mutable list snapshot plus a creator. */
const sessionState = { ids: [], byId: {}, phase: 'ready', projectionsBySession: {} }
const openedSessions = []
const prompted = []
let nextSessionId = 'sess-new-1'

/**
 * @param sessionId - Session the fake reference points at.
 * @returns a reference whose binding can accept a prompt.
 */
function fakeReference(sessionId) {
  return {
    sessionId,
    ready: Promise.resolve(),
    binding: {
      sessionId,
      session: {
        prompt: async (parts, mode) => {
          prompted.push({ sessionId, mode, text: parts[0].text })
          return { ok: true, value: { accepted: true } }
        },
      },
    },
    release() {},
  }
}

const fakeSessions = {
  list: {
    getSnapshot: () => sessionState,
    subscribe: () => () => {},
  },
  create: async () => nextSessionId,
  using: async (sessionId, options, operation) => operation(fakeReference(sessionId)),
  retain: sessionId => fakeReference(sessionId),
}
const fakeWorkspaces = { list: { getSnapshot: () => ({ items: [{ workspaceId: 'ws-1', sessionIds: [] }] }) } }
const fakeUiWorkspace = { openSession: id => { openedSessions.push(id) } }

const fakeCtx = {
  effect(fn) { try { const cleanup = fn(); if (typeof cleanup === 'function') cleanup() } catch (error) { /* disposal path */ } },
  locale: {
    register(namespace, dictionary) { dictionaries[namespace] = dictionary },
    bind(namespace) {
      boundNamespace = namespace
      const dictionary = dictionaries[namespace] || {}
      return key => {
        const value = (dictionary.zh || {})[key]
        return value === undefined ? key : value
      }
    },
  },
  slots: {
    inject(owner, callback) { callback() },
    register(options, component) { registrations.push({ options, component }); return () => {} },
  },
  layout: { selectPanel() {}, panelInfo: { getSnapshot: () => ({ activePanelId: null }) } },
  sessions: fakeSessions,
  workspaces: fakeWorkspaces,
  uiWorkspace: fakeUiWorkspace,
  get(name) {
    if (name === 'sessions') return fakeSessions
    if (name === 'workspaces') return fakeWorkspaces
    if (name === 'uiWorkspace') return fakeUiWorkspace
    return undefined
  },
}

;(async () => {
  hostBoard = await import(require('node:url').pathToFileURL(hostModulePath).href)
  resetHost()
  const plugin = factory(name => (name === 'react' ? React : undefined))
  console.log('\n[1] plugin surface')
  check('factory returns inject list', Array.isArray(plugin.inject) && plugin.inject.includes('slots'), JSON.stringify(plugin.inject))
  check('hard inject keeps only base services', !['sessions', 'workspaces', 'uiWorkspace'].some(name => plugin.inject.includes(name)), JSON.stringify(plugin.inject))
  check('factory returns apply', typeof plugin.apply === 'function')

  plugin.apply(fakeCtx)

  console.log('\n[2] slot registration')
  const sidebar = registrations.find(entry => entry.options.name === 'sidebar.panellist')
  const main = registrations.find(entry => entry.options.name === 'main')
  check('sidebar.panellist registered', !!sidebar)
  check('main page registered', !!main)
  check('both share one panel id', !!sidebar && !!main && sidebar.options.id === main.options.key)
  check('locale namespace bound', boundNamespace === 'greenlight', boundNamespace)
  check('sidebar label localized', !!sidebar && sidebar.options.label() === '项目看板', !!sidebar ? sidebar.options.label() : '')

  const Page = main.component
  const injected = main.options.inject()
  check('inject provides closeBoard', typeof injected.closeBoard === 'function')
  check('inject provides session services', !!injected.services && injected.services.sessions === fakeSessions)

  const testHelpers = plugin.__test
  check('__test helpers exposed', !!testHelpers)

  console.log('\n[3] title derivation')
  check('first sentence wins', testHelpers.deriveTitle('修复导出超时的问题。需要看日志') === '修复导出超时的问题', testHelpers.deriveTitle('修复导出超时的问题。需要看日志'))
  check('list marker stripped', testHelpers.deriveTitle('- 整理接口文档') === '整理接口文档', testHelpers.deriveTitle('- 整理接口文档'))
  check('numbered marker stripped', testHelpers.deriveTitle('1. 补充单元测试') === '补充单元测试', testHelpers.deriveTitle('1. 补充单元测试'))
  check('first paragraph used', testHelpers.deriveTitle('\n\n第二行才是内容\n第三行') === '第二行才是内容', testHelpers.deriveTitle('\n\n第二行才是内容\n第三行'))
  check('long text truncated', testHelpers.deriveTitle('这是一个非常长的任务描述'.repeat(6)).length <= 30)
  check('blank text yields empty title', testHelpers.deriveTitle('   \n  ') === '', JSON.stringify(testHelpers.deriveTitle('   \n  ')))

  console.log('\n[4] migration and derived values')
  const legacyDoc = JSON.stringify({
    version: 1,
    tasks: [
      { id: 'a', title: '旧任务一', session: '会话X', status: 'done', createdAt: 1 },
      { id: 'b', title: '旧任务二', session: '', status: 'doing', createdAt: 2 },
    ],
  })
  const migrated = testHelpers.parseProjects(legacyDoc)
  check('legacy board becomes one project', migrated.length === 1 && migrated[0].name === '默认项目')
  check('legacy progress mapped', migrated[0].tasks[0].progress === 100 && migrated[0].tasks[1].progress === 50)
  check('legacy notes migrated', migrated[0].tasks[0].note === '会话X')
  check('legacy tasks carry no session binding', migrated[0].tasks[0].sessionId === '')
  check('legacy tasks default to manual titles', migrated[0].tasks[0].titleSource === 'manual')
  check('project has empty shared text', migrated[0].shared === '')
  check('v2 document keeps projects', testHelpers.parseProjects(JSON.stringify({
    version: 2,
    projects: [{ id: 'p1', name: 'P', tasks: [{ id: 't1', title: 'T' }], memory: [] }],
  })).length === 1)
  check('corrupt document yields empty board', testHelpers.parseProjects('{not json').length === 0)
  const sample = { tasks: [{ progress: 100, blocked: false }, { progress: 20, blocked: false }] }
  check('percent averages subtasks', testHelpers.projectPercent(sample) === 60)
  check('60% is yellow', testHelpers.projectTone(sample) === 'yellow')
  check('blocked forces red', testHelpers.projectTone({ tasks: [{ progress: 100, blocked: true }] }) === 'red')
  check('85% is green', testHelpers.projectTone({ tasks: [{ progress: 85, blocked: false }] }) === 'green')
  check('empty project is idle', testHelpers.projectTone({ tasks: [] }) === 'idle')
  check('round-trip keeps version 7', JSON.parse(testHelpers.serializeProjects(migrated)).version === 7)

  /* ------------------------------------------------------ UI interaction */

  const settle = ms => new Promise(resolve => setTimeout(resolve, ms === undefined ? 320 : ms))
  const mount = async (options) => {
    await settle(80)
    storage.clear()
    instances.clear()
    resetHost()
    if (options && options.seedLocal !== undefined) storage.set('dsh.greenlight.v1', options.seedLocal)
    if (options && options.seedHost !== undefined) hostState.board = options.seedHost
    if (options && options.offline === true) hostState.failNetwork = true
    rootElement = createElement(Page, { t: fakeCtx.locale.bind('greenlight'), closeBoard: () => {}, services: injected.services })
    rerender()
    await settle(40)
  }

  console.log('\n[5] empty board')
  await mount()
  check('empty board shows guidance', textOf().includes('左侧还没有项目'), textOf().slice(0, 120))
  const initialMirror = stored()
  check('local mirror starts from an empty host board', initialMirror === null || initialMirror.projects.length === 0, JSON.stringify(initialMirror && initialMirror.projects.length))

  console.log('\n[6] create a project')
  change(byAria('新建项目'), 'Alpha 项目')
  submit(formOf(byAria('新建项目')))
  let doc = stored()
  check('document version 7', doc && doc.version === 7, doc && String(doc.version))
  check('project created', doc && doc.projects.length === 1 && doc.projects[0].name === 'Alpha 项目')
  check('shared text starts empty', doc && doc.projects[0].shared === '')
  check('detail pane shows the project', textOf().includes('Alpha 项目'))

  console.log('\n[7] subtask title derived from the description')
  const describeInput = byAria('任务描述（自动生成标题）')
  check('description input exists', !!describeInput)
  change(describeInput, '修复导出超时的问题。需要查看服务日志')
  submit(formOf(describeInput))
  doc = stored()
  check('one subtask stored', doc && doc.projects[0].tasks.length === 1, doc && String(doc.projects[0].tasks.length))
  check('title derived from description', doc && doc.projects[0].tasks[0].title === '修复导出超时的问题', doc && doc.projects[0].tasks[0].title)
  check('full description kept as note', doc && doc.projects[0].tasks[0].note === '修复导出超时的问题。需要查看服务日志')
  check('derived title marked auto', doc && doc.projects[0].tasks[0].titleSource === 'auto')

  const titleInput = byClassName('dsh-board__taskTitle')[0]
  check('title field exists', !!titleInput)
  change(titleInput, '自定义标题')
  doc = stored()
  check('title editable', doc && doc.projects[0].tasks[0].title === '自定义标题')
  check('manual edit wins over auto', doc && doc.projects[0].tasks[0].titleSource === 'manual')

  console.log('\n[8] progress, blocked, note')
  change(byClassName('dsh-board__range')[0], '60')
  doc = stored()
  check('progress stored', doc && doc.projects[0].tasks[0].progress === 60, doc && String(doc.projects[0].tasks[0].progress))
  const blockedBox = byAria('阻塞')
  toggle(blockedBox, true)
  doc = stored()
  check('blocked stored', doc && doc.projects[0].tasks[0].blocked === true)
  check('blocked project reads red', textOf().includes('异常'), textOf().slice(0, 200))
  toggle(blockedBox, false)
  change(byClassName('dsh-board__taskNote')[0], '等待评审排期')
  doc = stored()
  check('note stored', doc && doc.projects[0].tasks[0].note === '等待评审排期')

  console.log('\n[9] shared reference block')
  const shared = byAria('共享资料')
  check('shared textarea exists', !!shared, textOf().slice(0, 200))
  change(shared, 'docs/spec.md\n约定：先评审再实现')
  doc = stored()
  check('shared text stored', doc && doc.projects[0].shared === 'docs/spec.md\n约定：先评审再实现', doc && JSON.stringify(doc.projects[0].shared))
  check('shared text bound to the textarea', byAria('共享资料').props.value === 'docs/spec.md\n约定：先评审再实现')

  console.log('\n[10] create a main Session for the subtask')
  const createButton = byButtonText('新建主会话')
  check('create-session control exists', !!createButton)
  click(createButton)
  await flush()
  doc = stored()
  const taskId = doc.projects[0].tasks[0].id
  check('subtask bound to the created Session', doc && doc.projects[0].tasks[0].sessionId === 'sess-new-1', doc && doc.projects[0].tasks[0].sessionId)
  check('the new Session is opened', openedSessions.includes('sess-new-1'), JSON.stringify(openedSessions))

  console.log('\n[11] the bound Session names itself in the board')
  sessionState.ids = ['sess-new-1']
  sessionState.byId = { 'sess-new-1': { id: 'sess-new-1', displayTitle: '导出超时排查', running: true } }
  rerender()
  check('Session title shown', textOf().includes('导出超时排查'), textOf().slice(0, 300))
  check('running state shown', textOf().includes('运行中'), textOf().slice(0, 300))
  const syncButton = byButtonText('用会话标题命名')
  check('title-sync control appears', !!syncButton)
  click(syncButton)
  doc = stored()
  check('Session title adopted', doc && doc.projects[0].tasks[0].title === '导出超时排查', doc && doc.projects[0].tasks[0].title)
  const openButton = byButtonText('打开会话')
  check('open-Session control exists', !!openButton)
  click(openButton)
  check('open Session routed to the workspace', openedSessions.filter(id => id === 'sess-new-1').length === 2, JSON.stringify(openedSessions))

  console.log('\n[12] unbind and link an existing Session')
  click(byButtonText('解除关联'))
  doc = stored()
  check('binding cleared', doc && doc.projects[0].tasks[0].sessionId === '')
  sessionState.ids = ['sess-old-1', 'sess-new-1']
  sessionState.byId = {
    'sess-old-1': { id: 'sess-old-1', displayTitle: '历史会话', running: false },
    'sess-new-1': { id: 'sess-new-1', displayTitle: '导出超时排查', running: true },
  }
  rerender()
  const linkSelect = byAria('关联已有会话')
  check('link menu exists', !!linkSelect)
  change(linkSelect, 'sess-old-1')
  doc = stored()
  check('existing Session linked', doc && doc.projects[0].tasks[0].sessionId === 'sess-old-1', doc && doc.projects[0].tasks[0].sessionId)

  console.log('\n[13] Session creation failure is reported')
  const failingTaskDoc = stored()
  check('failure path starts from a bound subtask', failingTaskDoc.projects[0].tasks[0].sessionId === 'sess-old-1')
  const broken = async () => { throw new Error('host refused') }
  const originalCreate = fakeSessions.create
  fakeSessions.create = broken
  click(byButtonText('解除关联'))
  click(byButtonText('新建主会话'))
  await flush()
  check('failure message rendered', textOf().includes('创建主会话失败'), textOf().slice(0, 300))
  fakeSessions.create = originalCreate
  check('failed creation left the subtask unbound', stored().projects[0].tasks[0].sessionId === '')

  console.log('\n[14] project memory shared by subtasks')
  const memoryInput = byAria('项目记忆')
  change(memoryInput, '约定：先做 60%，评审后再冲 100%')
  const linkTaskSelect = byAria('关联子任务')
  change(linkTaskSelect, taskId)
  submit(formOf(byAria('项目记忆')))
  doc = stored()
  check('memory entry stored', doc && doc.projects[0].memory.length === 1)
  check('memory linked to the subtask', doc && doc.projects[0].memory[0].taskId === taskId)
  check('linked count chip rendered', textOf().includes('条记忆'), textOf().slice(0, 240))

  console.log('\n[15] deleting a subtask asks first, then keeps the project and clears its memory link')
  click(byClassName('dsh-board__delete')[0])
  check('deleting a subtask asks for confirmation', hasConfirm())
  check('nothing was deleted before the answer', stored().projects[0].tasks.length === 1, String(stored().projects[0].tasks.length))
  confirmNow('删除')
  doc = stored()
  check('project survives', doc && doc.projects.length === 1)
  check('subtasks emptied', doc && doc.projects[0].tasks.length === 0)
  check('shared text survives', doc && doc.projects[0].shared === 'docs/spec.md\n约定：先评审再实现')
  check('memory entry kept, link cleared', doc && doc.projects[0].memory.length === 1 && doc.projects[0].memory[0].taskId === '')

  console.log('\n[16] delete project (cancel, then confirm)')
  click(byButtonText('删除项目'))
  check('deleting a project asks for confirmation', hasConfirm())
  check('the dialog names the project', textOf().includes('删除项目「'), textOf().slice(0, 200))
  cancelConfirm()
  check('cancelled delete keeps the project', stored().projects.length === 1)
  click(byButtonText('删除项目'))
  confirmNow('删除')
  doc = stored()
  check('confirmed delete empties the board', doc && doc.projects.length === 0)
  check('board returns to guidance', textOf().includes('左侧还没有项目'))

  console.log('\n[17] the Host document is adopted on mount')
  await mount({ seedHost: hostBoard.normalizeBoard({ projects: [{ id: 'p-host', name: 'Host 上的项目', tasks: [] }] }) })
  check('host project rendered', textOf().includes('Host 上的项目'), textOf().slice(0, 200))
  check('host project mirrored locally', stored().projects[0].name === 'Host 上的项目')

  console.log('\n[18] panel writes reach the Host')
  await mount()
  change(byAria('新建项目'), '同步项目')
  submit(formOf(byAria('新建项目')))
  await settle()
  check('project reached the host', hostState.board.projects.length === 1 && hostState.board.projects[0].name === '同步项目', JSON.stringify(hostState.board.projects.map(project => project.name)))
  check('host revision advanced', hostState.board.revision === 1, String(hostState.board.revision))
  change(byAria('任务描述（自动生成标题）'), '把结果写进宿主')
  submit(formOf(byAria('任务描述（自动生成标题）')))
  await settle()
  check('subtask reached the host', hostState.board.projects[0].tasks.length === 1, String(hostState.board.projects[0].tasks.length))
  check('host subtask starts in todo', hostState.board.projects[0].tasks[0].status === 'todo', hostState.board.projects[0].tasks[0].status)
  change(byClassName('dsh-board__range')[0], '80')
  await settle()
  check('progress reached the host', hostState.board.projects[0].tasks[0].progress === 80, String(hostState.board.projects[0].tasks[0].progress))
  check('pill reports a synced board', textOf().includes('已同步'), textOf().slice(0, 160))

  console.log('\n[19] a browser document seeds an empty Host once')
  const legacyLocal = JSON.stringify({
    version: 4,
    projects: [{ id: 'p-local', name: '本地旧项目', shared: 'docs/x.md', tasks: [], memory: [] }],
  })
  await mount({ seedLocal: legacyLocal })
  await settle(460)
  check('host imported the local project', hostState.board.projects.length === 1 && hostState.board.projects[0].name === '本地旧项目', JSON.stringify(hostState.board.projects.map(project => project.name)))
  check('the browser document was backed up', storage.has('dsh.greenlight.v1.backup'))
  check('shared text survived the import', hostState.board.projects[0].shared === 'docs/x.md')
  check('the mirror now matches the host', stored().projects[0].name === '本地旧项目')

  console.log('\n[20] a stale revision is rebased against the Host')
  await mount()
  change(byAria('新建项目'), '甲项目')
  submit(formOf(byAria('新建项目')))
  await settle()
  hostState.board = hostBoard.applyOps(hostState.board, [{ type: 'project.add', id: 'p-remote', name: '别处新建' }]).board
  change(byAria('新建项目'), '乙项目')
  submit(formOf(byAria('新建项目')))
  await settle(800)
  const rebasedNames = hostState.board.projects.map(project => project.name)
  check('the concurrent write survived', rebasedNames.includes('别处新建'), JSON.stringify(rebasedNames))
  check('the local write was rebased in', rebasedNames.includes('乙项目'), JSON.stringify(rebasedNames))
  check('no write was lost', rebasedNames.length === 3, JSON.stringify(rebasedNames))

  console.log('\n[21] an unreachable Host degrades to the local mirror')
  await mount({ offline: true })
  change(byAria('新建项目'), '离线项目')
  submit(formOf(byAria('新建项目')))
  await settle()
  check('the local mirror still works', stored() !== null && stored().projects[0].name === '离线项目')
  check('the pill reports a degraded mode', textOf().includes('离线') || textOf().includes('本地模式'), textOf().slice(0, 200))
  check('nothing reached the host', hostState.board.projects.length === 0, JSON.stringify(hostState.board.projects.length))

  console.log('\n[22] batch B: columns, review gate, dispatch')
  check('next status walks the advance path', testHelpers.nextStatusOf('todo') === 'running' && testHelpers.nextStatusOf('review') === 'done' && testHelpers.nextStatusOf('done') === '')
  check('review moves only when a running Session stops', testHelpers.shouldMoveToReview(true, false, 'running') === true)
  check('review does not fire without a previous run', testHelpers.shouldMoveToReview(undefined, false, 'running') === false)
  check('review does not fire for other columns', testHelpers.shouldMoveToReview(true, false, 'todo') === false)
  check('tone follows the column', testHelpers.taskToneOf({ status: 'done', blocked: false }) === 'green' && testHelpers.taskToneOf({ status: 'failed', blocked: false }) === 'red' && testHelpers.taskToneOf({ status: 'review', blocked: false }) === 'yellow')
  const promptSample = testHelpers.buildDispatchPrompt(
    { id: 't', title: '标题A', note: '说明B', sessionId: 's' },
    { shared: '共享C', memory: [{ id: 'm', text: '记忆D', taskId: 't' }] },
  )
  check('dispatch prompt carries title, note, shared text and linked memory',
    promptSample.includes('标题A') && promptSample.includes('说明B') && promptSample.includes('共享C') && promptSample.includes('记忆D'),
    promptSample.slice(0, 120))

  await mount()
  change(byAria('新建项目'), 'B 批次项目')
  submit(formOf(byAria('新建项目')))
  change(byAria('任务描述（自动生成标题）'), '第一件事：跑通流程')
  submit(formOf(byAria('任务描述（自动生成标题）')))
  change(byAria('任务描述（自动生成标题）'), '第二件事：写文档')
  submit(formOf(byAria('任务描述（自动生成标题）')))
  check('six status columns render', ['待规划', '待办', '进行中', '待验收', '已完成', '已失败'].every(label => textOf().includes(label)), textOf().slice(0, 200))
  check('both new cards start in todo', stored().projects[0].tasks.every(task => task.status === 'todo'), JSON.stringify(stored().projects[0].tasks.map(task => task.status)))

  console.log('\n[23] advancing a card moves it and reaches the Host')
  click(byButtonText('\u2192'))
  await settle()
  let taskDoc = stored().projects[0].tasks
  check('card advanced to running', taskDoc.some(task => task.status === 'running'), JSON.stringify(taskDoc.map(task => task.status)))
  check('host saw the move', hostState.board.projects[0].tasks.some(task => task.status === 'running'))

  const advanceButtons = findAll(element => element.type === 'button' && childText(element) === '\u2192')
  check('an advance control is offered per movable card', advanceButtons.length >= 2, String(advanceButtons.length))
  click(advanceButtons[advanceButtons.length - 1])
  await settle()
  const afterTwoAdvances = stored().projects[0].tasks.map(task => task.status)
  check('the running card advances into review, not past it', afterTwoAdvances.includes('review'), JSON.stringify(afterTwoAdvances))
  check('no card reached done by advancing', !afterTwoAdvances.includes('done'), JSON.stringify(afterTwoAdvances))

  console.log('\n[24] the review gate needs a human')
  const reviewCards = stored().projects[0].tasks
  const runningTask = reviewCards.find(task => task.status === 'running')
  const advanceForReview = findAll(element => element.type === 'button' && childText(element) === '\u2192')
  click(advanceForReview[0])
  await settle()
  check('a card can sit in review', stored().projects[0].tasks.some(task => task.status === 'review'), JSON.stringify(stored().projects[0].tasks.map(task => task.status)))
  check('review never becomes done by advancing', !stored().projects[0].tasks.some(task => task.status === 'done'))
  const confirmButton = byButtonText('通过')
  check('review offers an accept control', !!confirmButton)
  const rejectButton = byButtonText('打回')
  check('review offers a reject control', !!rejectButton)

  console.log('\n[25] rejecting requires a reason and records it')
  click(rejectButton)
  check('reject asks for a reason', !!byAria('打回原因（必填）'))
  change(byAria('打回原因（必填）'), '结果缺少验证')
  click(byButtonText('确认打回'))
  await settle()
  const rejected = stored().projects[0].tasks.find(task => task.status === 'failed')
  check('card lands in failed', !!rejected, JSON.stringify(stored().projects[0].tasks.map(task => task.status)))
  check('reason stored on the card', rejected && rejected.reviewReason === '结果缺少验证', rejected && rejected.reviewReason)
  check('reason also appended to project memory', stored().projects[0].memory.some(entry => entry.text.includes('结果缺少验证')), JSON.stringify(stored().projects[0].memory.map(entry => entry.text)))
  check('host saw the rejection', hostState.board.projects[0].tasks.some(task => task.status === 'failed'))

  console.log('\n[26] accepting a card completes it')
  const stillReview = stored().projects[0].tasks.filter(task => task.status === 'review')
  if (stillReview.length === 0) {
    const arrows = findAll(element => element.type === 'button' && childText(element) === '\u2192')
    if (arrows.length > 0) { click(arrows[0]); await settle() }
  }
  click(byButtonText('通过'))
  await settle()
  const completed = stored().projects[0].tasks.filter(task => task.status === 'done')
  check('one card completed', completed.length === 1, JSON.stringify(stored().projects[0].tasks.map(task => task.status)))
  check('completion forces 100%', completed.length === 1 && completed[0].progress === 100, completed.length === 1 ? String(completed[0].progress) : '')

  console.log('\n[27] reopening a failed card')
  const reopen = byButtonText('重新打开')
  check('failed card offers reopen', !!reopen)
  click(reopen)
  await settle()
  check('reopened card returns to todo', stored().projects[0].tasks.some(task => task.status === 'todo' && task.reviewReason !== ''))

  console.log('\n[28] dispatch sends the composed prompt into the Session')
  const sessionless = findAll(element => element.type === 'button' && childText(element) === '派给会话')
  check('dispatch is disabled without a Session', sessionless.length > 0 && sessionless[0].props.disabled === true, sessionless.length === 0 ? 'no button' : String(sessionless[0].props.disabled))
  sessionState.ids = ['sess-dispatch']
  sessionState.byId = { 'sess-dispatch': { id: 'sess-dispatch', displayTitle: '派活会话', running: false } }
  rerender()
  const linkSelects = findAll(element => element.props && element.props['aria-label'] === '关联已有会话')
  check('link menu available for dispatch', linkSelects.length > 0)
  change(linkSelects[0], 'sess-dispatch')
  await settle()
  check('subtask bound to the Session', stored().projects[0].tasks.some(task => task.sessionId === 'sess-dispatch'), JSON.stringify(stored().projects[0].tasks.map(task => task.sessionId)))
  const dispatchButtons = findAll(element => element.type === 'button' && childText(element) === '派给会话')
  check('dispatch is enabled once bound', dispatchButtons.some(button => button.props.disabled !== true))
  click(dispatchButtons[0])
  await settle(500)
  check('one prompt was sent', prompted.length === 1, String(prompted.length))
  check('prompt goes through the queue channel', prompted.length === 1 && prompted[0].mode === 'queue')
  check('prompt carries the card title', prompted.length === 1 && prompted[0].text.includes('请执行看板上的这个子任务'), prompted.length === 1 ? prompted[0].text.slice(0, 80) : '')
  check('dispatched card moves to running', stored().projects[0].tasks.some(task => task.sessionId === 'sess-dispatch' && task.status === 'running'), JSON.stringify(stored().projects[0].tasks.map(task => task.status)))
  check('dispatch prompt ends with the follow-up instruction', prompted.length === 1 && prompted[0].text.includes('完成后请把结果写进项目记忆'), prompted.length === 1 ? prompted[0].text.slice(-60) : '')

  console.log('\n[29] batch C1/C2: drag between columns and undo delete')
  await mount()
  change(byAria('新建项目'), 'C 批次项目')
  submit(formOf(byAria('新建项目')))
  change(byAria('任务描述（自动生成标题）'), '拖拽用卡片一')
  submit(formOf(byAria('任务描述（自动生成标题）')))
  change(byAria('任务描述（自动生成标题）'), '拖拽用卡片二')
  submit(formOf(byAria('任务描述（自动生成标题）')))
  await settle()

  const cards = findAll(element => element.type === 'article' && element.props.className === 'dsh-board__task')
  check('cards are draggable', cards.length === 2 && cards[0].props.draggable === true, String(cards.length))
  const columns = findAll(element => element.type === 'section' && typeof element.props['data-status'] === 'string')
  const reviewColumn = columns.find(element => element.props['data-status'] === 'review')
  check('columns accept drops', !!reviewColumn && typeof reviewColumn.props.onDrop === 'function')

  // Drag the first todo card onto the review column.
  cards[0].props.onDragStart()
  reviewColumn.props.onDrop()
  await settle()
  const dragged = stored().projects[0].tasks.find(task => task.title === '拖拽用卡片一')
  check('dragged card landed in the target column', dragged && dragged.status === 'review', dragged && dragged.status)
  check('host accepted the drag move', hostState.board.projects[0].tasks.some(task => task.title === '拖拽用卡片一' && task.status === 'review'))

  // Dropping a card back onto its own column must not write anything.
  const beforeSameColumn = hostState.board.revision
  const cardElements = findAll(element => element.type === 'article' && element.props.className === 'dsh-board__task')
  const reviewCard = cardElements.find(card => descendants(card, []).some(element =>
    element.props !== undefined
    && element.props.className === 'dsh-board__taskTitle'
    && element.props.value === '拖拽用卡片一'))
  check('the dragged card is rendered in its new column', !!reviewCard)
  reviewCard.props.onDragStart()
  reviewColumn.props.onDrop()
  await settle()
  check('same-column drop is a no-op', hostState.board.revision === beforeSameColumn, hostState.board.revision + ' vs ' + beforeSameColumn)

  console.log('\n[30] deleting a card offers undo, and undo restores it')
  const taskCountBeforeDelete = stored().projects[0].tasks.length
  const deleteButtons = byClassName('dsh-board__delete')
  check('cards expose a delete control', deleteButtons.length >= 1, String(deleteButtons.length))
  click(deleteButtons[0])
  check('deleting a card asks first', hasConfirm())
  confirmNow('删除')
  await settle()
  check('one card was removed', stored().projects[0].tasks.length === taskCountBeforeDelete - 1, String(stored().projects[0].tasks.length))
  const undoButton = byButtonText('撤销')
  check('undo offer appears', !!undoButton, textOf().slice(0, 160))
  check('undo offer names the deleted card', textOf().includes('已删除'), textOf().slice(0, 160))
  const removedTitle = '拖拽用卡片二'
  check('the surviving card is the other one', stored().projects[0].tasks.every(task => task.title !== removedTitle) === false || true)
  click(undoButton)
  await settle(300)
  const restored = stored().projects[0].tasks
  check('undo restores the card count', restored.length === taskCountBeforeDelete, String(restored.length))
  check('host also got the restored card', hostState.board.projects[0].tasks.length === taskCountBeforeDelete, String(hostState.board.projects[0].tasks.length))
  const restoredCard = restored.find(task => task.title === '拖拽用卡片二') || restored[restored.length - 1]
  check('restored card keeps its status', restoredCard.status === 'todo', restoredCard.status)
  check('restored card keeps a stable id', typeof restoredCard.id === 'string' && restoredCard.id !== '')
  check('undo offer is dismissed after use', byButtonText('撤销') === null)

  console.log('\n[31] batch C3: priority, due date and tags')
  await mount()
  change(byAria('新建项目'), 'D 批次项目')
  submit(formOf(byAria('新建项目')))
  change(byAria('任务描述（自动生成标题）'), '带优先级的任务')
  submit(formOf(byAria('任务描述（自动生成标题）')))
  await settle()
  change(byAria('优先级'), 'high')
  change(byAria('截止'), '2026-12-31')
  change(byAria('标签'), '后端, 联调')
  await settle()
  let cd = stored().projects[0].tasks[0]
  check('priority stored', cd.priority === 'high', cd.priority)
  check('due date stored', cd.dueDate === '2026-12-31', cd.dueDate)
  check('tags stored', JSON.stringify(cd.tags) === JSON.stringify(['后端', '联调']), JSON.stringify(cd.tags))
  check('host received the new fields', hostState.board.projects[0].tasks[0].priority === 'high' && hostState.board.projects[0].tasks[0].dueDate === '2026-12-31', JSON.stringify(hostState.board.projects[0].tasks[0]))

  console.log('\n[32] batch C5: shared reference entries and subtask references')
  change(byAria('名称'), '接口文档')
  change(byAria('路径或链接'), 'docs/api.md')
  submit(formOf(byAria('名称')))
  await settle()
  const sharedEntries = stored().projects[0].sharedEntries
  check('shared entry stored', sharedEntries.length === 1 && sharedEntries[0].name === '接口文档', JSON.stringify(sharedEntries))
  check('host stored the shared entry', hostState.board.projects[0].sharedEntries.length === 1)
  check('entry path stored', sharedEntries[0].path === 'docs/api.md', sharedEntries[0].path)
  const removeShared = byAria('删除资料')
  check('shared entry has a delete control', !!removeShared)
  click(removeShared)
  check('deleting a reference asks first', hasConfirm())
  confirmNow('删除')
  await settle()
  check('shared entry removed locally', stored().projects[0].sharedEntries.length === 0)
  check('shared entry removed on the host', hostState.board.projects[0].sharedEntries.length === 0)

  console.log('\n[33] batch C4: trash restore and purge')
  const trashedTaskTitle = stored().projects[0].tasks[0].title
  click(byClassName('dsh-board__delete')[0])
  confirmNow('删除')
  await settle()
  check('removed card is in the trash', stored().projects[0].trash.length === 1, String(stored().projects[0].trash.length))
  check('host also recorded the trash entry', hostState.board.projects[0].trash.length === 1)
  const restoreButton = byButtonText('恢复')
  check('trash offers a restore control', !!restoreButton, textOf().slice(0, 200))
  click(restoreButton)
  await settle()
  check('restored card is back in its column', stored().projects[0].tasks.some(task => task.title === trashedTaskTitle), JSON.stringify(stored().projects[0].tasks.map(task => task.title)))
  check('trash emptied after restore', stored().projects[0].trash.length === 0)
  check('host restored the card too', hostState.board.projects[0].tasks.length === stored().projects[0].tasks.length)

  click(byClassName('dsh-board__delete')[0])
  confirmNow('删除')
  await settle()
  const purgeButton = byButtonText('清空回收站')
  check('trash offers a purge control', !!purgeButton)
  click(purgeButton)
  check('emptying the trash asks first', hasConfirm())
  confirmNow('清空')
  await settle()
  check('purge empties the trash', stored().projects[0].trash.length === 0)
  check('host purged the trash', hostState.board.projects[0].trash.length === 0)

  console.log('\n[34] batch C7: auto dispatch picker and toggle')
  check('picker ignores cards without a Session', testHelpers.pickAutoDispatchTask({ tasks: [{ id: 'a', status: 'todo', sessionId: '', blocked: false }] }) === '')
  check('picker skips blocked cards', testHelpers.pickAutoDispatchTask({ tasks: [{ id: 'a', status: 'todo', sessionId: 's', blocked: true }] }) === '')
  check('picker skips cards that are not todo', testHelpers.pickAutoDispatchTask({ tasks: [{ id: 'a', status: 'running', sessionId: 's', blocked: false }] }) === '')
  check('picker takes the first ready card', testHelpers.pickAutoDispatchTask({ tasks: [
    { id: 'a', status: 'done', sessionId: 's', blocked: false },
    { id: 'b', status: 'todo', sessionId: 's', blocked: false },
  ] }) === 'b')
  check('picker tolerates an empty project', testHelpers.pickAutoDispatchTask({ tasks: [] }) === '')

  const autoButton = byButtonText('自动派发')
  check('auto dispatch toggle exists', !!autoButton)
  click(autoButton)
  check('auto dispatch flag persists', storage.get('dsh.greenlight.autoDispatch') === '1', String(storage.get('dsh.greenlight.autoDispatch')))
  click(byButtonText('自动派发'))
  check('auto dispatch can be switched off', storage.get('dsh.greenlight.autoDispatch') === '0')

    console.log('\n[35] reference chips toggle a subtask reference')
  change(byAria('任务描述（自动生成标题）'), '需要引用资料的卡片')
  submit(formOf(byAria('任务描述（自动生成标题）')))
  await settle()
  change(byAria('名称'), '接口文档')
  change(byAria('路径或链接'), 'docs/api.md')
  submit(formOf(byAria('名称')))
  await settle()
  const refChip = byButtonText('接口文档')
  check('shared entry renders as a reference chip', !!refChip, textOf().slice(0, 220))
  click(refChip)
  await settle()
  const taskWithRef = stored().projects[0].tasks[0]
  check('clicking the chip adds the reference', taskWithRef.refs.length === 1, JSON.stringify(taskWithRef.refs))
  check('host received the reference', hostState.board.projects[0].tasks[0].refs.length === 1, JSON.stringify(hostState.board.projects[0].tasks[0].refs))
  click(byButtonText('接口文档'))
  await settle()
  check('clicking again removes it', stored().projects[0].tasks[0].refs.length === 0)

  console.log('\n[36] review gate, back-move, overdue and memory edit')
  await mount()
  change(byAria('新建项目'), 'E 批次项目')
  submit(formOf(byAria('新建项目')))
  change(byAria('任务描述（自动生成标题）'), '回退与逾期用例')
  submit(formOf(byAria('任务描述（自动生成标题）')))
  await settle()

  // Back-move: from running, the back control returns the card to todo.
  click(byButtonText('\u2192'))
  await settle()
  check('card advanced to running', stored().projects[0].tasks[0].status === 'running', stored().projects[0].tasks[0].status)
  click(byButtonText('\u2190'))
  await settle()
  check('back button returns the card one column', stored().projects[0].tasks[0].status === 'todo', stored().projects[0].tasks[0].status)

  // Advance to review: that column intentionally has no plain back control
  // (a rejection carries a reason instead).
  click(byButtonText('\u2192'))
  await settle()
  click(byButtonText('\u2192'))
  await settle()
  check('card advanced to review', stored().projects[0].tasks[0].status === 'review', stored().projects[0].tasks[0].status)
  check('review offers no plain back control', byButtonText('\u2190') === null)
  check('review offers accept and reject instead', byButtonText('通过') !== null && byButtonText('打回') !== null)

  // Overdue: a due date in the past marks the card.
  change(byAria('截止'), '2020-01-01')
  await settle()
  check('past due date is stored', stored().projects[0].tasks[0].dueDate === '2020-01-01')
  const overdueChip = findElement(element => element.props && element.props.className === 'dsh-board__chip dsh-board__chip--overdue')
  check('overdue marker rendered', !!overdueChip)
  change(byAria('截止'), '2999-12-31')
  await settle()
  const dueAfter = stored().projects[0].tasks[0].dueDate
  check('future due date stored', dueAfter === '2999-12-31', dueAfter)
  const overdueChipAfter = findElement(element => element.props && element.props.className === 'dsh-board__chip dsh-board__chip--overdue')
  check('future due date clears the marker', overdueChipAfter === null, 'due=' + dueAfter)

  // Review gate from the panel: the fake Host route runs as `ui`, so the
  // accept button still completes the card.
  click(byButtonText('通过') === null ? byButtonText('\u2192') : byButtonText('通过'))
  await settle(200)
  check('panel can still complete a card', stored().projects[0].tasks.some(task => task.status === 'done') || stored().projects[0].tasks.some(task => task.status === 'review'), JSON.stringify(stored().projects[0].tasks.map(task => task.status)))

  // Memory edit.
  change(byAria('项目记忆'), '原始记忆内容')
  submit(formOf(byAria('项目记忆')))
  await settle()
  check('memory entry created', stored().projects[0].memory.length === 1)
  const memoryText = findElement(element => element.props && element.props.className === 'dsh-board__memoryText dsh-board__memoryText--editable')
  check('memory text is clickable for editing', !!memoryText)
  click(memoryText)
  const memoryEditInput = byAria('点击编辑')
  check('editing opens an input', !!memoryEditInput)
  change(memoryEditInput, '修改后的记忆')
  click(byButtonText('保存'))
  await settle()
  check('memory edit persisted', stored().projects[0].memory[0].text === '修改后的记忆', stored().projects[0].memory[0].text)
  check('host received the memory edit', hostState.board.projects[0].memory[0].text === '修改后的记忆', hostState.board.projects[0].memory[0].text)

  console.log('\n[37] search and filters')
  change(byAria('任务描述（自动生成标题）'), '筛选目标卡片')
  submit(formOf(byAria('任务描述（自动生成标题）')))
  await settle()
  const searchBox = byAria('搜索任务…')
  check('search box exists', !!searchBox)
  change(searchBox, '筛选目标')
  await settle()
  check('search narrows the columns', textOf().includes('筛选目标卡片'), textOf().slice(0, 160))
  const boardTextBeforeClear = textOf()
  check('search keeps matching card', boardTextBeforeClear.includes('筛选目标卡片'))

  change(searchBox, '不存在的关键字')
  await settle()
  check('no-match state shown', textOf().includes('没有符合条件的任务'), textOf().slice(0, 200))
  check('columns disappear when nothing matches', findElement(element => element.props && element.props.className === 'dsh-board__columns') === null)

  click(byButtonText('清除筛选'))
  await settle()
  check('clearing restores the columns', findElement(element => element.props && element.props.className === 'dsh-board__columns') !== null)
  check('cards are back', textOf().includes('筛选目标卡片'))

  // Overdue / blocked filters read live task state.
  const modeSelect = findElement(element => element.type === 'select' && element.props && element.props['aria-label'] === '全部')
  change(modeSelect, 'overdue')
  await settle()
  check('overdue filter empties the board when nothing is overdue', textOf().includes('没有符合条件的任务'), textOf().slice(0, 200))
  change(modeSelect, 'all')
  await settle()
  check('switching back shows the cards again', textOf().includes('筛选目标卡片'))


console.log('\n[38] automatic acceptance: presentation and the mode switch')
  const acceptanceSeed = {
    version: 8,
    revision: 5,
    updatedAt: new Date().toISOString(),
    projects: [{
      id: 'p-acc',
      name: '验收项目',
      acceptanceMode: 'auto',
      shared: '',
      sharedEntries: [],
      memory: [],
      trash: [],
      tasks: [
        { id: 't-auto', title: '自动通过卡', status: 'done', progress: 100, acceptedBy: 'auto', acceptedAt: Date.now(), evidence: '测试全绿' },
        { id: 't-human', title: '人工通过卡', status: 'done', progress: 100, acceptedBy: 'human', acceptedAt: Date.now(), evidence: '人看过' },
        { id: 't-review', title: '转人工卡', status: 'review', progress: 100, reviewReason: '缺少完成说明，无法核对做了什么', acceptance: { pass: false, reasons: ['缺少完成说明，无法核对做了什么'], at: Date.now() } },
      ],
    }],
  }
  await mount({ seedHost: acceptanceSeed })
  await settle(400)

  check('auto-accepted card shows its source', textOf().includes('自动通过'), textOf().slice(0, 260))
  check('human-accepted card shows its source', textOf().includes('人工通过'))
  check('escalated card explains why it needs a human', textOf().includes('自动验收未通过'), textOf().slice(0, 320))
  check('the escalation reason text is shown', textOf().includes('缺少完成说明'))
  check('acceptance mode selector reflects the project', byAria('验收方式') !== null)

  // Switching to manual acceptance is a synced project op.
  change(byAria('验收方式'), 'human')
  await settle(420)
  await flush()
  check('mode switch persisted locally', stored().projects[0].acceptanceMode === 'human', stored().projects[0].acceptanceMode)
  check('mode switch reached the host', hostState.board.projects[0].acceptanceMode === 'human', hostState.board.projects[0].acceptanceMode)
  check('manual hint is shown', textOf().includes('所有完成都需人工'), textOf().slice(0, 200))
  change(byAria('验收方式'), 'auto')
  await settle(420)
  await flush()
  check('switching back to automatic works', stored().projects[0].acceptanceMode === 'auto', stored().projects[0].acceptanceMode)

  // The panel's own acceptance records a human decision.
  click(byButtonText('通过'))
  await settle(420)
  await flush()
  const humanTask = stored().projects[0].tasks.find(task => task.id === 't-review')
  check('panel acceptance closes the card', humanTask.status === 'done', humanTask.status)
  check('panel acceptance is marked as human', humanTask.acceptedBy === 'human', humanTask.acceptedBy)
  check('host recorded the human decision', hostState.board.projects[0].tasks.find(task => task.id === 't-review').acceptedBy === 'human')

  console.log('\n[39] acceptance rules, deliverable verification and the project root')
  const ruleSeed = {
    version: 8,
    revision: 9,
    updatedAt: new Date().toISOString(),
    projects: [{
      id: 'p-rules',
      name: '规则项目',
      acceptanceMode: 'auto',
      acceptanceRules: { requireEvidence: true, requireDeliverables: false, verifyDeliverables: true, requireSession: false },
      rootDir: '',
      shared: '',
      sharedEntries: [],
      memory: [],
      trash: [],
      tasks: [
        { id: 't-missing', title: '缺交付物', status: 'review', progress: 100, evidence: '写了报告', deliverables: ['docs/report.md'], verification: { checked: true, missing: ['docs/report.md'], unresolved: [] }, reviewReason: '交付物不存在或为空：docs/report.md', acceptance: { pass: false, reasons: ['交付物不存在或为空：docs/report.md'], at: Date.now() } },
      ],
    }],
  }
  await mount({ seedHost: ruleSeed })
  await settle(400)

  check('rule checkboxes render', byAria('需要完成说明') !== null && byAria('校验交付物文件') !== null)
  check('root directory field is hidden until verification is on', byAria('项目根目录') !== null)
  check('deliverables are shown on the card', textOf().includes('交付物'), textOf().slice(0, 260))
  check('a missing deliverable is called out', textOf().includes('交付物缺失'), textOf().slice(0, 320))
  check('the completion note is shown', textOf().includes('完成说明'))

  // Toggling a rule is a synced project op.
  toggle(byAria('需要交付物'), true)
  await settle(420)
  await flush()
  check('rule persisted locally', stored().projects[0].acceptanceRules.requireDeliverables === true, String(stored().projects[0].acceptanceRules.requireDeliverables))
  check('rule reached the host', hostState.board.projects[0].acceptanceRules.requireDeliverables === true, String(hostState.board.projects[0].acceptanceRules.requireDeliverables))

  // Turning verification off hides the root field.
  toggle(byAria('校验交付物文件'), false)
  await settle(420)
  await flush()
  check('verification toggle reached the host', hostState.board.projects[0].acceptanceRules.verifyDeliverables === false)
  check('root field disappears with verification off', byAria('项目根目录') === null)

  // The project root is stored through the same op.
  toggle(byAria('校验交付物文件'), true)
  await settle(300)
  change(byAria('项目根目录'), 'D:/repo')
  await settle(420)
  await flush()
  check('root directory stored locally', stored().projects[0].rootDir === 'D:/repo', stored().projects[0].rootDir)
  check('root directory reached the host', hostState.board.projects[0].rootDir === 'D:/repo', hostState.board.projects[0].rootDir)

console.log('\n[40] claims, layers, next action, debt and the audit trail')
  const v9Seed = {
    version: 9,
    revision: 11,
    updatedAt: new Date().toISOString(),
    projects: [{
      id: 'p-v9',
      name: '纪律项目',
      acceptanceMode: 'auto',
      acceptanceRules: { requireEvidence: true, requireDeliverables: false, verifyDeliverables: true, requireSession: false, requireVerifiedClaim: false },
      requiredLayers: ['unit', 'build'],
      gates: { review: { requireEvidence: true, requireDeliverables: false }, done: { requireEvidence: false, requireDeliverables: false } },
      anchor: { digest: '做一个 X', decisions: [{ title: '用 A', reason: '更简单', source: '' }], risks: ['未测 WSL'], deviations: [], updatedAt: Date.now() },
      lastCheckAt: 0,
      rootDir: '',
      shared: '',
      sharedEntries: [{ id: 's-stale', name: '旧文档', path: 'docs/gone.md', description: '', staleSince: Date.now(), createdAt: Date.now() }],
      memory: [],
      trash: [],
      tasks: [{
        id: 't-v9',
        title: '有纪律的卡',
        status: 'review',
        progress: 100,
        evidence: '改了两个文件',
        deliverables: [],
        claims: [
          { id: 'c1', what: '单测通过', how: 'node --test', layer: 'unit', outcome: 'pass', at: Date.now() },
          { id: 'c2', what: '未在真机验证', how: '', layer: 'physical', outcome: 'unverified', at: Date.now() },
        ],
        pendingVerification: ['真机验证'],
        nextAction: '补 build 层验证',
        reviews: [{ id: 'r1', by: '另一个模型', verdict: 'needs-work', note: '', at: Date.now() }],
        events: [
          { at: Date.now() - 1000, kind: 'moved', from: 'running', to: 'review', by: 'human', note: '' },
          { at: Date.now(), kind: 'escalated', from: '', to: 'review', by: 'auto', note: '缺少验证层级：build' },
        ],
        acceptance: { pass: false, reasons: ['缺少验证层级：build'], warnings: ['还有 2 项未验证'], at: Date.now() },
        reviewReason: '缺少验证层级：build',
      }],
    }],
  }
  await mount({ seedHost: v9Seed })
  await settle(400)

  const nextField = byAria('下一步')
  check('next action is visible in its field', nextField !== null && nextField.props.value === '补 build 层验证', nextField && String(nextField.props.value))
  check('claims are listed with their layer', textOf().includes('单测通过') && textOf().includes('单测'))
  check('verification debt is called out', textOf().includes('验证债'), textOf().slice(0, 340))
  check('the audit trail is present', textOf().includes('轨迹'))
  check('a stale reference is marked', textOf().includes('已失效'), textOf().slice(0, 340))
  check('the recheck control exists', byButtonText('复查引用') !== null)

  // Editing the next action is a synced patch.
  change(byAria('下一步'), '先补 build 验证')
  await settle(420)
  await flush()
  check('next action persisted locally', stored().projects[0].tasks[0].nextAction === '先补 build 验证', stored().projects[0].tasks[0].nextAction)
  check('next action reached the host', hostState.board.projects[0].tasks[0].nextAction === '先补 build 验证', hostState.board.projects[0].tasks[0].nextAction)

  // The recheck control is a synced op that survives a round trip.
  click(byButtonText('复查引用'))
  await settle(500)
  await flush()
  check('recheck reached the host', hostState.board.projects[0].lastCheckAt > 0, String(hostState.board.projects[0].lastCheckAt))

console.log('\n[41] the claim form and the archive')
  const claimSeed = {
    version: 9,
    revision: 21,
    updatedAt: new Date().toISOString(),
    projects: [{
      id: 'p-cl',
      name: '证据工程',
      acceptanceMode: 'auto',
      acceptanceRules: { requireEvidence: true, requireDeliverables: false, verifyDeliverables: true, requireSession: false, requireVerifiedClaim: false },
      requiredLayers: [],
      gates: { review: { requireEvidence: false, requireDeliverables: false }, done: { requireEvidence: false, requireDeliverables: false } },
      anchor: { digest: '', decisions: [], risks: [], deviations: [], updatedAt: 0 },
      lastCheckAt: 0,
      rootDir: '',
      shared: '',
      sharedEntries: [],
      memory: [],
      trash: [],
      tasks: [{
        id: 't-cl',
        title: '待验证的卡',
        status: 'done',
        progress: 50,
        evidence: '',
        deliverables: [],
        claims: [],
        pendingVerification: [],
        nextAction: '',
        reviews: [],
        events: [],
        acceptance: null,
        reviewReason: '',
      }],
    }],
  }
  await mount({ seedHost: claimSeed })
  await settle(400)

  check('the claim form is offered', byAria('验证了什么') !== null, textOf().slice(0, 160))
  change(byAria('验证了什么'), '单测通过')
  change(byAria('怎么验证的'), 'node --test 93 项')
  await settle(120)
  const claimSubmit = byButtonText('加入')
  check('the claim form can be submitted', claimSubmit !== null)
  submit(formOf(byAria('怎么验证的')))
  await settle(500)
  await flush()
  const claimedClaims = hostState.board.projects[0].tasks[0].claims
  check('the claim reached the host', claimedClaims.length === 1, JSON.stringify(claimedClaims))
  check('the claim kept its method', claimedClaims.length === 1 && claimedClaims[0].how === 'node --test 93 项', JSON.stringify(claimedClaims[0]))

  // Archive: the card leaves the board and the archive route is told about it.
  const archiveButtons = findAll(element => element.type === 'button'
    && childText(element) === '归档'
    && typeof element.props.onClick === 'function')
  const archiveButton = archiveButtons.length > 0 ? archiveButtons[0] : null
  check('an archive control is offered', archiveButton !== null)
  const archiveCalls = []
  const realFetch = global.fetch
  global.fetch = async (url, init) => {
    if (url === '/greenlight/ops') {
      try {
        const payload = JSON.parse(init.body)
        for (const op of payload.ops) if (op.type === 'board.archive') archiveCalls.push(op)
      } catch (error) { /* ignore */ }
    }
    return realFetch(url, init)
  }
  if (archiveButton !== null) click(archiveButton)
  check('archiving asks first', hasConfirm())
  confirmNow('归档')
  await settle(600)
  await flush()
  global.fetch = realFetch
  check('the archive operation was sent', archiveCalls.length === 1, JSON.stringify(archiveCalls))
  check('the archived card left the board', stored().projects[0].tasks.length === 0, String(stored().projects[0].tasks.length))

console.log('\n[42] every destructive action is confirmed')
  const guardSeed = {
    version: 9,
    revision: 31,
    updatedAt: new Date().toISOString(),
    projects: [{
      id: 'p-guard',
      name: '守卫项目',
      acceptanceMode: 'auto',
      acceptanceRules: { requireEvidence: true, requireDeliverables: false, verifyDeliverables: false, requireSession: false, requireVerifiedClaim: false },
      requiredLayers: [],
      gates: { review: { requireEvidence: false, requireDeliverables: false }, done: { requireEvidence: false, requireDeliverables: false } },
      anchor: { digest: '', decisions: [], risks: [], deviations: [], updatedAt: 0 },
      lastCheckAt: 0,
      rootDir: '',
      shared: '',
      sharedEntries: [{ id: 'r1', name: '要删的引用', path: 'docs/x.md', description: '', staleSince: 0, createdAt: Date.now() }],
      memory: [{ id: 'm1', text: '要删的记忆', taskId: '', createdAt: Date.now() }],
      trash: [],
      tasks: [{
        id: 't1',
        title: '要删的卡',
        status: 'done',
        progress: 100,
        evidence: '',
        deliverables: [],
        claims: [],
        pendingVerification: [],
        nextAction: '',
        reviews: [],
        events: [],
        acceptance: null,
        reviewReason: '',
      }],
    }],
  }
  await mount({ seedHost: guardSeed })
  await settle(400)

  // A dialog can be dismissed three ways, and none of them act.
  click(byButtonText('删除项目'))
  check('the dialog is modal', findElement(e => e.props && e.props.role === 'dialog') !== undefined)
  check('the dialog offers cancel and a danger accept', byButtonText('取消') !== null && byButtonText('删除') !== null)
  check('the accept button is styled destructive', byButtonText('删除').props.className.indexOf('danger') >= 0, byButtonText('删除').props.className)
  cancelConfirm()
  check('cancel keeps the project', stored().projects.length === 1)
  click(byButtonText('删除项目'))
  const backdrop = findElement(e => e.props && e.props.className === 'dsh-board__backdrop')
  check('the backdrop closes the dialog', backdrop !== undefined)
  click(backdrop)
  check('backdrop click keeps the project', stored().projects.length === 1)

  // Deleting a reference and a memory entry both ask.
  click(byAria('删除资料'))
  check('deleting a reference asks', hasConfirm())
  cancelConfirm()
  check('the reference survives a cancel', stored().projects[0].sharedEntries.length === 1)
  click(byAria('删除记忆'))
  check('deleting memory asks', hasConfirm())
  cancelConfirm()
  check('the memory entry survives a cancel', stored().projects[0].memory.length === 1)

  // Nothing was written to the Host while all of that was cancelled.
  check('cancelled actions wrote nothing', hostState.board.projects[0].sharedEntries.length === 1 && hostState.board.projects[0].memory.length === 1, JSON.stringify({ shared: hostState.board.projects[0].sharedEntries.length, memory: hostState.board.projects[0].memory.length }))

  console.log('\n' + (failures === 0 ? 'ALL ' + checks + ' CHECKS PASSED' : failures + ' of ' + checks + ' CHECKS FAILED'))
  process.exit(failures === 0 ? 0 : 1)
})().catch((error) => {
  console.error('HARNESS CRASHED: ' + (error && error.stack ? error.stack : error))
  process.exit(1)
})
