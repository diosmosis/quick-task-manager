import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react'
import InboxView from './components/InboxView.jsx'
import PriorityView from './components/PriorityView.jsx'
import ArchiveView from './components/ArchiveView.jsx'
import PluginsView from './components/PluginsView.jsx'
import NotesSheet from './components/NotesSheet.jsx'
import PluginFormHost from './components/PluginFormHost.jsx'
import { closeForm, getTarget, subscribe as subscribeForm } from './utils/actionForm.js'
import { collectTexts, invalidateAll, invalidateTexts, prime } from './utils/decorate.js'
import { refresh as refreshTaskActions } from './utils/pluginActions.js'
import {
  applyDueRecurring,
  createTask,
  createSubtask,
  createRecurrenceCopy,
  findFocusTarget,
  parseInput,
  purgeExpired
} from './utils/tasks.js'

// The column list used to live here, in localStorage. It now lives in the
// SQLite store with the tasks; this key is only read once, to carry an existing
// list over, and is then stamped as migrated so it can't be imported twice.
const LEGACY_COLUMNS_KEY = 'qtm.priorityColumns'

function takeLegacyColumns() {
  try {
    const raw = localStorage.getItem(LEGACY_COLUMNS_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw)
    if (!Array.isArray(parsed)) return null
    localStorage.setItem(`${LEGACY_COLUMNS_KEY}.migrated`, raw)
    localStorage.removeItem(LEGACY_COLUMNS_KEY)
    return parsed
  } catch {
    return null
  }
}

