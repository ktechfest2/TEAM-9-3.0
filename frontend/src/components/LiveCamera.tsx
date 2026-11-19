import { Camera, CameraOff, RefreshCw } from 'lucide-react'
import { useCallback, useEffect, useRef, useState } from 'react'

export interface LiveCapture {
  file: File
  previewUrl: string
  capturedAt: string // ISO, sent to the server, which rejects stale captures
  latitude?: number
  longitude?: number
}

/**
 * In-app camera viewfinder. There is deliberately no gallery / file picker: agents can only
 * submit a photo taken here and now. Each frame is stamped with unit, time and "live camera".
 */
export default function LiveCamera({ unitCode, unitName, onCapture }: { unitCode: string; unitName: string; onCapture: (c: LiveCapture) => void }) {
  const video = useRef<HTMLVideoElement>(null)
  const stream = useRef<MediaStream | null>(null)
  const geo = useRef<{ latitude: number; longitude: number } | null>(null)
  const [ready, setReady] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [flash, setFlash] = useState(false)

  const stop = useCallback(() => {
    stream.current?.getTracks().forEach((t) => t.stop())
    stream.current = null
  }, [])

  const start = useCallback(async () => {
    setError(null)
    setReady(false)
    if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia) {
      setError('The camera needs a secure (https) connection. Open TallyTrail through its https address.')
      return
    }
    try {
      stop()
      stream.current = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: { ideal: 'environment' }, width: { ideal: 1920 }, height: { ideal: 1440 } },
        audio: false,
      })
      if (video.current) {
        video.current.srcObject = stream.current
        await video.current.play().catch(() => undefined)
      }
      setReady(true)
    } catch (e) {
      const name = e instanceof DOMException ? e.name : ''
      setError(
        name === 'NotAllowedError'
          ? 'Camera access was blocked. Allow camera access for TallyTrail in your browser settings, then try again.'
          : name === 'NotFoundError'
            ? 'No camera was found on this device.'
            : 'The camera could not start. Close other apps using it and try again.',
      )
    }
  }, [stop])

  useEffect(() => {
    start()
    // Location is optional context for the stamp; never blocks the capture.
    navigator.geolocation?.getCurrentPosition(
      (p) => (geo.current = { latitude: +p.coords.latitude.toFixed(5), longitude: +p.coords.longitude.toFixed(5) }),
      () => undefined,
      { enableHighAccuracy: true, timeout: 8000, maximumAge: 60_000 },
    )
    return stop
  }, [start, stop])

  const shoot = async () => {
    const v = video.current
    if (!v || !v.videoWidth) return
    const capturedAt = new Date()
    const scale = Math.min(1, 1800 / Math.max(v.videoWidth, v.videoHeight))
    const w = Math.round(v.videoWidth * scale)
    const h = Math.round(v.videoHeight * scale)
    const canvas = document.createElement('canvas')
    canvas.width = w
    canvas.height = h
    const g = canvas.getContext('2d')!
    g.drawImage(v, 0, 0, w, h)

    // Burn the provenance stamp into the pixels.
    const bar = Math.max(56, Math.round(h * 0.075))
    g.fillStyle = 'rgba(10,15,12,0.82)'
    g.fillRect(0, h - bar, w, bar)
    g.fillStyle = '#1f9d63'
    g.fillRect(0, h - bar, Math.round(w * 0.012), bar)
    const big = Math.round(bar * 0.34)
    const small = Math.round(bar * 0.26)
    const when = capturedAt.toLocaleString('en-NG', { timeZone: 'Africa/Lagos', dateStyle: 'medium', timeStyle: 'medium' })
    g.fillStyle = '#ffffff'
    g.font = `700 ${big}px Inter, system-ui, sans-serif`
    g.fillText(`TallyTrail live camera · PU ${unitCode}`, Math.round(w * 0.03), h - bar + Math.round(bar * 0.43))
    g.fillStyle = '#cfdad4'
    g.font = `500 ${small}px Inter, system-ui, sans-serif`
    const where = geo.current ? ` · ${geo.current.latitude}, ${geo.current.longitude}` : ''
    g.fillText(`${when} WAT${where}`, Math.round(w * 0.03), h - bar + Math.round(bar * 0.8))

    setFlash(true)
    setTimeout(() => setFlash(false), 160)
    const blob = await new Promise<Blob | null>((r) => canvas.toBlob(r, 'image/jpeg', 0.88))
    if (!blob) return
    stop()
    const stampName = capturedAt.toISOString().replace(/[:.]/g, '-')
    const file = new File([blob], `EC8A-live-${unitCode.replace(/\//g, '-')}-${stampName}.jpg`, { type: 'image/jpeg', lastModified: capturedAt.getTime() })
    onCapture({ file, previewUrl: URL.createObjectURL(blob), capturedAt: capturedAt.toISOString(), ...(geo.current ?? {}) })
  }

  if (error)
    return (
      <div className="camera-box">
        <div className="empty" style={{ color: '#e7eeea', minHeight: 260, alignContent: 'center' }}>
          <CameraOff size={30} />
          <span>{error}</span>
          <button className="btn sm" onClick={start}>
            <RefreshCw size={15} /> Try again
          </button>
        </div>
      </div>
    )

  return (
    <div className="camera-box">
      <video ref={video} playsInline muted autoPlay aria-label={`Camera viewfinder for ${unitName}`} />
      <div className="camera-guide" aria-hidden>
        <i />
        <i />
        <i />
        <i />
      </div>
      {flash && <div className="camera-flash" aria-hidden />}
      <div className="camera-bar">
        <span className="tiny" style={{ color: '#cfdad4' }}>
          Fit the whole sheet inside the frame
        </span>
        <button className="shutter" onClick={shoot} disabled={!ready} aria-label="Take photo">
          <Camera size={26} />
        </button>
      </div>
    </div>
  )
}
