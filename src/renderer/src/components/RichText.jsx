import { useSyncExternalStore } from 'react'
import { getVersion, resolve, subscribe } from '../utils/decorate.js'

// Renders a piece of task text, letting plugins turn parts of it into links
// (see src/main/plugins.js). Until the decoration for a given text is cached,
// the plain text renders in exactly the same DOM shape, so the only visible
// change when segments arrive is the link styling — nothing reflows.
export default function RichText({ text, className, fallback = '' }) {
  useSyncExternalStore(subscribe, getVersion)

  if (!text) return <span className={className}>{fallback}</span>

  // Requests what it doesn't have. Idempotent and de-duplicated, so asking
  // from render is safe.
  const segments = resolve(text)
  if (!segments) return <span className={className}>{text}</span>

  return (
    <span className={className}>
      {segments.map((segment, i) =>
        segment.type === 'link' ? (
          <a
            key={i}
            className="rt-link"
            href={segment.href}
            title={segment.title || segment.href}
            onClick={(e) => {
              e.preventDefault()
              // The task body opens the editor on click, so a link that let
              // the event bubble would drop the user into edit mode.
              e.stopPropagation()
              window.api.openExternal(segment.href)
            }}
          >
            {segment.text}
          </a>
        ) : (
          <span key={i}>{segment.text}</span>
        )
      )}
    </span>
  )
}
