import { statusColor } from '../utils/tasks.js'

// A task's free-form status, shown wherever the task is. Color-coded from its
// own text exactly as a tag is, so the same status reads the same everywhere —
// but drawn as a squared, upper-cased label rather than a `#pill`, because a
// status is not a tag and the two sit side by side on the same card.
//
// One component rather than the same markup in each view: the treatment is what
// distinguishes a status from a tag, so it must not be able to drift.
export default function StatusChip({ status }) {
  const text = String(status || '').trim()
  if (!text) return null
  const c = statusColor(text)
  return (
    <span
      className="status-chip"
      title={`Status: ${text}`}
      style={{ backgroundColor: c.bg, color: c.fg, borderColor: c.border }}
    >
      {text}
    </span>
  )
}
