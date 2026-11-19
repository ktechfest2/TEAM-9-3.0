import { CalendarCheck, Check, Download, FileUp, Info, MapPin, Plus, Trash2 } from 'lucide-react'
import { useCallback, useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Loading, Spinner } from '../components/ui'
import { api } from '../lib/api'
import type { GeographyNode } from '../lib/types'
import { useApp, useWorkspace } from '../state/app'

const TYPES = [
  ['presidential', 'Presidential'],
  ['governorship', 'Governorship'],
  ['senatorial', 'Senatorial'],
  ['representative', 'House of Representatives'],
  ['state_assembly', 'State House of Assembly'],
] as const

const TEMPLATE = `level,code,name,parent_code
state,25,Lagos,
lga,25/11,Ikeja,25
ward,25/11/01,Anifowoshe/Ikeja,25/11
polling_unit,25/11/01/001,Anifowoshe Pry. Sch.,25/11/01
polling_unit,25/11/01/002,Junction of Oduyemi/Independence St.,25/11/01
`

export default function Setup() {
  const { ctx, election, reload } = useWorkspace()
  const [nodes, setNodes] = useState<GeographyNode[] | null>(null)

  const loadNodes = useCallback(async () => {
    if (!ctx) return
    setNodes(await api.get<GeographyNode[]>(`/workspaces/${ctx.workspace.id}/geography`))
  }, [ctx])

  useEffect(() => {
    loadNodes()
  }, [loadNodes])

  if (!ctx || !nodes) return <Loading />
  const count = (level: string) => nodes.filter((n) => n.level === level).length

  return (
    <>
      <div className="page-head">
        <span className="faint small">{ctx.workspace.name}</span>
        <h1>Setup</h1>
      </div>
      <div className="banner">
        <Info size={16} />
        <span>
          {ctx.workspace.kind === 'inec' ? 'Parties' : 'INEC'} must use the <b>same polling-unit codes, election type, date and party codes</b> so results can be matched unit by unit.
        </span>
      </div>

      <GeographyStep wid={ctx.workspace.id} counts={{ state: count('state'), lga: count('lga'), ward: count('ward'), pu: count('polling_unit') }} onDone={loadNodes} />

      {election ? (
        <section className="card stack">
          <div className="spread">
            <h2 style={{ fontSize: 17 }}>Election</h2>
            <span className="chip ok">
              <Check size={14} /> {election.status}
            </span>
          </div>
          <div>
            <b>{election.name}</b>
            <div className="faint small">
              {election.election_type} · {election.election_date}
            </div>
          </div>
          <div className="row" style={{ gap: 6 }}>
            {election.contests[0]?.candidates.map((c) => (
              <span key={c.id} className="chip none">
                {c.party_code} · {c.name}
              </span>
            ))}
          </div>
        </section>
      ) : (
        <ElectionStep wid={ctx.workspace.id} wards={nodes.filter((n) => n.level === 'ward')} disabled={count('polling_unit') === 0} onDone={reload} />
      )}
    </>
  )
}

function GeographyStep({ wid, counts, onDone }: { wid: string; counts: { state: number; lga: number; ward: number; pu: number }; onDone: () => void }) {
  const { toast } = useApp()
  const [file, setFile] = useState<File | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const upload = async () => {
    if (!file) return
    setBusy(true)
    setError(null)
    try {
      const form = new FormData()
      form.append('file', file, file.name)
      await api.upload(`/workspaces/${wid}/geography/import`, form)
      await api.post(`/workspaces/${wid}/activate`).catch(() => undefined)
      toast('Polling units imported')
      setFile(null)
      onDone()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Import failed')
    } finally {
      setBusy(false)
    }
  }

  const template = URL.createObjectURL(new Blob([TEMPLATE], { type: 'text/csv' }))

  return (
    <section className="card stack">
      <div className="spread">
        <h2 style={{ fontSize: 17 }}>Polling units</h2>
        {counts.pu > 0 && (
          <span className="chip ok">
            <Check size={14} /> {counts.pu} units
          </span>
        )}
      </div>
      {counts.pu > 0 ? (
        <p className="muted small" style={{ margin: 0 }}>
          <MapPin size={14} style={{ verticalAlign: -2 }} /> {counts.state} state · {counts.lga} LGA · {counts.ward} wards · {counts.pu} polling units
        </p>
      ) : (
        <>
          <p className="muted small" style={{ margin: 0 }}>
            Upload a CSV with columns <span className="mono">level, code, name, parent_code</span> (state → LGA → ward → polling unit), using INEC polling-unit codes.
          </p>
          <label className="photo-drop" style={{ minHeight: 120 }}>
            <FileUp size={26} />
            <span>{file ? file.name : 'Choose CSV file'}</span>
            <input type="file" accept=".csv,text/csv" onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
          </label>
          {error && <div className="banner bad">{error}</div>}
          <div className="grid-2" style={{ gap: 10 }}>
            <button className="btn primary block" disabled={!file || busy} onClick={upload}>
              {busy && <Spinner />} Import polling units
            </button>
            <a className="btn block" href={template} download="tallytrail-polling-units-template.csv">
              <Download size={17} /> Template
            </a>
          </div>
        </>
      )}
    </section>
  )
}

