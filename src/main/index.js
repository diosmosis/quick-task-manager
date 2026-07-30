import { app, BrowserWindow, ipcMain } from 'electron'
import { join } from 'path'
import { initStore, loadTasks, saveTasks } from './store.js'

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

app.whenReady().then(() => {
  initStore()

  ipcMain.handle('tasks:load', () => loadTasks())
  ipcMain.handle('tasks:save', (_event, tasks) => saveTasks(tasks))

  // Synchronous save used on window close so pending changes are flushed to
  // disk before the process exits.
  ipcMain.on('tasks:save-sync', (event, tasks) => {
    try {
      saveTasks(tasks)
    } catch (err) {
      console.error('Failed to save tasks synchronously:', err)
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
