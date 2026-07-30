// Time constants (milliseconds).
export const PRIORITY_HIDE_MS = 15 * 60 * 1000 // 15 minutes
export const ARCHIVE_TTL_MS = 14 * 24 * 60 * 60 * 1000 // 14 days
const DAY_MS = 24 * 60 * 60 * 1000

export const RECURRENCE_UNITS = [
  { value: 'day', label: 'days' },
  { value: 'week', label: 'weeks' },
  { value: 'month', label: 'months' }
]

const TAG_RE = /#([\p{L}\p{N}_-]+)/gu

// Parse a single-input string into a description + normalized tag list.
// Example: "Buy milk #groceries #Errands" ->
//   { description: "Buy milk", tags: ["groceries", "errands"] }
export function parseInput(text) {
  const tags = []
  let match
  TAG_RE.lastIndex = 0
  while ((match = TAG_RE.exec(text)) !== null) {
    const tag = match[1].toLowerCase()
    if (!tags.includes(tag)) tags.push(tag)
  }
  const description = text.replace(TAG_RE, '').replace(/\s+/g, ' ').trim()
  return { description, tags }
}

// Reconstruct an editable input string from a task.
export function taskToInput(task) {
  const tagStr = task.tags.map((t) => `#${t}`).join(' ')
  return [task.description, tagStr].filter(Boolean).join(' ').trim()
}

export function createTask(text) {
  const { description, tags } = parseInput(text)
  return {
    id: crypto.randomUUID(),
    description,
    tags,
    createdAt: Date.now(),
    prioritized: false,
    completed: false,
    completedAt: null,
    subtasks: [],
    // Recurrence is opt-in, and only ever set while editing an existing task.
    recurrence: null, // { every: number, unit: 'day' | 'week' | 'month' }
    dueAt: null,
    autoPrioritizedFor: null,
    spawnedFrom: null
  }
}

// Create a subtask (belongs to a parent task; cannot be prioritized or tagged).
export function createSubtask(text) {
  return {
    id: crypto.randomUUID(),
    description: text.replace(/\s+/g, ' ').trim(),
    completed: false
  }
}

// Resolve the id held by the "Working on" focus zone. It may point at either a
// top-level task or a subtask, so search both. Returns a normalized descriptor
// (or null if the id no longer exists, e.g. it was removed).
export function findFocusTarget(tasks, id) {
  if (!id) return null
  const task = tasks.find((t) => t.id === id)
  if (task) {
    return {
      id: task.id,
      description: task.description,
      tags: task.tags,
      isSubtask: false
    }
  }
  for (const t of tasks) {
    const sub = (t.subtasks || []).find((s) => s.id === id)
    if (sub) {
      return {
        id: sub.id,
        description: sub.description,
        tags: [],
        isSubtask: true,
        parentDescription: t.description
      }
    }
  }
  return null
}

// ---------------------------------------------------------------------------
// Recurrence
// ---------------------------------------------------------------------------

function daysInMonth(year, month) {
  return new Date(year, month + 1, 0).getDate()
}

// Advance a timestamp by one recurrence interval, keeping the local time of day
// (so DST shifts don't creep). Month steps clamp to the last day of the target
// month, i.e. Jan 31 + 1 month = Feb 28, not Mar 3.
export function addInterval(ms, recurrence) {
  const every = Math.max(1, Math.round(recurrence?.every || 1))
  const d = new Date(ms)
  if (recurrence?.unit === 'week') {
    d.setDate(d.getDate() + every * 7)
  } else if (recurrence?.unit === 'month') {
    const day = d.getDate()
    d.setDate(1) // avoid overflowing while the month is being changed
    d.setMonth(d.getMonth() + every)
    d.setDate(Math.min(day, daysInMonth(d.getFullYear(), d.getMonth())))
  } else {
    d.setDate(d.getDate() + every)
  }
  return d.getTime()
}

