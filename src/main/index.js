import { app, BrowserWindow, ipcMain } from 'electron'
import { join } from 'path'
import { initStore, loadTasks, saveTasks, loadColumns, saveColumns } from './store.js'

let mainWindow = null

function createWindow() {
  const win = new BrowserWindow({
    show: false,
    autoHideMenuBar: true,
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

    createWindow()

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow()
    })
  })

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit()
  })
}
