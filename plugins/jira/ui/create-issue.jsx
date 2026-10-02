// The "Create JIRA ticket…" form.
//
// This runs in the renderer, but its `fetch` prop is not the renderer's: the
// app's CSP forbids the page from reaching anything but itself, and JIRA would
// refuse a cross-origin call from a file:// page anyway. So requests are made
// on the app's main process and the response handed back — see runPluginFetch
// in src/main/plugins.js. The app restricts it to the origins this plugin
// declares from its `ui:origins` hook, which is the configured base URL.
//
// Props supplied by the host: task, config (this plugin's saved settings),
// fetch, openExternal, onBusy, onDone, onCancel. Reporting the created key back
// through onDone is what puts it on the task — a plugin never writes task text
// itself.
//
// A failed request reports everything it knows rather than a status code. JIRA
// answers 403 for several unrelated reasons — an unlicensed account, a missing
// project permission, a token whose grants don't cover writes, a session check
// — and which one it is lives in the response body, or in headers when the body
// is empty. Discarding those makes the failure unactionable, so `describeFailure`
// keeps the lot.
import { useEffect, useRef, useState } from 'react'

// Enough of a body to identify the failure without pasting a whole HTML error
// page into the dialog.
const MAX_BODY_CHARS = 4000

// Headers JIRA uses to explain a refusal. `x-arequestid` is the id Atlassian
// support asks for; the rest say what kind of refusal it was.
const DIAGNOSTIC_HEADERS = [
  'content-type',
  'www-authenticate',
  'x-seraph-loginreason',
  'x-authentication-denied-reason',
  'x-arequestid',
  'retry-after'
]

function origin(config) {
  try {
    const url = new URL(String(config.baseUrl || '').trim())
    return url.origin
  } catch {
    return null
  }
}

function auth(config) {
  const email = String(config.email || '').trim()
  const token = String(config.apiToken || '').trim()
  if (!email || !token) return null
  return `Basic ${btoa(`${email}:${token}`)}`
}

// JIRA's REST v3 takes rich text as Atlassian Document Format rather than a
// string. Blank lines separate paragraphs; single newlines inside one become
// hard breaks, which is what a plain-text note means by them.
function toAdf(text) {
  const trimmed = String(text || '').trim()
  if (!trimmed) return null
  const paragraphs = trimmed.split(/\n\s*\n/)
  return {
    type: 'doc',
    version: 1,
    content: paragraphs.map((para) => {
      const content = []
      para.split('\n').forEach((line, i) => {
        if (i > 0) content.push({ type: 'hardBreak' })
        if (line) content.push({ type: 'text', text: line })
      })
      return { type: 'paragraph', content }
    })
  }
}

// What JIRA said, when it said it in JSON. It uses two keys and which one
// depends on the failure, so both are collected.
function jiraMessages(parsed) {
  if (!parsed || typeof parsed !== 'object') return []
  return [
    ...(Array.isArray(parsed.errorMessages) ? parsed.errorMessages : []),
    ...(parsed.errors && typeof parsed.errors === 'object'
      ? Object.entries(parsed.errors).map(([field, message]) => `${field}: ${message}`)
      : [])
  ]
}

// A plain-language guess at what to do about it. Deliberately worded as a
// likelihood rather than a diagnosis — the dump below it is the evidence, and
// this only saves the reader from having to know JIRA's conventions.
function hintFor(status, headers, bodyText) {
  const denied = headers['x-authentication-denied-reason']
  const seraph = headers['x-seraph-loginreason']

  if (denied) {
    return `JIRA refused this before the API saw it (${denied}). Signing in to JIRA in a browser usually clears it.`
  }
  if (status === 401) {
    return 'JIRA did not accept the account email and API token. Check both in plugin settings — the email must be the one the token was created under.'
  }
  if (status === 403) {
    if (/scope/i.test(bodyText)) {
      return "The token was accepted but its grants do not cover creating issues. A token created without write access to Jira will read fine and fail here."
    }
    if (seraph && seraph !== 'OK') {
      return `JIRA's session check rejected this (${seraph}) rather than the API refusing it.`
    }
    return 'Authenticated, but not permitted. Usually the account lacks "Create Issues" in this project, is a Service Management customer rather than a licensed user, or the token has no write access.'
  }
  if (status === 404) {
    return 'The endpoint or project was not found. Check the base URL points at the JIRA site root.'
  }
  if (status === 429) {
    return 'JIRA is rate-limiting this account; try again shortly.'
  }
  if (status >= 500) {
    return 'JIRA failed on its side. Nothing here to fix — retrying may work.'
  }
  return null
}

