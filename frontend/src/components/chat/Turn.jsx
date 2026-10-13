import { useEffect, useRef, useState } from 'react'
import { useSelector } from 'react-redux'
import Markdown from '../Markdown.jsx'
import AntralLogo from '../AntralLogo.jsx'
import dragon from '../../assets/dragon.png'
import Icon from '../ui/Icon.jsx'
import { Button, RiskBadge, Spinner } from '../ui/primitives.jsx'
import { getRun } from '../../../utils/agentApi.js'
import { fullDate, relativeTime } from '../../lib/format.js'
import { ACTIVE } from '../../lib/runs.js'

// "edit_file" -> sentence for the Always allow button.
const describeRule = (rule) => {
  if (!rule) return null
  if (rule.startsWith('run_command:')) return `Always allow “${rule.slice(12)}” commands on this target`
  const names = {
    write_file: 'writing files',
    edit_file: 'editing files',
    make_directory: 'creating folders',
    move_path: 'moving files',
  }
  return `Always allow ${names[rule] || rule} on this target`
}

// Plain-language progress labels; raw tool names and arguments stay in the
// audit log rather than the chat.
function activityLabel(step) {
  switch (step.kind) {
    case 'tool_call': {
      const tool = String(step.tool || '').toLowerCase()
      if (tool === 'get_permissions') return 'Checking your permissions'
      if (/permission/.test(tool)) return 'Updating your permissions'
      if (tool === 'recall_memory') return 'Recalling earlier conversations'
      if (/^android_/.test(tool)) return 'Using connected Android phone'
      if (/read|list|search|find|grep|glob|scan/.test(tool)) return 'Searching the project'
      if (/write|edit|delete|move|directory/.test(tool)) return 'Updating project files'
      if (/command|terminal|powershell/.test(tool)) return 'Running a command'
      if (/github|browser|web/.test(tool)) return 'Checking external resources'
      return 'Working on the solution'
    }
    case 'tool_result':
      return 'Checking the result'
    case 'approval_request':
      return 'Waiting for your approval'
    case 'approval':
      return step.ok ? 'Approved' : 'Declined'
    case 'denied':
      return 'Skipped an action that isn’t allowed'
    case 'error':
      return 'Handling an issue'
    default:
      return null
  }
}

const activityList = (steps) =>
  (steps || [])
    .map(activityLabel)
    .filter(Boolean)
    .filter((label, index, labels) => label !== labels[index - 1])

function Activity({ steps, status }) {
  const [open, setOpen] = useState(false)
  const [phase, setPhase] = useState(0)
  const updates = activityList(steps).slice(-6)
  const lastStep = [...(steps || [])].reverse().find((step) => activityLabel(step))
  const phases = ['Thinking', 'Analyzing your request', 'Planning the next step', 'Working on it']

  useEffect(() => {
    const timer = setInterval(() => setPhase((p) => p + 1), 3600)
    return () => clearInterval(timer)
  }, [])

  const current =
    status === 'awaiting_approval'
      ? 'Waiting for your approval'
      : lastStep?.kind === 'tool_call'
        ? activityLabel(lastStep)
        : lastStep?.kind === 'tool_result'
          ? 'Checking the result'
          : phases[phase % phases.length]

  return (
    <div className="mb-4 min-w-0">
      <div className="flex min-h-7 items-center gap-2.5">
        <span aria-hidden="true" className={`dragon-think shrink-0 ${status === 'awaiting_approval' ? 'is-waiting' : ''}`}>
          <img src={dragon} width={26} height={26} alt="" draggable="false" />
        </span>
        <span role="status" aria-live="polite" className="shimmer-text min-w-0 flex-1 truncate text-sm">
          {current}…
        </span>
        {updates.length > 0 && (
          <button
            type="button"
            onClick={() => setOpen((v) => !v)}
            aria-expanded={open}
            className="inline-flex shrink-0 items-center gap-1 rounded-md px-2 py-1 text-xs text-neutral-500 transition hover:bg-white/[0.05] hover:text-neutral-300"
          >
            {open ? 'Hide steps' : `${updates.length} step${updates.length === 1 ? '' : 's'}`}
            <Icon name="chevronDown" size={12} className={`transition-transform ${open ? 'rotate-180' : ''}`} />
          </button>
        )}
      </div>
      {open && (
        <ul className="expand-in mt-2 space-y-1.5 border-l border-white/10 pl-4 text-xs text-neutral-500">
          {updates.map((label, index) => {
            const last = index === updates.length - 1
            return (
              <li key={`${label}-${index}`} className="flex items-center gap-2">
                {last ? <Spinner size={10} /> : <Icon name="check" size={12} className="text-emerald-400" />}
                {label}
              </li>
            )
          })}
        </ul>
      )}
    </div>
  )
}

