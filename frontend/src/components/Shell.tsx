import { Building2, Camera, Home, LogOut, PencilLine, Settings, UserRound, Users } from 'lucide-react'
import type { ReactNode } from 'react'
import { NavLink } from 'react-router-dom'
import { useApp, useWorkspace } from '../state/app'
import { Logo, Toasts } from './ui'

interface Item {
  to: string
  label: string
  icon: typeof Home
  end?: boolean
}

export function navFor(base: string, kind: string, role: string, platform: boolean): Item[] {
  const items: Item[] = [{ to: base, label: 'Home', icon: Home, end: true }]
  if (role === 'pu_agent') items.push({ to: `${base}/submit`, label: 'Camera', icon: Camera })
  if (kind === 'inec' && role === 'party_admin') items.push({ to: `${base}/submit`, label: 'Enter result', icon: PencilLine })
  if (kind === 'party' && role === 'party_admin') items.push({ to: `${base}/agents`, label: 'Agents', icon: Users })
  if (role === 'party_admin') items.push({ to: `${base}/setup`, label: 'Setup', icon: Settings })
  if (platform) items.push({ to: '/accounts', label: 'Accounts', icon: Building2 })
  items.push({ to: '/me', label: 'Me', icon: UserRound })
  return items
}

export function Frame({ items, title, subtitle, children }: { items: Item[]; title: string; subtitle?: string; children: ReactNode }) {
  const { user, signOut } = useApp()
  return (
    <div className="app">
      <aside className="side" aria-label="Primary">
        <div className="brand">
          <Logo size={34} />
          <div>
            <b>TallyTrail</b>
            <span>Every total traceable</span>
          </div>
        </div>
        {items.map((i) => (
          <NavLink key={i.to} to={i.to} end={i.end} className={({ isActive }) => (isActive ? 'active' : '')}>
            <i.icon size={18} strokeWidth={2} />
            {i.label}
          </NavLink>
        ))}
        <div className="foot">
          <div style={{ color: '#e9efec', fontWeight: 600, fontSize: 13 }}>{user?.full_name}</div>
          <div style={{ marginBottom: 10 }}>{user?.email}</div>
          <button className="btn sm block" style={{ background: 'transparent', color: '#c9d4ce', borderColor: 'rgba(255,255,255,.14)' }} onClick={signOut}>
            <LogOut size={15} /> Sign out
          </button>
        </div>
      </aside>
      <div className="main">
        <header className="appbar">
          <span className="brand-sm">
            <Logo size={30} />
          </span>
          <div className="who">
            <b>{title}</b>
            {subtitle && <span>{subtitle}</span>}
          </div>
        </header>
        <main className="content">{children}</main>
      </div>
      <nav className="tabs" aria-label="Primary">
        {items.map((i) => (
          <NavLink key={i.to} to={i.to} end={i.end} className={({ isActive }) => `tab ${isActive ? 'active' : ''}`}>
            <i.icon size={21} strokeWidth={2} />
            {i.label}
          </NavLink>
        ))}
      </nav>
      <Toasts />
    </div>
  )
}

/** Frame for pages inside one account (party or INEC). */
export function WorkspaceFrame({ children }: { children: ReactNode }) {
  const { user } = useApp()
  const { ctx } = useWorkspace()
  if (!ctx) return <>{children}</>
  const base = `/w/${ctx.workspace.id}`
  const subtitle =
    ctx.workspace.kind === 'inec'
      ? 'INEC results desk'
      : ctx.role === 'pu_agent'
        ? `${ctx.workspace.party_code} agent`
        : `${ctx.workspace.party_code} · party account`
  return (
    <Frame items={navFor(base, ctx.workspace.kind, ctx.role, !!user?.is_platform_admin)} title={ctx.workspace.name} subtitle={subtitle}>
      {children}
    </Frame>
  )
}
