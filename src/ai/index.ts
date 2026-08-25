/**
 * The single entry point for "talk to the configured AI". Feature code asks for
 * aiProvider() (chat/tools/vision) or aiJson() (structured extraction) and never
 * touches a vendor SDK directly.
 *
 * Configuration lives in the settings table (Ajustes → Proveedor de IA):
 *   ai_provider           — preset id (see defaultProviderId(); qwen/kimi/…)
 *   ai_model:<provider>   — model override, per provider (switching back keeps it)
 *   ai_model_bulk:<prov>  — cheaper model for bulk work (see AiRole)
 *   ai_model_vision:<prov>— model used for image input (see AiRole)
 *   ai_base_url:<provider>— base URL override (mainly for 'custom' / mirrors)
 *   ai_key:<provider>     — API key, per provider (anthropic reuses the legacy
 *                           anthropic_api_key so existing installs keep working)
 *   ai_vision:<provider>  — '1'/'0': the chosen model accepts images
 */
import { config } from '../config.js';
import { t } from '../i18n.js';
import { getApiKey, getSetting, setSetting } from '../settings.js';
import { AnthropicProvider } from './anthropic.js';
import { OpenAiCompatProvider } from './openai.js';
import { presetById, PROVIDER_PRESETS, type ProviderPreset } from './providers.js';
import { extractJson, type AiChatProvider, type AiRequest } from './types.js';

export { PROVIDER_PRESETS } from './providers.js';
export * from './types.js';

/**
 * The app has two very different AI workloads, and paying chat-model prices for
 * bulk work is the single biggest avoidable cost here:
 *   'bulk' — extraction/classification/translation/vision over thousands of
 *            messages. High volume, low complexity, cost-sensitive.
 *   'chat' — the interactive tool-using agent. Low volume, needs the stronger
 *            model's tool discipline.
 *   'vision' — anything with an image attached. This is NOT the same choice as
 *            either of the other two: on most providers the strongest text
 *            model cannot see images at all (qwen-max and qwen-plus are both
 *            text-only), so sending a product photo to the chat or bulk model
 *            would simply fail.
 * Providers that publish a cheap tier get it via preset.defaultBulkModel; where
 * they don't, the roles resolve to the same model and nothing changes.
 */
export type AiRole = 'chat' | 'bulk' | 'vision';

export interface AiConfig {
  provider: string;
  label: string;
  kind: 'anthropic' | 'openai';
  baseUrl: string;
  model: string;
  /** Which role this config was resolved for. */
  role: AiRole;
  apiKey: string;
  vision: boolean;
  needsKey: boolean;
  keyHint: string;
}

function keyFor(preset: ProviderPreset): string {
  if (preset.id === 'anthropic') return getApiKey(); // legacy key, .env fallback
  return (getSetting(`ai_key:${preset.id}`) || '').trim();
}

/**
 * Which provider a config-less install starts on.
 *
 * The app is deployed in mainland China, where the Anthropic API is not an
 * available region — reaching it over the office VPN would put the account at
 * risk — so FRESH installs start on Qwen. An install that already has an
 * Anthropic key stored keeps using Anthropic until its owner switches, so this
 * change can't silently break a working setup.
 */
export function defaultProviderId(): string {
  const explicit = (getSetting('ai_provider') || '').trim();
  if (explicit) return explicit;
  return getApiKey() ? 'anthropic' : 'qwen';
}

/** The active provider's resolved configuration (settings + preset defaults). */
export function aiConfig(role: AiRole = 'chat'): AiConfig {
  const preset = presetById(defaultProviderId());
  const general =
    (getSetting(`ai_model:${preset.id}`) || '').trim() ||
    preset.defaultModel ||
    (preset.id === 'anthropic' ? config.model : '');
  const model =
    role === 'bulk'
      ? (getSetting(`ai_model_bulk:${preset.id}`) || '').trim() || preset.defaultBulkModel || general
      : role === 'vision'
        ? (getSetting(`ai_model_vision:${preset.id}`) || '').trim() || preset.defaultVisionModel || general
        : general;
  const baseUrl = (getSetting(`ai_base_url:${preset.id}`) || '').trim() || preset.baseUrl;
  const visionRaw = getSetting(`ai_vision:${preset.id}`);
  return {
    provider: preset.id,
    label: preset.label,
    kind: preset.kind,
    baseUrl,
    model,
    role,
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
  bulkModel?: string;
  visionModel?: string;
  baseUrl?: string;
  apiKey?: string;
  vision?: boolean;
}): void {
  const providerId = b.provider && PROVIDER_PRESETS.some((p) => p.id === b.provider)
    ? b.provider
    : defaultProviderId();
  if (typeof b.provider === 'string') setSetting('ai_provider', providerId);
  if (typeof b.model === 'string') setSetting(`ai_model:${providerId}`, b.model.trim());
  if (typeof b.bulkModel === 'string') setSetting(`ai_model_bulk:${providerId}`, b.bulkModel.trim());
  if (typeof b.visionModel === 'string') setSetting(`ai_model_vision:${providerId}`, b.visionModel.trim());
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

/**
 * Standard route-level error when hasAiKey() is false. A getter, not a const:
 * the message has to follow the owner's current language, and a module-level
 * constant would freeze whichever language was active at import time.
 */
export function aiNotConfigured(): string {
  return t('server.aiNotConfigured');
}

/** Construct the active provider for a role. Cheap — safe to call per request. */
export function aiProvider(role: AiRole = 'chat'): AiChatProvider {
  const c = aiConfig(role);
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
export function aiName(role: AiRole = 'chat'): string {
  const c = aiConfig(role);
  return `${c.provider}:${c.model || '?'}`;
}

export interface AiProviderStatus {
  id: string;
  label: string;
  baseUrl: string;
  /** International endpoint, when this provider runs a separate one. */
  baseUrlAlt: string;
  model: string;
  bulkModel: string;
  visionModel: string;
  vision: boolean;
  needsKey: boolean;
  keyHint: string;
  hasKey: boolean;
}

/** Everything the Ajustes UI needs — per-provider stored values and which one
 *  is active. Never returns a key, only whether one is saved. */
export function aiStatus(): {
  active: { provider: string; name: string; bulkName: string; visionName: string; configured: boolean };
  providers: AiProviderStatus[];
} {
  const active = aiConfig();
  return {
    active: {
      provider: active.provider,
      name: aiName(),
      bulkName: aiName('bulk'),
      visionName: aiName('vision'),
      configured: hasAiKey(),
    },
    providers: PROVIDER_PRESETS.map((p) => {
      const visionRaw = getSetting(`ai_vision:${p.id}`);
      return {
        id: p.id,
        label: p.label,
        baseUrl: (getSetting(`ai_base_url:${p.id}`) || '').trim() || p.baseUrl,
        baseUrlAlt: p.baseUrlAlt ?? '',
        model:
          (getSetting(`ai_model:${p.id}`) || '').trim() ||
          p.defaultModel ||
          (p.id === 'anthropic' ? config.model : ''),
        bulkModel: (getSetting(`ai_model_bulk:${p.id}`) || '').trim() || p.defaultBulkModel || '',
        visionModel: (getSetting(`ai_model_vision:${p.id}`) || '').trim() || p.defaultVisionModel || '',
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
export async function aiJson<T>(
  req: Omit<AiRequest, 'jsonSchema'>,
  schema: Record<string, unknown>,
  role: AiRole = 'bulk',
): Promise<T | null> {
  const resp = await aiProvider(role).chat({ ...req, jsonSchema: schema });
  return extractJson<T>(resp.text);
}
