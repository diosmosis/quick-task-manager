import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { createPortal } from 'react-dom'
import { openForm } from '../utils/actionForm.js'
import { isAvailable, subscribe } from '../utils/pluginActions.js'

// Roughly what the menu is allowed to grow to, used to decide whether it opens
// downward or upward. The real height is capped in CSS.
const MAX_HEIGHT = 280
const MIN_HEIGHT = 140

// The ⋮ menu on a task card: the app's own operations on the task, followed by
// any a plugin contributes (`task:actions`). The plugin section is fetched only
// when the menu opens, and only when some enabled plugin provides one — a user
// with no plugins pays no IPC for opening it.
//
// The menu is `position: fixed` and portalled to <body>. A card in the
// Prioritize view sits inside four nested clipping boxes — `.column-body`,
// `.column` (overflow: hidden), `.columns` and `.priority-view` — so an
// absolutely-positioned menu would be cut off. Being fixed escapes those, but
// not a stacking context: a completed card has `opacity: 0.5`, which traps the
// menu's z-index inside that card, so the cards after it were painted on top
// (and the menu itself came out half-transparent). The portal takes it out of
// the card entirely.
export default function TaskMenu({ task, onEditRequest }) {
  const available = useSyncExternalStore(subscribe, isAvailable)
  const [open, setOpen] = useState(false)
  const [place, setPlace] = useState(null)
  const [actions, setActions] = useState(null)
  const [busy, setBusy] = useState(null)
  const [error, setError] = useState(null)
  const buttonRef = useRef(null)
  const menuRef = useRef(null)

  const close = useCallback(() => {
    setOpen(false)
    setPlace(null)
    setActions(null)
    setBusy(null)
    setError(null)
  }, [])

  // A fixed menu does not travel with the card, so scrolling or resizing must
  // dismiss it rather than leave it pointing at nothing. Capture phase, because
  // the scrollers are inner elements and their scroll events do not bubble.
  useEffect(() => {
    if (!open) return undefined
    window.addEventListener('scroll', close, true)
    window.addEventListener('resize', close)
    return () => {
      window.removeEventListener('scroll', close, true)
      window.removeEventListener('resize', close)
    }
  }, [open, close])

  // Move focus into the menu once its rows exist, so Escape and Tab behave. The
  // app's own rows are there immediately, so this does not wait on the plugin
  // fetch; it runs again when that lands, which lands on the same first row.
  useEffect(() => {
    if (!open) return
    const first = menuRef.current && menuRef.current.querySelector('button:not(:disabled)')
    if (first) first.focus()
  }, [open, actions])

  function toggle(e) {
    e.stopPropagation()
    if (open) {
      close()
      return
    }
    const rect = buttonRef.current.getBoundingClientRect()
    const below = window.innerHeight - rect.bottom - 8
    // Flip above the button only when there genuinely isn't room below and
    // there is more room above.
    const flip = below < MIN_HEIGHT && rect.top > below
    setPlace({
      right: Math.max(8, window.innerWidth - rect.right),
      top: flip ? undefined : rect.bottom + 4,
      bottom: flip ? window.innerHeight - rect.top + 4 : undefined,
      maxHeight: Math.min(MAX_HEIGHT, Math.max(MIN_HEIGHT, flip ? rect.top - 12 : below))
    })
    setOpen(true)
    setActions(null)
    setError(null)
    // Nothing to ask for when no enabled plugin contributes actions: the menu
    // is then just the app's own entries.
    if (!available) {
      setActions([])
      return
    }
    window.api
      .listTaskActions(task)
      .then((result) => setActions(result.actions || []))
      .catch(() => setActions([]))
  }

  async function run(action) {
    // An action that carries its own form doesn't run from here at all: the
    // dialog collects what it needs first, and does the work when the user
    // commits. It is hosted at the top of the app rather than inside the menu,
    // which this click is about to close.
    if (action.form) {
      close()
      openForm(task, action)
      return
    }

    setBusy(action.id)
    setError(null)
    let result
    try {
      result = await window.api.runTaskAction(action.plugin, action.id, task)
    } catch (err) {
      result = { ok: false, message: String((err && err.message) || err) }
    }
    if (result && result.ok) {
      close()
      return
    }
    // Keep the menu up on failure — an action that silently does nothing
    // leaves the user with no idea whether it ran.
    setBusy(null)
    setError((result && result.message) || 'The action failed.')
  }

  // The app's own operations on the task. They are listed first and are always
  // present, which is why the button no longer depends on a plugin existing.
  const coreActions = onEditRequest
    ? [
        {
          key: 'edit',
          label: 'Edit task…',
          title: 'Edit the description, tags, status, subtasks and schedule',
          onClick: () => {
            close()
            onEditRequest()
          }
        }
      ]
    : []

  if (coreActions.length === 0 && !available) return null

  return (
    <>
      <button
        ref={buttonRef}
        className={`icon-btn task-menu-btn${open ? ' open' : ''}`}
        title="More actions"
        aria-label="More actions"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={toggle}
      >
        {/* A vertical kebab, not a hamburger: the notes button beside it is
            already three horizontal lines and the two would be a coin toss. */}
        <svg
          width="15"
          height="15"
          viewBox="0 0 24 24"
          fill="currentColor"
          stroke="none"
          aria-hidden="true"
        >
          <circle cx="12" cy="5" r="1.9" />
          <circle cx="12" cy="12" r="1.9" />
          <circle cx="12" cy="19" r="1.9" />
        </svg>
      </button>

      {open &&
        place &&
        createPortal(
          <>
            <div className="task-menu-backdrop" onClick={(e) => { e.stopPropagation(); close() }} />
            <div
              ref={menuRef}
              className="task-menu"
              role="menu"
              style={place}
              onClick={(e) => e.stopPropagation()}
              onKeyDown={(e) => {
                if (e.key === 'Escape') {
                  e.preventDefault()
                  e.stopPropagation()
                  close()
                  if (buttonRef.current) buttonRef.current.focus()
                }
              }}
            >
              {coreActions.map((action) => (
                <button
                  key={action.key}
                  type="button"
                  role="menuitem"
                  className="task-menu-item"
                  title={action.title}
                  disabled={busy !== null}
                  onClick={action.onClick}
                >
                  {action.label}
                </button>
              ))}

              {/* The plugin section, separated so it is clear which entries are
                  the app's and which an extension put there. Only drawn when a
                  plugin is actually contributing — with none enabled the menu is
                  just the app's own rows, with nothing to explain. */}
              {available && (
                <>
                  {coreActions.length > 0 && <div className="task-menu-sep" role="separator" />}
                  {!actions && <div className="task-menu-empty">Loading…</div>}
                  {actions && actions.length === 0 && (
                    <div className="task-menu-empty">No plugin actions for this task.</div>
                  )}
                  {actions &&
                    actions.map((action) => (
                      <button
                        key={`${action.plugin}:${action.id}`}
                        type="button"
                        role="menuitem"
                        className="task-menu-item"
                        title={action.title || undefined}
                        disabled={action.disabled || busy !== null}
                        onClick={() => run(action)}
                      >
                        {busy === action.id ? `${action.label} …` : action.label}
                      </button>
                    ))}
                </>
              )}
              {error && <div className="task-menu-error">{error}</div>}
            </div>
          </>,
          document.body
        )}
    </>
  )
}
