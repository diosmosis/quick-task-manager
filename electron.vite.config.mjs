import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = dirname(fileURLToPath(import.meta.url))

export default defineConfig({
  // externalizeDepsPlugin keeps native/node dependencies (better-sqlite3) out of
  // the bundle so they are required from node_modules at runtime.
  main: {
    plugins: [externalizeDepsPlugin()]
  },
  preload: {
    plugins: [externalizeDepsPlugin()]
  },
  // The renderer root is src/renderer, but plugins ship their own form
  // components under plugins/<name>/ui/. Those are imported into the bundle
  // (the CSP rules out evaluating them at runtime — see utils/pluginUi.js), so
  // the dev server has to be allowed to serve from outside its root.
  renderer: {
    plugins: [react()],
    server: {
      fs: { allow: [resolve(root, 'src/renderer'), resolve(root, 'plugins')] }
    }
  }
})
