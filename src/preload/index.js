import { contextBridge, ipcRenderer } from 'electron'

// Subscribe to a main-process push channel, handing the renderer back an
// unsubscribe function rather than exposing ipcRenderer itself.
function subscribe(channel, callback) {
  const handler = (_event, payload) => callback(payload)
  ipcRenderer.on(channel, handler)
  return () => ipcRenderer.removeListener(channel, handler)
}

contextBridge.exposeInMainWorld('api', {
  loadTasks: () => ipcRenderer.invoke('tasks:load'),
  saveTasks: (tasks) => ipcRenderer.invoke('tasks:save', tasks),
  saveTasksSync: (tasks) => ipcRenderer.sendSync('tasks:save-sync', tasks),
  loadColumns: () => ipcRenderer.invoke('columns:load'),
  saveColumns: (columns) => ipcRenderer.invoke('columns:save', columns),
  saveColumnsSync: (columns) => ipcRenderer.sendSync('columns:save-sync', columns),

  listPlugins: () => ipcRenderer.invoke('plugins:list'),
  setPluginEnabled: (name, enabled) =>
    ipcRenderer.invoke('plugins:set-enabled', name, enabled),
  setPluginConfig: (name, values) => ipcRenderer.invoke('plugins:set-config', name, values),
  reloadPlugins: () => ipcRenderer.invoke('plugins:reload'),
  decorateTexts: (texts) => ipcRenderer.invoke('plugins:decorate', texts),
  emitPluginEvent: (name, payload) => ipcRenderer.send('plugins:event', name, payload),
  onPluginsChanged: (cb) => subscribe('plugins:changed', cb),
  onDecorationInvalidated: (cb) => subscribe('plugins:decoration-invalidated', cb),

  openExternal: (url) => ipcRenderer.invoke('shell:open-external', url)
})
