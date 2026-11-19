import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// Dev server on :3000 (the backend's default FRONTEND_ORIGINS); /api is proxied to FastAPI so the
// browser never makes a cross-origin call. --host exposes it on the LAN for testing on a phone.
export default defineConfig({
  plugins: [react()],
  server: {
    port: 3000,
    proxy: {
      '/api': { target: process.env.TALLYTRAIL_API ?? 'http://127.0.0.1:8000', changeOrigin: true },
    },
  },
})
