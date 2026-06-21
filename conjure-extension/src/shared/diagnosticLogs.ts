export const DIAGNOSTIC_LOGS_STORAGE_KEY = "conjure.diagnostic-logs";

export interface DiagnosticLogEntry {
  id: string;
  timestamp: number;
  source: string;
  message: string;
}

const MAX_LOG_ENTRIES = 100;

const redactSecrets = (message: string) =>
  message
    .replace(/\b(sk-ant-[A-Za-z0-9_-]{8})[A-Za-z0-9_-]+/g, "$1…[redacted]")
    .replace(/\b(gsk_[A-Za-z0-9_-]{8})[A-Za-z0-9_-]+/g, "$1…[redacted]")
    .replace(/((?:api[_ -]?key|authorization)\s*[:=]\s*(?:bearer\s+)?)[^\s,;]+/gi, "$1[redacted]");

export const readDiagnosticLogs = async (): Promise<DiagnosticLogEntry[]> => {
  const stored = await chrome.storage.local.get(DIAGNOSTIC_LOGS_STORAGE_KEY);
  const logs = stored[DIAGNOSTIC_LOGS_STORAGE_KEY];
  return Array.isArray(logs) ? (logs as DiagnosticLogEntry[]) : [];
};

export const appendDiagnosticLog = async (source: string, error: unknown): Promise<void> => {
  const message = redactSecrets(error instanceof Error ? error.message : String(error));
  const logs = await readDiagnosticLogs();
  const entry: DiagnosticLogEntry = {
    id: globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random()}`,
    timestamp: Date.now(),
    source,
    message
  };
  await chrome.storage.local.set({
    [DIAGNOSTIC_LOGS_STORAGE_KEY]: [entry, ...logs].slice(0, MAX_LOG_ENTRIES)
  });
};

export const clearDiagnosticLogs = (): Promise<void> =>
  chrome.storage.local.remove(DIAGNOSTIC_LOGS_STORAGE_KEY);
