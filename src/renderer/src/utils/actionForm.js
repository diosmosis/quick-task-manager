// The plugin form that is currently open, if any.
//
// The ⋮ menu lives deep inside a task card, and the dialog it opens has to be
// mounted at the top of the app instead — TaskItem swaps its whole subtree out
// when the card enters edit mode, which would throw away a half-filled form.
// Lifting it the way the notes sheet is lifted would mean threading a callback
// through all three views, none of which have any stake in plugin machinery;
// change 23 deliberately kept them out of it. So the request travels through a
// module store, the same shape as pluginActions.js and decorate.js.

const listeners = new Set()
let target = null // { task, action } | null

function emit() {
  for (const listener of listeners) listener()
}

export function subscribe(listener) {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function getTarget() {
  return target
}

export function openForm(task, action) {
  target = { task, action }
  emit()
}

export function closeForm() {
  if (!target) return
  target = null
  emit()
}
