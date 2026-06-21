import { defineConfig } from 'vite';

export default defineConfig({
  server: {
    port: 3000,
    open: true
  },
  preview: {
    port: 3000
  },
  worker: {
    format: 'es'
  }
});
