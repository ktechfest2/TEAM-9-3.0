# TallyTrail frontend

Mobile-first web app for TallyTrail: party agents upload polling-unit result sheets, INEC uploads its own,
and every difference is flagged unit by unit.

Stack: Vite + React 19 + TypeScript, plain CSS (INEC green / ink / white, Inter + JetBrains Mono).
No UI framework, ~100 KB gzipped for weak field networks.

## Run

```bash
npm install
npm run dev            # http://localhost:3000, /api proxied to the API on 127.0.0.1:8000
npm run dev:phone      # HTTPS on the LAN: phones only allow the live camera on secure origins
```

Point at another API with `TALLYTRAIL_API=http://host:8000 npm run dev`, or set `VITE_API_BASE` at build time.

## Who sees what

| Role | Screens |
| --- | --- |
| Platform admin | **Accounts**: create the single INEC account and one account per party, invite each administrator |
| Party admin | **Home** (agents reported, mismatches vs INEC, awaiting INEC), **Agents** (add agent → must pick a polling unit → share invite via WhatsApp/copy), unit detail, **Setup** |
| Polling-unit agent | **Your polling unit** → **Camera**: live in-app camera only (no gallery/file upload) → figures auto-filled from the photo → check → double-entry total → submit; see whether INEC matches; corrections |
| INEC | **Results desk** (every unit, every party's report), **Enter result** for any unit by typing (optional *Scan sheet to fill*), unit detail with all parties' figures beside INEC's → **Correct INEC figure** (reason required, original kept) |

## Evidence rules

- Agents can only photograph the sheet with the in-app camera (`getUserMedia` viewfinder; no file input exists).
  Each capture is stamped into the pixels with the polling-unit code, date/time (WAT) and optional location,
  and the API rejects agent photos that are not live captures or are older than 10 minutes.
- INEC types figures; a sheet scan is optional and only used to pre-fill boxes (and kept as evidence if ticked).
- Auto-fill uses on-device OCR (Tesseract, lazy-loaded). It is reliable on clear printed figures and weak on
  handwriting, so filled boxes are highlighted, the printed total is cross-checked, and the re-typed total gate
  still applies before anything is submitted.

## Design rules

- Phone first: bottom tab bar, 48px touch targets, 16px inputs (no iOS zoom), sticky form actions. Sidebar from 900px.
- Photos are downscaled on the device before upload; submissions carry a stable `Idempotency-Key` so retries never duplicate.
- Reporting a unit you already reported opens a correction (new version superseding the old), never a competing first version.
- Neutral language throughout: differences to review, never accusations.

## Layout

```
src/
  lib/        API client (token refresh), types mirroring the backend, image compression, labels
  state/      signed-in user + accounts; per-account context (role, assigned units, ballot)
  components/ shell (sidebar / bottom tabs), status chips, sheets, figures tables, evidence images
  pages/      Auth, Home (agent / party / INEC), UnitDetail, Submit, Agents, Setup, Accounts
```
