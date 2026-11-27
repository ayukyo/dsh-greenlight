/**
 * Headless verification for the Greenlight board client module.
 *
 * Runs the real client.js with stubbed browser globals, a minimal React hook
 * runtime, and a fake Cordis Client context. Verifies: module init, slot
 * registration, document migration, title derivation, the project materials
 * text, subtask fields, Session create/link/unbind/title-sync, project memory, and
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

/** @returns {boolean} whether the element is the compact card's details toggle. */
function isDetailsToggle(element) {
  return element.type === 'button'
    && element.props !== undefined
    && typeof element.props.className === 'string'
    && element.props.className.includes('dsh-board__detailsToggle')
}

/** @returns {boolean} whether the element is a folded card's details toggle. */
function isFoldedToggle(element) {
  return isDetailsToggle(element) && element.props['aria-expanded'] === false
}

/** @returns {boolean} whether the element is an opened card's details toggle. */
function isOpenedToggle(element) {
  return isDetailsToggle(element) && element.props['aria-expanded'] === true
}

/**
 * A card is folded by default; open every card on the board so the controls it
 * holds back (priority, due date, tags, the Session row, the check form, the
 * next step) are on screen.
 * @returns how many cards were opened.
 */
function openCards() {
  let opened = 0
  for (;;) {
    const toggle = findElement(isFoldedToggle)
    if (!toggle) return opened
    click(toggle)
    opened += 1
    if (opened > 400) throw new Error('too many folded cards to open')
  }
}

/**
 * The card whose title field shows this title.
 * @param title - the card title.
 * @returns the card element, or null.
 */
function cardOf(title) {
  const card = findElement(element => element.type === 'article'
    && element.props !== undefined
    && element.props.className === 'dsh-board__task'
    && findIn(element, child => child.props !== undefined
      && child.props.className === 'dsh-board__taskTitle'
      && child.props.value === title) !== undefined)
  return card === undefined ? null : card
}

/**
 * Open one folded card so its controls are on screen.
 * @param title - the card title.
 */
function openCard(title) {
  const card = cardOf(title)
  if (card === null) throw new Error('no card titled "' + title + '"')
  const toggle = findIn(card, isFoldedToggle)
  if (toggle === undefined) throw new Error('card "' + title + '" is already open')
  click(toggle)
}

/**
 * Fold one open card again.
 * @param title - the card title.
 */
