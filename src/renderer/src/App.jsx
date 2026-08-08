import { useCallback, useEffect, useRef, useState } from 'react'
import InboxView from './components/InboxView.jsx'
import PriorityView from './components/PriorityView.jsx'
import ArchiveView from './components/ArchiveView.jsx'
import PluginsView from './components/PluginsView.jsx'
import { collectTexts, invalidateAll, invalidateTexts, prime } from './utils/decorate.js'
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
  const loaded = useRef(false)
  const columnsLoaded = useRef(false)
  const tasksRef = useRef(tasks)
  const columnsRef = useRef(columns)

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
    const offChanged = window.api.onPluginsChanged((epoch) => invalidateAll(epoch))
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
      if (loaded.current) window.api.saveTasksSync(tasksRef.current)
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
              onClick={() => setView(key)}
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
          />
        )}
        {view === 'plugins' && <PluginsView />}
      </main>
    </div>
  )
}
