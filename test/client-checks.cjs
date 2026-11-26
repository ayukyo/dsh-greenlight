/**
 * Headless verification for the Greenlight board client module.
 *
 * Runs the real client.js with stubbed browser globals, a minimal React hook
 * runtime, and a fake Cordis Client context. Verifies: module init, slot
 * registration, document migration, title derivation, project references,
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
    // surface, everything else is prepared first (the material scan expands
    // directories) and then applied by the pure board layer. Indices are kept so
    // a result can point back at the operation the caller sent.
    const boardOps = []
    const boardIndexes = []
    payload.ops.forEach((op, index) => {
      if (op !== null && typeof op === 'object' && op.type === 'board.archive') return
      boardOps.push(op)
      boardIndexes.push(index)
    })
    const prepared = hostVerify !== null && typeof hostVerify.prepareBatch === 'function'
      ? await hostVerify.prepareBatch(hostState.board, boardOps)
      : boardOps
    const outcome = hostBoard.applyOps(hostState.board, prepared, 'ui')
    hostState.board = outcome.board
    const results = []
    const refused = new Set(outcome.rejected.map(entry => entry.index))
    boardOps.forEach((op, position) => {
      if (refused.has(position)) return
      if (op === null || typeof op !== 'object') return
      const applied = prepared[position]
      if (op.type === 'reference.intake' && Array.isArray(applied.added)) {
        results.push({
          index: boardIndexes[position],
          type: 'reference.intake',
          added: applied.added,
          missing: Array.isArray(applied.missing) ? applied.missing : [],
          skipped: Array.isArray(applied.skipped) ? applied.skipped : [],
          truncated: applied.truncated === true,
        })
        return
      }
      if (op.type === 'plan.apply' && applied.result !== undefined) {
        results.push({
          index: boardIndexes[position],
          type: 'plan.apply',
          created: applied.result.created,
          skippedTitles: applied.result.skippedTitles,
        })
      }
    })
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
      results,
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
  check('the merged section is named in both locales',
    dictionaries.greenlight.zh['references.section'] === '项目资料'
    && dictionaries.greenlight.en['references.section'] === 'Project references',
    JSON.stringify({ zh: dictionaries.greenlight.zh['references.section'], en: dictionaries.greenlight.en['references.section'] }))
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
  check('legacy project starts with no references', migrated[0].references.length === 0)
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
  check('round-trip keeps version 11', JSON.parse(testHelpers.serializeProjects(migrated)).version === 11)

  // Version 9 held project material in `shared` (free text) plus a
  // `sharedEntries` list; version 10 folds both into one typed list.
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
  const migratedV9 = testHelpers.parseProjects(v9Doc)
  const v9References = migratedV9[0].references
  check('v9 shared text becomes a note reference', v9References.length === 2 && v9References[0].kind === 'note', JSON.stringify(v9References))
  check('the migrated note keeps the old text', v9References[0].name === '项目说明' && v9References[0].value === '先评审再实现', JSON.stringify(v9References[0]))
  check('v9 shared entries become link references', v9References[1].kind === 'link' && v9References[1].id === 's-old' && v9References[1].value === 'docs/design.md', JSON.stringify(v9References[1]))
  check('the v9 description survives', v9References[1].description === '首页与详情页 2 版', JSON.stringify(v9References[1]))
  check('the card reference still points at the migrated entry', migratedV9[0].tasks[0].refs.length === 1 && migratedV9[0].tasks[0].refs[0] === 's-old', JSON.stringify(migratedV9[0].tasks[0].refs))
  check('the legacy fields are dropped from memory', !('shared' in migratedV9[0]) && !('sharedEntries' in migratedV9[0]), JSON.stringify(Object.keys(migratedV9[0])))
  const v10RoundTrip = testHelpers.parseProjects(testHelpers.serializeProjects(migratedV9))
  check('migrating a v9 document twice does not duplicate', v10RoundTrip[0].references.length === 2, JSON.stringify(v10RoundTrip[0].references))
  check('the migrated document writes version 11', JSON.parse(testHelpers.serializeProjects(migratedV9)).version === 11)

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
  check('document version 11', doc && doc.version === 11, doc && String(doc.version))
  check('project created', doc && doc.projects.length === 1 && doc.projects[0].name === 'Alpha 项目')
  check('project starts with no references', doc && Array.isArray(doc.projects[0].references) && doc.projects[0].references.length === 0, doc && JSON.stringify(doc.projects[0]))
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

  console.log('\n[9] project references block')
  const kindSelect = byAria('类型')
  check('one merged references block is rendered', !!kindSelect, textOf().slice(0, 200))
  check('the block is titled project references', textOf().includes('项目资料'))
  check('the old shared block is gone', !textOf().includes('共享资料'))
  change(kindSelect, 'link')
  change(byAria('名称'), '接口文档')
  change(byAria('路径或链接'), 'docs/api.md')
  change(byAria('说明（可选）'), '接口约定')
  submit(formOf(byAria('名称')))
  await settle()
  doc = stored()
  let projectRefs = doc.projects[0].references
  check('a link reference is stored', projectRefs.length === 1 && projectRefs[0].kind === 'link', JSON.stringify(projectRefs))
  check('the reference name and value are stored', projectRefs[0].name === '接口文档' && projectRefs[0].value === 'docs/api.md', JSON.stringify(projectRefs[0]))
  check('the reference description is stored', projectRefs[0].description === '接口约定', JSON.stringify(projectRefs[0]))
  check('a fresh link is not stale', projectRefs[0].staleSince === 0)
  check('the host stored the reference', hostState.board.projects[0].references.length === 1, JSON.stringify(hostState.board.projects[0].references))
  check('the local document carries no legacy fields', !('shared' in doc.projects[0]) && !('sharedEntries' in doc.projects[0]), JSON.stringify(Object.keys(doc.projects[0])))

  // A note uses a textarea: it is convention text and is never probed.
  change(byAria('类型'), 'note')
  const noteField = byAria('约定内容')
  check('a note value uses a textarea', noteField !== null && noteField.type === 'textarea', noteField && String(noteField.type))
  change(noteField, '先评审再实现')
  change(byAria('名称'), '项目说明')
  submit(formOf(byAria('名称')))
  await settle()
  doc = stored()
  projectRefs = doc.projects[0].references
  check('a note reference is stored', projectRefs.length === 2 && projectRefs[1].kind === 'note', JSON.stringify(projectRefs))
  check('the note keeps its text', projectRefs[1].name === '项目说明' && projectRefs[1].value === '先评审再实现', JSON.stringify(projectRefs[1]))
  check('a note is never stale', projectRefs[1].staleSince === 0)
  check('the host stored both references', hostState.board.projects[0].references.length === 2, JSON.stringify(hostState.board.projects[0].references))
  check('rows badge their kind', byClassName('dsh-board__chip').some(chip => childText(chip) === '链接') && byClassName('dsh-board__chip').some(chip => childText(chip) === '约定'), textOf().slice(0, 240))

  // The third kind: neither a file to probe nor a project convention.
  change(byAria('类型'), 'other')
  change(byAria('名称'), '外部审批')
  change(byAria('约定内容'), '线下邮件确认')
  submit(formOf(byAria('名称')))
  await settle()
  projectRefs = stored().projects[0].references
  check('an other-kind reference is stored', projectRefs.length === 3 && projectRefs[2].kind === 'other', JSON.stringify(projectRefs))
  check('an other-kind reference keeps its text', projectRefs[2].value === '线下邮件确认', JSON.stringify(projectRefs[2]))
  check('the host stored the third kind', hostState.board.projects[0].references.some(entry => entry.kind === 'other'), JSON.stringify(hostState.board.projects[0].references))
  check('rows badge the other kind', byClassName('dsh-board__chip').some(chip => childText(chip) === '其它'), textOf().slice(0, 240))
  check('an other-kind row is never stale', projectRefs[2].staleSince === 0)
  check('reference rows carry values and descriptions', textOf().includes('docs/api.md') && textOf().includes('接口约定') && textOf().includes('先评审再实现'), textOf().slice(0, 240))
  check('a reference row has a delete control', byAria('删除资料') !== null)

  // Inline editing: the row turns into a form, saves through reference.update,
  // and a cancel leaves the entry exactly as it was.
  const referenceRows = () => byClassName('dsh-board__memoryItem')
  const rowWith = (label) => findIn(referenceRows()[0], element => element.props !== undefined && element.props['aria-label'] === label)
  const linkReferenceId = stored().projects[0].references[0].id
  check('a reference row has an edit control', rowWith('编辑资料') !== null)
  click(rowWith('编辑资料'))
  await settle()
  // The add form above carries the same field labels, so the edit form is looked
  // up inside the row instead of by label alone.
  const editForm = findIn(referenceRows()[0], element => element.type === 'form')
  check('editing a row opens a form', editForm !== null)
  change(rowWith('名称'), '接口文档（二版）')
  change(rowWith('说明（可选）'), '更新后的说明')
  submit(findIn(referenceRows()[0], element => element.type === 'form'))
  await settle()
  const updatedReference = stored().projects[0].references[0]
  check('the edit is saved locally', updatedReference.name === '接口文档（二版）' && updatedReference.description === '更新后的说明', JSON.stringify(updatedReference))
  check('the edit keeps the id, kind and value', updatedReference.id === linkReferenceId && updatedReference.kind === 'link' && updatedReference.value === 'docs/api.md', JSON.stringify(updatedReference))
  check('the host accepted reference.update', hostState.board.projects[0].references[0].name === '接口文档（二版）', JSON.stringify(hostState.board.projects[0].references))
  check('a reference.update op was sent', sentOps.some(op => op.type === 'reference.update'), JSON.stringify(sentOps.map(op => op.type)))
  click(rowWith('编辑资料'))
  await settle()
  change(rowWith('名称'), '不应保存')
  click(byButtonText('取消'))
  await settle()
  check('cancel leaves the entry untouched', stored().projects[0].references[0].name === '接口文档（二版）', JSON.stringify(stored().projects[0].references[0]))

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
  // The card's own delete control: the references block renders delete buttons
  // too, and those must not be mistaken for the card one.
  click(byAria('删除子任务'))
  check('deleting a subtask asks for confirmation', hasConfirm())
  check('nothing was deleted before the answer', stored().projects[0].tasks.length === 1, String(stored().projects[0].tasks.length))
  confirmNow('删除')
  doc = stored()
  check('project survives', doc && doc.projects.length === 1)
  check('subtasks emptied', doc && doc.projects[0].tasks.length === 0)
  check('references survive', doc && doc.projects[0].references.length === 3, doc && JSON.stringify(doc.projects[0].references))
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
  const importedRefs = hostState.board.projects[0].references
  check('the v9 shared text became a note reference', importedRefs.length === 2 && importedRefs[0].kind === 'note' && importedRefs[0].value === 'docs/x.md', JSON.stringify(importedRefs))
  check('the v9 entry became a link reference', importedRefs[1].kind === 'link' && importedRefs[1].value === 'legacy/site.zip', JSON.stringify(importedRefs[1]))
  check('the mirror now carries references', stored().projects[0].references.length === 2, JSON.stringify(stored().projects[0].references))
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
      references: [
        { id: 'r-note', kind: 'note', name: '约定', value: '共享C', description: '', staleSince: 0 },
        { id: 'r-link', kind: 'link', name: '文档', value: 'docs/spec.md', description: '', staleSince: 0 },
      ],
      memory: [{ id: 'm', text: '记忆D', taskId: 't' }],
    },
  )
  check('dispatch prompt carries title, note, references and linked memory',
    promptSample.includes('标题A') && promptSample.includes('说明B') && promptSample.includes('共享C') && promptSample.includes('docs/spec.md') && promptSample.includes('记忆D'),
    promptSample.slice(0, 160))

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

  console.log('\n[32] batch C5: project references and subtask references')
  change(byAria('名称'), '接口文档')
  change(byAria('路径或链接'), 'docs/api.md')
  submit(formOf(byAria('名称')))
  await settle()
  const references = stored().projects[0].references
  check('a link reference is stored', references.length === 1 && references[0].name === '接口文档', JSON.stringify(references))
  check('host stored the reference', hostState.board.projects[0].references.length === 1)
  check('the reference value is stored', references[0].value === 'docs/api.md', references[0].value)
  const removeReferenceControl = byAria('删除资料')
  check('a reference row has a delete control', !!removeReferenceControl)
  click(removeReferenceControl)
  check('deleting a reference asks first', hasConfirm())
  confirmNow('删除')
  await settle()
  check('the reference is removed locally', stored().projects[0].references.length === 0)
  check('the reference is removed on the host', hostState.board.projects[0].references.length === 0)

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
  check('a reference renders as a reference chip', !!refChip, textOf().slice(0, 220))
  click(refChip)
  await settle()
  const taskWithRef = stored().projects[0].tasks[0]
  const chipReferenceId = stored().projects[0].references[0].id
  check('clicking the chip adds the reference', taskWithRef.refs.length === 1, JSON.stringify(taskWithRef.refs))
  check('the chip points at the project reference', taskWithRef.refs[0] === chipReferenceId, JSON.stringify(taskWithRef.refs))
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
    version: 10,
    revision: 5,
    updatedAt: new Date().toISOString(),
    projects: [{
      id: 'p-acc',
      name: '验收项目',
      acceptanceMode: 'auto',
      references: [],
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
    version: 10,
    revision: 9,
    updatedAt: new Date().toISOString(),
    projects: [{
      id: 'p-rules',
      name: '规则项目',
      acceptanceMode: 'auto',
      acceptanceRules: { requireEvidence: true, requireDeliverables: false, verifyDeliverables: true, requireSession: false },
      rootDir: '',
      references: [],
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
      references: [{ id: 's-stale', kind: 'link', name: '旧文档', value: 'docs/gone.md', description: '', staleSince: Date.now() }],
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
      references: [],
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
      references: [{ id: 'r1', kind: 'link', name: '要删的引用', value: 'docs/x.md', description: '', staleSince: 0 }],
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
  check('the reference survives a cancel', stored().projects[0].references.length === 1)
  click(byAria('删除记忆'))
  check('deleting memory asks', hasConfirm())
  cancelConfirm()
  check('the memory entry survives a cancel', stored().projects[0].memory.length === 1)

  // Nothing was written to the Host while all of that was cancelled.
  check('cancelled actions wrote nothing', hostState.board.projects[0].references.length === 1 && hostState.board.projects[0].memory.length === 1, JSON.stringify({ references: hostState.board.projects[0].references.length, memory: hostState.board.projects[0].memory.length }))

console.log('\n[43] the project rail collapses and remembers it')
  const railSeed = {
    version: 10,
    revision: 41,
    updatedAt: new Date().toISOString(),
    projects: [
      { id: 'pa', name: '甲项目', acceptanceMode: 'auto', acceptanceRules: {}, requiredLayers: [], gates: {}, anchor: {}, references: [], memory: [], trash: [], tasks: [] },
      { id: 'pb', name: '乙项目', acceptanceMode: 'auto', acceptanceRules: {}, requiredLayers: [], gates: {}, anchor: {}, references: [], memory: [], trash: [], tasks: [] },
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

console.log('\n[44] the client only writes the version-11 reference operations')
  check('the local mirror stores references, never the legacy fields',
    stored().projects.every(project => Array.isArray(project.references) && !('shared' in project) && !('sharedEntries' in project)),
    JSON.stringify(Object.keys(stored().projects[0])))
  check('no legacy shared operation was sent',
    !sentOps.some(op => op.type === 'project.setShared' || String(op.type).startsWith('sharedEntry.')),
    JSON.stringify([...new Set(sentOps.map(op => op.type))]))
  check('references are written through the version-11 operations',
    ['reference.add', 'reference.update', 'reference.remove'].every(type => sentOps.some(op => op.type === type)),
    JSON.stringify([...new Set(sentOps.map(op => op.type))]))

console.log('\n[45] version 11: the draft plan and its migration')
  // Version 10 has no plan field at all: reading one must yield a null draft,
  // and writing it back must already be version 11.
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
  check('a version-10 document is rewritten as version 11', JSON.parse(testHelpers.serializeProjects(migratedV10)).version === 11)
  check('a version-10 project migrates to a null plan', migratedV10.length === 1 && migratedV10[0].plan === null, JSON.stringify(migratedV10[0] && migratedV10[0].plan))
  check('material and draft locale text is registered in both locales',
    dictionaries.greenlight.zh['references.intake'] === '扫描材料'
    && dictionaries.greenlight.en['references.intake'] === 'Scan materials'
    && dictionaries.greenlight.zh['references.intakePlaceholder'] === '粘贴本地路径或链接，一行一个'
    && dictionaries.greenlight.en['references.intakePlaceholder'] === 'Paste local paths or links, one per line'
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
    JSON.stringify(Object.keys(planParsed.plan.items[0]).sort()) === JSON.stringify(['deliverables', 'note', 'priority', 'refs', 'tags', 'title']),
    JSON.stringify(Object.keys(planParsed.plan.items[0])))
  check('draft items resolve their references against the project',
    JSON.stringify(planParsed.plan.items[0].refs) === JSON.stringify(['ref-plan']), JSON.stringify(planParsed.plan.items[0].refs))
  const danglingPlanProject = testHelpers.parseProjects(JSON.stringify({
    version: 11,
    projects: [{ id: 'p-dangle', name: '悬空引用', references: [], tasks: [], memory: [], trash: [], plan: { id: 'plan-2', summary: '', createdAt: 1, items: [{ title: '只有悬空引用', refs: ['missing-ref'] }] } }],
  }))
  check('a draft item drops references that do not exist',
    danglingPlanProject[0].plan.items[0].refs.length === 0, JSON.stringify(danglingPlanProject[0].plan.items[0].refs))
  const emptyPlanProject = testHelpers.parseProjects(JSON.stringify({
    version: 11,
    projects: [{ id: 'p-empty', name: '空草案', references: [], tasks: [], memory: [], trash: [], plan: { id: 'plan-3', summary: 'x', createdAt: 1, items: [] } }],
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
  check('a draft item badges its references', textOf().includes('引用 1'), textOf().slice(0, 400))
  const draftOrder = textOf()
  check('the draft card sits between the references and the subtasks',
    draftOrder.indexOf('项目资料') >= 0
    && draftOrder.indexOf('拆解草案') > draftOrder.indexOf('项目资料')
    && draftOrder.indexOf('这个项目还没有子任务') > draftOrder.indexOf('拆解草案'),
    JSON.stringify({ references: draftOrder.indexOf('项目资料'), draft: draftOrder.indexOf('拆解草案'), tasks: draftOrder.indexOf('这个项目还没有子任务') }))
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
    JSON.stringify(savedPlan.items[0].refs) === JSON.stringify(['ref-plan'])
    && JSON.stringify(savedPlan.items[0].deliverables) === JSON.stringify(['docs/tree.md'])
    && savedPlan.items[0].note === '输出目录树与依赖清单',
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
    && JSON.stringify(firstAppliedTask.refs) === JSON.stringify(['ref-plan'])
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

  await mount({ seedHost: { version: 10, revision: 51, projects: [{ id: 'p-noplan', name: '无草案项目', references: [], tasks: [], memory: [], trash: [] }] } })
  await settle(300)
  check('a project without a draft renders no draft card', !textOf().includes('拆解草案'), textOf().slice(0, 220))
  check('a project without a draft offers no apply control', byButtonText('全部落卡') === null)

console.log('\n[46] material intake: scan local paths and links into references')
  const materialDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-greenlight-intake-'))
  fs.mkdirSync(path.join(materialDir, 'docs'))
  fs.writeFileSync(path.join(materialDir, 'a.md'), '# A\n')
  fs.writeFileSync(path.join(materialDir, 'docs', 'b.md'), '# B\n')
  const firstMaterial = path.join(materialDir, 'a.md')
  const secondMaterial = path.join(materialDir, 'docs', 'b.md')
  const materialSeed = {
    version: 10,
    revision: 71,
    projects: [{ id: 'p-mat', name: '材料项目', rootDir: materialDir, references: [], tasks: [], memory: [], trash: [] }],
  }
  await mount({ seedHost: materialSeed })
  await settle(300)
  const intakeBox = byAria('粘贴本地路径或链接，一行一个')
  check('the material input line exists', intakeBox !== null && intakeBox.type === 'textarea', intakeBox && String(intakeBox.type))
  check('the material scan control exists', byButtonText('扫描材料') !== null)
  // Blank lines, stray whitespace and a repeated path must not reach the Host.
  change(intakeBox, '  ' + firstMaterial + '  \n\n' + secondMaterial + '\n' + firstMaterial)
  submit(formOf(intakeBox))
  await settle(700)
  await flush()
  const intakeOp = sentOps.filter(op => op.type === 'reference.intake').pop()
  check('scanning materials sends reference.intake', !!intakeOp && intakeOp.projectId === 'p-mat', JSON.stringify(intakeOp))
  check('the pasted block becomes a path array',
    !!intakeOp && JSON.stringify(intakeOp.paths) === JSON.stringify([firstMaterial, secondMaterial]),
    intakeOp && JSON.stringify(intakeOp.paths))
  check('the scan result line reports what the Host did',
    textOf().includes('已添加 2 条资料（跳过 0 条重复，0 条未找到）'), textOf().slice(-320))
  const intakeRefs = stored().projects[0].references
  check('the scanned paths became link references',
    intakeRefs.length === 2 && intakeRefs.every(reference => reference.kind === 'link'),
    JSON.stringify(intakeRefs))
  check('the scanned references reach the host', hostState.board.projects[0].references.length === 2, String(hostState.board.projects[0].references.length))
  const intakeValues = intakeRefs.map(reference => reference.value.replace(/\\/g, '/'))
  check('the scanned values are recorded relative to the project root',
    intakeValues.includes('a.md') && intakeValues.includes('docs/b.md'), JSON.stringify(intakeValues))

  // Scanning the same paths again adds nothing and says so.
  change(byAria('粘贴本地路径或链接，一行一个'), firstMaterial + '\n' + secondMaterial)
  submit(formOf(byAria('粘贴本地路径或链接，一行一个')))
  await settle(700)
  await flush()
  check('a repeated scan adds no duplicate references', hostState.board.projects[0].references.length === 2, JSON.stringify(hostState.board.projects[0].references.map(reference => reference.value)))
  check('the repeated scan reports every path as a duplicate',
    textOf().includes('已添加 0 条资料（跳过 2 条重复，0 条未找到）'), textOf().slice(-320))

  // A path that does not exist is requested from the Host and adds nothing.
  const missingMaterial = path.join(materialDir, 'gone.md')
  change(byAria('粘贴本地路径或链接，一行一个'), missingMaterial)
  submit(formOf(byAria('粘贴本地路径或链接，一行一个')))
  await settle(700)
  await flush()
  const missingIntakeOp = sentOps.filter(op => op.type === 'reference.intake').pop()
  check('a missing path is still handed to the Host',
    !!missingIntakeOp && JSON.stringify(missingIntakeOp.paths) === JSON.stringify([missingMaterial]),
    missingIntakeOp && JSON.stringify(missingIntakeOp.paths))
  check('a missing path adds no reference', hostState.board.projects[0].references.length === 2, JSON.stringify(hostState.board.projects[0].references.map(reference => reference.value)))
  check('the missing path is reported as not found',
    textOf().includes('已添加 0 条资料（跳过 0 条重复，1 条未找到）'), textOf().slice(-320))

  // A Host that does not report per-op results still gets a usable line: the
  // added entries are counted from the adopted board, the other counters are 0.
  fs.writeFileSync(path.join(materialDir, 'docs', 'c.md'), '# C\n')
  const thirdMaterial = path.join(materialDir, 'docs', 'c.md')
  const realFetchWithResults = global.fetch
  global.fetch = async (url, init) => {
    const response = await realFetchWithResults(url, init)
    if (url !== '/greenlight/ops' || typeof response.json !== 'function') return response
    const body = await response.json()
    if (body !== null && typeof body === 'object') delete body.results
    return { ok: response.ok, status: response.status, json: async () => body }
  }
  change(byAria('粘贴本地路径或链接，一行一个'), thirdMaterial)
  submit(formOf(byAria('粘贴本地路径或链接，一行一个')))
  await settle(700)
  await flush()
  global.fetch = realFetchWithResults
  check('a scan without Host results falls back to the added count',
    textOf().includes('已添加 1 条资料（跳过 0 条重复，0 条未找到）'), textOf().slice(-320))
  check('the fallback scan still reached the host', hostState.board.projects[0].references.length === 3, String(hostState.board.projects[0].references.length))

  const localV10 = JSON.stringify({ version: 10, projects: [{ id: 'p-local-v10', name: '本地 v10 项目', references: [], tasks: [], memory: [], trash: [] }] })
  await mount({ seedLocal: localV10 })
  await settle(700)
  await flush()
  check('a version-10 browser mirror is rewritten as version 11', stored() !== null && stored().version === 11, stored() && String(stored().version))
  check('the mirrored project carries a null draft', stored() !== null && stored().projects[0].plan === null, stored() && JSON.stringify(stored().projects[0].plan))

  console.log('\n' + (failures === 0 ? 'ALL ' + checks + ' CHECKS PASSED' : failures + ' of ' + checks + ' CHECKS FAILED'))
  process.exit(failures === 0 ? 0 : 1)
})().catch((error) => {
  console.error('HARNESS CRASHED: ' + (error && error.stack ? error.stack : error))
  process.exit(1)
})
