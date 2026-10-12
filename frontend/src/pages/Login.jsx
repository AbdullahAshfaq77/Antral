import { useState } from 'react'
import {
  GithubAuthProvider,
  GoogleAuthProvider,
  createUserWithEmailAndPassword,
  signInWithEmailAndPassword,
  signInWithPopup,
} from 'firebase/auth'
import { auth, googleProvider, githubProvider } from '../../utils/firebase.js'
import AntralLogo from '../components/AntralLogo.jsx'
import NeuralBackground from '../components/NeuralBackground.jsx'

// Same provider, but asks the user to pick which account to sign in with.
function withAccountPicker(provider, Provider) {
  const picker = new Provider()
  provider.getScopes().forEach((scope) => picker.addScope(scope))
  picker.setCustomParameters({ prompt: 'select_account' })
  return picker
}

const PROVIDERS = {
  google: { label: 'Google', provider: googleProvider, picker: withAccountPicker(googleProvider, GoogleAuthProvider) },
  github: { label: 'GitHub', provider: githubProvider, picker: withAccountPicker(githubProvider, GithubAuthProvider) },
}

const AUTH_ERRORS = {
  'auth/popup-closed-by-user': null,
  'auth/cancelled-popup-request': null,
  'auth/popup-blocked': 'Your browser blocked the sign-in popup. Allow popups and try again.',
  'auth/account-exists-with-different-credential':
    'An account with this email already exists. Sign in with the provider you used before.',
  'auth/unauthorized-domain': 'This domain is not authorized for sign-in in Firebase.',
  'auth/operation-not-allowed': 'This sign-in provider is not enabled in Firebase.',
  'auth/user-disabled': 'This account has been disabled.',
  'auth/invalid-credential': 'Incorrect email or password.',
  'auth/wrong-password': 'Incorrect email or password.',
  'auth/user-not-found': 'No account found with that email. Create one below.',
  'auth/invalid-email': 'Enter a valid email address.',
  'auth/email-already-in-use': 'An account with this email already exists. Log in instead.',
  'auth/weak-password': 'Password must be at least 6 characters.',
  'auth/too-many-requests': 'Too many attempts. Please wait a moment and try again.',
}

// Writes the pointer position (in %) to CSS variables, without re-rendering.
function trackPointer(e) {
  const el = e.currentTarget
  const rect = el.getBoundingClientRect()
  el.style.setProperty('--x', `${((e.clientX - rect.left) / rect.width) * 100}%`)
  el.style.setProperty('--y', `${((e.clientY - rect.top) / rect.height) * 100}%`)
}

function GoogleIcon() {
  return (
    <svg viewBox="0 0 24 24" className="h-4 w-4" aria-hidden="true">
      <path
        fill="currentColor"
        d="M21.35 11.1H12v2.98h5.35c-.23 1.4-1.64 4.1-5.35 4.1-3.22 0-5.85-2.67-5.85-5.96S8.78 6.26 12 6.26c1.83 0 3.06.78 3.76 1.45l2.56-2.47C16.68 3.7 14.55 2.75 12 2.75 6.89 2.75 2.75 6.89 2.75 12S6.89 21.25 12 21.25c5.34 0 8.88-3.75 8.88-9.04 0-.61-.07-1.07-.15-1.53z"
      />
    </svg>
  )
}

function GitHubIcon() {
  return (
    <svg viewBox="0 0 24 24" className="h-4 w-4" aria-hidden="true">
      <path
        fill="currentColor"
        d="M12 .5C5.65.5.5 5.65.5 12c0 5.08 3.29 9.39 7.86 10.91.58.1.79-.25.79-.56v-1.96c-3.2.7-3.87-1.54-3.87-1.54-.52-1.33-1.28-1.68-1.28-1.68-1.04-.71.08-.7.08-.7 1.16.08 1.77 1.19 1.77 1.19 1.03 1.76 2.7 1.25 3.36.96.1-.75.4-1.25.73-1.54-2.55-.29-5.24-1.28-5.24-5.68 0-1.25.45-2.28 1.19-3.08-.12-.29-.52-1.46.11-3.05 0 0 .97-.31 3.17 1.18a11 11 0 0 1 5.77 0c2.2-1.49 3.17-1.18 3.17-1.18.63 1.59.23 2.76.11 3.05.74.8 1.19 1.83 1.19 3.08 0 4.41-2.69 5.38-5.25 5.67.41.36.78 1.06.78 2.14v3.17c0 .31.21.67.8.56A11.51 11.51 0 0 0 23.5 12C23.5 5.65 18.35.5 12 .5z"
      />
    </svg>
  )
}

