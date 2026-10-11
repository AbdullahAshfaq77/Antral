import { useEffect, useMemo, useState } from 'react'
import { useDispatch, useSelector } from 'react-redux'
import Icon from '../components/ui/Icon.jsx'
import { Button, Card, EmptyState, Spinner, StatusPill } from '../components/ui/primitives.jsx'
import { listRuns } from '../../utils/agentApi.js'
import { getLlmSettings } from '../../utils/consentApi.js'
import { loadConsent } from '../store/consentSlice.js'
import { daysUntil, greeting, relativeTime, TARGET_TYPE_META, targetName } from '../lib/format.js'
import { riskDot, SCOPE_ICON } from '../components/settings/scopeMeta.js'
import { QUICK_STARTS } from '../lib/quickStarts.js'


function Stat({ icon, label, value, detail, tone = 'default', onClick }) {
  const tones = {
    default: 'text-neutral-300',
    warn: 'text-amber-300',
    good: 'text-emerald-300',
  }
  const Tag = onClick ? 'button' : 'div'
  return (
    <Tag
      type={onClick ? 'button' : undefined}
      onClick={onClick}
      className={`group flex flex-col rounded-2xl border border-white/[0.08] bg-white/[0.025] p-4 text-left transition ${
        onClick ? 'hover:border-white/15 hover:bg-white/[0.04]' : ''
      }`}
    >
      <span className="flex items-center justify-between text-xs text-neutral-500">
        {label}
        <Icon name={icon} size={16} className={tones[tone]} />
      </span>
      <span className="mt-3 text-2xl font-semibold tabular-nums tracking-tight text-white">{value}</span>
      <span className="mt-1 truncate text-xs text-neutral-500">{detail}</span>
    </Tag>
  )
}

function SetupStep({ done, index, title, children, action }) {
  return (
    <li className="flex items-start gap-3.5 py-3">
      <span
        className={`mt-0.5 grid h-6 w-6 shrink-0 place-items-center rounded-full text-[11px] font-semibold ${
          done ? 'bg-emerald-500/20 text-emerald-300' : 'border border-white/15 text-neutral-400'
        }`}
      >
        {done ? <Icon name="check" size={13} strokeWidth={2.5} /> : index}
      </span>
      <div className="min-w-0 flex-1">
        <p className={`text-sm font-medium ${done ? 'text-neutral-500 line-through decoration-neutral-700' : 'text-white'}`}>{title}</p>
        {!done && <p className="mt-0.5 text-xs leading-5 text-neutral-500">{children}</p>}
      </div>
      {!done && action}
    </li>
  )
}

