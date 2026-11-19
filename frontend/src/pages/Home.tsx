import { Camera, ChevronRight, Info, MapPin, RefreshCw, Search, Settings, Users } from 'lucide-react'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { Empty, Loading, Spinner, StatusChip } from '../components/ui'
import { api } from '../lib/api'
import type { CrossCheck, Status, UnitCrossCheck } from '../lib/types'
import { fmt, STATUS, timeAgo, titleCase } from '../lib/util'
import { useWorkspace } from '../state/app'

export function useCrossCheck(workspaceId: string | undefined, electionId: string | undefined) {
  const [data, setData] = useState<CrossCheck | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const load = useCallback(async () => {
    if (!workspaceId || !electionId) return
    setBusy(true)
    try {
      setData(await api.get<CrossCheck>(`/workspaces/${workspaceId}/crosscheck?election_id=${electionId}`))
      setError(null)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not load results')
    } finally {
      setBusy(false)
    }
  }, [workspaceId, electionId])
  useEffect(() => {
    load()
    const t = setInterval(load, 20_000) // live: new uploads and corrections appear without a reload
    return () => clearInterval(t)
  }, [load])
  return { data, error, busy, reload: load }
}

export default function Home() {
  const { ctx, election } = useWorkspace()
  if (!ctx) return <Loading />
  if (!election)
    return (
      <div className="card">
        <Empty icon={<Settings size={24} />} title="No election set up yet">
          {ctx.role === 'party_admin' ? (
            <>
              Add your polling units and the election to start receiving results.
              <div style={{ marginTop: 12 }}>
                <Link className="btn primary" to={`/w/${ctx.workspace.id}/setup`}>
                  Open setup
                </Link>
              </div>
            </>
          ) : (
            'Your administrator has not finished setting up the election.'
          )}
        </Empty>
      </div>
    )
  if (ctx.role === 'pu_agent') return <AgentHome />
  return <Board />
}

/* ------------------------------------------------------------------ agent */

function AgentHome() {
  const { ctx, election } = useWorkspace()
  const { data } = useCrossCheck(ctx!.workspace.id, election!.id)
  const units = ctx!.assignments.filter((a) => a.level === 'polling_unit')
  return (
    <>
      <div className="page-head">
        <span className="faint small">{election!.name}</span>
        <h1>Your polling unit</h1>
      </div>
      {units.length === 0 && <div className="banner wait">You have not been assigned a polling unit yet. Ask your party administrator.</div>}
      {units.map((u) => {
        const row = data?.units.find((x) => x.node.id === u.id)
        const mine = row?.reports[0]?.result
        return (
          <section key={u.id} className="card stack">
            <div className="spread" style={{ alignItems: 'flex-start' }}>
              <div style={{ minWidth: 0 }}>
                <div style={{ fontWeight: 700, fontSize: 18, lineHeight: 1.25 }}>{titleCase(u.name)}</div>
                <div className="mono faint small">{u.code}</div>
                <div className="faint small">{u.path.map(titleCase).join(' · ')}</div>
              </div>
              {row && <StatusChip status={row.status} />}
            </div>
            {mine ? (
              <div className={`banner ${row?.status === 'mismatch' ? 'bad' : row?.status === 'awaiting_inec' ? 'wait' : ''}`}>
                <Info size={16} />
                <span>
                  You reported <b>{fmt.format(mine.totals.total_votes_cast)}</b> votes cast {timeAgo(mine.submitted_at)}
                  {mine.version > 1 ? ` (correction v${mine.version})` : ''}.{' '}
                  {row?.status === 'mismatch' && 'INEC’s upload differs from yours. Your party has been alerted.'}
                  {row?.status === 'match' && 'It matches INEC’s upload.'}
                  {row?.status === 'awaiting_inec' && 'INEC has not uploaded this unit yet.'}
                </span>
              </div>
            ) : (
              <p className="muted" style={{ margin: 0 }}>
                When counting ends, take a clear photo of the result sheet (Form EC8A) and enter the figures.
              </p>
            )}
            <div className="grid-2" style={{ gap: 10 }}>
              <Link className="btn primary block" to={`/w/${ctx!.workspace.id}/submit/${u.id}${mine ? `?correct=${mine.submission_id}` : ''}`}>
                <Camera size={18} /> {mine ? 'Submit a correction' : 'Upload result'}
              </Link>
              {row && mine && (
                <Link className="btn block" to={`/w/${ctx!.workspace.id}/units/${u.id}`}>
                  View vs INEC
                </Link>
              )}
            </div>
          </section>
        )
      })}
    </>
  )
}

/* ------------------------------------------------------------------ party admin + INEC */

const FILTERS: (Status | 'all')[] = ['all', 'mismatch', 'awaiting_inec', 'match']

