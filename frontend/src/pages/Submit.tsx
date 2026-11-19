import { ArrowLeft, ArrowRight, Camera, CheckCircle2, ImageUp, RefreshCw, Search, ShieldCheck } from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom'
import { Loading, Spinner, StatusChip } from '../components/ui'
import { api, ApiError, idempotencyKey } from '../lib/api'
import type { DocumentOut, GeographyNode, NodeSummary, ReportedFigures, Submission, UnitCrossCheck } from '../lib/types'
import { compressImage, fmt, titleCase } from '../lib/util'
import { useApp, useWorkspace } from '../state/app'

type Step = 'unit' | 'photo' | 'figures' | 'confirm' | 'done'

export default function Submit() {
  const { nodeId } = useParams()
  const [params] = useSearchParams()
  const correctId = params.get('correct')
  const { ctx, election } = useWorkspace()
  const { toast } = useApp()
  const nav = useNavigate()
  const contest = election?.contests[0]
  const inec = ctx?.workspace.kind === 'inec'

  const [units, setUnits] = useState<NodeSummary[]>([])
  const [unit, setUnit] = useState<NodeSummary | null>(null)
  const [step, setStep] = useState<Step>('unit')
  const [file, setFile] = useState<File | null>(null)
  const [preview, setPreview] = useState<string | null>(null)
  const [previous, setPrevious] = useState<ReportedFigures | null>(null)
  const [votes, setVotes] = useState<Record<string, string>>({})
  const [rejected, setRejected] = useState('')
  const [accredited, setAccredited] = useState('')
  const [confirmTotal, setConfirmTotal] = useState('')
  const [reason, setReason] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [result, setResult] = useState<UnitCrossCheck | null>(null)
  const idem = useRef(idempotencyKey()) // stable across retries so a flaky network never double-submits

  // Units this person may report: their assignments, or every polling unit for the INEC account.
  useEffect(() => {
    if (!ctx) return
    if (ctx.can_submit_anywhere) {
      api.get<GeographyNode[]>(`/workspaces/${ctx.workspace.id}/geography?level=polling_unit`).then((nodes) =>
        setUnits(nodes.map((n) => ({ id: n.id, level: n.level, code: n.code, name: n.name, path: [] }))),
      )
    } else setUnits(ctx.assignments.filter((a) => a.level === 'polling_unit'))
  }, [ctx])

  useEffect(() => {
    if (!units.length) return
    const chosen = units.find((u) => u.id === nodeId) ?? (units.length === 1 ? units[0] : null)
    if (chosen) {
      setUnit(chosen)
      setStep((s) => (s === 'unit' ? 'photo' : s))
    }
  }, [units, nodeId])

  // Already reported this unit? Then this is a correction of that result, never a competing v1.
  // Correction: prefill from the current figures and keep the existing sheet unless replaced.
  useEffect(() => {
    if (!ctx || !election || !unit) return
    api.get<UnitCrossCheck>(`/workspaces/${ctx.workspace.id}/crosscheck/units/${unit.id}?election_id=${election.id}`).then((u) => {
      const current = inec ? u.inec : u.reports[0]?.result
      if (current && current.submission_id !== correctId) {
        nav(`/w/${ctx.workspace.id}/submit/${unit.id}?correct=${current.submission_id}`, { replace: true })
        return
      }
      if (current && current.submission_id === correctId) {
        setPrevious(current)
        setVotes(Object.fromEntries(Object.entries(current.votes).map(([k, v]) => [k, String(v)])))
        setRejected(String(current.totals.rejected_ballots))
      }
    })
  }, [ctx, election, unit, correctId, inec, nav])

  useEffect(() => () => void (preview && URL.revokeObjectURL(preview)), [preview])

  const candidates = contest?.candidates ?? []
  const valid = useMemo(() => candidates.reduce((s, c) => s + (Number(votes[c.party_code]) || 0), 0), [candidates, votes])
  const rej = Number(rejected) || 0
  const total = valid + rej
  const acc = accredited === '' ? null : Number(accredited)
  const figuresOk = candidates.every((c) => votes[c.party_code] !== undefined && votes[c.party_code] !== '') && rejected !== '' && (acc === null || total <= acc)

  if (!ctx || !election) return <Loading />
  if (!contest) return <div className="banner wait">This election has no contest configured yet.</div>

  const pickPhoto = async (f: File | undefined) => {
    if (!f) return
    const small = await compressImage(f)
    setFile(small)
    if (preview) URL.revokeObjectURL(preview)
    setPreview(small.type.startsWith('image/') ? URL.createObjectURL(small) : null)
  }

  const submit = async () => {
    if (!unit) return
    setBusy(true)
    setError(null)
    try {
      let documentId = previous?.document_id
      if (file) {
        const form = new FormData()
        form.append('file', file, file.name)
        documentId = (await api.upload<DocumentOut>(`/workspaces/${ctx.workspace.id}/documents`, form)).id
      }
      if (!documentId) throw new ApiError(422, 'photo_required', 'Add a photo of the result sheet first.')
      await api.post<Submission>(
        `/workspaces/${ctx.workspace.id}/submissions`,
        {
          election_id: election.id,
          contest_id: contest.id,
          geography_node_id: unit.id,
          document_id: documentId,
          form_type: 'EC8A',
          figures: candidates.map((c) => ({ candidate_id: c.id, votes: Number(votes[c.party_code]) || 0 })),
          valid_votes: valid,
          rejected_ballots: rej,
          total_votes_cast: total,
          accredited_voters: acc,
          supersedes_id: correctId ?? undefined,
          correction_reason: correctId ? reason.trim() : undefined,
        },
        { 'Idempotency-Key': idem.current },
      )
      setResult(await api.get<UnitCrossCheck>(`/workspaces/${ctx.workspace.id}/crosscheck/units/${unit.id}?election_id=${election.id}`))
      setStep('done')
      toast(correctId ? 'Correction saved' : 'Result submitted')
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Submission failed')
    } finally {
      setBusy(false)
    }
  }

  const steps: Step[] = ['unit', 'photo', 'figures', 'confirm']
  const at = steps.indexOf(step)

  return (
    <>
      <div className="page-head">
        <span className="faint small">{correctId ? (inec ? 'Correct INEC figure' : 'Correction') : 'Form EC8A'}</span>
        <h1>{step === 'done' ? 'Submitted' : correctId ? 'Submit a correction' : 'Upload result'}</h1>
      </div>
      {step !== 'done' && (
        <div className="steps" aria-hidden>
          {steps.map((s, i) => (
            <i key={s} className={i <= at ? 'on' : ''} />
          ))}
        </div>
      )}
      {unit && step !== 'unit' && step !== 'done' && (
        <div className="card spread" style={{ padding: 12 }}>
          <span style={{ minWidth: 0 }}>
            <b style={{ display: 'block', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{titleCase(unit.name)}</b>
            <span className="mono faint small">{unit.code}</span>
          </span>
          {units.length > 1 && !correctId && (
            <button className="btn sm" onClick={() => setStep('unit')}>
              Change
            </button>
          )}
        </div>
      )}

      {step === 'unit' && <UnitPicker units={units} onPick={(u) => (setUnit(u), setStep('photo'))} />}

      {step === 'photo' && (
        <section className="card stack">
          <h2 style={{ fontSize: 17 }}>Photo of the result sheet</h2>
          <p className="muted small" style={{ margin: 0 }}>
            Lay the sheet flat in good light. All figures and signatures should be readable.
          </p>
          {preview || file ? (
            <div className="photo">
              {preview ? <img src={preview} alt="Result sheet preview" /> : <div className="empty">PDF attached</div>}
              <div className="cap">
                <span className="faint">
                  {file?.name} · {fmt.format(Math.round((file?.size ?? 0) / 1024))} KB
                </span>
                <label className="btn sm" style={{ minHeight: 30 }}>
                  <RefreshCw size={14} /> Retake
                  <input type="file" accept="image/*,application/pdf" capture="environment" hidden onChange={(e) => pickPhoto(e.target.files?.[0])} />
                </label>
              </div>
            </div>
          ) : (
            <label className="photo-drop">
              <Camera size={34} />
              <span>Take photo</span>
              <span className="faint small" style={{ fontWeight: 400 }}>
                or choose a photo / PDF
              </span>
              <input type="file" accept="image/*,application/pdf" capture="environment" onChange={(e) => pickPhoto(e.target.files?.[0])} />
            </label>
          )}
          {previous && !file && (
            <div className="banner">
              <ImageUp size={16} />
              <span>The earlier sheet will be kept for this correction unless you take a new photo.</span>
            </div>
          )}
          <div className="sticky-actions">
            <button className="btn primary" disabled={!file && !previous} onClick={() => setStep('figures')}>
              Next: enter figures <ArrowRight size={18} />
            </button>
          </div>
        </section>
      )}

      {step === 'figures' && (
        <section className="card stack">
          <h2 style={{ fontSize: 17 }}>Votes on the sheet</h2>
          <div>
            {candidates.map((c) => (
              <label key={c.id} className="vote-row">
                <span className="party">
                  <b>{c.party_code}</b>
                  <span>
                    {c.party_name} · {c.name}
                  </span>
                </span>
                <input
                  className="input"
                  inputMode="numeric"
                  pattern="[0-9]*"
                  placeholder="0"
                  value={votes[c.party_code] ?? ''}
                  onChange={(e) => setVotes({ ...votes, [c.party_code]: e.target.value.replace(/\D/g, '') })}
                />
              </label>
            ))}
            <label className="vote-row">
              <span className="party">
                <b>Rejected ballots</b>
              </span>
              <input className="input" inputMode="numeric" pattern="[0-9]*" placeholder="0" value={rejected} onChange={(e) => setRejected(e.target.value.replace(/\D/g, ''))} />
            </label>
            <label className="vote-row">
              <span className="party">
                <b>Accredited voters</b>
                <span>Optional</span>
              </span>
              <input className="input" inputMode="numeric" pattern="[0-9]*" placeholder="—" value={accredited} onChange={(e) => setAccredited(e.target.value.replace(/\D/g, ''))} />
            </label>
          </div>
          <div className="sum-check num">
            <div className="spread">
              <span>Valid votes (sum)</span>
              <b>{fmt.format(valid)}</b>
            </div>
            <div className="spread">
              <span>Total votes cast</span>
              <b>{fmt.format(total)}</b>
            </div>
            {acc !== null && total > acc && <span style={{ color: 'var(--bad)' }}>Total cast cannot exceed accredited voters ({fmt.format(acc)}).</span>}
          </div>
          <div className="sticky-actions">
            <button className="btn" onClick={() => setStep('photo')} aria-label="Back">
              <ArrowLeft size={18} />
            </button>
            <button className="btn primary" disabled={!figuresOk} onClick={() => setStep('confirm')}>
              Review <ArrowRight size={18} />
            </button>
          </div>
        </section>
      )}

      {step === 'confirm' && (
        <section className="card stack">
          <h2 style={{ fontSize: 17 }}>Check before you send</h2>
          <label className="field">
            <span>
              Type the <b>total votes cast</b> exactly as written on the sheet
            </span>
            <input className="input num" inputMode="numeric" pattern="[0-9]*" value={confirmTotal} onChange={(e) => setConfirmTotal(e.target.value.replace(/\D/g, ''))} autoFocus />
            {confirmTotal !== '' && Number(confirmTotal) !== total && (
              <span className="small" style={{ color: 'var(--bad)' }}>
                That doesn’t match the {fmt.format(total)} you entered. Recheck the figures.
              </span>
            )}
          </label>
          {correctId && (
            <label className="field">
              <span>
                Reason for the correction <span className="hint">· kept in the audit trail</span>
              </span>
              <textarea className="textarea" value={reason} onChange={(e) => setReason(e.target.value)} placeholder={inec ? 'e.g. Transcription error on the PF row; corrected from the EC8A sheet' : 'e.g. I misread the DU figure'} />
            </label>
          )}
          {error && <div className="banner bad">{error}</div>}
          <div className="sticky-actions">
            <button className="btn" onClick={() => setStep('figures')} aria-label="Back">
              <ArrowLeft size={18} />
            </button>
            <button className="btn primary" disabled={busy || Number(confirmTotal) !== total || confirmTotal === '' || (!!correctId && reason.trim().length < 3)} onClick={submit}>
              {busy ? <Spinner /> : <ShieldCheck size={18} />} {correctId ? 'Save correction' : 'Submit result'}
            </button>
          </div>
        </section>
      )}

      {step === 'done' && result && (
        <section className="card stack" style={{ textAlign: 'center', justifyItems: 'center' }}>
          <CheckCircle2 size={44} color="var(--green-600)" />
          <h2 style={{ fontSize: 20 }}>Saved and fingerprinted</h2>
          <p className="muted" style={{ margin: 0 }}>The sheet was hashed on upload, so any later change to the file is detectable.</p>
          <StatusChip status={result.status} long inec={inec} />
          <div className="grid-2" style={{ width: '100%', gap: 10 }}>
            <Link className="btn primary block" to={`/w/${ctx.workspace.id}/units/${result.node.id}`}>
              View comparison
            </Link>
            <button className="btn block" onClick={() => nav(`/w/${ctx.workspace.id}`)}>
              Done
            </button>
          </div>
        </section>
      )}
    </>
  )
}

function UnitPicker({ units, onPick }: { units: NodeSummary[]; onPick: (u: NodeSummary) => void }) {
  const [q, setQ] = useState('')
  const list = units.filter((u) => !q || u.name.toLowerCase().includes(q.toLowerCase()) || u.code.includes(q))
  if (!units.length) return <div className="banner wait">No polling units are assigned to you yet.</div>
  return (
    <section className="card flush">
      <div style={{ padding: 12, borderBottom: '1px solid var(--line-2)', position: 'relative' }}>
        <Search size={17} style={{ position: 'absolute', left: 25, top: 27, color: 'var(--ink-4)' }} />
        <input className="input" style={{ paddingLeft: 38 }} placeholder="Find polling unit" value={q} onChange={(e) => setQ(e.target.value)} autoFocus />
      </div>
      <div className="list">
        {list.map((u) => (
          <button key={u.id} className="row-link" onClick={() => onPick(u)}>
            <span style={{ minWidth: 0 }}>
              <span className="t" style={{ display: 'block' }}>
                {titleCase(u.name)}
              </span>
              <span className="s mono">{u.code}</span>
            </span>
            <ArrowRight size={18} className="faint" />
          </button>
        ))}
      </div>
    </section>
  )
}
