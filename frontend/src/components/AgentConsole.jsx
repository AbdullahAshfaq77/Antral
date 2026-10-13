import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useDispatch, useSelector } from 'react-redux'
import AntralLogo from './AntralLogo.jsx'
import Icon from './ui/Icon.jsx'
import { ConfirmDialog, Spinner } from './ui/primitives.jsx'
import { useToast } from './ui/toast.js'
import Composer from './chat/Composer.jsx'
import Turn from './chat/Turn.jsx'
import { ImageGallery, ImageViewer } from './chat/ImageGallery.jsx'
import Dashboard from '../pages/Dashboard.jsx'
import Settings from '../pages/Settings.jsx'
import TargetAuthorizationDialog from './TargetAuthorizationDialog.jsx'
import { loadConsent, refreshConsent } from '../store/consentSlice.js'
import { useHashRoute } from '../lib/useHashRoute.js'
import { ACTIVE } from '../lib/runs.js'
import { QUICK_STARTS } from '../lib/quickStarts.js'
import { relativeTime, TARGET_TYPE_META, targetName } from '../lib/format.js'
import {
  answerApproval,
  cancelRun,
  deleteConversation,
  deleteProject,
  getConversation,
  getRun,
  listConversations,
  listRuns,
  startRun,
} from '../../utils/agentApi.js'

const POLL_MS = 1200
const MAX_IMAGES = 3
const MAX_IMAGE_BYTES = 5 * 1024 * 1024
const MAX_TOTAL_IMAGE_BYTES = 15 * 1024 * 1024
const IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/webp']
const PERMISSION_TOOLS = /^(turn_(on|off)_permission|add_project|switch_to_global)$/

const VIEW_TITLES = { dashboard: 'Dashboard', chat: 'Chat', images: 'Images', settings: 'Settings' }

const NAV = [
  { key: 'dashboard', label: 'Dashboard', icon: 'dashboard' },
  { key: 'chat', label: 'Chat', icon: 'chat' },
  { key: 'images', label: 'Images', icon: 'image' },
]

const SOON = [
  { key: 'library', label: 'Library', icon: 'library' },
  { key: 'scheduled', label: 'Scheduled', icon: 'clock' },
]

const targetKey = (target) => `${target?.type}|${target?.identifier}`

function readImage(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => {
      if (typeof reader.result === 'string') resolve(reader.result)
      else reject(new Error('Could not read this image.'))
    }
    reader.onerror = () => reject(new Error('Could not read this image.'))
    reader.readAsDataURL(file)
  })
}

// Today / Previous 7 days / Older, newest first.
function groupConversations(list) {
  const startOfToday = new Date()
  startOfToday.setHours(0, 0, 0, 0)
  const weekAgo = startOfToday.getTime() - 7 * 86400000
  const groups = [
    { label: 'Today', items: [] },
    { label: 'Previous 7 days', items: [] },
    { label: 'Older', items: [] },
  ]
  list.forEach((c) => {
    const at = new Date(c.updatedAt || c.createdAt).getTime()
    if (at >= startOfToday.getTime()) groups[0].items.push(c)
    else if (at >= weekAgo) groups[1].items.push(c)
    else groups[2].items.push(c)
  })
  return groups.filter((g) => g.items.length)
}

function ErrorBanner({ error, onAction, onDismiss, className = '' }) {
  return (
    <div role="alert" className={`error-in flex items-start gap-2.5 rounded-xl border border-rose-400/20 bg-rose-500/[0.08] px-3.5 py-2.5 text-sm text-rose-100 ${className}`}>
      <Icon name="alert" size={16} className="mt-0.5 text-rose-300" />
      <span className="min-w-0 flex-1">{error.message}</span>
      {error.action && (
        <button type="button" onClick={() => onAction(error.action.to)} className="shrink-0 text-xs font-medium text-rose-200 underline-offset-2 hover:underline">
          {error.action.label}
        </button>
      )}
      <button type="button" onClick={onDismiss} aria-label="Dismiss" className="grid h-5 w-5 shrink-0 place-items-center rounded text-rose-300/70 hover:text-rose-200">
        <Icon name="x" size={13} />
      </button>
    </div>
  )
}

