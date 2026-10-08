// Plugin host.
//
// A plugin is an ordinary CommonJS node module — either `myplugin.js` or
// `myplugin/index.js` — living in one of two directories: the app's own
// `plugins/` folder (shipped with the repo) or `<userData>/plugins/` (the
// user's own). It is loaded here, in the main process, which is the only place
// with `require()` and unrestricted network access; the renderer talks to it
// over IPC.
//
// The API is entirely hooks. Three kinds:
//
//   * filters   — chained. Each enabled plugin receives the previous value and
//     returns a new one. `text:decorate` is the filter that lets a plugin
//     change how task text is rendered.
//   * events    — fire-and-forget notifications posted by the core. The return
//     value is ignored.
//   * providers — each enabled plugin is asked independently and the answers
//     are concatenated. `task:actions` is how a plugin contributes operations
//     to a task's ⋮ menu. Deliberately not a filter: a menu is not something
//     one plugin should be able to edit on another's behalf.
//
// Besides hooks, a plugin may declare `views`: tabs of its own, rendered by a
// component it ships in `views/<id>.jsx`. A view asks its plugin for data
// through the `view:query` hook — see runViewQuery.
//
// See plugins/README.md for the plugin-author-facing documentation.
import { app, net, shell } from 'electron'
import { createRequire } from 'node:module'
import { existsSync, readdirSync, statSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import {
  cacheClear,
  cacheDelete,
  cacheGet,
  cacheSet,
  getSetting,
  setSetting
} from './store.js'

// The main process is bundled to CJS, so `import.meta.url` is rewritten to
// pathToFileURL(__filename) — the one form that works today and would keep
// working if the build ever emitted ESM. Vite only applies its CommonJS
// interop under node_modules, so this require is left alone at build time and
// resolves plugin paths at runtime.
const requirePlugin = createRequire(import.meta.url)

const ENABLED_SETTING = 'plugins.enabled'
const CONFIG_SETTING = 'plugins.config'

// __dirname is <repo>/out/main under both `npm run dev` and launch.sh (both
// run `electron .` from the repo root), so this reaches the repo's plugins
// folder without depending on the working directory.
const BUILTIN_DIR = () => resolve(__dirname, '..', '..', 'plugins')
const USER_DIR = () => join(app.getPath('userData'), 'plugins')

const ALLOWED_PROTOCOLS = new Set(['https:', 'http:'])

let plugins = []
let epoch = 0
let send = () => {}

// Normalises a plugin-supplied URL, or returns null if it is not something we
// are willing to hand to the OS. Plugin code is arbitrary JavaScript and
// shell.openExternal ends up at xdg-open, so `file://` and custom schemes must
// never get through.
export function safeExternalUrl(raw) {
  if (typeof raw !== 'string' || raw.length > 2048) return null
  let url
  try {
    url = new URL(raw)
  } catch {
    return null
  }
  if (!ALLOWED_PROTOCOLS.has(url.protocol)) return null
  return url.href
}

export async function openExternal(raw) {
  const url = safeExternalUrl(raw)
  if (!url) {
    console.warn('Refused to open external URL:', raw)
    return false
  }
  await shell.openExternal(url)
  return true
}

// --- discovery -------------------------------------------------------------

// Every `foo.js` / `foo/index.js` entry in `dir`, as { name, file }.
function candidatesIn(dir) {
  if (!existsSync(dir)) return []
  let entries
  try {
    entries = readdirSync(dir)
  } catch (err) {
    console.error(`Could not read plugins directory ${dir}:`, err)
    return []
  }

  const found = []
  for (const entry of entries) {
    if (entry.startsWith('.') || entry.startsWith('_')) continue
    const full = join(dir, entry)
    try {
      if (statSync(full).isDirectory()) {
        const index = join(full, 'index.js')
        if (existsSync(index)) found.push({ name: entry, file: index })
      } else if (entry.endsWith('.js') && !entry.endsWith('.test.js')) {
        found.push({ name: entry.slice(0, -3), file: full })
      }
    } catch {
      // Unreadable entry — skip it rather than failing the whole scan.
    }
  }
  return found
}

// Forget a module (and anything it pulled in from its own folder) so a reload
// picks up edits instead of serving the cached copy.
function uncache(file) {
  let resolved
  try {
    resolved = requirePlugin.resolve(file)
  } catch {
    return
  }
  const dir = dirname(resolved) + '/'
  for (const cached of Object.keys(requirePlugin.cache)) {
    if (cached === resolved || cached.startsWith(dir)) delete requirePlugin.cache[cached]
  }
}

const MAX_VIEWS_PER_PLUGIN = 5
const VIEW_ID = /^[a-z0-9][a-z0-9-]*$/i

// The tabs a plugin declares. Each becomes a tab only if the renderer also has
// a bundled component for it, so a declaration here is a request, not a
// guarantee. The id doubles as the component's file name, hence the pattern.
function validViews(list) {
  if (!Array.isArray(list)) return []
  const out = []
  for (const item of list) {
    if (out.length >= MAX_VIEWS_PER_PLUGIN) break
    if (!item || typeof item.id !== 'string' || !VIEW_ID.test(item.id)) continue
    if (typeof item.label !== 'string' || !item.label) continue
    if (out.some((v) => v.id === item.id)) continue
    out.push({ id: item.id, label: item.label.slice(0, 40) })
  }
  return out
}

function validate(mod, fallbackName) {
  if (!mod || typeof mod !== 'object') throw new Error('module does not export an object')
  const hooks = mod.hooks
  if (!hooks || typeof hooks !== 'object') throw new Error('module exports no `hooks` object')
  const names = Object.keys(hooks).filter((h) => typeof hooks[h] === 'function')
  const views = validViews(mod.views)
  if (names.length === 0 && views.length === 0) {
    throw new Error('module registers no hooks and declares no views')
  }
  return {
    name: typeof mod.name === 'string' && mod.name ? mod.name : fallbackName,
    title: typeof mod.title === 'string' && mod.title ? mod.title : fallbackName,
    description: typeof mod.description === 'string' ? mod.description : '',
    config: Array.isArray(mod.config) ? mod.config : [],
    views,
    hooks,
    hookNames: names
  }
}

// Everything a hook is given. Plugins are deliberately handed their
// capabilities rather than being expected to require() host modules — a user
// plugin in <userData>/plugins can't resolve this app's node_modules, and that
// asymmetry must not leak into the API.
function makeContext(name, values) {
  return {
    config: values,
    cache: new Map(),
    storage: {
      get: (key) => cacheGet(name, key),
      set: (key, value, ttlMs) => cacheSet(name, key, value, ttlMs),
      delete: (key) => cacheDelete(name, key),
      clear: () => cacheClear(name)
    },
    // Electron's net.fetch rather than Node's global: it goes through
    // Chromium's stack, so system proxy settings and the OS certificate store
    // apply. That is the difference between working and not working on a
    // machine behind a corporate proxy.
    fetch: (input, init) => net.fetch(input, init),
    log: (...args) => console.log(`[plugin:${name}]`, ...args),
    // The sanctioned way for a plugin to reach the system browser. It goes
    // through the same validation as every href a decorator produces, so a
    // plugin cannot get `file://` or a custom scheme as far as xdg-open.
    openExternal: (url) => openExternal(url),
    // Tells the renderer that decorations of these texts are out of date, so a
    // hook can answer instantly from cache and refine later.
    invalidate: (texts) => {
      const list = (Array.isArray(texts) ? texts : [texts]).filter(
        (t) => typeof t === 'string' && t
      )
      if (list.length > 0) send('plugins:decoration-invalidated', list)
    }
  }
}

function loadAll() {
  const enabled = getSetting(ENABLED_SETTING) || {}
  const configs = getSetting(CONFIG_SETTING) || {}
  const seen = new Set()
  const loaded = []

  for (const [dir, source] of [
    [BUILTIN_DIR(), 'builtin'],
    [USER_DIR(), 'user']
  ]) {
    for (const { name: fallbackName, file } of candidatesIn(dir)) {
      try {
        uncache(file)
        const mod = requirePlugin(file)
        const meta = validate(mod && mod.__esModule && mod.default ? mod.default : mod, fallbackName)
        // A user plugin may deliberately shadow a built-in of the same name.
        if (seen.has(meta.name)) {
          const i = loaded.findIndex((p) => p.name === meta.name)
          if (i !== -1) loaded.splice(i, 1)
        }
        seen.add(meta.name)
        const values = configs[meta.name] || {}
        loaded.push({
          ...meta,
          file,
          source,
          values,
          // Built-ins ship disabled: a plugin that needs credentials is inert
          // and possibly noisy until the user has actually configured it.
          enabled: enabled[meta.name] === true,
          error: null,
          ctx: makeContext(meta.name, values)
        })
      } catch (err) {
        console.error(`Failed to load plugin ${file}:`, err)
        loaded.push({
          name: fallbackName,
          title: fallbackName,
          description: '',
          config: [],
          views: [],
          hooks: {},
          hookNames: [],
          file,
          source,
          values: {},
          enabled: false,
          error: String((err && err.message) || err),
          ctx: null
        })
      }
    }
  }
  return loaded
}

export function initPlugins(sender) {
  if (typeof sender === 'function') send = sender
  plugins = loadAll()
  const ok = plugins.filter((p) => !p.error)
  console.log(
    `Loaded ${ok.length} plugin(s): ${ok.map((p) => `${p.name}${p.enabled ? '' : ' (disabled)'}`).join(', ') || 'none'}`
  )
  emitEvent('app:ready', {})
}

// --- state -----------------------------------------------------------------

const active = () => plugins.filter((p) => p.enabled && !p.error)

export function listPlugins() {
  return {
    epoch,
    plugins: plugins.map((p) => ({
      name: p.name,
      title: p.title,
      description: p.description,
      config: p.config,
      views: p.views,
      hooks: p.hookNames,
      source: p.source,
      enabled: p.enabled,
      values: p.values,
      error: p.error
    }))
  }
}

function changed() {
  epoch++
  send('plugins:changed', epoch)
  return listPlugins()
}

export function setPluginEnabled(name, enabled) {
  const plugin = plugins.find((p) => p.name === name)
  if (!plugin || plugin.error) return listPlugins()
  plugin.enabled = !!enabled
  setSetting(ENABLED_SETTING, { ...(getSetting(ENABLED_SETTING) || {}), [name]: plugin.enabled })
  return changed()
}

export function setPluginConfig(name, values) {
  const plugin = plugins.find((p) => p.name === name)
  if (!plugin || plugin.error) return listPlugins()
  plugin.values = values && typeof values === 'object' ? values : {}
  // The in-memory cache may have been derived from the old settings (a
  // different JIRA site, say), so it cannot be carried over. The durable
  // store survives — its keys are expected to be scoped by whatever varies.
  plugin.ctx = makeContext(name, plugin.values)
  setSetting(CONFIG_SETTING, { ...(getSetting(CONFIG_SETTING) || {}), [name]: plugin.values })
  return changed()
}

export function reloadPlugins() {
  plugins = loadAll()
  emitEvent('app:ready', {})
  return changed()
}

// --- dispatch --------------------------------------------------------------

// Fire-and-forget notification. A throwing handler is logged and ignored: one
// bad plugin must not take the app down.
export function emitEvent(name, payload) {
  for (const plugin of active()) {
    const hook = plugin.hooks[name]
    if (typeof hook !== 'function') continue
    try {
      const result = hook(payload, plugin.ctx)
      if (result && typeof result.catch === 'function') {
        result.catch((err) => console.error(`Plugin ${plugin.name} hook ${name} failed:`, err))
      }
    } catch (err) {
      console.error(`Plugin ${plugin.name} hook ${name} failed:`, err)
    }
  }
}

function validSegments(segments, original) {
  if (!Array.isArray(segments)) return null
  const out = []
  for (const seg of segments) {
    if (!seg || typeof seg.text !== 'string') return null
    if (seg.type === 'link') {
      // A link the app would refuse to open must never render as one.
      const href = safeExternalUrl(seg.href)
      if (!href) {
        out.push({ type: 'text', text: seg.text })
        continue
      }
      out.push({
        type: 'link',
        text: seg.text,
        href,
        title: typeof seg.title === 'string' ? seg.title : undefined
      })
    } else {
      out.push({ type: 'text', text: seg.text })
    }
  }
  // Rewriting the text itself is out of scope for a decorator — it would let a
  // plugin silently misrepresent what a task says.
  if (out.map((s) => s.text).join('') !== original) return null
  return out
}

// Runs the `text:decorate` filter chain over each text. Hooks are expected to
// answer from their own cache and refine later via ctx.invalidate(), so this
// stays fast even when a plugin is backed by a network service.
export async function runTextDecorate(texts) {
  const list = Array.isArray(texts) ? texts : []
  const decorators = active().filter((p) => typeof p.hooks['text:decorate'] === 'function')

  const results = await Promise.all(
    list.map(async (text) => {
      let segments = [{ type: 'text', text }]
      if (typeof text !== 'string' || !text) return segments
      for (const plugin of decorators) {
        try {
          const next = await plugin.hooks['text:decorate'](segments, plugin.ctx)
          const checked = validSegments(next, text)
          if (checked) segments = checked
          else console.warn(`Plugin ${plugin.name} returned invalid segments; ignoring.`)
        } catch (err) {
          console.error(`Plugin ${plugin.name} hook text:decorate failed:`, err)
        }
      }
      return segments
    })
  )

  return { epoch, results }
}

// A plugin may contribute at most this many actions to one task's menu. Not a
// policy so much as a backstop: the menu is a fixed overlay, and a plugin
// returning thousands of rows would paint over the whole window.
const MAX_ACTIONS_PER_PLUGIN = 20
const MAX_LABEL_LENGTH = 120

// Keeps only what a menu row is allowed to be. A plugin's return value reaches
// the renderer and is rendered, so — as with decoration segments — it is
// normalised here rather than trusted.
function validActions(list, pluginName) {
  if (!Array.isArray(list)) return []
  const out = []
  for (const item of list) {
    // Bound the *valid* output rather than the input, so a plugin's usable
    // actions aren't crowded out by its malformed ones; stopping here also
    // bounds the work when the array is enormous.
    if (out.length >= MAX_ACTIONS_PER_PLUGIN) break
    if (!item || typeof item.id !== 'string' || !item.id) continue
    if (typeof item.label !== 'string' || !item.label) continue
    out.push({
      plugin: pluginName,
      id: item.id,
      label: item.label.slice(0, MAX_LABEL_LENGTH),
      title: typeof item.title === 'string' ? item.title.slice(0, MAX_LABEL_LENGTH) : undefined,
      disabled: item.disabled === true,
      // Picking this one opens the plugin's own form instead of running it
      // straight away. The component is looked up by plugin name and action id
      // in the renderer's bundled registry; the lookup, not this flag, decides
      // what actually renders, so a plugin claiming a form it does not ship
      // gets nothing rather than a broken dialog.
      form: item.form === true
    })
  }
  return out
}

// Collects the `task:actions` provider hook across enabled plugins. Runs when
// the user opens a task's menu, so a hook is still expected to answer from what
// it already knows rather than going to the network.
export async function runTaskActions(task) {
  const providers = active().filter((p) => typeof p.hooks['task:actions'] === 'function')
  const actions = []

  for (const plugin of providers) {
    try {
      const list = await plugin.hooks['task:actions']({ task }, plugin.ctx)
      actions.push(...validActions(list, plugin.name))
    } catch (err) {
      // One plugin's bad hook must not empty another's menu entries.
      console.error(`Plugin ${plugin.name} hook task:actions failed:`, err)
    }
  }

  return { epoch, actions }
}

// Invokes the action the user picked. Unlike `text:decorate`, this one is
// allowed to await the network — it runs on a click, not while the app is
// waiting to paint — so the renderer shows it as pending until it resolves.
export async function runTaskAction(pluginName, actionId, task) {
  const plugin = plugins.find((p) => p.name === pluginName)
  if (!plugin || plugin.error || !plugin.enabled) {
    return { ok: false, message: 'That plugin is no longer available.' }
  }
  const hook = plugin.hooks['task:action']
  if (typeof hook !== 'function') {
    return { ok: false, message: 'That plugin does not handle actions.' }
  }
  try {
    const result = await hook({ task, actionId }, plugin.ctx)
    // A hook that returns nothing succeeded; only an explicit failure fails.
    if (result && result.ok === false) {
      return { ok: false, message: String(result.message || 'The action failed.') }
    }
    return { ok: true }
  } catch (err) {
    console.error(`Plugin ${plugin.name} hook task:action failed:`, err)
    return { ok: false, message: String((err && err.message) || err) }
  }
}

// Answers a plugin view's request for data. A view runs in the renderer and
// cannot reach the plugin's `ctx.storage`, so it asks here and the plugin's
// `view:query` hook answers from the main process. What comes back must
// survive structured clone; anything that does not is reported as a failure
// rather than arriving half-formed.
export async function runViewQuery(pluginName, viewId, query) {
  const plugin = plugins.find((p) => p.name === pluginName)
  if (!plugin || plugin.error || !plugin.enabled) {
    return { ok: false, message: 'That plugin is no longer available.' }
  }
  const hook = plugin.hooks['view:query']
  if (typeof hook !== 'function') {
    return { ok: false, message: 'That plugin does not answer view queries.' }
  }
  try {
    const data = await hook({ viewId, query: query ?? null }, plugin.ctx)
    return { ok: true, data: structuredClone(data ?? null) }
  } catch (err) {
    console.error(`Plugin ${plugin.name} hook view:query failed:`, err)
    return { ok: false, message: String((err && err.message) || err) }
  }
}

// --- network for plugin UI ---------------------------------------------------

// A plugin's form runs in the renderer, where the CSP (`default-src 'self'`)
// forbids reaching anything but the app itself, and where a cross-origin call
// to a service like JIRA would be refused by CORS even if it did not. So the
// request is made here instead and the result handed back as plain data.
//
// That makes this the one place in the app where the renderer can cause an
// arbitrary outbound request, so it is deliberately narrow: a plugin only
// reaches origins it names through `ui:origins`, and a plugin that registers no
// such hook gets no network from its UI at all. The allowlist is asked for on
// every call rather than cached, so revoking it is a matter of changing the
// plugin's configuration.
const MAX_FETCH_BODY = 2 * 1024 * 1024
const MAX_REQUEST_BODY = 256 * 1024
const ALLOWED_METHODS = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD'])
// A form's request cannot carry its own AbortSignal: it is dropped in transit
// rather than refused, so a caller-supplied timeout would silently never fire.
// The timeout is applied here instead, on behalf of every plugin.
const UI_FETCH_TIMEOUT_MS = 20000

async function allowedOrigins(plugin) {
  const hook = plugin.hooks['ui:origins']
  if (typeof hook !== 'function') return []
  const list = await hook({}, plugin.ctx)
  if (!Array.isArray(list)) return []
  const out = []
  for (const entry of list) {
    // Run each through the same parser as every other plugin-supplied URL, so
    // an origin can only ever be http(s) — no `file:`, no custom scheme.
    const url = safeExternalUrl(entry)
    if (url) out.push(new URL(url).origin)
  }
  return out
}

// Only the parts of RequestInit that make sense across the boundary, and only
// in shapes that survive structured clone. Anything else is dropped rather than
// forwarded, so a plugin cannot reach for redirect/credentials behaviour the
// host has not thought about.
function validInit(init) {
  const source = init && typeof init === 'object' ? init : {}
  const method = String(source.method || 'GET').toUpperCase()
  if (!ALLOWED_METHODS.has(method)) return null

  const headers = {}
  if (source.headers && typeof source.headers === 'object') {
    for (const [key, value] of Object.entries(source.headers)) {
      if (typeof key === 'string' && typeof value === 'string') headers[key] = value
    }
  }

  // These requests go through Chromium's network stack, which otherwise fills
  // in a full Chrome User-Agent. That makes a plugin's API call look like a
  // browser session, and services defend against browsers doing exactly this:
  // JIRA's XSRF filter rejects an authenticated POST that appears to come from
  // one, with a 403 that has nothing to do with the caller's permissions. Say
  // what we actually are. A plugin that needs a different identity — an API
  // that allowlists user agents, say — can still set its own.
  if (!Object.keys(headers).some((key) => key.toLowerCase() === 'user-agent')) {
    headers['User-Agent'] = `quick-task-manager/${app.getVersion()}`
  }

  const out = { method, headers, signal: AbortSignal.timeout(UI_FETCH_TIMEOUT_MS) }
  if (typeof source.body === 'string') {
    if (source.body.length > MAX_REQUEST_BODY) return null
    out.body = source.body
  }
  return out
}

// Performs one request on behalf of a plugin's UI. Returns a description of the
// response rather than a Response — the renderer rebuilds a real one — and
// reports failure as data so a form can show it instead of crashing.
export async function runPluginFetch(pluginName, rawUrl, init) {
  const plugin = plugins.find((p) => p.name === pluginName)
  if (!plugin || plugin.error || !plugin.enabled) {
    return { ok: false, message: 'That plugin is no longer available.' }
  }

  const url = safeExternalUrl(rawUrl)
  if (!url) return { ok: false, message: 'That address is not one the app will request.' }

  let origins
  try {
    origins = await allowedOrigins(plugin)
  } catch (err) {
    console.error(`Plugin ${plugin.name} hook ui:origins failed:`, err)
    return { ok: false, message: 'The plugin could not say which addresses it may reach.' }
  }
  if (!origins.includes(new URL(url).origin)) {
    return { ok: false, message: `${plugin.name} is not configured to reach ${new URL(url).origin}.` }
  }

  const options = validInit(init)
  if (!options) return { ok: false, message: 'That request is not one the app will make.' }

  try {
    const response = await net.fetch(url, options)
    const body = await response.text()
    if (body.length > MAX_FETCH_BODY) {
      return {
        ok: false,
        message: `${options.method} ${url} answered with more than the app will read (${body.length} characters).`
      }
    }
    return {
      ok: true,
      status: response.status,
      statusText: response.statusText,
      headers: Object.fromEntries(response.headers),
      body
    }
  } catch (err) {
    // Offline, DNS failure, TLS rejection, or the timeout above. Naming the
    // request matters here more than anywhere else: nothing came back, so this
    // message is all the form has to report.
    return {
      ok: false,
      message: `${options.method} ${url} failed: ${String((err && err.message) || err)}`
    }
  }
}
