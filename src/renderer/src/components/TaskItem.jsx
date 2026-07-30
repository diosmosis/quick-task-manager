import { useState } from 'react'
import TaskInput from './TaskInput.jsx'
import {
  RECURRENCE_UNITS,
  describeRecurrence,
  formatDueRelative,
  isDue,
  taskToInput,
  tagColor
} from '../utils/tasks.js'

// Inline editor for a task's subtasks, shown only while the parent task is being
// edited. Subtasks are plain descriptions — they cannot be tagged or prioritized.
function SubtaskEditor({ subtasks, onAddSubtask, onRemoveSubtask }) {
  const [value, setValue] = useState('')

  function add() {
    const trimmed = value.trim()
    if (!trimmed) return
    onAddSubtask(trimmed)
    setValue('')
  }

  return (
    <div className="subtask-editor">
      <span className="subtask-editor-label">Subtasks</span>
      {subtasks.length > 0 && (
        <ul className="subtask-edit-list">
          {subtasks.map((s) => (
            <li key={s.id}>
              <span className="subtask-edit-desc">{s.description}</span>
              <button
                type="button"
                className="icon-btn"
                title="Remove subtask"
                aria-label="Remove subtask"
                onClick={() => onRemoveSubtask(s.id)}
              >
                ✕
              </button>
            </li>
          ))}
        </ul>
      )}
      <div className="subtask-add">
        <input
          type="text"
          value={value}
          placeholder="Add a subtask…"
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault()
              add()
            }
          }}
        />
        <button type="button" className="btn-ghost" onClick={add}>
          Add
        </button>
      </div>
    </div>
  )
}

// Schedules a task to recur every N days/weeks/months. Like the subtask editor,
// it is only reachable while editing an existing task.
function RecurrenceEditor({ task, onSetRecurrence }) {
  const [every, setEvery] = useState(task.recurrence?.every ?? 1)
  const [unit, setUnit] = useState(task.recurrence?.unit ?? 'week')
  const on = !!task.recurrence

  function apply(enabled, nextEvery, nextUnit) {
    const n = Math.max(1, Math.round(Number(nextEvery) || 1))
    onSetRecurrence(enabled ? { every: n, unit: nextUnit } : null)
  }

  return (
    <div className="recur-editor">
      <span className="subtask-editor-label">Recurring</span>
      <div className="recur-row">
        <label className="recur-toggle">
          <input
            type="checkbox"
            checked={on}
            onChange={(e) => apply(e.target.checked, every, unit)}
          />
          Repeat every
        </label>
        <input
          type="number"
          min="1"
          className="recur-every"
          value={every}
          disabled={!on}
          onChange={(e) => {
            setEvery(e.target.value)
            if (on) apply(true, e.target.value, unit)
          }}
        />
        <div className="select-wrap">
          <select
            value={unit}
            disabled={!on}
            onChange={(e) => {
              setUnit(e.target.value)
              if (on) apply(true, every, e.target.value)
            }}
          >
            {RECURRENCE_UNITS.map((u) => (
              <option key={u.value} value={u.value}>
                {u.label}
              </option>
            ))}
          </select>
        </div>
      </div>
      {on && task.dueAt != null && (
        <span className="recur-next">
          {formatDueRelative(task.dueAt, Date.now())} · the next occurrence is created
          when this one is completed
        </span>
      )}
    </div>
  )
}

