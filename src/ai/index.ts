/**
 * The single entry point for "talk to the configured AI". Feature code asks for
 * aiProvider() (chat/tools/vision) or aiJson() (structured extraction) and never
 * touches a vendor SDK directly.
 *
 * Configuration lives in the settings table (Ajustes → Proveedor de IA):
 *   ai_provider           — preset id ('anthropic' default; kimi/deepseek/…)
 *   ai_model:<provider>   — model override, per provider (switching back keeps it)
 *   ai_base_url:<provider>— base URL override (mainly for 'custom' / mirrors)
 *   ai_key:<provider>     — API key, per provider (anthropic reuses the legacy
 *                           anthropic_api_key so existing installs keep working)
 *   ai_vision:<provider>  — '1'/'0': the chosen model accepts images
 */
import { config } from '../config.js';
import { getApiKey, getSetting, setSetting } from '../settings.js';
import { AnthropicProvider } from './anthropic.js';
import { OpenAiCompatProvider } from './openai.js';
import { presetById, PROVIDER_PRESETS, type ProviderPreset } from './providers.js';
import { extractJson, type AiChatProvider, type AiRequest } from './types.js';

export { PROVIDER_PRESETS } from './providers.js';
export * from './types.js';

export interface AiConfig {
  provider: string;
  label: string;
  kind: 'anthropic' | 'openai';
  baseUrl: string;
  model: string;
  apiKey: string;
  vision: boolean;
  needsKey: boolean;
  keyHint: string;
}

function keyFor(preset: ProviderPreset): string {
  if (preset.id === 'anthropic') return getApiKey(); // legacy key, .env fallback
  return (getSetting(`ai_key:${preset.id}`) || '').trim();
}

/** The active provider's resolved configuration (settings + preset defaults). */
export function aiConfig(): AiConfig {
  const preset = presetById(getSetting('ai_provider') || 'anthropic');
  const model =
    (getSetting(`ai_model:${preset.id}`) || '').trim() ||
    preset.defaultModel ||
    (preset.id === 'anthropic' ? config.model : '');
  const baseUrl = (getSetting(`ai_base_url:${preset.id}`) || '').trim() || preset.baseUrl;
  const visionRaw = getSetting(`ai_vision:${preset.id}`);
  return {
    provider: preset.id,
    label: preset.label,
    kind: preset.kind,
    baseUrl,
    model,
    apiKey: keyFor(preset),
    vision: visionRaw === null ? preset.vision : visionRaw === '1',
    needsKey: preset.needsKey,
    keyHint: preset.keyHint ?? '',
  };
}

/** Persist provider settings coming from Ajustes. Empty strings clear overrides. */
export function saveAiSettings(b: {
  provider?: string;
  model?: string;
  baseUrl?: string;
  apiKey?: string;
  vision?: boolean;
}): void {
  const providerId = b.provider && PROVIDER_PRESETS.some((p) => p.id === b.provider)
    ? b.provider
    : (getSetting('ai_provider') || 'anthropic');
  if (typeof b.provider === 'string') setSetting('ai_provider', providerId);
  if (typeof b.model === 'string') setSetting(`ai_model:${providerId}`, b.model.trim());
  if (typeof b.baseUrl === 'string') setSetting(`ai_base_url:${providerId}`, b.baseUrl.trim());
  if (typeof b.apiKey === 'string') {
    if (providerId === 'anthropic') setSetting('anthropic_api_key', b.apiKey.trim());
    else setSetting(`ai_key:${providerId}`, b.apiKey.trim());
  }
  if (typeof b.vision === 'boolean') setSetting(`ai_vision:${providerId}`, b.vision ? '1' : '0');
}

/**
 * Is the active provider usable? Replaces the old "is there an Anthropic key"
 * gate on AI routes — a keyless local provider (Ollama) counts as configured
 * once it has a model name.
 */
export function hasAiKey(): boolean {
  const c = aiConfig();
  if (c.kind === 'anthropic') return Boolean(c.apiKey);
  return Boolean(c.baseUrl && c.model && (c.apiKey || !c.needsKey));
}

/** Standard route-level error when hasAiKey() is false. */
export const AI_NOT_CONFIGURED = 'Configura el proveedor de IA en Ajustes (clave y modelo).';

/** Construct the active provider. Cheap — safe to call per request. */
export function aiProvider(): AiChatProvider {
  const c = aiConfig();
  if (c.kind === 'anthropic') return new AnthropicProvider(c.apiKey, c.model);
  return new OpenAiCompatProvider({
    providerId: c.provider,
    baseUrl: c.baseUrl,
    model: c.model,
    apiKey: c.apiKey,
    vision: c.vision,
  });
}

/** Short "provider:model" label for logs and the UI. */
export function aiName(): string {
  const c = aiConfig();
  return `${c.provider}:${c.model || '?'}`;
}

export interface AiProviderStatus {
  id: string;
  label: string;
  baseUrl: string;
  model: string;
  vision: boolean;
  needsKey: boolean;
  keyHint: string;
  hasKey: boolean;
}

/** Everything the Ajustes UI needs — per-provider stored values and which one
 *  is active. Never returns a key, only whether one is saved. */
export function aiStatus(): {
  active: { provider: string; name: string; configured: boolean };
  providers: AiProviderStatus[];
} {
  const active = aiConfig();
  return {
    active: { provider: active.provider, name: aiName(), configured: hasAiKey() },
    providers: PROVIDER_PRESETS.map((p) => {
      const visionRaw = getSetting(`ai_vision:${p.id}`);
      return {
        id: p.id,
        label: p.label,
        baseUrl: (getSetting(`ai_base_url:${p.id}`) || '').trim() || p.baseUrl,
        model:
          (getSetting(`ai_model:${p.id}`) || '').trim() ||
          p.defaultModel ||
          (p.id === 'anthropic' ? config.model : ''),
        vision: visionRaw === null ? p.vision : visionRaw === '1',
        needsKey: p.needsKey,
        keyHint: p.keyHint ?? '',
        hasKey: Boolean(keyFor(p)),
      };
    }),
  };
}

/**
 * One-shot structured call: send the request with a JSON schema and parse the
 * reply, tolerating providers that decorate their JSON. Returns null on
 * unparseable output (callers decide whether that's fatal).
 */
export async function aiJson<T>(req: Omit<AiRequest, 'jsonSchema'>, schema: Record<string, unknown>): Promise<T | null> {
  const resp = await aiProvider().chat({ ...req, jsonSchema: schema });
  return extractJson<T>(resp.text);
}
