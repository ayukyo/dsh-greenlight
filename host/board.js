/**
 * Greenlight board data layer — pure functions only.
 *
 * The Host half owns this module: it normalizes whatever is on disk, migrates
 * the earlier browser-only documents, and applies every board operation. The
 * browser half never validates business rules; it renders what this module
 * returns, so there is exactly one implementation of the model.
 *
 * Document versions
 *   1 (browser, flat tasks with queued/doing/done)
 *   2–4 (browser, projects with progress percentages)
 *   6 (this module: projects → subtasks with status, project references, memory)
 *   7 (priority, due date, tags, references, trash)
 *   8 (automatic acceptance: a completed card is verified first and only lands
 *      in `review` when it cannot be verified, or when the project or the card
 *      asks for a human)
 *   9 (verified claims, column gates, cold storage, decision anchor)
 *  10 (one typed `references` list replaces the `shared` text and the
 *      `sharedEntries` list; `link` references are re-checked, `note` ones are
 *      convention text that is never probed)
 *  11 (a project may hold one `plan`: a draft breakdown of subtasks that a
 *      human confirms before it becomes real cards)
 *  12 (project material is one free-text `materials` block: the typed
 *      `references` list, the card `refs` and the draft item `refs` are gone,
 *      and an older document is merged into that text on load)
 */

/** Version written by this module. */
export const DOC_VERSION = 12

/** Subtask columns, in board order. */
export const TASK_STATUSES = ['backlog', 'todo', 'running', 'review', 'done', 'failed']

/** Subtask priorities, low to high. */
export const TASK_PRIORITIES = ['low', 'normal', 'high', 'urgent']

/** How a finished subtask is accepted: automatically when verifiable, otherwise by a human. */
export const ACCEPTANCE_MODES = ['auto', 'human']

/** Default per-project acceptance rules. */
export const DEFAULT_ACCEPTANCE_RULES = {
  /** A completion must say what was done. */
  requireEvidence: true,
  /** A completion must declare at least one deliverable. */
  requireDeliverables: false,
  /** Declared deliverables must exist on disk (needs the project root for relative paths). */
  verifyDeliverables: true,
  /** A completion must belong to a Session. */
  requireSession: false,
  /** A completion must carry at least one verified claim. */
  requireVerifiedClaim: false,
  /** Open items (unverified claims, undecided questions) must be decided by a human. */
  blockOnDebt: false,
}

/**
 * Verification layers a claim can be checked at, coarsest to strictest.
 *
 * Delivery pipelines distinguish many more layers; these are the five a board
 * can actually tell apart, so "compiled" never looks like "ran on the device".
 */
export const VERIFY_LAYERS = ['static', 'unit', 'build', 'host', 'physical']

/** Outcomes a claim may carry. */
export const CLAIM_OUTCOMES = ['pass', 'fail', 'unverified']

/** How many audit events one subtask keeps. */
export const MAX_TASK_EVENTS = 50
/** How many independent reviews one subtask keeps. */
export const MAX_TASK_REVIEWS = 20
/** How many claims one subtask keeps. */
export const MAX_TASK_CLAIMS = 30
/** Longest accepted next action. */
export const MAX_NEXT_ACTION_LENGTH = 500

/** How long a removed subtask stays restorable. */
export const TRASH_RETENTION_MS = 7 * 24 * 60 * 60 * 1000

/**
 * Who issued an operation.
 *
 * A human-driven surface may close a card outright. A model-facing tool cannot:
 * its completion request runs through {@link evaluateAcceptance} first, so a
 * card only lands in `done` when the work is verifiable, and otherwise stops in
 * `review` for a human.
 */
export const OP_ORIGIN_UI = 'ui'
/** Origin used by model-facing tool calls. */
export const OP_ORIGIN_AGENT = 'agent'

/**
 * @param value - candidate origin.
 * @returns the origin, defaulting to `agent` so an unlabelled caller is
 *   subjected to acceptance instead of bypassing it.
 */
function asOrigin(value) {
  return value === OP_ORIGIN_UI ? OP_ORIGIN_UI : OP_ORIGIN_AGENT
}

/**
 * Whether this operation may close a card without automatic acceptance.
 * @param origin - who issued it.
 * @returns whether the caller is the human-driven surface.
 */
function isHumanOrigin(origin) {
  return origin === OP_ORIGIN_UI
}

/** Longest accepted title / name. */
export const MAX_TITLE_LENGTH = 200
/** Longest accepted project material text. */
export const MAX_MATERIALS_LENGTH = 20000
/** Name the legacy `project.shared` free text is carried over under. */
const LEGACY_SHARED_NAME = '项目说明'
/** Longest accepted note text. */
export const MAX_NOTE_LENGTH = 8000
/** Longest accepted memory entry. */
export const MAX_MEMORY_LENGTH = 4000
/** Longest accepted completion note. */
export const MAX_EVIDENCE_LENGTH = 8000
/** Most deliverable paths one subtask may declare. */
export const MAX_DELIVERABLES = 20
/** Longest single deliverable path. */
export const MAX_DELIVERABLE_LENGTH = 500
/** Longest accepted project root directory. */
export const MAX_ROOT_LENGTH = 1000
/** Fewest items a plan may hold. */
export const MIN_PLAN_ITEMS = 1
/** Most items a plan may hold. */
export const MAX_PLAN_ITEMS = 50

/**
 * @returns the current time as an ISO string.
 */
function nowIso() {
  return new Date().toISOString()
}

/**
 * Build a locally unique id.
 * @param prefix - character naming the entity kind.
 * @returns a unique id string.
 */
export function createId(prefix) {
  return prefix + Date.now().toString(36) + Math.random().toString(36).slice(2, 8)
}

/**
 * @param value - candidate.
 * @returns whether the value is a plain object.
 */
function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/**
 * Normalize an acceptance mode.
 * @param value - candidate mode.
 * @returns 'auto' or 'human'; unknown values fall back to automatic acceptance.
 */
function asAcceptanceMode(value) {
  return value === 'human' ? 'human' : 'auto'
}

/**
 * Normalize the declared deliverable paths.
 * @param value - candidate list.
 * @returns a bounded list of paths.
 */
function asDeliverables(value) {
  if (!Array.isArray(value)) return []
  const out = []
  for (const item of value) {
    if (typeof item !== 'string') continue
    const path = item.trim()
    if (path === '') continue
    out.push(bounded(path, MAX_DELIVERABLE_LENGTH))
    if (out.length >= MAX_DELIVERABLES) break
  }
  return out
}

/**
 * Normalize the per-project acceptance rules.
 * @param value - candidate rules.
 * @returns the rules, each falling back to its default.
 */
function asAcceptanceRules(value) {
  const source = isRecord(value) ? value : {}
  const out = {}
  for (const key of Object.keys(DEFAULT_ACCEPTANCE_RULES)) {
    out[key] = typeof source[key] === 'boolean' ? source[key] : DEFAULT_ACCEPTANCE_RULES[key]
  }
  return out
}

/**
 * Normalize the verdict of a deliverable probe.
 * @param value - candidate verdict.
 * @returns a verdict, or null.
 */
function normalizeVerification(value) {
  if (!isRecord(value)) return null
  const asList = input => (Array.isArray(input)
    ? input.filter(item => typeof item === 'string').map(item => bounded(item, MAX_DELIVERABLE_LENGTH))
    : [])
  return {
    checked: value.checked === true,
    missing: asList(value.missing),
    unresolved: asList(value.unresolved),
    at: typeof value.at === 'number' && Number.isFinite(value.at) ? value.at : 0,
  }
}

/**
 * Normalize one verification claim: what was checked, how, at which layer.
 * @param raw - candidate claim.
 * @returns a normalized claim, or null when unusable.
 */
function normalizeClaim(raw) {
  if (!isRecord(raw)) return null
  const what = bounded(asString(raw.what).trim(), MAX_TITLE_LENGTH)
  if (what === '') return null
  return {
    id: typeof raw.id === 'string' && raw.id !== '' ? raw.id : createId('c'),
    what,
    how: bounded(asString(raw.how).trim(), MAX_NOTE_LENGTH),
    layer: VERIFY_LAYERS.includes(raw.layer) ? raw.layer : 'static',
    outcome: CLAIM_OUTCOMES.includes(raw.outcome) ? raw.outcome : 'unverified',
    at: typeof raw.at === 'number' && Number.isFinite(raw.at) ? raw.at : Date.now(),
  }
}

