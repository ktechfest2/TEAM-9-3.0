import { CheckCircle2, ShieldCheck } from 'lucide-react'
import { useState, type FormEvent, type ReactNode } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { Logo, Spinner, Toasts } from '../components/ui'
import { auth } from '../lib/api'
import { useApp } from '../state/app'

function AuthLayout({ children }: { children: ReactNode }) {
  return (
    <div className="auth">
      <section className="auth-hero">
        <div className="brand">
          <Logo size={44} />
          <div>
            <b style={{ fontSize: 18 }}>TallyTrail</b>
            <span>Every total traceable</span>
          </div>
        </div>
        <div style={{ display: 'grid', gap: 14 }}>
          <h1>Every polling-unit result, checked against INEC.</h1>
          <p>Party agents snap the result sheet. INEC uploads its own. Any difference is flagged at once, with both sheets side by side.</p>
        </div>
        <div className="auth-points">
          <div>
            <CheckCircle2 size={16} /> One account per party, each agent tied to a polling unit
          </div>
          <div>
            <CheckCircle2 size={16} /> Photos hashed on upload; corrections never erase the original
          </div>
          <div>
            <CheckCircle2 size={16} /> Neutral by design: differences to review, never accusations
          </div>
        </div>
      </section>
      <section className="auth-form">{children}</section>
      <Toasts />
    </div>
  )
}

export function Login() {
  const { reloadUser } = useApp()
  const nav = useNavigate()
  const [params] = useSearchParams()
  const [email, setEmail] = useState(params.get('email') ?? '')
  const [password, setPassword] = useState('')
  const [challenge, setChallenge] = useState<string | null>(null)
  const [code, setCode] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const submit = async (e: FormEvent) => {
    e.preventDefault()
    setBusy(true)
    setError(null)
    try {
      if (challenge) await auth.mfa(challenge, code.trim())
      else {
        const r = await auth.login(email, password)
        if (r.status === 'mfa_required') {
          setChallenge(r.challenge)
          return
        }
      }
      await reloadUser()
      nav('/', { replace: true })
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Sign-in failed')
    } finally {
      setBusy(false)
    }
  }

  return (
    <AuthLayout>
      <form onSubmit={submit}>
        <div>
          <h2 style={{ fontSize: 24 }}>{challenge ? 'Enter your code' : 'Sign in'}</h2>
          <p className="muted" style={{ margin: '6px 0 0' }}>
            {challenge ? 'Open your authenticator app and enter the 6-digit code.' : 'Party admins, agents and INEC staff all sign in here.'}
          </p>
        </div>
        {challenge ? (
          <label className="field">
            <span>Authentication code</span>
            <input className="input mono" inputMode="numeric" autoComplete="one-time-code" maxLength={20} value={code} onChange={(e) => setCode(e.target.value)} autoFocus required />
          </label>
        ) : (
          <>
            <label className="field">
              <span>Email</span>
              <input className="input" type="email" autoComplete="username" value={email} onChange={(e) => setEmail(e.target.value)} required />
            </label>
            <label className="field">
              <span>Password</span>
              <input className="input" type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} required />
            </label>
          </>
        )}
        {error && <div className="banner bad">{error}</div>}
        <button className="btn primary block" disabled={busy}>
          {busy ? <Spinner /> : <ShieldCheck size={18} />} {challenge ? 'Verify' : 'Sign in'}
        </button>
        <p className="faint small" style={{ margin: 0 }}>
          Agents: open the invite link your party sent you to set your password first.
        </p>
      </form>
    </AuthLayout>
  )
}

export function Join() {
  const [params] = useSearchParams()
  const token = params.get('token') ?? ''
  const nav = useNavigate()
  const { toast } = useApp()
  const [name, setName] = useState('')
  const [password, setPassword] = useState('')
  const [confirm, setConfirm] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const submit = async (e: FormEvent) => {
    e.preventDefault()
    if (password !== confirm) return setError('Passwords do not match')
    setBusy(true)
    setError(null)
    try {
      const user = await auth.accept(token, name.trim(), password)
      toast('Account ready. Sign in to continue.')
      nav(`/login?email=${encodeURIComponent(user.email)}`, { replace: true })
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not accept the invitation')
    } finally {
      setBusy(false)
    }
  }

  return (
    <AuthLayout>
      <form onSubmit={submit}>
        <div>
          <h2 style={{ fontSize: 24 }}>Join TallyTrail</h2>
          <p className="muted" style={{ margin: '6px 0 0' }}>Set your name and a password. Your polling unit is already assigned.</p>
        </div>
        {!token && <div className="banner bad">This link is missing its invitation code. Ask your administrator to resend it.</div>}
        <label className="field">
          <span>Full name</span>
          <input className="input" autoComplete="name" value={name} onChange={(e) => setName(e.target.value)} required />
        </label>
        <label className="field">
          <span>
            Password <span className="hint">· at least 12 characters</span>
          </span>
          <input className="input" type="password" autoComplete="new-password" minLength={12} value={password} onChange={(e) => setPassword(e.target.value)} required />
        </label>
        <label className="field">
          <span>Confirm password</span>
          <input className="input" type="password" autoComplete="new-password" minLength={12} value={confirm} onChange={(e) => setConfirm(e.target.value)} required />
        </label>
        {error && <div className="banner bad">{error}</div>}
        <button className="btn primary block" disabled={busy || !token}>
          {busy && <Spinner />} Create my account
        </button>
      </form>
    </AuthLayout>
  )
}
