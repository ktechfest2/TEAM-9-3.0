import type { ReactNode } from 'react'
import { BrowserRouter, Navigate, Outlet, Route, Routes, useParams } from 'react-router-dom'
import { WorkspaceFrame } from './components/Shell'
import { Loading } from './components/ui'
import { Accounts, Me } from './pages/Accounts'
import Agents from './pages/Agents'
import { Join, Login } from './pages/Auth'
import Home from './pages/Home'
import Setup from './pages/Setup'
import Submit from './pages/Submit'
import UnitDetail from './pages/UnitDetail'
import { AppProvider, lastWorkspaceKey, useApp, WorkspaceProvider, useWorkspace } from './state/app'

function RequireAuth({ children }: { children: ReactNode }) {
  const { booting, user } = useApp()
  if (booting) return <Loading text="Starting TallyTrail…" />
  if (!user) return <Navigate to="/login" replace />
  return <>{children}</>
}

/** Send each person to the right place: platform admin → accounts, everyone else → their account. */
function Root() {
  const { user, workspaces } = useApp()
  if (user?.is_platform_admin) return <Navigate to="/accounts" replace />
  let last: string | null = null
  try {
    last = localStorage.getItem(lastWorkspaceKey())
  } catch {
    /* ignore */
  }
  const target = workspaces.find((w) => w.id === last) ?? workspaces[0]
  if (!target) return <Navigate to="/me" replace />
  return <Navigate to={`/w/${target.id}`} replace />
}

function WorkspaceLayout() {
  const { wid } = useParams()
  try {
    if (wid) localStorage.setItem(lastWorkspaceKey(), wid)
  } catch {
    /* ignore */
  }
  return (
    <WorkspaceProvider id={wid!}>
      <WorkspaceGate />
    </WorkspaceProvider>
  )
}

function WorkspaceGate() {
  const { ctx, error } = useWorkspace()
  if (error)
    return (
      <div className="content">
        <div className="banner bad">{error}</div>
        <a className="btn" href="/">
          Back
        </a>
      </div>
    )
  if (!ctx) return <Loading text="Loading your account…" />
  return (
    <WorkspaceFrame>
      <Outlet />
    </WorkspaceFrame>
  )
}

function AdminOnly({ children }: { children: ReactNode }) {
  const { ctx } = useWorkspace()
  if (ctx && ctx.role !== 'party_admin') return <Navigate to={`/w/${ctx.workspace.id}`} replace />
  return <>{children}</>
}

export default function App() {
  return (
    <BrowserRouter>
      <AppProvider>
        <Routes>
          <Route path="/login" element={<LoginGate />} />
          <Route path="/join" element={<Join />} />
          <Route path="/" element={<RequireAuth><Root /></RequireAuth>} />
          <Route path="/accounts" element={<RequireAuth><Accounts /></RequireAuth>} />
          <Route path="/me" element={<RequireAuth><Me /></RequireAuth>} />
          <Route path="/w/:wid" element={<RequireAuth><WorkspaceLayout /></RequireAuth>}>
            <Route index element={<Home />} />
            <Route path="units/:nodeId" element={<UnitDetail />} />
            <Route path="submit" element={<Submit />} />
            <Route path="submit/:nodeId" element={<Submit />} />
            <Route path="agents" element={<AdminOnly><Agents /></AdminOnly>} />
            <Route path="setup" element={<AdminOnly><Setup /></AdminOnly>} />
          </Route>
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </AppProvider>
    </BrowserRouter>
  )
}

function LoginGate() {
  const { booting, user } = useApp()
  if (booting) return <Loading />
  if (user) return <Navigate to="/" replace />
  return <Login />
}
