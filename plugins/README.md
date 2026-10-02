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

There are three kinds. **Filters** are chained: each enabled plugin receives the
previous value and returns a new one. **Events** are fire-and-forget; the
return value is ignored. **Providers** are asked independently: every enabled
plugin gets the same input and the answers are concatenated, so one plugin never
sees or changes another's. A hook that throws is logged and skipped — it cannot
break the app.

| Hook | Kind | Payload |
| --- | --- | --- |
| `text:decorate` | filter | `segments` → `segments` |
| `task:actions` | provider | `{ task }` → `[action]` |
| `task:action` | event | `{ task, actionId }`, when the user picks one |
| `ui:origins` | provider | `{}` → `[origin]` your form may request |
| `app:ready` | event | `{}`, once the plugin registry has loaded |
| `task:created` | event | `{ task }` |
| `task:updated` | event | `{ task }` |
| `task:prioritized` | event | `{ task }` |
| `task:completed` | event | `{ task }` |
| `task:uncompleted` | event | `{ task }` |
| `task:deleted` | event | `{ task }`, the task as it was before deletion |

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

`plugins/jira/index.js` is a worked example of both, and
`plugins/jira/ui/create-issue.jsx` of the form described below.

### `task:actions` and `task:action`

This is how a plugin offers the user an operation. `task:actions` is asked when
a task's ⋮ menu is opened and returns the rows to show:

```js
{ id, label, title, disabled }   // id and label required; title is a tooltip
```

Picking a row calls `task:action` with `{ task, actionId }` on the plugin that
contributed it. Two hooks rather than one because the list crosses into the
renderer, and a function cannot travel with it.

```js
hooks: {
  'task:actions': ({ task }, ctx) =>
    ctx.config.baseUrl ? [{ id: 'open', label: 'Open somewhere…' }] : [],
  'task:action': async ({ task, actionId }, ctx) => {
    await ctx.openExternal(`${ctx.config.baseUrl}/thing/${task.id}`)
  }
}
```

Return nothing (or anything without `ok: false`) to report success. To report a
failure, return `{ ok: false, message }` — the message is shown in the menu,
which stays open. A hook that throws is reported the same way.

The ⋮ button does not appear at all unless some enabled plugin registers
`task:actions`, so returning `[]` when your plugin is unconfigured leaves the
card exactly as it was.

`task:actions` runs while the user is waiting for the menu to draw, so answer
from what you already know. **`task:action` is exempt from the no-network
rule** — it runs on a click, and the app shows the row as pending until it
resolves.

### Actions that open a form

An action that needs input from the user before it can do anything sets
`form: true` instead of doing its work in `task:action`. The app then renders a
**React component you ship yourself**, in `ui/<action-id>.jsx` next to your
`index.js` — the file name is the action id, so there is nothing to register:

```
plugins/jira/
  index.js               hooks, config
  ui/create-issue.jsx     the form for the `create-issue` action
```

The component is given props and reports back through them:

| | |
| --- | --- |
| `task` | the task the menu was opened on |
| `config` | your saved configuration values |
| `fetch` | like `fetch`, but able to reach the origins you declare (below) |
| `openExternal(url)` | open an `http(s)` URL in the system browser |
| `onBusy(bool)` | say work is in flight, so the dialog cannot be dismissed under it |
| `onDone(result)` | finish. `{ appendToDescription }` adds text to the task |
| `onCancel()` | close without doing anything |

`onDone` is the only way to change the task: a plugin never writes task text
itself. Style your fields with `plugin-form-fields`, `plugin-field` and
`plugin-form-actions` and they will match the rest of the app.

An exception thrown while rendering is caught and shown inside the dialog, so a
broken form cannot take the window down with it.

**This is available to plugins in the repo's `plugins/` folder only.** The
component is compiled into the app when it is built, because the renderer's
content-security policy forbids evaluating code that arrives at runtime.
A plugin in the user-data directory can still contribute actions that run
without a form, but cannot ship UI. Editing a form needs `npm run build`, not
the **Reload plugins** button.

### `ui:origins`

Your form runs in the renderer, which cannot reach the network: the app's CSP
allows it to talk only to itself, and a service like JIRA would refuse a
cross-origin request from it anyway. The `fetch` your component is given
therefore makes the request in the main process instead — and asks this hook
first, every time, which addresses it is allowed to reach:

```js
'ui:origins': (_payload, ctx) => [new URL(ctx.config.baseUrl).origin]
```

Return the origins your form needs and nothing more. Anything that is not an
`http(s)` URL is discarded, a request to an origin you did not name is refused,
and **a plugin that does not register this hook gets no network from its UI at
all.** Deriving the list from your own configuration, as above, means the reach
of your form is whatever the user pointed you at.

Requests carry no `AbortSignal` — one cannot survive the trip and would appear
to work while doing nothing — so the app applies its own timeout.

They also carry `User-Agent: quick-task-manager/<version>` unless you set your
own. The request goes through Chromium's network stack, which would otherwise
label it as a full browser — and services defend against browsers making
authenticated state-changing calls. JIRA's XSRF filter rejects exactly that,
with a 403 that looks like a permissions problem and isn't. Override the header
only if the service you talk to expects something specific.

A refused or failed request rejects, and the `Error` carries a `request`
property (`{ method, url }`) so a form can say which call failed — nothing came
back to inspect in that case. A request that *did* reach the service resolves
normally whatever its status, so `response.status`, `response.headers` and the
body are all yours to report. Do report them: services explain a refusal in
different places, and a form that shows only a status code makes its own
failures unactionable. `plugins/jira/ui/create-issue.jsx` is a worked example.

## The context object

Every hook gets `ctx` as its second argument:

| | |
| --- | --- |
| `ctx.config` | this plugin's saved configuration values |
| `ctx.cache` | a `Map`, kept for as long as the configuration is unchanged |
| `ctx.storage` | durable key/value storage: `get(key)`, `set(key, value, ttlMs)`, `delete(key)`, `clear()` |
| `ctx.fetch` | like `fetch`, but routed through the app's network stack so system proxy and certificate settings apply |
| `ctx.log(...)` | prefixed console logging |
| `ctx.openExternal(url)` | open an `http(s)` URL in the system browser; resolves `false` if the URL was refused |
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