/**
 * @param value - candidate claim list.
 * @returns normalized claims, capped.
 */
function asClaims(value) {
  if (!Array.isArray(value)) return []
  const out = []
  for (const item of value) {
    const claim = normalizeClaim(item)
    if (claim === null) continue
    out.push(claim)
    if (out.length >= MAX_TASK_CLAIMS) break
  }
  return out
}

/**
 * Normalize one audit event.
 * @param raw - candidate event.
 * @returns a normalized event, or null.
 */
function normalizeEvent(raw) {
  if (!isRecord(raw)) return null
  const kind = asString(raw.kind).trim()
  if (kind === '') return null
  return {
    at: typeof raw.at === 'number' && Number.isFinite(raw.at) ? raw.at : Date.now(),
    kind: bounded(kind, 60),
    from: bounded(asString(raw.from), 40),
    to: bounded(asString(raw.to), 40),
    by: bounded(asString(raw.by), 40),
    note: bounded(asString(raw.note), MAX_NOTE_LENGTH),
  }
}

/**
 * @param value - candidate event list.
 * @returns normalized events, newest last, capped.
 */
function asEvents(value) {
  if (!Array.isArray(value)) return []
  const out = []
  for (const item of value) {
    const event = normalizeEvent(item)
    if (event !== null) out.push(event)
  }
  return out.slice(-MAX_TASK_EVENTS)
}

/**
 * Normalize one independent review record.
 * @param raw - candidate review.
 * @returns a normalized review, or null.
 */
function normalizeReview(raw) {
  if (!isRecord(raw)) return null
  const verdict = asString(raw.verdict).trim()
  if (verdict === '') return null
  return {
    id: typeof raw.id === 'string' && raw.id !== '' ? raw.id : createId('r'),
    by: bounded(asString(raw.by).trim(), MAX_TITLE_LENGTH),
    verdict: bounded(verdict, 40),
    note: bounded(asString(raw.note), MAX_NOTE_LENGTH),
    at: typeof raw.at === 'number' && Number.isFinite(raw.at) ? raw.at : Date.now(),
  }
}

/**
 * @param value - candidate review list.
 * @returns normalized reviews, capped.
 */
function asReviews(value) {
  if (!Array.isArray(value)) return []
  const out = []
  for (const item of value) {
    const review = normalizeReview(item)
    if (review !== null) out.push(review)
  }
  return out.slice(-MAX_TASK_REVIEWS)
}

/**
 * Normalize the verification layers a project requires.
 * @param value - candidate layer list.
 * @returns the layers, deduplicated and ordered.
 */
function asRequiredLayers(value) {
  if (!Array.isArray(value)) return []
  const seen = new Set()
  for (const item of value) {
    if (typeof item === 'string' && VERIFY_LAYERS.includes(item)) seen.add(item)
  }
  return VERIFY_LAYERS.filter(layer => seen.has(layer))
}

/**
 * Normalize a project's per-column gates.
 * @param value - candidate gates.
 * @returns the gates, each defaulting to false.
 */
function asGates(value) {
  const source = isRecord(value) ? value : {}
  const review = isRecord(source.review) ? source.review : {}
  const done = isRecord(source.done) ? source.done : {}
  return {
    review: {
      requireEvidence: review.requireEvidence === true,
      requireDeliverables: review.requireDeliverables === true,
    },
    done: {
      requireEvidence: done.requireEvidence === true,
      requireDeliverables: done.requireDeliverables === true,
    },
  }
}

/**
 * Normalize a project's decision anchor: the distilled reasoning that should
 * survive from card to card instead of being re-read from full notes.
 * @param value - candidate anchor.
 * @returns the anchor.
 */
function asAnchor(value) {
  const source = isRecord(value) ? value : {}
  const asLines = input => (Array.isArray(input)
    ? input.filter(item => typeof item === 'string' && item.trim() !== '').map(item => bounded(item.trim(), MAX_NOTE_LENGTH)).slice(0, 20)
    : [])
  const decisions = []
  if (Array.isArray(source.decisions)) {
    for (const item of source.decisions) {
      if (!isRecord(item)) continue
      const title = bounded(asString(item.title).trim(), MAX_TITLE_LENGTH)
      if (title === '') continue
      decisions.push({
        title,
        reason: bounded(asString(item.reason).trim(), MAX_NOTE_LENGTH),
        source: bounded(asString(item.source).trim(), MAX_TITLE_LENGTH),
      })
      if (decisions.length >= 20) break
    }
  }
  return {
    digest: bounded(asString(source.digest).trim(), MAX_MATERIALS_LENGTH),
    decisions,
    risks: asLines(source.risks),
    deviations: asLines(source.deviations),
    updatedAt: typeof source.updatedAt === 'number' && Number.isFinite(source.updatedAt) ? source.updatedAt : 0,
  }
}

/**
 * Normalize the last acceptance verdict.
 * @param value - candidate verdict.
 * @returns a verdict, or null.
 */
function normalizeAcceptance(value) {
  if (!isRecord(value)) return null
  const asList = input => (Array.isArray(input)
    ? input.filter(reason => typeof reason === 'string').map(reason => bounded(reason, MAX_NOTE_LENGTH))
    : [])
  return {
    pass: value.pass === true,
    reasons: asList(value.reasons),
    warnings: asList(value.warnings),
    at: typeof value.at === 'number' && Number.isFinite(value.at) ? value.at : 0,
  }
}

/**
 * @param value - candidate.
 * @param fallback - value used when the candidate is not a string.
 * @returns the string.
 */
function asString(value, fallback = '') {
  return typeof value === 'string' ? value : fallback
}

/**
 * Cut a string to its bound.
 * @param value - source text.
 * @param limit - maximum length.
 * @returns the bounded text.
 */
function bounded(value, limit) {
  return value.length > limit ? value.slice(0, limit) : value
}

/**
 * Clamp a completion value.
 * @param value - candidate percentage.
 * @param fallback - value used when the candidate is not finite.
 * @returns an integer from 0 to 100.
 */
function clampPercent(value, fallback = 0) {
  const number = typeof value === 'number' && Number.isFinite(value) ? value : fallback
  return Math.max(0, Math.min(100, Math.round(number)))
}

/**
 * @param value - candidate status.
 * @param fallback - status used when the candidate is unknown.
 * @returns a known status.
 */
function asStatus(value, fallback = 'todo') {
  return typeof value === 'string' && TASK_STATUSES.includes(value) ? value : fallback
}

/**
 * @param value - candidate priority.
 * @param fallback - priority used when the candidate is unknown.
 * @returns a known priority.
 */
function asPriority(value, fallback = 'normal') {
  return typeof value === 'string' && TASK_PRIORITIES.includes(value) ? value : fallback
}

/**
 * Keep a string list of tags, trimmed, de-duplicated and bounded.
 * @param value - candidate list.
 * @returns the normalized tags.
 */
function asTags(value) {
  if (!Array.isArray(value)) return []
  const tags = []
  for (const candidate of value) {
    if (typeof candidate !== 'string') continue
    const tag = candidate.trim().slice(0, 32)
    if (tag === '' || tags.includes(tag)) continue
    if (tags.length >= 8) break
    tags.push(tag)
  }
  return tags
}

/**
 * Normalize a due date: an ISO date (`YYYY-MM-DD`) or the empty string.
 * @param value - candidate value.
 * @returns the normalized date or ''.
 */
function asDueDate(value) {
  if (typeof value !== 'string') return ''
  const trimmed = value.trim()
  if (!/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) return ''
  const stamp = Date.parse(trimmed + 'T00:00:00Z')
  return Number.isNaN(stamp) ? '' : trimmed
}

/**
 * @returns a board document with no projects.
 */
export function emptyBoard() {
  return { version: DOC_VERSION, revision: 0, updatedAt: nowIso(), projects: [] }
}

/**
 * @returns a project record with every field at its empty value.
 */
function emptyProject() {
  return {
    acceptanceMode: 'auto',
    acceptanceRules: asAcceptanceRules({}),
    requiredLayers: [],
    gates: asGates({}),
    anchor: asAnchor({}),
    rootDir: '',
    // One free-text block: document paths, conventions and links all live here.
    materials: '',
    // The draft breakdown of subtasks, or null when there is none.
    plan: null,
    tasks: [],
    memory: [],
    trash: [],
    createdAt: Date.now(),
  }
}

