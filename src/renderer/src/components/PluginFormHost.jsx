import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { makeFetch, pluginComponent } from '../utils/pluginUi.js'
import PluginBoundary from './PluginBoundary.jsx'

// Hosts the component a plugin ships for one of its actions. Everything the
// form does — which fields it has, what it asks its service, what it makes of
// the answer — belongs to the plugin; the app supplies the surface it sits on,
// a fetch that can actually reach the plugin's service, and somewhere to send
// the result.
export default function PluginFormHost({ task, action, onDone, onClose }) {
  const Form = pluginComponent(action.plugin, action.id)
  const dialogRef = useRef(null)
  const bodyRef = useRef(null)
  const [busy, setBusy] = useState(false)
  // The plugin's saved settings, which its form needs to know where to look and
  // who to authenticate as. Read here rather than passed down: it is the
  // plugin's own configuration, and no part of the app's state.
  const [config, setConfig] = useState(null)

  useEffect(() => {
    let cancelled = false
    window.api
      .listPlugins()
      .then(({ plugins }) => {
        if (cancelled) return
        const found = plugins.find((p) => p.name === action.plugin)
        setConfig((found && found.values) || {})
      })
      .catch(() => {
        if (!cancelled) setConfig({})
      })
    return () => {
      cancelled = true
    }
  }, [action.plugin])

  // Bound to the plugin, and stable, so a form can use it as an effect
  // dependency without re-requesting on every render.
  const fetchImpl = useMemo(() => makeFetch(action.plugin), [action.plugin])

  // Move focus into the dialog so Escape and Tab reach it rather than the card
  // underneath. Waits for the config, because the form — and so the first field
  // worth focusing — does not exist until then.
  useEffect(() => {
    if (!config) return
    // Scoped to the body: the ✕ in the header comes first in document order,
    // and landing there would put the user one stray Enter from closing a form
    // they have not filled in yet.
    const first =
      bodyRef.current &&
      bodyRef.current.querySelector('input, textarea, select, button')
    if (first) first.focus()
  }, [config])

  const done = useCallback(
    (result) => {
      onDone(result || {})
    },
    [onDone]
  )

  // A form that is mid-submit must not be dismissed out from under its own
  // request — the issue would still be created, with nothing left to report it.
  const close = useCallback(() => {
    if (busy) return
    onClose()
  }, [busy, onClose])

  return (
    <>
      <div className="plugin-form-scrim" onClick={close} />
      <section
        ref={dialogRef}
        className="plugin-form"
        role="dialog"
        aria-modal="true"
        aria-label={action.label}
        onClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => {
          if (e.key === 'Escape') {
            e.preventDefault()
            e.stopPropagation()
            close()
          }
        }}
      >
        <header className="plugin-form-header">
          <span className="plugin-form-title">{action.label}</span>
          <button
            className="icon-btn"
            title="Close"
            aria-label="Close"
            disabled={busy}
            onClick={close}
          >
            ✕
          </button>
        </header>

        <div className="plugin-form-body" ref={bodyRef}>
          {!Form && (
            <div className="plugin-form-error">
              {action.plugin} does not ship a form for this action.
            </div>
          )}
          {Form && !config && <div className="plugin-form-status">Loading…</div>}
          {Form && config && (
            <PluginBoundary label={`${action.plugin}:${action.id}`}>
              <Form
                task={task}
                config={config}
                fetch={fetchImpl}
                openExternal={(url) => window.api.openExternal(url)}
                onBusy={setBusy}
                onDone={done}
                onCancel={close}
              />
            </PluginBoundary>
          )}
        </div>
      </section>
    </>
  )
}
