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
  commands: {
    "toggle-command-bar": {
      suggested_key: {
        default: "Ctrl+K",
        mac: "Command+K"
      },
      description: "Open the Conjure command bar"
    }
  },
  background: {
    service_worker: "src/background.ts",
    type: "module"
  },
  content_security_policy: {
    extension_pages: "script-src 'self'; object-src 'self'; font-src 'self'"
  },
  content_scripts: [
    {
      matches: ["<all_urls>"],
      js: ["src/content/main.tsx"],
      run_at: "document_start"
    }
  ],
  web_accessible_resources: [
    {
      resources: ["fonts/*"],
      matches: ["<all_urls>"]
    }
  ],
  permissions: ["sidePanel", "storage", "tabs", "scripting", "userScripts", "offscreen"],
  host_permissions: ["<all_urls>"]
}));
