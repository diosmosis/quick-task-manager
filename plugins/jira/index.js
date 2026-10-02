// JIRA integration.
//
// Finds ticket ids (MWP-20, ABC-1234) in task and subtask descriptions and
// turns them into links that open the ticket in the system browser. The API
// token is used to check that each id is a real issue, so that text which
// merely looks like a ticket id (COVID-19, UTF-8) is left alone.
//
// It also contributes a "Create JIRA ticket…" action to each task's ⋮ menu.
// That action opens a form this plugin ships itself, in ui/create-issue.jsx,
// which creates the issue through the REST API. Everything about creating an
// issue — the fields, the project and issue-type lookups, the request — lives
// in that file; all this one does for it is declare the action and name the
// origin its form is allowed to reach.
//
// The decorate hook never waits on the network. It answers immediately from
// what it already knows and starts a lookup in the background; when that
// lookup lands, ctx.invalidate() asks the app to re-decorate the affected
// text. See plugins/README.md for the hook contract.

// A JIRA project key is uppercase letters/digits starting with a letter.
const TICKET_RE = /\b([A-Z][A-Z0-9]+)-(\d+)\b/g

// Issues are essentially never deleted, so a confirmed id can be trusted for a
// long time. A negative answer gets a much shorter life: an id that does not
// exist today may well be created tomorrow.
const CONFIRMED_TTL_MS = 30 * 24 * 60 * 60 * 1000
const MISSING_TTL_MS = 24 * 60 * 60 * 1000
const REQUEST_TIMEOUT_MS = 8000

// Per-run bookkeeping, keyed by context so a config change starts clean.
const runtimes = new WeakMap()

function runtimeFor(ctx) {
  let runtime = runtimes.get(ctx)
  if (!runtime) {
    runtime = { known: new Map(), inflight: new Map() }
    runtimes.set(ctx, runtime)
  }
  return runtime
}

function siteOf(config) {
  const raw = typeof config.baseUrl === 'string' ? config.baseUrl.trim() : ''
  if (!raw) return null
  try {
    const url = new URL(raw)
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return null
    return { origin: url.origin, host: url.host }
  } catch {
    return null
  }
}

function authHeader(config) {
  const email = typeof config.email === 'string' ? config.email.trim() : ''
  const token = typeof config.apiToken === 'string' ? config.apiToken.trim() : ''
  if (!email || !token) return null
  // JIRA Cloud authenticates the REST API with the account email and an API
  // token as HTTP Basic credentials.
  return `Basic ${Buffer.from(`${email}:${token}`).toString('base64')}`
}

// What we currently believe about an issue key: from memory, then from the
// durable store. `stale` means it is still usable but should be re-checked.
function lookupKnown(ctx, runtime, cacheKey) {
  const remembered = runtime.known.get(cacheKey)
  if (remembered) return remembered

  const stored = ctx.storage.get(cacheKey)
  if (!stored) return null
  const entry = { ...stored.value, stale: stored.expired }
  runtime.known.set(cacheKey, entry)
  return entry
}

function verify(ctx, runtime, { site, auth, key, cacheKey, text }) {
  if (runtime.inflight.has(cacheKey)) return
  const request = (async () => {
    let result
    try {
      const response = await ctx.fetch(
        `${site.origin}/rest/api/3/issue/${encodeURIComponent(key)}?fields=summary`,
        {
          headers: { Authorization: auth, Accept: 'application/json' },
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
        }
      )

      if (response.status === 200) {
        const body = await response.json()
        result = { ok: true, summary: (body && body.fields && body.fields.summary) || '' }
      } else if (response.status === 404 || response.status === 400) {
        result = { ok: false, summary: '' }
      } else {
        // Rate limiting, an expired token, an outage — we have learned nothing
        // about the issue, so don't record an answer.
        ctx.log(`lookup for ${key} returned ${response.status}; leaving it linked`)
        return
      }
    } catch (err) {
      // Offline or blocked. The id stays linked so the app remains useful.
      ctx.log(`lookup for ${key} failed: ${(err && err.message) || err}`)
      return
    }

    runtime.known.set(cacheKey, result)
    ctx.storage.set(cacheKey, result, result.ok ? CONFIRMED_TTL_MS : MISSING_TTL_MS)
    ctx.invalidate([text])
  })()

  runtime.inflight.set(cacheKey, request)
  request.finally(() => runtime.inflight.delete(cacheKey))
}

