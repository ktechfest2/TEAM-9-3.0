import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { api, auth, session } from '../lib/api'
import type { BallotElection, User, Workspace, WorkspaceContext } from '../lib/types'

interface Toast {
  id: number
  text: string
  tone: 'ok' | 'error'
}

interface AppState {
  booting: boolean
  user: User | null
  workspaces: Workspace[]
  reloadUser: () => Promise<void>
  signOut: () => Promise<void>
  toast: (text: string, tone?: Toast['tone']) => void
  toasts: Toast[]
}

const Ctx = createContext<AppState | null>(null)

export function AppProvider({ children }: { children: ReactNode }) {
  const [booting, setBooting] = useState(true)
  const [user, setUser] = useState<User | null>(null)
  const [workspaces, setWorkspaces] = useState<Workspace[]>([])
  const [toasts, setToasts] = useState<Toast[]>([])
  const seq = useRef(0)

  const toast = useCallback((text: string, tone: Toast['tone'] = 'ok') => {
    const id = ++seq.current
    setToasts((t) => [...t, { id, text, tone }])
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), 4000)
  }, [])

  const reloadUser = useCallback(async () => {
    if (!session.signedIn) {
      setUser(null)
      setWorkspaces([])
      setBooting(false)
      return
    }
    try {
      const [me, ws] = await Promise.all([auth.me(), api.get<Workspace[]>('/workspaces')])
      setUser(me)
      setWorkspaces(ws)
    } catch {
      setUser(null)
    } finally {
      setBooting(false)
    }
  }, [])

  useEffect(() => {
    reloadUser()
    return session.onChange(() => {
      if (!session.signedIn) {
        setUser(null)
        setWorkspaces([])
      }
    })
  }, [reloadUser])

  const signOut = useCallback(async () => {
    await auth.logout()
    setUser(null)
    setWorkspaces([])
  }, [])

  return <Ctx.Provider value={{ booting, user, workspaces, reloadUser, signOut, toast, toasts }}>{children}</Ctx.Provider>
}

export function useApp() {
  const v = useContext(Ctx)
  if (!v) throw new Error('useApp outside AppProvider')
  return v
}

/* ---------------------------------------------------------------- workspace context */

interface WsState {
  ctx: WorkspaceContext | null
  error: string | null
  election: BallotElection | null
  reload: () => Promise<void>
}

const WsCtx = createContext<WsState | null>(null)

export function WorkspaceProvider({ id, children }: { id: string; children: ReactNode }) {
  const [ctx, setCtx] = useState<WorkspaceContext | null>(null)
  const [error, setError] = useState<string | null>(null)

  const reload = useCallback(async () => {
    try {
      setCtx(await api.get<WorkspaceContext>(`/workspaces/${id}/context`))
      setError(null)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not load this account')
    }
  }, [id])

  useEffect(() => {
    setCtx(null)
    reload()
  }, [reload])

  // The election in play: the first active one, else the most recent.
  const election = useMemo(() => ctx?.elections.find((e) => e.status === 'active') ?? ctx?.elections[0] ?? null, [ctx])

  return <WsCtx.Provider value={{ ctx, error, election, reload }}>{children}</WsCtx.Provider>
}

export function useWorkspace() {
  const v = useContext(WsCtx)
  if (!v) throw new Error('useWorkspace outside WorkspaceProvider')
  return v
}

export function lastWorkspaceKey() {
  return 'tallytrail.workspace'
}
