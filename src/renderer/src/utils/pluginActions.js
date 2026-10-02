// Whether any enabled plugin contributes task actions.
//
// The ⋮ menu button must not appear on every card when nothing would go in it,
// but asking the main process per card per render would be one IPC call per
// task. So the *availability* of actions is answered once here and shared by
// every card, and the actions themselves are fetched only when a menu opens.
//
// Same shape as decorate.js: module-level state plus a useSyncExternalStore
// subscription, refreshed from App when the plugin registry changes.

const listeners = new Set()
let available = false

function emit() {
  for (const listener of listeners) listener()
}

export function subscribe(listener) {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function isAvailable() {
  return available
}

// Re-derive from the plugin registry. `hooks` is the list of hook names a
// plugin registered, so this needs no separate main-process query.
export function refresh() {
  return window.api
    .listPlugins()
    .then(({ plugins }) => {
      const next = plugins.some(
        (p) => p.enabled && !p.error && (p.hooks || []).includes('task:actions')
      )
      if (next === available) return
      available = next
      emit()
    })
    .catch(() => {
      // Leave the previous answer in place; the next plugin change re-asks.
    })
}
