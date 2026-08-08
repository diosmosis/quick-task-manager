// Renderer-side cache for plugin-decorated text.
//
// Decoration happens in the main process (that is where plugins live), so it
// is asynchronous. Three things keep that from being visible:
//
//   * results are cached by text, so a re-render never re-asks;
//   * requests are batched into one IPC per React commit, so a list of thirty
//     tasks costs one round trip rather than thirty;
//   * prime() pre-warms the cache on the already-async task load, so the very
//     first paint has its segments in hand.
//
// Decoration is required to be a pure function of text + plugin config, which
// is what makes the text itself a safe cache key.

const cache = new Map()
// Kept across an invalidation so descriptions don't blink back to plain text
// for a frame while the fresh answers are in flight.
let staleCache = new Map()
const pending = new Set()
const inflight = new Set()
const listeners = new Set()

let version = 0
let epoch = 0
let flushScheduled = false

function emit() {
  version++
  for (const listener of listeners) listener()
}

export function subscribe(listener) {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function getVersion() {
  return version
}

// The segments to render right now, requesting fresh ones if what we have is
// missing or stale. Returning the stale value while the request is in flight is
// what stops descriptions blinking back to plain text when a plugin changes.
export function resolve(text) {
  if (!text) return null
  const fresh = cache.get(text)
  if (fresh) return fresh
  request(text)
  return staleCache.get(text) || null
}

function store(text, segments) {
  cache.set(text, segments)
  staleCache.delete(text)
}

function schedule() {
  if (flushScheduled) return
  flushScheduled = true
  // A microtask coalesces everything rendered in one commit into a single call.
  queueMicrotask(flush)
}

async function flush() {
  flushScheduled = false
  const batch = [...pending].filter((t) => !inflight.has(t))
  pending.clear()
  if (batch.length === 0) return

  for (const text of batch) inflight.add(text)
  const sentEpoch = epoch
  try {
    const { epoch: gotEpoch, results } = await window.api.decorateTexts(batch)
    // A plugin was enabled or reconfigured mid-flight — these answers describe
    // the old configuration, so drop them and let the retry re-ask.
    if (gotEpoch !== sentEpoch) return
    batch.forEach((text, i) => store(text, results[i]))
    emit()
  } catch {
    // Leave it uncached; the next render requests it again.
  } finally {
    for (const text of batch) inflight.delete(text)
  }
}

export function request(text) {
  if (!text || cache.has(text) || inflight.has(text)) return
  pending.add(text)
  schedule()
}

// Pre-warm a whole set of texts and resolve once they are cached.
export function prime(texts) {
  const missing = [...new Set(texts)].filter((t) => t && !cache.has(t) && !inflight.has(t))
  if (missing.length === 0) return Promise.resolve()

  for (const text of missing) inflight.add(text)
  const sentEpoch = epoch
  return window.api
    .decorateTexts(missing)
    .then(({ epoch: gotEpoch, results }) => {
      if (gotEpoch !== sentEpoch) return
      missing.forEach((text, i) => store(text, results[i]))
      emit()
    })
    .catch(() => {})
    .finally(() => {
      for (const text of missing) inflight.delete(text)
    })
}

// Every description and subtask description in a task list.
export function collectTexts(tasks) {
  const texts = []
  for (const task of tasks) {
    if (task.description) texts.push(task.description)
    for (const sub of task.subtasks || []) {
      if (sub.description) texts.push(sub.description)
    }
  }
  return texts
}

// A plugin was enabled, disabled or reconfigured: everything may decorate
// differently now.
export function invalidateAll(nextEpoch) {
  if (typeof nextEpoch === 'number') epoch = nextEpoch
  staleCache = cache.size > 0 ? new Map(cache) : staleCache
  cache.clear()
  pending.clear()
  inflight.clear()
  emit()
}

// A plugin finished a background lookup and these texts may now decorate
// differently (a JIRA ticket that turned out not to exist, say).
export function invalidateTexts(texts) {
  let touched = false
  for (const text of texts) {
    const existing = cache.get(text)
    if (existing) {
      staleCache.set(text, existing)
      cache.delete(text)
      touched = true
    }
  }
  if (touched) emit()
}
