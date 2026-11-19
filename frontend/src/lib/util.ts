import type { Status } from './types'

/**
 * Shrink a result-sheet photo on the device before upload (weak field networks).
 * Keeps enough resolution to read handwriting; PDFs and small files pass through untouched.
 */
export async function compressImage(file: File, maxSide = 2000, quality = 0.85): Promise<File> {
  if (!file.type.startsWith('image/') || file.size < 600_000) return file
  try {
    const bitmap = await createImageBitmap(file)
    const scale = Math.min(1, maxSide / Math.max(bitmap.width, bitmap.height))
    const canvas = document.createElement('canvas')
    canvas.width = Math.round(bitmap.width * scale)
    canvas.height = Math.round(bitmap.height * scale)
    canvas.getContext('2d')!.drawImage(bitmap, 0, 0, canvas.width, canvas.height)
    bitmap.close()
    const blob = await new Promise<Blob | null>((r) => canvas.toBlob(r, 'image/jpeg', quality))
    if (!blob || blob.size >= file.size) return file
    return new File([blob], file.name.replace(/\.\w+$/, '') + '.jpg', { type: 'image/jpeg' })
  } catch {
    return file
  }
}

export const fmt = new Intl.NumberFormat('en-NG')

export const STATUS: Record<Status, { label: string; short: string; tone: 'ok' | 'bad' | 'wait' | 'none' }> = {
  match: { label: 'Matches INEC', short: 'Match', tone: 'ok' },
  mismatch: { label: 'Differs from INEC', short: 'Mismatch', tone: 'bad' },
  awaiting_inec: { label: 'Waiting for INEC', short: 'Awaiting INEC', tone: 'wait' },
  awaiting_party: { label: 'Waiting for party agents', short: 'Awaiting agents', tone: 'wait' },
  not_reported: { label: 'Not reported yet', short: 'Not reported', tone: 'none' },
}

/** INEC reads statuses from its own side of the comparison. */
export const INEC_STATUS: Record<Status, { label: string; short: string }> = {
  match: { label: 'Matches party agents', short: 'Match' },
  mismatch: { label: 'Party agents differ', short: 'Mismatch' },
  awaiting_inec: { label: 'Not uploaded by INEC', short: 'Upload due' },
  awaiting_party: { label: 'No party reports yet', short: 'No reports' },
  not_reported: { label: 'Not reported yet', short: 'Not reported' },
}

export function titleCase(s: string) {
  return s.toLowerCase().replace(/(^|[\s/(.-])([a-z])/g, (_, p, c) => p + c.toUpperCase())
}

export function timeAgo(iso: string) {
  const s = Math.max(1, Math.round((Date.now() - new Date(iso).getTime()) / 1000))
  if (s < 60) return `${s}s ago`
  if (s < 3600) return `${Math.round(s / 60)} min ago`
  if (s < 86400) return `${Math.round(s / 3600)} h ago`
  return new Date(iso).toLocaleDateString('en-NG', { day: 'numeric', month: 'short' })
}

export function inviteLink(token: string) {
  return `${window.location.origin}/join?token=${encodeURIComponent(token)}`
}

export const ROLE_LABEL: Record<string, string> = {
  party_admin: 'Administrator',
  pu_agent: 'Polling-unit agent',
  ward_agent: 'Ward agent',
  collation_officer: 'Collation officer',
  operations: 'Operations',
  legal_compliance: 'Legal & compliance',
}
