import { useEffect, useState } from 'react'
import { Button, Card, Spinner } from '../ui/primitives.jsx'
import { useToast } from '../ui/toast.js'
import { getToolApiSettings, setToolApiSettings } from '../../../utils/consentApi.js'

const field = 'w-full rounded-lg border border-white/10 bg-white/[0.04] px-3 py-2 text-sm text-white outline-none transition focus:border-indigo-400/60 placeholder:text-neutral-500'

function ToolIntegrationSettings() {
  const toast = useToast()
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [settings, setSettings] = useState({ github: {}, tavily: {}, crawl4ai: {} })
  const [values, setValues] = useState({ githubToken: '', tavilyApiKey: '', crawl4aiUrl: '', crawl4aiApiToken: '' })

  useEffect(() => {
    getToolApiSettings().then(setSettings).catch(() => toast({ tone: 'error', message: "Couldn't load tool integration settings." })).finally(() => setLoading(false))
  }, [toast])

  const save = async () => {
    setSaving(true)
    try {
      const result = await setToolApiSettings(values)
      setSettings(result.integrations)
      setValues({ githubToken: '', tavilyApiKey: '', crawl4aiUrl: '', crawl4aiApiToken: '' })
      toast({ tone: 'success', message: result.message || 'Tool integrations saved.' })
    } catch (error) {
      toast({ tone: 'error', message: error.message || 'Could not save tool integrations.' })
    } finally { setSaving(false) }
  }

  if (loading) return <Card className="flex items-center gap-2 px-5 py-4 text-sm text-neutral-400"><Spinner /> Loading optional tool integrations…</Card>
  const setValue = (key) => (event) => setValues((current) => ({ ...current, [key]: event.target.value }))

  return <Card className="space-y-4 px-4 py-4 sm:px-5 sm:py-5">
    <div className="flex flex-wrap items-start gap-3">
      <span aria-hidden="true" className="grid h-7 w-7 shrink-0 place-items-center rounded-full border border-white/15 bg-white/[0.05] text-xs font-semibold text-neutral-300">4</span>
      <div className="min-w-0"><h3 className="text-sm font-semibold text-neutral-100">Optional: connect agent tools</h3><p className="mt-1 max-w-3xl text-xs leading-5 text-neutral-400">These credentials power GitHub and web research tools. They are separate from AI provider keys and are not assigned to agent roles. Keys are encrypted on this installation; leave a saved key blank to keep it.</p></div>
    </div>
    <div className="grid gap-3 lg:grid-cols-2">
      <div className="space-y-3 rounded-xl border border-white/[0.07] bg-black/10 p-3 sm:p-4">
        <div><label className="block text-sm font-medium text-neutral-100">GitHub token {settings.github?.hasKey && <span className="font-normal text-emerald-300">· saved</span>}</label><p className="mt-1 text-xs leading-5 text-neutral-500">Improves GitHub API limits and enables code search or private repository access when authorized.</p></div>
        <p className="text-xs"><a href="https://github.com/settings/personal-access-tokens" target="_blank" rel="noreferrer" className="text-indigo-300 hover:underline">Create a GitHub token ↗</a></p>
        <input aria-label="GitHub token" className={`${field} h-10`} type="password" value={values.githubToken} onChange={setValue('githubToken')} placeholder={settings.github?.hasKey ? 'Saved token (leave blank to keep)' : 'Paste your GitHub token'} autoComplete="off" />
      </div>
      <div className="space-y-3 rounded-xl border border-white/[0.07] bg-black/10 p-3 sm:p-4">
        <div><label className="block text-sm font-medium text-neutral-100">Tavily API key {settings.tavily?.hasKey && <span className="font-normal text-emerald-300">· saved</span>}</label><p className="mt-1 text-xs leading-5 text-neutral-500">Used by web research for web search and page extraction.</p></div>
        <p className="text-xs"><a href="https://app.tavily.com/home" target="_blank" rel="noreferrer" className="text-indigo-300 hover:underline">Create a Tavily key ↗</a></p>
        <input aria-label="Tavily API key" className={`${field} h-10`} type="password" value={values.tavilyApiKey} onChange={setValue('tavilyApiKey')} placeholder={settings.tavily?.hasKey ? 'Saved key (leave blank to keep)' : 'Paste your Tavily API key'} autoComplete="off" />
      </div>
      <div className="space-y-3 rounded-xl border border-white/[0.07] bg-black/10 p-3 sm:p-4 lg:col-span-2">
        <div><label className="block text-sm font-medium text-neutral-100">Crawl4AI endpoint {settings.crawl4ai?.hasKey && <span className="font-normal text-emerald-300">· token saved</span>}</label><p className="mt-1 text-xs leading-5 text-neutral-500">Optional self-hosted service for reading pages. Enter the endpoint and, if required, its API token.</p></div>
        <div className="grid gap-2 sm:grid-cols-2"><input aria-label="Crawl4AI endpoint" className={field} value={values.crawl4aiUrl || settings.crawl4ai?.baseUrl || ''} onChange={setValue('crawl4aiUrl')} placeholder="http://localhost:11235" /><input aria-label="Crawl4AI API token" className={field} type="password" value={values.crawl4aiApiToken} onChange={setValue('crawl4aiApiToken')} placeholder={settings.crawl4ai?.hasKey ? 'Saved token (leave blank to keep)' : 'Optional Crawl4AI API token'} autoComplete="off" /></div>
      </div>
    </div>
    <div className="flex flex-wrap items-center justify-between gap-3 border-t border-white/[0.07] pt-4"><p className="text-xs text-neutral-500">Tool keys are saved separately from AI provider credentials.</p><Button type="button" variant="primary" disabled={saving} onClick={save}>{saving ? 'Saving…' : 'Save tool integrations'}</Button></div>
  </Card>
}

export default ToolIntegrationSettings
