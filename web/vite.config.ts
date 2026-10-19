import { defineConfig } from 'vite';
export default defineConfig({
  base: './',
  // the point clouds (GBs) are uploaded separately, not bundled
  build: { copyPublicDir: false, chunkSizeWarningLimit: 1000 },
  // wait for editors (and scripts) to finish writing before reloading, or Vite can cache a half-written file
  server: { port: 5190, watch: { awaitWriteFinish: { stabilityThreshold: 150, pollInterval: 50 } } },
});