export default function App() {
  const [tasks, setTasks] = useState([])
  const [view, setView] = useState('inbox')
  const [now, setNow] = useState(Date.now())
  const [columns, setColumns] = useState([])
  // The task the user is currently focused on. Intentionally in-memory only —
  // it must not persist beyond a single run.
  const [focusTaskId, setFocusTaskId] = useState(null)
  // Which task's notes sheet is open, and whether it opened read-only. Which it
  // is depends on the *view*, not on the task: a task completed in the
  // Prioritize view lingers there for 15 minutes and stays editable, while the
  // same task reached through the Archive does not.
  const [notesTarget, setNotesTarget] = useState(null) // { id, readOnly } | null
  const loaded = useRef(false)
  const columnsLoaded = useRef(false)
  const tasksRef = useRef(tasks)
  const columnsRef = useRef(columns)
  // A note that has been typed but not yet committed by the sheet's debounce.
  // Held here so the close-time flush can include it — see the flush effect.
  const notesDraftRef = useRef(null)

  // Load persisted tasks once on startup and purge anything past retention.
  useEffect(() => {
    let cancelled = false
    window.api.loadTasks().then(async (stored) => {
      if (cancelled) return
      const t = Date.now()
      // Recurring tasks that came due while the app was closed are picked up here.
      const next = applyDueRecurring(purgeExpired(stored, t), t)
      // Decorate every description before the first paint, so tasks don't
      // render as plain text and then visibly gain their plugin links.
      await prime(collectTexts(next))
      if (cancelled) return
      setTasks(next)
      loaded.current = true
    })
    return () => {
      cancelled = true
    }
  }, [])

  // Plugin state changed, or a plugin finished a background lookup — either
  // way some decorations are stale and every visible description re-resolves.
  useEffect(() => {
    // Which plugins contribute task actions can change with the same event, so
    // the ⋮ menu appears or disappears live rather than waiting for a reload.
    refreshTaskActions()
    const offChanged = window.api.onPluginsChanged((epoch) => {
      invalidateAll(epoch)
      refreshTaskActions()
    })
    const offInvalidated = window.api.onDecorationInvalidated((texts) =>
      invalidateTexts(texts)
    )
    return () => {
      offChanged()
      offInvalidated()
    }
  }, [])

  // Load the persisted column list once on startup, importing the pre-SQLite
  // localStorage list the first time this version runs.
  useEffect(() => {
    let cancelled = false
    window.api.loadColumns().then((stored) => {
      if (cancelled) return
      if (Array.isArray(stored)) {
        setColumns(stored)
      } else {
        const legacy = takeLegacyColumns()
        if (legacy) setColumns(legacy)
      }
      // Only set once the load actually succeeded: a rejected load leaves this
      // false, so a failed read can never be written back over a good list.
      columnsLoaded.current = true
    })
    return () => {
      cancelled = true
    }
  }, [])

  // Keep refs to the latest state so the close-time flush can read them.
  useEffect(() => {
    tasksRef.current = tasks
  }, [tasks])

  useEffect(() => {
    columnsRef.current = columns
  }, [columns])

  // Persist tasks whenever they change (after the initial load).
  useEffect(() => {
    if (!loaded.current) return
    window.api.saveTasks(tasks)
  }, [tasks])

  // Flush synchronously when the window is closing, so a change made right
  // before quitting is never lost to an interrupted async write.
  useEffect(() => {
    const flush = () => {
      // Closing does not unmount the sheet, so a note still inside its debounce
      // window has to be folded in here rather than committed through state —
      // a setTasks now would never reach tasksRef before this write.
      const draft = notesDraftRef.current
      const list = draft
        ? tasksRef.current.map((t) => (t.id === draft.id ? { ...t, notes: draft.notes } : t))
        : tasksRef.current
      if (loaded.current) window.api.saveTasksSync(list)
      if (columnsLoaded.current) window.api.saveColumnsSync(columnsRef.current)
    }
    window.addEventListener('beforeunload', flush)
    return () => window.removeEventListener('beforeunload', flush)
  }, [])

  // Persist which tag columns are shown in the prioritization view (after the
  // initial load, so the empty starting state is never saved over a real list).
  useEffect(() => {
    if (!columnsLoaded.current) return
    window.api.saveColumns(columns)
  }, [columns])

  // Tick so time-based rules (15-min hide, 14-day purge, recurring due dates)
  // apply live.
  useEffect(() => {
    const id = setInterval(() => {
      const t = Date.now()
      setNow(t)
      setTasks((prev) => {
        const purged = purgeExpired(prev, t)
        const next = applyDueRecurring(purged, t)
        if (next !== purged) return next
        // Keep the previous array identity when nothing changed, so the tick
        // doesn't trigger a pointless re-save every 30s.
        return purged.length === prev.length ? prev : purged
      })
    }, 30 * 1000)
    return () => clearInterval(id)
  }, [])

  // Post an event hook to the plugin host. Fire-and-forget: no plugin can
  // change or block what the app does here.
  const emitPlugin = useCallback((name, id, changes) => {
    const task = tasksRef.current.find((t) => t.id === id)
    if (task) window.api.emitPluginEvent(name, { task: { ...task, ...changes } })
  }, [])

  const addTask = useCallback((text) => {
    const task = createTask(text)
    setTasks((prev) => [task, ...prev])
    window.api.emitPluginEvent('task:created', { task })
  }, [])

  const editTask = useCallback(
    (id, text) => {
      const { description, tags } = parseInput(text)
      setTasks((prev) =>
        prev.map((t) => (t.id === id ? { ...t, description, tags } : t))
      )
      emitPlugin('task:updated', id, { description, tags })
    },
    [emitPlugin]
  )

  const togglePriority = useCallback(
    (id) => {
      setTasks((prev) =>
        prev.map((t) => (t.id === id ? { ...t, prioritized: !t.prioritized } : t))
      )
      const task = tasksRef.current.find((t) => t.id === id)
      if (task) emitPlugin('task:prioritized', id, { prioritized: !task.prioritized })
    },
    [emitPlugin]
  )

  const toggleComplete = useCallback((id) => {
    const before = tasksRef.current.find((t) => t.id === id)
    if (before) {
      window.api.emitPluginEvent(
        before.completed ? 'task:uncompleted' : 'task:completed',
        { task: { ...before, completed: !before.completed } }
      )
    }
    setTasks((prev) => {
      const task = prev.find((t) => t.id === id)
      if (!task) return prev
      const now = Date.now()

      if (task.completed) {
        // Undoing a completion also withdraws the follow-up occurrence it
        // spawned — a recurring task only rolls forward once it is *finished*.
        return prev
          .filter((t) => !(t.spawnedFrom === id && !t.completed))
          .map((t) => (t.id === id ? { ...t, completed: false, completedAt: null } : t))
      }

      const done = { ...task, completed: true, completedAt: now }
      const next = prev.map((t) => (t.id === id ? done : t))
      // Finishing a recurring task schedules the next occurrence.
      return task.recurrence ? [createRecurrenceCopy(done, now), ...next] : next
    })
  }, [])

  // Enable/disable recurrence on an existing task. Enabling makes the task due
  // immediately (so it is picked up as due right away); disabling clears the
  // schedule but leaves the task itself untouched.
  const setRecurrence = useCallback((id, recurrence) => {
    const now = Date.now()
    setTasks((prev) => {
      const next = prev.map((t) => {
        if (t.id !== id) return t
        if (!recurrence) {
          return { ...t, recurrence: null, dueAt: null, autoPrioritizedFor: null }
        }
        return {
          ...t,
          recurrence,
          dueAt: t.dueAt ?? now,
          // A changed schedule is a new occurrence as far as auto-priority goes.
          autoPrioritizedFor: t.recurrence ? t.autoPrioritizedFor : null
        }
      })
      return applyDueRecurring(next, now)
    })
  }, [])

  // Free-form notes, written through the notes sheet. The sheet debounces, so
  // this runs at most every few hundred milliseconds of typing; persistence is
  // the same effect that saves every other task change.
  const setNotes = useCallback(
    (id, notes) => {
      setTasks((prev) => prev.map((t) => (t.id === id ? { ...t, notes } : t)))
      emitPlugin('task:updated', id, { notes })
    },
    [emitPlugin]
  )

  // A task's free-form status ("in progress", "blocked", …). Set from the
  // editor, cleared by emptying the field. Like notes it is a field of the task
  // rather than a re-parse of the input, so it does not go through `editTask`.
  const setStatus = useCallback(
    (id, status) => {
      setTasks((prev) => prev.map((t) => (t.id === id ? { ...t, status } : t)))
      emitPlugin('task:updated', id, { status })
    },
    [emitPlugin]
  )

  // A plugin form reporting what it made of a task — the JIRA one hands back
  // the key of the issue it created. Appended rather than merged into the
  // editor's parse: `editTask` runs its input through `parseInput`, which is
  // for text the user typed, and an id arriving from a plugin has no business
  // being read for #tags. Appending twice is guarded against because a form can
  // be opened again on a task that already carries its key.
  const appendToDescription = useCallback(
    (id, text) => {
      const addition = String(text || '').replace(/\s+/g, ' ').trim()
      if (!addition) return
      setTasks((prev) =>
        prev.map((t) => {
          if (t.id !== id) return t
          const current = t.description || ''
          if (current.split(/\s+/).includes(addition)) return t
          return { ...t, description: current ? `${current} ${addition}` : addition }
        })
      )
      const task = tasksRef.current.find((t) => t.id === id)
      if (task) {
        const current = task.description || ''
        if (!current.split(/\s+/).includes(addition)) {
          emitPlugin('task:updated', id, {
            description: current ? `${current} ${addition}` : addition
          })
        }
      }
    },
    [emitPlugin]
  )

  // Subtasks are added/removed while editing a task, never at creation time.
  const addSubtask = useCallback((taskId, text) => {
    const sub = createSubtask(text)
    if (!sub.description) return
    setTasks((prev) =>
      prev.map((t) =>
        t.id === taskId ? { ...t, subtasks: [...(t.subtasks || []), sub] } : t
      )
    )
  }, [])

  const removeSubtask = useCallback((taskId, subId) => {
    setTasks((prev) =>
      prev.map((t) =>
        t.id === taskId
          ? { ...t, subtasks: (t.subtasks || []).filter((s) => s.id !== subId) }
          : t
      )
    )
  }, [])

  const toggleSubtask = useCallback((taskId, subId) => {
    setTasks((prev) =>
      prev.map((t) =>
        t.id === taskId
          ? {
              ...t,
              subtasks: (t.subtasks || []).map((s) =>
                s.id === subId ? { ...s, completed: !s.completed } : s
              )
            }
          : t
      )
    )
  }, [])

  const addColumn = useCallback((tag) => {
    setColumns((prev) => (prev.includes(tag) ? prev : [...prev, tag]))
  }, [])

  const removeColumn = useCallback((tag) => {
    setColumns((prev) => prev.filter((t) => t !== tag))
  }, [])

  // Move the column `fromTag` so it sits at the position of `toTag`.
  const reorderColumns = useCallback((fromTag, toTag) => {
    if (fromTag === toTag) return
    setColumns((prev) => {
      const from = prev.indexOf(fromTag)
      const to = prev.indexOf(toTag)
      if (from === -1 || to === -1) return prev
      const next = [...prev]
      next.splice(from, 1)
      next.splice(to, 0, fromTag)
      return next
    })
  }, [])

  // Resolve the focused item from its id — it may be a task or a subtask; yields
  // null if it was removed / no longer present, which clears the zone.
  const focusTask = findFocusTarget(tasks, focusTaskId)

  // Same idea for the notes sheet: resolving through `tasks` means a task that
  // is purged or completed away closes the sheet instead of leaving it showing
  // a task that no longer exists.
  const notesTask = notesTarget ? tasks.find((t) => t.id === notesTarget.id) : null

  const setNotesDraft = useCallback((draft) => {
    notesDraftRef.current = draft
  }, [])

  const openNotes = useCallback((id) => setNotesTarget({ id, readOnly: false }), [])
  const openNotesReadOnly = useCallback((id) => setNotesTarget({ id, readOnly: true }), [])
  const closeNotes = useCallback(() => setNotesTarget(null), [])

  // The plugin form a ⋮ menu asked for, if any. It arrives through a module
  // store rather than a prop because the menu that requests it sits inside a
  // card — see utils/actionForm.js.
  const formTarget = useSyncExternalStore(subscribeForm, getTarget)

  // What a form hands back when it finishes. Only the task text is the app's to
  // change; anything else the plugin did, it did itself.
  const finishForm = useCallback(
    (result) => {
      if (result && result.appendToDescription && formTarget) {
        appendToDescription(formTarget.task.id, result.appendToDescription)
      }
      closeForm()
    },
    [appendToDescription, formTarget]
  )

  return (
    <div className="app">
      <header className="app-header">
        <h1>Quick Task Manager</h1>
        <nav className="tabs">
          {[
            ['inbox', 'Inbox'],
            ['priority', 'Prioritize'],
            ['archive', 'Archive'],
            ['plugins', 'Plugins']
          ].map(([key, label]) => (
            <button
              key={key}
              className={`tab${view === key ? ' active' : ''}`}
              onClick={() => {
                // The sheet belongs to a task in the view being left, and it
                // overlays whatever comes next — close it with the view. Same
                // for a plugin form, which is modal over the same ground.
                setNotesTarget(null)
                closeForm()
                setView(key)
              }}
            >
              {label}
            </button>
          ))}
        </nav>
      </header>

      <main className="app-main">
        {view === 'inbox' && (
          <InboxView
            tasks={tasks}
            onAdd={addTask}
            onEdit={editTask}
            onTogglePriority={togglePriority}
            onAddSubtask={addSubtask}
            onRemoveSubtask={removeSubtask}
            onSetRecurrence={setRecurrence}
            onSetStatus={setStatus}
            onOpenNotes={openNotes}
          />
        )}
        {view === 'priority' && (
          <PriorityView
            tasks={tasks}
            now={now}
            columns={columns}
            onAddColumn={addColumn}
            onRemoveColumn={removeColumn}
            onReorderColumns={reorderColumns}
            focusTask={focusTask}
            onSetFocus={setFocusTaskId}
            onClearFocus={() => setFocusTaskId(null)}
            onEdit={editTask}
            onTogglePriority={togglePriority}
            onToggleComplete={toggleComplete}
            onAddSubtask={addSubtask}
            onRemoveSubtask={removeSubtask}
            onToggleSubtask={toggleSubtask}
            onSetRecurrence={setRecurrence}
            onSetStatus={setStatus}
            onOpenNotes={openNotes}
          />
        )}
        {view === 'archive' && (
          <ArchiveView
            tasks={tasks}
            now={now}
            onEdit={editTask}
            onToggleComplete={toggleComplete}
            onAddSubtask={addSubtask}
            onRemoveSubtask={removeSubtask}
            onSetStatus={setStatus}
            onOpenNotes={openNotesReadOnly}
          />
        )}
        {view === 'plugins' && <PluginsView />}
      </main>

      {notesTask && (
        // Keyed on the task so opening another task's notes while the sheet is
        // already up re-seeds the draft, rather than carrying the previous
        // task's text over.
        <NotesSheet
          key={notesTask.id}
          task={notesTask}
          readOnly={notesTarget.readOnly}
          onChange={setNotes}
          onDraft={setNotesDraft}
          onClose={closeNotes}
        />
      )}

      {formTarget && (
        <PluginFormHost
          key={`${formTarget.action.plugin}:${formTarget.action.id}:${formTarget.task.id}`}
          task={formTarget.task}
          action={formTarget.action}
          onDone={finishForm}
          onClose={closeForm}
        />
      )}
    </div>
  )
}
