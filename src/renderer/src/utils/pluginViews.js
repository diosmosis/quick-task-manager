// The tabs enabled plugins contribute.
//
// Same shape as pluginActions.js: module-level state plus a
// useSyncExternalStore subscription, refreshed from App when the plugin
// registry changes. A declared view only becomes a tab when the renderer has a
// bundled component for it — see pluginView in pluginUi.js.
import { pluginView } from './pluginUi.js'

const listeners = new Set()
let views = [] // [{ key, plugin, id, label, config }]

function emit() {
  for (const listener of listeners) listener()
}

export function subscribe(listener) {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function getViews() {
  return views
}

export const viewKey = (plugin, id) => `plugin:${plugin}:${id}`

export function refresh() {
  return window.api
    .listPlugins()
    .then(({ plugins }) => {
      const next = []
      for (const p of plugins) {
        if (!p.enabled || p.error) continue
        for (const v of p.views || []) {
          if (!pluginView(p.name, v.id)) continue
          next.push({
            key: viewKey(p.name, v.id),
            plugin: p.name,
            id: v.id,
            label: v.label,
            config: p.values || {}
          })
        }
      }
      views = next
      emit()
    })
    .catch(() => {
      // Leave the previous tabs in place; the next plugin change re-asks.
    })
}
