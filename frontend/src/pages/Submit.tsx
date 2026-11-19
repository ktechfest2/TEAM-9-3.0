import { ArrowLeft, ArrowRight, CheckCircle2, ImageUp, Info, RefreshCw, ScanLine, Search, ShieldCheck, Sparkles } from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom'
import LiveCamera, { type LiveCapture } from '../components/LiveCamera'
import { Loading, Spinner, StatusChip } from '../components/ui'
import { api, idempotencyKey } from '../lib/api'
import { readSheet, type SheetReading } from '../lib/ocr'
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
  // Agents photograph the sheet live; INEC types figures (a scan is only an optional helper).
  const steps: Step[] = inec ? ['unit', 'figures', 'confirm'] : ['unit', 'photo', 'figures', 'confirm']
  const firstStep: Step = inec ? 'figures' : 'photo'

  const [units, setUnits] = useState<NodeSummary[]>([])
  const [unit, setUnit] = useState<NodeSummary | null>(null)
  const [step, setStep] = useState<Step>('unit')
  const [capture, setCapture] = useState<LiveCapture | null>(null) // agent: live camera
  const [scan, setScan] = useState<File | null>(null) // INEC: optional helper scan
  const [keepScan, setKeepScan] = useState(true)
  const [previous, setPrevious] = useState<ReportedFigures | null>(null)
  const [votes, setVotes] = useState<Record<string, string>>({})
  const [rejected, setRejected] = useState('')
  const [accredited, setAccredited] = useState('')
  const [autoFilled, setAutoFilled] = useState<Set<string>>(new Set())
  const [reading, setReading] = useState<{ busy: boolean; progress: number; result?: SheetReading; error?: string }>({ busy: false, progress: 0 })
  const [confirmTotal, setConfirmTotal] = useState('')
  const [reason, setReason] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [result, setResult] = useState<UnitCrossCheck | null>(null)
  const idem = useRef(idempotencyKey()) // stable across retries so a flaky network never double-submits

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
      setStep((s) => (s === 'unit' ? firstStep : s))
    }
  }, [units, nodeId, firstStep])

  // Already reported this unit? Then this is a correction of that result, never a competing v1.
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

  useEffect(() => () => void (capture && URL.revokeObjectURL(capture.previewUrl)), [capture])

  const candidates = useMemo(() => contest?.candidates ?? [], [contest])
  const valid = useMemo(() => candidates.reduce((s, c) => s + (Number(votes[c.party_code]) || 0), 0), [candidates, votes])
  const rej = Number(rejected) || 0
  const total = valid + rej
  const acc = accredited === '' ? null : Number(accredited)
  const figuresOk = candidates.every((c) => votes[c.party_code] !== undefined && votes[c.party_code] !== '') && rejected !== '' && (acc === null || total <= acc)

  if (!ctx || !election) return <Loading />
  if (!contest) return <div className="banner wait">This election has no contest configured yet.</div>

  /** Read a sheet photo on the device and fill every box we can read; the person still checks each one. */
  const autofill = async (image: Blob) => {
    setReading({ busy: true, progress: 0 })
    try {
      const r = await readSheet(image, candidates, (p) => setReading((s) => ({ ...s, progress: p })))
      const filled = new Set<string>()
      setVotes((v) => {
        const next = { ...v }
        for (const [code, n] of Object.entries(r.votes)) {
          next[code] = String(n)
          filled.add(code)
        }
        return next
      })
      if (r.rejected !== undefined) {
        setRejected(String(r.rejected))
        filled.add('rejected')
      }
      if (r.accredited !== undefined) {
        setAccredited(String(r.accredited))
        filled.add('accredited')
      }
      setAutoFilled(filled)
      setReading({ busy: false, progress: 1, result: r })
    } catch {
      setReading({ busy: false, progress: 0, error: 'Could not read the sheet. Type the figures instead.' })
    }
  }

  const onCapture = (c: LiveCapture) => {
    setCapture(c)
    autofill(c.file)
  }

  const onScan = async (f: File | undefined) => {
    if (!f) return
    const small = await compressImage(f)
    setScan(small)
    autofill(small)
  }

  const edit = (key: string, value: string, set: (v: string) => void) => {
    set(value.replace(/\D/g, ''))
    if (autoFilled.has(key)) setAutoFilled((s) => new Set([...s].filter((k) => k !== key)))
  }

  const upload = async (file: File, meta: Record<string, string>) => {
    const form = new FormData()
    form.append('file', file, file.name)
    for (const [k, v] of Object.entries(meta)) form.append(k, v)
    return (await api.upload<DocumentOut>(`/workspaces/${ctx.workspace.id}/documents`, form)).id
  }

  const submit = async () => {
    if (!unit) return
    setBusy(true)
    setError(null)
    try {
      let documentId: string | null = previous?.document_id ?? null
      if (capture) {
        const meta: Record<string, string> = { capture_source: 'camera', captured_at: capture.capturedAt }
        if (capture.latitude !== undefined) meta.latitude = String(capture.latitude)
        if (capture.longitude !== undefined) meta.longitude = String(capture.longitude)
        documentId = await upload(capture.file, meta)
      } else if (inec && scan && keepScan) {
        documentId = await upload(scan, { capture_source: 'file' })
      }
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
      const message = e instanceof Error ? e.message : 'Submission failed'
      setError(message)
      // A stale capture can only be fixed by retaking the photo.
      if (message.includes('not taken just now')) setCapture(null)
    } finally {
      setBusy(false)
    }
  }

  const at = steps.indexOf(step)
  const printedMismatch = reading.result?.total !== undefined && figuresOk && reading.result.total !== total

  return (
    <>
      <div className="page-head">
        <span className="faint small">{correctId ? (inec ? 'Correct INEC figure' : 'Correction') : inec ? 'INEC official result' : 'Form EC8A'}</span>
        <h1>{step === 'done' ? 'Submitted' : correctId ? 'Submit a correction' : inec ? 'Enter result' : 'Upload result'}</h1>
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

      {step === 'unit' && <UnitPicker units={units} onPick={(u) => (setUnit(u), setStep(firstStep))} />}

      {step === 'photo' && unit && (
        <section className="card stack">
          <div>
            <h2 style={{ fontSize: 17 }}>Photograph the result sheet</h2>
            <p className="muted small" style={{ margin: '4px 0 0' }}>
              Live camera only. The photo is stamped with your polling unit and the exact time, and must be sent within 10 minutes.
            </p>
          </div>
          {capture ? (
            <div className="photo">
              <img src={capture.previewUrl} alt="Captured result sheet" />
              <div className="cap">
                <span className="faint">
                  Taken {new Date(capture.capturedAt).toLocaleTimeString('en-NG', { timeStyle: 'medium' })} · {fmt.format(Math.round(capture.file.size / 1024))} KB
                </span>
                <button className="btn sm" style={{ minHeight: 30 }} onClick={() => setCapture(null)}>
                  <RefreshCw size={14} /> Retake
                </button>
              </div>
            </div>
          ) : previous ? (
            <>
              <div className="banner">
                <ImageUp size={16} />
                <span>Your earlier live photo stays with this correction. Take a new one only if the sheet changed.</span>
              </div>
              <LiveCamera unitCode={unit.code} unitName={unit.name} onCapture={onCapture} />
            </>
          ) : (
            <LiveCamera unitCode={unit.code} unitName={unit.name} onCapture={onCapture} />
          )}
          <ReadingStatus reading={reading} />
          <div className="sticky-actions">
            <button className="btn primary" disabled={!capture && !previous} onClick={() => setStep('figures')}>
              {autoFilled.size ? 'Check the figures' : 'Next: enter figures'} <ArrowRight size={18} />
            </button>
          </div>
        </section>
      )}

      {step === 'figures' && (
        <section className="card stack">
          {inec && (
            <div className="scan-helper">
              <div className="row" style={{ flexWrap: 'nowrap', alignItems: 'flex-start' }}>
                <ScanLine size={20} style={{ flex: 'none', marginTop: 2 }} />
                <div style={{ flex: 1, minWidth: 0 }}>
                  <b>Scan sheet to fill (optional)</b>
                  <div className="faint small">Snap or choose the EC8A and the boxes below fill themselves. Always check each figure.</div>
                </div>
                <label className="btn sm">
                  <Sparkles size={15} /> {scan ? 'Rescan' : 'Scan'}
                  <input type="file" accept="image/*" hidden onChange={(e) => onScan(e.target.files?.[0])} />
                </label>
              </div>
              {scan && (
                <label className="row small muted" style={{ gap: 8 }}>
                  <input type="checkbox" checked={keepScan} onChange={(e) => setKeepScan(e.target.checked)} style={{ accentColor: '#008751', width: 18, height: 18 }} />
                  Keep this scan with INEC’s result as supporting evidence
                </label>
              )}
              <ReadingStatus reading={reading} />
            </div>
          )}
          {!inec && <ReadingStatus reading={reading} />}
          <h2 style={{ fontSize: 17 }}>{inec ? 'Official figures' : 'Votes on the sheet'}</h2>
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
                  className={`input ${autoFilled.has(c.party_code) ? 'filled' : ''}`}
                  inputMode="numeric"
                  pattern="[0-9]*"
                  placeholder="0"
                  value={votes[c.party_code] ?? ''}
                  onChange={(e) => edit(c.party_code, e.target.value, (v) => setVotes({ ...votes, [c.party_code]: v }))}
                />
              </label>
            ))}
            <label className="vote-row">
              <span className="party">
                <b>Rejected ballots</b>
              </span>
              <input className={`input ${autoFilled.has('rejected') ? 'filled' : ''}`} inputMode="numeric" pattern="[0-9]*" placeholder="0" value={rejected} onChange={(e) => edit('rejected', e.target.value, setRejected)} />
            </label>
            <label className="vote-row">
              <span className="party">
                <b>Accredited voters</b>
                <span>Optional</span>
              </span>
              <input className={`input ${autoFilled.has('accredited') ? 'filled' : ''}`} inputMode="numeric" pattern="[0-9]*" placeholder="—" value={accredited} onChange={(e) => edit('accredited', e.target.value, setAccredited)} />
            </label>
          </div>
          {autoFilled.size > 0 && (
            <div className="banner wait">
              <Sparkles size={16} />
              <span>Highlighted boxes were read from the photo. Compare each one with the paper sheet; they turn plain once you edit them.</span>
            </div>
          )}
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
            {printedMismatch && <span style={{ color: 'var(--bad)' }}>The sheet’s printed total looks like {fmt.format(reading.result!.total!)}. Recheck the figures.</span>}
          </div>
          <div className="sticky-actions">
            {!inec && (
              <button className="btn" onClick={() => setStep('photo')} aria-label="Back">
                <ArrowLeft size={18} />
              </button>
            )}
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
          {!inec && !capture && !previous && (
            <button className="btn ghost" onClick={() => setStep('photo')}>
              Retake photo
            </button>
          )}
        </section>
      )}

      {step === 'done' && result && (
        <section className="card stack" style={{ textAlign: 'center', justifyItems: 'center' }}>
          <CheckCircle2 size={44} color="var(--green-600)" />
          <h2 style={{ fontSize: 20 }}>{capture || scan ? 'Saved and fingerprinted' : 'Saved'}</h2>
          <p className="muted" style={{ margin: 0 }}>
            {capture || (scan && keepScan) ? 'The sheet was hashed on upload, so any later change to the file is detectable.' : 'Every version of this result is kept in the audit trail.'}
          </p>
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

function ReadingStatus({ reading }: { reading: { busy: boolean; progress: number; result?: SheetReading; error?: string } }) {
  if (reading.busy)
    return (
      <div className="banner">
        <Spinner size={16} />
        <span>Reading the sheet… {Math.round(reading.progress * 100)}%</span>
      </div>
    )
  if (reading.error)
    return (
      <div className="banner wait">
        <Info size={16} />
        <span>{reading.error}</span>
      </div>
    )
  if (reading.result) {
    const n = Object.keys(reading.result.votes).length + (reading.result.rejected !== undefined ? 1 : 0)
    return (
      <div className={`banner ${n ? '' : 'wait'}`}>
        <Sparkles size={16} />
        <span>{n ? `Filled ${n} box${n === 1 ? '' : 'es'} from the photo. Check them on the next step.` : 'No figures could be read clearly. Type them on the next step.'}</span>
      </div>
    )
  }
  return null
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