interface PartyRow {
  code: string
  name: string
  candidate: string
}

function ElectionStep({ wid, wards, disabled, onDone }: { wid: string; wards: GeographyNode[]; disabled: boolean; onDone: () => void }) {
  const { toast } = useApp()
  const nav = useNavigate()
  const [name, setName] = useState('')
  const [type, setType] = useState<(typeof TYPES)[number][0]>('governorship')
  const [date, setDate] = useState('')
  const [jurisdiction, setJurisdiction] = useState('')
  const [parties, setParties] = useState<PartyRow[]>([
    { code: '', name: '', candidate: '' },
    { code: '', name: '', candidate: '' },
  ])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const valid = name && date && jurisdiction && parties.length >= 2 && parties.every((p) => p.code && p.name && p.candidate) && new Set(parties.map((p) => p.code.toUpperCase())).size === parties.length

  const save = async () => {
    setBusy(true)
    setError(null)
    try {
      const election = await api.post<{ id: string }>(`/workspaces/${wid}/elections`, { name, election_type: type, election_date: date, jurisdiction })
      const contest = await api.post<{ id: string }>(`/workspaces/${wid}/elections/${election.id}/contests`, {
        name,
        office: type,
        form_type: 'EC8A',
        geography_level: 'polling_unit',
      })
      for (const [i, p] of parties.entries()) {
        const party = await api.post<{ id: string }>(`/workspaces/${wid}/parties`, { code: p.code.trim().toUpperCase(), name: p.name.trim(), is_monitored: true })
        await api.post(`/workspaces/${wid}/elections/${election.id}/contests/${contest.id}/candidates`, {
          party_id: party.id,
          name: p.candidate.trim(),
          ballot_code: String(i + 1).padStart(2, '0'),
        })
      }
      await api.put(`/workspaces/${wid}/elections/${election.id}/coverage`, { geography_node_ids: wards.map((w) => w.id) })
      await api.post(`/workspaces/${wid}/elections/${election.id}/activate`)
      toast('Election is live')
      await onDone()
      nav(`/w/${wid}`)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not create the election')
    } finally {
      setBusy(false)
    }
  }

  return (
    <section className="card stack" style={disabled ? { opacity: 0.55, pointerEvents: 'none' } : undefined}>
      <h2 style={{ fontSize: 17 }}>Election</h2>
      {disabled && <span className="faint small">Import polling units first.</span>}
      <label className="field">
        <span>Name</span>
        <input className="input" placeholder="2027 Lagos Governorship Election" value={name} onChange={(e) => setName(e.target.value)} />
      </label>
      <div className="grid-2" style={{ gap: 12 }}>
        <label className="field">
          <span>Type</span>
          <select className="select" value={type} onChange={(e) => setType(e.target.value as typeof type)}>
            {TYPES.map(([v, l]) => (
              <option key={v} value={v}>
                {l}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          <span>Polling date</span>
          <input className="input" type="date" value={date} onChange={(e) => setDate(e.target.value)} />
        </label>
      </div>
      <label className="field">
        <span>Jurisdiction</span>
        <input className="input" placeholder="Lagos State" value={jurisdiction} onChange={(e) => setJurisdiction(e.target.value)} />
      </label>
      <div className="field">
        <span>Parties on the ballot</span>
        <div className="stack" style={{ gap: 8 }}>
          {parties.map((p, i) => (
            <div key={i} className="card" style={{ padding: 10, display: 'grid', gap: 8, gridTemplateColumns: '90px 1fr auto' }}>
              <input className="input mono" placeholder="Code" maxLength={30} value={p.code} onChange={(e) => setParties(parties.map((x, j) => (j === i ? { ...x, code: e.target.value.toUpperCase() } : x)))} />
              <input className="input" placeholder="Party name" value={p.name} onChange={(e) => setParties(parties.map((x, j) => (j === i ? { ...x, name: e.target.value } : x)))} />
              <button className="btn icon ghost" aria-label="Remove party" disabled={parties.length <= 2} onClick={() => setParties(parties.filter((_, j) => j !== i))}>
                <Trash2 size={17} />
              </button>
              <input className="input" style={{ gridColumn: '1 / -1' }} placeholder="Candidate name" value={p.candidate} onChange={(e) => setParties(parties.map((x, j) => (j === i ? { ...x, candidate: e.target.value } : x)))} />
            </div>
          ))}
          <button className="btn" onClick={() => setParties([...parties, { code: '', name: '', candidate: '' }])}>
            <Plus size={17} /> Add party
          </button>
        </div>
      </div>
      {error && <div className="banner bad">{error}</div>}
      <button className="btn primary block" disabled={!valid || busy} onClick={save}>
        {busy ? <Spinner /> : <CalendarCheck size={18} />} Create and activate election
      </button>
    </section>
  )
}
