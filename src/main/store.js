import Database from 'better-sqlite3'
import { app } from 'electron'
import { join } from 'path'
import {
  existsSync,
  readFileSync,
  renameSync,
  mkdirSync,
  copyFileSync,
  readdirSync,
  unlinkSync
} from 'fs'

// Columns added after the first release, applied to existing databases with
// ALTER TABLE on startup.
const ADDED_COLUMNS = [
  ['subtasks', "TEXT NOT NULL DEFAULT '[]'"],
  ['recurrence', 'TEXT'],
  ['dueAt', 'INTEGER'],
  ['autoPrioritizedFor', 'INTEGER'],
  ['spawnedFrom', 'TEXT'],
  ['notes', "TEXT NOT NULL DEFAULT ''"],
  ['status', "TEXT NOT NULL DEFAULT ''"]
]

// Keys used in the `settings` table (small bits of UI state that must be as
// durable as the tasks themselves).
const COLUMNS_SETTING = 'priorityColumns'
const ORDER_SETTING = 'priorityOrder'

const MAX_BACKUPS = 3
const BACKUP_PREFIX = 'tasks-'
const BACKUP_SUFFIX = '.db'
const DAY_MS = 24 * 60 * 60 * 1000

let db

const dbPath = () => join(app.getPath('userData'), 'tasks.db')
const backupsDir = () => join(app.getPath('userData'), 'backups')

function rowToTask(r) {
  return {
    id: r.id,
    description: r.description,
    tags: JSON.parse(r.tags),
    createdAt: r.createdAt,
    prioritized: !!r.prioritized,
    completed: !!r.completed,
    completedAt: r.completedAt ?? null,
    subtasks: r.subtasks ? JSON.parse(r.subtasks) : [],
    recurrence: r.recurrence ? JSON.parse(r.recurrence) : null,
    dueAt: r.dueAt ?? null,
    autoPrioritizedFor: r.autoPrioritizedFor ?? null,
    spawnedFrom: r.spawnedFrom ?? null,
    notes: r.notes ?? '',
    status: r.status ?? ''
  }
}

// Persist the full task list. Tasks are small in number, so a transactional
// replace-all keeps the store dead simple and always consistent with the UI.
export function saveTasks(tasks) {
  const write = db.transaction((list) => {
    db.prepare('DELETE FROM tasks').run()
    const insert = db.prepare(
      `INSERT INTO tasks
         (id, description, tags, createdAt, prioritized, completed, completedAt, subtasks,
          recurrence, dueAt, autoPrioritizedFor, spawnedFrom, notes, status)
       VALUES
         (@id, @description, @tags, @createdAt, @prioritized, @completed, @completedAt, @subtasks,
          @recurrence, @dueAt, @autoPrioritizedFor, @spawnedFrom, @notes, @status)`
    )
    for (const t of list) {
      insert.run({
        id: t.id,
        description: t.description ?? '',
        tags: JSON.stringify(t.tags ?? []),
        createdAt: t.createdAt,
        prioritized: t.prioritized ? 1 : 0,
        completed: t.completed ? 1 : 0,
        completedAt: t.completedAt ?? null,
        subtasks: JSON.stringify(t.subtasks ?? []),
        recurrence: t.recurrence ? JSON.stringify(t.recurrence) : null,
        dueAt: t.dueAt ?? null,
        autoPrioritizedFor: t.autoPrioritizedFor ?? null,
        spawnedFrom: t.spawnedFrom ?? null,
        notes: t.notes ?? '',
        status: t.status ?? ''
      })
    }
  })
  write(tasks)
  return true
}

export function loadTasks() {
  return db.prepare('SELECT * FROM tasks').all().map(rowToTask)
}

// Generic access to the `settings` table. Returns null — not a default — when a
// key has never been stored, so callers can tell "no value" apart from "the
// value is empty" and never mistake a missing row for a deliberate choice.
export function getSetting(key) {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key)
  if (!row) return null
  try {
    return JSON.parse(row.value)
  } catch {
    return null
  }
}

export function setSetting(key, value) {
  db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run(
    key,
    JSON.stringify(value)
  )
  return true
}

// The prioritization view's column list. Null when never stored (see above).
export function loadColumns() {
  const stored = getSetting(COLUMNS_SETTING)
  return Array.isArray(stored) ? stored : null
}

export function saveColumns(columns) {
  return setSetting(COLUMNS_SETTING, Array.isArray(columns) ? columns : [])
}

// The hand-arranged order of tasks within each prioritization column, as
// { [tag]: [taskId, …] }. Per column because a task with several tags sits in
// several columns, and its place in one says nothing about its place in
// another. Null when never stored.
export function loadPriorityOrder() {
  const stored = getSetting(ORDER_SETTING)
  return stored && typeof stored === 'object' && !Array.isArray(stored) ? stored : null
}

export function savePriorityOrder(order) {
  const valid = order && typeof order === 'object' && !Array.isArray(order)
  return setSetting(ORDER_SETTING, valid ? order : {})
}

// Durable, TTL-aware key/value storage for plugins. Plugins use it to remember
// the results of expensive lookups (a JIRA issue check, say) across restarts;
// keeping it here rather than in a plugin-owned file means it is as durable as
// the tasks and rides along in the daily backup for free.
export function cacheGet(plugin, key, now = Date.now()) {
  const row = db
    .prepare('SELECT value, storedAt, expiresAt FROM plugin_cache WHERE plugin = ? AND key = ?')
    .get(plugin, key)
  if (!row) return null
  let value
  try {
    value = JSON.parse(row.value)
  } catch {
    return null
  }
  // Expired entries are returned, flagged — that lets a caller serve a stale
  // value instantly and re-validate in the background instead of blocking.
  return {
    value,
    storedAt: row.storedAt,
    expiresAt: row.expiresAt ?? null,
    expired: row.expiresAt != null && row.expiresAt <= now
  }
}

