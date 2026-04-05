// ── AI Coach model registry ─────────────────────────────────────────────────
// Add new models here — the UI dropdown and provider routing derive from this.

export const AI_COACH_MODELS = [
  { id: "gpt-4o",                     label: "OpenAI GPT-4o",      provider: "openai" },
  { id: "gpt-5.2",                    label: "OpenAI GPT-5.2",     provider: "openai" },
  { id: "gpt-5.4",                    label: "OpenAI GPT-5.4",     provider: "openai" },
  { id: "gpt-5.4-mini",              label: "OpenAI GPT-5.4 Mini", provider: "openai" },
  { id: "gemini-3-flash-preview",             label: "Gemini 3 Flash",     provider: "google" },
  { id: "gemini-3.1-pro-preview",     label: "Gemini 3.1 Pro",     provider: "google" },
  { id: "claude-sonnet-4-5-20250929", label: "Claude Sonnet 4.5",  provider: "anthropic" },
  { id: "claude-sonnet-4-6", label: "Claude Sonnet 4.6",  provider: "anthropic" },
  { id: "claude-opus-4-6",   label: "Claude Opus 4.6",    provider: "anthropic" },
] as const;

export type AICoachModelId = (typeof AI_COACH_MODELS)[number]["id"];

// ── Transcriber model registry ──────────────────────────────────────────────

export const TRANSCRIBER_MODELS = [
  { id: "openai",  label: "OpenAI Whisper-1",          provider: "openai", modelId: "whisper-1" },
  { id: "groq",    label: "Groq Whisper Large v3 Turbo", provider: "groq",   modelId: "whisper-large-v3-turbo" },
] as const;

export type TranscriberModelId = (typeof TRANSCRIBER_MODELS)[number]["id"];

// ── Lookup helpers ──────────────────────────────────────────────────────────

export function getCoachProvider(modelId: string): string {
  const entry = AI_COACH_MODELS.find((m) => m.id === modelId);
  return entry?.provider ?? "openai";
}

export function getTranscriberProvider(modelId: string): string {
  const entry = TRANSCRIBER_MODELS.find((m) => m.id === modelId);
  return entry?.provider ?? "openai";
}

export function getTranscriberModelId(modelId: string): string {
  const entry = TRANSCRIBER_MODELS.find((m) => m.id === modelId);
  return entry?.modelId ?? "";
}

export function transcriberNeedsKey(modelId: string): boolean {
  return TRANSCRIBER_MODELS.some((m) => m.id === modelId);
}

export function getKeyPlaceholder(provider: string): string {
  switch (provider) {
    case "openai":    return "sk-...";
    case "anthropic": return "sk-ant-...";
    case "google":    return "AIza...";
    case "groq":      return "gsk_...";
    default:          return "API key";
  }
}