/**
 * Normalize one subtask.
 * @param raw - candidate subtask.
 * @returns a normalized subtask, or null when unusable.
 */
function normalizeTask(raw) {
  if (!isRecord(raw) || typeof raw.title !== 'string') return null
  const createdAt = typeof raw.createdAt === 'number' && Number.isFinite(raw.createdAt) ? raw.createdAt : Date.now()
  return {
    id: typeof raw.id === 'string' && raw.id !== '' ? raw.id : createId('t'),
    title: bounded(raw.title, MAX_TITLE_LENGTH),
    titleSource: raw.titleSource === 'auto' ? 'auto' : 'manual',
    note: bounded(asString(raw.note), MAX_NOTE_LENGTH),
    status: asStatus(raw.status, raw.progress >= 100 ? 'done' : raw.progress > 0 ? 'running' : 'todo'),
    progress: clampPercent(raw.progress, 0),
    priority: asPriority(raw.priority, 'normal'),
    dueDate: asDueDate(raw.dueDate),
    tags: asTags(raw.tags),
    blocked: raw.blocked === true,
    requireHuman: raw.requireHuman === true,
    evidence: bounded(asString(raw.evidence), MAX_EVIDENCE_LENGTH),
    deliverables: asDeliverables(raw.deliverables),
    acceptedBy: raw.acceptedBy === 'auto' || raw.acceptedBy === 'human' ? raw.acceptedBy : '',
    acceptedAt: typeof raw.acceptedAt === 'number' && Number.isFinite(raw.acceptedAt) && raw.acceptedAt > 0
      ? raw.acceptedAt
      : 0,
    acceptance: normalizeAcceptance(raw.acceptance),
    verification: normalizeVerification(raw.verification),
    nextAction: bounded(asString(raw.nextAction), MAX_NEXT_ACTION_LENGTH),
    claims: asClaims(raw.claims),
    pendingVerification: Array.isArray(raw.pendingVerification)
      ? raw.pendingVerification.filter(item => typeof item === 'string' && item.trim() !== '')
        .map(item => bounded(item.trim(), MAX_NOTE_LENGTH)).slice(0, 20)
      : [],
    reviews: asReviews(raw.reviews),
    events: asEvents(raw.events),
    reviewReason: bounded(asString(raw.reviewReason), MAX_NOTE_LENGTH),
    sessionId: asString(raw.sessionId),
    workspaceId: asString(raw.workspaceId),
    agentPreset: asString(raw.agentPreset),
    createdAt,
    updatedAt: typeof raw.updatedAt === 'number' && Number.isFinite(raw.updatedAt) ? raw.updatedAt : createdAt,
  }
}

/**
 * Normalize one memory entry.
 * @param raw - candidate entry.
 * @returns a normalized entry, or null when unusable.
 */
function normalizeMemory(raw) {
  if (!isRecord(raw)) return null
  const text = asString(raw.text)
  if (text.trim() === '') return null
  return {
    id: typeof raw.id === 'string' && raw.id !== '' ? raw.id : createId('m'),
    text: bounded(text, MAX_MEMORY_LENGTH),
    taskId: asString(raw.taskId),
    createdAt: typeof raw.createdAt === 'number' && Number.isFinite(raw.createdAt) ? raw.createdAt : Date.now(),
  }
}

/**
 * Read one stored material entry of a version-11 (or older) document.
 *
 * Only what the text rendering needs is kept: the merged block has no per-entry
 * identity, so ids and stale marks are dropped here.
 * @param raw - candidate entry.
 * @returns `{ kind, name, value, description }`, or null when unusable.
 */
function asMaterialEntry(raw) {
  if (!isRecord(raw)) return null
  const name = asString(raw.name).trim()
  if (name === '') return null
  return {
    // Only a `note` renders differently from the rest; `link` and `other` are
    // both named pointers, so folding them together loses nothing.
    kind: raw.kind === 'note' ? 'note' : 'link',
    name: bounded(name, MAX_TITLE_LENGTH),
    value: asString(raw.value),
    description: asString(raw.description).trim(),
  }
}

/**
 * Read one version-9 shared entry: a named path, which becomes a link entry.
 * @param raw - legacy entry.
 * @returns `{ kind, name, value, description }`, or null when unusable.
 */
function asLegacySharedEntry(raw) {
  if (!isRecord(raw)) return null
  const name = asString(raw.name).trim()
  if (name === '') return null
  return {
    kind: 'link',
    name: bounded(name, MAX_TITLE_LENGTH),
    value: asString(raw.path).trim(),
    description: asString(raw.description).trim(),
  }
}

/**
 * Render one stored material entry as a line of the free-text block.
 *
 * A `note` is convention text that already reads as a sentence, so its
 * description is not repeated; a link keeps one, because that is where a
 * version-11 document recorded what the target is.
 * @param entry - entry to render.
 * @returns the line.
 */
function materialLine(entry) {
  const value = entry.value === '' ? '' : '：' + entry.value
  const description = entry.kind === 'note' || entry.description === '' ? '' : '（' + entry.description + '）'
  return '- ' + entry.name + value + description
}

/**
 * Merge a stored document's material into the one free-text block.
 *
 * A block that is already written wins: reading a document that has been
 * migrated once must not append its entries again.
 *
 * @param raw - stored project.
 * @param entries - the project's material entries, in stored order.
 * @returns the material text, bounded.
 */
function asMaterials(raw, entries) {
  const stored = asString(raw.materials)
  if (stored.trim() !== '') return bounded(stored, MAX_MATERIALS_LENGTH)
  return bounded(entries.map(materialLine).join('\n'), MAX_MATERIALS_LENGTH)
}

/**
 * @param value - candidate.
 * @returns whether the value is an array whose entries are all strings.
 */
function isStringArray(value) {
  if (!Array.isArray(value)) return false
  return value.every(item => typeof item === 'string')
}

/**
 * Normalize the items of one plan.
 *
 * Loading is lenient on purpose: a hand-edited document must not lose the whole
 * draft because one item is unreadable, so unusable items are dropped instead of
 * failing the load.
 *
 * @param value - candidate item list.
 * @returns the normalized items, in order, bounded.
 */
function normalizePlanItems(value) {
  const items = []
  for (const candidate of Array.isArray(value) ? value : []) {
    if (!isRecord(candidate)) continue
    const title = asString(candidate.title).trim()
    if (title === '') continue
    items.push({
      title: bounded(title, MAX_TITLE_LENGTH),
      note: bounded(asString(candidate.note), MAX_NOTE_LENGTH),
      priority: asPriority(candidate.priority, 'normal'),
      tags: asTags(candidate.tags),
      deliverables: asDeliverables(candidate.deliverables),
    })
    if (items.length >= MAX_PLAN_ITEMS) break
  }
  return items
}

/**
 * Normalize one project plan: the draft breakdown a human confirms before it
 * becomes real subtasks.
 *
 * A version-10 document has no plan at all, and a draft without any item would
 * render as an empty card, so both come back as `null`.
 *
 * @param raw - candidate plan.
 * @returns a normalized plan, or null.
 */
function normalizePlan(raw) {
  if (!isRecord(raw)) return null
  const items = normalizePlanItems(raw.items)
  if (items.length === 0) return null
  return {
    id: typeof raw.id === 'string' && raw.id !== '' ? raw.id : createId('plan-'),
    summary: bounded(asString(raw.summary).trim(), MAX_NOTE_LENGTH),
    createdAt: typeof raw.createdAt === 'number' && Number.isFinite(raw.createdAt) ? raw.createdAt : Date.now(),
    items,
  }
}

/**
 * Validate the items of a plan before they are stored.
 *
 * Unlike a document load, invalid input is refused outright: a draft is written
 * once, so an item silently dropped here would be a lost instruction.
 *
 * @param value - candidate item list.
 * @returns `{ items }` on success, or `{ code }` when refused.
 */
