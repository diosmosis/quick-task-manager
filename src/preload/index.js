import { contextBridge, ipcRenderer } from 'electron'

contextBridge.exposeInMainWorld('api', {
  loadTasks: () => ipcRenderer.invoke('tasks:load'),
  saveTasks: (tasks) => ipcRenderer.invoke('tasks:save', tasks),
  saveTasksSync: (tasks) => ipcRenderer.sendSync('tasks:save-sync', tasks),
  loadColumns: () => ipcRenderer.invoke('columns:load'),
  saveColumns: (columns) => ipcRenderer.invoke('columns:save', columns),
  saveColumnsSync: (columns) => ipcRenderer.sendSync('columns:save-sync', columns)
})