// App shell: sidebar navigation, the dashboard, chat with the agent team,
// the image gallery and settings. Chat state lives here so a run keeps
// streaming while the user looks at another page.
function AgentConsole({ profile }) {
  const dispatch = useDispatch()
  const toast = useToast()
  const user = useSelector((state) => state.auth.user)
  const consentStatus = useSelector((state) => state.consent.status)
  const account = useSelector((state) => state.consent.account)
  const policies = useSelector((state) => state.consent.policies)
  const authorizations = useSelector((state) => state.consent.authorizations)
  const targets = useMemo(() => authorizations.filter((a) => a.status === 'active'), [authorizations])
  const computerTargetAvailable = Boolean(policies?.features?.computerTarget)
  const route = useHashRoute('dashboard')
  const { view, sub } = route
  const [drawerOpen, setDrawerOpen] = useState(false)
  const routeNavigate = route.navigate
  const navigate = useCallback(
    (...parts) => {
      setDrawerOpen(false)
      routeNavigate(...parts)
    },
    [routeNavigate],
  )

  const [targetId, setTargetId] = useState('')
  const [conversationId, setConversationId] = useState(null)
  const [conversationTarget, setConversationTarget] = useState(null)
  const [thread, setThread] = useState([])
  const [liveRun, setLiveRun] = useState(null)
  const [conversations, setConversations] = useState(null)
  const [opening, setOpening] = useState(false)
  const [task, setTask] = useState('')
  const [error, setError] = useState(null) // { message, action? }
  const [sending, setSending] = useState(false)
  const [answering, setAnswering] = useState(false)
  const [attachments, setAttachments] = useState([])
  const [galleryArchive, setGalleryArchive] = useState([])
  const [viewerImage, setViewerImage] = useState(null)
  const [search, setSearch] = useState('')
  const [deleting, setDeleting] = useState(null) // conversation pending delete
  const [deleteBusy, setDeleteBusy] = useState(false)
  const [deletingProject, setDeletingProject] = useState(null) // { auth, chats }
  const [authorizingComputer, setAuthorizingComputer] = useState(false)
  const [collapsed, setCollapsed] = useState({}) // project id -> true when folded
  const scrollRef = useRef(null)
  const bottomRef = useRef(null)
  const inputRef = useRef(null)
  const attachmentsRef = useRef([])
  const permissionSteps = useRef(0)
  const scrolledFor = useRef({ conversationId: null, length: 0 })
  const conversationIdRef = useRef(null)
  useEffect(() => {
    conversationIdRef.current = conversationId
  }, [conversationId])

  const userName = [profile?.firstName, profile?.lastName].filter(Boolean).join(' ') || 'Your account'
  const initials =
    userName
      .split(/\s+/)
      .slice(0, 2)
      .map((part) => part[0])
      .join('')
      .toUpperCase() || 'U'

  const accepted = Boolean(account?.accepted)
  const currentView = VIEW_TITLES[view] ? view : 'dashboard'

  useEffect(() => {
    if (consentStatus === 'idle') dispatch(loadConsent())
  }, [consentStatus, dispatch])

  useEffect(() => {
    document.title = `${VIEW_TITLES[currentView]} · Antral`
  }, [currentView])

  const replaceAttachments = (next) => {
    attachmentsRef.current = next
    setAttachments(next)
  }

  useEffect(
    () => () => attachmentsRef.current.forEach((attachment) => URL.revokeObjectURL(attachment.previewUrl)),
    [],
  )

  const addAttachments = (files) => {
    const next = [...attachmentsRef.current]
    let totalBytes = next.reduce((total, attachment) => total + attachment.file.size, 0)
    let problem = ''

    for (const file of files) {
      if (!IMAGE_TYPES.includes(file.type)) {
        problem = 'Only PNG, JPEG and WebP images can be attached.'
        continue
      }
      if (file.size > MAX_IMAGE_BYTES) {
        problem = 'Each image must be 5 MB or smaller.'
        continue
      }
      if (next.length >= MAX_IMAGES) {
        problem = `You can attach up to ${MAX_IMAGES} images at a time.`
        continue
      }
      if (totalBytes + file.size > MAX_TOTAL_IMAGE_BYTES) {
        problem = 'Attached images must total 15 MB or less.'
        continue
      }
      next.push({ id: `${Date.now()}-${Math.random().toString(36).slice(2)}`, file, previewUrl: URL.createObjectURL(file) })
      totalBytes += file.size
    }

    if (next.length !== attachmentsRef.current.length) replaceAttachments(next)
    if (problem) toast({ tone: 'error', message: problem })
  }

  const removeAttachment = (id) => {
    const removed = attachmentsRef.current.find((attachment) => attachment.id === id)
    if (removed) URL.revokeObjectURL(removed.previewUrl)
    replaceAttachments(attachmentsRef.current.filter((attachment) => attachment.id !== id))
  }

  const galleryImages = useMemo(() => {
    const runImages = [...galleryArchive]
    ;[...thread, ...(liveRun ? [liveRun] : [])].forEach((run) => {
      ;(Array.isArray(run?.attachments) ? run.attachments : []).forEach((attachment, index) => {
        const src = attachment?.dataUrl || attachment?.previewUrl || attachment?.url
        if (!src) return
        runImages.push({ id: `${run?._id || run?.id || 'run'}-${index}`, src, name: attachment?.name || `Image ${index + 1}` })
      })
    })
    return [...new Map(runImages.map((image) => [image.id, image])).values()].reverse()
  }, [galleryArchive, thread, liveRun])

  // The target this chat talks to: the conversation's own target once it has
  // one, otherwise the user's pick (default: Global (This PC) when it is
  // authorized, else the first authorized target).
  const selected = conversationTarget
    ? targets.find((a) => a.target.type === conversationTarget.type && a.target.identifier === conversationTarget.identifier) || null
    : targets.find((a) => a.id === targetId) || targets.find((a) => a.target.type === 'computer') || targets[0] || null

  const refreshConversations = useCallback(() => {
    listConversations()
      .then(({ conversations: list }) => setConversations(list))
      .catch(() => setConversations((current) => current || []))
  }, [])

  const openConversation = useCallback(
    async (id) => {
      setError(null)
      setOpening(true)
      navigate('chat')
      try {
        const { conversation, runs } = await getConversation(id)
        setConversationId(conversation.id)
        setConversationTarget(conversation.target)
        setThread(runs)
        const active = runs.find((r) => ACTIVE.includes(r.status))
        setLiveRun(active ? (await getRun(active._id)).run : null)
      } catch {
        toast({ tone: 'error', message: "I couldn't open that conversation. It may have expired." })
      } finally {
        setOpening(false)
      }
    },
    [navigate, toast],
  )

  // On load: list chats, and reattach to a run still working in the background.
  useEffect(() => {
    refreshConversations()
    listRuns()
      .then(({ runs }) => {
        const active = runs.find((r) => ACTIVE.includes(r.status))
        if (!active?.conversationId) return
        getConversation(active.conversationId)
          .then(async ({ conversation, runs: convRuns }) => {
                setConversationId(conversation.id)
            setConversationTarget(conversation.target)
            setThread(convRuns)
            setLiveRun((await getRun(active._id)).run)
          })
          .catch(() => {})
      })
      .catch(() => {})
  }, [refreshConversations])

  // Poll the live run until it finishes.
  const liveId = liveRun?._id
  const liveActive = Boolean(liveRun && ACTIVE.includes(liveRun.status))
  useEffect(() => {
    if (!liveId || !liveActive) return undefined
    permissionSteps.current = 0
    const timer = setInterval(async () => {
      try {
        const { run } = await getRun(liveId)
        setLiveRun((current) => ({ ...run, attachments: current?.attachments || [] }))

        // The agent changed a permission from chat: refresh Settings right away.
        const changed = (run.steps || []).filter((s) => s.kind === 'tool_result' && s.ok && PERMISSION_TOOLS.test(s.tool)).length
        if (changed !== permissionSteps.current) {
          permissionSteps.current = changed
          const refreshed = dispatch(refreshConsent())
          // The agent added a project and moved this chat into it: follow it there.
          if ((run.steps || []).some((s) => s.kind === 'tool_result' && s.ok && /^(add_project|switch_to_global)$/.test(s.tool))) {
            Promise.all([refreshed, getConversation(run.conversationId)])
              .then(([, { conversation }]) => {
                if (conversationIdRef.current === conversation.id) setConversationTarget(conversation.target)
                refreshConversations()
              })
              .catch(() => {})
          }
        }

        if (!ACTIVE.includes(run.status)) {
          setThread((t) => t.map((r) => (r._id === run._id ? { ...run, attachments: r.attachments || [] } : r)))
          // The chat switched to Global and the request continues in a new run.
          if (run.continuedBy) {
            const { run: next } = await getRun(run.continuedBy)
            if (conversationIdRef.current === next.conversationId) {
              setConversationTarget(next.target)
              setThread((t) => (t.some((r) => r._id === next._id) ? t : [...t, next]))
              setLiveRun(next)
            }
          }
          refreshConversations()
          dispatch(refreshConsent())
        }
      } catch {
        // keep polling; transient errors are fine
      }
    }, POLL_MS)
    return () => clearInterval(timer)
  }, [liveId, liveActive, refreshConversations, dispatch])

  // Keep the newest message in view, but don't yank the user back down if
  // they scrolled up to read something. Opening a chat, sending, and an
  // approval request always scroll, so a question is never hidden.
  const stepCount = liveRun?.steps?.length
  const liveStatus = liveRun?.status
  useEffect(() => {
    const container = scrollRef.current
    if (!container) return
    const seen = scrolledFor.current
    const opened = conversationId !== seen.conversationId
    const sent = !opened && thread.length > seen.length
    scrolledFor.current = { conversationId, length: thread.length }
    const nearBottom = container.scrollHeight - container.scrollTop - container.clientHeight < 240
    if (opened || sent || liveStatus === 'awaiting_approval' || nearBottom) {
      requestAnimationFrame(() => bottomRef.current?.scrollIntoView({ behavior: opened ? 'auto' : 'smooth', block: 'end' }))
    }
  }, [conversationId, thread.length, stepCount, liveStatus, opening])

  const newChat = useCallback(
    (prompt, projectId) => {
      // A plain "new chat" starts on the default target (Global when authorized).
      setTargetId(projectId || '')
      setConversationId(null)
      setConversationTarget(null)
      setThread([])
      setLiveRun((current) => (current && ACTIVE.includes(current.status) ? current : null))
      setError(null)
      if (typeof prompt === 'string') setTask(prompt)
      navigate('chat')
      requestAnimationFrame(() => inputRef.current?.focus())
    },
    [navigate],
  )

  // Ctrl/Cmd + Shift + O starts a new chat from anywhere.
  useEffect(() => {
    const onKey = (event) => {
      if ((event.ctrlKey || event.metaKey) && event.shiftKey && event.key.toLowerCase() === 'o') {
        event.preventDefault()
        newChat()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [newChat])

  const describeStartError = (err) => {
    const missing = err.payload?.missingScopes || err.payload?.disabledScopes
    if (missing?.length) {
      return { message: `This target needs more permissions: ${missing.join(', ')}.`, action: { label: 'Permissions', to: ['settings', 'permissions'] } }
    }
    if (err.payload?.consentRequired === 'account') {
      return { message: 'Please accept the current policies before starting a run.', action: { label: 'Review policies', to: ['settings', 'privacy'] } }
    }
    if (err.payload?.consentRequired === 'target') {
      return { message: 'This target is no longer authorized. Re-authorize it, then try again.', action: { label: 'Targets', to: ['settings', 'targets'] } }
    }
    if (err.status === 409) return { message: 'The agent is still working on something. Wait for it to finish or stop it first.' }
    if (err.status === 413) return { message: 'The images are too large. Attach images totaling no more than 15 MB.' }
    if (err.status === 503) return { message: "The AI model isn't configured on the server right now." }
    if (err.status === 400 || err.status === 422) return { message: err.message }
    return { message: err.message || "I couldn't start that run. Please try again." }
  }

  const send = async () => {
    const text = task.trim()
    const selectedAttachments = attachmentsRef.current
    if ((!text && !selectedAttachments.length) || !selected || sending) return
    setSending(true)
    setError(null)
    try {
      const imagePayload = await Promise.all(
        selectedAttachments.map(async ({ file }) => ({ dataUrl: await readImage(file), name: file.name, mimeType: file.type })),
      )
      const submittedTask = text || 'Please describe the attached image(s).'
      const { run } = await startRun({
        target: { type: selected.target.type, identifier: selected.target.identifier },
        task: submittedTask,
        attachments: imagePayload.map(({ dataUrl, mimeType }) => ({ dataUrl, mimeType })),
        conversationId: conversationId || undefined,
      })
      setConversationId(run.conversationId)
      setConversationTarget({ type: selected.target.type, identifier: selected.target.identifier })
      setGalleryArchive((images) => [
        ...images,
        ...imagePayload.map((image, index) => ({ id: `${run.id}-${index}`, src: image.dataUrl, name: image.name || `Image ${index + 1}` })),
      ])
      const localRun = {
        _id: run.id,
        conversationId: run.conversationId,
        status: run.status,
        task: submittedTask,
        steps: [],
        attachments: imagePayload,
        createdAt: new Date().toISOString(),
      }
      setThread((t) => [...t, localRun])
      setLiveRun(localRun)
      setTask('')
      selectedAttachments.forEach((attachment) => URL.revokeObjectURL(attachment.previewUrl))
      replaceAttachments([])
      refreshConversations()
    } catch (err) {
      setError(describeStartError(err))
    } finally {
      setSending(false)
    }
  }

  const onAnswer = async (decision) => {
    if (!liveRun?.pendingApproval) return
    setAnswering(true)
    try {
      await answerApproval(liveRun._id, liveRun.pendingApproval.id, decision)
      setLiveRun((r) => ({ ...r, status: 'running', pendingApproval: null }))
    } catch (err) {
      toast({ tone: 'error', message: err.status === 409 ? 'That request already expired or was answered.' : "I couldn't send your answer. Please try again." })
    } finally {
      setAnswering(false)
    }
  }

  const onStop = async () => {
    if (!liveRun) return
    try {
      await cancelRun(liveRun._id)
      toast({ message: 'Stopping the agent…' })
    } catch {
      toast({ tone: 'error', message: "I couldn't stop the run. Please try again." })
    }
  }

  const confirmDelete = async () => {
    setDeleteBusy(true)
    try {
      await deleteConversation(deleting.id)
      if (deleting.id === conversationId) newChat()
      setConversations((list) => (list || []).filter((c) => c.id !== deleting.id))
      toast({ tone: 'success', message: 'Conversation deleted.' })
      setDeleting(null)
    } catch {
      toast({ tone: 'error', message: "I couldn't delete that conversation. Please try again." })
    } finally {
      setDeleteBusy(false)
    }
  }

  const confirmDeleteProject = async () => {
    const { auth } = deletingProject
    setDeleteBusy(true)
    try {
      await deleteProject(auth.id)
      if (conversationTarget && targetKey(conversationTarget) === targetKey(auth.target)) newChat()
      if (targetId === auth.id) setTargetId('')
      dispatch(refreshConsent())
      refreshConversations()
      toast({ tone: 'success', message: `Project “${targetName(auth)}” deleted.` })
      setDeletingProject(null)
    } catch (err) {
      toast({ tone: 'error', message: err.status === 409 ? err.message : "I couldn't delete that project. Please try again." })
    } finally {
      setDeleteBusy(false)
    }
  }

  const onComputerAuthorized = async (authorization) => {
    setAuthorizingComputer(false)
    const refreshed = await dispatch(refreshConsent())
    if (!refreshConsent.fulfilled.match(refreshed)) {
      toast({ tone: 'error', message: 'Global was authorized, but the target list could not be refreshed. Reload the app to use it.' })
      return
    }
    newChat(undefined, authorization.id)
  }

  const busy = liveActive || sending
  const liveElsewhere = liveActive && liveRun.conversationId !== conversationId

  const blocked =
    consentStatus !== 'ready'
      ? null
      : !accepted
        ? { message: 'Accept the policies to start using the agents.', actionLabel: 'Review policies', onAction: () => navigate('settings', 'privacy') }
        : conversationTarget && !selected
          ? { message: 'This chat’s target is no longer authorized.', actionLabel: 'Manage targets', onAction: () => navigate('settings', 'targets') }
          : !targets.length
            ? { message: 'Authorize a folder or repository so the agents have something to work on.', actionLabel: 'Add a target', onAction: () => navigate('settings', 'targets') }
            : liveElsewhere
              ? { message: 'The agent is busy in another chat.', actionLabel: 'Go to it', onAction: () => openConversation(liveRun.conversationId) }
              : null

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase()
    return (conversations || []).filter((c) => !q || (c.title || '').toLowerCase().includes(q))
  }, [conversations, search])
  // Chats grouped into their projects, most recently used project first.
  // Chats whose project was removed land in "Other chats".
  const projects = useMemo(() => {
    const projectTargets = targets.filter((auth) => auth.target.type !== 'computer')
    const byTarget = new Map(projectTargets.map((auth) => [targetKey(auth.target), { auth, chats: [], at: 0 }]))
    const other = []
    filtered.forEach((c) => {
      const project = byTarget.get(targetKey(c.target))
      if (!project) return other.push(c)
      project.chats.push(c)
      project.at = Math.max(project.at, new Date(c.updatedAt || c.createdAt).getTime())
    })
    const list = [...byTarget.values()]
      .filter((p) => !search.trim() || p.chats.length)
      .sort((a, b) => b.at - a.at)
    return { list, other: groupConversations(other) }
  }, [targets, filtered, search])

  const composer = (placeholder) => (
    <Composer
      value={task}
      onChange={setTask}
      onSubmit={send}
      attachments={attachments}
      onAddFiles={addAttachments}
      onRemoveAttachment={removeAttachment}
      busy={busy}
      sending={sending}
      onStop={liveActive && !liveElsewhere ? onStop : null}
      blocked={blocked}
      placeholder={placeholder}
      inputRef={inputRef}
      footer={busy && !sending ? 'The agent keeps working in the background. You can leave this page.' : null}
    />
  )

  const navButton = (item) => {
    const active = currentView === item.key
    return (
      <button
        key={item.key}
        type="button"
        onClick={() => navigate(item.key)}
        aria-current={active ? 'page' : undefined}
        className={`flex h-9 w-full items-center gap-3 rounded-lg px-3 text-left text-sm transition ${
          active ? 'bg-white/[0.08] font-medium text-white' : 'text-neutral-400 hover:bg-white/[0.04] hover:text-white'
        }`}
      >
        <Icon name={item.icon} size={17} className={active ? 'text-indigo-300' : ''} />
        <span className="flex-1">{item.label}</span>
        {item.key === 'chat' && liveActive && (
          <span
            aria-label={liveRun.status === 'awaiting_approval' ? 'Needs your approval' : 'Agent working'}
            className={`h-2 w-2 rounded-full ${liveRun.status === 'awaiting_approval' ? 'bg-amber-400' : 'animate-pulse bg-indigo-400'}`}
          />
        )}
      </button>
    )
  }

  const chatItem = (c) => {
    const current = conversationId === c.id && currentView === 'chat'
    const working = liveActive && liveRun.conversationId === c.id
    return (
      <li key={c.id} className="group/chat relative">
        <button
          type="button"
          onClick={() => openConversation(c.id)}
          title={`${c.title || 'New conversation'} · ${relativeTime(c.updatedAt)}`}
          className={`flex w-full items-center gap-2 rounded-lg py-2 pl-2.5 pr-8 text-left text-[13px] transition ${
            current ? 'bg-white/[0.08] text-white' : 'text-neutral-400 hover:bg-white/[0.04] hover:text-neutral-100'
          }`}
        >
          {working && <span className="h-1.5 w-1.5 shrink-0 animate-pulse rounded-full bg-indigo-400" />}
          <span className="truncate">{c.title?.trim() || 'New conversation'}</span>
        </button>
        <button
          type="button"
          onClick={() => setDeleting(c)}
          aria-label={`Delete “${c.title || 'conversation'}”`}
          className="absolute right-1 top-1/2 grid h-7 w-7 -translate-y-1/2 place-items-center rounded-md text-neutral-500 opacity-0 transition hover:bg-white/10 hover:text-rose-300 focus-visible:opacity-100 group-hover/chat:opacity-100"
        >
          <Icon name="trash" size={14} />
        </button>
      </li>
    )
  }

  const sidebar = (
    <div className="flex h-full flex-col">
      <div className="flex h-14 shrink-0 items-center justify-between gap-2.5 px-4">
        <button type="button" onClick={() => navigate('dashboard')} className="flex items-center gap-2.5" aria-label="Antral home">
          <AntralLogo size={28} />
          <span className="text-sm font-semibold tracking-[0.18em]">ANTRAL</span>
        </button>
        <button
          type="button"
          onClick={() => setDrawerOpen(false)}
          aria-label="Close menu"
          className="grid h-8 w-8 place-items-center rounded-lg text-neutral-400 transition hover:bg-white/10 hover:text-white md:hidden"
        >
          <Icon name="x" size={16} />
        </button>
      </div>

      <div className="px-3">
        <button
          type="button"
          onClick={() => newChat()}
          title="New chat (Ctrl+Shift+O)"
          className="flex h-10 w-full items-center gap-3 rounded-xl border border-white/10 bg-white/[0.06] px-3 text-left text-sm font-medium transition hover:border-white/20 hover:bg-white/10"
        >
          <Icon name="plus" size={17} />
          <span className="flex-1">New chat</span>
        </button>
      </div>

      <nav className="mt-3 space-y-0.5 px-3" aria-label="Main navigation">
        {NAV.map(navButton)}
        {SOON.map((item) => (
          <div
            key={item.key}
            aria-disabled="true"
            title={`${item.label} is coming soon`}
            className="flex h-9 w-full cursor-default items-center gap-3 rounded-lg px-3 text-sm text-neutral-600"
          >
            <Icon name={item.icon} size={17} />
            <span className="flex-1">{item.label}</span>
            <span className="rounded-full border border-white/[0.08] px-1.5 py-px text-[10px] text-neutral-500">Soon</span>
          </div>
        ))}
      </nav>

      <div className="mt-5 flex min-h-0 flex-1 flex-col">
        <div className="flex items-center justify-between pb-2 pl-5 pr-3">
          <h2 className="text-xs font-medium text-neutral-500">Projects</h2>
          <button
            type="button"
            onClick={() => navigate('settings', 'targets')}
            title="Add a project, or just tell the agent which folder you want to work on"
            aria-label="Add a project"
            className="grid h-6 w-6 place-items-center rounded-md text-neutral-500 transition hover:bg-white/10 hover:text-white"
          >
            <Icon name="plus" size={14} />
          </button>
        </div>
        {(conversations?.length || 0) > 6 && (
          <label className="mx-3 mb-2 flex items-center gap-2 rounded-lg border border-white/[0.08] bg-black/20 px-2.5 focus-within:border-white/20">
            <Icon name="search" size={14} className="text-neutral-500" />
            <input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search chats"
              aria-label="Search chats"
              className="h-8 min-w-0 flex-1 bg-transparent text-xs text-white placeholder:text-neutral-600 focus:outline-none"
            />
          </label>
        )}
        <div className="scrollbar-thin min-h-0 flex-1 overflow-y-auto px-3 pb-3">
          {conversations === null ? (
            <div className="space-y-1.5 px-2 pt-1" aria-label="Loading conversations">
              {[70, 55, 80].map((w) => (
                <span key={w} className="skeleton block h-7 rounded-lg" style={{ width: `${w}%` }} />
              ))}
            </div>
          ) : projects.list.length === 0 && projects.other.length === 0 ? (
            <p className="px-2 py-1 text-xs leading-5 text-neutral-600">
              {search ? 'No chats match your search.' : 'Your projects and their chats will appear here.'}
            </p>
          ) : (
            <>
              {projects.list.map(({ auth, chats }) => {
                const open = Boolean(search.trim()) || !collapsed[auth.id]
                const name = targetName(auth)
                return (
                  <div key={auth.id} className="mb-1">
                    <div className="group relative">
                      <button
                        type="button"
                        onClick={() => setCollapsed((c) => ({ ...c, [auth.id]: open }))}
                        aria-expanded={open}
                        title={auth.target.identifier}
                        className="flex w-full items-center gap-2 rounded-lg py-2 pl-2 pr-16 text-left text-[13px] text-neutral-300 transition hover:bg-white/[0.04] hover:text-white"
                      >
                        <Icon name="chevronRight" size={12} className={`shrink-0 text-neutral-600 transition-transform ${open ? 'rotate-90' : ''}`} />
                        <Icon name={(TARGET_TYPE_META[auth.target.type] || TARGET_TYPE_META.project).icon} size={15} className="shrink-0 text-neutral-500" />
                        <span className="truncate">{name}</span>
                      </button>
                      <span className="pointer-events-none absolute right-2.5 top-1/2 -translate-y-1/2 text-[11px] text-neutral-600 group-focus-within:opacity-0 group-hover:opacity-0">
                        {chats.length || ''}
                      </span>
                      <div className="absolute right-1 top-1/2 flex -translate-y-1/2 opacity-0 transition focus-within:opacity-100 group-hover:opacity-100">
                        <button
                          type="button"
                          onClick={() => newChat(undefined, auth.id)}
                          aria-label={`New chat in “${name}”`}
                          title="New chat in this project"
                          className="grid h-7 w-7 place-items-center rounded-md text-neutral-500 hover:bg-white/10 hover:text-white"
                        >
                          <Icon name="plus" size={14} />
                        </button>
                        <button
                          type="button"
                          onClick={() => setDeletingProject({ auth, chats: chats.length })}
                          aria-label={`Delete project “${name}”`}
                          title="Delete project"
                          className="grid h-7 w-7 place-items-center rounded-md text-neutral-500 hover:bg-white/10 hover:text-rose-300"
                        >
                          <Icon name="trash" size={14} />
                        </button>
                      </div>
                    </div>
                    {open && (
                      <ul className="ml-[15px] space-y-px border-l border-white/[0.06] pl-1.5">
                        {chats.length ? chats.map(chatItem) : <li className="px-2.5 py-1.5 text-xs text-neutral-600">No chats yet</li>}
                      </ul>
                    )}
                  </div>
                )
              })}
              {projects.other.map((group) => (
                <div key={group.label} className="mb-3 mt-3">
                  <p className="px-2 pb-1 text-[11px] text-neutral-600">Other chats · {group.label}</p>
                  <ul className="space-y-px">{group.items.map(chatItem)}</ul>
                </div>
              ))}
            </>
          )}
        </div>
      </div>

      <button
        type="button"
        onClick={() => navigate('settings')}
        aria-current={currentView === 'settings' ? 'page' : undefined}
        className={`flex shrink-0 items-center gap-3 border-t border-white/[0.07] px-4 py-3 text-left transition hover:bg-white/[0.04] ${
          currentView === 'settings' ? 'bg-white/[0.05]' : ''
        }`}
      >
        {user?.photoURL ? (
          <img src={user.photoURL} alt="" referrerPolicy="no-referrer" className="h-9 w-9 shrink-0 rounded-full object-cover" />
        ) : (
          <span className="grid h-9 w-9 shrink-0 place-items-center rounded-full bg-gradient-to-br from-teal-400 to-indigo-500 text-xs font-semibold text-black">
            {initials}
          </span>
        )}
        <span className="min-w-0 flex-1">
          <span className="block truncate text-sm font-medium">{userName}</span>
          <span className="block truncate text-xs text-neutral-500">{user?.email || 'Account settings'}</span>
        </span>
        <span className="relative">
          <Icon name="settings" size={17} className="text-neutral-500" />
          {account && !accepted && <span aria-label="Action needed" className="absolute -right-0.5 -top-0.5 h-2 w-2 rounded-full bg-amber-400" />}
        </span>
      </button>
    </div>
  )

  const conversationTitle = conversationId ? conversations?.find((c) => c.id === conversationId)?.title : null
  const typeMeta = selected ? TARGET_TYPE_META[selected.target.type] || TARGET_TYPE_META.project : null

  return (
    <main className="flex h-dvh overflow-hidden bg-[#0a0a0c] text-white">
      {/* Sidebar: static on desktop, a drawer on small screens. */}
      <aside className="hidden w-64 shrink-0 border-r border-white/[0.07] bg-[#0d0d10] md:block" aria-label="Sidebar">
        {sidebar}
      </aside>
      {drawerOpen && (
        <div className="fixed inset-0 z-40 md:hidden">
          <div className="modal-backdrop absolute inset-0 bg-black/60 backdrop-blur-sm" onClick={() => setDrawerOpen(false)} />
          <aside className="drawer-in relative h-full w-72 max-w-[85vw] border-r border-white/10 bg-[#0d0d10] shadow-2xl" aria-label="Sidebar">
            {sidebar}
          </aside>
        </div>
      )}

      <section className="flex h-dvh min-h-0 min-w-0 flex-1 flex-col overflow-hidden" aria-label={VIEW_TITLES[currentView]}>
        <header className="flex h-14 shrink-0 items-center gap-3 border-b border-white/[0.06] px-4 sm:px-5">
          <button
            type="button"
            onClick={() => setDrawerOpen(true)}
            aria-label="Open menu"
            className="-ml-1 grid h-9 w-9 place-items-center rounded-lg text-neutral-300 transition hover:bg-white/10 md:hidden"
          >
            <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden="true">
              <path d="M4 7h16M4 12h16M4 17h10" />
            </svg>
          </button>
          <h1 className="min-w-0 flex-1 truncate text-sm font-medium text-neutral-200">
            {currentView === 'chat' && conversationTitle ? conversationTitle : VIEW_TITLES[currentView]}
          </h1>

          {currentView === 'chat' && selected && (
            <label className="relative flex max-w-[min(55vw,16rem)] items-center gap-2 rounded-full border border-white/10 bg-white/[0.03] py-1 pl-2.5 pr-2 text-xs text-neutral-300 transition focus-within:border-white/25 hover:border-white/20">
              <Icon name={typeMeta.icon} size={14} className="text-neutral-400" />
              <span className="sr-only">Target</span>
              <select
                value={selected.id}
                onChange={(e) => {
                  if (e.target.value === '__authorize_computer__') {
                    setAuthorizingComputer(true)
                    return
                  }
                  newChat(undefined, e.target.value)
                }}
                disabled={
                  Boolean(conversationId) ||
                  (targets.length < 2 && !(computerTargetAvailable && !targets.some((a) => a.target.type === 'computer')))
                }
                title={conversationId ? 'Start a new chat to switch targets' : targetName(selected)}
                className="min-w-0 max-w-full cursor-pointer appearance-none truncate bg-transparent pr-4 text-xs text-neutral-100 focus:outline-none disabled:cursor-default"
              >
                {targets.map((a) => (
                  <option key={a.id} value={a.id} className="bg-[#18181c]">
                    {targetName(a)}
                  </option>
                ))}
                {computerTargetAvailable && !targets.some((a) => a.target.type === 'computer') && (
                      <option value="__authorize_computer__" className="bg-[#18181c]">
                        Authorize Global…
                  </option>
                )}
              </select>
              {!conversationId &&
                (targets.length > 1 || (computerTargetAvailable && !targets.some((a) => a.target.type === 'computer'))) && (
                  <Icon name="chevronDown" size={12} className="pointer-events-none absolute right-2 text-neutral-500" />
                )}
            </label>
          )}
          {!['chat', 'dashboard'].includes(currentView) && (
            <button
              type="button"
              onClick={() => newChat()}
              className="inline-flex h-8 items-center gap-1.5 rounded-full px-3 text-xs text-neutral-300 transition hover:bg-white/[0.06] hover:text-white md:hidden"
            >
              <Icon name="plus" size={14} />
              New chat
            </button>
          )}
        </header>

        {currentView === 'dashboard' && (
          <div className="scrollbar-thin min-h-0 flex-1 overflow-y-auto">
            <Dashboard
              firstName={profile?.firstName}
              liveRun={liveRun}
              onNavigate={navigate}
              onStartChat={newChat}
              onOpenConversation={openConversation}
            />
          </div>
        )}

        {currentView === 'settings' && (
          <div className="scrollbar-thin min-h-0 flex-1 overflow-y-auto">
            <Settings tab={sub} onNavigate={navigate} initials={initials} userName={userName} />
          </div>
        )}

        {currentView === 'images' && (
          <div className="scrollbar-thin min-h-0 flex-1 overflow-y-auto">
            <ImageGallery images={galleryImages} onSelect={setViewerImage} />
          </div>
        )}

        {currentView === 'chat' &&
          (opening ? (
            <div className="grid flex-1 place-items-center">
              <Spinner size={22} />
            </div>
          ) : thread.length === 0 ? (
            <div className="scrollbar-thin flex min-h-0 flex-1 flex-col items-center justify-center overflow-y-auto px-4 pb-16 pt-8">
              <div className="page-enter flex w-full max-w-3xl flex-col items-center">
                <AntralLogo size={44} animated />
                <h2 className="mt-5 text-center text-2xl font-medium tracking-tight sm:text-3xl">What should we work on?</h2>
                {selected && (
                  <p className="mt-2 text-center text-sm text-neutral-500">
                    Working in <span className="text-neutral-300">{targetName(selected)}</span>
                  </p>
                )}
                <div className="mt-8 w-full">
                  {consentStatus === 'loading' || consentStatus === 'idle' ? (
                    <div className="flex justify-center py-6"><Spinner size={20} /></div>
                  ) : (
                    composer('Ask anything, or describe a security task…')
                  )}
                </div>
                {!blocked && consentStatus === 'ready' && (
                  <div className="mt-4 flex flex-wrap justify-center gap-2">
                    {QUICK_STARTS.map((q) => (
                      <button
                        key={q.title}
                        type="button"
                        onClick={() => {
                          setTask(q.prompt)
                          inputRef.current?.focus()
                        }}
                        className="inline-flex items-center gap-2 rounded-full border border-white/10 px-3.5 py-2 text-xs text-neutral-300 transition hover:border-white/20 hover:bg-white/[0.04] hover:text-white"
                      >
                        <Icon name={q.icon} size={14} className="text-neutral-400" />
                        {q.title}
                      </button>
                    ))}
                  </div>
                )}
              </div>
            </div>
          ) : (
            <>
              <div ref={scrollRef} className="scrollbar-thin min-h-0 flex-1 overflow-y-auto px-4 py-8 sm:px-6">
                <ul className="mx-auto w-full max-w-3xl space-y-8">
                  {thread.map((item) => (
                    <Turn
                      key={item._id}
                      item={item}
                      live={liveRun && liveRun._id === item._id ? liveRun : null}
                      onAnswer={onAnswer}
                      answering={answering}
                      onImageOpen={setViewerImage}
                    />
                  ))}
                  <li ref={bottomRef} aria-hidden="true" />
                </ul>
              </div>
              <div className="mx-auto w-full max-w-3xl shrink-0 px-4 pb-5 pt-2 sm:px-6">
                {error && <ErrorBanner error={error} onAction={(to) => navigate(...to)} onDismiss={() => setError(null)} className="mb-2" />}
                {composer('Ask a follow-up…')}
              </div>
            </>
          ))}

        {currentView === 'chat' && thread.length === 0 && error && (
          <div className="mx-auto mb-5 w-[calc(100%-2rem)] max-w-3xl">
            <ErrorBanner error={error} onAction={(to) => navigate(...to)} onDismiss={() => setError(null)} />
          </div>
        )}
      </section>

      <ImageViewer image={viewerImage} onClose={() => setViewerImage(null)} />

      <TargetAuthorizationDialog
        open={authorizingComputer}
        onClose={() => setAuthorizingComputer(false)}
        prefill={{ type: 'computer' }}
        onAuthorized={onComputerAuthorized}
      />

      <ConfirmDialog
        open={Boolean(deletingProject)}
        busy={deleteBusy}
        title="Delete this project?"
        message={`“${deletingProject ? targetName(deletingProject.auth) : ''}” will be removed${
          deletingProject?.chats ? ` along with its ${deletingProject.chats === 1 ? 'chat' : `${deletingProject.chats} chats`}` : ''
        }, and the agents lose access to it. Your files are not touched, and the audit log of its runs is kept.`}
        confirmLabel="Delete project"
        onConfirm={confirmDeleteProject}
        onCancel={() => setDeletingProject(null)}
      />

      <ConfirmDialog
        open={Boolean(deleting)}
        busy={deleteBusy}
        title="Delete this conversation?"
        message={`“${deleting?.title || 'New conversation'}” will be removed from your chats and from the agent’s memory. The audit log of its runs is kept.`}
        confirmLabel="Delete"
        onConfirm={confirmDelete}
        onCancel={() => setDeleting(null)}
      />
    </main>
  )
}

export default AgentConsole