function Board() {
  const { ctx, election } = useWorkspace()
  const inec = ctx!.workspace.kind === 'inec'
  const { data, error, busy, reload } = useCrossCheck(ctx!.workspace.id, election!.id)
  const [filter, setFilter] = useState<Status | 'all'>('all')
  const [q, setQ] = useState('')

  const units = useMemo(() => {
    const term = q.trim().toLowerCase()
    return (data?.units ?? []).filter(
      (u) => (filter === 'all' || u.status === filter) && (!term || u.node.name.toLowerCase().includes(term) || u.node.code.includes(term)),
    )
  }, [data, filter, q])

  if (!data && !error) return <Loading text="Loading polling units…" />
  const s = data?.summary
  const reported = s ? s.total_units - s.not_reported - (inec ? s.awaiting_inec : s.awaiting_party) : 0

  return (
    <>
      <div className="page-head">
        <span className="faint small">{election!.name}</span>
        <div className="spread">
          <h1>{inec ? 'Results desk' : 'Results'}</h1>
          <button className="btn sm" onClick={reload} disabled={busy} aria-label="Refresh">
            {busy ? <Spinner size={15} /> : <RefreshCw size={15} />}
          </button>
        </div>
      </div>

      {error && <div className="banner bad">{error}</div>}
      {data && !inec && !data.inec_connected && (
        <div className="banner wait">
          <Info size={16} />
          <span>INEC has not published this election on TallyTrail yet. Agent results are being collected and will be checked as soon as INEC uploads.</span>
        </div>
      )}
      {s && (s.mismatch > 0 ? (
        <div className="banner bad">
          <Info size={16} />
          <span>
            <b>{s.mismatch}</b> polling unit{s.mismatch === 1 ? '' : 's'} {inec ? 'where INEC’s upload differs from party agents’ results. Review each one and confirm the correct figure.' : 'where INEC’s figures differ from your agents’ result sheets.'}
          </span>
        </div>
      ) : null)}

      {s && (
        <div className="tiles">
          <button className={`tile ink ${filter === 'all' ? 'on' : ''}`} onClick={() => setFilter('all')}>
            <span className="l">{inec ? 'INEC uploaded' : 'Agents reported'}</span>
            <span className="v num">
              {inec ? s.total_units - s.awaiting_inec - s.not_reported : reported}
              <span style={{ fontSize: 15, opacity: 0.6 }}> / {s.total_units}</span>
            </span>
          </button>
          <button className={`tile ${s.mismatch ? 'bad' : ''} ${filter === 'mismatch' ? 'on' : ''}`} onClick={() => setFilter('mismatch')}>
            <span className="l">Mismatches</span>
            <span className="v num">{s.mismatch}</span>
          </button>
          <button className={`tile ${filter === 'awaiting_inec' ? 'on' : ''}`} onClick={() => setFilter('awaiting_inec')}>
            <span className="l">Awaiting INEC</span>
            <span className="v num">{s.awaiting_inec}</span>
          </button>
          <button className={`tile ${filter === 'match' ? 'on' : ''}`} onClick={() => setFilter('match')}>
            <span className="l">Matching</span>
            <span className="v num">{s.match}</span>
          </button>
        </div>
      )}

      <section className="card flush">
        <div style={{ padding: 12, borderBottom: '1px solid var(--line-2)' }} className="row">
          <div style={{ position: 'relative', flex: 1, minWidth: 180 }}>
            <Search size={17} style={{ position: 'absolute', left: 13, top: 15, color: 'var(--ink-4)' }} />
            <input className="input" style={{ paddingLeft: 38 }} placeholder="Search polling unit or code" value={q} onChange={(e) => setQ(e.target.value)} />
          </div>
          <div className="row" style={{ gap: 6 }}>
            {FILTERS.map((f) => (
              <button key={f} className={`btn sm ${filter === f ? 'dark' : ''}`} onClick={() => setFilter(f)}>
                {f === 'all' ? 'All' : STATUS[f].short}
              </button>
            ))}
          </div>
        </div>
        <div className="list">
          {units.length === 0 ? (
            <Empty icon={<MapPin size={22} />} title="No polling units here">
              {filter === 'all' ? 'Add polling units in Setup.' : 'Nothing in this filter right now.'}
            </Empty>
          ) : (
            units.map((u) => <UnitRow key={u.node.id} u={u} inec={inec} wid={ctx!.workspace.id} />)
          )}
        </div>
      </section>

      {!inec && ctx!.role === 'party_admin' && (
        <Link to={`/w/${ctx!.workspace.id}/agents`} className="card row-link" style={{ border: '1px solid var(--line)', borderRadius: 'var(--r)' }}>
          <span className="row" style={{ flexWrap: 'nowrap' }}>
            <Users size={20} />
            <span>
              <span className="t" style={{ display: 'block' }}>
                Manage agents
              </span>
              <span className="s">Add an agent and assign their polling unit</span>
            </span>
          </span>
          <ChevronRight size={18} />
        </Link>
      )}
    </>
  )
}

function UnitRow({ u, inec, wid }: { u: UnitCrossCheck; inec: boolean; wid: string }) {
  const lead = u.reports.find((r) => r.status === 'mismatch')?.differences.find((d) => d.field.startsWith('party:'))
  const sub = inec
    ? u.reports.length
      ? `${u.reports.length} party report${u.reports.length === 1 ? '' : 's'}: ${u.reports.map((r) => r.party_code).join(', ')}`
      : 'No party reports yet'
    : u.reports[0]?.result
      ? `Agent reported ${fmt.format(u.reports[0].result.totals.total_votes_cast)} votes cast`
      : 'Agent has not reported'
  return (
    <Link to={`/w/${wid}/units/${u.node.id}`} className="row-link">
      <span style={{ minWidth: 0 }}>
        <span className="t" style={{ display: 'block' }}>
          {titleCase(u.node.name)}
        </span>
        <span className="s" style={{ display: 'block' }}>
          <span className="mono">{u.node.code}</span> · {lead ? `${lead.label} ${lead.delta! > 0 ? '+' : ''}${fmt.format(lead.delta ?? 0)} at INEC` : sub}
        </span>
      </span>
      <span className="row" style={{ gap: 6, flexWrap: 'nowrap' }}>
        <StatusChip status={u.status} inec={inec} />
        <ChevronRight size={18} className="faint" />
      </span>
    </Link>
  )
}
