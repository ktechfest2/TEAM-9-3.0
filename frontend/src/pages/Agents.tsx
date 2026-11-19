import { Check, Copy, MapPin, MessageCircle, Plus, Search, Share2, UserPlus, Users } from 'lucide-react'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { Empty, Loading, Sheet, Spinner } from '../components/ui'
import { api } from '../lib/api'
import type { GeographyNode, Invitation, PendingInvite, Person } from '../lib/types'
import { inviteLink, titleCase } from '../lib/util'
import { useApp, useWorkspace } from '../state/app'

export default function Agents() {
  const { ctx } = useWorkspace()
  const [people, setPeople] = useState<{ members: Person[]; pending: PendingInvite[] } | null>(null)
  const [units, setUnits] = useState<GeographyNode[]>([])
  const [adding, setAdding] = useState<GeographyNode | true | null>(null)
  const [issued, setIssued] = useState<{ invite: Invitation; unit: GeographyNode } | null>(null)
  const [q, setQ] = useState('')

  const load = useCallback(async () => {
    if (!ctx) return
    const [p, u] = await Promise.all([
      api.get<{ members: Person[]; pending: PendingInvite[] }>(`/workspaces/${ctx.workspace.id}/people`),
      api.get<GeographyNode[]>(`/workspaces/${ctx.workspace.id}/geography?level=polling_unit`),
    ])
    setPeople(p)
    setUnits(u)
  }, [ctx])

  useEffect(() => {
    load()
  }, [load])

  const agents = useMemo(() => people?.members.filter((m) => m.role === 'pu_agent') ?? [], [people])
  const covered = useMemo(() => {
    const ids = new Set<string>()
    agents.forEach((a) => a.assignments.forEach((n) => ids.add(n.id)))
    people?.pending.forEach((p) => p.polling_unit && ids.add(p.polling_unit.id))
    return ids
  }, [agents, people])

  if (!ctx || !people) return <Loading />

  const rows = [...units]
    .sort((a, b) => Number(covered.has(a.id)) - Number(covered.has(b.id)) || a.code.localeCompare(b.code))
    .filter((u) => !q || u.name.toLowerCase().includes(q.toLowerCase()) || u.code.includes(q))

  return (
    <>
      <div className="page-head">
        <span className="faint small">{ctx.workspace.name}</span>
        <div className="spread">
          <h1>Agents</h1>
          <button className="btn primary" onClick={() => setAdding(true)} disabled={!units.length}>
            <UserPlus size={18} /> Add agent
          </button>
        </div>
      </div>

      <section className="card stack">
        <div className="spread">
          <span>
            <b className="num" style={{ fontSize: 22 }}>
              {covered.size}
            </b>
            <span className="muted"> of {units.length} polling units have an agent</span>
          </span>
        </div>
        <div className="progress" aria-hidden>
          <i style={{ width: `${units.length ? (covered.size / units.length) * 100 : 0}%` }} />
        </div>
      </section>

      <section className="card flush">
        <div style={{ padding: 12, borderBottom: '1px solid var(--line-2)', position: 'relative' }}>
          <Search size={17} style={{ position: 'absolute', left: 25, top: 27, color: 'var(--ink-4)' }} />
          <input className="input" style={{ paddingLeft: 38 }} placeholder="Search polling units" value={q} onChange={(e) => setQ(e.target.value)} />
        </div>
        <div className="list">
          {rows.length === 0 && (
            <Empty icon={<MapPin size={22} />} title="No polling units yet">
              Import your polling units in Setup first.
            </Empty>
          )}
          {rows.map((u) => {
            const agent = agents.find((a) => a.assignments.some((n) => n.id === u.id))
            const pending = people.pending.find((p) => p.polling_unit?.id === u.id)
            return (
              <div key={u.id} className="row-link" style={{ cursor: 'default' }}>
                <span style={{ minWidth: 0 }}>
                  <span className="t" style={{ display: 'block' }}>
                    {titleCase(u.name)}
                  </span>
                  <span className="s" style={{ display: 'block' }}>
                    <span className="mono">{u.code}</span> ·{' '}
                    {agent ? (
                      <>
                        {agent.full_name}
                        {!agent.is_active && ' (deactivated)'}
                      </>
                    ) : pending ? (
                      <>Invited {pending.email}</>
                    ) : (
                      <span style={{ color: 'var(--bad)' }}>No agent</span>
                    )}
                  </span>
                </span>
                {agent ? (
                  <span className="chip ok">
                    <Check size={14} /> Agent
                  </span>
                ) : pending ? (
                  <button className="btn sm" onClick={() => setAdding(u)}>
                    Re-invite
                  </button>
                ) : (
                  <button className="btn sm primary" onClick={() => setAdding(u)}>
                    <Plus size={15} /> Assign
                  </button>
                )}
              </div>
            )
          })}
        </div>
      </section>

      {agents.length === 0 && people.pending.length === 0 && units.length > 0 && (
        <div className="banner">
          <Users size={16} />
          <span>Add an agent for each polling unit. They get a link to set their password, then upload the result sheet from their phone.</span>
        </div>
      )}

      {adding && (
        <AddAgent
          units={units}
          covered={covered}
          preset={adding === true ? null : adding}
          onClose={() => setAdding(null)}
          onDone={(invite, unit) => {
            setAdding(null)
            setIssued({ invite, unit })
            load()
          }}
        />
      )}
      {issued && <InviteIssued invite={issued.invite} unit={issued.unit} party={ctx.workspace.name} onClose={() => setIssued(null)} />}
    </>
  )
}

