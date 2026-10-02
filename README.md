# Quick Task Manager

An Electron + React desktop app for managing a todo list: create tasks with inline
`#hashtag` tags, organize them, and prioritize them per tag until completed.

## Features

- **Task creation** — a single input; type a description plus `#tags` (e.g.
  `Email the client #work #urgent`) and press Enter or click **Add**.
- **Inbox view** — all active (non-completed) tasks. Filter by text or tag, sort by
  text or creation date. A ★ button toggles priority on each task.
- **Prioritize view** — one column per tag you choose. Each column has a search box
  (above the scroll area) to find and prioritize matching tasks; already-prioritized
  tasks are excluded from the search. De-prioritizing asks for confirmation first.
- **Completion** — in the Prioritize view a ✓ marks a task done (shown faded and
  struck through). Click again to undo. 15 minutes after completion (if not undone)
  the task leaves the Prioritize view.
- **Archive view** — completed tasks live here for 14 days, then are removed
  permanently.
- **Editing** — click a task in any view to edit its description and tags inline, or
  pick **Edit task…** from the ⋮ menu on the card (which is the reliable way in when
  a long description leaves nothing free to click).
- **Status** — a free-form progress label ("in progress", "blocked", …), set in the
  task editor and shown on the card as a color-coded chip, from the same palette as
  the tags. Statuses already in use are offered as completions.
- The window starts maximized.

## Requirements

- Node.js 18+ and npm.

## Setup

```bash
npm install
```

## Run (development)

```bash
npm run dev
```

## Build / preview production output

```bash
npm run build
npm run preview
```

### Linux: add to the application menu

```bash
npm run build
npm run install-desktop
```

This installs `assets/quick-task-manager.desktop` into
`~/.local/share/applications`, with its `Exec`/`Icon` paths pointed at this
checkout. The entry runs `launch.sh`, which starts the production build.
Re-run it if you move the checkout.

### Linux note: chrome-sandbox

On some Linux systems Electron aborts at startup with a `chrome-sandbox` /
`setuid sandbox` permission error. `npm run dev` avoids this by passing
`--noSandbox`. For `npm run preview` (or a packaged build), fix it once with:

```bash
sudo chown root:root node_modules/electron/dist/chrome-sandbox
sudo chmod 4755 node_modules/electron/dist/chrome-sandbox
```

## Data storage

Tasks are persisted in a **SQLite database** (`tasks.db`) in Electron's per-user data
directory (`app.getPath('userData')`), via `better-sqlite3`. An existing legacy
`tasks.json` is automatically migrated into the database on first run. The chosen
prioritization columns are stored in the renderer's `localStorage`.

A backup of the database is made at most once per day into a `backups/` subfolder
(`tasks-YYYY-MM-DD.db`); only the three most recent backups are kept.

### Native module note

`better-sqlite3` is a native module and must be compiled against Electron's ABI.
This happens automatically on `npm install` (via the `postinstall` script). If you
ever hit a `NODE_MODULE_VERSION` mismatch, rebuild it manually:

```bash
npm run rebuild
```
