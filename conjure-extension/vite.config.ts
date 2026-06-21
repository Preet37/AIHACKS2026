import { crx } from "@crxjs/vite-plugin";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import manifest from "./manifest.config";

export default defineConfig({
  plugins: [react(), crx({ manifest })],
  envDir: "..",
  build: {
    emptyOutDir: true,
    sourcemap: true,
    rollupOptions: {
      input: {
        index: "index.html",
        design: "design.html",
        run: "run.html",
        settings: "settings.html",
        offscreen: "offscreen.html"
      }
    }
  },
  server: {
    port: 5173,
    strictPort: false
  }
});