// Splits every text segment on ticket ids, replacing the ones we are willing
// to link. Segments produced by an earlier plugin are left alone.
function decorate(segments, ctx) {
  const config = ctx.config || {}
  const site = siteOf(config)
  if (!site) return segments

  const auth = authHeader(config)
  const runtime = runtimeFor(ctx)
  const text = segments.map((s) => s.text).join('')
  const out = []

  for (const segment of segments) {
    if (segment.type !== 'text') {
      out.push(segment)
      continue
    }

    let last = 0
    TICKET_RE.lastIndex = 0
    let match
    while ((match = TICKET_RE.exec(segment.text)) !== null) {
      const key = match[0]
      const cacheKey = `${site.host}:${key}`
      const known = auth ? lookupKnown(ctx, runtime, cacheKey) : null

      // Unknown ids are linked optimistically and checked in the background,
      // so a working link never waits on a round trip. A stale confirmation is
      // used as-is and re-checked, since the summary may have changed.
      if (auth && (!known || known.stale)) {
        verify(ctx, runtime, { site, auth, key, cacheKey, text })
      }

      if (known && known.ok === false) continue // checked, and not a real issue

      if (match.index > last) {
        out.push({ type: 'text', text: segment.text.slice(last, match.index) })
      }
      out.push({
        type: 'link',
        text: key,
        href: `${site.origin}/browse/${key}`,
        title: known && known.summary ? `${key}: ${known.summary}` : `Open ${key} in JIRA`
      })
      last = match.index + key.length
    }

    if (last === 0) out.push(segment)
    else if (last < segment.text.length) {
      out.push({ type: 'text', text: segment.text.slice(last) })
    }
  }

  return out
}

// --- create a ticket from a task --------------------------------------------

// Offered whenever the plugin has a base URL — the same condition under which
// it does anything at all. Without credentials the form has no way to reach the
// API, so the row is shown disabled and says why rather than disappearing,
// which would look like the feature is missing rather than unconfigured.
function taskActions(_payload, ctx) {
  const config = ctx.config || {}
  if (!siteOf(config)) return []
  const authorized = Boolean(authHeader(config))
  return [
    {
      id: 'create-issue',
      label: 'Create JIRA ticket…',
      title: authorized
        ? 'Create a new JIRA issue from this task'
        : 'Add your account email and API token in plugin settings first',
      disabled: !authorized,
      // Renders ui/create-issue.jsx instead of running immediately.
      form: true
    }
  ]
}

// Where this plugin's form is allowed to send requests. The host asks before
// every request its UI makes and permits nothing else, so this is the whole of
// the form's reach — and it is derived from the base URL the user configured,
// not from anything the form itself supplies.
function uiOrigins(_payload, ctx) {
  const site = siteOf(ctx.config || {})
  return site ? [site.origin] : []
}

module.exports = {
  name: 'jira',
  title: 'JIRA integration',
  description:
    'Turns JIRA ticket ids in task and subtask descriptions into links that open in your browser, and adds a "Create JIRA ticket" action to each task menu that creates the issue and writes its key back onto the task. Ids are checked against the JIRA API so text that merely looks like a ticket id is left alone.',
  config: [
    {
      key: 'baseUrl',
      label: 'JIRA base URL',
      type: 'text',
      placeholder: 'https://your-team.atlassian.net',
      help: 'The address you use to reach JIRA. Required — without it nothing is linked.'
    },
    {
      key: 'email',
      label: 'Account email',
      type: 'text',
      placeholder: 'you@example.com',
      help: 'The account the API token belongs to.'
    },
    {
      key: 'apiToken',
      label: 'API token',
      type: 'password',
      help: 'Created under Atlassian account settings → Security → API tokens. Without an email and token, ids are linked without being checked.'
    },
    {
      key: 'projectKey',
      label: 'Default project for new tickets',
      type: 'text',
      placeholder: 'MWP',
      help: 'Pre-selected in the "Create JIRA ticket" form. Optional — the form lists every project you can create in, and remembers nothing you do not set here.'
    },
    {
      key: 'defaultIssueType',
      label: 'Default issue type for new tickets',
      type: 'text',
      placeholder: 'Task',
      // Not a select: issue types are defined per project and per instance, so
      // there is no list to offer here — the plugin's config schema is static
      // and read before anything has talked to JIRA.
      help: 'Matched by name against the types the chosen project offers, ignoring case. Optional, and ignored for a project that has no type by that name — the form then picks that project\'s first.'
    }
  ],
  hooks: {
    'text:decorate': decorate,
    'task:actions': taskActions,
    'ui:origins': uiOrigins
  }
}