// Displays a single task. Clicking the body switches to an inline edit input.
// `actions` are rendered as compact icon buttons on the right, and are
// context-specific (priority toggle, complete, de-prioritize, …).
export default function TaskItem({
  task,
  onEdit,
  actions = [],
  children,
  draggable = false,
  onDragStart,
  onAddSubtask,
  onRemoveSubtask,
  onToggleSubtask,
  onSubtaskDragStart,
  onSetRecurrence,
  focused = false,
  focusedSubtaskId = null
}) {
  const [editing, setEditing] = useState(false)
  const subtasks = task.subtasks || []
  const canEditSubtasks = onAddSubtask && onRemoveSubtask
  const now = Date.now()
  const due = isDue(task, now)
  // When a subtask of this task is the focused item, the card itself is also
  // marked (subtly) so it can be spotted in the column at a glance.
  const hasFocusedSubtask = subtasks.some((s) => s.id === focusedSubtaskId)

  if (editing) {
    return (
      <li className="task-item editing">
        <TaskInput
          initialValue={taskToInput(task)}
          submitLabel="Save"
          autoFocus
          onSubmit={(text) => {
            onEdit(text)
            setEditing(false)
          }}
          onCancel={() => setEditing(false)}
        />
        {canEditSubtasks && (
          <SubtaskEditor
            subtasks={subtasks}
            onAddSubtask={onAddSubtask}
            onRemoveSubtask={onRemoveSubtask}
          />
        )}
        {onSetRecurrence && (
          <RecurrenceEditor task={task} onSetRecurrence={onSetRecurrence} />
        )}
      </li>
    )
  }

  return (
    <li
      className={`task-item${task.completed ? ' completed' : ''}${draggable ? ' draggable' : ''}${due ? ' due' : ''}${focused ? ' focused' : ''}${hasFocusedSubtask ? ' has-focused-subtask' : ''}`}
      draggable={draggable}
      onDragStart={draggable ? onDragStart : undefined}
    >
      <div className="task-row">
        {/* Outside .task-body, whose contents wrap — the marker belongs on the
            card's leading edge, not on a line of its own. */}
        {focused && (
          <span className="focus-marker" title="You are working on this">
            🎯
          </span>
        )}
        <div
          className="task-body"
          title="Click to edit"
          onClick={() => setEditing(true)}
        >
          <span className="task-desc">{task.description || '(no description)'}</span>
          {task.tags.length > 0 && (
            <span className="task-tags">
              {task.tags.map((tag) => {
                const c = tagColor(tag)
                return (
                  <span
                    key={tag}
                    className="tag-chip"
                    style={{ backgroundColor: c.bg, color: c.fg, borderColor: c.border }}
                  >
                    #{tag}
                  </span>
                )
              })}
            </span>
          )}
          {task.recurrence && (
            <span
              className={`recur-chip${due ? ' due' : ''}`}
              title={`Repeats ${describeRecurrence(task.recurrence)}`}
            >
              {due ? '⏰' : '🔁'} {describeRecurrence(task.recurrence)}
              {task.dueAt != null && ` · ${formatDueRelative(task.dueAt, now)}`}
            </span>
          )}
          {children && <div className="task-meta">{children}</div>}
        </div>
        <div className="task-actions">
          {actions.map((action) => (
            <button
              key={action.key}
              className={`icon-btn${action.active ? ' active' : ''}`}
              title={action.title}
              aria-label={action.title}
              onClick={(e) => {
                e.stopPropagation()
                action.onClick()
              }}
            >
              {action.icon}
            </button>
          ))}
        </div>
      </div>

      {subtasks.length > 0 && (
        <ul className="subtask-list">
          {subtasks.map((s) => (
            <li
              key={s.id}
              className={
                'subtask-item' +
                (s.completed ? ' completed' : '') +
                (onSubtaskDragStart ? ' draggable' : '') +
                (s.id === focusedSubtaskId ? ' focused' : '')
              }
              draggable={onSubtaskDragStart ? true : undefined}
              onDragStart={
                onSubtaskDragStart
                  ? (e) => {
                      // Prevent the drag from bubbling to the parent task-item's
                      // onDragStart, which would overwrite the payload with the
                      // parent's id and focus the parent instead of the subtask.
                      e.stopPropagation()
                      onSubtaskDragStart(s.id, e)
                    }
                  : undefined
              }
            >
              {onToggleSubtask && (
                <button
                  className={`icon-btn subtask-check${s.completed ? ' active' : ''}`}
                  title={s.completed ? 'Mark not completed' : 'Mark completed'}
                  aria-label={s.completed ? 'Mark not completed' : 'Mark completed'}
                  onClick={() => onToggleSubtask(s.id)}
                >
                  {s.completed ? '☑' : '☐'}
                </button>
              )}
              {s.id === focusedSubtaskId && (
                <span className="focus-marker" title="You are working on this">
                  🎯
                </span>
              )}
              <span className="subtask-desc">{s.description}</span>
            </li>
          ))}
        </ul>
      )}
    </li>
  )
}