function validatePlanItems(value) {
  if (!Array.isArray(value)) return { code: 'invalid_field' }
  if (value.length < MIN_PLAN_ITEMS || value.length > MAX_PLAN_ITEMS) return { code: 'invalid_field' }
  const items = []
  for (const candidate of value) {
    if (!isRecord(candidate)) return { code: 'invalid_field' }
    if (typeof candidate.title !== 'string') return { code: 'invalid_field' }
    const title = candidate.title.trim()
    if (title === '' || title.length > MAX_TITLE_LENGTH) return { code: 'invalid_field' }
    // A version-11 draft could carry `refs`; the field no longer exists, so it
    // is ignored instead of refusing a payload an older client still sends.
    const item = {
      title,
      note: '',
      priority: 'normal',
      tags: [],
      deliverables: [],
    }
    if (candidate.note !== undefined) {
      if (typeof candidate.note !== 'string') return { code: 'invalid_field' }
      item.note = bounded(candidate.note, MAX_NOTE_LENGTH)
    }
    if (candidate.priority !== undefined) {
      if (!TASK_PRIORITIES.includes(candidate.priority)) return { code: 'invalid_field' }
      item.priority = candidate.priority
    }
    if (candidate.tags !== undefined) {
      if (!isStringArray(candidate.tags)) return { code: 'invalid_field' }
      item.tags = asTags(candidate.tags)
    }
    if (candidate.deliverables !== undefined) {
      if (!isStringArray(candidate.deliverables)) return { code: 'invalid_field' }
      item.deliverables = asDeliverables(candidate.deliverables)
    }
    items.push(item)
  }
  return { items }
}

/**
 * Turn one plan item into a subtask record, at the task defaults the contract
 * states: `todo`, zero progress, and the item's note/priority/tags/
 * deliverables carried over.
 * @param item - normalized plan item.
 * @param at - creation timestamp.
 * @returns a normalized subtask.
 */
function taskFromPlanItem(item, at) {
  return normalizeTask({
    id: createId('t'),
    title: item.title,
    titleSource: 'manual',
    note: item.note,
    status: 'todo',
    progress: 0,
    priority: item.priority,
    tags: item.tags,
    deliverables: item.deliverables,
    createdAt: at,
    updatedAt: at,
  })
}

/**
 * Normalize one trash record.
 * @param raw - candidate record.
 * @returns a normalized record, or null when unusable.
 */
function normalizeTrash(raw) {
  if (!isRecord(raw)) return null
  const task = normalizeTask(raw.task)
  if (task === null) return null
  return {
    task,
    index: typeof raw.index === 'number' && Number.isFinite(raw.index) ? Math.max(0, Math.floor(raw.index)) : 0,
    deletedAt: typeof raw.deletedAt === 'number' && Number.isFinite(raw.deletedAt) ? raw.deletedAt : Date.now(),
  }
}

/**
 * Normalize one project.
 * @param raw - candidate project.
 * @returns a normalized project, or null when unusable.
 */
function normalizeProject(raw) {
  if (!isRecord(raw) || typeof raw.name !== 'string') return null
  const tasks = []
  const taskSource = Array.isArray(raw.tasks) ? raw.tasks : []
  for (const candidate of taskSource) {
    const task = normalizeTask(candidate)
    if (task !== null) tasks.push(task)
  }
  const memory = []
  const memorySource = Array.isArray(raw.memory) ? raw.memory : []
  for (const candidate of memorySource) {
    const entry = normalizeMemory(candidate)
    if (entry !== null) memory.push(entry)
  }
  // Memory links survive while their subtask sits in the trash, so restoring a
  // card also restores what its memory entries pointed at.
  const known = new Set(tasks.map(task => task.id))
  for (const record of Array.isArray(raw.trash) ? raw.trash : []) {
    if (isRecord(record) && isRecord(record.task) && typeof record.task.id === 'string') known.add(record.task.id)
  }
  for (const entry of memory) {
    if (entry.taskId !== '' && !known.has(entry.taskId)) entry.taskId = ''
  }
  // Version 9 kept project material in two fields: a free-text `shared` block
  // and a `sharedEntries` list of named paths; versions 10 and 11 kept one typed
  // `references` list. Version 12 folds all of them into a single free-text
  // block, so a stored older document is migrated here, in memory, before
  // anything reads it; the legacy fields are dropped from what gets written.
  const entries = []
  for (const candidate of Array.isArray(raw.references) ? raw.references : []) {
    const entry = asMaterialEntry(candidate)
    if (entry !== null) entries.push(entry)
  }
  const shared = asString(raw.shared)
  if (shared.trim() !== '') {
    // The old free text becomes the first line: that is where it was read.
    entries.unshift({ kind: 'note', name: LEGACY_SHARED_NAME, value: shared, description: '' })
  }
  for (const candidate of Array.isArray(raw.sharedEntries) ? raw.sharedEntries : []) {
    const entry = asLegacySharedEntry(candidate)
    if (entry !== null) entries.push(entry)
  }
  const materials = asMaterials(raw, entries)
  const plan = normalizePlan(raw.plan)
  const trash = []
  const trashSource = Array.isArray(raw.trash) ? raw.trash : []
  const cutoff = Date.now() - TRASH_RETENTION_MS
  for (const candidate of trashSource) {
    const record = normalizeTrash(candidate)
    if (record === null) continue
    if (record.deletedAt < cutoff) continue
    trash.push(record)
  }
  return {
    id: typeof raw.id === 'string' && raw.id !== '' ? raw.id : createId('p'),
    name: bounded(raw.name, MAX_TITLE_LENGTH),
    acceptanceMode: asAcceptanceMode(raw.acceptanceMode),
    acceptanceRules: asAcceptanceRules(raw.acceptanceRules),
    requiredLayers: asRequiredLayers(raw.requiredLayers),
    gates: asGates(raw.gates),
    anchor: asAnchor(raw.anchor),
    lastCheckAt: typeof raw.lastCheckAt === 'number' && Number.isFinite(raw.lastCheckAt) ? raw.lastCheckAt : 0,
    rootDir: bounded(asString(raw.rootDir).trim(), MAX_ROOT_LENGTH),
    materials,
    plan,
    tasks,
    memory,
    trash,
    createdAt: typeof raw.createdAt === 'number' && Number.isFinite(raw.createdAt) ? raw.createdAt : Date.now(),
  }
}

/**
 * Migrate the version-1 flat task list.
 * @param list - legacy task array.
 * @returns projects holding those tasks.
 */
function migrateV1(list) {
  const tasks = []
  for (const item of list) {
    if (!isRecord(item)) continue
    const title = asString(item.title)
    if (title.trim() === '') continue
    const legacyStatus = item.status === 'done' ? 'done' : item.status === 'doing' ? 'running' : 'todo'
    const progress = legacyStatus === 'done' ? 100 : legacyStatus === 'running' ? 50 : 0
    const note = asString(item.session).trim()
    tasks.push({
      id: typeof item.id === 'string' && item.id !== '' ? item.id : createId('t'),
      title: bounded(title, MAX_TITLE_LENGTH),
      titleSource: 'manual',
      note,
      status: legacyStatus,
      progress,
      priority: 'normal',
      dueDate: '',
      tags: [],
      blocked: false,
      requireHuman: false,
      evidence: '',
      deliverables: [],
      acceptedBy: '',
      acceptedAt: 0,
      acceptance: null,
      verification: null,
      nextAction: '',
      claims: [],
      pendingVerification: [],
      reviews: [],
      events: [],
      reviewReason: '',
      sessionId: '',
      workspaceId: '',
      agentPreset: '',
      createdAt: typeof item.createdAt === 'number' && Number.isFinite(item.createdAt) ? item.createdAt : Date.now(),
      updatedAt: Date.now(),
    })
  }
  if (tasks.length === 0) return []
  return [{
    id: createId('p'),
    name: '默认项目',
    ...emptyProject(),
    tasks,
  }]
}

/**
 * Normalize any stored document (object, string, or legacy array) into a board.
 * @param raw - stored document value.
 * @returns a board document at DOC_VERSION.
 */
export function normalizeBoard(raw) {
  if (typeof raw === 'string') {
    try {
      return normalizeBoard(JSON.parse(raw))
    } catch (error) {
      return emptyBoard()
    }
  }
  if (Array.isArray(raw)) {
    return { version: DOC_VERSION, revision: 0, updatedAt: nowIso(), projects: migrateV1(raw) }
  }
  if (!isRecord(raw)) return emptyBoard()
  if (Array.isArray(raw.projects)) {
    const projects = []
    for (const candidate of raw.projects) {
      const project = normalizeProject(candidate)
      if (project !== null) projects.push(project)
    }
    return {
      version: DOC_VERSION,
      revision: typeof raw.revision === 'number' && Number.isFinite(raw.revision) && raw.revision >= 0
        ? Math.floor(raw.revision)
        : 0,
      updatedAt: typeof raw.updatedAt === 'string' ? raw.updatedAt : nowIso(),
      projects,
    }
  }
  if (Array.isArray(raw.tasks)) {
    return { version: DOC_VERSION, revision: 0, updatedAt: nowIso(), projects: migrateV1(raw.tasks) }
  }
  return emptyBoard()
}

