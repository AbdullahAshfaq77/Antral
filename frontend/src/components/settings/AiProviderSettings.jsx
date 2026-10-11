import { useEffect, useState } from 'react'
import Icon from '../ui/Icon.jsx'
import { Button, Card, Spinner } from '../ui/primitives.jsx'
import { useToast } from '../ui/toast.js'
import { SettingsSection } from './SettingsSection.jsx'
import { getLlmSettings, setLlmSettings } from '../../../utils/consentApi.js'

// Friendly labels + where to get a key, merged with the provider list the
// backend reports. Groq and Gemini have free tiers.
const PROVIDER_INFO = {
  groq: { label: 'Groq', free: true, keyUrl: 'https://console.groq.com/keys' },
  gemini: { label: 'Google Gemini', free: true, keyUrl: 'https://aistudio.google.com/apikey' },
  openrouter: { label: 'OpenRouter', free: false, keyUrl: 'https://openrouter.ai/keys' },
  cloudflare: { label: 'Cloudflare Workers AI', free: true, keyUrl: 'https://dash.cloudflare.com/profile/api-tokens' },
}

const field =
  'w-full rounded-lg border border-white/10 bg-white/[0.04] px-3 py-2 text-sm text-white outline-none transition focus:border-indigo-400/60 placeholder:text-neutral-500'

function AiProviderSettings() {
  const toast = useToast()
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [status, setStatus] = useState(null)
  const [provider, setProvider] = useState('groq')
  const [apiKey, setApiKey] = useState('')
  const [accountId, setAccountId] = useState('')
  const [model, setModel] = useState('')

  const load = async () => {
    try {
      const s = await getLlmSettings()
      setStatus(s)
      if (s.provider) setProvider(s.provider)
      if (s.accountId) setAccountId(s.accountId)
      if (s.model) setModel(s.model)
    } catch {
      toast({ tone: 'error', message: "Couldn't load the AI provider settings." })
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    load()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const providers = status?.providers || []
  const meta = providers.find((p) => p.id === provider)
  const info = PROVIDER_INFO[provider] || { label: provider }
  const needsAccountId = meta?.needsAccountId
  const hasKey = status?.provider === provider && status?.hasKey

  const save = async (e) => {
    e.preventDefault()
    if (!apiKey && !hasKey) {
      toast({ tone: 'error', message: 'Enter your API key.' })
      return
    }
    setSaving(true)
    try {
      const res = await setLlmSettings({
        provider,
        apiKey: apiKey || undefined, // blank = keep the existing key
        accountId: needsAccountId ? accountId : '',
        model,
      })
      toast({ tone: 'success', message: res.message || 'Saved.' })
      setApiKey('')
      await load()
    } catch (err) {
      toast({ tone: 'error', message: err.message || 'Could not save.' })
    } finally {
      setSaving(false)
    }
  }

  if (loading) {
    return (
      <SettingsSection title="AI provider" description="Connect your own AI key so the agents can run.">
        <div className="flex items-center gap-2 text-sm text-neutral-400">
          <Spinner /> Loading…
        </div>
      </SettingsSection>
    )
  }

  return (
    <SettingsSection
      title="AI provider"
      description="Antral uses your own AI account. Your key is stored only on this device and is used to run the agents."
    >
      {status?.configured ? (
        <div className="flex items-center gap-2.5 rounded-xl border border-emerald-400/25 bg-emerald-500/[0.07] px-4 py-3 text-sm text-emerald-100/90">
          <Icon name="check" size={16} className="text-emerald-300" />
          Connected to <strong className="font-medium">{PROVIDER_INFO[status.provider]?.label || status.provider}</strong>
          {status.model ? ` · ${status.model}` : ''}.
        </div>
      ) : (
        <div className="flex items-center gap-2.5 rounded-xl border border-amber-400/25 bg-amber-500/[0.07] px-4 py-3 text-sm text-amber-100/90">
          <Icon name="alert" size={16} className="text-amber-300" />
          No AI key yet. Add one below to start using the agents.
        </div>
      )}

      <Card className="px-5 py-5">
        <form onSubmit={save} className="space-y-4">
          <div>
            <label className="mb-1.5 block text-sm font-medium text-neutral-200">Provider</label>
            <select className={field} value={provider} onChange={(e) => setProvider(e.target.value)}>
              {providers.map((p) => (
                <option key={p.id} value={p.id} className="bg-neutral-900">
                  {(PROVIDER_INFO[p.id]?.label || p.id) + (PROVIDER_INFO[p.id]?.free ? ' (free tier)' : '')}
                </option>
              ))}
            </select>
            {info.keyUrl && (
              <p className="mt-1.5 text-xs text-neutral-500">
                Get a key:{' '}
                <a href={info.keyUrl} target="_blank" rel="noreferrer" className="text-indigo-300 hover:underline">
                  {info.keyUrl}
                </a>
              </p>
            )}
          </div>

          <div>
            <label className="mb-1.5 block text-sm font-medium text-neutral-200">API key</label>
            <input
              type="password"
              className={field}
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
              placeholder={hasKey ? '•••••••• (saved — leave blank to keep)' : 'Paste your API key'}
              autoComplete="off"
            />
          </div>

          {needsAccountId && (
            <div>
              <label className="mb-1.5 block text-sm font-medium text-neutral-200">Account ID</label>
              <input
                type="text"
                className={field}
                value={accountId}
                onChange={(e) => setAccountId(e.target.value)}
                placeholder="Cloudflare account ID"
                autoComplete="off"
              />
            </div>
          )}

          <div>
            <label className="mb-1.5 block text-sm font-medium text-neutral-200">
              Model <span className="font-normal text-neutral-500">(optional)</span>
            </label>
            <input
              type="text"
              className={field}
              value={model}
              onChange={(e) => setModel(e.target.value)}
              placeholder={meta?.defaultModel ? `Default: ${meta.defaultModel}` : 'Provider default'}
              autoComplete="off"
            />
          </div>

          <div className="flex items-center gap-3 pt-1">
            <Button type="submit" variant="primary" disabled={saving}>
              {saving ? 'Saving…' : 'Save'}
            </Button>
            <p className="text-xs text-neutral-500">Applies from your next message.</p>
          </div>
        </form>
      </Card>
    </SettingsSection>
  )
}

export default AiProviderSettings
