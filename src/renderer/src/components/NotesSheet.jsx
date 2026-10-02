import { useEffect, useRef, useState } from 'react'
import RichText from './RichText.jsx'

// How long typing has to stop before the note is committed to the task list.
// Long enough that a burst of typing is one write, short enough that the
// "Saved" line settles while the user is still looking at it.
const SAVE_DELAY = 400

// Free-form notes for a single task, shown in a sheet pinned to the bottom of
// the window. It lives here rather than on the task card because a card is
// rendered in a 300px Prioritize column and in a dense Inbox list, where a
// permanent multi-line input would dominate everything else.
//
// Two modes, which is what lets plugin links coexist with a plain textarea:
// read mode renders the note through `RichText` (so a JIRA id is clickable),
// and clicking it swaps in the raw textarea.
//
// There is no Save button. Edits commit on a debounce and are flushed on close,
// matching the subtask and recurrence editors, which also commit immediately.
export default function NotesSheet({ task, readOnly = false, onChange, onDraft, onClose }) {
  const stored = task.notes || ''
  const [value, setValue] = useState(stored)
  // An empty note is opened straight into the textarea — there is nothing to
  // read, and the only reason to open it is to write.
  const [editing, setEditing] = useState(!readOnly && !stored)
  const dirty = !readOnly && value !== stored
  const flush = useRef(() => {})

  // Commit after typing stops. Re-running on `stored` is what settles the
  // status line: once App has the new value the guard above goes false.
  useEffect(() => {
    if (!dirty) return undefined
    const id = setTimeout(() => onChange(task.id, value), SAVE_DELAY)
    return () => clearTimeout(id)
  }, [dirty, value, task.id, onChange])

  // Report the uncommitted draft upward. The window's close-time flush writes
  // the task list synchronously from a ref, so without this a note typed in the
  // last few hundred milliseconds before quitting would be lost — App applies
  // the draft to the list it saves.
  useEffect(() => {
    onDraft(dirty ? { id: task.id, notes: value } : null)
  }, [dirty, value, task.id, onDraft])

  // Kept current on every render so the unmount cleanup below sees the latest
  // draft rather than the one captured on mount.
  useEffect(() => {
    flush.current = () => {
      if (dirty) onChange(task.id, value)
      onDraft(null)
    }
  })

  useEffect(() => () => flush.current(), [])

  function handleKeyDown(e) {
    // Everything is already saved, so there is nothing to cancel — both
    // shortcuts just dismiss.
    if (e.key === 'Escape' || (e.key === 'Enter' && (e.metaKey || e.ctrlKey))) {
      e.preventDefault()
      e.stopPropagation()
      onClose()
    }
  }

  return (
    <>
      <div className="notes-scrim" onClick={onClose} />
      <section
        className="notes-sheet"
        role="dialog"
        aria-label="Task notes"
        onKeyDown={handleKeyDown}
      >
        <header className="notes-header">
          <span className="notes-title">
            Notes — <span className="notes-title-task">{task.description || '(no description)'}</span>
          </span>
          <button className="icon-btn" title="Close" aria-label="Close notes" onClick={onClose}>
            ✕
          </button>
        </header>

        <div className="notes-content">
          {editing ? (
            <textarea
              className="notes-input"
              autoFocus
              value={value}
              placeholder="Anything worth remembering about this task…"
              onChange={(e) => setValue(e.target.value)}
              // Leaving the field returns to read mode, so plugin links come
              // back as soon as you stop typing.
              onBlur={() => setEditing(false)}
            />
          ) : (
            <div
              className={`notes-read${readOnly ? '' : ' editable'}`}
              role={readOnly ? undefined : 'button'}
              tabIndex={readOnly ? undefined : 0}
              title={readOnly ? undefined : 'Click to edit'}
              onClick={readOnly ? undefined : () => setEditing(true)}
              onKeyDown={
                readOnly
                  ? undefined
                  : (e) => {
                      if (e.key === 'Enter') {
                        e.preventDefault()
                        setEditing(true)
                      }
                    }
              }
            >
              <RichText
                className={`notes-body${value ? '' : ' placeholder'}`}
                text={value}
                fallback={readOnly ? 'No notes.' : 'No notes yet — click to write one.'}
              />
            </div>
          )}
        </div>

        <footer className="notes-footer">
          <span>{readOnly ? 'Read-only — archived task' : dirty ? 'Saving…' : 'Saved'}</span>
          <span className="notes-hint">Esc to close</span>
        </footer>
      </section>
    </>
  )
}