/**
 * A project's completion: the average of its subtask percentages.
 *
 * A card that is not yet `done` cannot contribute a full share, however far its
 * own bar has been dragged: work waiting in review counts as 99 at most, so the
 * project only reaches 100% once every card is actually accepted. Without that
 * cap a single card pushed to review at 100% made an untouched project look
 * finished.
 * @param project - project to measure.
 * @returns an integer from 0 to 100.
 */
export function projectPercent(project) {
  if (project.tasks.length === 0) return 0
  let total = 0
  for (const task of project.tasks) {
    total += task.status === 'done' ? 100 : Math.min(task.progress, 99)
  }
  return Math.round(total / project.tasks.length)
}

/**
 * The project's color band: a blocked subtask forces red, work waiting for a
 * human reads yellow, otherwise the average decides (red below 40, yellow below
 * 80, green from 80); an empty project has no band.
 * @param project - project to classify.
 * @returns 'idle' | 'red' | 'yellow' | 'green'.
 */
export function projectTone(project) {
  if (project.tasks.length === 0) return 'idle'
  if (project.tasks.some(task => task.blocked)) return 'red'
  if (project.tasks.some(task => task.status === 'review')) return 'yellow'
  const percent = projectPercent(project)
  if (percent >= 80) return 'green'
  if (percent >= 40) return 'yellow'
  return 'red'
}

/**
 * Column counts for one project.
 * @param project - project to count.
 * @returns one count per status.
 */
export function statusCounts(project) {
  const counts = {}
  for (const status of TASK_STATUSES) counts[status] = 0
  for (const task of project.tasks) counts[task.status] += 1
  return counts
}

/**
 * Find a project by id.
 * @param board - board to search.
 * @param projectId - project identity.
 * @returns the project, or undefined.
 */
export function findProject(board, projectId) {
  return board.projects.find(project => project.id === projectId)
}

/**
 * Find a subtask by id inside one project.
 * @param project - project to search.
 * @param taskId - subtask identity.
 * @returns the subtask, or undefined.
 */
export function findTask(project, taskId) {
  return project.tasks.find(task => task.id === taskId)
}

/* ------------------------------------------------------------- acceptance */

/**
 * The layers actually covered by passing claims.
 * @param task - subtask to inspect.
 * @returns covered layers, ordered coarsest to strictest.
 */
export function verifiedLayers(task) {
  const claims = Array.isArray(task.claims) ? task.claims : []
  const covered = new Set()
  for (const claim of claims) {
    if (claim.outcome === 'pass' && claim.how.trim() !== '') covered.add(claim.layer)
  }
  return VERIFY_LAYERS.filter(layer => covered.has(layer))
}

/**
 * Reports unverified knowledge: claims that are not passing, plus anything the
 * executor explicitly listed as still unverified. This is the card's debt.
 * @param task - subtask to inspect.
 * @returns the open items.
 */
export function verificationDebt(task) {
  const claims = Array.isArray(task.claims) ? task.claims : []
  const open = []
  for (const claim of claims) {
    if (claim.outcome !== 'pass') open.push(claim.what)
  }
  for (const item of Array.isArray(task.pendingVerification) ? task.pendingVerification : []) {
    if (!open.includes(item)) open.push(item)
  }
  return open
}

/**
 * Decide whether a finished subtask may be accepted without a human.
 *
 * Automatic acceptance is deliberately conservative: it only passes when the
 * work is stated as complete, nothing is flagged, and the executor recorded what
 * it did. Everything else becomes a human decision, which is the point — the
 * human only sees the cards that could not be verified.
 *
 * A refusal carries two kinds of reasons: blockers stop acceptance, warnings are
 * worth showing but do not. That keeps small gaps visible without dumping every
 * card on a human.
 *
 * @param task - subtask that claims completion.
 * @param project - project holding it.
 * @returns `{ pass, reasons, warnings }`.
 */
export function evaluateAcceptance(task, project) {
  const reasons = []
  const warnings = []
  const rules = project === undefined ? DEFAULT_ACCEPTANCE_RULES : asAcceptanceRules(project.acceptanceRules)
  if (project !== undefined && project.acceptanceMode === 'human') reasons.push('项目设置为人工验收')
  if (task.requireHuman === true) reasons.push('该卡片要求人工验收')
  if (task.progress < 100) reasons.push('进度未到 100%')
  if (task.blocked === true) reasons.push('仍标记为阻塞')
  if (task.status === 'failed') reasons.push('上一次执行标记为失败')
  if (rules.requireEvidence === true && task.evidence.trim() === '') reasons.push('缺少完成说明，无法核对做了什么')
  if (rules.requireSession === true && task.sessionId === '') reasons.push('该卡片未绑定会话')

  const claims = Array.isArray(task.claims) ? task.claims : []
  const passing = claims.filter(claim => claim.outcome === 'pass' && claim.how.trim() !== '')
  if (rules.requireVerifiedClaim === true && passing.length === 0) reasons.push('没有任何带验证方式的通过项')
  // A failed claim is a fact the executor reported; it must not be auto-accepted.
  const failedClaim = claims.find(claim => claim.outcome === 'fail')
  if (failedClaim !== undefined) reasons.push('存在验证失败项：' + failedClaim.what)

  const requiredLayers = project === undefined ? [] : asRequiredLayers(project.requiredLayers)
  if (requiredLayers.length > 0) {
    const covered = verifiedLayers(task)
    const missing = requiredLayers.filter(layer => !covered.includes(layer))
    if (missing.length > 0) reasons.push('缺少验证层级：' + missing.join('、'))
  }
  if (task.nextAction.trim() === '') warnings.push('没有写下一步动作')

  const deliverables = Array.isArray(task.deliverables) ? task.deliverables : []
  if (rules.requireDeliverables === true && deliverables.length === 0) reasons.push('没有声明交付物')
  if (rules.verifyDeliverables === true && deliverables.length > 0) {
    const verdict = task.verification
    if (verdict === null || verdict === undefined) {
      reasons.push('交付物尚未校验')
    } else if (verdict.unresolved.length > 0) {
      reasons.push('无法定位交付物（项目未设置根目录）：' + verdict.unresolved.join('、'))
    } else if (verdict.missing.length > 0) {
      reasons.push('交付物不存在或为空：' + verdict.missing.join('、'))
    } else if (verdict.checked !== true) {
      reasons.push('交付物未能校验')
    }
  }
  const debt = verificationDebt(task)
  if (debt.length > 0) {
    // The debt is one sentence: a warning by default, because a small open item
    // should stay visible without dumping every card on a human. A project that
    // turned on blockOnDebt promotes the same sentence to a blocker, so "we have
    // not decided that yet" cannot be accepted as finished.
    const note = '还有 ' + debt.length + ' 项未验证或待决策：' + debt.slice(0, 3).join('、')
    if (rules.blockOnDebt === true) reasons.push(note)
    else warnings.push(note)
  }
  return { pass: reasons.length === 0, reasons, warnings }
}

/**
 * Move a subtask into `done` or into `review` according to who completed it.
 *
 * A human-driven surface closes the card directly. A model caller must pass
 * {@link evaluateAcceptance}; when it does not, the card lands in `review` with
 * the refusal recorded, so the human queue only holds what needs attention.
 *
 * @param task - subtask to settle (mutated).
 * @param project - project holding it.
 * @param origin - who asked for completion.
 * @param at - timestamp to record.
 * @param verification - deliverable verdict attached to the op, if a probe ran.
 * @returns the outcome that was applied.
 */
