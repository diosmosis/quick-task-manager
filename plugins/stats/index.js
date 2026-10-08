// Completion statistics.
//
// Adds a "Stats" tab showing how many tasks have been completed recently, a
// day-by-day chart, a streak, the busiest tags and how long tasks take from
// creation to completion. The tab itself is views/stats.jsx; this file only
// keeps the history it draws from.
//
// The history has to be kept here because the app forgets completed tasks
// after 14 days. Each completion is logged to ctx.storage as it happens, and
// undoing a completion withdraws the entry, so the log is the set of tasks
// that are actually done. Only what the statistics need is stored — no
// descriptions or notes. Completions made while this plugin was disabled are
// not logged, but anything still in the Archive is merged in by the view.

const LOG_KEY = 'completions'

function readLog(ctx) {
  const entry = ctx.storage.get(LOG_KEY)
  return entry && entry.value && typeof entry.value === 'object' ? entry.value : {}
}

module.exports = {
  title: 'Completion stats',
  description:
    'Adds a Stats tab with basic statistics about completed tasks. ' +
    'History is recorded while the plugin is enabled.',
  views: [{ id: 'stats', label: 'Stats' }],
  hooks: {
    'task:completed': ({ task }, ctx) => {
      if (!task || !task.id) return
      const log = readLog(ctx)
      log[task.id] = {
        completedAt: task.completedAt || Date.now(),
        createdAt: typeof task.createdAt === 'number' ? task.createdAt : null,
        tags: Array.isArray(task.tags) ? task.tags : []
      }
      ctx.storage.set(LOG_KEY, log)
    },

    'task:uncompleted': ({ task }, ctx) => {
      if (!task || !task.id) return
      const log = readLog(ctx)
      if (!(task.id in log)) return
      delete log[task.id]
      ctx.storage.set(LOG_KEY, log)
    },

    // Retagging a completed task from the Archive should move its count with it.
    'task:updated': ({ task }, ctx) => {
      if (!task || !task.id || !Array.isArray(task.tags)) return
      const log = readLog(ctx)
      if (!log[task.id]) return
      log[task.id] = { ...log[task.id], tags: task.tags }
      ctx.storage.set(LOG_KEY, log)
    },

    // The view's only question is "what have you recorded?".
    'view:query': (_payload, ctx) => readLog(ctx)
  }
}