export default function CreateIssue({
  task,
  config,
  fetch,
  openExternal,
  onBusy,
  onDone,
  onCancel
}) {
  const base = origin(config)
  const header = auth(config)
  const token = String(config.apiToken || '').trim()

  const [summary, setSummary] = useState((task.description || '').trim())
  const [description, setDescription] = useState((task.notes || '').trim())
  const [projects, setProjects] = useState(null)
  const [project, setProject] = useState('')
  const [issueTypes, setIssueTypes] = useState(null)
  const [issueType, setIssueType] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [failure, setFailure] = useState(null) // { summary, hint, detail }

  // Every request this form has made. Kept because the lookups below fall back
  // to older endpoints when the current ones don't answer — without a log, a
  // 403 on the modern endpoint is invisible whenever the legacy one succeeds,
  // which is exactly the case that later fails at create time.
  const logRef = useRef([])

  const headers = { Authorization: header, Accept: 'application/json' }

  // Nothing that reaches the dump may carry the credential — it is rendered,
  // selectable and copyable. Header names are filtered by `DIAGNOSTIC_HEADERS`
  // already; this is the backstop for the token turning up anywhere else.
  function redact(text) {
    let out = String(text)
    if (token) out = out.split(token).join('***')
    if (header) out = out.split(header.slice(6)).join('***')
    return out
  }

  // The host applies its own request timeout; a signal could not be passed
  // across to it in any case.
  async function request(method, path, init) {
    const started = Date.now()
    const url = `${base}${path}`
    try {
      const response = await fetch(url, { method, headers, ...init })
      logRef.current.push({ method, path, status: response.status, ms: Date.now() - started })
      return response
    } catch (err) {
      // A refusal by the host, or a transport failure. It never became a
      // response, so it is logged as whatever the host called it.
      logRef.current.push({ method, path, status: 'failed', ms: Date.now() - started })
      err.request = { method, url }
      throw err
    }
  }

  const get = (path) => request('GET', path)

  function formatLog() {
    if (logRef.current.length === 0) return '(none)'
    return logRef.current
      .map((e) => `  ${String(e.status).padEnd(6)} ${String(e.ms + 'ms').padStart(7)}  ${e.method} ${e.path}`)
      .join('\n')
  }

  // Turns a failed response into something worth reading. The body is taken as
  // text first and parsed second, so a body that is not JSON — an HTML error
  // page, or nothing at all — is still reported rather than thrown away.
  async function describeFailure(response, method, url) {
    let raw = ''
    try {
      raw = await response.text()
    } catch {
      raw = ''
    }

    let parsed = null
    try {
      parsed = JSON.parse(raw)
    } catch {
      // Left null; `raw` is shown instead.
    }

    const responseHeaders = {}
    response.headers.forEach((value, key) => {
      responseHeaders[key.toLowerCase()] = value
    })

    const messages = jiraMessages(parsed)
    const status = `${response.status}${response.statusText ? ` ${response.statusText}` : ''}`
    const summary = messages.length ? messages.join(' ') : `JIRA returned ${status}.`

    const lines = [`${method} ${url}`, status, '']
    const shown = DIAGNOSTIC_HEADERS.filter((h) => responseHeaders[h])
    if (shown.length) {
      lines.push(...shown.map((h) => `${h}: ${responseHeaders[h]}`), '')
    }
    if (messages.length) {
      lines.push('JIRA said:', ...messages.map((m) => `  ${m}`), '')
    }
    lines.push('Response body:')
    lines.push(
      raw.trim()
        ? raw.length > MAX_BODY_CHARS
          ? `${raw.slice(0, MAX_BODY_CHARS)}\n… (${raw.length - MAX_BODY_CHARS} more characters)`
          : raw
        : '(empty)'
    )
    lines.push('', 'Requests made by this form:', formatLog())

    return {
      summary,
      hint: hintFor(response.status, responseHeaders, raw),
      detail: redact(lines.join('\n'))
    }
  }

  // The same panel for a request that never became a response: refused by the
  // host, or the network failing under it.
  function describeThrow(err) {
    const req = err && err.request
    const lines = [
      req ? `${req.method} ${req.url}` : '(request not sent)',
      'The request did not complete.',
      '',
      String((err && err.message) || err),
      '',
      'Requests made by this form:',
      formatLog()
    ]
    return {
      summary: String((err && err.message) || err),
      hint: 'The request never reached JIRA. Check the base URL in plugin settings, and that this machine can reach it.',
      detail: redact(lines.join('\n'))
    }
  }

  // Which projects the user can create in. `project/search` is the current
  // endpoint; the plain `project` list is its predecessor and is all that
  // answers on older Server instances.
  useEffect(() => {
    let cancelled = false
    ;(async () => {
      try {
        let list = null
        const search = await get('/rest/api/3/project/search?maxResults=100&orderBy=key')
        if (search.ok) {
          const body = await search.json()
          list = Array.isArray(body.values) ? body.values : null
        }
        if (!list) {
          const all = await get('/rest/api/3/project')
          if (!all.ok) {
            throw await describeFailure(all, 'GET', `${base}/rest/api/3/project`)
          }
          const body = await all.json()
          list = Array.isArray(body) ? body : []
        }
        if (cancelled) return
        const options = list.map((p) => ({ id: String(p.id), key: p.key, name: p.name }))
        setProjects(options)
        const preferred = String(config.projectKey || '').trim().toUpperCase()
        const match = options.find((p) => p.key === preferred)
        setProject((match || options[0] || {}).key || '')
      } catch (err) {
        if (!cancelled) setFailure(err && err.detail ? err : describeThrow(err))
      }
    })()
    return () => {
      cancelled = true
    }
  }, [])

  // Issue types are per project, so this re-runs whenever the project changes.
  // Sub-task types are dropped: creating one needs a parent issue, which this
  // form has no way to choose.
  //
  // This used to try `createmeta/{key}/issuetypes` first and fall back here.
  // The request log showed that endpoint answering 200 with a body carrying no
  // `values` array, so the fallback ran every time and the first call was two
  // wasted round trips per project change. One call, and the diagnostics say so
  // if it ever stops answering.
  useEffect(() => {
    if (!project) return undefined
    let cancelled = false
    setIssueTypes(null)
    setIssueType('')
    ;(async () => {
      try {
        const path =
          `/rest/api/3/issue/createmeta?projectKeys=${encodeURIComponent(project)}` +
          '&expand=projects.issuetypes'
        const meta = await get(path)
        if (!meta.ok) {
          throw await describeFailure(meta, 'GET', `${base}${path}`)
        }
        const body = await meta.json()
        const first = Array.isArray(body.projects) ? body.projects[0] : null
        const list = (first && first.issuetypes) || []
        if (cancelled) return
        const options = list
          .filter((t) => t.subtask !== true)
          .map((t) => ({ id: String(t.id), name: t.name }))
        setIssueTypes(options)
        // The configured default is matched by name, because ids are per
        // instance and mean nothing to a user typing one in. A project that has
        // no type by that name falls back to its first rather than to nothing.
        const preferred = String(config.defaultIssueType || '').trim().toLowerCase()
        const match = preferred
          ? options.find((t) => t.name.trim().toLowerCase() === preferred)
          : null
        setIssueType((match || options[0] || {}).id || '')
      } catch (err) {
        if (!cancelled) {
          setIssueTypes([])
          setFailure(err && err.detail ? err : describeThrow(err))
        }
      }
    })()
    return () => {
      cancelled = true
    }
  }, [project])

  async function create() {
    const chosen = (projects || []).find((p) => p.key === project)
    if (!chosen || !issueType || !summary.trim()) return

    setSubmitting(true)
    onBusy(true)
    setFailure(null)
    try {
      const fields = {
        project: { id: chosen.id },
        issuetype: { id: issueType },
        summary: summary.trim()
      }
      const adf = toAdf(description)
      if (adf) fields.description = adf

      const response = await request('POST', '/rest/api/3/issue', {
        headers: {
          ...headers,
          'Content-Type': 'application/json',
          // Opts out of JIRA's XSRF check. Not needed for a plain token
          // request, but harmless when it was never going to fire and the
          // difference between working and a bare 403 when it was.
          'X-Atlassian-Token': 'no-check'
        },
        body: JSON.stringify({ fields })
      })
      if (!response.ok) {
        throw await describeFailure(response, 'POST', `${base}/rest/api/3/issue`)
      }

      const body = await response.json()
      const key = body && body.key
      if (!key) throw new Error('JIRA created the issue but did not say which one.')

      // Opened so the result can be checked, which is the point of doing this
      // from a form rather than blind.
      await openExternal(`${base}/browse/${key}`)
      onDone({ appendToDescription: key })
    } catch (err) {
      setFailure(err && err.detail ? err : describeThrow(err))
      setSubmitting(false)
      onBusy(false)
    }
  }

  if (!base || !header) {
    return (
      <div className="plugin-form-fields">
        <div className="plugin-form-error">
          Set the JIRA base URL, account email and API token in plugin settings first.
        </div>
      </div>
    )
  }

  const ready = Boolean(summary.trim() && project && issueType) && !submitting

  return (
    <>
      <div className="plugin-form-fields">
        <div className="plugin-field">
          <label htmlFor="jira-summary">Summary</label>
          <input
            id="jira-summary"
            type="text"
            value={summary}
            disabled={submitting}
            onChange={(e) => setSummary(e.target.value)}
          />
        </div>

        <div className="plugin-field">
          <label htmlFor="jira-description">Description</label>
          <textarea
            id="jira-description"
            rows={6}
            value={description}
            disabled={submitting}
            placeholder="Taken from the task's notes"
            onChange={(e) => setDescription(e.target.value)}
          />
        </div>

        <div className="plugin-field">
          <label htmlFor="jira-project">Project</label>
          <div className="select-wrap">
            <select
              id="jira-project"
              value={project}
              disabled={submitting || !projects}
              onChange={(e) => setProject(e.target.value)}
            >
              {!projects && <option value="">Loading…</option>}
              {projects && projects.length === 0 && <option value="">No projects found</option>}
              {(projects || []).map((p) => (
                <option key={p.id} value={p.key}>
                  {p.key} — {p.name}
                </option>
              ))}
            </select>
          </div>
        </div>

        <div className="plugin-field">
          <label htmlFor="jira-issue-type">Issue type</label>
          <div className="select-wrap">
            <select
              id="jira-issue-type"
              value={issueType}
              disabled={submitting || !issueTypes}
              onChange={(e) => setIssueType(e.target.value)}
            >
              {!issueTypes && <option value="">Loading…</option>}
              {issueTypes && issueTypes.length === 0 && (
                <option value="">No issue types available</option>
              )}
              {(issueTypes || []).map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name}
                </option>
              ))}
            </select>
          </div>
        </div>
      </div>

      {failure && <Diagnostic failure={failure} />}

      <div className="plugin-form-actions">
        <button type="button" className="btn-ghost" disabled={submitting} onClick={onCancel}>
          Cancel
        </button>
        <button type="button" className="btn-primary" disabled={!ready} onClick={create}>
          {submitting ? 'Creating…' : 'Create'}
        </button>
      </div>
    </>
  )
}

