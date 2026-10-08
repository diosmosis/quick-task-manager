import { useCallback } from 'react'
import { pluginView } from '../utils/pluginUi.js'
import PluginBoundary from './PluginBoundary.jsx'

// Hosts a tab a plugin contributes. The view sees the task list read-only —
// it has no callbacks to change it — and reaches its own plugin's data through
// `query`, which runs the plugin's `view:query` hook in the main process.
export default function PluginViewHost({ view, tasks, now }) {
  const View = pluginView(view.plugin, view.id)

  // Stable per view, so a component can use it as an effect dependency.
  const query = useCallback(
    async (payload) => {
      const result = await window.api.pluginViewQuery(view.plugin, view.id, payload)
      if (!result || !result.ok) {
        throw new Error((result && result.message) || 'The plugin did not answer.')
      }
      return result.data
    },
    [view.plugin, view.id]
  )

  return (
    <div className="view plugin-view">
      {View ? (
        <PluginBoundary label={view.key}>
          <View
            tasks={tasks}
            now={now}
            config={view.config}
            query={query}
            openExternal={(url) => window.api.openExternal(url)}
          />
        </PluginBoundary>
      ) : (
        <div className="plugin-form-error">{view.plugin} does not ship this view.</div>
      )}
    </div>
  )
}