export function cacheSet(plugin, key, value, ttlMs = null, now = Date.now()) {
  db.prepare(
    `INSERT OR REPLACE INTO plugin_cache (plugin, key, value, storedAt, expiresAt)
     VALUES (?, ?, ?, ?, ?)`
  ).run(plugin, key, JSON.stringify(value), now, ttlMs == null ? null : now + ttlMs)
  return true
}

export function cacheDelete(plugin, key) {
  db.prepare('DELETE FROM plugin_cache WHERE plugin = ? AND key = ?').run(plugin, key)
  return true
}

export function cacheClear(plugin) {
  db.prepare('DELETE FROM plugin_cache WHERE plugin = ?').run(plugin)
  return true
}

// Drop entries past their expiry so the table can't grow without bound.
export function prunePluginCache(now = Date.now()) {
  db.prepare('DELETE FROM plugin_cache WHERE expiresAt IS NOT NULL AND expiresAt <= ?').run(now)
}

// One-time import of a legacy tasks.json file, if present and the DB is empty.
function migrateFromJson() {
  const count = db.prepare('SELECT COUNT(*) AS c FROM tasks').get().c
  if (count > 0) return

  const jsonPath = join(app.getPath('userData'), 'tasks.json')
  if (!existsSync(jsonPath)) return

  try {
    const parsed = JSON.parse(readFileSync(jsonPath, 'utf-8'))
    if (Array.isArray(parsed) && parsed.length > 0) {
      saveTasks(parsed)
      console.log(`Migrated ${parsed.length} task(s) from tasks.json into SQLite.`)
    }
    // Keep the old file around (renamed) so it isn't re-imported.
    renameSync(jsonPath, `${jsonPath}.migrated`)
  } catch (err) {
    console.error('Failed to migrate tasks.json:', err)
  }
}

// Create at most one backup per calendar day and keep only the newest few.
export function maybeDailyBackup() {
  try {
    const dir = backupsDir()
    mkdirSync(dir, { recursive: true })

    const today = new Date().toISOString().slice(0, 10) // YYYY-MM-DD
    const dest = join(dir, `${BACKUP_PREFIX}${today}${BACKUP_SUFFIX}`)
    if (!existsSync(dest)) {
      copyFileSync(dbPath(), dest)
      console.log(`Created daily tasks backup: ${dest}`)
    }

    // Date-stamped names sort chronologically, so lexical sort is oldest-first.
    const backups = readdirSync(dir)
      .filter((f) => f.startsWith(BACKUP_PREFIX) && f.endsWith(BACKUP_SUFFIX))
      .sort()
    while (backups.length > MAX_BACKUPS) {
      const oldest = backups.shift()
      unlinkSync(join(dir, oldest))
    }
  } catch (err) {
    console.error('Daily backup failed:', err)
  }
}

export function initStore() {
  db = new Database(dbPath())
  db.pragma('journal_mode = DELETE') // single-file DB keeps backups trivial
  db.exec(
    `CREATE TABLE IF NOT EXISTS tasks (
       id TEXT PRIMARY KEY,
       description TEXT NOT NULL DEFAULT '',
       tags TEXT NOT NULL DEFAULT '[]',
       createdAt INTEGER NOT NULL,
       prioritized INTEGER NOT NULL DEFAULT 0,
       completed INTEGER NOT NULL DEFAULT 0,
       completedAt INTEGER,
       subtasks TEXT NOT NULL DEFAULT '[]',
       recurrence TEXT,
       dueAt INTEGER,
       autoPrioritizedFor INTEGER,
       spawnedFrom TEXT,
       notes TEXT NOT NULL DEFAULT '',
       status TEXT NOT NULL DEFAULT ''
     )`
  )

  // UI state that used to live in the renderer's localStorage. Chromium commits
  // localStorage lazily (~5s) and it is per-origin and per-profile-lock, so a
  // non-graceful exit, a dev/packaged origin switch, or a second instance could
  // all lose it. Keeping it here makes it exactly as durable as the tasks, and
  // it rides along in the daily backup for free.
  db.exec(
    `CREATE TABLE IF NOT EXISTS settings (
       key TEXT PRIMARY KEY,
       value TEXT NOT NULL
     )`
  )

  db.exec(
    `CREATE TABLE IF NOT EXISTS plugin_cache (
       plugin TEXT NOT NULL,
       key TEXT NOT NULL,
       value TEXT NOT NULL,
       storedAt INTEGER NOT NULL,
       expiresAt INTEGER,
       PRIMARY KEY (plugin, key)
     )`
  )

  // Bring databases created by earlier versions up to the current shape.
  const cols = db.prepare('PRAGMA table_info(tasks)').all()
  for (const [name, decl] of ADDED_COLUMNS) {
    if (!cols.some((c) => c.name === name)) {
      db.exec(`ALTER TABLE tasks ADD COLUMN ${name} ${decl}`)
    }
  }

  migrateFromJson()
  prunePluginCache()
  maybeDailyBackup()
  // Also cover long-running sessions that cross midnight.
  setInterval(maybeDailyBackup, DAY_MS)
}