// The next due date strictly after `now`. Stepping from the previous due date
// (rather than from `now`) keeps a schedule on its original cadence when a task
// is completed late; the loop then skips any occurrences that were missed.
export function nextDueDate(from, recurrence, now) {
  let next = addInterval(from, recurrence)
  let guard = 0
  while (next <= now && guard++ < 10000) next = addInterval(next, recurrence)
  return next
}

export function isDue(task, now) {
  return !!task.recurrence && !task.completed && task.dueAt != null && task.dueAt <= now
}

export function describeRecurrence(recurrence) {
  if (!recurrence) return ''
  const { every, unit } = recurrence
  return every === 1 ? `every ${unit}` : `every ${every} ${unit}s`
}

function startOfDay(ms) {
  const d = new Date(ms)
  d.setHours(0, 0, 0, 0)
  return d.getTime()
}

// Short, human-readable "when is this due" label for a task chip.
export function formatDueRelative(dueAt, now) {
  if (dueAt <= now) return 'due now'
  const days = Math.round((startOfDay(dueAt) - startOfDay(now)) / DAY_MS)
  if (days <= 0) return 'due today'
  if (days === 1) return 'due tomorrow'
  if (days < 7) return `due in ${days} days`
  return `due ${new Date(dueAt).toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric'
  })}`
}

// Auto-prioritize recurring tasks that have come due. Each occurrence is
// auto-prioritized at most once (tracked by `autoPrioritizedFor`), so a user who
// deliberately de-prioritizes a due task isn't fighting the timer — it comes
// back at the next occurrence instead.
export function applyDueRecurring(tasks, now) {
  let changed = false
  const next = tasks.map((t) => {
    if (!isDue(t, now) || t.autoPrioritizedFor === t.dueAt) return t
    changed = true
    return { ...t, prioritized: true, autoPrioritizedFor: t.dueAt }
  })
  return changed ? next : tasks
}

// The follow-up occurrence spawned when a recurring task is completed. It starts
// fresh: not prioritized, not completed, subtasks reset, due in the future.
export function createRecurrenceCopy(task, now) {
  return {
    ...task,
    id: crypto.randomUUID(),
    createdAt: now,
    prioritized: false,
    completed: false,
    completedAt: null,
    autoPrioritizedFor: null,
    spawnedFrom: task.id,
    dueAt: nextDueDate(task.dueAt ?? now, task.recurrence, now),
    subtasks: (task.subtasks || []).map((s) => ({
      ...s,
      id: crypto.randomUUID(),
      completed: false
    }))
  }
}

// Collect all distinct tags across the given tasks (sorted).
export function allTags(tasks) {
  const set = new Set()
  for (const t of tasks) {
    for (const tag of t.tags) set.add(tag)
  }
  return [...set].sort()
}

// Whether a completed task should still be shown in the prioritization view
// (completed less than 15 minutes ago, or its completion was undone).
export function visibleInPriority(task, now) {
  if (!task.completed) return true
  return now - task.completedAt < PRIORITY_HIDE_MS
}

// Remove completed tasks whose 14-day retention has elapsed.
export function purgeExpired(tasks, now) {
  return tasks.filter(
    (t) => !(t.completed && t.completedAt && now - t.completedAt > ARCHIVE_TTL_MS)
  )
}

// Deterministically map a tag string to a color. The same tag always yields the
// same color, while different tags are spread across the hue circle so they get
// visibly distinct colors.
export function tagColor(tag) {
  let hash = 0
  for (let i = 0; i < tag.length; i++) {
    hash = (hash * 31 + tag.charCodeAt(i)) | 0
  }
  const hue = Math.abs(hash) % 360
  return {
    bg: `hsl(${hue}, 45%, 28%)`,
    fg: `hsl(${hue}, 75%, 82%)`,
    border: `hsl(${hue}, 45%, 42%)`
  }
}

export function formatDate(ms) {
  return new Date(ms).toLocaleString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit'
  })
}
