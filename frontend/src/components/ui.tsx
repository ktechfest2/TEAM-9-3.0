import { AlertTriangle, CheckCircle2, Clock, Loader2, MinusCircle, PencilLine, X, XCircle } from 'lucide-react'
import { useEffect, useState, type ReactNode } from 'react'
import logo from '../assets/logo-mark.png'
import type { ReportedFigures, Status } from '../lib/types'
import { fmt, INEC_STATUS, STATUS, timeAgo } from '../lib/util'
import { useApp } from '../state/app'

export function Logo({ size = 34 }: { size?: number }) {
  return <img src={logo} alt="" aria-hidden width={Math.round(size * 1.1)} height={size} style={{ objectFit: 'contain', flex: 'none' }} />
}

export function Spinner({ size = 18 }: { size?: number }) {
  return <Loader2 size={size} className="spin" aria-label="Loading" />
}

const ICON = { ok: CheckCircle2, bad: XCircle, wait: Clock, none: MinusCircle }

export function StatusChip({ status, long, inec }: { status: Status; long?: boolean; inec?: boolean }) {
  const s = STATUS[status]
  const words = inec ? INEC_STATUS[status] : s
  const Icon = ICON[s.tone]
  return (
    <span className={`chip ${s.tone}`}>
      <Icon size={14} strokeWidth={2.4} />
      {long ? words.label : words.short}
    </span>
  )
}

/** INEC's view: every party agent's figures beside INEC's in one table. */
export function MultiFiguresTable({ parties, inec, reports }: { parties: string[]; inec: ReportedFigures | null; reports: { code: string; result: ReportedFigures | null }[] }) {
  const rows: { key: string; label: string; get: (f: ReportedFigures) => number; total?: boolean }[] = [
    ...parties.map((p) => ({ key: p, label: p, get: (f: ReportedFigures) => f.votes[p] ?? 0 })),
    { key: 'valid', label: 'Valid votes', get: (f: ReportedFigures) => f.totals.valid_votes, total: true },
    { key: 'rej', label: 'Rejected', get: (f: ReportedFigures) => f.totals.rejected_ballots },
    { key: 'cast', label: 'Total cast', get: (f: ReportedFigures) => f.totals.total_votes_cast, total: true },
  ]
  return (
    <table className="figs num">
      <thead>
        <tr>
          <th />
          {reports.map((r) => (
            <th key={r.code}>{r.code} agent</th>
          ))}
          <th style={{ color: 'var(--ink)' }}>INEC</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((row) => {
          const iv = inec ? row.get(inec) : undefined
          const differs = iv !== undefined && reports.some((r) => r.result && row.get(r.result) !== iv)
          return (
            <tr key={row.key} className={`${differs ? 'diff' : ''} ${row.total ? 'total' : ''}`}>
              <td>{row.label}</td>
              {reports.map((r) => (
                <td key={r.code}>{r.result ? fmt.format(row.get(r.result)) : '—'}</td>
              ))}
              <td style={differs ? { color: 'var(--bad)', fontWeight: 750 } : { fontWeight: 650 }}>{iv === undefined ? '—' : fmt.format(iv)}</td>
            </tr>
          )
        })}
      </tbody>
    </table>
  )
}

export function Sheet({ title, onClose, children }: { title: string; onClose: () => void; children: ReactNode }) {
  useEffect(() => {
    const k = (e: KeyboardEvent) => e.key === 'Escape' && onClose()
    window.addEventListener('keydown', k)
    document.body.style.overflow = 'hidden'
    return () => {
      window.removeEventListener('keydown', k)
      document.body.style.overflow = ''
    }
  }, [onClose])
  return (
    <div className="overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="sheet" role="dialog" aria-modal="true" aria-label={title}>
        <div className="grab" />
        <div className="spread" style={{ marginBottom: 14 }}>
          <h2 style={{ fontSize: 18 }}>{title}</h2>
          <button className="btn ghost icon" onClick={onClose} aria-label="Close">
            <X size={20} />
          </button>
        </div>
        {children}
      </div>
    </div>
  )
}