function ApprovalCard({ approval, onAnswer, busy }) {
  const scopes = useSelector((state) => state.consent.policies?.scopes || [])
  const args = approval.args || {}
  const isPermission = approval.tool === 'turn_on_permission'
  const isCommand = approval.tool.startsWith('run_')
  const scope = isPermission ? scopes.find((s) => s.id === args.scope) : null
  const preview = isPermission
    ? null
    : approval.tool === 'edit_file'
      ? `- ${args.oldText ?? ''}\n+ ${args.newText ?? ''}`
      : approval.tool === 'write_file'
        ? args.content
        : approval.tool === 'run_command'
          ? args.command
          : JSON.stringify(args, null, 2)
  const rule = describeRule(approval.rule)
  const [answered, setAnswered] = useState(null)

  const answer = (decision) => {
    setAnswered(decision)
    onAnswer(decision)
  }

  return (
    <div className="approval-in mt-3 rounded-2xl border border-amber-400/30 bg-amber-500/[0.06] p-4">
      <div className="flex items-start gap-3">
        <span className="grid h-8 w-8 shrink-0 place-items-center rounded-full bg-amber-500/15 text-amber-300">
          <Icon name={isPermission ? 'key' : isCommand ? 'terminal' : 'doc'} size={16} />
        </span>
        <div className="min-w-0 flex-1">
          <p className="text-xs font-semibold uppercase tracking-wide text-amber-300">
            {isPermission ? 'Permission request' : isCommand ? 'The agent wants to run a command' : 'The agent wants to make a change'}
          </p>
          <p className="mt-1 text-sm text-white">{approval.summary}</p>
          {scope && (
            <div className="mt-3 rounded-xl border border-white/10 bg-black/30 p-3">
              <p className="flex flex-wrap items-center gap-2 text-sm font-medium text-white">
                {scope.label}
                <RiskBadge risk={scope.risk} />
              </p>
              <p className="mt-1 text-xs leading-5 text-neutral-400">{scope.description}</p>
              <p className="mt-2 text-[11px] text-neutral-500">
                {args.where === 'this_target' ? 'Applies to this chat’s target only.' : 'Applies account-wide.'}
              </p>
            </div>
          )}
          {isPermission && (
            <p className="mt-2 flex items-start gap-1.5 text-xs leading-5 text-amber-100/80">
              <Icon name="info" size={13} className="mt-0.5" />
              Only allow this if you asked for it yourself. You can turn it off again any time in Settings or by asking in chat.
            </p>
          )}
        </div>
      </div>
      {preview && (
        <pre className="mt-3 max-h-56 overflow-auto whitespace-pre-wrap break-words rounded-xl border border-white/10 bg-black/40 p-3 font-mono text-[11px] leading-5 text-neutral-200">
          {preview}
        </pre>
      )}
      <div className="mt-4 flex flex-wrap items-center gap-2">
        <Button size="sm" variant="primary" disabled={busy} onClick={() => answer('allow_once')}>
          {busy && answered === 'allow_once' && <Spinner size={11} className="border-white/30 border-t-white" />}
          {isPermission ? 'Allow' : 'Allow once'}
        </Button>
        {rule && (
          <Button size="sm" variant="secondary" disabled={busy} onClick={() => answer('allow_always')} title={rule}>
            Always allow
          </Button>
        )}
        <Button size="sm" variant="dangerGhost" disabled={busy} onClick={() => answer('decline')}>
          Decline
        </Button>
        {approval.expiresAt && (
          <span className="ml-auto text-[11px] text-neutral-500">Auto-declines {relativeTime(approval.expiresAt)}</span>
        )}
      </div>
      {rule && <p className="mt-2 text-[11px] text-neutral-500">“Always allow” = {rule.charAt(0).toLowerCase() + rule.slice(1)}.</p>}
    </div>
  )
}

function CopyButton({ text }) {
  const [copied, setCopied] = useState(false)
  const timer = useRef(null)
  useEffect(() => () => clearTimeout(timer.current), [])
  return (
    <button
      type="button"
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(text)
          setCopied(true)
          clearTimeout(timer.current)
          timer.current = setTimeout(() => setCopied(false), 1600)
        } catch {
          setCopied(false)
        }
      }}
      aria-label={copied ? 'Copied' : 'Copy answer'}
      title={copied ? 'Copied' : 'Copy answer'}
      className="grid h-7 w-7 place-items-center rounded-md text-neutral-500 transition hover:bg-white/[0.06] hover:text-white"
    >
      <Icon name={copied ? 'check' : 'copy'} size={14} className={copied ? 'text-emerald-300' : ''} />
    </button>
  )
}

