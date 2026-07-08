import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), tailwindcss()],
  build: {
    // Keep CSS in a single file to reduce render-blocking requests
    cssCodeSplit: false,
    rollupOptions: {
      output: {
        manualChunks(id) {
          // Split vendor libraries into a separate cacheable chunk
          if (id.includes('node_modules')) {
            if (
              id.includes('react') ||
              id.includes('react-dom') ||
              id.includes('react-router')
            ) {
              return 'vendor';
            }
          }
        },
      },
    },
  },
})