function MailIcon() {
  return (
    <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true">
      <rect x="3" y="5" width="18" height="14" rx="2.5" />
      <path d="m4 7 8 6 8-6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

function LockIcon() {
  return (
    <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true">
      <rect x="4.5" y="10.5" width="15" height="10" rx="2.5" />
      <path d="M8 10.5V7a4 4 0 0 1 8 0v3.5" strokeLinecap="round" />
    </svg>
  )
}

function Spinner({ className = 'h-4 w-4 border-white/25 border-t-white' }) {
  return <span className={`animate-spin rounded-full border-2 ${className}`} aria-hidden="true" />
}

function GlowButton({ children, loading = false, ...props }) {
  return (
    <button
      {...props}
      onPointerMove={trackPointer}
      className="glow-btn relative h-11 w-full rounded-full text-xs font-semibold tracking-[0.14em] text-neutral-900 disabled:cursor-not-allowed disabled:opacity-70"
    >
      <span className="glow-btn-halo" aria-hidden="true" />
      <span className="glow-btn-surface" aria-hidden="true" />
      <span className="relative z-10 inline-flex items-center justify-center gap-2">
        {loading && <Spinner className="h-3.5 w-3.5 border-neutral-900/25 border-t-neutral-900" />}
        {children}
      </span>
    </button>
  )
}

function ProviderButton({ icon, label, loading, ...props }) {
  return (
    <button
      type="button"
      {...props}
      className="provider-btn group flex h-11 items-center justify-center gap-2 rounded-lg border border-white/10 bg-white/[0.03] text-xs font-medium text-neutral-200 transition duration-300 hover:-translate-y-0.5 hover:border-white/20 hover:bg-white/[0.07] hover:text-white active:translate-y-0 disabled:pointer-events-none disabled:opacity-60"
    >
      {loading ? <Spinner /> : icon}
      {label}
    </button>
  )
}

function Login() {
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [mode, setMode] = useState('signin') // 'signin' | 'signup'
  const [pending, setPending] = useState(null)
  const [error, setError] = useState(null)

  const showError = (message) => setError({ message, id: Date.now() })

  const mapAuthError = (err) =>
    err.code?.startsWith('auth/')
      ? AUTH_ERRORS[err.code] || 'Sign-in failed. Please try again.'
      : err.message || 'Sign-in failed. Please try again.'

  const handleEmailSubmit = async (e) => {
    e.preventDefault()
    setError(null)
    setPending('email')
    try {
      const address = email.trim().toLowerCase()
      if (mode === 'signup') {
        await createUserWithEmailAndPassword(auth, address, password)
      } else {
        await signInWithEmailAndPassword(auth, address, password)
      }
      // onAuthStateChanged (App.jsx) takes over from here.
    } catch (err) {
      const message = mapAuthError(err)
      if (message) showError(message)
      setPending(null)
    }
  }

  const toggleMode = () => {
    setMode((m) => (m === 'signin' ? 'signup' : 'signin'))
    setError(null)
  }

  const handleProviderSignIn = async (name, { pickAccount = false } = {}) => {
    setError(null)
    setPending(name)
    try {
      const { provider, picker } = PROVIDERS[name]
      await signInWithPopup(auth, pickAccount ? picker : provider)
    } catch (err) {
      const message = err.code in AUTH_ERRORS ? AUTH_ERRORS[err.code] : 'Sign-in failed. Please try again.'
      if (message) {
        const emailTaken = err.code === 'auth/account-exists-with-different-credential'
        setError({ message, id: Date.now(), retryWith: emailTaken ? name : null })
      }
    } finally {
      setPending(null)
    }
  }

  return (
    <div className="relative flex min-h-screen items-center justify-center overflow-hidden bg-[#05050a] px-4 py-12 text-white">
      {/* Background layers */}
      <div className="pointer-events-none absolute inset-0" aria-hidden="true">
        <div className="aurora aurora-1" />
        <div className="aurora aurora-2" />
        <div className="aurora aurora-3" />
        <div className="bg-grid absolute inset-0" />
        <NeuralBackground className="absolute inset-0" />
        <div className="absolute inset-0 bg-[radial-gradient(ellipse_at_center,transparent_30%,#05050a_85%)]" />
      </div>

      <div className="card-enter relative w-full max-w-[420px]">
        <div className="card-backglow" aria-hidden="true" />

        <div
          onPointerMove={trackPointer}
          className="login-card relative overflow-hidden rounded-[22px] border border-white/[0.08] px-8 pb-9 pt-10 shadow-2xl shadow-black/70 sm:px-10"
        >
          <span className="card-border" aria-hidden="true" />
          <span className="card-spotlight" aria-hidden="true" />

          <div className="relative z-10">
            <div className="reveal mb-7 flex items-center gap-3" style={{ '--i': 0 }}>
              <div className="logo-tile relative grid h-12 w-12 place-items-center rounded-xl border border-white/10 bg-white/[0.04]">
                <AntralLogo size={30} animated />
              </div>
              <span className="text-sm font-semibold tracking-[0.2em] text-neutral-300">ANTRAL</span>
            </div>

            <h1 className="reveal text-[30px] font-semibold leading-tight tracking-tight" style={{ '--i': 1 }}>
              {mode === 'signup' ? (
                <>Create your <span className="text-gradient">Antral</span> account</>
              ) : (
                <>Sign in to <span className="text-gradient">Antral</span></>
              )}
            </h1>
            <p className="reveal mb-8 mt-2 text-sm text-neutral-400" style={{ '--i': 2 }}>
              {mode === 'signup'
                ? 'Set an email and password to get started.'
                : 'Welcome back. Secure every AI model you ship.'}
            </p>

            <form onSubmit={handleEmailSubmit} className="space-y-5">
              <div className="reveal" style={{ '--i': 3 }}>
                <label htmlFor="email" className="mb-1.5 block text-xs font-medium text-neutral-400">
                  Email
                </label>
                <div className="input-wrap relative">
                  <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-neutral-500 transition-colors">
                    <MailIcon />
                  </span>
                  <input
                    id="email"
                    type="email"
                    required
                    autoComplete="email"
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    disabled={pending !== null}
                    placeholder="name@work-email.com"
                    className="h-11 w-full rounded-lg border border-white/10 bg-black/40 pl-10 pr-3 text-sm text-white outline-none transition duration-300 placeholder:text-neutral-600 hover:border-white/20 focus:border-indigo-400/60 focus:bg-black/60 focus:shadow-[0_0_0_4px_rgba(99,102,241,0.15)] disabled:opacity-60"
                  />
                </div>
              </div>

              <div className="reveal" style={{ '--i': 4 }}>
                <label htmlFor="password" className="mb-1.5 block text-xs font-medium text-neutral-400">
                  Password
                </label>
                <div className="input-wrap relative">
                  <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-neutral-500 transition-colors">
                    <LockIcon />
                  </span>
                  <input
                    id="password"
                    type="password"
                    required
                    minLength={6}
                    autoComplete={mode === 'signup' ? 'new-password' : 'current-password'}
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    disabled={pending !== null}
                    placeholder={mode === 'signup' ? 'At least 6 characters' : 'Your password'}
                    className="h-11 w-full rounded-lg border border-white/10 bg-black/40 pl-10 pr-3 text-sm text-white outline-none transition duration-300 placeholder:text-neutral-600 hover:border-white/20 focus:border-indigo-400/60 focus:bg-black/60 focus:shadow-[0_0_0_4px_rgba(99,102,241,0.15)] disabled:opacity-60"
                  />
                </div>
              </div>

              <div className="reveal" style={{ '--i': 5 }}>
                <GlowButton type="submit" loading={pending === 'email'} disabled={pending !== null}>
                  {mode === 'signup' ? 'CREATE ACCOUNT' : 'LOG IN'}
                </GlowButton>
              </div>
            </form>

            <p className="reveal mt-4 text-center text-xs text-neutral-500" style={{ '--i': 6 }}>
              {mode === 'signup' ? 'Already have an account? ' : "Don't have an account? "}
              <button
                type="button"
                onClick={toggleMode}
                disabled={pending !== null}
                className="link-underline text-indigo-300 transition hover:text-indigo-200 disabled:pointer-events-none disabled:opacity-60"
              >
                {mode === 'signup' ? 'Log in' : 'Create one'}
              </button>
            </p>

            <div className="reveal my-7 flex items-center gap-3" style={{ '--i': 7 }}>
              <div className="h-px flex-1 bg-gradient-to-r from-transparent to-white/15" />
              <span className="text-[10px] tracking-[0.2em] text-neutral-500">OR</span>
              <div className="h-px flex-1 bg-gradient-to-l from-transparent to-white/15" />
            </div>

            <div className="reveal grid grid-cols-1 gap-3 sm:grid-cols-2" style={{ '--i': 8 }}>
              <ProviderButton
                icon={<GoogleIcon />}
                label="Sign in with Google"
                loading={pending === 'google'}
                disabled={pending !== null}
                onClick={() => handleProviderSignIn('google')}
              />
              <ProviderButton
                icon={<GitHubIcon />}
                label="Sign in with GitHub"
                loading={pending === 'github'}
                disabled={pending !== null}
                onClick={() => handleProviderSignIn('github')}
              />
            </div>

            {error && (
              <div
                key={error.id}
                role="alert"
                className="error-in mt-5 rounded-lg border border-red-500/20 bg-red-500/10 px-3 py-2.5 text-center text-xs text-red-300"
              >
                <p>{error.message}</p>
                {error.retryWith && (
                  <button
                    type="button"
                    disabled={pending !== null}
                    onClick={() => handleProviderSignIn(error.retryWith, { pickAccount: true })}
                    className="mt-2.5 inline-flex h-8 cursor-pointer items-center gap-2 rounded-md border border-white/10 bg-white/[0.06] px-3 font-medium text-neutral-100 transition hover:border-white/25 hover:bg-white/10 disabled:pointer-events-none disabled:opacity-60"
                  >
                    {error.retryWith === 'github' ? <GitHubIcon /> : <GoogleIcon />}
                    Continue with a different {PROVIDERS[error.retryWith].label} account
                  </button>
                )}
              </div>
            )}
          </div>
        </div>

        <div className="reveal mt-8 flex items-center justify-center gap-3 text-xs text-neutral-500" style={{ '--i': 7 }}>
          <button type="button" className="link-underline transition hover:text-neutral-200">
            Terms of Use
          </button>
          <span className="h-3 w-px bg-white/15" />
          <button type="button" className="link-underline transition hover:text-neutral-200">
            Privacy Policy
          </button>
        </div>
      </div>
    </div>
  )
}

export default Login
