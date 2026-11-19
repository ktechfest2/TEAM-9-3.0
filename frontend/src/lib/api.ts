import type { User } from './types'

const BASE = (import.meta.env.VITE_API_BASE as string | undefined) ?? '/api/v1'
const KEY = 'tallytrail.session'

export class ApiError extends Error {
  status: number
  code: string
  constructor(status: number, code: string, message: string) {
    super(message)
    this.status = status
    this.code = code
  }
}

interface Tokens {
  access_token: string
  refresh_token: string
}

let tokens: Tokens | null = read()
let refreshing: Promise<boolean> | null = null
const listeners = new Set<() => void>()

function read(): Tokens | null {
  try {
    const raw = localStorage.getItem(KEY)
    return raw ? (JSON.parse(raw) as Tokens) : null
  } catch {
    return null
  }
}

function write(next: Tokens | null) {
  tokens = next
  try {
    if (next) localStorage.setItem(KEY, JSON.stringify(next))
    else localStorage.removeItem(KEY)
  } catch {
    /* storage unavailable: keep the session in memory */
  }
  listeners.forEach((fn) => fn())
}

export const session = {
  get signedIn() {
    return !!tokens
  },
  onChange(fn: () => void) {
    listeners.add(fn)
    return () => {
      listeners.delete(fn)
    }
  },
  clear() {
    write(null)
  },
}

async function refresh(): Promise<boolean> {
  if (!tokens) return false
  refreshing ??= (async () => {
    try {
      const res = await fetch(`${BASE}/auth/refresh`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ refresh_token: tokens!.refresh_token }),
      })
      if (!res.ok) throw new Error('refresh failed')
      const body = await res.json()
      write({ access_token: body.access_token, refresh_token: body.refresh_token })
      return true
    } catch {
      write(null)
      return false
    } finally {
      refreshing = null
    }
  })()
  return refreshing
}

async function request<T>(path: string, init: RequestInit = {}, retry = true): Promise<T> {
  const headers = new Headers(init.headers)
  if (init.body && !(init.body instanceof FormData) && !headers.has('Content-Type')) headers.set('Content-Type', 'application/json')
  if (tokens) headers.set('Authorization', `Bearer ${tokens.access_token}`)
  let res: Response
  try {
    res = await fetch(`${BASE}${path}`, { ...init, headers })
  } catch {
    throw new ApiError(0, 'network', 'No connection. Check your network and try again.')
  }
  if (res.status === 401 && retry && tokens && (await refresh())) return request<T>(path, init, false)
  if (!res.ok) {
    let body: { error?: { code?: string; message?: string } } | null = null
    try {
      body = await res.json()
    } catch {
      /* non-JSON */
    }
    throw new ApiError(res.status, body?.error?.code ?? 'http_error', friendly(body?.error?.message, res.status))
  }
  if (res.status === 204) return undefined as T
  return res.json() as Promise<T>
}

function friendly(message: string | undefined, status: number) {
  if (message) return message
  if (status >= 500) return 'Something went wrong on the server. Try again shortly.'
  return `Request failed (${status})`
}

export const api = {
  get: <T>(path: string) => request<T>(path),
  post: <T>(path: string, body?: unknown, headers?: Record<string, string>) =>
    request<T>(path, { method: 'POST', body: body === undefined ? undefined : JSON.stringify(body), headers }),
  put: <T>(path: string, body: unknown) => request<T>(path, { method: 'PUT', body: JSON.stringify(body) }),
  upload: <T>(path: string, form: FormData) => request<T>(path, { method: 'POST', body: form }),
}

export type LoginResult = { status: 'authenticated' } | { status: 'mfa_required'; challenge: string }

export const auth = {
  async login(email: string, password: string): Promise<LoginResult> {
    const body = await request<{ status: string; access_token?: string; refresh_token?: string; challenge_token?: string }>(
      '/auth/login',
      { method: 'POST', body: JSON.stringify({ email, password }) },
      false,
    )
    if (body.status === 'mfa_required' && body.challenge_token) return { status: 'mfa_required', challenge: body.challenge_token }
    write({ access_token: body.access_token!, refresh_token: body.refresh_token! })
    return { status: 'authenticated' }
  },
  async mfa(challenge: string, code: string) {
    const body = await request<Tokens>('/auth/mfa/challenge', { method: 'POST', body: JSON.stringify({ challenge_token: challenge, code }) }, false)
    write({ access_token: body.access_token, refresh_token: body.refresh_token })
  },
  me: () => api.get<User>('/auth/me'),
  async logout() {
    const t = tokens
    write(null)
    if (t) {
      try {
        await request('/auth/logout', { method: 'POST', body: JSON.stringify({ refresh_token: t.refresh_token }) }, false)
      } catch {
        /* already signed out locally */
      }
    }
  },
  accept: (token: string, full_name: string, password: string) =>
    request<User>('/auth/invitations/accept', { method: 'POST', body: JSON.stringify({ token, full_name, password }) }, false),
}

export function idempotencyKey() {
  return `tt-${crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}`}`
}