function settleCompletion(task, project, origin, at, verification) {
  if (verification !== undefined) task.verification = normalizeVerification(verification)
  if (isHumanOrigin(origin)) {
    task.status = 'done'
    task.progress = 100
    task.acceptedBy = 'human'
    task.acceptedAt = at
    task.acceptance = { pass: true, reasons: ['人工验收通过'], warnings: [], at }
    task.reviewReason = ''
    task.updatedAt = at
    pushEvent(task, { at, kind: 'accepted', from: '', to: 'done', by: 'human', note: '人工验收通过' })
    return { accepted: true, acceptedBy: 'human', reasons: [] }
  }
  const verdict = evaluateAcceptance(task, project)
  task.acceptance = { pass: verdict.pass, reasons: verdict.reasons, warnings: verdict.warnings, at }
  task.updatedAt = at
  if (verdict.pass) {
    task.status = 'done'
    task.progress = 100
    task.acceptedBy = 'auto'
    task.acceptedAt = at
    task.reviewReason = ''
    pushEvent(task, { at, kind: 'accepted', from: '', to: 'done', by: 'auto', note: '自动验收通过' })
    return { accepted: true, acceptedBy: 'auto', reasons: [] }
  }
  task.status = 'review'
  task.acceptedBy = ''
  task.acceptedAt = 0
  task.reviewReason = verdict.reasons.join('；')
  pushEvent(task, { at, kind: 'escalated', from: '', to: 'review', by: 'auto', note: task.reviewReason })
  return { accepted: false, acceptedBy: '', reasons: verdict.reasons }
}

/**
 * Append one audit event, keeping the newest `MAX_TASK_EVENTS`.
 * @param task - subtask to record against (mutated).
 * @param event - event to append.
 */
function pushEvent(task, event) {
  const normalized = normalizeEvent(event)
  if (normalized === null) return
  const events = Array.isArray(task.events) ? task.events : []
  events.push(normalized)
  task.events = events.slice(-MAX_TASK_EVENTS)
}

/**
 * Check the gate that guards a column a card is about to enter.
 *
 * Gates are opt-in per project: when off, moving between columns stays free.
 * @param task - subtask being moved.
 * @param project - project holding it.
 * @param status - target column.
 * @returns null when allowed, or an error code.
 */
function checkGate(task, project, status) {
  const gates = asGates(project.gates)
  const gate = status === 'review' ? gates.review : (status === 'done' ? gates.done : null)
  if (gate === null) return null
  if (gate.requireEvidence === true && task.evidence.trim() === '') return 'gate_evidence'
  if (gate.requireDeliverables === true && task.deliverables.length === 0) return 'gate_deliverables'
  return null
}

/**
 * Clear the acceptance marks when a card leaves the `done` column.
 * @param task - subtask that moved away.
 */
function clearAcceptance(task) {
  task.acceptedBy = ''
  task.acceptedAt = 0
}

/* -------------------------------------------------------------- operations */

/** Subtask fields a patch may touch. */
const PATCHABLE_TASK_FIELDS = [
  'title', 'titleSource', 'note', 'status', 'progress', 'blocked',
  'reviewReason', 'sessionId', 'workspaceId', 'agentPreset',
  'priority', 'dueDate', 'tags',
  'evidence', 'deliverables', 'requireHuman',
  'nextAction', 'pendingVerification',
]

/**
 * Apply one patch object to a subtask.
 * @param task - target subtask (mutated).
 * @param patch - candidate patch.
 * @returns null on success, or an error code.
 */
function applyTaskPatch(task, patch) {
  if (!isRecord(patch)) return 'invalid_field'
  for (const key of Object.keys(patch)) {
    if (!PATCHABLE_TASK_FIELDS.includes(key)) return 'invalid_field'
  }
  if ('title' in patch) {
    if (typeof patch.title !== 'string') return 'invalid_field'
    task.title = bounded(patch.title, MAX_TITLE_LENGTH)
  }
  if ('titleSource' in patch) task.titleSource = patch.titleSource === 'auto' ? 'auto' : 'manual'
  if ('note' in patch) {
    if (typeof patch.note !== 'string') return 'invalid_field'
    task.note = bounded(patch.note, MAX_NOTE_LENGTH)
  }
  if ('status' in patch) {
    if (!TASK_STATUSES.includes(patch.status)) return 'invalid_field'
    task.status = patch.status
  }
  if ('progress' in patch) {
    const next = typeof patch.progress === 'number' && Number.isFinite(patch.progress) ? patch.progress : NaN
    if (Number.isNaN(next)) return 'invalid_field'
    task.progress = clampPercent(next, task.progress)
  }
  if ('blocked' in patch) task.blocked = patch.blocked === true
  if ('reviewReason' in patch) {
    if (typeof patch.reviewReason !== 'string') return 'invalid_field'
    task.reviewReason = bounded(patch.reviewReason, MAX_NOTE_LENGTH)
  }
  if ('sessionId' in patch) task.sessionId = asString(patch.sessionId)
  if ('workspaceId' in patch) task.workspaceId = asString(patch.workspaceId)
  if ('agentPreset' in patch) task.agentPreset = asString(patch.agentPreset)
  if ('priority' in patch) {
    if (!TASK_PRIORITIES.includes(patch.priority)) return 'invalid_field'
    task.priority = patch.priority
  }
  if ('dueDate' in patch) {
    if (typeof patch.dueDate !== 'string') return 'invalid_field'
    task.dueDate = asDueDate(patch.dueDate)
  }
  if ('tags' in patch) {
    if (!Array.isArray(patch.tags)) return 'invalid_field'
    task.tags = asTags(patch.tags)
  }
  if ('evidence' in patch) {
    if (typeof patch.evidence !== 'string') return 'invalid_field'
    task.evidence = bounded(patch.evidence, MAX_EVIDENCE_LENGTH)
  }
  if ('deliverables' in patch) {
    if (!Array.isArray(patch.deliverables)) return 'invalid_field'
    task.deliverables = asDeliverables(patch.deliverables)
  }
  if ('requireHuman' in patch) task.requireHuman = patch.requireHuman === true
  if ('nextAction' in patch) {
    if (typeof patch.nextAction !== 'string') return 'invalid_field'
    task.nextAction = bounded(patch.nextAction, MAX_NEXT_ACTION_LENGTH)
  }
  if ('pendingVerification' in patch) {
    if (!Array.isArray(patch.pendingVerification)) return 'invalid_field'
    task.pendingVerification = patch.pendingVerification
      .filter(item => typeof item === 'string' && item.trim() !== '')
      .map(item => bounded(item.trim(), MAX_NOTE_LENGTH))
      .slice(0, 20)
  }
  task.updatedAt = Date.now()
  return null
}

/**
 * Apply one operation to a board in place.
 *
 * Every operation is idempotent: repeating it either succeeds without changing
 * the document or reports a stable code the caller can recover from.
 *
 * An operation whose contract states a result writes it back on `op.result`
 * (`plan.apply` reports `{ created, skippedTitles }`), so a caller can read the
 * outcome without diffing the board.
 *
 * @param board - board to mutate.
 * @param op - operation envelope.
 * @returns null on success, or an error code.
 */
