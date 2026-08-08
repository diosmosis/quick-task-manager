// Plugin host.
//
// A plugin is an ordinary CommonJS node module — either `myplugin.js` or
// `myplugin/index.js` — living in one of two directories: the app's own
// `plugins/` folder (shipped with the repo) or `<userData>/plugins/` (the
// user's own). It is loaded here, in the main process, which is the only place
// with `require()` and unrestricted network access; the renderer talks to it
// over IPC.
//
// The API is entirely hooks. Two kinds:
//
//   * filters — chained. Each enabled plugin receives the previous value and
//     returns a new one. `text:decorate` is the filter that lets a plugin
//     change how task text is rendered.
//   * events  — fire-and-forget notifications posted by the core. The return
//     value is ignored.
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

function validate(mod, fallbackName) {
  if (!mod || typeof mod !== 'object') throw new Error('module does not export an object')
  const hooks = mod.hooks
  if (!hooks || typeof hooks !== 'object') throw new Error('module exports no `hooks` object')
  const names = Object.keys(hooks).filter((h) => typeof hooks[h] === 'function')
  if (names.length === 0) throw new Error('module registers no hooks')
  return {
    name: typeof mod.name === 'string' && mod.name ? mod.name : fallbackName,
    title: typeof mod.title === 'string' && mod.title ? mod.title : fallbackName,
    description: typeof mod.description === 'string' ? mod.description : '',
    config: Array.isArray(mod.config) ? mod.config : [],
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
