import { useCallback, useEffect, useId, useRef, useState } from 'react'
import TaskInput from './TaskInput.jsx'
import RichText from './RichText.jsx'
import TaskMenu from './TaskMenu.jsx'
import StatusChip from './StatusChip.jsx'
import {
  RECURRENCE_UNITS,
  describeRecurrence,
  formatDueRelative,
  isDue,
  taskToInput,
  tagColor
} from '../utils/tasks.js'

// The task's free-form status, edited alongside its description. Committed on
// blur and on Enter rather than on every keystroke: the recurrence editor can
// commit per change because it is a checkbox and a number, but a text field
// would put a full store write behind every letter. Clearing the field clears
// the status.
//
// `known` are the statuses already in use elsewhere, offered as completions —
// color-coding only says anything if the same wording comes back.
function StatusEditor({ task, known = [], onSetStatus }) {
  const [value, setValue] = useState(task.status || '')
  const listId = useId()

  const commit = useCallback(
    (text, current, set) => {
      const next = text.replace(/\s+/g, ' ').trim()
      if (next !== (current || '')) set(next)
    },
    []
  )

  // Leaving edit mode does not blur the field — the description input's Enter
  // key and the Cancel button both unmount this editor from under it — so the
  // draft is committed on the way out as well, or a status typed and then
  // saved from the other input would be silently dropped. Read through a ref:
  // the cleanup runs once, long after this render's closure went stale. The ref
  // is written from an effect rather than during render so only renders that
  // were actually committed reach it.
  const latest = useRef({ value, status: task.status, onSetStatus })
  useEffect(() => {
    latest.current = { value, status: task.status, onSetStatus }
  })
  useEffect(
    () => () => {
      const { value: v, status, onSetStatus: set } = latest.current
      commit(v, status, set)
    },
    [commit]
  )

  return (
    <div className="status-editor">
      <span className="subtask-editor-label">Status</span>
      <input
        type="text"
        className="status-input"
        value={value}
        list={known.length > 0 ? listId : undefined}
        placeholder="e.g. in progress, blocked, waiting on review…"
        onChange={(e) => setValue(e.target.value)}
        onBlur={() => commit(value, task.status, onSetStatus)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault()
            commit(value, task.status, onSetStatus)
          }
        }}
      />
      {known.length > 0 && (
        <datalist id={listId}>
          {known.map((s) => (
            <option key={s} value={s} />
          ))}
        </datalist>
      )}
    </div>
  )
}

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
  onSetStatus,
  knownStatuses = [],
  onOpenNotes,
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
        {onSetStatus && (
          <StatusEditor task={task} known={knownStatuses} onSetStatus={onSetStatus} />
        )}
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
          <RichText
            className="task-desc"
            text={task.description}
            fallback="(no description)"
          />
          {/* Before the tags: the status is about this task's progress, so it
              belongs next to what the task says, ahead of its categories. */}
          <StatusChip status={task.status} />
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
          {/* Rendered here rather than as another entry in each view's
              `actions` array so the icon and the has-notes indicator are
              defined once instead of in all three views. */}
          {onOpenNotes && (
            <button
              className={`icon-btn notes-btn${task.notes ? ' has-notes' : ''}`}
              title={task.notes ? 'Notes' : 'Add notes'}
              aria-label={task.notes ? 'Notes' : 'Add notes'}
              onClick={(e) => {
                e.stopPropagation()
                onOpenNotes(task.id)
              }}
            >
              {/* An SVG rather than an emoji: change #10 records that the
                  system font rendered the de-prioritize glyph badly enough to
                  misread. Lines of text, shortest last, so it reads as a note
                  and not as a menu. */}
              <svg
                width="15"
                height="15"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2.2"
                strokeLinecap="round"
                aria-hidden="true"
              >
                <line x1="4.5" y1="6.5" x2="19.5" y2="6.5" />
                <line x1="4.5" y1="12" x2="19.5" y2="12" />
                <line x1="4.5" y1="17.5" x2="13" y2="17.5" />
              </svg>
            </button>
          )}
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
          {/* Core and plugin-contributed operations, last in the row as an
              overflow menu conventionally is. "Edit task" lives here because a
              card whose description fills its width leaves almost nothing of
              `.task-body` free to click. */}
          <TaskMenu task={task} onEditRequest={() => setEditing(true)} />
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
              <RichText className="subtask-desc" text={s.description} />
            </li>
          ))}
        </ul>
      )}
    </li>
  )
}
