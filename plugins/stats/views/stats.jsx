import { useEffect, useMemo, useState } from 'react'
import './stats.css'

// The Stats tab. Draws from two sources: the completion log this plugin keeps
// (see ../index.js), which reaches back past the Archive's 14 days, and the
// app's live task list, which covers anything completed before the plugin was
// enabled and is authoritative for whatever it still holds.

const DAY_MS = 24 * 60 * 60 * 1000
const RANGES = [7, 30, 90]
const TOP_TAGS = 8

function startOfDay(t) {
  const d = new Date(t)
  d.setHours(0, 0, 0, 0)
  return d.getTime()
}

// Local calendar days rather than 24h steps, so a DST change cannot skip or
// double a day.
function addDays(dayStart, n) {
  const d = new Date(dayStart)
  d.setDate(d.getDate() + n)
  return d.getTime()
}

function formatDay(t, long = false) {
  return new Date(t).toLocaleDateString(undefined, {
    weekday: long ? 'short' : undefined,
    month: 'short',
    day: 'numeric'
  })
}

function formatDuration(ms) {
  if (ms == null) return '—'
  const minutes = ms / 60000
  if (minutes < 60) return `${Math.max(1, Math.round(minutes))} min`
  const hours = minutes / 60
  if (hours < 24) return `${hours.toFixed(hours < 10 ? 1 : 0)} h`
  const days = hours / 24
  return `${days.toFixed(days < 10 ? 1 : 0)} days`
}

function median(values) {
  if (values.length === 0) return null
  const sorted = [...values].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2
}

// One record per completed task: { completedAt, createdAt, tags }.
function mergeRecords(log, tasks) {
  const byId = { ...(log || {}) }
  for (const t of tasks) {
    if (t.completed && t.completedAt) {
      byId[t.id] = { completedAt: t.completedAt, createdAt: t.createdAt, tags: t.tags || [] }
    } else if (t.id in byId) {
      // Un-completed since it was logged; the live list wins.
      delete byId[t.id]
    }
  }
  return Object.values(byId).filter((r) => r && typeof r.completedAt === 'number')
}

function computeStats(records, rangeDays, now) {
  const today = startOfDay(now)
  const first = addDays(today, -(rangeDays - 1))

  const counts = new Map()
  for (const r of records) {
    const day = startOfDay(r.completedAt)
    counts.set(day, (counts.get(day) || 0) + 1)
  }

  const days = []
  for (let i = 0; i < rangeDays; i++) {
    const day = addDays(first, i)
    days.push({ day, count: counts.get(day) || 0 })
  }

  const inRange = records.filter((r) => r.completedAt >= first)

  // A streak is still alive until a whole day passes without a completion, so
  // an empty today counts from yesterday rather than resetting to zero.
  let streak = 0
  let cursor = counts.get(today) ? today : addDays(today, -1)
  while (counts.get(cursor)) {
    streak++
    cursor = addDays(cursor, -1)
  }

  const tagCounts = new Map()
  for (const r of inRange) {
    for (const tag of r.tags || []) tagCounts.set(tag, (tagCounts.get(tag) || 0) + 1)
  }
  const tags = [...tagCounts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, TOP_TAGS)
    .map(([tag, count]) => ({ tag, count }))

  const durations = inRange
    .filter((r) => typeof r.createdAt === 'number' && r.completedAt >= r.createdAt)
    .map((r) => r.completedAt - r.createdAt)

  return {
    days,
    tags,
    today: counts.get(today) || 0,
    total: inRange.length,
    allTime: records.length,
    perDay: inRange.length / rangeDays,
    streak,
    medianDuration: median(durations)
  }
}

function Tile({ label, value, hint }) {
  return (
    <div className="stats-tile">
      <div className="stats-tile-value">{value}</div>
      <div className="stats-tile-label">{label}</div>
      {hint && <div className="stats-tile-hint">{hint}</div>}
    </div>
  )
}

