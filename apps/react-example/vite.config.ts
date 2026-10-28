import { defineConfig, loadEnv } from 'vite'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
export default defineConfig(({ mode }) => {
  // The example token server (apps/token-server). Proxying it keeps the app and
  // its sign-in cookie on one origin, so no CORS is needed.
  const tokenServer = loadEnv(mode, process.cwd(), '').TOKEN_SERVER_URL || 'http://127.0.0.1:8787'
  return {
    plugins: [
      react({
        babel: {
          plugins: [['babel-plugin-react-compiler']],
        },
      }),
    ],
    server: {
      proxy: { '/api': tokenServer },
    },
  }
})
