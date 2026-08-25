/**
 * Named provider presets for the Ajustes UI. Base URL and default model are
 * prefills — model names on these platforms change every few months, so every
 * field stays editable and nothing here is load-bearing beyond first setup.
 *
 * All non-Anthropic presets speak the OpenAI Chat Completions dialect
 * (POST {baseUrl}/chat/completions), which every major Chinese lab exposes.
 */

export interface ProviderPreset {
  id: string;
  /** Display label. */
  label: string;
  /** 'anthropic' uses the official SDK; 'openai' uses the generic adapter. */
  kind: 'anthropic' | 'openai';
  /**
   * Default endpoint. These are the MAINLAND-CHINA endpoints, because that is
   * where the app is deployed — the international ones are separate hosts with
   * separate accounts and, from the office, worse latency. `baseUrlAlt` carries
   * the international host so Ajustes can offer it to anyone running elsewhere.
   */
  baseUrl: string;
  /** International endpoint, when the provider runs a separate one. */
  baseUrlAlt?: string;
  defaultModel: string;
  /**
   * Cheaper model for BULK work (extraction over thousands of messages,
   * classification, translation) as opposed to the interactive chat agent.
   * Empty = use defaultModel for both.
   */
  defaultBulkModel?: string;
  /**
   * Model used for IMAGE input. Separate from the other two because the
   * strongest text model is usually NOT the vision one — on Qwen, qwen-max and
   * qwen-plus are both text-only, so without this every product photo would be
   * sent to a model that cannot see it. Empty = use defaultModel.
   * As with every field here, these are prefills: confirm the current name in
   * the provider's console, they change every few months.
   */
  defaultVisionModel?: string;
  /** Whether the default model accepts image input (user-overridable). */
  vision: boolean;
  /** Whether an API key is required ('' allowed for local servers). */
  needsKey: boolean;
  /** Where to get a key, shown as a hint in Ajustes. */
  keyHint?: string;
}

export const PROVIDER_PRESETS: ProviderPreset[] = [
  {
    id: 'anthropic',
    label: 'Anthropic (Claude)',
    kind: 'anthropic',
    baseUrl: '',
    defaultModel: '', // falls back to config.model (claude-haiku-4-5)
    vision: true,
    needsKey: true,
    keyHint: 'console.anthropic.com',
  },
  {
    id: 'qwen',
    label: 'Qwen (Alibaba / DashScope)',
    kind: 'openai',
    // DashScope runs on Alibaba Cloud inside mainland China, so AI traffic does
    // not have to ride the same VPN the WhatsApp mirror needs.
    baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    baseUrlAlt: 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1',
    defaultModel: 'qwen-max',
    defaultBulkModel: 'qwen-plus',
    defaultVisionModel: 'qwen-vl-max',
    vision: true,
    needsKey: true,
    keyHint: 'dashscope.console.aliyun.com',
  },
  {
    id: 'kimi',
    label: 'Kimi (Moonshot)',
    kind: 'openai',
    baseUrl: 'https://api.moonshot.cn/v1',
    baseUrlAlt: 'https://api.moonshot.ai/v1',
    defaultModel: 'kimi-k2-0711-preview',
    // Moonshot's vision models are a separate family from the K-series text
    // models; confirm the current id in the console before relying on images.
    defaultVisionModel: 'moonshot-v1-8k-vision-preview',
    vision: true,
    needsKey: true,
    keyHint: 'platform.moonshot.cn',
  },
  {
    id: 'deepseek',
    label: 'DeepSeek',
    kind: 'openai',
    baseUrl: 'https://api.deepseek.com/v1',
    defaultModel: 'deepseek-chat',
    // No vision at all: product photos and scanned PDFs stop producing tasks.
    vision: false,
    needsKey: true,
    keyHint: 'platform.deepseek.com',
  },
  {
    id: 'glm',
    label: 'GLM (Zhipu)',
    kind: 'openai',
    baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
    defaultModel: 'glm-4.6',
    // GLM-4V is the vision-capable sibling — set it as the vision model in
    // Ajustes if images matter; glm-4.6 alone cannot read them.
    vision: false,
    needsKey: true,
    keyHint: 'open.bigmodel.cn',
  },
  {
    id: 'ollama',
    label: 'Ollama (local)',
    kind: 'openai',
    baseUrl: 'http://localhost:11434/v1',
    defaultModel: '',
    vision: false,
    needsKey: false,
  },
  {
    id: 'custom',
    label: 'Otro (compatible con OpenAI)',
    kind: 'openai',
    baseUrl: '',
    defaultModel: '',
    vision: false,
    needsKey: false,
  },
];

export function presetById(id: string): ProviderPreset {
  return PROVIDER_PRESETS.find((p) => p.id === id) ?? PROVIDER_PRESETS[0]!;
}
