import { useSelector } from 'react-redux'
import Icon from '../components/ui/Icon.jsx'
import PermissionsSettings from '../components/settings/PermissionsSettings.jsx'
import TargetsSettings from '../components/settings/TargetsSettings.jsx'
import PoliciesSettings from '../components/settings/PoliciesSettings.jsx'
import AccountSettings from '../components/settings/AccountSettings.jsx'
import AiProviderSettings from '../components/settings/AiProviderSettings.jsx'

const TABS = [
  { id: 'ai', label: 'AI provider', icon: 'bolt' },
  { id: 'permissions', label: 'Permissions', icon: 'key' },
  { id: 'targets', label: 'Targets', icon: 'target' },
  { id: 'privacy', label: 'Privacy & policies', icon: 'shield' },
  { id: 'account', label: 'Account', icon: 'user' },
]

function Settings({ tab, onNavigate, initials, userName }) {
  const account = useSelector((state) => state.consent.account)
  const authorizations = useSelector((state) => state.consent.authorizations)
  const current = TABS.find((t) => t.id === tab) ? tab : account && !account.accepted ? 'privacy' : 'permissions'
  const expired = authorizations.filter((a) => a.status !== 'active').length

  const badge = (id) => {
    if (id === 'privacy' && account && !account.accepted) return 'bg-amber-400'
    if (id === 'targets' && expired) return 'bg-rose-400'
    return null
  }

  return (
    <div className="mx-auto flex w-full max-w-5xl flex-col gap-6 px-5 py-8 sm:px-8 md:flex-row md:gap-10">
      <nav aria-label="Settings sections" className="md:w-52 md:shrink-0">
        <p className="mb-3 hidden px-3 text-xs font-medium uppercase tracking-[0.16em] text-neutral-500 md:block">Settings</p>
        <ul className="scrollbar-hidden -mx-1 flex gap-1 overflow-x-auto px-1 md:mx-0 md:flex-col md:px-0">
          {TABS.map((t) => {
            const selected = t.id === current
            const dot = badge(t.id)
            return (
              <li key={t.id} className="shrink-0">
                <button
                  type="button"
                  onClick={() => onNavigate('settings', t.id)}
                  aria-current={selected ? 'page' : undefined}
                  className={`flex h-9 w-full items-center gap-2.5 rounded-lg px-3 text-left text-sm transition ${
                    selected ? 'bg-white/[0.08] text-white' : 'text-neutral-400 hover:bg-white/[0.04] hover:text-white'
                  }`}
                >
                  <Icon name={t.icon} size={16} className={selected ? 'text-indigo-300' : ''} />
                  <span className="whitespace-nowrap">{t.label}</span>
                  {dot && <span aria-label="Needs attention" className={`ml-auto h-1.5 w-1.5 rounded-full ${dot}`} />}
                </button>
              </li>
            )
          })}
        </ul>
      </nav>

      <div className="min-w-0 flex-1 pb-10">
        {current === 'ai' && <AiProviderSettings />}
        {current === 'permissions' && <PermissionsSettings onNavigate={onNavigate} />}
        {current === 'targets' && <TargetsSettings onNavigate={onNavigate} />}
        {current === 'privacy' && <PoliciesSettings />}
        {current === 'account' && <AccountSettings initials={initials} userName={userName} />}
      </div>
    </div>
  )
}

export default Settings
