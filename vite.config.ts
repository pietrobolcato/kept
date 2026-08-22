import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  build: {
    rollupOptions: {
      output: {
        entryFileNames: 'assets/app.js',
        chunkFileNames: 'assets/[name].js',
        assetFileNames: (asset) => asset.names.some((name) => name.endsWith('.css')) ? 'assets/app.css' : 'assets/[name][extname]',
      },
    },
  },
  server: {
    host: '127.0.0.1',
    port: 3456,
    proxy: { '/api': 'http://127.0.0.1:8787', '/uploads': 'http://127.0.0.1:8787' },
  },
})
