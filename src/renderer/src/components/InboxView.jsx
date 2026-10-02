import { useMemo, useState } from 'react'
import TaskInput from './TaskInput.jsx'
import TaskItem from './TaskItem.jsx'
import { allStatuses, allTags } from '../utils/tasks.js'

// Shows all non-completed tasks with text/tag filtering and sorting.
export default function InboxView({
  tasks,
  onAdd,
  onEdit,
  onTogglePriority,
  onAddSubtask,
  onRemoveSubtask,
  onSetRecurrence,
  onSetStatus,
  onOpenNotes
}) {
  const [textFilter, setTextFilter] = useState('')
  const [tagFilter, setTagFilter] = useState('')
  const [sortBy, setSortBy] = useState('created-desc')

  const tags = useMemo(() => allTags(tasks), [tasks])
  // Offered as completions in each card's status editor, so statuses converge
  // on the same wording instead of fragmenting into near-duplicates.
  const statuses = useMemo(() => allStatuses(tasks), [tasks])

  const visible = useMemo(() => {
    const text = textFilter.trim().toLowerCase()
    let list = tasks.filter((t) => !t.completed)

    if (text) {
      list = list.filter(
        (t) =>
          t.description.toLowerCase().includes(text) ||
          t.tags.some((tag) => tag.includes(text))
      )
    }
    if (tagFilter) {
      list = list.filter((t) => t.tags.includes(tagFilter))
    }

    const sorted = [...list]
    switch (sortBy) {
      case 'text-asc':
        sorted.sort((a, b) => a.description.localeCompare(b.description))
        break
      case 'text-desc':
        sorted.sort((a, b) => b.description.localeCompare(a.description))
        break
      case 'created-asc':
        sorted.sort((a, b) => a.createdAt - b.createdAt)
        break
      case 'created-desc':
      default:
        sorted.sort((a, b) => b.createdAt - a.createdAt)
        break
    }
    return sorted
  }, [tasks, textFilter, tagFilter, sortBy])

  return (
    <div className="view inbox-view">
      <div className="inbox-header">
        <TaskInput onSubmit={onAdd} autoFocus />

        <div className="toolbar">
          <input
            type="text"
            className="filter-input"
            placeholder="Filter by text…"
            value={textFilter}
            onChange={(e) => setTextFilter(e.target.value)}
          />
          <div className="select-wrap">
            <select value={tagFilter} onChange={(e) => setTagFilter(e.target.value)}>
              <option value="">All tags</option>
              {tags.map((tag) => (
                <option key={tag} value={tag}>
                  #{tag}
                </option>
              ))}
            </select>
          </div>
          <div className="select-wrap">
            <select value={sortBy} onChange={(e) => setSortBy(e.target.value)}>
              <option value="created-desc">Newest first</option>
              <option value="created-asc">Oldest first</option>
              <option value="text-asc">Text (A–Z)</option>
              <option value="text-desc">Text (Z–A)</option>
            </select>
          </div>
        </div>
      </div>

      <div className="inbox-list">
        {visible.length === 0 ? (
          <p className="empty">No tasks. Add one above to get started.</p>
        ) : (
          <ul className="task-list">
            {visible.map((task) => (
              <TaskItem
                key={task.id}
                task={task}
                onEdit={(text) => onEdit(task.id, text)}
                onAddSubtask={(text) => onAddSubtask(task.id, text)}
                onRemoveSubtask={(subId) => onRemoveSubtask(task.id, subId)}
                onSetRecurrence={(rec) => onSetRecurrence(task.id, rec)}
                onSetStatus={(status) => onSetStatus(task.id, status)}
                knownStatuses={statuses}
                onOpenNotes={onOpenNotes}
                actions={[
                  {
                    key: 'priority',
                    icon: task.prioritized ? '★' : '☆',
                    title: task.prioritized ? 'Remove priority' : 'Prioritize',
                    active: task.prioritized,
                    onClick: () => onTogglePriority(task.id)
                  }
                ]}
              />
            ))}
          </ul>
        )}
      </div>
    </div>
  )
}
