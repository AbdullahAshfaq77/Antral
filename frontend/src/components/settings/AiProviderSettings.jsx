import { useCallback, useEffect, useState } from 'react'
import { Button, Card, Spinner } from '../ui/primitives.jsx'
import { useToast } from '../ui/toast.js'
import { SettingsSection } from './SettingsSection.jsx'
import ToolIntegrationSettings from './ToolIntegrationSettings.jsx'
import { getLlmSettings, setLlmSettings, testLlmConnection } from '../../../utils/consentApi.js'
import localProviderCatalog from '../../data/providerCatalog.json'

const field = 'w-full rounded-lg border border-white/10 bg-white/[0.04] px-3 py-2 text-sm text-white outline-none transition focus:border-indigo-400/60 placeholder:text-neutral-500'
const ROLES = [
  ['clarifier', 'cheap'], ['planner', 'best'], ['researcher', 'cheap'], ['coder', 'fast'],
  ['verifier', 'no model'], ['fixer', 'mid'], ['reviewer', 'best'], ['memory-keeper', 'cheap'],
]

function SetupStep({ number, title, description, aside }) {
  return <div className="flex flex-wrap items-start justify-between gap-3">
    <div className="flex min-w-0 items-start gap-3">
      <span aria-hidden="true" className="grid h-7 w-7 shrink-0 place-items-center rounded-full border border-indigo-400/30 bg-indigo-500/10 text-xs font-semibold text-indigo-200">{number}</span>
      <div className="min-w-0">
        <h3 className="text-sm font-semibold text-neutral-100">{title}</h3>
        {description && <p className="mt-1 max-w-3xl text-xs leading-5 text-neutral-400">{description}</p>}
      </div>
    </div>
    {aside && <div className="shrink-0">{aside}</div>}
  </div>
}