function Dashboard({ firstName, liveRun, onNavigate, onStartChat, onOpenConversation }) {
  const dispatch = useDispatch()
  const { policies, account, authorizations, status: consentStatus } = useSelector((state) => state.consent)
  const [runs, setRuns] = useState(null)
  const [runsError, setRunsError] = useState(false)
  const [aiReady, setAiReady] = useState(null)
  const liveStatus = liveRun?.status

  useEffect(() => {
    let cancelled = false
    getLlmSettings()
      .then((s) => !cancelled && setAiReady(Boolean(s.configured)))
      .catch(() => !cancelled && setAiReady(false))
    return () => {
      cancelled = true
    }
  }, [liveStatus])

  useEffect(() => {
    let cancelled = false
    listRuns()
      .then(({ runs: list }) => {
        if (cancelled) return
        setRuns(list)
        setRunsError(false)
      })
      .catch(() => {
        if (cancelled) return
        setRuns((current) => current || [])
        setRunsError(true)
      })
    return () => {
      cancelled = true
    }
  }, [liveStatus])

  const scopes = useMemo(() => policies?.scopes || [], [policies])
  const disabled = account?.disabledCapabilities || []
  const accepted = Boolean(account?.accepted)
  const activeTargets = authorizations.filter((a) => a.status === 'active')
  const expiring = activeTargets.filter((a) => {
    const days = daysUntil(a.expiresAt)
    return days !== null && days <= 14
  })
  const enabledScopes = scopes.filter((s) => !disabled.includes(s.id))
  const highRiskOn = enabledScopes.filter((s) => s.risk === 'high').length
  const completed = runs?.filter((r) => r.status === 'completed').length ?? 0
  const failed = runs?.filter((r) => r.status === 'failed').length ?? 0
  const waiting = runs?.filter((r) => r.status === 'awaiting_approval').length ?? 0

  const setupDone = aiReady && accepted && activeTargets.length > 0 && (runs?.length ?? 0) > 0
  const setupProgress = [aiReady, accepted, activeTargets.length > 0, (runs?.length ?? 0) > 0].filter(Boolean).length
  const canChat = Boolean(aiReady) && accepted && activeTargets.length > 0
  const today = new Date().toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' })

  return (
    <div className="page-enter mx-auto w-full max-w-6xl px-5 py-8 sm:px-8">
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <p className="text-xs font-medium text-neutral-500">{today}</p>
          <h1 className="mt-1 text-2xl font-semibold tracking-tight text-white sm:text-3xl">
            {greeting()}{firstName ? `, ${firstName}` : ''}
          </h1>
          <p className="mt-1.5 text-sm text-neutral-400">Here’s what your security agents are up to.</p>
        </div>
        <Button variant="light" onClick={() => onStartChat()} disabled={!canChat} title={canChat ? 'Start a new chat' : 'Finish setup to start chatting'}>
          <Icon name="plus" size={16} />
          New chat
        </Button>
      </header>

      {consentStatus === 'error' && (
        <div role="alert" className="mt-6 flex items-center gap-3 rounded-2xl border border-rose-400/25 bg-rose-500/[0.07] px-4 py-3 text-sm text-rose-100">
          <Icon name="alert" size={18} className="text-rose-300" />
          <span className="flex-1">We couldn’t load your permissions. Check that the server is running.</span>
          <Button size="sm" variant="secondary" onClick={() => dispatch(loadConsent())}>
            <Icon name="refresh" size={14} />
            Retry
          </Button>
        </div>
      )}

      {liveRun && ['running', 'awaiting_approval'].includes(liveRun.status) && (
        <button
          type="button"
          onClick={() => onOpenConversation(liveRun.conversationId)}
          className={`mt-6 flex w-full items-center gap-3 rounded-2xl border px-4 py-3.5 text-left transition ${
            liveRun.status === 'awaiting_approval'
              ? 'border-amber-400/30 bg-amber-500/[0.08] hover:bg-amber-500/[0.12]'
              : 'border-indigo-400/25 bg-indigo-500/[0.07] hover:bg-indigo-500/[0.1]'
          }`}
        >
          <span className={`activity-orb h-2.5 w-2.5 shrink-0 rounded-full ${liveRun.status === 'awaiting_approval' ? 'bg-amber-300' : 'bg-indigo-300'}`} />
          <span className="min-w-0 flex-1">
            <span className="block text-sm font-medium text-white">
              {liveRun.status === 'awaiting_approval' ? 'The agent is waiting for your approval' : 'The agent is working'}
            </span>
            <span className="block truncate text-xs text-neutral-400">{liveRun.task}</span>
          </span>
          <span className="flex items-center gap-1 text-xs font-medium text-neutral-200">
            {liveRun.status === 'awaiting_approval' ? 'Review' : 'Open'}
            <Icon name="arrowRight" size={14} />
          </span>
        </button>
      )}

      {!setupDone && consentStatus === 'ready' && (
        <Card className="mt-6 overflow-hidden">
          <div className="flex items-center justify-between gap-4 border-b border-white/[0.06] px-5 py-4">
            <div>
              <h2 className="text-sm font-semibold text-white">Get started</h2>
              <p className="mt-0.5 text-xs text-neutral-500">A few quick steps before the agents can help.</p>
            </div>
            <div className="flex items-center gap-3">
              <span className="text-xs tabular-nums text-neutral-400">{setupProgress}/4</span>
              <span className="h-1.5 w-24 overflow-hidden rounded-full bg-white/10">
                <span className="block h-full rounded-full bg-indigo-400 transition-[width] duration-500" style={{ width: `${(setupProgress / 4) * 100}%` }} />
              </span>
            </div>
          </div>
          <ol className="divide-y divide-white/[0.05] px-5">
            <SetupStep
              index={1}
              done={Boolean(aiReady)}
              title="Connect your AI key"
              action={<Button size="sm" variant="primary" onClick={() => onNavigate('settings', 'ai')}>Add key</Button>}
            >
              Antral runs on your own AI account. Paste your API key (Groq and Gemini have free tiers) — it stays on this device.
            </SetupStep>
            <SetupStep
              index={2}
              done={accepted}
              title="Accept the policies"
              action={<Button size="sm" variant="primary" onClick={() => onNavigate('settings', 'privacy')}>Review</Button>}
            >
              The agents only work on systems you own or may assess. Read and accept the terms in Settings.
            </SetupStep>
            <SetupStep
              index={3}
              done={activeTargets.length > 0}
              title="Authorize a target"
              action={
                <Button size="sm" variant={accepted ? 'primary' : 'secondary'} disabled={!accepted} onClick={() => onNavigate('settings', 'targets')}>
                  Add target
                </Button>
              }
            >
              Choose a folder, GitHub repository or host and what the agents may do there.
            </SetupStep>
            <SetupStep
              index={4}
              done={(runs?.length ?? 0) > 0}
              title="Start your first chat"
              action={
                <Button size="sm" variant={canChat ? 'primary' : 'secondary'} disabled={!canChat} onClick={() => onStartChat(QUICK_STARTS[0].prompt)}>
                  Run an audit
                </Button>
              }
            >
              Ask for a security audit, or anything else about your project.
            </SetupStep>
          </ol>
        </Card>
      )}

      <section aria-label="Overview" className="mt-6 grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat
          icon="target"
          label="Authorized targets"
          value={activeTargets.length}
          detail={expiring.length ? `${expiring.length} expiring soon` : activeTargets.length ? 'All current' : 'None yet'}
          tone={expiring.length ? 'warn' : 'default'}
          onClick={() => onNavigate('settings', 'targets')}
        />
        <Stat
          icon="key"
          label="Capabilities on"
          value={scopes.length ? `${enabledScopes.length}/${scopes.length}` : '—'}
          detail={highRiskOn ? 'Includes high-risk access' : 'No high-risk access'}
          tone={highRiskOn ? 'warn' : 'good'}
          onClick={() => onNavigate('settings', 'permissions')}
        />
        <Stat
          icon="check"
          label="Completed runs"
          value={runs ? completed : '—'}
          detail={failed ? `${failed} failed recently` : 'Last 20 runs'}
          tone="good"
        />
        <Stat
          icon="activity"
          label="Waiting on you"
          value={runs ? waiting : '—'}
          detail={waiting ? 'Approvals pending' : 'Nothing to approve'}
          tone={waiting ? 'warn' : 'default'}
          onClick={waiting && liveRun?.conversationId ? () => onOpenConversation(liveRun.conversationId) : undefined}
        />
      </section>

      <div className="mt-6 grid gap-6 lg:grid-cols-[minmax(0,1fr)_20rem]">
        <div className="min-w-0 space-y-6">
          <section aria-labelledby="quick-start">
            <h2 id="quick-start" className="mb-3 text-sm font-semibold text-white">Quick start</h2>
            <div className="grid gap-3 sm:grid-cols-2">
              {QUICK_STARTS.map((q) => (
                <button
                  key={q.title}
                  type="button"
                  disabled={!canChat}
                  onClick={() => onStartChat(q.prompt)}
                  className="group flex items-start gap-3 rounded-2xl border border-white/[0.08] bg-white/[0.025] p-4 text-left transition hover:-translate-y-0.5 hover:border-indigo-400/30 hover:bg-indigo-500/[0.05] disabled:pointer-events-none disabled:opacity-45"
                >
                  <span className="grid h-9 w-9 shrink-0 place-items-center rounded-xl bg-indigo-500/10 text-indigo-300 transition group-hover:bg-indigo-500/20">
                    <Icon name={q.icon} size={17} />
                  </span>
                  <span className="min-w-0">
                    <span className="block text-sm font-medium text-white">{q.title}</span>
                    <span className="mt-0.5 line-clamp-2 block text-xs leading-5 text-neutral-500">{q.prompt}</span>
                  </span>
                </button>
              ))}
            </div>
          </section>

          <section aria-labelledby="recent-activity">
            <div className="mb-3 flex items-center justify-between">
              <h2 id="recent-activity" className="text-sm font-semibold text-white">Recent activity</h2>
              {runsError && <span className="text-xs text-rose-300/80">Couldn’t refresh</span>}
            </div>
            <Card className="overflow-hidden">
              {runs === null ? (
                <div className="flex items-center justify-center gap-2 py-10 text-sm text-neutral-500">
                  <Spinner size={14} /> Loading activity…
                </div>
              ) : runs.length === 0 ? (
                <EmptyState icon="activity" title="No activity yet">
                  Runs you start will show up here with their status.
                </EmptyState>
              ) : (
                <ul className="divide-y divide-white/[0.05]">
                  {runs.slice(0, 7).map((run) => {
                    const meta = TARGET_TYPE_META[run.target?.type] || TARGET_TYPE_META.project
                    return (
                      <li key={run._id}>
                        <button
                          type="button"
                          onClick={() => run.conversationId && onOpenConversation(run.conversationId)}
                          disabled={!run.conversationId}
                          className="flex w-full items-center gap-3 px-4 py-3 text-left transition hover:bg-white/[0.03] disabled:cursor-default"
                        >
                          <Icon name={meta.icon} size={16} className="text-neutral-500" />
                          <span className="min-w-0 flex-1">
                            <span className="block truncate text-sm text-neutral-100">{run.task}</span>
                            <span className="block truncate text-xs text-neutral-500">
                              {targetName({ target: run.target })} · {relativeTime(run.createdAt)}
                            </span>
                          </span>
                          <StatusPill status={run.status} />
                        </button>
                      </li>
                    )
                  })}
                </ul>
              )}
            </Card>
          </section>
        </div>

        <aside className="space-y-6">
          <section aria-labelledby="agent-access">
            <div className="mb-3 flex items-center justify-between">
              <h2 id="agent-access" className="text-sm font-semibold text-white">Agent access</h2>
              <button type="button" onClick={() => onNavigate('settings', 'permissions')} className="text-xs text-indigo-300 transition hover:text-indigo-200">
                Manage
              </button>
            </div>
            <Card className="p-2">
              {scopes.length === 0 ? (
                <p className="px-3 py-4 text-xs text-neutral-500">Permissions load once the server responds.</p>
              ) : (
                <ul>
                  {scopes.map((s) => {
                    const on = !disabled.includes(s.id)
                    return (
                      <li key={s.id} className="flex items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-xs">
                        <Icon name={SCOPE_ICON[s.id]} size={14} className={on ? 'text-neutral-400' : 'text-neutral-700'} />
                        <span className={`min-w-0 flex-1 truncate ${on ? 'text-neutral-200' : 'text-neutral-600 line-through decoration-neutral-700'}`}>
                          {s.label}
                        </span>
                        <span aria-label={on ? 'On' : 'Off'} className={`h-1.5 w-1.5 rounded-full ${on ? riskDot(s.risk) : 'bg-neutral-700'}`} />
                      </li>
                    )
                  })}
                </ul>
              )}
              <p className="mx-2.5 mt-1 border-t border-white/[0.06] pb-1 pt-2.5 text-[11px] leading-4 text-neutral-500">
                Tip: ask in chat, e.g. “turn off PowerShell”.
              </p>
            </Card>
          </section>

          <section aria-labelledby="targets-heading">
            <div className="mb-3 flex items-center justify-between">
              <h2 id="targets-heading" className="text-sm font-semibold text-white">Targets</h2>
              <button type="button" onClick={() => onNavigate('settings', 'targets')} className="text-xs text-indigo-300 transition hover:text-indigo-200">
                {activeTargets.length ? 'Manage' : 'Add'}
              </button>
            </div>
            <Card className="p-2">
              {authorizations.length === 0 ? (
                <p className="px-3 py-4 text-xs leading-5 text-neutral-500">No targets yet. Add a folder or repository in Settings.</p>
              ) : (
                <ul>
                  {authorizations.slice(0, 5).map((a) => {
                    const meta = TARGET_TYPE_META[a.target.type] || TARGET_TYPE_META.project
                    const days = daysUntil(a.expiresAt)
                    return (
                      <li key={a.id} className="flex items-center gap-2.5 rounded-lg px-2.5 py-2">
                        <Icon name={meta.icon} size={15} className="text-neutral-400" />
                        <span className="min-w-0 flex-1">
                          <span className="block truncate text-xs text-neutral-200">{targetName(a)}</span>
                          <span className={`block text-[11px] ${a.status !== 'active' ? 'text-rose-300' : days !== null && days <= 14 ? 'text-amber-300' : 'text-neutral-600'}`}>
                            {a.status !== 'active' ? 'Expired' : days !== null ? `${days} day${days === 1 ? '' : 's'} left` : 'Active'}
                          </span>
                        </span>
                      </li>
                    )
                  })}
                </ul>
              )}
            </Card>
          </section>
        </aside>
      </div>
    </div>
  )
}

export default Dashboard
