import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react-swc'

export default defineConfig({
  plugins: [react()],
  server: {
    host: '127.0.0.1',
    port: 8086,
    // If you later add a local Express server, enable a proxy like:
    // proxy: { '/api': { target: 'http://127.0.0.1:5057', changeOrigin: true } }
  },
})

