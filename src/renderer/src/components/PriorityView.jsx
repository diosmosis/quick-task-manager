import { useMemo, useState } from 'react'
import TaskItem from './TaskItem.jsx'
import RichText from './RichText.jsx'
import StatusChip from './StatusChip.jsx'
import {
  allStatuses,
  allTags,
  moveId,
  sortByPriorityOrder,
  tagColor,
  visibleInPriority
} from '../utils/tasks.js'

// A search box shown at the top of a column (outside the scroll area). It finds
// tasks with the column's tag that are not yet prioritized (and not completed).
// Selecting one prioritizes it.
function ColumnSearch({ tag, tasks, onPrioritize }) {
  const [query, setQuery] = useState('')

  const matches = useMemo(() => {
    const q = query.trim().toLowerCase()
    return tasks
      .filter(
        (t) =>
          t.tags.includes(tag) &&
          !t.prioritized &&
          !t.completed &&
          (q === '' || t.description.toLowerCase().includes(q))
      )
      .slice(0, 8)
  }, [tasks, tag, query])

  return (
    <div className="column-search">
      <input
        type="text"
        placeholder={`Add a #${tag} task…`}
        value={query}
        onChange={(e) => setQuery(e.target.value)}
      />
      {query.trim() !== '' && (
        <ul className="search-results">
          {matches.length === 0 ? (
            <li className="search-empty">No matching tasks</li>
          ) : (
            matches.map((t) => (
              <li
                key={t.id}
                onClick={() => {
                  onPrioritize(t.id)
                  setQuery('')
                }}
              >
                {t.description || '(no description)'}
              </li>
            ))
          )}
        </ul>
      )}
    </div>
  )
}

