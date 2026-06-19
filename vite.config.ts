import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// The /api directory is served by Vercel's runtime (`vercel dev` locally,
// serverless functions in production). Vite only builds the SPA.
export default defineConfig({
  plugins: [react()],
})
