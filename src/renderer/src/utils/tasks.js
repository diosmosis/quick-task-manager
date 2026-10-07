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
    // The due date and recurrence are opt-in, and only ever set while editing
    // an existing task. A task can have a due date without recurring (a one-off
    // deadline); a recurring task always has one (its next occurrence).
    recurrence: null, // { every: number, unit: 'day' | 'week' | 'month' }
    dueAt: null,
    autoPrioritizedFor: null,
    spawnedFrom: null,
    // Free-form text, written through the notes sheet. Like recurrence and
    // subtasks it is only ever set on an existing task — the creation input is
    // a single line and has no room for it.
    notes: '',
    // Free-form progress label ("in progress", "blocked", …). Like a tag in
    // that it is short, repeated across tasks and color-coded from its own
    // text; unlike a tag in that a task has at most one and it says how far
    // along the work is rather than what the work is about.
    status: ''
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
      status: task.status || '',
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
        // Subtasks carry no status of their own; the parent's would be about
        // the whole task, not about this line of it.
        status: '',
        isSubtask: true,
        parentDescription: t.description
      }
    }
  }
  return null
}

// ---------------------------------------------------------------------------
// Due dates and recurrence
// ---------------------------------------------------------------------------

function daysInMonth(year, month) {
  return new Date(year, month + 1, 0).getDate()
}

export function startOfDay(ms) {
  const d = new Date(ms)
  d.setHours(0, 0, 0, 0)
  return d.getTime()
}

// Convert between a due timestamp and the `YYYY-MM-DD` value of a date input,
// in local time. A picked date is stored as the start of that local day: a due
// date is about which day, not which moment (see isDue).
export function dueAtToDateInput(ms) {
  if (ms == null) return ''
  const d = new Date(ms)
  const pad = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

export function dateInputToDueAt(value) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value || '')
  if (!m) return null
  return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])).getTime()
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

// The next due date, on a later day than `now`. Stepping from the previous due
// date (rather than from `now`) keeps a schedule on its original cadence when a
// task is completed late; the loop then skips any occurrences that were missed.
//
// The comparison is by day rather than by instant because a task counts as due
// for its whole due day (see isDue). Landing the follow-up occurrence on the
// day the previous one was finished would make it due — and so auto-prioritized
// — immediately, which is exactly what "the copy should not be prioritized"
// rules out.
export function nextDueDate(from, recurrence, now) {
  const today = startOfDay(now)
  let next = addInterval(from, recurrence)
  let guard = 0
  while (startOfDay(next) <= today && guard++ < 10000) next = addInterval(next, recurrence)
  return next
}

// A task is due for the whole of its due day, not just from its due time
// onwards: something due at 6pm today is something you need to do today, and
// waiting until 6pm to surface it is too late to be useful. This applies to
// one-off due dates and recurring occurrences alike.
export function isDue(task, now) {
  return (
    !task.completed &&
    task.dueAt != null &&
    startOfDay(task.dueAt) <= startOfDay(now)
  )
}

export function describeRecurrence(recurrence) {
  if (!recurrence) return ''
  const { every, unit } = recurrence
  return every === 1 ? `every ${unit}` : `every ${every} ${unit}s`
}

// Short, human-readable "when is this due" label for a task chip.
// Compared by day, like isDue: a picked date is stored as the start of its day,
// which would otherwise read as "overdue" from the first minute of that day.
export function formatDueRelative(dueAt, now) {
  const days = Math.round((startOfDay(dueAt) - startOfDay(now)) / DAY_MS)
  if (days < 0) return days === -1 ? 'overdue by 1 day' : `overdue by ${-days} days`
  if (days === 0) return 'due today'
  if (days === 1) return 'due tomorrow'
  if (days < 7) return `due in ${days} days`
  return `due ${new Date(dueAt).toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric'
  })}`
}

// Auto-prioritize tasks that have come due, recurring or not. Each due date is
// auto-prioritized at most once (tracked by `autoPrioritizedFor`), so a user who
// deliberately de-prioritizes a due task isn't fighting the timer — it comes
// back at the next occurrence (or if the due date is changed) instead.
export function applyDueTasks(tasks, now) {
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
    // Notes carry over (they are the task's standing instructions) but the
    // status does not: it describes how far *this* occurrence got, and a fresh
    // occurrence has not been started.
    status: '',
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

// Collect the distinct statuses in use across the given tasks (sorted). Offered
// as suggestions while editing: a status is only worth color-coding if the same
// wording comes back, and typing "in progres" once defeats that.
export function allStatuses(tasks) {
  const seen = new Map() // lowercased -> first spelling encountered
  for (const t of tasks) {
    const status = (t.status || '').trim()
    if (status && !seen.has(status.toLowerCase())) seen.set(status.toLowerCase(), status)
  }
  return [...seen.values()].sort((a, b) => a.localeCompare(b))
}

// Whether a completed task should still be shown in the prioritization view
// (completed less than 15 minutes ago, or its completion was undone).
export function visibleInPriority(task, now) {
  if (!task.completed) return true
  return now - task.completedAt < PRIORITY_HIDE_MS
}

// Order a column's tasks by the user's hand-arranged list of ids. Tasks that
// were never placed (newly prioritized, or every task before the column was
// first rearranged) follow the placed ones, in their existing relative order —
// the sort is stable.
export function sortByPriorityOrder(tasks, order) {
  if (!order || order.length === 0) return tasks
  const rank = new Map(order.map((id, i) => [id, i]))
  const unplaced = order.length
  return [...tasks].sort(
    (a, b) => (rank.get(a.id) ?? unplaced) - (rank.get(b.id) ?? unplaced)
  )
}

// Move `id` within `ids` to sit before or after `targetId`.
export function moveId(ids, id, targetId, position) {
  const next = ids.filter((x) => x !== id)
  const at = next.indexOf(targetId)
  if (at === -1) return ids
  next.splice(position === 'after' ? at + 1 : at, 0, id)
  return next
}

// Drop a task from every column's order, e.g. once it is de-prioritized or
// deleted, so that if it comes back it is treated as newly placed.
export function removeFromPriorityOrder(order, id) {
  let changed = false
  const next = {}
  for (const [tag, ids] of Object.entries(order)) {
    if (ids.includes(id)) {
      next[tag] = ids.filter((x) => x !== id)
      changed = true
    } else {
      next[tag] = ids
    }
  }
  return changed ? next : order
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

// Statuses are color-coded the same way tags are, from the same hash, so the
// palette is one palette. Normalized first: a status is typed by hand, so
// "In Progress" and "in progress" are the same status and must not land on two
// different colors.
export function statusColor(status) {
  return tagColor(String(status || '').trim().toLowerCase())
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