export default function PriorityView({
  tasks,
  now,
  columns,
  onAddColumn,
  onRemoveColumn,
  onReorderColumns,
  priorityOrder,
  onReorderTasks,
  focusTask,
  onSetFocus,
  onClearFocus,
  onEdit,
  onTogglePriority,
  onToggleComplete,
  onAddSubtask,
  onRemoveSubtask,
  onToggleSubtask,
  onSetSchedule,
  onSetStatus,
  onOpenNotes
}) {
  const tags = useMemo(() => allTags(tasks), [tasks])
  const statuses = useMemo(() => allStatuses(tasks), [tasks])
  const availableToAdd = tags.filter((t) => !columns.includes(t))
  const [dragTag, setDragTag] = useState(null)
  const [dragOverTag, setDragOverTag] = useState(null)
  const [focusDragOver, setFocusDragOver] = useState(false)
  // A task card being dragged within its column ({ id, tag }), and where it
  // would land ({ id, position }). Subtask drags only ever target the focus
  // zone, so they never set these.
  const [dragTask, setDragTask] = useState(null)
  const [dropTarget, setDropTarget] = useState(null)

  function endTaskDrag() {
    setDragTask(null)
    setDropTarget(null)
  }

  // The card under the pointer and which half of it the pointer is in. In the
  // gap between two cards there is no card, and the last target stands.
  function taskDropTarget(e, tag) {
    if (!dragTask || dragTask.tag !== tag) return undefined
    const li = e.target.closest('[data-task-id]')
    if (!li) return undefined
    const id = li.dataset.taskId
    if (id === dragTask.id) return null
    const rect = li.getBoundingClientRect()
    return { id, position: e.clientY < rect.top + rect.height / 2 ? 'before' : 'after' }
  }

  // The focused item is either a task or a subtask; each is marked in the
  // columns so the user can find what they're working on and complete it.
  const focusedTaskId = focusTask && !focusTask.isSubtask ? focusTask.id : null
  const focusedSubtaskId = focusTask && focusTask.isSubtask ? focusTask.id : null

  function handleDeprioritize(task) {
    const ok = window.confirm(
      `De-prioritize "${task.description || 'this task'}"?`
    )
    if (ok) onTogglePriority(task.id)
  }

  return (
    <div className="view priority-view">
      <div
        className={
          'focus-zone' +
          (focusTask ? ' filled' : ' empty') +
          (focusDragOver ? ' drag-over' : '')
        }
        onDragOver={(e) => {
          // Only react to task drags (not column-reorder drags).
          if (dragTag !== null) return
          e.preventDefault()
          e.dataTransfer.dropEffect = 'copy'
          if (!focusDragOver) setFocusDragOver(true)
        }}
        onDragLeave={() => setFocusDragOver(false)}
        onDrop={(e) => {
          setFocusDragOver(false)
          const id = e.dataTransfer.getData('task-id')
          if (id) {
            e.preventDefault()
            onSetFocus(id)
          }
        }}
      >
        <span className="focus-label">Working on</span>
        {focusTask ? (
          <div className="focus-content">
            <div className="focus-task">
              <RichText
                className="focus-desc"
                text={focusTask.description}
                fallback="(no description)"
              />
              {/* How far along the thing you're working on is — the one card
                  where that is worth having in front of you. Empty for a
                  focused subtask, which has no status of its own. */}
              <StatusChip status={focusTask.status} />
              {focusTask.tags.length > 0 && (
                <span className="focus-tags">
                  {focusTask.tags.map((t) => {
                    const c = tagColor(t)
                    return (
                      <span
                        key={t}
                        className="tag-chip"
                        style={{ backgroundColor: c.bg, color: c.fg, borderColor: c.border }}
                      >
                        #{t}
                      </span>
                    )
                  })}
                </span>
              )}
              {focusTask.isSubtask && (
                <span className="focus-parent">
                  in “{focusTask.parentDescription || 'a task'}”
                </span>
              )}
            </div>
            <button
              className="focus-clear"
              title="Clear"
              aria-label="Clear focus"
              onClick={onClearFocus}
            >
              ✕
            </button>
          </div>
        ) : (
          <div className="focus-empty-hint">
            🎯 Drag a task here to focus on what you&apos;re working on
          </div>
        )}
      </div>

      <div className="column-adder">
        <label>Add column:</label>
        <div className="select-wrap">
          <select
            value=""
            onChange={(e) => {
              if (e.target.value) onAddColumn(e.target.value)
            }}
          >
            <option value="">Select a tag…</option>
            {availableToAdd.map((tag) => (
              <option key={tag} value={tag}>
                #{tag}
              </option>
            ))}
          </select>
        </div>
      </div>

      {columns.length === 0 ? (
        <p className="empty">
          No columns yet. Choose a tag above to create a prioritization column.
        </p>
      ) : (
        <div className="columns">
          {columns.map((tag) => {
            const columnTasks = sortByPriorityOrder(
              tasks.filter(
                (t) => t.tags.includes(tag) && t.prioritized && visibleInPriority(t, now)
              ),
              priorityOrder[tag]
            )
            const c = tagColor(tag)
            const classes =
              'column' +
              (dragTag === tag ? ' dragging' : '') +
              (dragOverTag === tag && dragTag !== tag ? ' drag-over' : '')
            return (
              <div
                key={tag}
                className={classes}
                onDragOver={(e) => {
                  if (dragTag === null) return
                  e.preventDefault()
                  if (dragOverTag !== tag) setDragOverTag(tag)
                }}
                onDrop={(e) => {
                  e.preventDefault()
                  if (dragTag) onReorderColumns(dragTag, tag)
                  setDragTag(null)
                  setDragOverTag(null)
                }}
              >
                <div
                  className="column-header"
                  draggable
                  title="Drag to reorder"
                  style={{ borderTopColor: c.border }}
                  onDragStart={(e) => {
                    setDragTag(tag)
                    e.dataTransfer.effectAllowed = 'move'
                  }}
                  onDragEnd={() => {
                    setDragTag(null)
                    setDragOverTag(null)
                  }}
                >
                  <h3 style={{ color: c.fg }}>
                    <span className="drag-grip" aria-hidden="true">
                      ⠿
                    </span>
                    #{tag}
                  </h3>
                  <button
                    className="icon-btn"
                    title="Remove column"
                    aria-label="Remove column"
                    onClick={() => onRemoveColumn(tag)}
                  >
                    ✕
                  </button>
                </div>
                <ColumnSearch tag={tag} tasks={tasks} onPrioritize={onTogglePriority} />
                <div className="column-body">
                  {columnTasks.length === 0 ? (
                    <p className="empty small">No prioritized tasks.</p>
                  ) : (
                    <ul
                      className="task-list"
                      onDragOver={(e) => {
                        const target = taskDropTarget(e, tag)
                        if (target === undefined) {
                          // Still inside the list, between cards: keep the drop
                          // alive so the indicator doesn't flicker.
                          if (dragTask && dragTask.tag === tag) e.preventDefault()
                          return
                        }
                        e.preventDefault()
                        e.dataTransfer.dropEffect = 'move'
                        if (
                          target?.id !== dropTarget?.id ||
                          target?.position !== dropTarget?.position
                        ) {
                          setDropTarget(target)
                        }
                      }}
                      onDrop={(e) => {
                        if (!dragTask || dragTask.tag !== tag) return
                        e.preventDefault()
                        if (dropTarget) {
                          const ids = columnTasks.map((t) => t.id)
                          onReorderTasks(
                            tag,
                            moveId(ids, dragTask.id, dropTarget.id, dropTarget.position)
                          )
                        }
                        endTaskDrag()
                      }}
                      onDragEnd={endTaskDrag}
                    >
                      {columnTasks.map((task) => (
                        <TaskItem
                          key={task.id}
                          task={task}
                          focused={task.id === focusedTaskId}
                          focusedSubtaskId={focusedSubtaskId}
                          dragging={dragTask?.id === task.id && dragTask.tag === tag}
                          dropPosition={
                            dropTarget?.id === task.id ? dropTarget.position : null
                          }
                          draggable
                          onDragStart={(e) => {
                            e.dataTransfer.setData('task-id', task.id)
                            // Copy onto the focus zone, move within the column.
                            e.dataTransfer.effectAllowed = 'copyMove'
                            setDragTask({ id: task.id, tag })
                          }}
                          onSubtaskDragStart={(subId, e) => {
                            e.dataTransfer.setData('task-id', subId)
                            e.dataTransfer.effectAllowed = 'copy'
                          }}
                          onEdit={(text) => onEdit(task.id, text)}
                          onAddSubtask={(text) => onAddSubtask(task.id, text)}
                          onRemoveSubtask={(subId) => onRemoveSubtask(task.id, subId)}
                          onToggleSubtask={(subId) => onToggleSubtask(task.id, subId)}
                          onSetSchedule={(patch) => onSetSchedule(task.id, patch)}
                          onSetStatus={(status) => onSetStatus(task.id, status)}
                          knownStatuses={statuses}
                          onOpenNotes={onOpenNotes}
                          actions={[
                            {
                              key: 'complete',
                              icon: task.completed ? '↩' : '✓',
                              title: task.completed
                                ? 'Undo completion'
                                : 'Mark completed',
                              active: task.completed,
                              onClick: () => onToggleComplete(task.id)
                            },
                            {
                              key: 'deprioritize',
                              icon: (
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
                                  <circle cx="12" cy="12" r="8.5" />
                                  <line x1="8.5" y1="12" x2="15.5" y2="12" />
                                </svg>
                              ),
                              title: 'De-prioritize (remove from column)',
                              onClick: () => handleDeprioritize(task)
                            }
                          ]}
                        />
                      ))}
                    </ul>
                  )}
                </div>
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}
