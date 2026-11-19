import { ArrowLeft, Camera, FileCheck2, Info, PencilLine, Scale } from 'lucide-react'
import { useCallback, useEffect, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { Evidence, FiguresTable, Loading, MultiFiguresTable, StatusChip } from '../components/ui'
import { api } from '../lib/api'
import type { UnitCrossCheck } from '../lib/types'
import { fmt, timeAgo, titleCase } from '../lib/util'
import { useWorkspace } from '../state/app'

export default function UnitDetail() {
  const { nodeId } = useParams()
  const { ctx, election } = useWorkspace()
  const [unit, setUnit] = useState<UnitCrossCheck | null>(null)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async () => {
    if (!ctx || !election || !nodeId) return
    try {
      setUnit(await api.get<UnitCrossCheck>(`/workspaces/${ctx.workspace.id}/crosscheck/units/${nodeId}?election_id=${election.id}`))
      setError(null)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not load this polling unit')
    }
  }, [ctx, election, nodeId])

  useEffect(() => {
    load()
  }, [load])

  if (error) return <div className="banner bad">{error}</div>
  if (!ctx || !unit) return <Loading />

  const inecView = ctx.workspace.kind === 'inec'
  const wid = ctx.workspace.id
  const parties = election?.contests[0]?.candidates.map((c) => c.party_code) ?? []
  const own = unit.reports[0]
  const canCorrect = inecView && ctx.can_submit_anywhere

  return (
    <>
      <Link to={`/w/${wid}`} className="btn ghost sm" style={{ justifySelf: 'start', marginLeft: -10 }}>
        <ArrowLeft size={16} /> All polling units
      </Link>
      <div className="page-head">
        <div className="spread" style={{ alignItems: 'flex-start' }}>
          <h1 style={{ fontSize: 'clamp(20px, 5vw, 26px)' }}>{titleCase(unit.node.name)}</h1>
          <StatusChip status={unit.status} long inec={inecView} />
        </div>
        <span className="faint small">
          <span className="mono">{unit.node.code}</span> · {unit.node.path.map(titleCase).join(' · ')}
        </span>
      </div>

      {unit.status === 'mismatch' && (
        <div className="banner bad">
          <Scale size={16} />
          <span>
            {inecView
              ? 'Party agents’ result sheets differ from INEC’s upload for this unit. Compare the sheets and confirm the correct figure.'
              : 'INEC’s upload differs from your agent’s result sheet. Both sheets are preserved below for review.'}
          </span>
        </div>
      )}
      {unit.inec?.correction_reason && (
        <div className="banner">
          <FileCheck2 size={16} />
          <span>
            INEC corrected this unit (version {unit.inec.version}, {timeAgo(unit.inec.submitted_at)}): “{unit.inec.correction_reason}”. Earlier versions are kept in the audit trail.
          </span>
        </div>
      )}

      {inecView ? (
        <>
          <section className="card">
            <div className="card-title">
              <h2>Figures</h2>
              {canCorrect &&
                (unit.inec ? (
                  <Link className="btn sm dark" to={`/w/${wid}/submit/${unit.node.id}?correct=${unit.inec.submission_id}`}>
                    <PencilLine size={15} /> Correct INEC figure
                  </Link>
                ) : (
                  <Link className="btn sm primary" to={`/w/${wid}/submit/${unit.node.id}`}>
                    <Camera size={15} /> Upload INEC result
                  </Link>
                ))}
            </div>
            {unit.reports.length === 0 && <div className="banner wait" style={{ marginBottom: 12 }}>No party agent has reported this unit yet.</div>}
            <div style={{ overflowX: 'auto' }}>
              <MultiFiguresTable parties={parties} inec={unit.inec} reports={unit.reports.map((r) => ({ code: r.party_code, result: r.result }))} />
            </div>
            <div className="row" style={{ gap: 6, marginTop: 12 }}>
              {unit.reports.map((r) => (
                <span key={r.workspace_id} className="row" style={{ gap: 6 }}>
                  <span className="small muted">{r.party_name}</span>
                  <StatusChip status={r.status} inec />
                </span>
              ))}
            </div>
          </section>
          <div className="sheets">
            <Evidence title="INEC sheet" figures={unit.inec} />
            {unit.reports.map((r) => (
              <Evidence key={r.workspace_id} title={`${r.party_code} agent sheet`} figures={r.result} />
            ))}
          </div>
        </>
      ) : (
        <>
          <section className="card">
            <div className="card-title">
              <h2>Figures</h2>
              {own?.result && <span className="faint small">Agent v{own.result.version}</span>}
            </div>
            <div style={{ overflowX: 'auto' }}>
              <FiguresTable parties={parties} left={own?.result ?? null} right={unit.inec} leftLabel={ctx.role === 'pu_agent' ? 'You' : 'Agent'} />
            </div>
            {own?.differences.some((d) => d.field.startsWith('party:')) && (
              <p className="small muted" style={{ margin: '12px 0 0' }}>
                Largest difference:{' '}
                {own.differences
                  .filter((d) => d.field.startsWith('party:'))
                  .sort((a, b) => Math.abs(b.delta ?? 0) - Math.abs(a.delta ?? 0))
                  .slice(0, 1)
                  .map((d) => (
                    <b key={d.field}>
                      {d.label} {d.delta! > 0 ? '+' : ''}
                      {fmt.format(d.delta ?? 0)} on INEC’s upload
                    </b>
                  ))}
              </p>
            )}
          </section>
          <div className="grid-2">
            <Evidence title={ctx.role === 'pu_agent' ? 'Your sheet' : 'Agent sheet'} figures={own?.result ?? null} />
            <Evidence title="INEC sheet" figures={unit.inec} />
          </div>
          {ctx.role === 'pu_agent' && own?.result && (
            <Link className="btn block" to={`/w/${wid}/submit/${unit.node.id}?correct=${own.result.submission_id}`}>
              <PencilLine size={17} /> Submit a correction
            </Link>
          )}
        </>
      )}

      <p className="faint tiny" style={{ display: 'flex', gap: 6, margin: 0 }}>
        <Info size={14} style={{ flex: 'none', marginTop: 2 }} />
        TallyTrail flags numerical differences for review. It does not declare results or determine wrongdoing. Sheet links expire after an hour.
      </p>
    </>
  )
}
