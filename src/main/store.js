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
  ['spawnedFrom', 'TEXT']
]

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
    spawnedFrom: r.spawnedFrom ?? null
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
          recurrence, dueAt, autoPrioritizedFor, spawnedFrom)
       VALUES
         (@id, @description, @tags, @createdAt, @prioritized, @completed, @completedAt, @subtasks,
          @recurrence, @dueAt, @autoPrioritizedFor, @spawnedFrom)`
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
        spawnedFrom: t.spawnedFrom ?? null
      })
    }
  })
  write(tasks)
  return true
}

export function loadTasks() {
  return db.prepare('SELECT * FROM tasks').all().map(rowToTask)
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
       spawnedFrom TEXT
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
  maybeDailyBackup()
  // Also cover long-running sessions that cross midnight.
  setInterval(maybeDailyBackup, DAY_MS)
}
