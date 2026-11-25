/**
 * Project board — Host half.
 *
 * Owns the authoritative board document, serves it to the Web panel over
 * loopback HTTP routes, and registers the model-facing `greenlight_*` tools.
 * The browser half only renders what this half returns.
 *
 * Config (all optional, set on the bundle row in `cordis.patch.yml`):
 *   boardFile  absolute path of the board document
 *   enabled    false leaves the browser half in its local-only mode
 */
import { homedir } from 'node:os'
import { join } from 'node:path'
import { archivePathFor, createArchiver } from './host/archive.js'
import { createStore } from './host/store.js'
import { createBoardRoutes } from './host/routes.js'
import { createBoardTools } from './host/tools.js'

/** Plugin name shown in Cordis diagnostics. */
export const name = 'greenlight'

/**
 * `webServer` is required for the panel to sync. The tool registry is obtained
 * through `ctx.inject` so a profile without it still mounts the board.
 */
export const inject = ['webServer']

/** Registration outcome reported by `/greenlight/diagnostics`. */
const toolState = { registered: [], errors: [], serviceMissing: false }

/**
 * Resolve the board document path.
 * @param config - plugin config.
 * @returns the absolute document path.
 */
function resolveBoardFile(config) {
  if (config !== null && config !== undefined && typeof config.boardFile === 'string' && config.boardFile !== '') {
    return config.boardFile
  }
  const home = typeof process.env.DSH_HOME === 'string' && process.env.DSH_HOME !== ''
    ? process.env.DSH_HOME
    : join(homedir(), '.dsh')
  return join(home, 'greenlight', 'board.json')
}

/**
 * Mount the board Host surface.
 * @param ctx - Host plugin context.
 * @param config - bundle row config.
 */
export function apply(ctx, config) {
  if (config !== null && config !== undefined && config.enabled === false) return

  const boardFile = resolveBoardFile(config)
  const store = createStore(boardFile)
  const archiver = createArchiver(archivePathFor(boardFile))
  const routes = createBoardRoutes(store, { archiver })

  // Diagnostics describe the mount being created now, not an earlier one.
  toolState.registered.length = 0
  toolState.errors.length = 0
  toolState.serviceMissing = false

  // Diagnostics: tells a caller what this half actually mounted, without logs.
  routes.push({
    kind: 'exact',
    path: '/greenlight/diagnostics',
    async resource() {
      await store.init()
      return new Response(JSON.stringify({
        ok: true,
        plugin: name,
        boardFile,
        revision: store.snapshot().revision,
        projects: store.snapshot().projects.length,
        recovered: store.wasRecovered(),
        tools: {
          registered: toolState.registered,
          errors: toolState.errors,
          serviceMissing: toolState.serviceMissing,
        },
      }), { status: 200, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' } })
    },
  })

  ctx.effect(() => {
    const disposers = []
    try {
      for (const route of routes) {
        const dispose = ctx.webServer.register(route)
        if (typeof dispose === 'function') disposers.push(dispose)
      }
    } catch (error) {
      // A duplicate route belongs to another plugin; the board degrades to its
      // local-only mode instead of failing the whole profile.
      console.warn('greenlight: route registration failed: ' + String(error && error.message ? error.message : error))
    }
    return () => {
      for (const dispose of disposers) {
        try {
          dispose()
        } catch (error) {
          /* the server may already be gone */
        }
      }
    }
  }, 'greenlight: http routes')

  const mountTools = (registry) => {
    if (registry === undefined || registry === null || typeof registry.register !== 'function') {
      toolState.serviceMissing = true
      return undefined
    }
    const disposers = []
    for (const definition of createBoardTools(store, { archiver })) {
      try {
        const dispose = registry.register(definition)
        toolState.registered.push(definition.name)
        if (typeof dispose === 'function') disposers.push(dispose)
      } catch (error) {
        toolState.errors.push({
          name: definition.name,
          message: String(error && error.message ? error.message : error),
        })
        console.warn('greenlight: tool registration failed for ' + definition.name + ': ' + String(error && error.message ? error.message : error))
      }
    }
    return () => {
      for (const dispose of disposers) {
        try {
          dispose()
        } catch (error) {
          /* the registry may already be gone */
        }
      }
    }
  }

  if (typeof ctx.inject === 'function') {
    // Canonical optional-service wiring: the callback is a plugin body whose
    // child context has `tools` injected, and it re-runs if that service changes.
    ctx.inject(['tools'], (child) => {
      const registry = child.tools !== undefined
        ? child.tools
        : (typeof child.get === 'function' ? child.get('tools') : undefined)
      child.effect(() => mountTools(registry), 'greenlight: tools')
    })
  } else {
    const fallback = typeof ctx.get === 'function' ? ctx.get('tools') : undefined
    ctx.effect(() => mountTools(fallback), 'greenlight: tools')
  }
}

/** Kept for the diagnostics route: registration outcome of the last mount. */
export function diagnostics() {
  return {
    registered: toolState.registered.slice(),
    errors: toolState.errors.slice(),
    serviceMissing: toolState.serviceMissing,
  }
}