import { useCallback, useEffect, useState } from 'react'

// Renders one field of a plugin's config schema. The shape of a field is
// { key, label, type, placeholder?, help?, options? } — see plugins/README.md.
function ConfigField({ field, value, onChange }) {
  const id = `cfg-${field.key}`

  if (field.type === 'checkbox') {
    return (
      <label className="plugin-field plugin-field-check">
        <input
          type="checkbox"
          checked={!!value}
          onChange={(e) => onChange(e.target.checked)}
        />
        {field.label || field.key}
        {field.help && <span className="plugin-field-help">{field.help}</span>}
      </label>
    )
  }

  if (field.type === 'select') {
    return (
      <div className="plugin-field">
        <label htmlFor={id}>{field.label || field.key}</label>
        <div className="select-wrap">
          <select id={id} value={value ?? ''} onChange={(e) => onChange(e.target.value)}>
            {(field.options || []).map((opt) => (
              <option key={opt.value} value={opt.value}>
                {opt.label ?? opt.value}
              </option>
            ))}
          </select>
        </div>
        {field.help && <span className="plugin-field-help">{field.help}</span>}
      </div>
    )
  }

  const type = field.type === 'password' || field.type === 'number' ? field.type : 'text'
  return (
    <div className="plugin-field">
      <label htmlFor={id}>{field.label || field.key}</label>
      <input
        id={id}
        type={type}
        value={value ?? ''}
        placeholder={field.placeholder || ''}
        onChange={(e) => onChange(type === 'number' ? Number(e.target.value) : e.target.value)}
      />
      {field.help && <span className="plugin-field-help">{field.help}</span>}
    </div>
  )
}

function PluginCard({ plugin, onToggle, onSave }) {
  // Edits are local until saved, so a half-typed API token is never persisted
  // (and never sent to the plugin) on every keystroke.
  const [values, setValues] = useState(plugin.values || {})
  const [saved, setSaved] = useState(false)

  // A save round-trips through the store, so adopt whatever came back as the
  // new baseline. Compared by content, not identity: listPlugins() hands back
  // a fresh object every time, and merely toggling a plugin on must not throw
  // away config the user has typed but not saved yet.
  const savedValues = JSON.stringify(plugin.values || {})
  useEffect(() => {
    setValues(JSON.parse(savedValues))
  }, [savedValues])

  if (plugin.error) {
    return (
      <div className="plugin-card errored">
        <div className="plugin-head">
          <span className="plugin-title">{plugin.title}</span>
          <span className="plugin-source">{plugin.source}</span>
        </div>
        <p className="plugin-error">Failed to load: {plugin.error}</p>
      </div>
    )
  }

  return (
    <div className={`plugin-card${plugin.enabled ? ' enabled' : ''}`}>
      <div className="plugin-head">
        <label className="plugin-toggle">
          <input
            type="checkbox"
            checked={plugin.enabled}
            onChange={(e) => onToggle(plugin.name, e.target.checked)}
          />
          <span className="plugin-title">{plugin.title}</span>
        </label>
        <span className="plugin-source">{plugin.source}</span>
      </div>

      {plugin.description && <p className="plugin-desc">{plugin.description}</p>}
      {plugin.hooks.length > 0 && (
        <p className="plugin-hooks">
          Hooks: {plugin.hooks.map((h) => <code key={h}>{h}</code>).reduce((a, b) => [a, ' ', b])}
        </p>
      )}

      {plugin.config.length > 0 && (
        <div className="plugin-config">
          {plugin.config.map((field) => (
            <ConfigField
              key={field.key}
              field={field}
              value={values[field.key]}
              onChange={(v) => {
                setSaved(false)
                setValues((prev) => ({ ...prev, [field.key]: v }))
              }}
            />
          ))}
          <div className="plugin-actions">
            <button
              type="button"
              className="btn-primary"
              onClick={() => {
                onSave(plugin.name, values)
                setSaved(true)
              }}
            >
              Save
            </button>
            {saved && <span className="plugin-saved">Saved</span>}
          </div>
        </div>
      )}
    </div>
  )
}

// Lists the plugins the app found, and lets the user enable, disable and
// configure them. Plugins live in the app's own `plugins/` folder or in
// `plugins/` inside the user-data directory.
export default function PluginsView() {
  const [state, setState] = useState(null)

  useEffect(() => {
    let cancelled = false
    window.api.listPlugins().then((next) => {
      if (!cancelled) setState(next)
    })
    return () => {
      cancelled = true
    }
  }, [])

  const toggle = useCallback((name, enabled) => {
    window.api.setPluginEnabled(name, enabled).then(setState)
  }, [])

  const save = useCallback((name, values) => {
    window.api.setPluginConfig(name, values).then(setState)
  }, [])

  const reload = useCallback(() => {
    window.api.reloadPlugins().then(setState)
  }, [])

  if (!state) return <div className="view plugins-view" />

  return (
    <div className="view plugins-view">
      <div className="plugins-header">
        <div>
          <h2>Plugins</h2>
          <p className="plugins-hint">
            Add your own by dropping a <code>myplugin.js</code> or{' '}
            <code>myplugin/index.js</code> into the <code>plugins</code> folder.
          </p>
        </div>
        <button type="button" className="btn-ghost" onClick={reload}>
          Reload plugins
        </button>
      </div>

      {state.plugins.length === 0 ? (
        <p className="empty">No plugins found.</p>
      ) : (
        <div className="plugin-list">
          {state.plugins.map((plugin) => (
            <PluginCard
              key={`${plugin.source}:${plugin.name}`}
              plugin={plugin}
              onToggle={toggle}
              onSave={save}
            />
          ))}
        </div>
      )}
    </div>
  )
}
