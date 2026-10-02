// Form components contributed by plugins.
//
// A plugin action marked `form: true` renders a React component the plugin
// itself ships, in `plugins/<name>/ui/<action-id>.jsx`. The file name is the
// action id, so no registration step is needed — dropping the file in is
// enough.
//
// These are pulled into the renderer bundle at build time, which is the only
// way they can run: the renderer's CSP is `script-src 'self'` with no
// `unsafe-eval`, so component source arriving at runtime could never be
// evaluated. The consequence is that form UI is available to plugins shipped in
// the repo's `plugins/` folder and not to ones in the user-data directory,
// which can still contribute actions that run without a form. Relaxing the CSP
// to lift that restriction would weaken a protection covering the whole window,
// including text that arrives from whatever service a plugin talks to.
const modules = import.meta.glob('../../../../plugins/*/ui/*.jsx', { eager: true })

const registry = {}
for (const [path, mod] of Object.entries(modules)) {
  const match = path.match(/\/plugins\/([^/]+)\/ui\/([^/]+)\.jsx$/)
  if (!match || !mod || !mod.default) continue
  const [, plugin, actionId] = match
  if (!registry[plugin]) registry[plugin] = {}
  registry[plugin][actionId] = mod.default
}

export function pluginComponent(plugin, actionId) {
  return (registry[plugin] && registry[plugin][actionId]) || null
}

// A `fetch` for a plugin's form, bound to that plugin. The request is made in
// the main process — see runPluginFetch in src/main/plugins.js for why — and
// the reply is a plain description of the response, so a real Response is
// rebuilt here. That keeps the component writing ordinary fetch code:
// `const res = await fetch(url); if (res.ok) return res.json()`.
export function makeFetch(plugin) {
  return async function pluginFetch(url, init) {
    // Rebuilt rather than forwarded. Everything crossing to the main process is
    // structured-cloned, and the pieces of a RequestInit that are not plain
    // data are dropped in transit rather than refused — an AbortSignal, the
    // obvious thing to reach for, arrives as nothing at all, so a caller's
    // timeout would quietly never fire. Taking only what does survive keeps
    // that from looking like it worked. The request timeout is the host's.
    const source = init && typeof init === 'object' ? init : {}
    const clean = { method: source.method, headers: source.headers }
    if (typeof source.body === 'string') clean.body = source.body

    const result = await window.api.pluginFetch(plugin, String(url), clean)
    if (!result || !result.ok) {
      // Refusals and transport failures both surface the way a failed fetch
      // does, so a component has one error path rather than two. The request is
      // attached because a form reporting a failure has no other way to say
      // which call it was — nothing came back to inspect.
      const error = new Error((result && result.message) || 'The request could not be made.')
      error.request = { method: clean.method || 'GET', url: String(url) }
      throw error
    }
    // 204/205/304 are defined as having no body, and the Response constructor
    // throws rather than ignoring one.
    const bodyless = result.status === 204 || result.status === 205 || result.status === 304
    return new Response(bodyless ? null : result.body, {
      status: result.status,
      statusText: result.statusText,
      headers: result.headers
    })
  }
}