export function applyOp(board, op, origin) {
  if (!isRecord(op) || typeof op.type !== 'string') return 'invalid_op'
  const source = asOrigin(origin)
  const project = typeof op.projectId === 'string' ? findProject(board, op.projectId) : undefined

  switch (op.type) {
    case 'project.add': {
      if (typeof op.name !== 'string' || op.name.trim() === '') return 'invalid_field'
      const id = typeof op.id === 'string' && op.id !== '' ? op.id : createId('p')
      if (findProject(board, id) !== undefined) return 'duplicate_id'
      board.projects.push({
        id,
        name: bounded(op.name, MAX_TITLE_LENGTH),
        ...emptyProject(),
        acceptanceMode: asAcceptanceMode(op.acceptanceMode),
        acceptanceRules: asAcceptanceRules(op.acceptanceRules),
        requiredLayers: asRequiredLayers(op.requiredLayers),
        gates: asGates(op.gates),
        anchor: asAnchor(op.anchor),
        rootDir: bounded(asString(op.rootDir).trim(), MAX_ROOT_LENGTH),
      })
      return null
    }
    case 'project.setAcceptance': {
      if (project === undefined) return 'unknown_project'
      if (op.mode !== undefined) {
        if (!ACCEPTANCE_MODES.includes(op.mode)) return 'invalid_field'
        project.acceptanceMode = op.mode
      }
      if (op.rules !== undefined) {
        if (!isRecord(op.rules)) return 'invalid_field'
        for (const key of Object.keys(op.rules)) {
          if (!(key in DEFAULT_ACCEPTANCE_RULES)) return 'invalid_field'
          if (typeof op.rules[key] !== 'boolean') return 'invalid_field'
        }
        project.acceptanceRules = asAcceptanceRules({ ...project.acceptanceRules, ...op.rules })
      }
      if (op.rootDir !== undefined) {
        if (typeof op.rootDir !== 'string') return 'invalid_field'
        project.rootDir = bounded(op.rootDir.trim(), MAX_ROOT_LENGTH)
      }
      if (op.requiredLayers !== undefined) {
        if (!Array.isArray(op.requiredLayers)) return 'invalid_field'
        project.requiredLayers = asRequiredLayers(op.requiredLayers)
      }
      if (op.gates !== undefined) {
        if (!isRecord(op.gates)) return 'invalid_field'
        project.gates = asGates({ ...project.gates, ...op.gates })
      }
      return null
    }
    case 'project.rename': {
      if (project === undefined) return 'unknown_project'
      if (typeof op.name !== 'string') return 'invalid_field'
      project.name = bounded(op.name, MAX_TITLE_LENGTH)
      return null
    }
    case 'project.setMaterials': {
      // Project material is one free-text block: a caller writes the whole
      // thing, so every write replaces what was there instead of merging.
      if (project === undefined) return 'unknown_project'
      if (typeof op.materials !== 'string') return 'invalid_field'
      project.materials = bounded(op.materials, MAX_MATERIALS_LENGTH)
      return null
    }
    case 'project.remove': {
      if (project === undefined) return null
      board.projects = board.projects.filter(entry => entry.id !== project.id)
      return null
    }
    case 'task.add': {
      if (project === undefined) return 'unknown_project'
      if (typeof op.title !== 'string') return 'invalid_field'
      const id = typeof op.id === 'string' && op.id !== '' ? op.id : createId('t')
      if (findTask(project, id) !== undefined) return 'duplicate_id'
      const createdAt = Date.now()
      project.tasks.push({
        id,
        title: bounded(op.title, MAX_TITLE_LENGTH),
        titleSource: op.titleSource === 'auto' ? 'auto' : 'manual',
        note: bounded(asString(op.note), MAX_NOTE_LENGTH),
        status: asStatus(op.status, 'todo'),
        progress: clampPercent(op.progress, 0),
        priority: asPriority(op.priority, 'normal'),
        dueDate: asDueDate(op.dueDate),
        tags: asTags(op.tags),
        blocked: op.blocked === true,
        requireHuman: op.requireHuman === true,
        evidence: bounded(asString(op.evidence), MAX_EVIDENCE_LENGTH),
        deliverables: asDeliverables(op.deliverables),
        acceptedBy: op.acceptedBy === 'auto' || op.acceptedBy === 'human' ? op.acceptedBy : '',
        acceptedAt: typeof op.acceptedAt === 'number' && Number.isFinite(op.acceptedAt) ? op.acceptedAt : 0,
        acceptance: normalizeAcceptance(op.acceptance),
        verification: normalizeVerification(op.verification),
        nextAction: bounded(asString(op.nextAction), MAX_NEXT_ACTION_LENGTH),
        claims: asClaims(op.claims),
        pendingVerification: Array.isArray(op.pendingVerification)
          ? op.pendingVerification.filter(item => typeof item === 'string' && item.trim() !== '')
            .map(item => bounded(item.trim(), MAX_NOTE_LENGTH)).slice(0, 20)
          : [],
        reviews: [],
        events: [],
        reviewReason: bounded(asString(op.reviewReason), MAX_NOTE_LENGTH),
        sessionId: asString(op.sessionId),
        workspaceId: asString(op.workspaceId),
        agentPreset: asString(op.agentPreset),
        // An undo restores the original timestamps instead of inventing new ones.
        createdAt: typeof op.createdAt === 'number' && Number.isFinite(op.createdAt) ? op.createdAt : createdAt,
        updatedAt: createdAt,
      })
      return null
    }
    case 'task.patch': {
      if (project === undefined) return 'unknown_project'
      const task = typeof op.taskId === 'string' ? findTask(project, op.taskId) : undefined
      if (task === undefined) return 'unknown_task'
      if (!isRecord(op.patch)) return 'invalid_field'
      // Asking for `done` is a completion request, not an ordinary field edit:
      // the acceptance rules decide where the card lands.
      if (op.patch.status === 'done') {
        const rest = { ...op.patch }
        delete rest.status
        if (Object.keys(rest).length > 0) {
          const code = applyTaskPatch(task, rest)
          if (code !== null) return code
        }
        settleCompletion(task, project, source, Date.now(), op.verification)
        return null
      }
      // A status written through a patch is a column change too, so the same gate
      // must guard it; otherwise the tool surface could skip the gate. The gate
      // is evaluated before the patch lands so a refusal changes nothing.
      if (typeof op.patch.status === 'string' && op.patch.status !== 'done') {
        const gate = checkGate(task, project, op.patch.status)
        if (gate !== null) return gate
      }
      const code = applyTaskPatch(task, op.patch)
      // Leaving `done` invalidates the previous acceptance.
      if (code === null && task.status !== 'done') clearAcceptance(task)
      return code
    }
    case 'task.move': {
      if (project === undefined) return 'unknown_project'
      const task = typeof op.taskId === 'string' ? findTask(project, op.taskId) : undefined
      if (task === undefined) return 'unknown_task'
      if (!TASK_STATUSES.includes(op.status)) return 'invalid_field'
      if (typeof op.expectedStatus === 'string' && task.status !== op.expectedStatus) return 'stale_status'
      if (typeof op.progress === 'number' && Number.isFinite(op.progress)) task.progress = clampPercent(op.progress, task.progress)
      if (op.status === 'done') {
        const blocked = checkGate(task, project, 'done')
        if (blocked !== null) return blocked
        settleCompletion(task, project, source, Date.now(), op.verification)
        return null
      }
      const gate = checkGate(task, project, op.status)
      if (gate !== null) return gate
      const before = task.status
      task.status = op.status
      clearAcceptance(task)
      task.updatedAt = Date.now()
      pushEvent(task, { at: task.updatedAt, kind: 'moved', from: before, to: op.status, by: isHumanOrigin(source) ? 'human' : 'agent' })
      return null
    }
    case 'task.claim': {
      // Record what was actually checked, how, and at which layer. Claims are the
      // evidence a human reads instead of trusting the word "done".
      if (project === undefined) return 'unknown_project'
      const task = typeof op.taskId === 'string' ? findTask(project, op.taskId) : undefined
      if (task === undefined) return 'unknown_task'
      const claim = normalizeClaim({ ...op.claim, at: Date.now() })
      if (claim === null) return 'invalid_field'
      task.claims = asClaims([...(Array.isArray(task.claims) ? task.claims : []), claim])
      task.updatedAt = Date.now()
      pushEvent(task, { at: task.updatedAt, kind: 'claim', from: '', to: claim.outcome, by: 'agent', note: claim.what })
      return null
    }
    case 'task.review': {
      // An independent second look, recorded next to the card instead of in chat.
      if (project === undefined) return 'unknown_project'
      const task = typeof op.taskId === 'string' ? findTask(project, op.taskId) : undefined
      if (task === undefined) return 'unknown_task'
      const review = normalizeReview({ ...op.review, at: Date.now() })
      if (review === null) return 'invalid_field'
      task.reviews = asReviews([...(Array.isArray(task.reviews) ? task.reviews : []), review])
      task.updatedAt = Date.now()
      pushEvent(task, { at: task.updatedAt, kind: 'review', from: '', to: review.verdict, by: review.by, note: review.note })
      return null
    }
    case 'project.setAnchor': {
      if (project === undefined) return 'unknown_project'
      if (op.anchor !== undefined && !isRecord(op.anchor)) return 'invalid_field'
      project.anchor = asAnchor({ ...project.anchor, ...(op.anchor === undefined ? {} : op.anchor), updatedAt: Date.now() })
      return null
    }
    case 'project.recheck': {
      // The Host probed the declared deliverables; apply the verdict without
      // touching the acceptance record, which belongs to the moment a card was
      // settled.
      if (project === undefined) return 'unknown_project'
      const deliverableCheck = isRecord(op.deliverables) ? op.deliverables : {}
      const at = Date.now()
      for (const task of project.tasks) {
        const verdict = deliverableCheck[task.id]
        if (isRecord(verdict)) {
          task.verification = normalizeVerification({ ...verdict, at })
          task.updatedAt = at
        }
      }
      project.lastCheckAt = at
      return null
    }
    case 'task.submit': {
      // The explicit "I finished this" operation used by tools: it records what
      // was done, then lets automatic acceptance decide. It never closes a card
      // outright — submitting is the executor's act, not the reviewer's.
      if (project === undefined) return 'unknown_project'
      const task = typeof op.taskId === 'string' ? findTask(project, op.taskId) : undefined
      if (task === undefined) return 'unknown_task'
      if (op.evidence !== undefined) {
        if (typeof op.evidence !== 'string') return 'invalid_field'
        task.evidence = bounded(op.evidence, MAX_EVIDENCE_LENGTH)
      }
      if (op.deliverables !== undefined) {
        if (!Array.isArray(op.deliverables)) return 'invalid_field'
        task.deliverables = asDeliverables(op.deliverables)
      }
      if (op.claims !== undefined) {
        if (!Array.isArray(op.claims)) return 'invalid_field'
        task.claims = asClaims(op.claims)
      }
      if (op.nextAction !== undefined) {
        if (typeof op.nextAction !== 'string') return 'invalid_field'
        task.nextAction = bounded(op.nextAction, MAX_NEXT_ACTION_LENGTH)
      }
      if (op.pendingVerification !== undefined) {
        if (!Array.isArray(op.pendingVerification)) return 'invalid_field'
        task.pendingVerification = op.pendingVerification
          .filter(item => typeof item === 'string' && item.trim() !== '')
          .map(item => bounded(item.trim(), MAX_NOTE_LENGTH))
          .slice(0, 20)
      }
      if (op.progress !== undefined) task.progress = clampPercent(op.progress, task.progress)
      if (op.blocked !== undefined) task.blocked = op.blocked === true
      if (op.status === 'failed') {
        task.status = 'failed'
        clearAcceptance(task)
        task.updatedAt = Date.now()
        return null
      }
      settleCompletion(task, project, OP_ORIGIN_AGENT, Date.now(), op.verification)
      return null
    }
    case 'task.remove': {
      if (project === undefined) return 'unknown_project'
      const index = typeof op.taskId === 'string' ? project.tasks.findIndex(entry => entry.id === op.taskId) : -1
      if (index < 0) return null
      const task = project.tasks[index]
      project.tasks = project.tasks.filter(entry => entry.id !== task.id)
      // Soft delete: the card stays restorable for a while instead of vanishing.
      project.trash = project.trash.filter(entry => entry.task.id !== task.id)
      project.trash.push({ task, index, deletedAt: Date.now() })
      return null
    }
    case 'task.restore': {
      if (project === undefined) return 'unknown_project'
      const record = typeof op.taskId === 'string'
        ? project.trash.find(entry => entry.task.id === op.taskId)
        : undefined
      if (record === undefined) return null
      if (findTask(project, record.task.id) !== undefined) return 'duplicate_id'
      project.trash = project.trash.filter(entry => entry !== record)
      const at = Math.max(0, Math.min(record.index, project.tasks.length))
      project.tasks.splice(at, 0, record.task)
      return null
    }
    case 'trash.purge': {
      if (project === undefined) return 'unknown_project'
      const cutoff = Date.now() - TRASH_RETENTION_MS
      project.trash = op.all === true
        ? []
        : project.trash.filter(entry => entry.deletedAt >= cutoff)
      return null
    }
    case 'plan.set': {
      // A draft, not cards: it is validated here and written once, and only
      // `plan.apply` turns it into subtasks.
      if (project === undefined) return 'unknown_project'
      if (typeof op.summary !== 'string') return 'invalid_field'
      const checked = validatePlanItems(op.items)
      if (checked.code !== undefined) return checked.code
      project.plan = {
        id: createId('plan-'),
        summary: bounded(op.summary.trim(), MAX_NOTE_LENGTH),
        createdAt: Date.now(),
        items: checked.items,
      }
      return null
    }
    case 'plan.apply': {
      // Turn the draft into real cards, in item order, at the task defaults.
      // A title that already exists is skipped rather than duplicated: the board
      // must never hold two cards for the same instruction.
      if (project === undefined) return 'unknown_project'
      const plan = project.plan
      if (!isRecord(plan) || !Array.isArray(plan.items) || plan.items.length === 0) return 'unknown_plan'
      const at = Date.now()
      const taken = new Set(project.tasks.map(task => task.title))
      const skippedTitles = []
      let created = 0
      for (const item of plan.items) {
        if (taken.has(item.title)) {
          skippedTitles.push(item.title)
          continue
        }
        taken.add(item.title)
        const task = taskFromPlanItem(item, at)
        // A corrupted draft could carry an item no task can be built from; the
        // rest still lands instead of failing the whole batch.
        if (task === null) {
          taken.delete(item.title)
          continue
        }
        project.tasks.push(task)
        created += 1
      }
      // The draft is confirmed: it is no longer a draft once the cards exist.
      project.plan = null
      // The op reports what it did, so a caller reads the outcome without
      // diffing the board.
      op.result = { created, skippedTitles }
      return null
    }
    case 'plan.discard': {
      // Dropping a draft is deliberately not an error when there is nothing to
      // drop: a stale panel button must not surface as a failure.
      if (project === undefined) return 'unknown_project'
      project.plan = null
      return null
    }
    case 'board.replace': {
      if (!isRecord(op.document)) return 'invalid_field'
      const imported = normalizeBoard(op.document)
      if (imported.projects.length === 0) return 'import_empty'
      board.projects = imported.projects
      return null
    }
    case 'memory.add': {
      if (project === undefined) return 'unknown_project'
      if (typeof op.text !== 'string' || op.text.trim() === '') return 'invalid_field'
      const id = typeof op.id === 'string' && op.id !== '' ? op.id : createId('m')
      if (project.memory.some(entry => entry.id === id)) return 'duplicate_id'
      const taskId = typeof op.taskId === 'string' ? op.taskId : ''
      project.memory.push({
        id,
        text: bounded(op.text, MAX_MEMORY_LENGTH),
        taskId: taskId !== '' && findTask(project, taskId) !== undefined ? taskId : '',
        createdAt: Date.now(),
      })
      return null
    }
    case 'memory.patch': {
      if (project === undefined) return 'unknown_project'
      const entry = typeof op.memoryId === 'string' ? project.memory.find(candidate => candidate.id === op.memoryId) : undefined
      if (entry === undefined) return 'unknown_memory'
      if (op.text !== undefined) {
        if (typeof op.text !== 'string' || op.text.trim() === '') return 'invalid_field'
        entry.text = bounded(op.text, MAX_MEMORY_LENGTH)
      }
      if (op.taskId !== undefined) {
        if (typeof op.taskId !== 'string') return 'invalid_field'
        entry.taskId = op.taskId === '' || findTask(project, op.taskId) !== undefined ? op.taskId : ''
      }
      return null
    }
    case 'memory.remove': {
      if (project === undefined) return 'unknown_project'
      project.memory = project.memory.filter(entry => entry.id !== op.memoryId)
      return null
    }
    case 'board.import': {
      if (board.projects.length > 0) return 'import_conflict'
      const imported = normalizeBoard(op.document)
      if (imported.projects.length === 0) return 'import_empty'
      board.projects = imported.projects
      return null
    }
    default:
      return 'unknown_op'
  }
}

