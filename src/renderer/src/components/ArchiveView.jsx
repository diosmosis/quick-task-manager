import { useMemo } from 'react'
import TaskItem from './TaskItem.jsx'
import { ARCHIVE_TTL_MS, formatDate } from '../utils/tasks.js'

// Shows completed tasks. They remain here for 14 days before being purged.
export default function ArchiveView({
  tasks,
  now,
  onEdit,
  onToggleComplete,
  onAddSubtask,
  onRemoveSubtask
}) {
  const completed = useMemo(
    () =>
      tasks
        .filter((t) => t.completed && t.completedAt)
        .sort((a, b) => b.completedAt - a.completedAt),
    [tasks]
  )

  return (
    <div className="view archive-view">
      {completed.length === 0 ? (
        <p className="empty">No completed tasks yet.</p>
      ) : (
        <ul className="task-list">
          {completed.map((task) => {
            const daysLeft = Math.max(
              0,
              Math.ceil((task.completedAt + ARCHIVE_TTL_MS - now) / (24 * 60 * 60 * 1000))
            )
            return (
              <TaskItem
                key={task.id}
                task={task}
                onEdit={(text) => onEdit(task.id, text)}
                onAddSubtask={(text) => onAddSubtask(task.id, text)}
                onRemoveSubtask={(subId) => onRemoveSubtask(task.id, subId)}
                actions={[
                  {
                    key: 'restore',
                    icon: '↩',
                    title: 'Restore (un-complete)',
                    onClick: () => onToggleComplete(task.id)
                  }
                ]}
              >
                <span className="archive-meta">
                  Completed {formatDate(task.completedAt)} · removed in {daysLeft}d
                </span>
              </TaskItem>
            )
          })}
        </ul>
      )}
    </div>
  )
}
