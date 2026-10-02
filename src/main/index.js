import { app, BrowserWindow, ipcMain } from 'electron'
import { join } from 'path'
import { initStore, loadTasks, saveTasks, loadColumns, saveColumns } from './store.js'
import {
  emitEvent,
  initPlugins,
  listPlugins,
  openExternal,
  reloadPlugins,
  runPluginFetch,
  runTaskAction,
  runTaskActions,
  runTextDecorate,
  safeExternalUrl,
  setPluginConfig,
  setPluginEnabled
} from './plugins.js'

let mainWindow = null

// Push a message to the renderer. Used by the plugin host to say that plugin
// state changed or that some decorated text is now stale.
function sendToRenderer(channel, payload) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(channel, payload)
  }
}

function createWindow() {
  const win = new BrowserWindow({
    show: false,
    autoHideMenuBar: true,
    // Linux window managers take the taskbar/panel icon from the window itself
    // (_NET_WM_ICON), not the .desktop entry. nativeImage can't read SVG, hence
    // a PNG rendering of assets/icon.svg.
    icon: join(__dirname, '../../assets/icon.png'),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false,
      contextIsolation: true
    }
  })
  mainWindow = win
  win.on('closed', () => {
    if (mainWindow === win) mainWindow = null
  })

  // Plugins can put links in the UI, so a stray middle-click or a handler that
  // misses preventDefault must not be able to navigate the app window away
  // from the renderer or spawn an Electron window pointed at the internet.
  win.webContents.setWindowOpenHandler(({ url }) => {
    openExternal(url)
    return { action: 'deny' }
  })

  win.webContents.on('will-navigate', (event, url) => {
    if (url === win.webContents.getURL()) return
    event.preventDefault()
    if (safeExternalUrl(url)) openExternal(url)
  })

  // Start maximized (spec requirement).
  win.once('ready-to-show', () => {
    win.maximize()
    win.show()
  })

  if (process.env['ELECTRON_RENDERER_URL']) {
    win.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    win.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

function focusMainWindow() {
  if (!mainWindow) return
  if (mainWindow.isMinimized()) mainWindow.restore()
  mainWindow.show()
  mainWindow.focus()
}

// Only one copy of the app may own the user-data directory. A second instance
// cannot open the profile's locked storage, so it would come up with empty UI
// state and silently discard anything done in it — launching again just raises
// the window that is already running.
if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.on('second-instance', focusMainWindow)

  app.whenReady().then(() => {
    initStore()
    initPlugins(sendToRenderer)

    ipcMain.handle('tasks:load', () => loadTasks())
    ipcMain.handle('tasks:save', (_event, tasks) => saveTasks(tasks))
    ipcMain.handle('columns:load', () => loadColumns())
    ipcMain.handle('columns:save', (_event, columns) => saveColumns(columns))

    // Synchronous saves used on window close so pending changes are flushed to
    // disk before the process exits.
    ipcMain.on('tasks:save-sync', (event, tasks) => {
      try {
        saveTasks(tasks)
      } catch (err) {
        console.error('Failed to save tasks synchronously:', err)
      }
      event.returnValue = true
    })

    ipcMain.on('columns:save-sync', (event, columns) => {
      try {
        saveColumns(columns)
      } catch (err) {
        console.error('Failed to save columns synchronously:', err)
      }
      event.returnValue = true
    })

    ipcMain.handle('plugins:list', () => listPlugins())
    ipcMain.handle('plugins:set-enabled', (_event, name, enabled) =>
      setPluginEnabled(name, enabled)
    )
    ipcMain.handle('plugins:set-config', (_event, name, values) =>
      setPluginConfig(name, values)
    )
    ipcMain.handle('plugins:reload', () => reloadPlugins())
    // Batched: the renderer sends every description it needs at once, so a
    // full task list costs one round trip rather than one per task.
    ipcMain.handle('plugins:decorate', (_event, texts) => runTextDecorate(texts))
    ipcMain.on('plugins:event', (_event, name, payload) => emitEvent(name, payload))
    // Asked when a task's ⋮ menu is opened, rather than for every visible card.
    ipcMain.handle('plugins:task-actions', (_event, task) => runTaskActions(task))
    ipcMain.handle('plugins:run-task-action', (_event, name, actionId, task) =>
      runTaskAction(name, actionId, task)
    )
    // Lets a plugin's own form reach its own service. The renderer cannot make
    // the request itself — the CSP forbids it and CORS would refuse it — and
    // the plugin host restricts each caller to the origins that plugin names.
    ipcMain.handle('plugins:fetch', (_event, name, url, init) =>
      runPluginFetch(name, url, init)
    )

    ipcMain.handle('shell:open-external', (_event, url) => openExternal(url))

    createWindow()

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow()
    })
  })

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit()
  })
}
