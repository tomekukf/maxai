import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  // fs.allow: pozwól importować runbook z repo root (docs/) spoza katalogu frontend/.
  server: { port: 5173, fs: { allow: ['..'] } },
});
