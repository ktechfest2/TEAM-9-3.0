import { ArrowRight, Building2, Copy, Home, Landmark, LogOut, MessageCircle, Plus, UserRound } from 'lucide-react'
import { useState } from 'react'
import { Link } from 'react-router-dom'
import { Frame, navFor } from '../components/Shell'
import { Empty, Sheet, Spinner } from '../components/ui'
import { api } from '../lib/api'
import type { Invitation, Workspace } from '../lib/types'
import { inviteLink } from '../lib/util'
import { lastWorkspaceKey, useApp } from '../state/app'

function AccountRow({ w }: { w: Workspace }) {
  return (
    <Link
      to={`/w/${w.id}`}
      className="row-link"
      onClick={() => {
        try {
          localStorage.setItem(lastWorkspaceKey(), w.id)
        } catch {
          /* ignore */
        }
      }}
    >
      <span className="row" style={{ flexWrap: 'nowrap', minWidth: 0 }}>
        <span className={`chip ${w.kind === 'inec' ? 'ink' : 'none'}`} style={{ minWidth: 56, justifyContent: 'center' }}>
          {w.kind === 'inec' ? <Landmark size={14} /> : null}
          {w.party_code}
        </span>
        <span style={{ minWidth: 0 }}>
          <span className="t" style={{ display: 'block' }}>
            {w.name}
          </span>
          <span className="s">{w.kind === 'inec' ? 'INEC account' : 'Party account'} · {w.status}</span>
        </span>
      </span>
      <ArrowRight size={18} className="faint" />
    </Link>
  )
}

export function Accounts() {
  const { workspaces, user, reloadUser } = useApp()
  const [creating, setCreating] = useState<'party' | 'inec' | null>(null)
  const [issued, setIssued] = useState<{ ws: Workspace; invite: Invitation } | null>(null)
  const hasInec = workspaces.some((w) => w.kind === 'inec')
  const sorted = [...workspaces].sort((a, b) => (a.kind === b.kind ? a.party_code.localeCompare(b.party_code) : a.kind === 'inec' ? -1 : 1))

  return (
    <Frame items={navFor('', '', '', true).filter((i) => i.to.startsWith('/'))} title="TallyTrail" subtitle="Platform administration">
      <div className="page-head">
        <span className="faint small">Platform administrator</span>
        <h1>Accounts</h1>
      </div>
      <p className="muted" style={{ margin: 0 }}>
        Each political party gets exactly one account. INEC has a single account. Their administrators then add agents and upload results.
      </p>
      <div className="grid-2" style={{ gap: 10 }}>
        <button className="btn primary block" onClick={() => setCreating('party')}>
          <Plus size={18} /> Add party account
        </button>
        {!hasInec && (
          <button className="btn dark block" onClick={() => setCreating('inec')}>
            <Landmark size={18} /> Create INEC account
          </button>
        )}
      </div>
      <section className="card flush">
        <div className="list">
          {sorted.length === 0 ? <Empty icon={<Building2 size={22} />} title="No accounts yet" /> : sorted.map((w) => <AccountRow key={w.id} w={w} />)}
        </div>
      </section>
      {creating && (
        <CreateAccount
          kind={creating}
          onClose={() => setCreating(null)}
          onDone={async (ws, invite) => {
            setCreating(null)
            setIssued({ ws, invite })
            await reloadUser()
          }}
        />
      )}
      {issued && (
        <Sheet title="Administrator invite" onClose={() => setIssued(null)}>
          <AdminInvite ws={issued.ws} invite={issued.invite} />
        </Sheet>
      )}
      {!user?.is_platform_admin && <div className="banner bad">Only platform administrators can manage accounts.</div>}
    </Frame>
  )
}

function CreateAccount({ kind, onClose, onDone }: { kind: 'party' | 'inec'; onClose: () => void; onDone: (w: Workspace, i: Invitation) => void }) {
  const [name, setName] = useState(kind === 'inec' ? 'Independent National Electoral Commission' : '')
  const [code, setCode] = useState(kind === 'inec' ? 'INEC' : '')
  const [email, setEmail] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const save = async () => {
    setBusy(true)
    setError(null)
    try {
      const ws = await api.post<Workspace>('/workspaces', { name: name.trim(), party_code: code.trim().toUpperCase(), kind })
      const invite = await api.post<Invitation>(`/workspaces/${ws.id}/invitations`, { email: email.trim(), role: 'party_admin' })
      onDone(ws, invite)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not create the account')
    } finally {
      setBusy(false)
    }
  }

  return (
    <Sheet title={kind === 'inec' ? 'Create INEC account' : 'Add party account'} onClose={onClose}>
      <div className="stack">
        <label className="field">
          <span>{kind === 'inec' ? 'Name' : 'Party name'}</span>
          <input className="input" value={name} onChange={(e) => setName(e.target.value)} />
        </label>
        <label className="field">
          <span>
            {kind === 'inec' ? 'Code' : 'Party code'} <span className="hint">· as on the ballot, e.g. PA</span>
          </span>
          <input className="input mono" maxLength={30} value={code} onChange={(e) => setCode(e.target.value.toUpperCase())} disabled={kind === 'inec'} />
        </label>
        <label className="field">
          <span>Administrator’s email</span>
          <input className="input" type="email" value={email} onChange={(e) => setEmail(e.target.value)} />
        </label>
        {error && <div className="banner bad">{error}</div>}
        <button className="btn primary block" disabled={busy || !name || !code || !email.includes('@')} onClick={save}>
          {busy && <Spinner />} Create account
        </button>
      </div>
    </Sheet>
  )
}

function AdminInvite({ ws, invite }: { ws: Workspace; invite: Invitation }) {
  const { toast } = useApp()
  const link = inviteLink(invite.invitation_token)
  const message = `You're the administrator for ${ws.name} on TallyTrail. Set your password here: ${link}`
  return (
    <div className="stack">
      <p className="muted" style={{ margin: 0 }}>
        Send this link to <b>{invite.email}</b>. It is shown only once and expires in 3 days.
      </p>
      <input className="input mono small" readOnly value={link} onFocus={(e) => e.target.select()} />
      <div className="grid-2" style={{ gap: 10 }}>
        <a className="btn primary block" href={`https://wa.me/?text=${encodeURIComponent(message)}`} target="_blank" rel="noreferrer">
          <MessageCircle size={18} /> WhatsApp
        </a>
        <button
          className="btn block"
          onClick={() =>
            navigator.clipboard.writeText(link).then(
              () => toast('Invite link copied'),
              () => toast('Copy failed', 'error'),
            )
          }
        >
          <Copy size={18} /> Copy link
        </button>
      </div>
    </div>
  )
}

export function Me() {
  const { user, workspaces, signOut } = useApp()
  return (
    <Frame
      items={[{ to: '/', label: 'Home', icon: Home, end: true }, ...navFor('', '', '', !!user?.is_platform_admin).filter((i) => i.to.startsWith('/'))]}
      title="Me"
      subtitle={user?.email}
    >
      <div className="page-head">
        <h1>{user?.full_name}</h1>
        <span className="faint small">{user?.email}</span>
      </div>
      <section className="card flush">
        <div style={{ padding: '14px 16px 4px' }} className="faint small">
          Your accounts
        </div>
        <div className="list">
          {workspaces.length === 0 ? <Empty icon={<UserRound size={22} />} title="No accounts yet" /> : workspaces.map((w) => <AccountRow key={w.id} w={w} />)}
        </div>
      </section>
      <button className="btn block" onClick={signOut}>
        <LogOut size={18} /> Sign out
      </button>
    </Frame>
  )
}