function AiProviderSettings() {
  const toast = useToast()
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [testing, setTesting] = useState(false)
  const [status, setStatus] = useState(null)
  const [profiles, setProfiles] = useState([])
  const [selectedId, setSelectedId] = useState('')
  const [apiKey, setApiKey] = useState('')
  const [modelInput, setModelInput] = useState('')
  const [modelOptions, setModelOptions] = useState([])
  const [testResult, setTestResult] = useState(null)
  const [roleModels, setRoleModels] = useState({})
  const catalog = status?.catalog?.length ? status.catalog : localProviderCatalog.presets
  const selected = profiles.find((p) => p.id === selectedId) || null
  const preset = catalog.find((p) => p.id === selected?.id)
  const roleModelOptions = profiles.filter((p) => {
    if (p.enabled === false) return false
    const required = catalog.find((item) => item.id === p.id)?.requiredFields || []
    return required.every((field) => field === 'apiKey' ? Boolean(p.hasKey || (p.id === selectedId && apiKey.trim())) : Boolean(String(p[field] || '').trim()))
  }).flatMap((p) => (p.models || []).filter((m) => m.enabled !== false).map((m) => ({ providerId: p.id, modelId: m.id, tier: m.tier || 'fast', label: `${p.name || p.id}: ${m.id}` })))

  const applySettings = useCallback((result) => {
    const savedProfiles = result.profiles || []
    const availableProviders = result.catalog?.length ? result.catalog : localProviderCatalog.presets
    setStatus({ ...result, catalog: availableProviders })
    const initialProvider = availableProviders[0]
    const initialProfile = !savedProfiles.length && initialProvider ? {
      id: initialProvider.id,
      name: initialProvider.name,
      kind: initialProvider.kind,
      baseUrl: initialProvider.baseUrl,
      enabled: true,
      priority: 0,
      accountId: '',
      models: (initialProvider.suggestedModels || []).map((model, priority) => ({ ...model, enabled: true, priority })),
    } : null
    setProfiles(initialProfile ? [initialProfile] : savedProfiles)
    setRoleModels(result.roleModels || {})
    setSelectedId((current) => current || savedProfiles[0]?.id || initialProfile?.id || '')
  }, [])
  const load = useCallback(async () => {
    try {
      applySettings(await getLlmSettings())
    } catch {
      toast({ tone: 'error', message: "Couldn't load the AI provider settings." })
    } finally { setLoading(false) }
  }, [applySettings, toast])
  useEffect(() => {
    let cancelled = false
    getLlmSettings().then((result) => {
      if (!cancelled) applySettings(result)
    }).catch(() => {
      if (!cancelled) toast({ tone: 'error', message: "Couldn't load the AI provider settings." })
    }).finally(() => {
      if (!cancelled) setLoading(false)
    })
    return () => { cancelled = true }
  }, [applySettings, toast])

  const updateSelected = (changes) => setProfiles((items) => items.map((p) => p.id === selectedId ? { ...p, ...changes } : p))
  const clearRolePins = (providerId, modelId = '') => setRoleModels((current) => Object.fromEntries(Object.entries(current).map(([role, pin]) => {
    const matchesProvider = typeof pin === 'string' && pin.startsWith(`${providerId}:`)
    const matchesModel = !modelId || pin === `${providerId}:${modelId}`
    return [role, matchesProvider && matchesModel ? 'auto' : pin]
  })))
  const addProvider = (id) => {
    const item = catalog.find((p) => p.id === id)
    if (!item) return
    const existing = profiles.find((p) => p.id === id)
    if (existing) { setSelectedId(id); setApiKey(''); setModelInput(existing.models?.[0]?.id || ''); setModelOptions([]); setTestResult(null); return }
    const model = item.suggestedModels?.[0]
    const profile = { id: item.id, name: item.name, kind: item.kind, baseUrl: item.baseUrl, enabled: true, priority: profiles.length, accountId: '', models: model ? [{ ...model, enabled: true, priority: 0 }] : [] }
    setProfiles((items) => [...items, profile])
    setSelectedId(id)
    setApiKey('')
    setModelOptions([])
    setTestResult(null)
    setModelInput(model?.id || '')
  }

  const save = async () => {
    setSaving(true)
    try {
      const next = profiles.map((p) => {
        if (p.id !== selectedId) return p
        const modelId = modelInput.trim()
        const models = modelId && !p.models?.some((model) => model.id === modelId)
          ? [...(p.models || []), { id: modelId, tier: 'fast', enabled: true, priority: p.models?.length || 0 }]
          : p.models
        return { ...p, ...(apiKey.trim() ? { apiKey: apiKey.trim() } : {}), models }
      })
      const result = await setLlmSettings({ profiles: next, roles: roleModels })
      setApiKey('')
      toast({ tone: 'success', message: result.message || 'Provider settings saved.' })
      await load()
    } catch (err) { toast({ tone: 'error', message: err.message || 'Could not save.' }) }
    finally { setSaving(false) }
  }

  const applyRecommendedRoles = () => {
    const rank = { cheap: 0, fast: 1, mid: 2, best: 3 }
    const next = {}
    for (const [role, tier] of ROLES) {
      if (role === 'verifier') continue
      if (!roleModelOptions.length) { next[role] = 'auto'; continue }
      const ordered = [...roleModelOptions].sort((a, b) => {
        if (tier === 'cheap') return (rank[a.tier] ?? 1) - (rank[b.tier] ?? 1)
        if (tier === 'best') return (rank[b.tier] ?? 1) - (rank[a.tier] ?? 1)
        return Math.abs((rank[a.tier] ?? 1) - rank[tier]) - Math.abs((rank[b.tier] ?? 1) - rank[tier])
      })
      next[role] = `${ordered[0].providerId}:${ordered[0].modelId}`
    }
    setRoleModels(next)
  }

  const saveRoleAssignments = async () => {
    setSaving(true)
    try {
      const profilesToSave = profiles.map((profile) => profile.id === selectedId && apiKey.trim() ? { ...profile, apiKey: apiKey.trim() } : profile)
      const result = await setLlmSettings({ profiles: profilesToSave, roles: roleModels })
      setApiKey('')
      toast({ tone: 'success', message: result.message || 'Recommended role settings saved.' })
      await load()
    } catch (err) { toast({ tone: 'error', message: err.message || 'Could not save role settings.' }) }
    finally { setSaving(false) }
  }

  const test = async () => {
    if (!selected) return
    const modelId = modelInput.trim() || selected.models?.find((model) => model.enabled !== false)?.id
    if (!modelId) {
      setTestResult({ status: 'invalid_model', message: 'Enter a model ID before testing this provider.' })
      return
    }
    setTesting(true)
    setTestResult(null)
    try {
      const result = await testLlmConnection({ baseUrl: selected.baseUrl || preset?.baseUrl, apiKey: apiKey.trim() || undefined, model: modelId, provider: selected.id, accountId: selected.accountId })
      setTestResult(result)
      setModelOptions(result.models || [])
      if (result.status === 'ok' && !selected.models?.some((model) => model.id === modelId)) {
        updateSelected({ models: [...(selected.models || []), { id: modelId, tier: 'fast', enabled: true, priority: selected.models?.length || 0 }] })
      }
    } catch (err) { setTestResult({ status: 'unreachable', message: err.message || 'Connection test failed.' }) }
    finally { setTesting(false) }
  }

  const addModel = () => {
    const id = modelInput.trim()
    if (!id || !selected) return
    if (selected.models?.some((m) => m.id === id)) { toast({ tone: 'error', message: 'That model is already in the provider.' }); return }
    updateSelected({ models: [...(selected.models || []), { id, tier: 'fast', enabled: true, priority: selected.models?.length || 0 }] })
    setModelInput('')
    setTestResult(null)
  }
  const moveProfile = (direction) => {
    const sorted = [...profiles].sort((a, b) => a.priority - b.priority)
    const index = sorted.findIndex((p) => p.id === selectedId)
    const next = index + direction
    if (index < 0 || next < 0 || next >= sorted.length) return
    ;[sorted[index].priority, sorted[next].priority] = [sorted[next].priority, sorted[index].priority]
    setProfiles(sorted)
  }

  if (loading) return <SettingsSection title="AI providers" description="Connect models using your own provider accounts."><div className="flex items-center gap-2 text-sm text-neutral-400"><Spinner /> Loading…</div></SettingsSection>

  return <SettingsSection title="AI providers" description="Connect your own AI accounts, then choose which models each agent role should use. API keys are stored with this Antral installation and are hidden after saving.">
    <div className="grid gap-2 rounded-2xl border border-white/[0.08] bg-white/[0.025] p-3 sm:grid-cols-4 sm:p-4" aria-label="Provider setup steps">
      {[
        ['1', 'Choose provider'], ['2', 'Add key · optional models'], ['3', 'Assign agent roles'], ['4', 'Optional tools'],
      ].map(([number, label], index) => <div key={number} className="flex items-center gap-2.5 text-xs text-neutral-300">
        <span aria-hidden="true" className={`grid h-6 w-6 shrink-0 place-items-center rounded-full text-[11px] font-semibold ${index === 3 ? 'bg-white/[0.07] text-neutral-400' : 'bg-indigo-500/15 text-indigo-200'}`}>{number}</span>
        <span>{label}</span>
        {index < 3 && <span aria-hidden="true" className="ml-auto hidden text-neutral-600 sm:inline">→</span>}
      </div>)}
    </div>

    <Card className="space-y-4 px-4 py-4 sm:px-5 sm:py-5">
      <SetupStep number="1" title="Choose a provider" description="Select each service you want to connect. You’ll enter its API key in the next step, where you can also open the provider’s key signup page. Local and custom URLs are supported too." />
      <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-3">{catalog.map((item) => {
        const savedProfile = profiles.find((profile) => profile.id === item.id)
        const selectedProvider = selectedId === item.id
        const description = savedProfile?.hasKey ? 'API key saved on this device' : item.local ? 'Connect to a local endpoint' : item.keyUrl ? 'Add your own API key' : 'Use a compatible API URL'
        return <button key={item.id} type="button" onClick={() => addProvider(item.id)} aria-pressed={selectedProvider} className={`group rounded-xl border p-3.5 text-left transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-400/70 ${selectedProvider ? 'border-indigo-400/70 bg-indigo-500/10 shadow-sm shadow-indigo-950/30' : 'border-white/10 bg-white/[0.025] hover:border-white/25 hover:bg-white/[0.05]'}`}>
          <span className="flex items-center justify-between gap-2"><span className="text-sm font-medium text-neutral-100">{item.name}</span>{savedProfile?.hasKey && <span className="rounded-full bg-emerald-500/10 px-2 py-0.5 text-[10px] font-medium text-emerald-300">Key saved</span>}</span>
          <span className="mt-1.5 block text-xs text-neutral-400">{description}</span>
          <span className={`mt-3 block text-xs font-medium ${selectedProvider ? 'text-indigo-200' : 'text-neutral-500 group-hover:text-indigo-300'}`}>{selectedProvider ? 'Selected · configure below ↓' : 'Select provider →'}</span>
        </button>
      })}</div>
    </Card>

    {profiles.length > 0 && <Card className="space-y-5 border-indigo-400/25 px-4 py-4 sm:px-5 sm:py-5">
      <SetupStep number="2" title="Add your API key and models" description="Credentials and model settings are saved on this device. Add a key for each provider you selected; a saved key stays in place when this field is left blank." />
      <div className="rounded-xl border border-white/[0.07] bg-black/10 p-3 sm:p-4">
        <div className="mb-2 flex flex-wrap items-center justify-between gap-2"><label htmlFor="provider-profile-select" className="text-xs font-medium uppercase tracking-wide text-neutral-400">Provider to configure</label><span className="text-[11px] text-neutral-500">Choose one provider at a time</span></div>
        <div className="flex flex-wrap items-center gap-2">
        <select id="provider-profile-select" className={`${field} min-w-52 flex-1`} value={selectedId} onChange={(e) => { const profile = profiles.find((p) => p.id === e.target.value); setSelectedId(e.target.value); setApiKey(''); setModelInput(profile?.models?.[0]?.id || ''); setModelOptions([]); setTestResult(null) }}>
          {profiles.map((p) => <option key={p.id} value={p.id} className="bg-neutral-900">{p.name || p.id}{p.hasKey ? ` · key …${p.keyLast4}` : ''}</option>)}
        </select>
        <Button type="button" onClick={() => moveProfile(-1)}>↑ Move up</Button><Button type="button" onClick={() => moveProfile(1)}>↓ Move down</Button>
        <Button type="button" onClick={() => { clearRolePins(selectedId); setProfiles((items) => items.filter((p) => p.id !== selectedId)); setSelectedId(''); setApiKey(''); setModelInput(''); setModelOptions([]); setTestResult(null) }}>Remove provider</Button>
        </div>
      </div>
      {selected && <>
        <label className="flex w-fit items-center gap-2 rounded-lg border border-white/[0.07] px-3 py-2 text-sm text-neutral-200"><input type="checkbox" checked={selected.enabled !== false} onChange={(e) => { updateSelected({ enabled: e.target.checked }); if (!e.target.checked) clearRolePins(selectedId) }} /> Enable this provider</label>
        {(() => {
          const health = status?.health?.[selected.id]
          const label = health?.status === 'invalid_key' ? 'Key invalid' : health?.status === 'cooling' ? `Cooling down until ${new Date(health.until).toLocaleTimeString()}` : health?.status === 'down' ? 'Down' : health?.status === 'healthy' ? 'Healthy' : 'Not tested yet'
          const color = health?.status === 'healthy' ? 'text-emerald-300' : health ? 'text-amber-300' : 'text-neutral-500'
          return <p className={`flex items-center gap-2 text-xs ${color}`}><span aria-hidden="true" className={`h-1.5 w-1.5 rounded-full ${health?.status === 'healthy' ? 'bg-emerald-300' : health ? 'bg-amber-300' : 'bg-neutral-500'}`} />Connection status: {label}</p>
        })()}
        {selected.id === 'custom' && <div><label className="mb-1 block text-sm">Provider name</label><input className={field} value={selected.name || ''} onChange={(e) => updateSelected({ name: e.target.value })} /></div>}
        <div className="space-y-4 rounded-xl border border-white/[0.07] bg-black/10 p-3 sm:p-4">
          <div className="space-y-2">
            <div><label htmlFor="provider-api-key" className="block text-sm font-medium text-neutral-100">Your API key</label><p className="mt-1 text-xs leading-5 text-neutral-500">Paste the key from your provider account here. It is used for this Antral installation only.{selected.hasKey && <span className="text-emerald-300"> A key is saved; leave blank to keep it.</span>}</p></div>
            {preset?.keyUrl?.startsWith('https://') && <p className="text-xs text-neutral-400"><a href={preset.keyUrl} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-indigo-300 hover:underline">{preset.local ? 'Provider setup instructions' : `Get an API key from ${preset.name}`} ↗</a>{preset.approximateLimits?.rpd > 0 && <span className="ml-1">· Check the provider’s current free quota and billing terms.</span>}</p>}
            <input id="provider-api-key" className={`${field} h-11`} type="password" value={apiKey} onChange={(e) => { setApiKey(e.target.value); setTestResult(null) }} placeholder={preset?.requiredFields?.includes('apiKey') ? 'Paste your personal API key here' : 'Optional for local/custom endpoints'} autoComplete="off" />
          </div>
          <div className="grid gap-4 sm:grid-cols-2">
            <div><label className="mb-1.5 block text-sm font-medium text-neutral-200">Base URL</label><input className={field} value={selected.baseUrl || ''} onChange={(e) => { updateSelected({ baseUrl: e.target.value }); setTestResult(null) }} placeholder="https://api.example.com/v1" /><p className="mt-1 text-[11px] text-neutral-500">Endpoint for this provider. Keep the default unless using a custom URL.</p></div>
            {preset?.requiredFields?.includes('accountId') && <div><label className="mb-1.5 block text-sm font-medium text-neutral-200">Cloudflare Account ID</label><input className={field} value={selected.accountId || ''} onChange={(e) => { updateSelected({ accountId: e.target.value }); setTestResult(null) }} /><p className="mt-1 text-[11px] text-neutral-500">Required to route requests to your Cloudflare account.</p></div>}
          </div>
        </div>
        <div className="space-y-3 rounded-xl border border-white/[0.07] p-3 sm:p-4">
          <div><h4 className="text-sm font-medium text-neutral-100">Available models <span className="font-normal text-neutral-500">(optional)</span></h4><p className="mt-1 text-xs leading-5 text-neutral-500">A suggested model may already be listed. Keep it, add other model IDs, or remove it. Enabled models appear in agent role choices.</p></div>
          <div className="hidden grid-cols-[minmax(0,1fr)_110px_70px_auto] gap-2 px-1 text-[10px] font-medium uppercase tracking-wide text-neutral-500 sm:grid"><span>Model ID</span><span>Tier</span><span>Enabled</span><span className="sr-only">Actions</span></div>
          {(selected.models || []).map((model, index) => <div key={`${model.id}-${index}`} className="grid grid-cols-1 items-center gap-2 rounded-lg bg-white/[0.025] p-2 sm:grid-cols-[minmax(0,1fr)_110px_70px_auto] sm:bg-transparent sm:p-0">
            <span className="truncate text-sm" title={model.id}>{model.id}</span>
            <select aria-label={`Tier for ${model.id}`} className={field} value={model.tier || 'fast'} onChange={(e) => updateSelected({ models: selected.models.map((m, i) => i === index ? { ...m, tier: e.target.value } : m) })}>{['cheap','fast','mid','best'].map((tier) => <option key={tier} className="bg-neutral-900" value={tier}>{tier}</option>)}</select>
            <label className="flex items-center gap-2 text-xs text-neutral-400"><input aria-label={`Enable ${model.id}`} type="checkbox" checked={model.enabled !== false} onChange={(e) => updateSelected({ models: selected.models.map((m, i) => i === index ? { ...m, enabled: e.target.checked } : m) })} /><span className="sm:hidden">Enabled</span></label>
            <Button type="button" onClick={() => { const remaining = selected.models.filter((_, i) => i !== index); clearRolePins(selected.id, model.id); updateSelected({ models: remaining }); if (modelInput === model.id) setModelInput(remaining[0]?.id || ''); setTestResult(null) }}>Remove</Button>
          </div>)}
          <div className="flex flex-col gap-2 sm:flex-row"><input aria-label="Optional model ID to add" className={field} value={modelInput} onChange={(e) => { setModelInput(e.target.value); setTestResult(null) }} list="provider-model-options" placeholder="Model ID to add (optional)" /><datalist id="provider-model-options">{[...(preset?.suggestedModels || []).map((m) => m.id), ...modelOptions].map((id) => <option key={id} value={id} />)}</datalist><Button type="button" onClick={addModel}>Add model</Button></div>
          <p className="text-[11px] text-neutral-500">Free tier limits can change. You can type a model ID if it is not listed.</p>
        </div>
      <div className="flex flex-col gap-3 border-t border-white/[0.07] pt-4 sm:flex-row sm:items-center"><Button type="button" onClick={test} disabled={testing}>{testing ? 'Testing…' : 'Test connection'}</Button>{testResult && <span role="status" className={`text-sm ${testResult.status === 'ok' && testResult.modelAvailable !== false ? 'text-emerald-300' : 'text-amber-300'}`}>{testResult.message}</span>}</div>
      </>}
      <div className="flex flex-wrap items-center justify-between gap-3 border-t border-white/[0.07] pt-4"><p className="text-xs text-neutral-500">Save your key and provider model list on this device.</p><Button type="button" variant="primary" disabled={saving} onClick={save}>{saving ? 'Saving…' : 'Save provider settings'}</Button></div>
    </Card>}

    <Card className="space-y-4 px-4 py-4 sm:px-5 sm:py-5"><SetupStep number="3" title="Assign models to agent roles" description="Each role can use Auto or a specific enabled model from your connected providers. Suggested tiers give routine work lower-cost models and reserve stronger models for planning and review." aside={<Button type="button" onClick={applyRecommendedRoles}>Apply recommended settings</Button>} />
      <div className="hidden grid-cols-[minmax(0,1fr)_90px_minmax(130px,1fr)] gap-3 border-b border-white/[0.07] px-2 pb-2 text-[10px] font-medium uppercase tracking-wide text-neutral-500 sm:grid"><span>Agent role</span><span>Suggested tier</span><span>Model selection</span></div>
      <div className="space-y-2">{ROLES.map(([role, tier]) => <div key={role} className="grid grid-cols-1 items-center gap-2 rounded-xl border border-white/[0.06] bg-white/[0.02] p-3 sm:grid-cols-[minmax(0,1fr)_90px_minmax(130px,1fr)] sm:gap-3 sm:border-0 sm:bg-transparent sm:px-2 sm:py-1.5"><span className="text-sm font-medium text-neutral-200">{role}</span><span className="text-xs text-neutral-500 sm:text-sm">Suggested: {tier}</span>{role !== 'verifier' ? <select aria-label={`Model for ${role}`} className={field} value={roleModels[role] || 'auto'} onChange={(e) => setRoleModels((prev) => ({ ...prev, [role]: e.target.value }))}><option value="auto" className="bg-neutral-900">Auto (recommended)</option>{roleModelOptions.map((option) => <option key={`${option.providerId}:${option.modelId}`} value={`${option.providerId}:${option.modelId}`} className="bg-neutral-900">{option.label}</option>)}</select> : <span className="text-sm text-neutral-500">Deterministic · no model used</span>}</div>)}</div>
      <div className="flex flex-wrap items-center justify-between gap-3 border-t border-white/[0.07] pt-4"><p className="text-xs text-neutral-500">Role choices use enabled models from saved providers.</p><Button type="button" variant="primary" disabled={saving} onClick={saveRoleAssignments}>{saving ? 'Saving…' : 'Save role assignments'}</Button></div>
    </Card>
    <ToolIntegrationSettings />
  </SettingsSection>
}

export default AiProviderSettings