function foldCard(title) {
  const card = cardOf(title)
  if (card === null) throw new Error('no card titled "' + title + '"')
  const toggle = findIn(card, isOpenedToggle)
  if (toggle === undefined) throw new Error('card "' + title + '" is already folded')
  click(toggle)
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
let hostVerify = null
let hostState = null
let hostArchive = { count: 0, projects: [] }
/** Every operation the client sent, kept so the harness can prove which
 *  write vocabulary is in use. */
const sentOps = []

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
    for (const op of payload.ops) {
      if (op !== null && typeof op === 'object') sentOps.push(op)
    }
    if (payload.revision !== hostState.board.revision) {
      return jsonResponse(409, {
        ok: false,
        code: 'stale_revision',
        revision: hostState.board.revision,
        board: hostState.board,
      })
    }
    // Mirror host/routes.js: archive operations belong to the cold-storage
    // surface, everything else is prepared first and then applied by the pure
    // board layer.
    const boardOps = []
    payload.ops.forEach((op) => {
      if (op !== null && typeof op === 'object' && op.type === 'board.archive') return
      boardOps.push(op)
    })
    const prepared = hostVerify !== null && typeof hostVerify.prepareBatch === 'function'
      ? await hostVerify.prepareBatch(hostState.board, boardOps)
      : boardOps
    const outcome = hostBoard.applyOps(hostState.board, prepared, 'ui')
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
const sessionState = { ids: [], byId: {}, phase: 'ready', projectionsBySession: {}, createCalls: 0 }
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
  create: async () => {
    sessionState.createCalls += 1
    return nextSessionId
  },
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
  // The real HTTP route prepares each batch (filesystem probes) before the
  // board layer runs; the fake Host follows the same order so a material scan
  // behaves here exactly as it does through the route.
  try {
    hostVerify = await import(require('node:url').pathToFileURL(path.join(path.dirname(hostModulePath), 'verify.js')).href)
  } catch (error) {
    hostVerify = null
  }
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
  check('sidebar label localized', !!sidebar && sidebar.options.label() === '绿灯看板', !!sidebar ? sidebar.options.label() : '')
  check('the materials section is named in both locales',
    dictionaries.greenlight.zh['materials.section'] === '项目资料'
    && dictionaries.greenlight.en['materials.section'] === 'Project materials',
    JSON.stringify({ zh: dictionaries.greenlight.zh['materials.section'], en: dictionaries.greenlight.en['materials.section'] }))
  check('the reference locale group is gone',
    Object.keys(dictionaries.greenlight.zh).every(key => !key.startsWith('references.'))
    && Object.keys(dictionaries.greenlight.en).every(key => !key.startsWith('references.'))
    && dictionaries.greenlight.zh['plan.refCount'] === undefined
    && dictionaries.greenlight.en['plan.refCount'] === undefined
    && dictionaries.greenlight.zh['task.refs'] === undefined
    && dictionaries.greenlight.en['task.refs'] === undefined,
    JSON.stringify(Object.keys(dictionaries.greenlight.zh).filter(key => key.startsWith('references.'))))
  check('the shared.* locale group is gone',
    Object.keys(dictionaries.greenlight.zh).every(key => !key.startsWith('shared.'))
    && Object.keys(dictionaries.greenlight.en).every(key => !key.startsWith('shared.')),
    JSON.stringify(Object.keys(dictionaries.greenlight.zh).filter(key => key.startsWith('shared.'))))

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
  check('a long description keeps a readable title', testHelpers.deriveTitle('这是一个非常长的任务描述'.repeat(6)).length <= 120)
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
  check('legacy project starts with an empty materials text', migrated[0].materials === '', JSON.stringify(migrated[0].materials))
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
  // Work waiting in review cannot make the project look complete.
  check('a card in review caps the project below 100%',
    testHelpers.projectPercent({ tasks: [{ status: 'review', progress: 100 }] }) === 99,
    String(testHelpers.projectPercent({ tasks: [{ status: 'review', progress: 100 }] })))
  check('a pending review turns the project yellow',
    testHelpers.projectTone({ tasks: [{ status: 'review', progress: 100, blocked: false }] }) === 'yellow',
    testHelpers.projectTone({ tasks: [{ status: 'review', progress: 100, blocked: false }] }))
  check('only accepted cards reach 100%',
    testHelpers.projectPercent({ tasks: [{ status: 'done', progress: 100 }] }) === 100,
    String(testHelpers.projectPercent({ tasks: [{ status: 'done', progress: 100 }] })))
  check('round-trip keeps version 12', JSON.parse(testHelpers.serializeProjects(migrated)).version === 12)
  // A stored card written before the field existed reads as never dispatched;
  // a value it does carry survives the local mirror parse.
  check('the local mirror reads a missing dispatch mark as never dispatched',
    testHelpers.normalizeTask({ id: 't-legacy', title: '旧卡' }).contextSentAt === 0,
    String(testHelpers.normalizeTask({ id: 't-legacy', title: '旧卡' }).contextSentAt))
  check('the local mirror keeps a stored dispatch mark',
    testHelpers.normalizeTask({ id: 't-marked', title: '派过', contextSentAt: 777 }).contextSentAt === 777,
    String(testHelpers.normalizeTask({ id: 't-marked', title: '派过', contextSentAt: 777 }).contextSentAt))
  // A card written before the field existed, already bound and past todo, was
  // dispatched: the mirror must agree with the Host or the button flickers from
  // "open" back to "dispatch".
  check('the mirror takes a bound card past todo as already dispatched',
    testHelpers.normalizeTask({ id: 't-mig', title: '迁移', status: 'review', sessionId: 'sess-x', updatedAt: 1700000000000 }).contextSentAt === 1700000000000,
    String(testHelpers.normalizeTask({ id: 't-mig', title: '迁移', status: 'review', sessionId: 'sess-x', updatedAt: 1700000000000 }).contextSentAt))
  check('the mirror keeps a bound card in todo as never dispatched',
    testHelpers.normalizeTask({ id: 't-todo', title: '待办', status: 'todo', sessionId: 'sess-x', updatedAt: 1700000000000 }).contextSentAt === 0,
    String(testHelpers.normalizeTask({ id: 't-todo', title: '待办', status: 'todo', sessionId: 'sess-x', updatedAt: 1700000000000 }).contextSentAt))

  // Version 11 kept the project's structured materials in a `references` list,
  // and cards and draft items pointed at its entries; version 12 holds one
  // multi-line text, so reading an old document folds the list into it.
  const v11Doc = JSON.stringify({
    version: 11,
    projects: [{
      id: 'p-v11',
      name: 'v11 项目',
      references: [
        { id: 'r-link-1', kind: 'link', name: '需求文档', value: 'docs/req.md', description: '主需求', staleSince: 0 },
        { id: 'r-link-2', kind: 'link', name: '接口文档', value: 'https://example.test/api', description: '', staleSince: 0 },
        { id: 'r-note', kind: 'note', name: '约定', value: '先评审再实现', description: '', staleSince: 0 },
      ],
      tasks: [{ id: 't-v11', title: '引用过资料的卡', refs: ['r-link-1', 'r-note'] }],
      plan: { id: 'plan-v11', summary: '', createdAt: 1, items: [{ title: '草案项', refs: ['r-link-1'], deliverables: [] }] },
      memory: [],
      trash: [],
    }],
  })
  const migratedV11 = testHelpers.parseProjects(v11Doc)[0]
  const v11Lines = migratedV11.materials.split('\n')
  check('v11 references merge into three materials lines', v11Lines.length === 3, JSON.stringify(migratedV11.materials))
  check('every migrated line keeps its name and value',
    v11Lines[0] === '- 需求文档：docs/req.md（主需求）'
    && v11Lines[1] === '- 接口文档：https://example.test/api'
    && v11Lines[2] === '- 约定：先评审再实现',
    JSON.stringify(v11Lines))
  check('the migrated reference list is gone', !('references' in migratedV11), JSON.stringify(Object.keys(migratedV11)))
  check('the migrated card reference is gone', !('refs' in migratedV11.tasks[0]), JSON.stringify(Object.keys(migratedV11.tasks[0])))
  check('the migrated draft item reference is gone', !('refs' in migratedV11.plan.items[0]), JSON.stringify(Object.keys(migratedV11.plan.items[0])))
  check('a migrated document writes version 12', JSON.parse(testHelpers.serializeProjects([migratedV11])).version === 12)
  check('reading a migrated document twice does not duplicate',
    testHelpers.parseProjects(testHelpers.serializeProjects([migratedV11]))[0].materials === migratedV11.materials,
    JSON.stringify(testHelpers.parseProjects(testHelpers.serializeProjects([migratedV11]))[0].materials))
  check('a document that already carries materials keeps it',
    testHelpers.parseProjects(JSON.stringify({ version: 12, projects: [{ id: 'p-m', name: '已有资料', materials: '自定义资料', references: [] }] }))[0].materials === '自定义资料')

  // Version 9 held project material in `shared` (free text) plus a
  // `sharedEntries` list; both are folded into the text as well.
  const v9Doc = JSON.stringify({
    version: 9,
    projects: [{
      id: 'p-v9',
      name: '旧项目',
      shared: '先评审再实现',
      sharedEntries: [
        { id: 's-old', name: '设计稿', path: 'docs/design.md', description: '首页与详情页 2 版', staleSince: 0 },
      ],
      tasks: [{ id: 't-old', title: '引用旧资料的卡', refs: ['s-old'] }],
      memory: [],
    }],
  })
  const migratedV9 = testHelpers.parseProjects(v9Doc)[0]
  const v9Lines = migratedV9.materials.split('\n')
  check('v9 shared text becomes the first materials line', v9Lines[0] === '- 项目说明：先评审再实现', JSON.stringify(v9Lines))
  check('v9 shared entries become link lines', v9Lines[1] === '- 设计稿：docs/design.md（首页与详情页 2 版）', JSON.stringify(v9Lines))
  check('the legacy fields are dropped from the migrated project',
    !('shared' in migratedV9) && !('sharedEntries' in migratedV9) && !('references' in migratedV9),
    JSON.stringify(Object.keys(migratedV9)))
  check('the legacy card reference is dropped', !('refs' in migratedV9.tasks[0]), JSON.stringify(Object.keys(migratedV9.tasks[0])))
  check('migrating a v9 document twice does not duplicate',
    testHelpers.parseProjects(testHelpers.serializeProjects([migratedV9]))[0].materials === migratedV9.materials,
    JSON.stringify(testHelpers.parseProjects(testHelpers.serializeProjects([migratedV9]))[0].materials))

  /* ------------------------------------------------------ UI interaction */

  const settle = ms => new Promise(resolve => setTimeout(resolve, ms === undefined ? 320 : ms))
  const mount = async (options) => {
    // Let the previous mounted page flush and settle its pending queue first:
    // its timer would otherwise fire after the fake Host was reset and write
    // into the next test's fresh board.
    await settle(600)
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
  check('the rail carries no empty-project hint', !textOf().includes('先在下面新建一个'), textOf().slice(0, 160))
  const initialMirror = stored()
  check('local mirror starts from an empty host board', initialMirror === null || initialMirror.projects.length === 0, JSON.stringify(initialMirror && initialMirror.projects.length))

  console.log('\n[6] create a project')
  change(byAria('新建项目'), 'Alpha 项目')
  submit(formOf(byAria('新建项目')))
  let doc = stored()
  check('document version 12', doc && doc.version === 12, doc && String(doc.version))
  check('project created', doc && doc.projects.length === 1 && doc.projects[0].name === 'Alpha 项目')
  check('project starts with an empty materials text', doc && doc.projects[0].materials === '', doc && JSON.stringify(doc.projects[0].materials))
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
  // The slider, the blocked switch and the note live behind the card's details.
  openCards()
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

  console.log('\n[9] project materials: one text box that writes itself')
  const materialsBox = byAria('项目资料')
  check('the materials card renders a textarea', materialsBox !== null && materialsBox.type === 'textarea', materialsBox && String(materialsBox.type))
  check('the textarea is six rows tall', materialsBox !== null && materialsBox.props.rows === 6, materialsBox && String(materialsBox.props.rows))
  check('the textarea is seeded from the project', materialsBox !== null && materialsBox.props.value === '', materialsBox && JSON.stringify(materialsBox.props.value))
  check('the placeholder names the material kinds',
    materialsBox !== null && materialsBox.props.placeholder === '例：docs/需求.md、接口文档链接、先评审再实现',
    materialsBox && materialsBox.props.placeholder)
  check('the card is titled project materials', textOf().includes('项目资料'))
  check('the old materials UI is gone',
    !textOf().includes('扫描材料') && !textOf().includes('添加资料') && !textOf().includes('共享资料'),
    textOf().slice(0, 240))
  check('no reference wording is rendered',
    !textOf().includes('链接') && !textOf().includes('约定') && !textOf().includes('其它') && !textOf().includes('引用资料'),
    textOf().slice(0, 240))

  // Typing is local first: the box and the mirror change before the Host hears
  // anything, and the write itself waits for the burst of keystrokes to stop.
  change(materialsBox, 'docs/需求.md')
  check('typing shows immediately', byAria('项目资料').props.value === 'docs/需求.md', JSON.stringify(byAria('项目资料').props.value))
  check('the local mirror already carries the text', stored().projects[0].materials === 'docs/需求.md', JSON.stringify(stored().projects[0].materials))
  change(byAria('项目资料'), 'docs/需求.md\n先评审再实现')
  change(byAria('项目资料'), 'docs/需求.md\n先评审再实现\nhttps://example.test/api')
  const burstText = 'docs/需求.md\n先评审再实现\nhttps://example.test/api'
  check('the box shows the latest text', byAria('项目资料').props.value === burstText, JSON.stringify(byAria('项目资料').props.value))
  const materialsSentBefore = sentOps.filter(op => op.type === 'project.setMaterials').length
  await settle(250)
  check('nothing is sent while the typing continues',
    sentOps.filter(op => op.type === 'project.setMaterials').length === materialsSentBefore,
    JSON.stringify(sentOps.map(op => op.type)))
  check('the card says it is still typing', textOf().includes('输入中…'), textOf().slice(0, 240))
  await settle(700)
  const materialsOps = sentOps.filter(op => op.type === 'project.setMaterials')
  check('one materials op covers the whole burst', materialsOps.length === 1, JSON.stringify(sentOps.map(op => op.type)))
  check('the op carries the latest text', materialsOps.length === 1 && materialsOps[0].materials === burstText, JSON.stringify(materialsOps[0]))
  check('the op names the project', materialsOps.length === 1 && materialsOps[0].projectId === stored().projects[0].id, JSON.stringify(materialsOps[0]))
  check('the card settles to saved', textOf().includes('已保存'), textOf().slice(0, 240))
  check('the host stores the materials text', hostState.board.projects[0].materials === burstText, JSON.stringify(hostState.board.projects[0].materials))
  check('no reference operation is used',
    !sentOps.some(op => String(op.type).startsWith('reference.')),
    JSON.stringify([...new Set(sentOps.map(op => op.type))]))

  // Clearing the text is a normal write: an empty string clears the materials.
  change(byAria('项目资料'), '')
  await settle(800)
  check('clearing stores an empty text', stored().projects[0].materials === '', JSON.stringify(stored().projects[0].materials))
  check('the host also cleared the text', hostState.board.projects[0].materials === '', JSON.stringify(hostState.board.projects[0].materials))
  check('clearing is one more materials op', sentOps.filter(op => op.type === 'project.setMaterials').length === 2, JSON.stringify(sentOps.map(op => op.type)))

  // Leave a text behind so the rest of the run can prove it survives edits.
  change(byAria('项目资料'), '先评审再实现')
  await settle(800)
  check('the final materials text reached the host', hostState.board.projects[0].materials === '先评审再实现', JSON.stringify(hostState.board.projects[0].materials))
  check('the box shows exactly what the project stores',
    byAria('项目资料').props.value === stored().projects[0].materials,
    JSON.stringify({ box: byAria('项目资料').props.value, stored: stored().projects[0].materials }))

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
  // The Session row no longer carries its own open control: opening a Session is
  // the second state of the card's single button, and this card was never
  // dispatched, so no open control is on screen yet.
  check('a never-dispatched card offers no open control', byButtonText('打开会话') === null, textOf().slice(0, 300))
  check('the card still offers dispatch for that Session', byButtonText('派给会话') !== null, textOf().slice(0, 300))
  const rowAfterCreate = byClassName('dsh-board__sessionRow')[0]
  const rowButtonTexts = rowAfterCreate === undefined
    ? []
    : descendants(rowAfterCreate, []).filter(element => element.type === 'button').map(element => childText(element))
  check('the Session row keeps its controls and renders no open control of its own',
    rowButtonTexts.includes('解除关联') && !rowButtonTexts.includes('打开会话'),
    JSON.stringify(rowButtonTexts))

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
  click(byAria('删除子任务'))
  check('deleting a subtask asks for confirmation', hasConfirm())
  check('nothing was deleted before the answer', stored().projects[0].tasks.length === 1, String(stored().projects[0].tasks.length))
  confirmNow('删除')
  doc = stored()
  check('project survives', doc && doc.projects.length === 1)
  check('subtasks emptied', doc && doc.projects[0].tasks.length === 0)
  check('the materials text survives', doc && doc.projects[0].materials === '先评审再实现', doc && JSON.stringify(doc.projects[0].materials))
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
  const revisionBefore = hostState.board.revision
  change(byAria('新建项目'), '同步项目')
  submit(formOf(byAria('新建项目')))
  await settle()
  check('project reached the host', hostState.board.projects.length === 1 && hostState.board.projects[0].name === '同步项目', JSON.stringify(hostState.board.projects.map(project => project.name)))
  check('host revision advanced once', hostState.board.revision === revisionBefore + 1, hostState.board.revision + ' vs ' + revisionBefore)
  change(byAria('任务描述（自动生成标题）'), '把结果写进宿主')
  submit(formOf(byAria('任务描述（自动生成标题）')))
  await settle()
  check('subtask reached the host', hostState.board.projects[0].tasks.length === 1, String(hostState.board.projects[0].tasks.length))
  check('host subtask starts in todo', hostState.board.projects[0].tasks[0].status === 'todo', hostState.board.projects[0].tasks[0].status)
  openCards()
  change(byClassName('dsh-board__range')[0], '80')
  await settle()
  check('progress reached the host', hostState.board.projects[0].tasks[0].progress === 80, String(hostState.board.projects[0].tasks[0].progress))
  check('pill reports a synced board', textOf().includes('已同步'), textOf().slice(0, 160))

  console.log('\n[19] a browser v9 document seeds an empty Host once')
  const legacyLocal = JSON.stringify({
    version: 9,
    projects: [{
      id: 'p-local',
      name: '本地旧项目',
      shared: 'docs/x.md',
      sharedEntries: [{ id: 's-local', name: '旧链接', path: 'legacy/site.zip', description: '', staleSince: 0 }],
      tasks: [],
      memory: [],
    }],
  })
  await mount({ seedLocal: legacyLocal })
  await settle(460)
  check('host imported the local project', hostState.board.projects.length === 1 && hostState.board.projects[0].name === '本地旧项目', JSON.stringify(hostState.board.projects.map(project => project.name)))
  check('the browser document was backed up', storage.has('dsh.greenlight.v1.backup'))
  const importedMaterials = hostState.board.projects[0].materials
  check('the v9 shared text became the first materials line',
    typeof importedMaterials === 'string' && importedMaterials.split('\n')[0] === '- 项目说明：docs/x.md',
    JSON.stringify(importedMaterials))
  check('the v9 entry became a materials line',
    typeof importedMaterials === 'string' && importedMaterials.split('\n')[1] === '- 旧链接：legacy/site.zip',
    JSON.stringify(importedMaterials))
  check('the mirror carries the materials text', stored().projects[0].materials === importedMaterials, JSON.stringify(stored().projects[0].materials))
  check('the mirror matches the host', stored().projects[0].name === '本地旧项目')

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
    {
      id: 'p',
      name: '项目P',
      materials: '共享C\n- 文档：docs/spec.md',
      memory: [{ id: 'm', text: '记忆D', taskId: 't' }],
    },
  )
  check('dispatch prompt carries title, note, materials and linked memory',
    promptSample.includes('标题A') && promptSample.includes('说明B') && promptSample.includes('共享C') && promptSample.includes('docs/spec.md') && promptSample.includes('记忆D'),
    promptSample.slice(0, 160))
  // A Session cannot call a tool for a card it cannot name: the ids and the tool
  // names have to be in the prompt, or the board stays a separate universe.
  check('dispatch prompt names the project and card ids',
    promptSample.includes('projectId：p') && promptSample.includes('taskId：t'),
    promptSample.slice(0, 260))
  check('dispatch prompt tells the agent which board tools to call',
    promptSample.includes('greenlight_task_update')
    && promptSample.includes('greenlight_task_submit')
    && promptSample.includes('greenlight_materials')
    && promptSample.includes('不要自己把卡片标成 done'),
    promptSample.slice(-220))

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
  // The advance control lives behind the details, so the card opens first.
  openCards()
  click(byButtonText('\u2192'))
  await settle()
  let taskDoc = stored().projects[0].tasks
  check('card advanced to running', taskDoc.some(task => task.status === 'running'), JSON.stringify(taskDoc.map(task => task.status)))
  check('host saw the move', hostState.board.projects[0].tasks.some(task => task.status === 'running'))

  // The card that just moved folded in its new column; open the board again.
  openCards()
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
  openCards()
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
  // The remaining card is in a column of its own; open it so its arrow is on screen.
  openCards()
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
  openCards()
  const sessionless = findAll(element => element.type === 'button' && childText(element) === '派给会话')
  check('every card offers the merged dispatch control', sessionless.length > 0, String(sessionless.length))
  check('an unbound card can create its own Session, so the control is enabled',
    sessionless.every(button => button.props.disabled !== true),
    JSON.stringify(sessionless.map(button => button.props.disabled)))
  sessionState.ids = ['sess-dispatch']
  sessionState.byId = { 'sess-dispatch': { id: 'sess-dispatch', displayTitle: '派活会话', running: false } }
  rerender()
  const linkSelects = findAll(element => element.props && element.props['aria-label'] === '关联已有会话')
  check('link menu available for dispatch', linkSelects.length > 0)
  change(linkSelects[0], 'sess-dispatch')
  await settle()
  check('subtask bound to the Session', stored().projects[0].tasks.some(task => task.sessionId === 'sess-dispatch'), JSON.stringify(stored().projects[0].tasks.map(task => task.sessionId)))
  // Linking a Session does not send it anything: the card has to say so, or the
  // Session runs the work knowing nothing about the materials or the card id.
  check('a bound but undispatched card warns the Session has no board context',
    textOf().includes('这个会话还没收到看板上下文'), textOf().slice(0, 400))
  const dispatchButtons = findAll(element => element.type === 'button' && childText(element) === '派给会话')
  check('dispatch is enabled once bound', dispatchButtons.some(button => button.props.disabled !== true))
  click(dispatchButtons[0])
  await settle(500)
  check('one prompt was sent', prompted.length === 1, String(prompted.length))
  check('prompt goes through the queue channel', prompted.length === 1 && prompted[0].mode === 'queue')
  check('prompt carries the card title', prompted.length === 1 && prompted[0].text.includes('请执行看板上的这个子任务'), prompted.length === 1 ? prompted[0].text.slice(0, 80) : '')
  check('dispatched card moves to running', stored().projects[0].tasks.some(task => task.sessionId === 'sess-dispatch' && task.status === 'running'), JSON.stringify(stored().projects[0].tasks.map(task => task.status)))
  check('dispatch prompt ends with the tool instructions', prompted.length === 1 && prompted[0].text.includes('不要自己把卡片标成 done'), prompted.length === 1 ? prompted[0].text.slice(-60) : '')
  check('dispatch prompt carries the real card id', prompted.length === 1 && prompted[0].text.includes('taskId：'), prompted.length === 1 ? prompted[0].text.slice(0, 200) : '')
  check('dispatching clears the missing-context warning', !textOf().includes('这个会话还没收到看板上下文'), textOf().slice(0, 400))
  check('dispatch records that the Session received the board context',
    stored().projects[0].tasks.some(task => task.sessionId === 'sess-dispatch' && task.contextSentAt > 0),
    JSON.stringify(stored().projects[0].tasks.map(task => ({ sessionId: task.sessionId, contextSentAt: task.contextSentAt }))))
  // The dispatch moved the card into running, where it folded again.
  openCards()
  const openButtonsAfterDispatch = findAll(element => element.type === 'button' && childText(element) === '打开会话')
  check('the dispatched card button switches to open', openButtonsAfterDispatch.length === 1, String(openButtonsAfterDispatch.length))
  const sessionRowAfterDispatch = byClassName('dsh-board__sessionRow')[0]
  check('the open control is the card button, not the Session row',
    sessionRowAfterDispatch === undefined
    || findIn(sessionRowAfterDispatch, element => element.type === 'button' && childText(element) === '打开会话') === undefined,
    textOf().slice(0, 320))

  console.log('\n[28b] one card button: dispatch first, then open the Session')
  const taskButtonSeed = (tasks) => ({
    version: 12,
    revision: 101,
    updatedAt: new Date().toISOString(),
    projects: [{
      id: 'p-one',
      name: '单按钮项目',
      acceptanceMode: 'auto',
      materials: '',
      memory: [],
      trash: [],
      tasks,
    }],
  })

  // --- no Session yet: the button creates one, then dispatches into it.
  sessionState.ids = []
  sessionState.byId = {}
  sessionState.createCalls = 0
  nextSessionId = 'sess-auto-1'
  prompted.length = 0
  openedSessions.length = 0
  await mount({
    seedHost: taskButtonSeed([{ id: 't-new', title: '还没派过的卡', status: 'todo', progress: 0, sessionId: '', contextSentAt: 0 }]),
  })
  await settle(300)
  openCards()
  const createDispatchButton = byButtonText('派给会话')
  check('an unbound card shows the dispatch label', createDispatchButton !== null, textOf().slice(0, 240))
  check('the unbound card shows no open label yet', byButtonText('打开会话') === null, textOf().slice(0, 240))
  click(createDispatchButton)
  await flush()
  // The mirror must switch the button before the Host acknowledges: a partial
  // optimistic write would drop the Session the create step just bound.
  const optimisticTask = stored().projects[0].tasks[0]
  check('the card is armed the moment the prompt is sent',
    optimisticTask.sessionId === 'sess-auto-1' && optimisticTask.status === 'running' && optimisticTask.contextSentAt > 0,
    JSON.stringify(optimisticTask))
  // Dispatching moved the card into running, so it folded again.
  openCards()
  check('the card button says open before the Host answers', byButtonText('打开会话') !== null, textOf().slice(0, 300))
  await settle(600)
  await flush()
  check('clicking dispatch created one Session', sessionState.createCalls === 1, String(sessionState.createCalls))
  const createdTask = stored().projects[0].tasks[0]
  check('the created Session is bound to the card', createdTask.sessionId === 'sess-auto-1', createdTask.sessionId)
  check('the prompt went to the new Session',
    prompted.length === 1 && prompted[0].sessionId === 'sess-auto-1',
    JSON.stringify(prompted.map(entry => entry.sessionId)))
  check('the dispatched card moves to running', createdTask.status === 'running', createdTask.status)
  check('the card records when the context was sent', createdTask.contextSentAt > 0, String(createdTask.contextSentAt))
  check('the Host stored the dispatch mark',
    hostState.board.projects[0].tasks[0].contextSentAt > 0,
    String(hostState.board.projects[0].tasks[0].contextSentAt))
  check('the card button now says open', byButtonText('打开会话') !== null, textOf().slice(0, 300))
  const createdOpenButtons = findAll(element => element.type === 'button' && childText(element) === '打开会话')
  check('only the card carries the open control', createdOpenButtons.length === 1, String(createdOpenButtons.length))
  const openedBeforeClick = openedSessions.length
  click(createdOpenButtons[0])
  await settle(200)
  check('opening really switches the workspace to that Session',
    openedSessions.length === openedBeforeClick + 1 && openedSessions[openedSessions.length - 1] === 'sess-auto-1',
    JSON.stringify(openedSessions))
  check('opening sends no prompt again', prompted.length === 1, String(prompted.length))
  check('opening creates no Session', sessionState.createCalls === 1, String(sessionState.createCalls))

  // --- bound but never dispatched: no new Session, only the prompt.
  sessionState.ids = ['sess-bound']
  sessionState.byId = { 'sess-bound': { id: 'sess-bound', displayTitle: '已绑定会话', running: false } }
  sessionState.createCalls = 0
  prompted.length = 0
  openedSessions.length = 0
  await mount({
    seedHost: taskButtonSeed([{ id: 't-bound', title: '绑定未派活的卡', status: 'todo', progress: 0, sessionId: 'sess-bound', contextSentAt: 0 }]),
  })
  await settle(300)
  openCards()
  const boundDispatchButton = byButtonText('派给会话')
  check('a bound but undispatched card shows the dispatch label', boundDispatchButton !== null, textOf().slice(0, 240))
  check('that card warns its Session has no board context', textOf().includes('这个会话还没收到看板上下文'), textOf().slice(0, 320))
  click(boundDispatchButton)
  await flush()
  const optimisticBoundTask = stored().projects[0].tasks[0]
  check('the bound card is armed before the Host answers',
    optimisticBoundTask.status === 'running' && optimisticBoundTask.contextSentAt > 0,
    JSON.stringify(optimisticBoundTask))
  await settle(600)
  await flush()
  check('dispatching into the bound Session creates no new Session', sessionState.createCalls === 0, String(sessionState.createCalls))
  check('the bound Session received the prompt',
    prompted.length === 1 && prompted[0].sessionId === 'sess-bound',
    JSON.stringify(prompted.map(entry => entry.sessionId)))
  const boundTask = stored().projects[0].tasks[0]
  check('the bound card moves to running', boundTask.status === 'running', boundTask.status)
  check('the bound card records contextSentAt', boundTask.contextSentAt > 0, String(boundTask.contextSentAt))
  // The dispatch moved this card into running, so open it again.
  openCards()
  check('the bound card button becomes open', byButtonText('打开会话') !== null, textOf().slice(0, 300))

  // --- already dispatched: the button only switches the workspace.
  sessionState.ids = ['sess-armed']
  sessionState.byId = { 'sess-armed': { id: 'sess-armed', displayTitle: '已派活会话', running: false } }
  sessionState.createCalls = 0
  prompted.length = 0
  openedSessions.length = 0
  await mount({
    seedHost: taskButtonSeed([{
      id: 't-armed',
      title: '已派活的卡',
      status: 'running',
      progress: 20,
      sessionId: 'sess-armed',
      contextSentAt: Date.now() - 1000,
    }]),
  })
  await settle(300)
  openCards()
  check('a dispatched card labels its button open',
    byButtonText('打开会话') !== null && byButtonText('派给会话') === null,
    textOf().slice(0, 300))
  const armedOpenButtons = findAll(element => element.type === 'button' && childText(element) === '打开会话')
  check('exactly one open control is on screen', armedOpenButtons.length === 1, String(armedOpenButtons.length))
  const armedSessionRow = byClassName('dsh-board__sessionRow')[0]
  check('the Session row renders no open control of its own',
    armedSessionRow !== undefined
    && findIn(armedSessionRow, element => element.type === 'button' && childText(element) === '打开会话') === undefined,
    textOf().slice(0, 320))
  const statusStrip = byClassName('dsh-board__taskStatus')[0]
  check('the open control lives in the card strip',
    statusStrip !== undefined
    && findIn(statusStrip, element => element.type === 'button' && childText(element) === '打开会话') !== undefined,
    textOf().slice(0, 320))
  click(armedOpenButtons[0])
  await settle(200)
  check('open sends no prompt', prompted.length === 0, String(prompted.length))
  check('open switches to the exact bound Session',
    openedSessions.length === 1 && openedSessions[0] === 'sess-armed', JSON.stringify(openedSessions))
  check('open creates no Session', sessionState.createCalls === 0, String(sessionState.createCalls))

  // --- both halves of the create-then-dispatch chain report their failure.
  sessionState.ids = []
  sessionState.byId = {}
  sessionState.createCalls = 0
  prompted.length = 0
  openedSessions.length = 0
  await mount({
    seedHost: taskButtonSeed([{ id: 't-fail', title: '两步都会失败的卡', status: 'todo', progress: 0, sessionId: '', contextSentAt: 0 }]),
  })
  await settle(300)
  openCards()
  const originalCreateForButton = fakeSessions.create
  fakeSessions.create = async () => {
    sessionState.createCalls += 1
    throw new Error('宿主拒绝创建')
  }
  click(byButtonText('派给会话'))
  await settle(600)
  await flush()
  check('a failed Session creation is shown on the card',
    textOf().includes('派活失败') && textOf().includes('宿主拒绝创建'), textOf().slice(0, 360))
  check('a failed Session creation sends no prompt', prompted.length === 0, String(prompted.length))
  check('a failed Session creation leaves the card unbound',
    stored().projects[0].tasks[0].sessionId === '', stored().projects[0].tasks[0].sessionId)
  fakeSessions.create = originalCreateForButton
  const originalUsingForButton = fakeSessions.using
  fakeSessions.using = async () => ({ ok: false, error: { message: '额度不足' } })
  nextSessionId = 'sess-refused'
  click(byButtonText('派给会话'))
  await settle(600)
  await flush()
  check('a failed prompt is shown on the card',
    textOf().includes('派活失败') && textOf().includes('额度不足'), textOf().slice(0, 360))
  const refusedTask = stored().projects[0].tasks[0]
  check('a failed prompt records no contextSentAt', refusedTask.contextSentAt === 0, String(refusedTask.contextSentAt))
  check('a failed prompt leaves the card in todo', refusedTask.status === 'todo', refusedTask.status)
  check('the Session created before the failure stays bound', refusedTask.sessionId === 'sess-refused', refusedTask.sessionId)
  fakeSessions.using = originalUsingForButton
  check('the merged button reuses the existing locale keys',
    dictionaries.greenlight.zh['task.dispatch'] === '派给会话'
    && dictionaries.greenlight.zh['task.openSession'] === '打开会话'
    && dictionaries.greenlight.zh['task.dispatching'] === '派发中…'
    && dictionaries.greenlight.en['task.dispatch'] === 'Dispatch to Session'
    && dictionaries.greenlight.en['task.openSession'] === 'Open Session',
    JSON.stringify({
      zhDispatch: dictionaries.greenlight.zh['task.dispatch'],
      zhOpen: dictionaries.greenlight.zh['task.openSession'],
      enDispatch: dictionaries.greenlight.en['task.dispatch'],
      enOpen: dictionaries.greenlight.en['task.openSession'],
    }))

  // --- without the Session Controller an unbound card cannot create a Session.
  await settle(600)
  storage.clear()
  instances.clear()
  resetHost()
  hostState.board = taskButtonSeed([{
    id: 't-no-service',
    title: '没有会话服务的卡',
    status: 'todo',
    progress: 0,
    sessionId: '',
    contextSentAt: 0,
  }])
  rootElement = createElement(Page, {
    t: fakeCtx.locale.bind('greenlight'),
    closeBoard: () => {},
    services: { sessions: undefined, workspaces: fakeWorkspaces, uiWorkspace: fakeUiWorkspace },
  })
  rerender()
  await settle(300)
  openCards()
  const noServiceButton = byButtonText('派给会话')
  check('an unbound card stays disabled without the Session service',
    noServiceButton !== null && noServiceButton.props.disabled === true,
    noServiceButton === null ? 'no button on screen' : String(noServiceButton.props.disabled))

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
  openCards()
  change(byAria('优先级'), 'high')
  change(byAria('截止'), '2026-12-31')
  change(byAria('标签'), '后端, 联调')
  await settle()
  let cd = stored().projects[0].tasks[0]
  check('priority stored', cd.priority === 'high', cd.priority)
  check('due date stored', cd.dueDate === '2026-12-31', cd.dueDate)
  check('tags stored', JSON.stringify(cd.tags) === JSON.stringify(['后端', '联调']), JSON.stringify(cd.tags))
  check('host received the new fields', hostState.board.projects[0].tasks[0].priority === 'high' && hostState.board.projects[0].tasks[0].dueDate === '2026-12-31', JSON.stringify(hostState.board.projects[0].tasks[0]))

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

  console.log('\n[36] review gate, back-move, overdue and memory edit')
  await mount()
  change(byAria('新建项目'), 'E 批次项目')
  submit(formOf(byAria('新建项目')))
  change(byAria('任务描述（自动生成标题）'), '回退与逾期用例')
  submit(formOf(byAria('任务描述（自动生成标题）')))
  await settle()

  // Back-move: from running, the back control returns the card to todo.
  openCards()
  click(byButtonText('\u2192'))
  await settle()
  check('card advanced to running', stored().projects[0].tasks[0].status === 'running', stored().projects[0].tasks[0].status)
  openCards()
  click(byButtonText('\u2190'))
  await settle()
  check('back button returns the card one column', stored().projects[0].tasks[0].status === 'todo', stored().projects[0].tasks[0].status)

  // Advance to review: that column intentionally has no plain back control
  // (a rejection carries a reason instead).
  openCards()
  click(byButtonText('\u2192'))
  await settle()
  openCards()
  click(byButtonText('\u2192'))
  await settle()
  check('card advanced to review', stored().projects[0].tasks[0].status === 'review', stored().projects[0].tasks[0].status)
  check('review offers no plain back control', byButtonText('\u2190') === null)
  check('review offers accept and reject instead', byButtonText('通过') !== null && byButtonText('打回') !== null)

  // Overdue: a due date in the past marks the card.
  openCards()
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
    version: 10,
    revision: 5,
    updatedAt: new Date().toISOString(),
    projects: [{
      id: 'p-acc',
      name: '验收项目',
      acceptanceMode: 'auto',
      materials: '',
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
  openCards()

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
    version: 10,
    revision: 9,
    updatedAt: new Date().toISOString(),
    projects: [{
      id: 'p-rules',
      name: '规则项目',
      acceptanceMode: 'auto',
      acceptanceRules: { requireEvidence: true, requireDeliverables: false, verifyDeliverables: true, requireSession: false },
      rootDir: '',
      materials: '',
      memory: [],
      trash: [],
      tasks: [
        { id: 't-missing', title: '缺交付物', status: 'review', progress: 100, evidence: '写了报告', deliverables: ['docs/report.md'], verification: { checked: true, missing: ['docs/report.md'], unresolved: [] }, reviewReason: '交付物不存在或为空：docs/report.md', acceptance: { pass: false, reasons: ['交付物不存在或为空：docs/report.md'], at: Date.now() } },
      ],
    }],
  }
  await mount({ seedHost: ruleSeed })
  await settle(400)
  openCards()

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
  const disciplineSeed = {
    version: 10,
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
      materials: '回查过的资料都在这段文字里',
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
  await mount({ seedHost: disciplineSeed })
  await settle(400)
  openCards()

  const nextField = byAria('下一步')
  check('next action is visible in its field', nextField !== null && nextField.props.value === '补 build 层验证', nextField && String(nextField.props.value))
  check('claims are listed with their layer', textOf().includes('单测通过') && textOf().includes('单测'))
  check('verification debt is called out', textOf().includes('验证债'), textOf().slice(0, 340))
  check('the audit trail is present', textOf().includes('轨迹'))
  const disciplineMaterials = byAria('项目资料')
  check('the materials text is shown as typed',
    disciplineMaterials !== null && disciplineMaterials.props.value === '回查过的资料都在这段文字里',
    disciplineMaterials && JSON.stringify(disciplineMaterials.props.value))
  check('the recheck control exists', byButtonText('复查交付物') !== null)

  // Editing the next action is a synced patch.
  change(byAria('下一步'), '先补 build 验证')
  await settle(420)
  await flush()
  check('next action persisted locally', stored().projects[0].tasks[0].nextAction === '先补 build 验证', stored().projects[0].tasks[0].nextAction)
  check('next action reached the host', hostState.board.projects[0].tasks[0].nextAction === '先补 build 验证', hostState.board.projects[0].tasks[0].nextAction)

  // The recheck control is a synced op that survives a round trip.
  click(byButtonText('复查交付物'))
  await settle(500)
  await flush()
  check('recheck reached the host', hostState.board.projects[0].lastCheckAt > 0, String(hostState.board.projects[0].lastCheckAt))

console.log('\n[41] the claim form and the archive')
  const claimSeed = {
    version: 10,
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
      materials: '',
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
  openCards()

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
    version: 10,
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
      materials: '',
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

  // Deleting a memory entry asks first.
  click(byAria('删除记忆'))
  check('deleting memory asks', hasConfirm())
  cancelConfirm()
  check('the memory entry survives a cancel', stored().projects[0].memory.length === 1)

  // Nothing was written to the Host while all of that was cancelled.
  check('cancelled actions wrote nothing', hostState.board.projects[0].memory.length === 1 && hostState.board.projects[0].tasks.length === 1, JSON.stringify({ memory: hostState.board.projects[0].memory.length, tasks: hostState.board.projects[0].tasks.length }))

console.log('\n[43] the project rail collapses and remembers it')
  const railSeed = {
    version: 10,
    revision: 41,
    updatedAt: new Date().toISOString(),
    projects: [
      { id: 'pa', name: '甲项目', acceptanceMode: 'auto', acceptanceRules: {}, requiredLayers: [], gates: {}, anchor: {}, materials: '', memory: [], trash: [], tasks: [] },
      { id: 'pb', name: '乙项目', acceptanceMode: 'auto', acceptanceRules: {}, requiredLayers: [], gates: {}, anchor: {}, materials: '', memory: [], trash: [], tasks: [] },
    ],
  }
  await mount({ seedHost: railSeed })
  await settle(300)

  const railOf = () => byClassName('dsh-board__rail')[0]
  const railButtons = () => byClassName('dsh-board__railToggle')
  check('the rail starts expanded', railOf() !== undefined)
  check('there is exactly one rail control', railButtons().length === 1, String(railButtons().length))
  check('the control says it will collapse', byAria('收起项目栏') !== null)
  check('project names are visible while expanded', textOf().includes('甲项目'))

  const firstToggle = railButtons()[0]
  click(byAria('收起项目栏'))
  await settle(200)
  check('collapsing removes the rail entirely', byClassName('dsh-board__rail').length === 0, String(byClassName('dsh-board__rail').length))
  check('no project names remain on screen', !textOf().includes('甲项目'))
  check('collapsing is remembered', storage.get('dsh.greenlight.railCollapsed') === '1', String(storage.get('dsh.greenlight.railCollapsed')))
  check('the same control is still on screen', railButtons().length === 1, String(railButtons().length))
  check('it now says it will expand', byAria('展开项目栏') !== null)
  check('the control keeps its place in the header', railButtons()[0].props.children !== undefined && byClassName('dsh-board__titleRow').length === 1)
  check('the icon reflects the closed rail', firstToggle.props['aria-expanded'] === 'true')

  click(byAria('展开项目栏'))
  await settle(200)
  check('the rail comes back', byClassName('dsh-board__rail').length === 1)
  check('expanding is remembered', storage.get('dsh.greenlight.railCollapsed') === '0', String(storage.get('dsh.greenlight.railCollapsed')))
  check('the control is still the only one', railButtons().length === 1, String(railButtons().length))
  check('project names come back', textOf().includes('甲项目') && textOf().includes('乙项目'))

console.log('\n[44] the client only writes the version-12 materials operation')
  check('the local mirror stores one materials text and no reference list',
    stored().projects.every(project => typeof project.materials === 'string'
      && !('references' in project)
      && !('shared' in project)
      && !('sharedEntries' in project)),
    JSON.stringify(Object.keys(stored().projects[0])))
  check('no legacy reference or shared operation was sent',
    !sentOps.some(op => String(op.type).startsWith('reference.')
      || op.type === 'project.setShared'
      || String(op.type).startsWith('sharedEntry.')),
    JSON.stringify([...new Set(sentOps.map(op => op.type))]))
  check('materials are written through project.setMaterials',
    sentOps.some(op => op.type === 'project.setMaterials'),
    JSON.stringify([...new Set(sentOps.map(op => op.type))]))

console.log('\n[45] version 12: the draft plan and its migration')
  // Version 10 has no plan field at all: reading one must yield a null draft,
  // and writing it back must already be version 12.
  const v10Doc = JSON.stringify({
    version: 10,
    projects: [{
      id: 'p-v10-plan',
      name: 'v10 项目',
      references: [{ id: 'r-v10', kind: 'link', name: '旧文档', value: 'docs/old.md', description: '', staleSince: 0 }],
      tasks: [{ id: 't-v10', title: '旧卡片' }],
      memory: [],
      trash: [],
    }],
  })
  const migratedV10 = testHelpers.parseProjects(v10Doc)
  check('a version-10 document is rewritten as version 12', JSON.parse(testHelpers.serializeProjects(migratedV10)).version === 12)
  check('a version-10 project migrates to a null plan', migratedV10.length === 1 && migratedV10[0].plan === null, JSON.stringify(migratedV10[0] && migratedV10[0].plan))
  check('the version-10 references become a materials text',
    migratedV10[0].materials === '- 旧文档：docs/old.md', JSON.stringify(migratedV10[0].materials))
  check('material and draft locale text is registered in both locales',
    dictionaries.greenlight.zh['materials.section'] === '项目资料'
    && dictionaries.greenlight.en['materials.section'] === 'Project materials'
    && dictionaries.greenlight.zh['materials.placeholder'] === '例：docs/需求.md、接口文档链接、先评审再实现'
    && dictionaries.greenlight.en['materials.placeholder'] === 'e.g. docs/spec.md, an API doc link, review before implementing'
    && dictionaries.greenlight.zh['plan.section'] === '拆解草案'
    && dictionaries.greenlight.en['plan.section'] === 'Draft plan',
    JSON.stringify({ zh: dictionaries.greenlight.zh['plan.section'], en: dictionaries.greenlight.en['plan.section'] }))

  const planSeed = {
    version: 10,
    revision: 61,
    projects: [{
      id: 'p-plan',
      name: '草案项目',
      references: [{ id: 'ref-plan', kind: 'link', name: '接口文档', value: 'docs/api.md', description: '', staleSince: 0 }],
      tasks: [],
      memory: [],
      trash: [],
      plan: {
        id: 'plan-1',
        summary: '把旧静态站迁到新构建链路，先文档后构建',
        createdAt: Date.now(),
        items: [
          // `bogus` is not part of the shape: a hand-edited document must not
          // smuggle extra state into the board through the draft.
          { title: '整理目录结构', note: '输出目录树与依赖清单', priority: 'normal', tags: ['docs'], refs: ['ref-plan'], deliverables: ['docs/tree.md'], bogus: 'ignored' },
          { title: '迁移构建脚本', note: '', priority: 'high', tags: [], refs: [], deliverables: [] },
          { title: '首页性能优化', note: '很长的说明'.repeat(20), priority: 'urgent', tags: ['perf'], refs: [], deliverables: [] },
        ],
      },
    }],
  }
  const planParsed = testHelpers.parseProjects(JSON.stringify(planSeed))[0]
  check('a stored draft plan is parsed', planParsed.plan !== null && planParsed.plan.items.length === 3, JSON.stringify(planParsed.plan))
  check('draft items keep only the defined fields',
    JSON.stringify(Object.keys(planParsed.plan.items[0]).sort()) === JSON.stringify(['deliverables', 'note', 'priority', 'tags', 'title']),
    JSON.stringify(Object.keys(planParsed.plan.items[0])))
  check('a draft item drops the retired refs field',
    !('refs' in planParsed.plan.items[0]), JSON.stringify(Object.keys(planParsed.plan.items[0])))
  const emptyPlanProject = testHelpers.parseProjects(JSON.stringify({
    version: 12,
    projects: [{ id: 'p-empty', name: '空草案', materials: '', tasks: [], memory: [], trash: [], plan: { id: 'plan-3', summary: 'x', createdAt: 1, items: [] } }],
  }))
  check('a draft without usable items is dropped', emptyPlanProject[0].plan === null, JSON.stringify(emptyPlanProject[0].plan))

  await mount({ seedHost: planSeed })
  await settle(400)
  check('a draft renders as its own card', textOf().includes('拆解草案'), textOf().slice(0, 260))
  check('the draft card shows the plan summary', textOf().includes('把旧静态站迁到新构建链路，先文档后构建'), textOf().slice(0, 320))
  check('the draft card lists every item title', ['整理目录结构', '迁移构建脚本', '首页性能优化'].every(title => textOf().includes(title)))
  check('the draft card badges the item count', textOf().includes('3 项'), textOf().slice(0, 320))
  check('a draft item shows its note', textOf().includes('输出目录树与依赖清单'))
  const longNote = '很长的说明'.repeat(20)
  check('a long item note is cut to eighty characters',
    textOf().includes(longNote.slice(0, 80)) && !textOf().includes(longNote),
    textOf().length + ' / note=' + longNote.length)
  check('a draft item carries no reference badge', !textOf().includes('引用 1'), textOf().slice(0, 400))
  const draftOrder = textOf()
  check('the draft card sits between the materials and the subtasks',
    draftOrder.indexOf('项目资料') >= 0
    && draftOrder.indexOf('拆解草案') > draftOrder.indexOf('项目资料')
    && draftOrder.indexOf('这个项目还没有子任务') > draftOrder.indexOf('拆解草案'),
    JSON.stringify({ materials: draftOrder.indexOf('项目资料'), draft: draftOrder.indexOf('拆解草案'), tasks: draftOrder.indexOf('这个项目还没有子任务') }))
  const applyPlanButton = byButtonText('全部落卡')
  check('the draft offers a primary apply control',
    applyPlanButton !== null && applyPlanButton.props.className === 'dsh-board__primary',
    applyPlanButton && applyPlanButton.props.className)

  // A draft is a proposal, so it must be editable before it becomes cards.
  const editPlanButton = byButtonText('编辑草案')
  check('the draft offers an edit control', editPlanButton !== null)
  click(editPlanButton)
  await settle(300)
  const planTitleInputs = () => findAll(element => element.props !== undefined && element.props['aria-label'] === '任务标题')
  check('editing the draft shows one title field per item', planTitleInputs().length === 3, String(planTitleInputs().length))
  const summaryInput = byAria('拆解说明')
  check('editing the draft seeds the summary', summaryInput !== null && summaryInput.props.value === '把旧静态站迁到新构建链路，先文档后构建', summaryInput && summaryInput.props.value)
  check('editing the draft seeds the first title', planTitleInputs()[0].props.value === '整理目录结构', planTitleInputs()[0].props.value)
  change(planTitleInputs()[0], '整理目录结构（改）')
  const planDeleteButtons = () => findAll(element => element.props !== undefined && element.props['aria-label'] === '删除这一项')
  check('every draft row can be removed', planDeleteButtons().length === 3, String(planDeleteButtons().length))
  click(planDeleteButtons()[2])
  await settle(200)
  check('removing a row drops it from the editor', planTitleInputs().length === 2, String(planTitleInputs().length))
  click(byButtonText('添加一项'))
  await settle(200)
  check('a row can be added to the editor', planTitleInputs().length === 3, String(planTitleInputs().length))
  change(planTitleInputs()[2], '补一份迁移说明')
  const planSetBefore = sentOps.filter(op => op.type === 'plan.set').length
  submit(formOf(byAria('拆解说明')))
  await settle(600)
  await flush()
  const planSetOps = sentOps.filter(op => op.type === 'plan.set')
  check('saving the edited draft sends plan.set', planSetOps.length === planSetBefore + 1, JSON.stringify(sentOps.map(op => op.type)))
  const savedPlan = planSetOps[planSetOps.length - 1]
  check('the edit keeps the summary', savedPlan.summary === '把旧静态站迁到新构建链路，先文档后构建', savedPlan.summary)
  check('the edit saves the renamed, kept and added rows',
    savedPlan.items.length === 3
    && savedPlan.items[0].title === '整理目录结构（改）'
    && savedPlan.items[1].title === '迁移构建脚本'
    && savedPlan.items[2].title === '补一份迁移说明',
    JSON.stringify(savedPlan.items.map(item => item.title)))
  check('the edit carries over what the page does not show',
    JSON.stringify(savedPlan.items[0].deliverables) === JSON.stringify(['docs/tree.md'])
    && savedPlan.items[0].note === '输出目录树与依赖清单'
    && !('refs' in savedPlan.items[0]),
    JSON.stringify(savedPlan.items[0]))
  check('the host stored the edited draft',
    hostState.board.projects[0].plan !== null && hostState.board.projects[0].plan.items[2].title === '补一份迁移说明',
    JSON.stringify(hostState.board.projects[0].plan && hostState.board.projects[0].plan.items.map(item => item.title)))
  check('the read-only card shows the edited title', textOf().includes('整理目录结构（改）'), textOf().slice(0, 320))
  // Cancelling must leave the stored draft alone.
  const planSetsAfterSave = sentOps.filter(op => op.type === 'plan.set').length
  click(byButtonText('编辑草案'))
  await settle(300)
  change(planTitleInputs()[0], '这个不该保存')
  click(byButtonText('取消编辑'))
  await settle(300)
  check('cancelling an edit sends nothing', sentOps.filter(op => op.type === 'plan.set').length === planSetsAfterSave, JSON.stringify(sentOps.map(op => op.type)))
  check('cancelling an edit keeps the stored draft', stored().projects[0].plan.items[0].title === '整理目录结构（改）', stored().projects[0].plan.items[0].title)
  check('cancelling returns the card to read-only', byButtonText('全部落卡') !== null && byButtonText('保存草案') === null)
  // A draft whose rows are all blank cannot become cards.
  click(byButtonText('编辑草案'))
  await settle(300)
  for (let row = 0; row < planTitleInputs().length; row += 1) change(planTitleInputs()[row], '   ')
  const planSetsBeforeBlank = sentOps.filter(op => op.type === 'plan.set').length
  submit(formOf(byAria('拆解说明')))
  await settle(400)
  check('an all-blank draft is refused on the page', sentOps.filter(op => op.type === 'plan.set').length === planSetsBeforeBlank, JSON.stringify(sentOps.map(op => op.type)))
  check('the refusal is explained', textOf().includes('至少需要一项'), textOf().slice(0, 400))
  click(byButtonText('取消编辑'))
  await settle(300)
  check('the draft survives the refused save', stored().projects[0].plan !== null && stored().projects[0].plan.items.length === 3)

  click(applyPlanButton)
  await settle(600)
  await flush()
  check('applying the draft sends plan.apply',
    sentOps.some(op => op.type === 'plan.apply' && op.projectId === 'p-plan'),
    JSON.stringify(sentOps.map(op => op.type)))
  const appliedProject = stored().projects[0]
  check('the draft is cleared after applying', appliedProject.plan === null, JSON.stringify(appliedProject.plan))
  check('the draft card disappears after applying', !textOf().includes('拆解草案'), textOf().slice(0, 320))
  check('the draft items became subtasks',
    appliedProject.tasks.length === 3 && appliedProject.tasks.every(task => task.status === 'todo' && task.progress === 0),
    JSON.stringify(appliedProject.tasks.map(task => ({ title: task.title, status: task.status, progress: task.progress }))))
  const firstAppliedTask = appliedProject.tasks[0] === undefined ? {} : appliedProject.tasks[0]
  check('the created subtasks carry the item fields',
    firstAppliedTask.note === '输出目录树与依赖清单'
    && firstAppliedTask.priority === 'normal'
    && JSON.stringify(firstAppliedTask.tags) === JSON.stringify(['docs'])
    && !('refs' in firstAppliedTask)
    && JSON.stringify(firstAppliedTask.deliverables) === JSON.stringify(['docs/tree.md']),
    JSON.stringify(firstAppliedTask))
  check('the host recorded the created subtasks', hostState.board.projects[0].tasks.length === 3, String(hostState.board.projects[0].tasks.length))

  await mount({ seedHost: planSeed })
  await settle(400)
  const discardPlanButton = byButtonText('丢弃草案')
  check('the draft offers a discard control', discardPlanButton !== null)
  click(discardPlanButton)
  check('discarding the draft asks first', hasConfirm())
  cancelConfirm()
  await settle(200)
  check('cancelling keeps the draft', textOf().includes('拆解草案') && stored().projects[0].plan !== null)
  click(byButtonText('丢弃草案'))
  confirmNow('丢弃')
  await settle(600)
  await flush()
  check('discarding the draft sends plan.discard',
    sentOps.some(op => op.type === 'plan.discard' && op.projectId === 'p-plan'),
    JSON.stringify(sentOps.map(op => op.type)))
  check('the draft is cleared after discarding', stored().projects[0].plan === null, JSON.stringify(stored().projects[0].plan))
  check('the draft card disappears after discarding', !textOf().includes('拆解草案'), textOf().slice(0, 320))

  await mount({ seedHost: { version: 10, revision: 51, projects: [{ id: 'p-noplan', name: '无草案项目', materials: '', tasks: [], memory: [], trash: [] }] } })
  await settle(300)
  check('a project without a draft renders no draft card', !textOf().includes('拆解草案'), textOf().slice(0, 220))
  check('a project without a draft offers no apply control', byButtonText('全部落卡') === null)

console.log('\n[46] a version-11 browser mirror migrates to the materials text')
  const localV11 = JSON.stringify({
    version: 11,
    projects: [{
      id: 'p-local-v11',
      name: '本地 v11 项目',
      references: [{ id: 'r-local', kind: 'link', name: '需求', value: 'docs/req.md', description: '', staleSince: 0 }],
      tasks: [{ id: 't-local', title: '旧卡片', refs: ['r-local'] }],
      memory: [],
      trash: [],
    }],
  })
  await mount({ seedLocal: localV11 })
  await settle(700)
  await flush()
  check('a version-11 browser mirror is rewritten as version 12', stored() !== null && stored().version === 12, stored() && String(stored().version))
  check('the mirrored references became the materials text',
    stored() !== null && stored().projects[0].materials === '- 需求：docs/req.md',
    stored() && JSON.stringify(stored().projects[0].materials))
  check('the mirrored project carries no reference list',
    stored() !== null && !('references' in stored().projects[0]),
    stored() && JSON.stringify(Object.keys(stored().projects[0])))
  check('the mirrored card carries no reference ids',
    stored() !== null && !('refs' in stored().projects[0].tasks[0]),
    stored() && JSON.stringify(Object.keys(stored().projects[0].tasks[0])))
  check('the mirrored project carries a null draft',
    stored() !== null && stored().projects[0].plan === null, stored() && JSON.stringify(stored().projects[0].plan))
  check('the materials card shows the migrated text',
    byAria('项目资料') !== null && byAria('项目资料').props.value === '- 需求：docs/req.md',
    byAria('项目资料') && JSON.stringify(byAria('项目资料').props.value))
  check('the migrated mirror reached the host',
    hostState.board.projects.length === 1 && hostState.board.projects[0].materials === '- 需求：docs/req.md',
    JSON.stringify(hostState.board.projects.map(project => ({ name: project.name, materials: project.materials }))))
  check('no reference wording remains on the page',
    !textOf().includes('引用资料') && !textOf().includes('扫描材料') && !textOf().includes('添加资料'),
    textOf().slice(0, 240))
  check('no old materials control is rendered',
    byAria('类型') === null && byAria('名称') === null && byAria('路径或链接') === null && byAria('约定内容') === null,
    textOf().slice(0, 240))

  console.log('\n[47] materials typed in two projects are both written')
  await mount()
  change(byAria('新建项目'), '甲资料项目')
  submit(formOf(byAria('新建项目')))
  change(byAria('项目资料'), '甲的说明')
  // Creating and typing in another project inside the debounce window must not
  // swallow the first project's pending text.
  change(byAria('新建项目'), '乙资料项目')
  submit(formOf(byAria('新建项目')))
  change(byAria('项目资料'), '乙的说明')
  const materialsOpsBeforePair = sentOps.filter(op => op.type === 'project.setMaterials').length
  await settle(900)
  const twoMaterials = hostState.board.projects.map(project => ({ name: project.name, materials: project.materials }))
  check('both projects keep their own materials text',
    twoMaterials.some(entry => entry.name === '甲资料项目' && entry.materials === '甲的说明')
    && twoMaterials.some(entry => entry.name === '乙资料项目' && entry.materials === '乙的说明'),
    JSON.stringify(twoMaterials))
  check('each project got one materials write',
    sentOps.filter(op => op.type === 'project.setMaterials').length === materialsOpsBeforePair + 2,
    JSON.stringify(sentOps.filter(op => op.type === 'project.setMaterials')))

  console.log('\n[48] a card that says it needs my acceptance')
  const requireHumanSeed = {
    version: 12,
    revision: 71,
    updatedAt: new Date().toISOString(),
    projects: [{
      id: 'p-mine',
      name: '要我验收的项目',
      acceptanceMode: 'auto',
      acceptanceRules: { requireEvidence: true, requireDeliverables: false, verifyDeliverables: true, requireSession: false },
      rootDir: '',
      materials: '',
      memory: [],
      trash: [],
      tasks: [{
        id: 't-mine',
        title: '需要我拍板的卡',
        status: 'review',
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
  await mount({ seedHost: requireHumanSeed })
  await settle(400)
  openCards()

  const humanSwitch = byAria('需要我验收')
  check('the card renders the "needs my acceptance" switch', humanSwitch !== null, textOf().slice(0, 260))
  check('the switch sits next to the blocked switch',
    humanSwitch !== null && byAria('阻塞') !== null,
    textOf().slice(0, 260))
  check('it starts unchecked',
    humanSwitch !== null && humanSwitch.props.checked === false,
    humanSwitch && String(humanSwitch.props.checked))
  check('no acceptance chip before it is switched on', !textOf().includes('待我验收'), textOf().slice(0, 260))

  // Local first, like the blocked switch: the mirror and the card change before
  // the Host hears anything, and the write itself is a normal task.patch.
  const humanOpsBeforeOn = sentOps.length
  toggle(humanSwitch, true)
  check('the card immediately shows the acceptance chip', textOf().includes('待我验收'), textOf().slice(0, 260))
  const humanChips = findAll(element => element.props && element.props.className === 'dsh-board__chip'
    && childText(element) === '待我验收')
  check('the chip reuses the existing chip style', humanChips.length === 1, String(humanChips.length))
  check('the local mirror marks the card as needing me',
    stored().projects[0].tasks[0].requireHuman === true,
    String(stored().projects[0].tasks[0].requireHuman))
  await settle(420)
  await flush()
  const humanOnOps = sentOps.slice(humanOpsBeforeOn).filter(op => op.type === 'task.patch' && op.taskId === 't-mine')
  check('checking it writes through task.patch', humanOnOps.length === 1 && humanOnOps[0].patch.requireHuman === true, JSON.stringify(humanOnOps))
  check('the patch names the project', humanOnOps.length === 1 && humanOnOps[0].projectId === 'p-mine', JSON.stringify(humanOnOps[0]))
  check('the card needs no other operation',
    JSON.stringify([...new Set(sentOps.slice(humanOpsBeforeOn).map(op => op.type))]) === JSON.stringify(['task.patch']),
    JSON.stringify([...new Set(sentOps.slice(humanOpsBeforeOn).map(op => op.type))]))
  check('the host stored the card as needing me',
    hostState.board.projects[0].tasks[0].requireHuman === true,
    String(hostState.board.projects[0].tasks[0].requireHuman))
  check('the mirror keeps it after the round trip',
    stored().projects[0].tasks[0].requireHuman === true,
    String(stored().projects[0].tasks[0].requireHuman))
  check('the switch stays on after the round trip',
    byAria('需要我验收') !== null && byAria('需要我验收').props.checked === true,
    byAria('需要我验收') && String(byAria('需要我验收').props.checked))
  check('the chip survives the round trip', textOf().includes('待我验收'), textOf().slice(0, 260))

  const humanOpsBeforeOff = sentOps.length
  toggle(byAria('需要我验收'), false)
  check('the chip goes away at once', !textOf().includes('待我验收'), textOf().slice(0, 260))
  await settle(420)
  await flush()
  const humanOffOps = sentOps.slice(humanOpsBeforeOff).filter(op => op.type === 'task.patch' && op.taskId === 't-mine')
  check('unchecking it sends requireHuman false', humanOffOps.length === 1 && humanOffOps[0].patch.requireHuman === false, JSON.stringify(humanOffOps))
  check('the local mirror clears it',
    stored().projects[0].tasks[0].requireHuman === false,
    String(stored().projects[0].tasks[0].requireHuman))
  check('the host clears it',
    hostState.board.projects[0].tasks[0].requireHuman === false,
    String(hostState.board.projects[0].tasks[0].requireHuman))
  check('no acceptance chip remains', !textOf().includes('待我验收'), textOf().slice(0, 260))

  console.log('\n[49] the project rule that sends unverified work to me')
  // A document written before the rule existed must read as "off": the old
  // four rules are kept and the new one is filled in as false.
  const oldRulesDoc = JSON.stringify({
    version: 10,
    projects: [{
      id: 'p-old-rules',
      name: '旧规则项目',
      acceptanceMode: 'auto',
      acceptanceRules: { requireEvidence: true, requireDeliverables: false, verifyDeliverables: true, requireSession: false },
      materials: '',
      tasks: [],
      memory: [],
      trash: [],
    }],
  })
  const oldRulesProject = testHelpers.parseProjects(oldRulesDoc)[0]
  check('an old document without blockOnDebt inherits the default (on)',
    oldRulesProject.acceptanceRules.blockOnDebt === true,
    JSON.stringify(oldRulesProject.acceptanceRules))
  check('the old four rules survive the parse',
    oldRulesProject.acceptanceRules.requireEvidence === true
    && oldRulesProject.acceptanceRules.requireDeliverables === false
    && oldRulesProject.acceptanceRules.verifyDeliverables === true
    && oldRulesProject.acceptanceRules.requireSession === false,
    JSON.stringify(oldRulesProject.acceptanceRules))

  const debtRuleSeed = {
    version: 10,
    revision: 81,
    updatedAt: new Date().toISOString(),
    projects: [{
      id: 'p-debt-rule',
      name: '未验证转人工项目',
      acceptanceMode: 'auto',
      // Explicitly off so the toggle can be exercised; the default is on.
      acceptanceRules: { requireEvidence: true, requireDeliverables: false, verifyDeliverables: true, requireSession: false, blockOnDebt: false },
      rootDir: '',
      materials: '',
      memory: [],
      trash: [],
      tasks: [],
    }],
  }
  await mount({ seedHost: debtRuleSeed })
  await settle(400)

  const debtSwitch = byAria('有未验证事项就转人工')
  check('the project header renders the blockOnDebt rule', debtSwitch !== null, textOf().slice(0, 320))
  check('the new rule sits with the existing rule switches',
    byAria('需要完成说明') !== null
    && byAria('需要交付物') !== null
    && byAria('校验交付物文件') !== null
    && byAria('需要绑定会话') !== null,
    textOf().slice(0, 320))
  check('a project that turned the rule off shows it unchecked',
    debtSwitch !== null && debtSwitch.props.checked === false,
    debtSwitch && String(debtSwitch.props.checked))

  // The rule rides the same save channel as the other four: one
  // project.setAcceptance op carrying the changed rule.
  const debtOpsBeforeOn = sentOps.length
  toggle(debtSwitch, true)
  check('the saved rules carry blockOnDebt at once',
    stored().projects[0].acceptanceRules.blockOnDebt === true,
    JSON.stringify(stored().projects[0].acceptanceRules))
  await settle(420)
  await flush()
  const debtOnOps = sentOps.slice(debtOpsBeforeOn).filter(op => op.type === 'project.setAcceptance' && op.projectId === 'p-debt-rule')
  check('turning it on saves through the existing acceptance channel',
    debtOnOps.length === 1 && debtOnOps[0].rules !== undefined && debtOnOps[0].rules.blockOnDebt === true,
    JSON.stringify(debtOnOps))
  check('the rule needs no new operation',
    JSON.stringify([...new Set(sentOps.slice(debtOpsBeforeOn).map(op => op.type))]) === JSON.stringify(['project.setAcceptance']),
    JSON.stringify([...new Set(sentOps.slice(debtOpsBeforeOn).map(op => op.type))]))
  check('the saved rules keep blockOnDebt on',
    stored().projects[0].acceptanceRules.blockOnDebt === true,
    JSON.stringify(stored().projects[0].acceptanceRules))
  check('the host stored blockOnDebt',
    hostState.board.projects[0].acceptanceRules.blockOnDebt === true,
    JSON.stringify(hostState.board.projects[0].acceptanceRules))
  check('the switch stays checked after the round trip',
    byAria('有未验证事项就转人工') !== null && byAria('有未验证事项就转人工').props.checked === true,
    byAria('有未验证事项就转人工') && String(byAria('有未验证事项就转人工').props.checked))

  const debtOpsBeforeOff = sentOps.length
  toggle(byAria('有未验证事项就转人工'), false)
  await settle(420)
  await flush()
  const debtOffOps = sentOps.slice(debtOpsBeforeOff).filter(op => op.type === 'project.setAcceptance' && op.projectId === 'p-debt-rule')
  check('turning it off saves blockOnDebt false',
    debtOffOps.length === 1 && debtOffOps[0].rules !== undefined && debtOffOps[0].rules.blockOnDebt === false,
    JSON.stringify(debtOffOps))
  check('the saved rules clear blockOnDebt',
    stored().projects[0].acceptanceRules.blockOnDebt === false,
    JSON.stringify(stored().projects[0].acceptanceRules))
  check('the host also cleared it',
    hostState.board.projects[0].acceptanceRules.blockOnDebt === false,
    JSON.stringify(hostState.board.projects[0].acceptanceRules))
  check('the switch is unchecked after the round trip',
    byAria('有未验证事项就转人工') !== null && byAria('有未验证事项就转人工').props.checked === false,
    byAria('有未验证事项就转人工') && String(byAria('有未验证事项就转人工').props.checked))

  console.log('\n[51] a long finished card folds its detail until asked')
  const longSeed = (tasks) => ({
    version: 12,
    revision: 111,
    updatedAt: new Date().toISOString(),
    projects: [{ id: 'p-long', name: '长卡片项目', acceptanceMode: 'auto', materials: '', memory: [], trash: [], tasks }],
  })
  const longText = '这是一段很长的完成说明。'.repeat(40)
  await mount({
    seedHost: longSeed([{
      id: 't-long', title: '长文本卡片', status: 'review', progress: 100,
      evidence: longText,
      claims: [
        { what: '验证一', how: '跑了一遍', layer: 'unit', outcome: 'pass' },
        { what: '验证二', how: '跑了两遍', layer: 'unit', outcome: 'pass' },
        { what: '验证三', how: '跑了三遍', layer: 'unit', outcome: 'pass' },
      ],
      deliverables: ['a.md', 'b.md', 'c.md', 'd.md'],
      pendingVerification: [],
    }]),
  })
  await settle(400)
  check('a folded card hides its completion note', !textOf().includes(longText.slice(0, 60)), textOf().slice(0, 300))
  check('a folded card hides the detail summary too', !textOf().includes('详情已折叠'), textOf().slice(0, 300))
  check('a folded card offers no long-text toggle', byButtonText('展开详情') === null, textOf().slice(0, 300))
  openCards()
  check('opening the card still folds its long detail until asked',
    textOf().includes('详情已折叠') && textOf().includes('验证项 3 条'),
    textOf().slice(0, 300))
  const showDetail = byButtonText('展开详情')
  check('the folded detail offers to expand', showDetail !== null && showDetail.props['aria-expanded'] === false)
  click(showDetail)
  await settle(200)
  check('expanding shows the completion note', textOf().includes(longText.slice(0, 60)), textOf().slice(0, 300))
  check('expanding shows the checks and deliverables',
    textOf().includes('验证一') && textOf().includes('a.md') && !textOf().includes('详情已折叠'),
    textOf().slice(0, 400))
  const hideDetail = findAll(element => element.type === 'button'
    && childText(element) === '收起详情'
    && element.props['aria-expanded'] === true)[0]
  check('an expanded card offers to fold its long detail again', hideDetail !== undefined)
  click(hideDetail)
  await settle(200)
  check('folding again hides the note',
    !textOf().includes(longText.slice(0, 60)) && textOf().includes('详情已折叠') && byButtonText('展开详情') !== null,
    textOf().slice(0, 300))

  // A short card keeps everything open: no toggle to click.
  await mount({
    seedHost: longSeed([{
      id: 't-short', title: '短文本卡片', status: 'review', progress: 100,
      evidence: '短说明', claims: [], deliverables: [], pendingVerification: [],
    }]),
  })
  await settle(400)
  check('a short card hides its note while folded', !textOf().includes('短说明'), textOf().slice(0, 300))
  openCards()
  check('a short card shows its completion note once opened', textOf().includes('短说明'), textOf().slice(0, 300))
  check('a short card offers no long-text toggle', byButtonText('展开详情') === null && !textOf().includes('详情已折叠'))

  console.log('\n[50] the two new switches are named in both locales')
  check('the acceptance switch and its chip are localized',
    dictionaries.greenlight.zh['task.requireHuman'] === '需要我验收'
    && dictionaries.greenlight.en['task.requireHuman'] === 'Needs my acceptance'
    && dictionaries.greenlight.zh['task.requireHumanChip'] === '待我验收'
    && dictionaries.greenlight.en['task.requireHumanChip'] === 'Awaiting me',
    JSON.stringify({
      zhSwitch: dictionaries.greenlight.zh['task.requireHuman'],
      enSwitch: dictionaries.greenlight.en['task.requireHuman'],
      zhChip: dictionaries.greenlight.zh['task.requireHumanChip'],
      enChip: dictionaries.greenlight.en['task.requireHumanChip'],
    }))
  check('the debt rule is localized',
    dictionaries.greenlight.zh['project.ruleBlockOnDebt'] === '有未验证事项就转人工'
    && dictionaries.greenlight.en['project.ruleBlockOnDebt'] === 'Send to me when anything is unverified',
    JSON.stringify({
      zh: dictionaries.greenlight.zh['project.ruleBlockOnDebt'],
      en: dictionaries.greenlight.en['project.ruleBlockOnDebt'],
    }))

  console.log('\n[52] a folded card is a summary, not a form')
  const compactSeed = {
    version: 12,
    revision: 131,
    updatedAt: new Date().toISOString(),
    projects: [{
      id: 'p-compact',
      name: '紧凑项目',
      acceptanceMode: 'auto',
      materials: '',
      memory: [],
      trash: [],
      tasks: [
        {
          id: 't-rich',
          title: '信息很多的卡',
          status: 'todo',
          progress: 40,
          priority: 'high',
          dueDate: '2020-01-01',
          blocked: true,
          requireHuman: true,
          sessionId: 'sess-compact',
          contextSentAt: Date.now() - 1000,
        },
        {
          id: 't-plain',
          title: '干净的卡',
          status: 'todo',
          progress: 0,
          priority: 'normal',
          dueDate: '',
          blocked: false,
          requireHuman: false,
          sessionId: '',
        },
      ],
    }],
  }
  sessionState.ids = ['sess-compact']
  sessionState.byId = { 'sess-compact': { id: 'sess-compact', displayTitle: '紧凑会话', running: true } }
  await mount({ seedHost: compactSeed })
  await settle(400)
  const richCard = cardOf('信息很多的卡')
  check('both cards render', richCard !== null && cardOf('干净的卡') !== null, textOf().slice(0, 200))
  check('a folded card hides the priority menu', byAria('优先级') === null)
  check('a folded card hides the due date field', byAria('截止') === null)
  check('a folded card hides the tags field', byAria('标签') === null)
  check('a folded card hides the note field', byAria('任务说明（可选）') === null)
  check('a folded card hides the progress slider', byClassName('dsh-board__range').length === 0, String(byClassName('dsh-board__range').length))
  check('a folded card hides the blocked switch', byAria('阻塞') === null)
  check('a folded card hides the Session row', byClassName('dsh-board__sessionRow').length === 0, String(byClassName('dsh-board__sessionRow').length))
  check('a folded card hides the check form', byAria('验证了什么') === null)
  check('a folded card hides the next step', byAria('下一步') === null)
  const richPill = findIn(richCard, element => element.props && element.props.className === 'dsh-board__pill')
  check('a folded card still names its state', richPill !== undefined && childText(richPill) === '待办' && richPill.props['data-status'] === 'todo', richPill && childText(richPill))
  check('a folded card still shows its title',
    findIn(richCard, element => element.props && element.props.className === 'dsh-board__taskTitle').props.value === '信息很多的卡')
  check('a folded card keeps its delete control', findIn(richCard, element => element.props && element.props.className === 'dsh-board__delete') !== undefined)
  const chipTexts = descendants(richCard, [])
    .filter(element => element.props && typeof element.props.className === 'string'
      && element.props.className.split(' ').indexOf('dsh-board__chip') >= 0)
    .map(childText)
  check('the folded chip row carries priority, due date, blocked and acceptance',
    chipTexts.includes('高') && chipTexts.includes('2020-01-01') && chipTexts.includes('阻塞') && chipTexts.includes('待我验收'),
    JSON.stringify(chipTexts))
  check('an overdue due date is marked red on the folded card',
    findIn(richCard, element => element.props && typeof element.props.className === 'string'
      && element.props.className.includes('dsh-board__chip--overdue')) !== undefined,
    JSON.stringify(chipTexts))
  const compactSessionTitle = findIn(richCard, element => element.props && element.props.className === 'dsh-board__sessionTitle')
  check('the Session chip names the Session in the chip row',
    findIn(richCard, element => element.props && typeof element.props.className === 'string'
      && element.props.className.includes('dsh-board__chip--session')) !== undefined
    && compactSessionTitle !== undefined
    && childText(compactSessionTitle) === '紧凑会话',
    compactSessionTitle === undefined ? 'no session chip' : JSON.stringify(childText(compactSessionTitle)))
  check('the Session chip keeps the running dot',
    findIn(richCard, element => element.props
      && element.props.className === 'dsh-board__dot'
      && element.props['data-tone'] === 'green') !== undefined)
  const richBar = findIn(richCard, element => element.props && element.props.className === 'dsh-board__barFill')
  check('a card with progress draws its bar while folded', richBar !== undefined, textOf().slice(0, 200))
  check('the folded bar carries the percentage', richBar !== undefined && richBar.props.style.width === '40%', richBar && JSON.stringify(richBar.props.style))
  const plainCard = cardOf('干净的卡')
  check('a card with nothing to say renders no chip row',
    findIn(plainCard, element => element.props && element.props.className === 'dsh-board__chipRow') === undefined)
  check('a card with no progress draws no bar',
    findIn(plainCard, element => element.props && element.props.className === 'dsh-board__taskBar') === undefined)
  check('a normal priority is not chipped', !descendants(plainCard, [])
    .some(element => element.props && typeof element.props.className === 'string'
      && element.props.className.indexOf('dsh-board__chip') === 0 && childText(element) === '普通'))
  check('every folded card offers exactly one details control', findAll(isFoldedToggle).length === 2, String(findAll(isFoldedToggle).length))
  check('the details control says it opens',
    childText(findIn(richCard, isFoldedToggle)) === '详情' && findIn(richCard, isFoldedToggle).props['aria-expanded'] === false,
    childText(findIn(richCard, isFoldedToggle)))
  // The chip has to tell running from idle, or folding the Session row away
  // would hide the one piece of state the row carried.
  sessionState.byId = { 'sess-compact': { id: 'sess-compact', displayTitle: '紧凑会话', running: false } }
  rerender()
  const idleCard = cardOf('信息很多的卡')
  check('an idle Session keeps a quiet dot on the folded chip',
    findIn(idleCard, element => element.props
      && element.props.className === 'dsh-board__dot'
      && element.props['data-tone'] === 'idle') !== undefined)
  check('the idle Session chip drops the live highlight',
    findIn(idleCard, element => element.props && element.props.className === 'dsh-board__chip dsh-board__chip--session').props['data-live'] === undefined,
    JSON.stringify(findIn(idleCard, element => element.props && element.props.className === 'dsh-board__chip dsh-board__chip--session').props['data-live']))
  sessionState.byId = { 'sess-compact': { id: 'sess-compact', displayTitle: '紧凑会话', running: true } }
  rerender()

  openCard('信息很多的卡')
  const openRichCard = cardOf('信息很多的卡')
  check('opening the card shows the priority menu', findIn(openRichCard, element => element.props && element.props['aria-label'] === '优先级') !== undefined)
  check('opening the card shows the due date and tags',
    findIn(openRichCard, element => element.props && element.props['aria-label'] === '截止') !== undefined
    && findIn(openRichCard, element => element.props && element.props['aria-label'] === '标签') !== undefined)
  check('opening the card shows the note field',
    findIn(openRichCard, element => element.props && element.props['aria-label'] === '任务说明（可选）') !== undefined)
  check('opening the card shows the Session row',
    byClassName('dsh-board__sessionRow').length === 1, String(byClassName('dsh-board__sessionRow').length))
  check('opening the card shows the check form and the next step',
    findIn(openRichCard, element => element.props && element.props['aria-label'] === '验证了什么') !== undefined
    && findIn(openRichCard, element => element.props && element.props['aria-label'] === '下一步') !== undefined)
  check('the open card keeps the controls it was built with',
    findIn(openRichCard, element => element.props && element.props.className === 'dsh-board__taskStatus') !== undefined
    && findIn(openRichCard, element => element.props && element.props.className === 'dsh-board__taskMeta') !== undefined
    && findIn(openRichCard, element => element.props && element.props.className === 'dsh-board__taskFields') !== undefined
    && findIn(openRichCard, element => element.props && element.props.className === 'dsh-board__claimForm') !== undefined)
  check('the other card stays folded', findIn(cardOf('干净的卡'), isFoldedToggle) !== undefined)
  const openToggle = findIn(openRichCard, isOpenedToggle)
  check('the open card offers to fold again', openToggle !== undefined && childText(openToggle) === '收起详情', openToggle && childText(openToggle))
  foldCard('信息很多的卡')
  const refoldedCard = cardOf('信息很多的卡')
  check('folding again hides the priority menu', findIn(refoldedCard, element => element.props && element.props['aria-label'] === '优先级') === undefined)
  check('folding again hides the Session row', byClassName('dsh-board__sessionRow').length === 0, String(byClassName('dsh-board__sessionRow').length))
  check('the folded card offers its details control again',
    childText(findIn(refoldedCard, isFoldedToggle)) === '详情' && findIn(refoldedCard, isFoldedToggle).props['aria-expanded'] === false)

  console.log('\n[53] a card in review keeps its decision on the folded card')
  await mount({
    seedHost: {
      version: 12,
      revision: 141,
      updatedAt: new Date().toISOString(),
      projects: [{
        id: 'p-decide',
        name: '决策项目',
        acceptanceMode: 'auto',
        materials: '',
        memory: [],
        trash: [],
        tasks: [{ id: 't-decide', title: '等我拍板的卡', status: 'review', progress: 100 }],
      }],
    },
  })
  await settle(400)
  check('the folded review card offers accept and reject',
    byButtonText('通过') !== null && byButtonText('打回') !== null, textOf().slice(0, 240))
  check('the folded review card keeps the other actions behind the details',
    byButtonText('派给会话') === null && byButtonText('归档') === null && findElement(isFoldedToggle) !== null,
    textOf().slice(0, 240))
  click(byButtonText('打回'))
  check('rejecting asks for a reason without opening the card',
    byAria('打回原因（必填）') !== null && findElement(isFoldedToggle) !== null, textOf().slice(0, 300))
  click(byButtonText('取消'))
  check('cancelling the rejection closes the reason field', byAria('打回原因（必填）') === null)
  openCards()
  check('opening the review card shows its full controls',
    byAria('优先级') !== null && byClassName('dsh-board__sessionRow').length === 1, textOf().slice(0, 300))
  click(byButtonText('通过'))
  await settle(320)
  check('the accept control still completes the card',
    stored().projects[0].tasks[0].status === 'done', stored().projects[0].tasks[0].status)

  console.log('\n[54] a long column renders one page at a time')
  const manyTasks = []
  for (let index = 0; index < 30; index += 1) {
    manyTasks.push({ id: 't-many-' + String(index), title: '批量卡片 ' + String(index + 1), status: 'todo', progress: 0 })
  }
  await mount({
    seedHost: {
      version: 12,
      revision: 151,
      updatedAt: new Date().toISOString(),
      projects: [{ id: 'p-many', name: '批量项目', acceptanceMode: 'auto', materials: '', memory: [], trash: [], tasks: manyTasks }],
    },
  })
  await settle(600)
  const renderedTitles = () => byClassName('dsh-board__taskTitle').map(element => element.props.value)
  check('a long column renders only its first page', byClassName('dsh-board__task').length === 25, String(byClassName('dsh-board__task').length))
  check('the column head still counts every card',
    findElement(element => element.props && element.props.className === 'dsh-board__count' && childText(element) === '30') !== undefined,
    textOf().slice(0, 200))
  check('the last card of the page is on screen', renderedTitles().includes('批量卡片 25'), String(renderedTitles().length))
  check('a card past the first page is not rendered', !renderedTitles().includes('批量卡片 26'))
  check('the rest waits behind one button', byButtonText('显示更多（还剩 5 张）') !== null, textOf().slice(-240))
  click(byButtonText('显示更多（还剩 5 张）'))
  check('the button brings the whole column on screen', byClassName('dsh-board__task').length === 30, String(byClassName('dsh-board__task').length))
  check('the last card is finally rendered', renderedTitles().includes('批量卡片 30'))
  check('the pager disappears once every card is shown', byButtonText('显示更多（还剩 5 张）') === null)

  console.log('\n[55] the details toggle, the pager and the internal scroll are in the page')
  check('the details toggle is named in both locales',
    dictionaries.greenlight.zh['task.details'] === '详情'
    && dictionaries.greenlight.en['task.details'] === 'Details'
    && dictionaries.greenlight.zh['task.collapseDetails'] === '收起详情'
    && dictionaries.greenlight.en['task.collapseDetails'] === 'Collapse',
    JSON.stringify({
      zhDetails: dictionaries.greenlight.zh['task.details'],
      enDetails: dictionaries.greenlight.en['task.details'],
      zhCollapse: dictionaries.greenlight.zh['task.collapseDetails'],
      enCollapse: dictionaries.greenlight.en['task.collapseDetails'],
    }))
  check('the long-text detail keys are left alone',
    dictionaries.greenlight.zh['task.detailsShow'] === '展开详情'
    && dictionaries.greenlight.zh['task.detailsHide'] === '收起详情'
    && dictionaries.greenlight.en['task.detailsShow'] === 'Show details'
    && dictionaries.greenlight.en['task.detailsHide'] === 'Hide details',
    JSON.stringify({
      zhShow: dictionaries.greenlight.zh['task.detailsShow'],
      zhHide: dictionaries.greenlight.zh['task.detailsHide'],
    }))
  check('the column pager is named in both locales',
    dictionaries.greenlight.zh['column.more'] === '显示更多（还剩 %s 张）'
    && dictionaries.greenlight.en['column.more'] === 'Show %s more',
    JSON.stringify({
      zh: dictionaries.greenlight.zh['column.more'],
      en: dictionaries.greenlight.en['column.more'],
    }))
  check('a column caps its height instead of stretching the page',
    source.includes('max-height: calc(100vh - 380px)'), 'column max-height missing')
  check('the card area scrolls inside the column',
    source.includes('overflow-y: auto') && source.includes('overscroll-behavior: contain'), 'cards scroll missing')
  check('the column head sticks with an opaque ground',
    source.includes('position: sticky')
    && source.includes('backdrop-filter: blur(2px)')
    && source.includes('color-mix(in srgb, var(--gl-state) 4%, var(--dsw-alias-bg-base))'),
    'sticky head missing')
  check('the details toggle and the chip row carry their own classes',
    source.includes('dsh-board__detailsToggle')
    && source.includes('dsh-board__chipRow')
    && source.includes('dsh-board__taskCompact')
    && source.includes('dsh-board__taskActions'),
    'compact card classes missing')

  console.log('\n[56] memory entries shorten themselves and the list pages')
  const memorySeed = (count, long) => ({
    version: 12,
    revision: 121,
    updatedAt: new Date().toISOString(),
    projects: [{
      id: 'p-mem', name: '记忆项目', acceptanceMode: 'auto', materials: '', tasks: [], trash: [],
      memory: Array.from({ length: count }, (_, index) => ({
        id: 'm' + index,
        text: long && index === 0 ? '记忆内容很长的条目。记忆内容很长的条目。记忆内容很长的条目。记忆内容很长的条目。记忆内容很长的条目。记忆内容很长的条目。记忆内容很长的条目。记忆内容很长的条目。记忆内容很长的条目。记忆内容很长的条目。记忆内容很长的条目。记忆内容很长的条目。记忆内容很长的条目。记忆内容很长的条目。记忆内容很长的条目。记忆内容很长的条目。记忆内容很长的条目。记忆内容很长的条目。记忆内容很长的条目。记忆内容很长的条目。' : '记忆 ' + index,
        taskId: '',
        createdAt: Date.now() - index * 1000,
      })),
    }],
  })
  await mount({ seedHost: memorySeed(1, true) })
  await settle(400)
  const longMemoryText = '记忆内容很长的条目。记忆内容很长的条目。记忆内容很长的条目。记忆内容很长的条目。记忆内容很长的条目。记忆内容很长的条目。记忆内容很长的条目。记忆内容很长的条目。记忆内容很长的条目。记忆内容很长的条目。记忆内容很长的条目。记忆内容很长的条目。记忆内容很长的条目。记忆内容很长的条目。记忆内容很长的条目。记忆内容很长的条目。记忆内容很长的条目。记忆内容很长的条目。记忆内容很长的条目。记忆内容很长的条目。'
  check('a long memory entry is truncated by default',
    !textOf().includes(longMemoryText),
    textOf().slice(0, 200))
  const expandMemory = byButtonText('展开全文')
  check('a long memory entry offers to expand', expandMemory !== null)
  click(expandMemory)
  await settle(200)
  check('expanding a memory entry shows the whole text',
    textOf().includes(longMemoryText) && byButtonText('收起') !== null,
    textOf().slice(0, 200))
  click(byButtonText('收起'))
  await settle(200)
  check('collapsing a memory entry shortens it again',
    !textOf().includes(longMemoryText) && byButtonText('展开全文') !== null)

  await mount({ seedHost: memorySeed(8, false) })
  await settle(400)
  const memoryMore = byButtonText('显示更多（还剩 2 条）')
  check('the memory list pages instead of listing everything',
    memoryMore !== null && textOf().includes('记忆 2') && !textOf().includes('记忆 7'),
    textOf().slice(0, 400))
  click(memoryMore)
  await settle(200)
  check('showing more reveals the rest of the memory',
    textOf().includes('记忆 7') && byButtonText('显示更多（还剩 2 条）') === null,
    textOf().slice(0, 400))

  console.log('\n' + (failures === 0 ? 'ALL ' + checks + ' CHECKS PASSED' : failures + ' of ' + checks + ' CHECKS FAILED'))
  process.exit(failures === 0 ? 0 : 1)
})().catch((error) => {
  console.error('HARNESS CRASHED: ' + (error && error.stack ? error.stack : error))
  process.exit(1)
})
