type ViteEnv = Record<string, string | boolean | undefined> & {
  MODE?: string;
  DEV?: boolean;
};

const env = import.meta.env as ViteEnv;

const stripTrailingSlash = (value: string) => value.replace(/\/+$/, "");

const wsBaseUrl = stripTrailingSlash(
  String(env.VITE_CONJURE_WS_BASE_URL || env.VITE_BACKEND_WS_URL || "ws://localhost:8000")
);

const backendUrl = stripTrailingSlash(
  String(env.VITE_BACKEND_URL || "http://localhost:8000")
);

const sentryDsn = String(env.VITE_SENTRY_DSN || "");
const sentryEnabled =
  Boolean(sentryDsn) && String(env.VITE_SENTRY_ENABLED || "true") !== "false";

export const CONJURE_CONFIG = {
  projectId: String(env.VITE_CONJURE_PROJECT_ID || "local-demo"),
  wsBaseUrl,
  backendUrl,
  pageContentMaxChars: Number(env.VITE_PAGE_CONTENT_MAX_CHARS || 150000),
  consoleRingLimit: Number(env.VITE_CONSOLE_RING_LIMIT || 500),
  sentry: {
    enabled: sentryEnabled,
    dsn: sentryDsn,
    environment: String(env.VITE_SENTRY_ENVIRONMENT || env.MODE || "development"),
    release: String(env.VITE_SENTRY_RELEASE || "conjure-extension@0.1.0")
  }
} as const;

export const createConversationWsUrl = (projectId: string) =>
  `${CONJURE_CONFIG.wsBaseUrl}/ws/${encodeURIComponent(projectId)}`;

const projectBase = (projectId: string) =>
  `${CONJURE_CONFIG.backendUrl}/projects/${encodeURIComponent(projectId)}`;

export const createModsUrl = (projectId: string) => `${projectBase(projectId)}/mods`;

export const createModsBundleUrl = (projectId: string) => `${projectBase(projectId)}/mods/bundle`;

export const createModUrl = (projectId: string, modId: string) =>
  `${projectBase(projectId)}/mods/${encodeURIComponent(modId)}`;
