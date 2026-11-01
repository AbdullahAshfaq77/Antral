import { useEffect, useState } from 'react'
import Markdown from '../Markdown.jsx'
import {
  answerApproval,
  approveSupervisorPlan,
  cancelRun,
  getRun,
  getSupervisorProjectSettings,
  pauseSupervisorRun,
  resumeSupervisorRun,
  rollbackSupervisorCheckpoint,
  saveSupervisorProjectSettings,
} from '../../../utils/agentApi.js'

const ACTIVE = ['running', 'awaiting_approval', 'awaiting_plan_approval']
const label = (value) => String(value || '').replaceAll('_', ' ').replace(/\b\w/g, (letter) => letter.toUpperCase())
const statusClass = (status) => status === 'done'
  ? 'border-emerald-400/20 bg-emerald-500/[0.08] text-emerald-200'
  : ['blocked', 'failed'].includes(status)
    ? 'border-rose-400/20 bg-rose-500/[0.08] text-rose-200'
    : ['coding', 'verifying', 'fixing', 'reviewing'].includes(status)
      ? 'border-indigo-400/20 bg-indigo-500/[0.08] text-indigo-200'
      : 'border-white/10 bg-white/[0.04] text-neutral-300'

function SupervisorBoard({ run, standaloneApproval = false }) {
  const runId = run._id || run.id
  const [supervisor, setSupervisor] = useState(run.supervisor)
  const [runStatus, setRunStatus] = useState(run.status)
  const [pendingApproval, setPendingApproval] = useState(run.pendingApproval || null)
  const [working, setWorking] = useState(false)
  const [editing, setEditing] = useState(false)
  const [editedTasks, setEditedTasks] = useState([])
  const [clarification, setClarification] = useState('')
  const [error, setError] = useState('')
  const [settings, setSettings] = useState({ godotPath: '', godotSmokeFrames: 120, verifyCommands: [] })
  const [godotDetected, setGodotDetected] = useState(false)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [settingsBusy, setSettingsBusy] = useState(false)
  const [settingsMessage, setSettingsMessage] = useState('')

  useEffect(() => {
    setSupervisor(run.supervisor)
    setRunStatus(run.status)
    setPendingApproval(run.pendingApproval || null)
  }, [run.supervisor, run.status, run.pendingApproval])

  useEffect(() => {
    if (!run.authorizationId || run.target?.type !== 'local') return undefined
    let mounted = true
    getSupervisorProjectSettings(run.authorizationId)
      .then(({ settings: value, godotDetected: detected }) => {
        if (!mounted) return
        setSettings({ ...value, verifyCommands: value.verifyCommands || [] })
        setGodotDetected(Boolean(detected))
      })
      .catch(() => {})
    return () => { mounted = false }
  }, [run.authorizationId, run.target?.type])

  useEffect(() => {
    if (!runId || (!ACTIVE.includes(runStatus) && !working)) return undefined
    let mounted = true
    const timer = setInterval(() => {
      getRun(runId).then(({ run: latest }) => {
        if (!mounted) return
        if (latest.supervisor) setSupervisor(latest.supervisor)
        setRunStatus(latest.status)
        setPendingApproval(latest.pendingApproval || null)
      }).catch(() => {})
    }, 1200)
    return () => { mounted = false; clearInterval(timer) }
  }, [runId, runStatus, working])

  if (!supervisor) return null

  const action = async (callback) => {
    setWorking(true)
    setError('')
    try {
      await callback()
      const { run: latest } = await getRun(runId)
      setSupervisor(latest.supervisor || supervisor)
      setRunStatus(latest.status)
      setPendingApproval(latest.pendingApproval || null)
    } catch (cause) {
      setError(cause.message || 'The supervisor action failed.')
    } finally {
      setWorking(false)
    }
  }

  const beginEdit = () => {
    setEditedTasks((supervisor.plan.tasks || []).map((task) => ({ ...task })))
    setEditing(true)
  }
  const approve = () => action(async () => {
    const tasks = editing ? editedTasks.map((task) => ({ title: task.title, goal: task.goal, acceptance_check: task.acceptance_check })) : undefined
    await approveSupervisorPlan(runId, tasks)
    setEditing(false)
  })
  const saveSettings = () => action(async () => {
    setSettingsBusy(true)
    try {
      const { settings: saved, godotDetected: detected } = await saveSupervisorProjectSettings(run.authorizationId, settings)
      setSettings({ ...saved, verifyCommands: saved.verifyCommands || [] })
      setGodotDetected(Boolean(detected))
      setSettingsMessage('Project verification settings saved.')
    } finally { setSettingsBusy(false) }
  })

  return (
    <section className="mt-4 overflow-hidden rounded-2xl border border-indigo-300/15 bg-[#141419]">
      <header className="flex flex-wrap items-center justify-between gap-3 border-b border-white/[0.07] px-4 py-3">
        <div>
          <p className="text-sm font-semibold text-white">Plan and execute</p>
          <p className="mt-0.5 text-xs text-neutral-500">
            {label(supervisor.status)} · {label(supervisor.phase)}
            {supervisor.currentRole ? ` · ${label(supervisor.currentRole)}` : ''}
            {supervisor.activeProvider ? ` · ${supervisor.activeProvider}${supervisor.activeModel ? ` / ${supervisor.activeModel}` : ''}` : ''}
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          {supervisor.status === 'awaiting_plan_approval' && (
            <>
              <button type="button" onClick={beginEdit} disabled={working} className="rounded-full border border-white/10 px-3 py-1.5 text-xs text-neutral-200 hover:bg-white/[0.06]">{editing ? 'Editing plan' : 'Edit plan'}</button>
              <button type="button" onClick={approve} disabled={working} className="rounded-full bg-indigo-500 px-3.5 py-1.5 text-xs font-medium text-white hover:bg-indigo-400 disabled:opacity-50">{working ? 'Saving…' : 'Approve plan'}</button>
              <button type="button" onClick={() => action(() => cancelRun(runId))} disabled={working} className="rounded-full border border-rose-300/20 px-3 py-1.5 text-xs text-rose-200 hover:bg-rose-400/10">Cancel</button>
            </>
          )}
          {['running', 'awaiting_approval'].includes(supervisor.status) && (
            <>
              <button type="button" onClick={() => action(() => pauseSupervisorRun(runId))} disabled={working} className="rounded-full border border-white/10 px-3 py-1.5 text-xs text-neutral-200 hover:bg-white/[0.06]">Pause</button>
              <button type="button" onClick={() => action(() => cancelRun(runId))} disabled={working} className="rounded-full border border-rose-300/20 px-3 py-1.5 text-xs text-rose-200 hover:bg-rose-400/10">Stop</button>
            </>
          )}
          {['paused', 'interrupted', 'blocked', 'stopped'].includes(supervisor.status) && supervisor.phase === 'clarifying' && (
            <button type="button" onClick={() => action(() => resumeSupervisorRun(runId, clarification))} disabled={working || !clarification.trim()} className="rounded-full bg-indigo-500 px-3.5 py-1.5 text-xs font-medium text-white hover:bg-indigo-400 disabled:opacity-50">Send answer</button>
          )}
          {['paused', 'interrupted', 'blocked', 'stopped'].includes(supervisor.status) && supervisor.phase !== 'clarifying' && (
            <button type="button" onClick={() => action(() => resumeSupervisorRun(runId))} disabled={working} className="rounded-full bg-indigo-500 px-3.5 py-1.5 text-xs font-medium text-white hover:bg-indigo-400 disabled:opacity-50">Resume</button>
          )}
        </div>
      </header>

      <div className="space-y-4 p-4">
        {supervisor.status === 'awaiting_plan_approval' && supervisor.planMarkdown && !editing && (
          <div className="max-h-64 overflow-auto rounded-xl border border-white/[0.07] bg-black/20 px-3 py-2 text-sm"><Markdown text={supervisor.planMarkdown} /></div>
        )}
        {editing && editedTasks.map((task, index) => (
          <fieldset key={index} className="space-y-2 rounded-xl border border-white/10 p-3">
            <legend className="px-1 text-xs text-neutral-500">Task {index + 1}</legend>
            <input value={task.title} onChange={(event) => setEditedTasks((items) => items.map((item, i) => i === index ? { ...item, title: event.target.value } : item))} aria-label={`Task ${index + 1} title`} className="w-full rounded-lg border border-white/10 bg-black/20 px-3 py-2 text-sm text-white" />
            <textarea value={task.goal} onChange={(event) => setEditedTasks((items) => items.map((item, i) => i === index ? { ...item, goal: event.target.value } : item))} aria-label={`Task ${index + 1} goal`} rows={2} className="w-full resize-y rounded-lg border border-white/10 bg-black/20 px-3 py-2 text-sm text-white" />
            <input value={task.acceptance_check} onChange={(event) => setEditedTasks((items) => items.map((item, i) => i === index ? { ...item, acceptance_check: event.target.value } : item))} aria-label={`Task ${index + 1} acceptance check`} className="w-full rounded-lg border border-white/10 bg-black/20 px-3 py-2 text-sm text-white" />
          </fieldset>
        ))}
        {supervisor.status === 'awaiting_plan_approval' && editing && <button type="button" onClick={approve} disabled={working} className="rounded-full bg-indigo-500 px-3.5 py-1.5 text-xs font-medium text-white">Save edits and approve</button>}

        {supervisor.status === 'blocked' && supervisor.phase === 'clarifying' && (
          <div className="rounded-xl border border-amber-300/20 bg-amber-400/[0.06] p-3">
            <p className="text-sm text-amber-100">{supervisor.clarification}</p>
            <textarea value={clarification} onChange={(event) => setClarification(event.target.value)} rows={2} placeholder="Your answer" className="mt-2 w-full rounded-lg border border-white/10 bg-black/20 px-3 py-2 text-sm text-white" />
          </div>
        )}

        {!!supervisor.tasks.length && (
          <ol className="space-y-2">
            {supervisor.tasks.map((task, index) => (
              <li key={task.id} className="rounded-xl border border-white/[0.07] bg-white/[0.02] p-3">
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-medium text-neutral-100">{index + 1}. {task.title}</p>
                    <p className="mt-1 text-xs leading-5 text-neutral-500">{task.goal}</p>
                    <p className="mt-1 text-[11px] text-neutral-600">Files: {task.filesToEdit.join(', ') || '—'} · Attempts: {task.attempts}</p>
                    {task.lastError && <p className="mt-2 whitespace-pre-wrap text-xs text-rose-200">{task.lastError}</p>}
                    {task.unverified && <p className="mt-2 text-xs text-amber-200">Unverified: add a project verifier before resuming.</p>}
                  </div>
                  <span className={`rounded-full border px-2.5 py-1 text-[11px] ${statusClass(task.status)}`}>{label(task.status)}{task.unverified ? ' · Unverified' : ''}</span>
                </div>
                {task.checkpointPath && (
                  <button type="button" onClick={() => action(() => rollbackSupervisorCheckpoint(runId, task.id))} disabled={working} className="mt-2 rounded-full border border-white/10 px-3 py-1 text-xs text-neutral-300 hover:bg-white/[0.06]">Restore this checkpoint</button>
                )}
              </li>
            ))}
          </ol>
        )}

        {standaloneApproval && pendingApproval && (
          <div className="rounded-xl border border-amber-300/20 bg-amber-400/[0.06] p-3">
            <p className="text-sm font-medium text-amber-100">Approval needed</p>
            <p className="mt-1 break-words text-xs text-neutral-300">{pendingApproval.summary}</p>
            <div className="mt-3 flex flex-wrap gap-2">
              {['allow_once', 'allow_always', 'decline'].map((decision) => (
                <button key={decision} type="button" disabled={working} onClick={() => action(() => answerApproval(runId, pendingApproval.id, decision))} className="rounded-full border border-white/10 px-3 py-1.5 text-xs text-neutral-200 hover:bg-white/[0.06]">{decision === 'allow_once' ? 'Allow once' : decision === 'allow_always' ? 'Always allow' : 'Decline'}</button>
              ))}
            </div>
          </div>
        )}

        {!!supervisor.events.length && (
          <details className="rounded-xl border border-white/[0.07] bg-black/10 px-3 py-2">
            <summary className="cursor-pointer text-xs text-neutral-400">Timeline · {supervisor.events.length} events</summary>
            <ol className="mt-2 space-y-1.5 text-xs text-neutral-500">
              {supervisor.events.slice(-12).reverse().map((event) => (
                <li key={event.id} className="flex gap-2">
                  <span className="w-24 shrink-0 text-neutral-600">{event.role ? label(event.role) : label(event.kind)}</span>
                  <span className="min-w-0 flex-1 break-words">{event.message}{event.provider ? ` · ${event.provider}${event.model ? ` / ${event.model}` : ''}` : ''}</span>
                </li>
              ))}
            </ol>
          </details>
        )}

        {run.target?.type === 'local' && run.authorizationId && (
          <details open={settingsOpen} onToggle={(event) => setSettingsOpen(event.currentTarget.open)} className="rounded-xl border border-white/[0.07] px-3 py-2">
            <summary className="cursor-pointer text-xs font-medium text-neutral-300">Project verification settings {godotDetected ? '· Godot detected' : ''}</summary>
            <div className="mt-3 space-y-3">
              <label className="block text-xs text-neutral-500">Godot executable path
                <input value={settings.godotPath || ''} onChange={(event) => setSettings((value) => ({ ...value, godotPath: event.target.value }))} placeholder="Auto-detected when available" className="mt-1 w-full rounded-lg border border-white/10 bg-black/20 px-3 py-2 text-sm text-neutral-100" />
              </label>
              <label className="block text-xs text-neutral-500">Smoke run frames (1–600)
                <input type="number" min="1" max="600" value={settings.godotSmokeFrames || 120} onChange={(event) => setSettings((value) => ({ ...value, godotSmokeFrames: Number(event.target.value) }))} className="mt-1 w-32 rounded-lg border border-white/10 bg-black/20 px-3 py-2 text-sm text-neutral-100" />
              </label>
              <label className="block text-xs text-neutral-500">Verification commands, one per line
                <textarea value={(settings.verifyCommands || []).join('\n')} onChange={(event) => setSettings((value) => ({ ...value, verifyCommands: event.target.value.split(/\r?\n/).map((line) => line.trim()).filter(Boolean) }))} rows={3} placeholder={'npm test\npython -m pytest'} className="mt-1 w-full rounded-lg border border-white/10 bg-black/20 px-3 py-2 font-mono text-xs text-neutral-100" />
              </label>
              <p className="text-[11px] text-neutral-600">Verification runs through Antral’s command approval. Use only commands you trust.</p>
              {settingsMessage && <p className="text-xs text-emerald-300">{settingsMessage}</p>}
              <button type="button" onClick={saveSettings} disabled={settingsBusy || working} className="rounded-full border border-white/10 px-3 py-1.5 text-xs text-neutral-200 hover:bg-white/[0.06]">{settingsBusy ? 'Saving…' : 'Save verification settings'}</button>
            </div>
          </details>
        )}
        {error && <p role="alert" className="text-xs text-rose-200">{error}</p>}
      </div>
    </section>
  )
}

export default SupervisorBoard
