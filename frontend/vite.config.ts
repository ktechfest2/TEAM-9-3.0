import basicSsl from '@vitejs/plugin-basic-ssl'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// Dev server on :3000 (the backend's default FRONTEND_ORIGINS); /api is proxied to FastAPI so the
// browser never makes a cross-origin call. `npm run dev:phone` serves HTTPS on the LAN, because
// phone browsers only allow the live camera on secure origins.
const phone = process.env.PHONE === '1'

export default defineConfig({
  plugins: phone ? [react(), basicSsl()] : [react()],
  server: {
    port: 3000,
    proxy: {
      '/api': { target: process.env.TALLYTRAIL_API ?? 'http://127.0.0.1:8000', changeOrigin: true },
    },
  },
})
