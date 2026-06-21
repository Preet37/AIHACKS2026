import type { ClientProvider } from "./messages";

export const PROVIDER_STORAGE_KEY = "conjure.provider-settings";

export interface PersistedProviderSettings {
  provider: ClientProvider;
  apiKey: string;
}

export const DEFAULT_PROVIDER_SETTINGS: PersistedProviderSettings = {
  provider: "anthropic",
  apiKey: ""
};

const isClientProvider = (value: unknown): value is ClientProvider =>
  value === "anthropic" || value === "groq";

export const readProviderSettings = async (): Promise<PersistedProviderSettings> => {
  const stored = await chrome.storage.local.get(PROVIDER_STORAGE_KEY);
  const saved = stored[PROVIDER_STORAGE_KEY] as Partial<PersistedProviderSettings> | undefined;
  const provider = isClientProvider(saved?.provider)
    ? saved.provider
    : DEFAULT_PROVIDER_SETTINGS.provider;
  return {
    provider,
    // Do not reuse a credential saved for an unrecognized legacy provider.
    apiKey: isClientProvider(saved?.provider) && typeof saved?.apiKey === "string" ? saved.apiKey : ""
  };
};

export const saveProviderSettings = (settings: PersistedProviderSettings): Promise<void> =>
  chrome.storage.local.set({ [PROVIDER_STORAGE_KEY]: settings });

export const clearProviderSettings = (): Promise<void> =>
  chrome.storage.local.remove(PROVIDER_STORAGE_KEY);
