import { useLayoutEffect, useRef, useState } from 'react'
import Icon from '../ui/Icon.jsx'
import { Spinner } from '../ui/primitives.jsx'

export const MAX_TASK_CHARS = 4000
const MAX_HEIGHT = 200

function AttachmentStrip({ attachments, onRemove }) {
  if (!attachments.length) return null
  return (
    <div className="flex max-w-full gap-2 overflow-x-auto px-1 pb-1 pt-1">
      {attachments.map((attachment) => (
        <div key={attachment.id} className="group relative h-16 w-16 shrink-0 overflow-hidden rounded-xl border border-white/10 bg-black/30">
          <img src={attachment.previewUrl} alt={attachment.file.name} className="h-full w-full object-cover" />
          <button
            type="button"
            onClick={() => onRemove(attachment.id)}
            aria-label={`Remove ${attachment.file.name}`}
            className="absolute right-1 top-1 grid h-5 w-5 place-items-center rounded-full bg-black/75 text-white opacity-100 transition hover:bg-black sm:opacity-0 sm:group-hover:opacity-100 sm:focus-visible:opacity-100"
          >
            <Icon name="x" size={12} strokeWidth={2.4} />
          </button>
        </div>
      ))}
    </div>
  )
}

// The message box. `blocked` = { message, actionLabel, onAction } explains why
// sending isn't possible (no policies accepted, no target) instead of leaving
// a dead input.
function Composer({
  value,
  onChange,
  onSubmit,
  attachments,
  onAddFiles,
  onRemoveAttachment,
  busy,
  sending,
  onStop,
  blocked,
  placeholder = 'Ask anything',
  inputRef,
  footer,
  planMode = false,
  onPlanModeChange,
}) {
  const fileRef = useRef(null)
  const localRef = useRef(null)
  const textareaRef = inputRef || localRef
  const [dragging, setDragging] = useState(false)
  const dragDepth = useRef(0)

  // Grow with the content up to MAX_HEIGHT, then scroll.
  useLayoutEffect(() => {
    const el = textareaRef.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${Math.min(el.scrollHeight, MAX_HEIGHT)}px`
    el.style.overflowY = el.scrollHeight > MAX_HEIGHT ? 'auto' : 'hidden'
  }, [value, textareaRef])

  const canSend = !blocked && !busy && (value.trim() || attachments.length)
  const nearLimit = value.length > MAX_TASK_CHARS * 0.85

  const submit = (event) => {
    event.preventDefault()
    if (canSend) onSubmit()
  }

  const onPaste = (event) => {
    const images = Array.from(event.clipboardData.items)
      .filter((item) => item.kind === 'file' && item.type.startsWith('image/'))
      .map((item) => item.getAsFile())
      .filter(Boolean)
    if (images.length) {
      event.preventDefault()
      onAddFiles(images)
    }
  }

  const dragProps = blocked
    ? {}
    : {
        onDragEnter: (event) => {
          if (![...event.dataTransfer.types].includes('Files')) return
          dragDepth.current += 1
          setDragging(true)
        },
        onDragLeave: () => {
          dragDepth.current = Math.max(0, dragDepth.current - 1)
          if (!dragDepth.current) setDragging(false)
        },
        onDragOver: (event) => {
          if ([...event.dataTransfer.types].includes('Files')) event.preventDefault()
        },
        onDrop: (event) => {
          event.preventDefault()
          dragDepth.current = 0
          setDragging(false)
          const files = Array.from(event.dataTransfer.files || [])
          if (files.length) onAddFiles(files)
        },
      }

  if (blocked) {
    return (
      <div className="flex w-full flex-wrap items-center gap-3 rounded-3xl border border-white/10 bg-[#18181c] px-4 py-3.5">
        <Icon name="lock" size={18} className="text-neutral-500" />
        <p className="min-w-0 flex-1 text-sm text-neutral-300">{blocked.message}</p>
        {blocked.actionLabel && (
          <button
            type="button"
            onClick={blocked.onAction}
            className="rounded-full bg-white px-4 py-1.5 text-sm font-medium text-black transition hover:bg-neutral-200"
          >
            {blocked.actionLabel}
          </button>
        )}
      </div>
    )
  }

  return (
    <form
      onSubmit={submit}
      {...dragProps}
      className={`relative flex w-full flex-col gap-1 rounded-3xl border bg-[#1c1c21] p-2 shadow-xl shadow-black/30 transition focus-within:border-white/20 ${
        dragging ? 'border-indigo-400/60 bg-indigo-500/[0.06]' : 'border-white/10'
      }`}
    >
      <input
        ref={fileRef}
        type="file"
        accept="image/png,image/jpeg,image/webp"
        multiple
        className="hidden"
        tabIndex={-1}
        aria-hidden="true"
        onChange={(event) => {
          onAddFiles(Array.from(event.target.files || []))
          event.target.value = ''
        }}
      />
      {dragging && (
        <div className="pointer-events-none absolute inset-0 z-10 grid place-items-center rounded-3xl text-sm font-medium text-indigo-200">
          Drop images to attach
        </div>
      )}
      <AttachmentStrip attachments={attachments} onRemove={onRemoveAttachment} />
      <div className={`flex items-end gap-1.5 ${dragging ? 'opacity-30' : ''}`}>
        <button
          type="button"
          onClick={() => fileRef.current?.click()}
          disabled={busy}
          aria-label="Attach images"
          title="Attach images (or paste / drop them here)"
          className="grid h-10 w-10 shrink-0 place-items-center rounded-full text-neutral-400 transition hover:bg-white/10 hover:text-white disabled:opacity-40"
        >
          <Icon name="paperclip" size={18} />
        </button>
        <textarea
          ref={textareaRef}
          value={value}
          onChange={(event) => onChange(event.target.value)}
          onPaste={onPaste}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) submit(event)
          }}
          rows={1}
          maxLength={MAX_TASK_CHARS}
          placeholder={placeholder}
          aria-label="Message"
          className="min-h-10 min-w-0 flex-1 resize-none bg-transparent px-1.5 py-2.5 text-[15px] leading-5 text-white placeholder:text-neutral-500 focus:outline-none"
        />
        {busy && !sending && onStop ? (
          <button
            type="button"
            onClick={onStop}
            aria-label="Stop the agent"
            title="Stop the agent"
            className="grid h-10 w-10 shrink-0 place-items-center rounded-full bg-white text-black transition hover:bg-neutral-200"
          >
            <Icon name="stop" size={16} />
          </button>
        ) : (
          <button
            type="submit"
            disabled={!canSend}
            aria-label="Send message"
            title="Send (Enter)"
            className="grid h-10 w-10 shrink-0 place-items-center rounded-full bg-indigo-500 text-white transition hover:bg-indigo-400 disabled:cursor-not-allowed disabled:bg-white/10 disabled:text-neutral-500"
          >
            {sending ? <Spinner size={16} className="border-white/30 border-t-white" /> : <Icon name="arrowUp" size={18} strokeWidth={2.2} />}
          </button>
        )}
      </div>
      {onPlanModeChange && (
        <label className="inline-flex w-fit items-center gap-2 rounded-full px-3 py-1.5 text-xs text-neutral-400 transition hover:bg-white/[0.04] hover:text-neutral-200">
          <input
            type="checkbox"
            checked={planMode}
            disabled={busy || attachments.length > 0}
            onChange={(event) => onPlanModeChange(event.target.checked)}
            className="accent-indigo-400"
          />
          <span>Plan and execute</span>
          <span className="text-neutral-600" title="The agent proposes a task plan for your approval, then works through it with verification and checkpoints.">ⓘ</span>
          {attachments.length > 0 && <span className="text-neutral-600">Remove images to use plan mode</span>}
        </label>
      )}
      {(nearLimit || footer) && (
        <div className="flex items-center justify-between gap-3 px-3 pb-1 text-[11px] text-neutral-500">
          <span className="min-w-0 truncate">{footer}</span>
          {nearLimit && (
            <span className={`shrink-0 tabular-nums ${value.length >= MAX_TASK_CHARS ? 'text-rose-300' : ''}`}>
              {value.length}/{MAX_TASK_CHARS}
            </span>
          )}
        </div>
      )}
    </form>
  )
}

export default Composer
