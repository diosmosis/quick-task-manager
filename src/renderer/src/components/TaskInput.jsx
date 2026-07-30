import { useEffect, useRef, useState } from 'react'

// A single text input that captures a description plus #hashtag tags.
// Used both for creating tasks and for inline editing.
export default function TaskInput({
  initialValue = '',
  onSubmit,
  onCancel,
  placeholder = 'Add a task…  use #tags to categorize',
  submitLabel = 'Add',
  autoFocus = false
}) {
  const [value, setValue] = useState(initialValue)
  const inputRef = useRef(null)

  useEffect(() => {
    if (autoFocus && inputRef.current) {
      inputRef.current.focus()
      inputRef.current.select()
    }
  }, [autoFocus])

  function submit() {
    const trimmed = value.trim()
    if (!trimmed) {
      if (onCancel) onCancel()
      return
    }
    onSubmit(trimmed)
    if (!onCancel) setValue('') // creation mode: clear for the next task
  }

  function handleKeyDown(e) {
    if (e.key === 'Enter') {
      e.preventDefault()
      submit()
    } else if (e.key === 'Escape' && onCancel) {
      e.preventDefault()
      onCancel()
    }
  }

  return (
    <div className="task-input">
      <input
        ref={inputRef}
        type="text"
        value={value}
        placeholder={placeholder}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={handleKeyDown}
      />
      <button className="btn-primary" onClick={submit}>
        {submitLabel}
      </button>
      {onCancel && (
        <button className="btn-ghost" onClick={onCancel}>
          Cancel
        </button>
      )}
    </div>
  )
}
