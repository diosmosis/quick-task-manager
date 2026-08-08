# Plugins

Quick Task Manager can be extended without editing any of its own files. A
plugin is an ordinary node module that hooks into events the app posts.

## Where plugins live

| Location | Purpose |
| --- | --- |
| `plugins/` in this repo | plugins shipped with the app |
| `plugins/` in the user-data directory | your own plugins |

The user-data directory is `~/.config/quick-task-manager` on Linux,
`~/Library/Application Support/quick-task-manager` on macOS, and
`%APPDATA%\quick-task-manager` on Windows.

Either directory may contain `myplugin.js` or `myplugin/index.js`. Entries
starting with `.` or `_` are ignored. If a user plugin has the same name as a
built-in one, the user's copy wins.

Enable, disable and configure plugins in the app's **Plugins** tab. Everything
ships disabled — a plugin that needs credentials does nothing useful until it
has been configured. The same tab has a **Reload plugins** button, which
re-reads both directories; use it after editing a plugin rather than restarting.

## Writing one

A plugin is CommonJS (`module.exports`, not `export`) and exports an object:

```js
module.exports = {
  name: 'my-plugin',            // optional; defaults to the file/folder name
  title: 'My plugin',           // shown in the Plugins tab
  description: 'What it does.',
  config: [                     // optional; renders as a form in the Plugins tab
    { key: 'apiKey', label: 'API key', type: 'password' }
  ],
  hooks: {
    'task:created': (payload, ctx) => ctx.log('new task', payload.task.description)
  }
}
```

Config fields are `{ key, label, type, placeholder?, help?, options? }`, where
`type` is `text`, `password`, `number`, `checkbox` or `select` (`select` takes
`options: [{ value, label }]`). Saved values arrive as `ctx.config`.

Plugins run in the app's main process with full node privileges — they are
trusted code, exactly as the app itself is. Only install ones you trust.

## Hooks

There are two kinds. **Filters** are chained: each enabled plugin receives the
previous value and returns a new one. **Events** are fire-and-forget; the
return value is ignored. A hook that throws is logged and skipped — it cannot
break the app.

| Hook | Kind | Payload |
| --- | --- | --- |
| `text:decorate` | filter | `segments` → `segments` |
| `app:ready` | event | `{}`, once the plugin registry has loaded |
| `task:created` | event | `{ task }` |
| `task:updated` | event | `{ task }` |
| `task:prioritized` | event | `{ task }` |
| `task:completed` | event | `{ task }` |
| `task:uncompleted` | event | `{ task }` |

### `text:decorate`

This is how a plugin changes the way task text is displayed. It receives the
segments a piece of text is currently made of and returns new ones:

```js
{ type: 'text', text }
{ type: 'link', text, href, title }   // href must be http(s)
```

Decoration starts as a single `text` segment covering the whole description,
and each plugin may split it further. The concatenated `text` of the segments
you return must equal what you were given — a decorator may change how text is
presented, never what it says. A returned `href` the app would refuse to open
is downgraded to plain text.

Two rules matter:

* **Do not await the network.** The hook runs while the app is waiting to draw
  the task list, so a slow hook is a slow app. Answer from what you already
  know, start any lookup in the background, and call `ctx.invalidate([text])`
  when it finishes — the app will then re-decorate that text.
* **Be a pure function of the text and your config.** Results are cached by
  text, so the same input must always give the same output.

`plugins/jira/index.js` is a worked example of both.

## The context object

Every hook gets `ctx` as its second argument:

| | |
| --- | --- |
| `ctx.config` | this plugin's saved configuration values |
| `ctx.cache` | a `Map`, kept for as long as the configuration is unchanged |
| `ctx.storage` | durable key/value storage: `get(key)`, `set(key, value, ttlMs)`, `delete(key)`, `clear()` |
| `ctx.fetch` | like `fetch`, but routed through the app's network stack so system proxy and certificate settings apply |
| `ctx.log(...)` | prefixed console logging |
| `ctx.invalidate(texts)` | tell the app that decorations of these texts are out of date |

`ctx.storage` is backed by the app's SQLite database, so it survives restarts
and is covered by the daily backup. `get` returns
`{ value, storedAt, expiresAt, expired }` or `null`; an expired entry is still
returned, flagged, so you can serve it immediately and refresh in the
background. Expired entries are pruned at startup.

Plugins are handed everything they need through `ctx` rather than requiring
modules from the app — a plugin in the user-data directory cannot resolve the
app's dependencies, and the API deliberately does not depend on where a plugin
was loaded from.