// One request/answer pair in the conversation.
function Turn({ item, live, onAnswer, answering, onImageOpen }) {
  const run = live || item
  const active = ACTIVE.includes(run.status)
  const [steps, setSteps] = useState(null)
  const [stepsOpen, setStepsOpen] = useState(false)
  const [loadingSteps, setLoadingSteps] = useState(false)
  const runId = run._id || run.id

  const toggleSteps = async () => {
    if (!stepsOpen && !steps) {
      setLoadingSteps(true)
      try {
        const { run: full } = await getRun(runId)
        setSteps(full.steps || [])
      } catch {
        setSteps([])
      } finally {
        setLoadingSteps(false)
      }
    }
    setStepsOpen((v) => !v)
  }

  const finishedSteps = activityList(steps)
  const time = run.createdAt

  return (
    <li className="space-y-4">
      <div className="flex flex-col items-end gap-1">
        <div className="max-w-[88%] whitespace-pre-wrap break-words rounded-3xl rounded-br-md bg-[#26262c] px-4 py-2.5 text-[15px] leading-6 text-neutral-100 sm:max-w-[75%]">
          {run.task}
          {run.attachments?.length > 0 && (
            <div className="mt-2 flex flex-wrap gap-2">
              {run.attachments.map((attachment, index) => (
                <button
                  key={`${attachment.name}-${index}`}
                  type="button"
                  onClick={() => onImageOpen?.({ src: attachment.dataUrl, name: attachment.name || 'Attached image' })}
                  className="overflow-hidden rounded-xl border border-white/10 transition hover:border-white/25"
                  aria-label={`Open ${attachment.name || 'attached image'}`}
                >
                  <img src={attachment.dataUrl} alt={attachment.name || 'Attached image'} className="max-h-48 max-w-full object-contain sm:max-w-64" />
                </button>
              ))}
            </div>
          )}
        </div>
        {time && (
          <time dateTime={time} title={fullDate(time)} className="px-2 text-[11px] text-neutral-600">
            {relativeTime(time)}
          </time>
        )}
      </div>

      <div className="flex min-w-0 gap-3">
        <span className="mt-0.5 hidden h-7 w-7 shrink-0 place-items-center overflow-hidden rounded-full border border-white/10 bg-white/[0.03] sm:grid">
          <AntralLogo size={24} />
        </span>
        <div className="min-w-0 flex-1">
          {active && <Activity steps={live?.steps} status={run.status} />}

          <div className="response-enter min-w-0 max-w-full">
            {run.result && <Markdown text={run.result} />}
            {run.error && !run.result && (
              <div className="flex items-start gap-2.5 rounded-xl border border-rose-400/20 bg-rose-500/[0.06] px-3.5 py-3 text-sm text-rose-100/90">
                <Icon name="alert" size={16} className="mt-0.5 text-rose-300" />
                <span>
                  {run.attachments?.length
                    ? "I couldn't process the image. Check that the configured AI model supports image input, then try again."
                    : 'I ran into a problem while completing that. Please try again.'}
                </span>
              </div>
            )}
            {!active && !run.result && !run.error && ['cancelled', 'interrupted'].includes(run.status) && (
              <p className="text-sm italic leading-7 text-neutral-500">
                {run.status === 'cancelled' ? 'You stopped this run.' : 'This run was interrupted before it finished.'}
              </p>
            )}
          </div>

          {live?.status === 'awaiting_approval' && live.pendingApproval && (
            <ApprovalCard key={live.pendingApproval.id} approval={live.pendingApproval} onAnswer={onAnswer} busy={answering} />
          )}

          {!active && (
            <div className="mt-2 flex items-center gap-1">
              {run.result && <CopyButton text={run.result} />}
              <button
                type="button"
                onClick={toggleSteps}
                aria-expanded={stepsOpen}
                className="inline-flex h-7 items-center gap-1.5 rounded-md px-2 text-xs text-neutral-500 transition hover:bg-white/[0.06] hover:text-neutral-300"
              >
                {loadingSteps ? <Spinner size={10} /> : <Icon name="activity" size={13} />}
                {stepsOpen ? 'Hide activity' : 'Activity'}
              </button>
            </div>
          )}
          {!active && stepsOpen && steps && (
            <ul className="expand-in mt-2 space-y-1.5 border-l border-white/10 pl-4 text-xs text-neutral-500">
              {finishedSteps.length === 0 ? (
                <li>No tool activity for this answer.</li>
              ) : (
                finishedSteps.map((label, index) => (
                  <li key={`${label}-${index}`} className="flex items-center gap-2">
                    <Icon name="check" size={12} className="text-emerald-400/80" />
                    {label}
                  </li>
                ))
              )}
            </ul>
          )}
        </div>
      </div>
    </li>
  )
}

export default Turn