// Shown open rather than behind a disclosure: it only appears when something
// went wrong, and the whole point of it is to be read.
function Diagnostic({ failure }) {
  const [open, setOpen] = useState(true)
  const [copied, setCopied] = useState(false)
  const preRef = useRef(null)

  async function copy() {
    try {
      await navigator.clipboard.writeText(failure.detail)
      setCopied(true)
    } catch {
      // The page is a file:// origin; if the async clipboard is unavailable,
      // select the text so ctrl-c still works.
      if (preRef.current) {
        const range = document.createRange()
        range.selectNodeContents(preRef.current)
        const selection = window.getSelection()
        selection.removeAllRanges()
        selection.addRange(range)
      }
    }
  }

  return (
    <div className="plugin-form-diagnostic">
      <div className="plugin-form-error">{failure.summary}</div>
      {failure.hint && <div className="plugin-form-hint">{failure.hint}</div>}
      <div className="plugin-form-diagnostic-bar">
        <button type="button" className="btn-ghost" onClick={() => setOpen((v) => !v)}>
          {open ? 'Hide details' : 'Show details'}
        </button>
        <button type="button" className="btn-ghost" onClick={copy}>
          {copied ? 'Copied' : 'Copy details'}
        </button>
      </div>
      {open && (
        <pre className="plugin-form-detail" ref={preRef}>
          {failure.detail}
        </pre>
      )}
    </div>
  )
}