/**
 * Apply a batch of operations to a board.
 * @param board - source board (not mutated).
 * @param ops - operations, in client order.
 * @returns the next board plus per-operation rejections.
 */
export function applyOps(board, ops, origin) {
  const list = Array.isArray(ops) ? ops : []
  const source = asOrigin(origin)
  // An empty batch is a no-op: it must not advance the revision, or clients
  // polling an idle board would keep re-reading it.
  if (list.length === 0) return { board, rejected: [] }
  const draft = structuredClone(board)
  const rejected = []
  list.forEach((op, index) => {
    const code = applyOp(draft, op, source)
    if (code !== null) {
      rejected.push({
        index,
        opId: isRecord(op) && typeof op.opId === 'string' ? op.opId : undefined,
        type: isRecord(op) && typeof op.type === 'string' ? op.type : undefined,
        code,
      })
    }
  })
  if (rejected.length === list.length && list.length > 0) {
    // Nothing applied: keep the source board and its revision untouched.
    return { board, rejected }
  }
  draft.revision = (typeof board.revision === 'number' ? board.revision : 0) + 1
  draft.updatedAt = nowIso()
  return { board: draft, rejected }
}

/**
 * Count subtasks per status across the whole board.
 * @param board - board to measure.
 * @returns totals per status.
 */
export function boardCounts(board) {
  const totals = {}
  for (const status of TASK_STATUSES) totals[status] = 0
  for (const project of board.projects) {
    for (const task of project.tasks) totals[task.status] += 1
  }
  return totals
}
