import { crx } from "@crxjs/vite-plugin";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import manifest from "./manifest.config";

export default defineConfig({
  plugins: [react(), crx({ manifest })],
  envDir: "..",
  build: {
    emptyOutDir: true,
    sourcemap: true
  },
  server: {
    port: 5173,
    strictPort: false
  }
});
