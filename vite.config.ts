import { defineConfig, type Plugin } from 'vite'
import react from '@vitejs/plugin-react'

// Content-Security-Policy for the built app. Injected as a <meta> tag at BUILD
// time only (not in dev), because a strict script-src/connect-src would block
// Vite's HMR client and inline preamble under `vercel dev`. frame-ancestors is
// not honored in meta CSP, so clickjacking is covered by X-Frame-Options in
// vercel.json instead.
//   connect-src: our /api proxy (self) + direct Trakt API calls.
//   img-src https:: Trakt (and later TMDB) poster/backdrop hosts.
//   style-src 'unsafe-inline': React inline style attributes (gradients, art).
const CSP = [
  "default-src 'self'",
  "connect-src 'self' https://api.trakt.tv",
  "img-src 'self' https: data:",
  "style-src 'self' 'unsafe-inline'",
  "script-src 'self'",
  "font-src 'self'",
  "base-uri 'self'",
  "form-action 'self'",
  "object-src 'none'",
].join('; ')

function cspMeta(): Plugin {
  return {
    name: 'inject-csp-meta',
    apply: 'build',
    transformIndexHtml(html) {
      return html.replace('</title>', `</title>\n    <meta http-equiv="Content-Security-Policy" content="${CSP}" />`)
    },
  }
}

// The /api directory is served by Vercel's runtime (`vercel dev` locally,
// serverless functions in production). Vite only builds the SPA.
export default defineConfig({
  plugins: [react(), cspMeta()],
  // Drop the inline modulepreload polyfill so the build has no inline scripts
  // and `script-src 'self'` holds. Native modulepreload covers our targets.
  build: { modulePreload: { polyfill: false } },
})