function DailyChart({ days }) {
  const [hover, setHover] = useState(null)
  const max = Math.max(1, ...days.map((d) => d.count))
  // A clean top tick: the next whole number that divides evenly into halves.
  const top = max <= 2 ? max : Math.ceil(max / 2) * 2
  const shown = hover != null ? days[hover] : null
  // Label roughly six dates along the axis, whatever the range.
  const labelEvery = Math.max(1, Math.ceil(days.length / 6))

  return (
    <div className="stats-chart">
      <div className="stats-chart-readout" aria-live="polite">
        {shown
          ? `${formatDay(shown.day, true)} · ${shown.count} completed`
          : 'Hover a day for its count'}
      </div>
      <div className="stats-chart-plot">
        <div className="stats-chart-axis" aria-hidden="true">
          <span>{top}</span>
          <span>{top / 2}</span>
          <span>0</span>
        </div>
        <div className="stats-chart-bars" onMouseLeave={() => setHover(null)}>
          <div className="stats-chart-grid" aria-hidden="true">
            <span />
            <span />
            <span />
          </div>
          {days.map((d, i) => (
            <div
              key={d.day}
              className={`stats-chart-slot${hover === i ? ' hover' : ''}`}
              onMouseEnter={() => setHover(i)}
              aria-label={`${formatDay(d.day, true)}: ${d.count} completed`}
              role="img"
            >
              {d.count > 0 && (
                <div className="stats-chart-bar" style={{ height: `${(d.count / top) * 100}%` }} />
              )}
            </div>
          ))}
        </div>
      </div>
      <div className="stats-chart-dates" aria-hidden="true">
        {days.map((d, i) => (
          <span key={d.day}>
            {(days.length - 1 - i) % labelEvery === 0 ? formatDay(d.day) : ''}
          </span>
        ))}
      </div>
    </div>
  )
}

function TagBars({ tags }) {
  if (tags.length === 0) return <p className="empty small">No tagged tasks completed.</p>
  const max = tags[0].count
  return (
    <ul className="stats-tags">
      {tags.map(({ tag, count }) => (
        <li key={tag} className="stats-tag-row">
          <span className="stats-tag-name">#{tag}</span>
          <span className="stats-tag-track">
            <span className="stats-tag-bar" style={{ width: `${(count / max) * 100}%` }} />
          </span>
          <span className="stats-tag-count">{count}</span>
        </li>
      ))}
    </ul>
  )
}

export default function StatsView({ tasks, now, query }) {
  const [range, setRange] = useState(30)
  const [log, setLog] = useState(null)
  const [error, setError] = useState(null)
  const [showTable, setShowTable] = useState(false)

  // Re-read whenever the task list changes, so a completion made in another
  // tab is reflected when this one is opened again.
  useEffect(() => {
    let cancelled = false
    query()
      .then((data) => {
        if (cancelled) return
        setLog(data || {})
        setError(null)
      })
      .catch((err) => {
        if (!cancelled) setError(String((err && err.message) || err))
      })
    return () => {
      cancelled = true
    }
  }, [query, tasks])

  const records = useMemo(() => mergeRecords(log, tasks), [log, tasks])
  const stats = useMemo(() => computeStats(records, range, now), [records, range, now])

  if (error) return <div className="plugin-form-error">{error}</div>
  if (log == null) return <p className="empty">Loading…</p>

  return (
    <div className="stats-view">
      <div className="stats-toolbar">
        <h2 className="stats-heading">Completed tasks</h2>
        <div className="stats-range" role="group" aria-label="Range">
          {RANGES.map((r) => (
            <button
              key={r}
              className={`stats-range-btn${range === r ? ' active' : ''}`}
              onClick={() => setRange(r)}
            >
              {r} days
            </button>
          ))}
        </div>
      </div>

      {records.length === 0 ? (
        <p className="empty">
          No completed tasks yet. Completions are recorded from now on while this plugin is enabled.
        </p>
      ) : (
        <>
          <div className="stats-tiles">
            <Tile label="Today" value={stats.today} />
            <Tile label={`Last ${range} days`} value={stats.total} hint={`${stats.allTime} all time`} />
            <Tile label="Per day" value={stats.perDay.toFixed(1)} hint={`over ${range} days`} />
            <Tile
              label="Day streak"
              value={stats.streak}
              hint={stats.streak === 1 ? 'day in a row' : 'days in a row'}
            />
            <Tile
              label="Median time to complete"
              value={formatDuration(stats.medianDuration)}
              hint="from creation"
            />
          </div>

          <section className="stats-section">
            <div className="stats-section-header">
              <h3>Completed per day</h3>
              <button className="btn-ghost stats-table-toggle" onClick={() => setShowTable((v) => !v)}>
                {showTable ? 'Show chart' : 'Show table'}
              </button>
            </div>
            {showTable ? (
              <table className="stats-table">
                <thead>
                  <tr>
                    <th>Day</th>
                    <th>Completed</th>
                  </tr>
                </thead>
                <tbody>
                  {[...stats.days].reverse().map((d) => (
                    <tr key={d.day}>
                      <td>{formatDay(d.day, true)}</td>
                      <td>{d.count}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            ) : (
              <DailyChart days={stats.days} />
            )}
          </section>

          <section className="stats-section">
            <div className="stats-section-header">
              <h3>Top tags</h3>
              <span className="stats-section-hint">last {range} days</span>
            </div>
            <TagBars tags={stats.tags} />
          </section>
        </>
      )}
    </div>
  )
}
