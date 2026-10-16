import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

declare const process: { env: Record<string, string | undefined> }   // no @types/node needed for one variable

// The browser only ever talks to /api on the dev server; Vite forwards it to FastAPI.
// PG_API overrides the target (e.g. PG_API=http://localhost:8002) if :8000 is taken.
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    strictPort: true,
    proxy: { '/api': process.env.PG_API || 'http://localhost:8000' },
  },
  build: {
    chunkSizeWarningLimit: 2000,
  },
})