function AddAgent({
  units,
  covered,
  preset,
  onClose,
  onDone,
}: {
  units: GeographyNode[]
  covered: Set<string>
  preset: GeographyNode | null
  onClose: () => void
  onDone: (i: Invitation, u: GeographyNode) => void
}) {
  const { ctx } = useWorkspace()
  const [email, setEmail] = useState('')
  const [unitId, setUnitId] = useState(preset?.id ?? units.find((u) => !covered.has(u.id))?.id ?? '')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const unit = units.find((u) => u.id === unitId)

  const save = async () => {
    if (!ctx || !unit) return
    setBusy(true)
    setError(null)
    try {
      const invite = await api.post<Invitation>(`/workspaces/${ctx.workspace.id}/invitations`, {
        email: email.trim(),
        role: 'pu_agent',
        geography_node_id: unit.id,
      })
      onDone(invite, unit)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not add the agent')
    } finally {
      setBusy(false)
    }
  }

  return (
    <Sheet title="Add an agent" onClose={onClose}>
      <div className="stack">
        <label className="field">
          <span>
            Polling unit <span className="hint">· required: where this agent reports from</span>
          </span>
          <select className="select" value={unitId} onChange={(e) => setUnitId(e.target.value)}>
            <option value="" disabled>
              Choose a polling unit
            </option>
            {units.map((u) => (
              <option key={u.id} value={u.id}>
                {u.code} · {titleCase(u.name)}
                {covered.has(u.id) ? ' (has agent)' : ''}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          <span>Agent’s email</span>
          <input className="input" type="email" inputMode="email" autoComplete="off" placeholder="agent@example.com" value={email} onChange={(e) => setEmail(e.target.value)} />
        </label>
        {unit && covered.has(unit.id) && <div className="banner wait">This unit already has an agent or a pending invite. Adding another is allowed.</div>}
        {error && <div className="banner bad">{error}</div>}
        <button className="btn primary block" disabled={busy || !unit || !email.includes('@')} onClick={save}>
          {busy ? <Spinner /> : <UserPlus size={18} />} Create invite
        </button>
      </div>
    </Sheet>
  )
}

function InviteIssued({ invite, unit, party, onClose }: { invite: Invitation; unit: GeographyNode; party: string; onClose: () => void }) {
  const { toast } = useApp()
  const link = inviteLink(invite.invitation_token)
  const message = `You've been added as the ${party} agent for ${titleCase(unit.name)} (${unit.code}) on TallyTrail. Set your password here: ${link}`
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(link)
      toast('Invite link copied')
    } catch {
      toast('Copy failed: select the link and copy it manually', 'error')
    }
  }
  return (
    <Sheet title="Invite ready" onClose={onClose}>
      <div className="stack">
        <p className="muted" style={{ margin: 0 }}>
          Send this link to <b>{invite.email}</b>. It assigns them to <b>{titleCase(unit.name)}</b> and expires in 3 days.
        </p>
        <input className="input mono small" readOnly value={link} onFocus={(e) => e.target.select()} />
        <div className="banner wait">
          <span>For security this link is shown only once. Share it now.</span>
        </div>
        <div className="grid-2" style={{ gap: 10 }}>
          <a className="btn primary block" href={`https://wa.me/?text=${encodeURIComponent(message)}`} target="_blank" rel="noreferrer">
            <MessageCircle size={18} /> WhatsApp
          </a>
          <button className="btn block" onClick={copy}>
            <Copy size={18} /> Copy link
          </button>
        </div>
        {'share' in navigator && (
          <button className="btn ghost block" onClick={() => navigator.share({ title: 'TallyTrail invite', text: message }).catch(() => {})}>
            <Share2 size={18} /> More sharing options
          </button>
        )}
      </div>
    </Sheet>
  )
}
