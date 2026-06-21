import { defineManifest } from "@crxjs/vite-plugin";

export default defineManifest((env) => ({
  manifest_version: 3,
  name: env.mode === "development" ? "Conjure Dev" : "Conjure",
  description: "Self-building browser agent product surface.",
  version: "0.1.0",
  minimum_chrome_version: "116",
  action: {
    default_title: "Open Conjure"
  },
  side_panel: {
    default_path: "index.html"
  },
  background: {
    service_worker: "src/background.ts",
    type: "module"
  },
  content_scripts: [
    {
      matches: ["http://*/*", "https://*/*"],
      js: ["src/content/main.tsx"],
      run_at: "document_start"
    }
  ],
  permissions: ["sidePanel", "storage", "tabs", "scripting"],
  host_permissions: ["<all_urls>"]
}));
