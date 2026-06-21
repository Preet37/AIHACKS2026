import type { ClientProvider } from "./messages";

export const PROVIDER_STORAGE_KEY = "conjure.provider";
export const DEFAULT_PROVIDER: ClientProvider = "anthropic";

export const isClientProvider = (value: unknown): value is ClientProvider =>
  value === "anthropic" || value === "groq";

export const readProvider = async (): Promise<ClientProvider> => {
  const stored = await chrome.storage.local.get(PROVIDER_STORAGE_KEY);
  return isClientProvider(stored[PROVIDER_STORAGE_KEY])
    ? stored[PROVIDER_STORAGE_KEY]
    : DEFAULT_PROVIDER;
};

export const saveProvider = (provider: ClientProvider): Promise<void> =>
  chrome.storage.local.set({ [PROVIDER_STORAGE_KEY]: provider });
