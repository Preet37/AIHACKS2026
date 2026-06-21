export const FALLBACK_HOTKEY_STORAGE_KEY = "conjure.commandFallbackHotkey";
export const DEFAULT_FALLBACK_HOTKEY = "Alt+K";

const MODIFIER_ALIASES: Record<string, string> = {
  cmd: "Command",
  command: "Command",
  meta: "Command",
  ctrl: "Ctrl",
  control: "Ctrl",
  alt: "Alt",
  option: "Alt",
  shift: "Shift"
};

const MODIFIER_ORDER = ["Ctrl", "Alt", "Shift", "Command"];

export const normalizeHotkey = (value: string) => {
  const parts = value
    .split("+")
    .map((part) => part.trim())
    .filter(Boolean);
  if (!parts.length) return DEFAULT_FALLBACK_HOTKEY;

  const modifiers = new Set<string>();
  let key = "";

  for (const part of parts) {
    const lower = part.toLowerCase();
    const modifier = MODIFIER_ALIASES[lower];
    if (modifier) {
      modifiers.add(modifier);
      continue;
    }
    key = part.length === 1 ? part.toUpperCase() : part;
  }

  if (!key) return DEFAULT_FALLBACK_HOTKEY;
  const ordered = MODIFIER_ORDER.filter((modifier) => modifiers.has(modifier));
  return [...ordered, key].join("+");
};

export const eventMatchesHotkey = (event: KeyboardEvent, hotkey: string) => {
  const normalized = normalizeHotkey(hotkey);
  const parts = new Set(normalized.split("+"));
  const key = normalized.split("+").at(-1);
  const eventKey = event.key.length === 1 ? event.key.toUpperCase() : event.key;

  return (
    eventKey === key &&
    event.ctrlKey === parts.has("Ctrl") &&
    event.altKey === parts.has("Alt") &&
    event.shiftKey === parts.has("Shift") &&
    event.metaKey === parts.has("Command")
  );
};

export const isEditableTarget = (target: EventTarget | null) => {
  if (!(target instanceof HTMLElement)) return false;
  const tag = target.tagName.toLowerCase();
  return tag === "input" || tag === "textarea" || tag === "select" || target.isContentEditable;
};