export function Toasts() {
  const { toasts } = useApp()
  return (
    <div className="toasts" aria-live="polite">
      {toasts.map((t) => (
        <div key={t.id} className={`toast ${t.tone}`}>
          {t.tone === 'error' ? <AlertTriangle size={18} /> : <CheckCircle2 size={18} />}
          <span>{t.text}</span>
        </div>
      ))}
    </div>
  )
}

export function Empty({ icon, title, children }: { icon?: ReactNode; title: string; children?: ReactNode }) {
  return (
    <div className="empty">
      {icon}
      <strong style={{ color: 'var(--ink)' }}>{title}</strong>
      {children && <div style={{ maxWidth: 420 }}>{children}</div>}
    </div>
  )
}

export function Loading({ text = 'Loading…' }: { text?: string }) {
  return (
    <div className="empty" style={{ minHeight: '40vh', alignContent: 'center' }}>
      <Spinner size={24} />
      <span>{text}</span>
    </div>
  )
}

/** Party (or agent) figures beside INEC's, with differing rows highlighted. */
export function FiguresTable({
  parties,
  left,
  right,
  leftLabel,
  rightLabel = 'INEC',
}: {
  parties: string[]
  left: ReportedFigures | null
  right: ReportedFigures | null
  leftLabel: string
  rightLabel?: string
}) {
  const rows: { key: string; label: string; l?: number; r?: number; total?: boolean }[] = [
    ...parties.map((p) => ({ key: p, label: p, l: left?.votes[p], r: right?.votes[p] })),
    { key: 'valid', label: 'Valid votes', l: left?.totals.valid_votes, r: right?.totals.valid_votes, total: true },
    { key: 'rej', label: 'Rejected', l: left?.totals.rejected_ballots, r: right?.totals.rejected_ballots },
    { key: 'cast', label: 'Total cast', l: left?.totals.total_votes_cast, r: right?.totals.total_votes_cast, total: true },
  ]
  return (
    <table className="figs num">
      <thead>
        <tr>
          <th />
          <th>{leftLabel}</th>
          <th>{rightLabel}</th>
          <th>Diff.</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((r) => {
          const both = r.l !== undefined && r.r !== undefined
          const delta = both ? r.r! - r.l! : null
          return (
            <tr key={r.key} className={`${delta ? 'diff' : ''} ${r.total ? 'total' : ''}`}>
              <td>{r.label}</td>
              <td>{r.l === undefined ? '—' : fmt.format(r.l)}</td>
              <td>{r.r === undefined ? '—' : fmt.format(r.r)}</td>
              <td>{delta ? `${delta > 0 ? '+' : ''}${fmt.format(delta)}` : both ? '0' : '—'}</td>
            </tr>
          )
        })}
      </tbody>
    </table>
  )
}

/** Result-sheet image behind a short-lived signed link. */
export function Evidence({ title, figures }: { title: string; figures: ReportedFigures | null }) {
  const [failed, setFailed] = useState(false)
  if (!figures) {
    return (
      <div className="photo">
        <div className="empty" style={{ minHeight: 160 }}>
          <MinusCircle size={20} />
          <span className="small">{title}: no result sheet yet</span>
        </div>
      </div>
    )
  }
  if (!figures.document_id) {
    return (
      <div className="photo">
        <div className="empty" style={{ minHeight: 160 }}>
          <PencilLine size={20} />
          <span className="small">
            {title}: figures typed directly · v{figures.version} · {timeAgo(figures.submitted_at)}
          </span>
        </div>
      </div>
    )
  }
  return (
    <figure className="photo" style={{ margin: 0 }}>
      {figures.document_url && !failed ? (
        <a href={figures.document_url} target="_blank" rel="noreferrer">
          <img src={figures.document_url} alt={`${title} result sheet`} loading="lazy" onError={() => setFailed(true)} />
        </a>
      ) : (
        <div className="empty" style={{ minHeight: 160 }}>
          <span className="small">Sheet image unavailable</span>
        </div>
      )}
      <figcaption className="cap">
        <b>{title}</b>
        <span className="faint">
          v{figures.version} · {timeAgo(figures.submitted_at)}
        </span>
      </figcaption>
    </figure>
  )
}
